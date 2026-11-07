import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  creerPool,
  initialiser,
  transaction,
  chargerEtat,
  lireReglages,
  etatPartie,
  lirePartie,
  ecrireScores,
} from './db.js';
import { ErreurHttp, echec } from './erreurs.js';
import { exigerAuteur, journaliser, lireJournal, instantanePartie, retablir } from './journal.js';

const PORT = Number(process.env.PORT ?? 3000);
const PIN = process.env.APP_PIN?.trim() || null;
const dossierPublic = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let pool;
try {
  pool = creerPool();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// --- Code d'accès (facultatif) : la lecture est libre, l'écriture demande le code. ---
const empreinte = (s) => crypto.createHash('sha256').update(String(s)).digest();
function pinValide(pin) {
  return !PIN || crypto.timingSafeEqual(empreinte(pin ?? ''), empreinte(PIN));
}
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/pin') return next();
  if (!pinValide(req.get('x-pin'))) return res.status(401).json({ erreur: 'Code d’accès requis', code: 'pin' });
  next();
});
// --- Chaque modification est signée (nom choisi sur le téléphone). ---
app.use('/api', exigerAuteur);

const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** Exécute une écriture dans une transaction puis renvoie l'état complet à jour. */
const ecriture = (fn) =>
  route(async (req, res) => {
    await transaction(pool, (client) => fn(client, req));
    res.json(await etatPublic());
  });

async function etatPublic() {
  return { ...(await chargerEtat(pool)), pinRequis: Boolean(PIN) };
}

// --- Validation ---
const entier = (v, nom, { min = -Infinity, max = Infinity } = {}) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) echec(400, `${nom} invalide`);
  return n;
};
const idParam = (req) => entier(Number(req.params.id), 'id', { min: 1 });
const nomJoueur = (v) => {
  const nom = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!nom || nom.length > 30) echec(400, 'Nom invalide (1 à 30 caractères)');
  return nom;
};
const MAX_POINTS = 1000;

async function partieOu404(client, id, options) {
  const partie = await lirePartie(client, id, options);
  if (!partie) echec(404, 'Partie introuvable');
  return partie;
}

function lireScores(brut, attendus) {
  if (!brut || typeof brut !== 'object') echec(400, 'Scores manquants');
  const scores = {};
  for (const id of attendus) {
    if (!(id in brut) || brut[id] === '' || brut[id] == null) echec(400, 'Il manque le score d’un joueur');
    scores[id] = entier(brut[id], 'Score', { min: -MAX_POINTS, max: MAX_POINTS });
  }
  return scores;
}

// --- Routes ---
app.get('/healthz', route(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/api/etat', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await etatPublic());
}));

app.post('/api/pin', (req, res) => {
  if (pinValide(req.body?.pin)) return res.json({ ok: true });
  res.status(401).json({ erreur: 'Code incorrect', code: 'pin' });
});

app.post('/api/joueurs', ecriture(async (client, req) => {
  const nom = nomJoueur(req.body?.nom);
  let id;
  try {
    id = (await client.query('INSERT INTO joueurs (nom) VALUES ($1) RETURNING id', [nom])).rows[0].id;
  } catch (err) {
    if (err.code === '23505') echec(409, `${nom} existe déjà`);
    throw err;
  }
  await journaliser(client, req, { action: 'joueur.ajoute', apres: { id, nom, actif: true } });
}));

app.patch('/api/joueurs/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const avant = (await client.query('SELECT id, nom, actif FROM joueurs WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!avant) echec(404, 'Joueur introuvable');
  const apres = { ...avant };
  if (req.body?.nom !== undefined) apres.nom = nomJoueur(req.body.nom);
  if (req.body?.actif !== undefined) apres.actif = Boolean(req.body.actif);
  if (apres.nom === avant.nom && apres.actif === avant.actif) return;
  try {
    await client.query('UPDATE joueurs SET nom = $1, actif = $2 WHERE id = $3', [apres.nom, apres.actif, id]);
  } catch (err) {
    if (err.code === '23505') echec(409, 'Ce nom existe déjà');
    throw err;
  }
  await journaliser(client, req, { action: 'joueur.modifie', avant, apres });
}));

