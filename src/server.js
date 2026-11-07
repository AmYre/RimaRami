import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { creerPool, initialiser, transaction, chargerEtat, lireReglages, etatPartie } from './db.js';

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

class ErreurHttp extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const echec = (status, message) => {
  throw new ErreurHttp(status, message);
};

// --- Code d'accès (facultatif) : la lecture est libre, l'écriture demande le code. ---
const empreinte = (s) => crypto.createHash('sha256').update(String(s)).digest();
function pinValide(pin) {
  return !PIN || crypto.timingSafeEqual(empreinte(pin ?? ''), empreinte(PIN));
}
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/pin') return next();
  if (!pinValide(req.get('x-pin'))) return res.status(401).json({ erreur: 'Code d’accès requis' });
  next();
});

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

async function lirePartie(client, id, { verrou = false } = {}) {
  const { rows } = await client.query(
    `SELECT id, num_table, seuil, restants, bareme FROM parties WHERE id = $1 ${verrou ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) echec(404, 'Partie introuvable');
  const p = rows[0];
  const joueurs = (
    await client.query('SELECT joueur_id FROM partie_joueurs WHERE partie_id = $1 ORDER BY siege', [id])
  ).rows.map((r) => r.joueur_id);
  const manches = (await client.query('SELECT id, num FROM manches WHERE partie_id = $1 ORDER BY num', [id])).rows;
  const scores = (
    await client.query(
      'SELECT s.manche_id, s.joueur_id, s.points FROM manche_scores s JOIN manches m ON m.id = s.manche_id WHERE m.partie_id = $1',
      [id],
    )
  ).rows;
  for (const m of manches) {
    m.scores = Object.fromEntries(scores.filter((s) => s.manche_id === m.id).map((s) => [s.joueur_id, s.points]));
  }
  return { id: p.id, table: p.num_table, seuil: p.seuil, restants: p.restants, bareme: p.bareme, joueurs, manches };
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

async function ecrireScores(client, mancheId, scores) {
  await client.query('DELETE FROM manche_scores WHERE manche_id = $1', [mancheId]);
  for (const [joueurId, points] of Object.entries(scores)) {
    await client.query('INSERT INTO manche_scores (manche_id, joueur_id, points) VALUES ($1, $2, $3)', [
      mancheId,
      Number(joueurId),
      points,
    ]);
  }
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
  res.status(401).json({ erreur: 'Code incorrect' });
});

app.post('/api/joueurs', ecriture(async (client, req) => {
  const nom = nomJoueur(req.body?.nom);
  try {
    await client.query('INSERT INTO joueurs (nom) VALUES ($1)', [nom]);
  } catch (err) {
    if (err.code === '23505') echec(409, `${nom} existe déjà`);
    throw err;
  }
}));

app.patch('/api/joueurs/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rowCount } = await client.query('SELECT 1 FROM joueurs WHERE id = $1', [id]);
  if (!rowCount) echec(404, 'Joueur introuvable');
  if (req.body?.nom !== undefined) {
    try {
      await client.query('UPDATE joueurs SET nom = $1 WHERE id = $2', [nomJoueur(req.body.nom), id]);
    } catch (err) {
      if (err.code === '23505') echec(409, 'Ce nom existe déjà');
      throw err;
    }
  }
  if (req.body?.actif !== undefined) {
    await client.query('UPDATE joueurs SET actif = $1 WHERE id = $2', [Boolean(req.body.actif), id]);
  }
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
  for (const [cle, valeur] of Object.entries({ seuil, restants, bareme })) {
    await client.query(
      'INSERT INTO reglages (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur',
      [cle, JSON.stringify(valeur)],
    );
  }
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
    const partie = (
      await client.query(
        'INSERT INTO parties (tour_id, num_table, seuil, restants, bareme) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [tour.id, numTable, reglages.seuil, reglages.restants, JSON.stringify(reglages.bareme[numTable] ?? [])],
      )
    ).rows[0];
    for (const [siege, joueurId] of joueurs.entries()) {
      await client.query('INSERT INTO partie_joueurs (partie_id, joueur_id, siege) VALUES ($1, $2, $3)', [
        partie.id,
        joueurId,
        siege,
      ]);
    }
  }
}));

app.delete('/api/parties/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rows } = await client.query('DELETE FROM parties WHERE id = $1 RETURNING tour_id', [id]);
  if (!rows[0]) echec(404, 'Partie introuvable');
  await client.query('DELETE FROM tours t WHERE t.id = $1 AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.tour_id = t.id)', [
    rows[0].tour_id,
  ]);
}));

app.post('/api/parties/:id/manches', ecriture(async (client, req) => {
  const partie = await lirePartie(client, idParam(req), { verrou: true });
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
}));

app.put('/api/manches/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rows } = await client.query('SELECT partie_id FROM manches WHERE id = $1', [id]);
  if (!rows[0]) echec(404, 'Manche introuvable');
  const partie = await lirePartie(client, rows[0].partie_id, { verrou: true });
  const index = partie.manches.findIndex((m) => m.id === id);
  // Joueurs encore en jeu au début de cette manche.
  const avant = etatPartie({ ...partie, manches: partie.manches.slice(0, index) });
  await ecrireScores(client, id, lireScores(req.body?.scores, avant.enJeu));
}));

app.delete('/api/manches/:id', ecriture(async (client, req) => {
  const id = idParam(req);
  const { rows } = await client.query('DELETE FROM manches WHERE id = $1 RETURNING partie_id, num', [id]);
  if (!rows[0]) echec(404, 'Manche introuvable');
  const { partie_id: partieId, num } = rows[0];
  // Renumérote les manches suivantes (en deux temps pour respecter l'unicité).
  await client.query('UPDATE manches SET num = -num WHERE partie_id = $1 AND num > $2', [partieId, num]);
  await client.query('UPDATE manches SET num = -num - 1 WHERE partie_id = $1 AND num < 0', [partieId]);
}));

app.get('/api/export', route(async (req, res) => {
  const tables = ['joueurs', 'reglages', 'tours', 'parties', 'partie_joueurs', 'manches', 'manche_scores'];
  const dump = { exporte_le: new Date().toISOString() };
  for (const t of tables) dump[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
  const jour = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="rimarami-${jour}.json"`);
  res.json(dump);
}));

app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route inconnue' }));

app.use(express.static(dossierPublic, { maxAge: 0 }));

app.use((err, req, res, next) => {
  if (err instanceof ErreurHttp) return res.status(err.status).json({ erreur: err.message });
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
