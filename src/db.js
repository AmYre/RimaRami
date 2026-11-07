import fs from 'node:fs/promises';
import pg from 'pg';
import {
  REGLAGES_PAR_DEFAUT,
  JOUEURS_INITIAUX,
  calculerPartie,
  calculerClassement,
  proposerTables,
} from '../public/js/rules.js';

// Les colonnes INT8 (count…) arrivent en chaîne par défaut.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const nettoyer = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** DATABASE_URL, en tolérant les erreurs de saisie courantes (espaces, minuscules, guillemets). */
function urlBase() {
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (cle.trim().toUpperCase() === 'DATABASE_URL' && valeur?.trim()) return nettoyer(valeur);
  }
  return null;
}

function diagnosticEnv() {
  const noms = Object.keys(process.env).filter((k) => /DATABASE|POSTGRES|^PG[A-Z]|(^|_)DB(_|$)/i.test(k));
  const vide = Object.keys(process.env).some((k) => k.trim().toUpperCase() === 'DATABASE_URL');
  return [
    'DATABASE_URL manquant : l’appli ne sait pas où est la base.',
    vide ? 'La variable existe mais elle est vide.' : 'La variable n’existe pas dans le conteneur.',
    noms.length ? `Variables proches trouvées (noms seuls) : ${noms.join(', ')}` : 'Aucune variable liée à une base trouvée.',
    'Dans Dokploy : Application > Environment > Environment Settings (pas Build-time Arguments),',
    'une ligne DATABASE_URL=postgresql://user:motdepasse@hote:5432/base, puis Save et Deploy.',
  ].join('\n');
}

export function creerPool() {
  // Un fichier .env à côté de l'appli est aussi accepté (pratique en local).
  try {
    process.loadEnvFile?.();
  } catch {
    /* pas de .env */
  }
  const ssl = /^(1|true|require)$/i.test(process.env.PGSSL ?? '') ? { rejectUnauthorized: false } : undefined;
  const connectionString = urlBase();
  if (connectionString) return new pg.Pool({ connectionString, ssl, max: 5 });
  // Sinon, variables Postgres classiques (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
  if (process.env.PGHOST) return new pg.Pool({ ssl, max: 5 });
  throw new Error(diagnosticEnv());
}

/** Attend la base (elle peut démarrer après l'appli), crée le schéma et les données de départ. */
export async function initialiser(pool, { essais = 20, delaiMs = 3000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (i >= essais) throw err;
      console.log(`Base injoignable (${err.code ?? err.message}), nouvel essai dans ${delaiMs / 1000}s…`);
      await new Promise((r) => setTimeout(r, delaiMs));
    }
  }
  const schema = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);

  for (const [cle, valeur] of Object.entries(REGLAGES_PAR_DEFAUT)) {
    await pool.query('INSERT INTO reglages (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO NOTHING', [
      cle,
      JSON.stringify(valeur),
    ]);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM joueurs');
  if (rows[0].n === 0) {
    for (const nom of JOUEURS_INITIAUX) await pool.query('INSERT INTO joueurs (nom) VALUES ($1)', [nom]);
    console.log(`Joueurs créés : ${JOUEURS_INITIAUX.join(', ')}`);
  }
}

export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function lireReglages(db) {
  const { rows } = await db.query('SELECT cle, valeur FROM reglages');
  const r = structuredClone(REGLAGES_PAR_DEFAUT);
  for (const { cle, valeur } of rows) r[cle] = valeur;
  return r;
}

/** Données brutes, structurées par partie (sans calcul). */
export async function lireDonnees(db) {
  const [joueurs, reglages, tours, parties, pj, manches, scores] = await Promise.all([
    db.query('SELECT id, nom, actif FROM joueurs ORDER BY id'),
    lireReglages(db),
    db.query('SELECT id, cree_le FROM tours ORDER BY id'),
    db.query('SELECT id, tour_id, num_table, seuil, restants, bareme, cree_le FROM parties ORDER BY id'),
    db.query('SELECT partie_id, joueur_id FROM partie_joueurs ORDER BY partie_id, siege'),
    db.query('SELECT id, partie_id, num, cree_le FROM manches ORDER BY partie_id, num'),
    db.query('SELECT manche_id, joueur_id, points FROM manche_scores'),
  ]);

  const scoresParManche = new Map();
  for (const s of scores.rows) {
    if (!scoresParManche.has(s.manche_id)) scoresParManche.set(s.manche_id, {});
    scoresParManche.get(s.manche_id)[s.joueur_id] = s.points;
  }
  const partiesById = new Map(
    parties.rows.map((p) => [
      p.id,
      {
        id: p.id,
        tourId: p.tour_id,
        table: p.num_table,
        seuil: p.seuil,
        restants: p.restants,
        bareme: p.bareme,
        creeLe: p.cree_le,
        joueurs: [],
        manches: [],
      },
    ]),
  );
  for (const r of pj.rows) partiesById.get(r.partie_id)?.joueurs.push(r.joueur_id);
  for (const m of manches.rows) {
    partiesById.get(m.partie_id)?.manches.push({
      id: m.id,
      num: m.num,
      creeLe: m.cree_le,
      scores: scoresParManche.get(m.id) ?? {},
    });
  }
  const toursById = new Map(tours.rows.map((t) => [t.id, { id: t.id, creeLe: t.cree_le, parties: [] }]));
  for (const p of partiesById.values()) toursById.get(p.tourId)?.parties.push(p);

  return { joueurs: joueurs.rows, reglages, tours: [...toursById.values()], partiesById };
}

export function etatPartie(p) {
  return calculerPartie({
    joueurs: p.joueurs,
    manches: p.manches,
    seuil: p.seuil,
    restants: p.restants,
    bareme: p.bareme,
  });
}

/** Tout ce dont l'interface a besoin, calculé. */
export async function chargerEtat(db) {
  const { joueurs, reglages, tours } = await lireDonnees(db);

  for (const t of tours) {
    t.parties.sort((a, b) => a.table - b.table);
    for (const p of t.parties) p.etat = etatPartie(p);
    t.termine = t.parties.length > 0 && t.parties.every((p) => p.etat.terminee);
  }

  const toutesParties = tours.flatMap((t) => t.parties);
  const classement = calculerClassement(
    toutesParties.map((p) => ({ table: p.table, etat: p.etat })),
    joueurs.map((j) => j.id),
  );

  const dernierTermine = [...tours].reverse().find((t) => t.termine) ?? null;
  const actifs = new Set(joueurs.filter((j) => j.actif).map((j) => j.id));
  const presents = classement.map((l) => l.id).filter((id) => actifs.has(id));
  const proposition = {
    ...proposerTables({
      dernierTour: dernierTermine?.parties.map((p) => ({ table: p.table, classement: p.etat.classement })) ?? null,
      presents,
    }),
    depuisTour: dernierTermine?.id ?? null,
  };

  return {
    joueurs,
    reglages,
    tours: tours.reverse(), // plus récent d'abord
    classement,
    proposition,
  };
}
