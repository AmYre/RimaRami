// Journal des modifications et retour en arrière.
import { echec } from './erreurs.js';
import { lirePartie, ecrireScores, etatPartie } from './db.js';

/** Résumé lisible de l'appareil : « iPhone, Safari (a3f9c2) ». */
export function appareil(req) {
  const ua = req.get('user-agent') ?? '';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const nav = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari/.test(ua)
            ? 'Safari'
            : null;
  const id = /^[a-f0-9]{6}$/.test(req.get('x-appareil') ?? '') ? req.get('x-appareil') : null;
  const base = [os, nav].filter(Boolean).join(', ') || (ua ? ua.slice(0, 40) : 'appareil inconnu');
  return id ? `${base} (${id})` : base;
}

/** Toute modification doit être signée : nom choisi sur le téléphone. */
export function exigerAuteur(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/pin') return next();
  let auteur = '';
  try {
    auteur = decodeURIComponent(req.get('x-auteur') ?? '').trim().replace(/\s+/g, ' ');
  } catch {
    auteur = '';
  }
  if (!auteur || auteur.length > 30) {
    return res.status(428).json({ erreur: 'Indique qui fait la modification', code: 'auteur' });
  }
  req.auteur = auteur;
  req.appareil = appareil(req);
  next();
}

export async function journaliser(client, req, { action, tourId, partieId, mancheId, mancheNum, avant, apres }) {
  await client.query(
    `INSERT INTO journal (auteur, appareil, action, tour_id, partie_id, manche_id, manche_num, avant, apres)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      req.auteur ?? null,
      req.appareil ?? null,
      action,
      tourId ?? null,
      partieId ?? null,
      mancheId ?? null,
      mancheNum ?? null,
      avant == null ? null : JSON.stringify(avant),
      apres == null ? null : JSON.stringify(apres),
    ],
  );
}

const versObjet = (r) => ({
  id: r.id,
  le: r.le,
  auteur: r.auteur,
  appareil: r.appareil,
  action: r.action,
  tourId: r.tour_id,
  partieId: r.partie_id,
  mancheId: r.manche_id,
  mancheNum: r.manche_num,
  avant: r.avant,
  apres: r.apres,
});

/** Événements, du plus récent au plus ancien. */
export async function lireJournal(db, { partieId = null, actions = null, limite = 200 } = {}) {
  const conditions = [];
  const params = [];
  if (partieId != null) {
    params.push(partieId);
    conditions.push(`partie_id = $${params.length}`);
  }
  if (actions?.length) {
    params.push(actions);
    conditions.push(`action = ANY($${params.length}::text[])`);
  }
  params.push(Math.min(Math.max(limite, 1), 500));
  const { rows } = await db.query(
    `SELECT * FROM journal ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(versObjet);
}

/** Copie complète d'une partie, gardée dans le journal avant suppression. */
export async function instantanePartie(client, partieId) {
  const partie = await lirePartie(client, partieId);
  if (!partie) return null;
  const tour = (await client.query('SELECT id, cree_le FROM tours WHERE id = $1', [partie.tourId])).rows[0];
  return { tour: { id: tour.id, creeLe: tour.cree_le }, partie };
}

const memesJoueurs = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** Annule l'effet d'un événement du journal (correction, suppression de manche ou de partie). */
export async function retablir(client, req, evenementId) {
  const evt = (await client.query('SELECT * FROM journal WHERE id = $1', [evenementId])).rows.map(versObjet)[0];
  if (!evt) echec(404, 'Modification introuvable');

  if (evt.action === 'manche.corrigee') {
    const ligne = (await client.query('SELECT partie_id FROM manches WHERE id = $1', [evt.mancheId])).rows[0];
    if (!ligne) echec(409, 'Cette manche a été supprimée depuis : rétablis-la d’abord.');
    const partie = await lirePartie(client, ligne.partie_id, { verrou: true });
    const index = partie.manches.findIndex((m) => m.id === evt.mancheId);
    const manche = partie.manches[index];
    const voulus = evt.avant.scores;
    const attendus = etatPartie({ ...partie, manches: partie.manches.slice(0, index) }).enJeu;
    if (!memesJoueurs(attendus, Object.keys(voulus).map(Number))) {
      echec(409, 'Impossible de revenir à ces scores : les joueurs en jeu ont changé depuis.');
    }
    await ecrireScores(client, manche.id, voulus);
    await journaliser(client, req, {
      action: 'manche.retablie',
      tourId: partie.tourId,
      partieId: partie.id,
      mancheId: manche.id,
      mancheNum: manche.num,
      avant: { scores: manche.scores },
      apres: { scores: voulus, source: evt.id },
    });
    return;
  }

  if (evt.action === 'manche.supprimee') {
    const partie = await lirePartie(client, evt.partieId, { verrou: true });
    if (!partie) echec(409, 'La partie a été supprimée depuis : rétablis-la d’abord.');
    if (partie.manches.some((m) => m.id === evt.mancheId)) echec(409, 'Cette manche est déjà rétablie.');
    const num = Math.min(evt.avant.num, partie.manches.length + 1);
    await client.query('UPDATE manches SET num = -num WHERE partie_id = $1 AND num >= $2', [partie.id, num]);
    await client.query('UPDATE manches SET num = -num + 1 WHERE partie_id = $1 AND num < 0', [partie.id]);
    await client.query('INSERT INTO manches (id, partie_id, num, cree_le) VALUES ($1, $2, $3, $4)', [
      evt.mancheId,
      partie.id,
      num,
      evt.avant.creeLe ?? new Date(),
    ]);
    await ecrireScores(client, evt.mancheId, evt.avant.scores);
    await journaliser(client, req, {
      action: 'manche.retablie',
      tourId: partie.tourId,
      partieId: partie.id,
      mancheId: evt.mancheId,
      mancheNum: num,
      apres: { scores: evt.avant.scores, source: evt.id },
    });
    return;
  }

  if (evt.action === 'partie.supprimee') {
    const { tour, partie } = evt.avant;
    const existe = (await client.query('SELECT 1 FROM parties WHERE id = $1', [partie.id])).rowCount;
    if (existe) echec(409, 'Cette partie est déjà rétablie.');
    await client.query('INSERT INTO tours (id, cree_le) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tour.id, tour.creeLe]);
    await client.query(
      'INSERT INTO parties (id, tour_id, num_table, seuil, restants, bareme, cree_le) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [partie.id, tour.id, partie.table, partie.seuil, partie.restants, JSON.stringify(partie.bareme), partie.creeLe],
    );
    for (const [siege, joueurId] of partie.joueurs.entries()) {
      await client.query('INSERT INTO partie_joueurs (partie_id, joueur_id, siege) VALUES ($1, $2, $3)', [
        partie.id,
        joueurId,
        siege,
      ]);
    }
    for (const m of partie.manches) {
      await client.query('INSERT INTO manches (id, partie_id, num, cree_le) VALUES ($1, $2, $3, $4)', [
        m.id,
        partie.id,
        m.num,
        m.creeLe,
      ]);
      await ecrireScores(client, m.id, m.scores);
    }
    await journaliser(client, req, {
      action: 'partie.retablie',
      tourId: tour.id,
      partieId: partie.id,
      apres: { source: evt.id, manches: partie.manches.length },
    });
    return;
  }

  echec(400, 'Cette modification ne peut pas être annulée.');
}