app.put('/api/reglages', ecriture(async (client, req) => {
  const seuil = entier(req.body?.seuil, 'Seuil', { min: 50, max: 100000 });
  const restants = entier(req.body?.restants ?? 2, 'Joueurs restants', { min: 1, max: 5 });
  const bareme = {};
  for (const [table, points] of Object.entries(req.body?.bareme ?? {})) {
    const t = entier(Number(table), 'Table', { min: 1, max: 9 });
    if (!Array.isArray(points) || points.length === 0 || points.length > 8) echec(400, 'Barème invalide');
    bareme[t] = points.map((p) => entier(p, 'Points du barème', { min: 0, max: 1000 }));
  }
  if (!bareme[1]) echec(400, 'Barème de la table 1 manquant');
  const avant = await lireReglages(client);
  const m = req.body?.manche;
  const manche = m
    ? {
        rien: entier(m.rien, 'Pénalité « rien posé »', { min: 1, max: 1000 }),
        fermeSeul: entier(m.fermeSeul, 'Score du gagnant seul descendu', { min: -1000, max: 0 }),
        ferme: entier(m.ferme, 'Score du gagnant', { min: -1000, max: 0 }),
      }
    : avant.manche;
  const apres = { seuil, restants, bareme, manche };
  if (JSON.stringify(avant) === JSON.stringify({ ...avant, ...apres })) return;
  for (const [cle, valeur] of Object.entries(apres)) {
    await client.query(
      'INSERT INTO reglages (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur',
      [cle, JSON.stringify(valeur)],
    );
  }
  await journaliser(client, req, { action: 'reglages.modifies', avant, apres });
}));

app.post('/api/tours', ecriture(async (client, req) => {
  const tables = req.body?.tables;
  if (!Array.isArray(tables) || tables.length === 0 || tables.length > 4) echec(400, 'Tables invalides');
  const vus = new Set();
  const propres = tables.map((t) => {
    if (!Array.isArray(t) || t.length < 2 || t.length > 6) echec(400, 'Une table doit avoir de 2 à 6 joueurs');
    return t.map((id) => {
      const n = entier(id, 'Joueur', { min: 1 });
      if (vus.has(n)) echec(400, 'Un joueur est à deux tables');
      vus.add(n);
      return n;
    });
  });
  const { rows } = await client.query('SELECT id FROM joueurs WHERE id = ANY($1::int[]) AND actif', [[...vus]]);
  if (rows.length !== vus.size) echec(400, 'Joueur inconnu ou inactif');

  const reglages = await lireReglages(client);
  const tour = (await client.query('INSERT INTO tours DEFAULT VALUES RETURNING id')).rows[0];
  for (const [i, joueurs] of propres.entries()) {
    const numTable = i + 1;
    const bareme = reglages.bareme[numTable] ?? [];
    const partie = (
      await client.query(
        'INSERT INTO parties (tour_id, num_table, seuil, restants, bareme) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [tour.id, numTable, reglages.seuil, reglages.restants, JSON.stringify(bareme)],
      )
    ).rows[0];
    for (const [siege, joueurId] of joueurs.entries()) {
      await client.query('INSERT INTO partie_joueurs (partie_id, joueur_id, siege) VALUES ($1, $2, $3)', [
        partie.id,
        joueurId,
        siege,
      ]);
    }
    await journaliser(client, req, {
      action: 'partie.creee',
      tourId: tour.id,
      partieId: partie.id,
      apres: { table: numTable, joueurs, seuil: reglages.seuil, restants: reglages.restants, bareme },
    });
  }
}));

app.delete('/api/parties/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const instantane = await instantanePartie(client, id);
  if (!instantane) echec(404, 'Partie introuvable');
  await client.query('DELETE FROM parties WHERE id = $1', [id]);
  await client.query('DELETE FROM tours t WHERE t.id = $1 AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.tour_id = t.id)', [
    instantane.tour.id,
  ]);
  await journaliser(client, req, {
    action: 'partie.supprimee',
    tourId: instantane.tour.id,
    partieId: id,
    avant: instantane,
  });
}));

app.post('/api/parties/:id/manches', ecriture(async (client, req) => {
  const partie = await partieOu404(client, idParam(req), { verrou: true });
  const etat = etatPartie(partie);
  if (etat.terminee) echec(409, 'La partie est déjà terminée');
  const num = partie.manches.length + 1;
  if (req.body?.num !== undefined && Number(req.body.num) !== num) {
    echec(409, 'Cette manche a déjà été enregistrée (depuis un autre téléphone ?)');
  }
  const scores = lireScores(req.body?.scores, etat.enJeu);
  const manche = (
    await client.query('INSERT INTO manches (partie_id, num) VALUES ($1, $2) RETURNING id', [partie.id, num])
  ).rows[0];
  await ecrireScores(client, manche.id, scores);
  await journaliser(client, req, {
    action: 'manche.ajoutee',
    tourId: partie.tourId,
    partieId: partie.id,
    mancheId: manche.id,
    mancheNum: num,
    apres: { scores },
  });
}));

app.put('/api/manches/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rows } = await client.query('SELECT partie_id FROM manches WHERE id = $1', [id]);
  if (!rows[0]) echec(404, 'Manche introuvable');
  const partie = await partieOu404(client, rows[0].partie_id, { verrou: true });
  const index = partie.manches.findIndex((m) => m.id === id);
  const manche = partie.manches[index];
  // Joueurs encore en jeu au début de cette manche.
  const avant = etatPartie({ ...partie, manches: partie.manches.slice(0, index) });
  const scores = lireScores(req.body?.scores, avant.enJeu);
  const inchange =
    Object.keys(scores).length === Object.keys(manche.scores).length &&
    Object.entries(scores).every(([j, p]) => manche.scores[j] === p);
  if (inchange) return;
  await ecrireScores(client, id, scores);
  await journaliser(client, req, {
    action: 'manche.corrigee',
    tourId: partie.tourId,
    partieId: partie.id,
    mancheId: id,
    mancheNum: manche.num,
    avant: { scores: manche.scores },
    apres: { scores },
  });
}));

app.delete('/api/manches/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rows } = await client.query('SELECT partie_id FROM manches WHERE id = $1', [id]);
  if (!rows[0]) echec(404, 'Manche introuvable');
  const partie = await partieOu404(client, rows[0].partie_id, { verrou: true });
  const manche = partie.manches.find((m) => m.id === id);
  await client.query('DELETE FROM manches WHERE id = $1', [id]);
  // Renumérote les manches suivantes (en deux temps pour respecter l'unicité).
  await client.query('UPDATE manches SET num = -num WHERE partie_id = $1 AND num > $2', [partie.id, manche.num]);
  await client.query('UPDATE manches SET num = -num - 1 WHERE partie_id = $1 AND num < 0', [partie.id]);
  await journaliser(client, req, {
    action: 'manche.supprimee',
    tourId: partie.tourId,
    partieId: partie.id,
    mancheId: id,
    mancheNum: manche.num,
    avant: { num: manche.num, creeLe: manche.creeLe, scores: manche.scores },
  });
}));

// --- Journal ---
app.get('/api/parties/:id/journal', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await lireJournal(pool, { partieId: idParam(req) }));
}));

app.get('/api/journal', route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actions = String(req.query.actions ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const limite = Number(req.query.limite) || 50;
  res.json(await lireJournal(pool, { actions, limite }));
}));

app.post('/api/journal/:id/retablir', ecriture(async (client, req) => {
  await retablir(client, req, idParam(req));
}));

app.get('/api/export', route(async (req, res) => {
  const tables = ['joueurs', 'reglages', 'tours', 'parties', 'partie_joueurs', 'manches', 'manche_scores', 'journal'];
  const dump = { exporte_le: new Date().toISOString() };
  for (const t of tables) dump[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
  const jour = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="rimarami-${jour}.json"`);
  res.json(dump);
}));

app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route inconnue' }));

app.use(express.static(dossierPublic, { maxAge: 0 }));

app.use((err, req, res, next) => {
  if (err instanceof ErreurHttp) return res.status(err.status).json({ erreur: err.message, code: err.code });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'JSON invalide' });
  console.error(err);
  res.status(500).json({ erreur: 'Erreur serveur' });
});

await initialiser(pool);
const serveur = app.listen(PORT, () => {
  console.log(`rimarami prêt sur le port ${PORT}${PIN ? ' (code d’accès activé)' : ''}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    serveur.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
