// Règles du rami (version du groupe) et calcul du classement.
// Module partagé : importé par le serveur Node et par le navigateur.

export const REGLAGES_PAR_DEFAUT = {
  // Un joueur dont le total dépasse le seuil est sorti.
  seuil: 701,
  // La partie s'arrête quand il ne reste plus que ce nombre de joueurs sous le seuil
  // (4 joueurs → 2 sortis, 3 joueurs → 1 sorti).
  restants: 2,
  // Points de classement par place, pour chaque table (index 0 = 1re place).
  bareme: { 1: [10, 7, 5, 3], 2: [5, 3, 1] },
  // Score d'une manche : celui qui n'a rien posé prend `rien` ; celui qui ferme prend `fermeSeul`
  // si personne d'autre n'est descendu, sinon `ferme` ; les autres comptent les cartes restées en main.
  manche: { rien: 100, fermeSeul: -20, ferme: -10 },
  // « Taxiphone » : le joueur qui prend le +100 (rien posé) `fois` fois dans la même partie.
  taxiphone: { fois: 3 },
};

/**
 * Score du joueur qui ferme, selon les scores des autres joueurs de la manche.
 * @param {number[]} autres scores des autres joueurs
 */
export function scoreDuGagnant(autres, regle = REGLAGES_PAR_DEFAUT.manche) {
  const personneDescendu = autres.length > 0 && autres.every((v) => v === regle.rien);
  return personneDescendu ? regle.fermeSeul : regle.ferme;
}

export const JOUEURS_INITIAUX = ['Amir', 'Youns', 'Riadh', 'Mo Salah', 'Adel', 'Fares', 'Jelel'];

/** Nombre de joueurs à sortir pour terminer une partie de n joueurs. */
export function nombreASortir(n, restants = REGLAGES_PAR_DEFAUT.restants) {
  return Math.max(1, n - restants);
}

/**
 * Calcule l'état d'une partie à partir de ses manches.
 *
 * - Après chaque manche, tout joueur encore en jeu dont le total dépasse le seuil est sorti.
 * - Un joueur sorti ne marque plus de points.
 * - La partie se termine dès que `nombreASortir` joueurs sont sortis.
 * - Places : les joueurs encore en jeu sont classés au plus petit total ; les sortis sont
 *   derrière, le premier sorti étant dernier (même manche : le plus gros total est derrière).
 *   Égalité parfaite = même place.
 *
 * @param {object}   p
 * @param {number[]} p.joueurs   ids des joueurs, dans l'ordre autour de la table
 * @param {{scores: Record<string, number>}[]} p.manches  manches dans l'ordre
 * @param {number}   p.seuil
 * @param {number}   [p.restants]
 * @param {number[]} [p.bareme]  points de classement par place
 */
export function calculerPartie({ joueurs, manches, seuil, restants = REGLAGES_PAR_DEFAUT.restants, bareme = [] }) {
  const aSortir = nombreASortir(joueurs.length, restants);
  const totaux = Object.fromEntries(joueurs.map((id) => [id, 0]));
  const sortiA = {}; // id -> index de la manche où il est sorti
  const ordreSortie = [];
  const detail = [];
  let finIndex = null;

  manches.forEach((m, i) => {
    if (finIndex !== null) {
      detail.push({ actifs: [], sortisIci: [], horsPartie: true });
      return;
    }
    const actifs = joueurs.filter((id) => !(id in sortiA));
    for (const id of actifs) totaux[id] += toInt(m.scores?.[id]);
    const sortisIci = actifs.filter((id) => totaux[id] > seuil).sort((a, b) => totaux[b] - totaux[a]);
    for (const id of sortisIci) {
      sortiA[id] = i;
      ordreSortie.push(id);
    }
    detail.push({ actifs, sortisIci, horsPartie: false });
    if (ordreSortie.length >= aSortir) finIndex = i;
  });

  const terminee = finIndex !== null;
  const enJeu = joueurs.filter((id) => !(id in sortiA));

  // a avant b ? (négatif = a mieux classé)
  const comparer = (a, b) => {
    const aOut = a in sortiA;
    const bOut = b in sortiA;
    if (aOut !== bOut) return aOut ? 1 : -1;
    if (aOut && sortiA[a] !== sortiA[b]) return sortiA[b] - sortiA[a];
    return totaux[a] - totaux[b];
  };

  const classement = joueurs
    .map((id) => {
      const place = 1 + joueurs.filter((autre) => comparer(autre, id) < 0).length;
      return {
        id,
        total: totaux[id],
        reste: seuil - totaux[id],
        sorti: id in sortiA,
        sortiManche: id in sortiA ? sortiA[id] + 1 : null,
        place,
        points: terminee ? (bareme[place - 1] ?? 0) : null,
      };
    })
    .sort((a, b) => a.place - b.place || joueurs.indexOf(a.id) - joueurs.indexOf(b.id));

  return {
    terminee,
    aSortir,
    sortisRestants: Math.max(0, aSortir - ordreSortie.length),
    totaux,
    enJeu,
    ordreSortie,
    classement,
    detail,
    // Manches enregistrées après la fin (possible seulement après une correction).
    manchesEnTrop: terminee ? manches.length - 1 - finIndex : 0,
  };
}

/**
 * Nombre de manches où chaque joueur a pris le +100 (rien posé), tant qu'il était en jeu.
 * @param {number[]} joueurs
 * @param {{scores: Record<string, number>}[]} manches
 * @param {ReturnType<typeof calculerPartie>['detail']} detail
 */
export function compterRien(joueurs, manches, detail, rien = REGLAGES_PAR_DEFAUT.manche.rien) {
  const compte = Object.fromEntries(joueurs.map((id) => [id, 0]));
  manches.forEach((m, i) => {
    const d = detail[i];
    if (!d || d.horsPartie) return;
    for (const id of d.actifs) if (toInt(m.scores?.[id]) === rien) compte[id] += 1;
  });
  return compte;
}

/**
 * Joueurs « taxiphone » d'une partie.
 * @param {{rien: number, fois: number}} regle
 */
export function taxiphones(joueurs, manches, detail, regle = { rien: 100, fois: 3 }) {
  const compte = compterRien(joueurs, manches, detail, regle.rien);
  return { compte, taxi: joueurs.filter((id) => compte[id] >= regle.fois) };
}

/**
 * Classement général à partir des parties terminées.
 * @param {{table: number, etat: ReturnType<typeof calculerPartie>, joueurs?: number[], manches?: object[]}[]} parties
 *   du plus ancien au plus récent
 * @param {number[]} joueurs ids à inclure
 * @param {{taxiphone?: {rien: number, fois: number}}} [options]
 */
export function calculerClassement(parties, joueurs, { taxiphone = { rien: 100, fois: 3 } } = {}) {
  const stats = new Map(
    joueurs.map((id) => [
      id,
      { id, points: 0, parties: 0, victoires: 0, partiesT1: 0, sommePlaces: 0, taxiphone: 0, forme: [] },
    ]),
  );
  for (const p of parties) {
    if (!p.etat.terminee) continue;
    if (p.manches && p.joueurs) {
      for (const id of taxiphones(p.joueurs, p.manches, p.etat.detail, taxiphone).taxi) {
        if (stats.has(id)) stats.get(id).taxiphone += 1;
      }
    }
    for (const c of p.etat.classement) {
      const s = stats.get(c.id);
      if (!s) continue;
      s.points += c.points ?? 0;
      s.parties += 1;
      s.sommePlaces += c.place;
      if (c.place === 1) s.victoires += 1;
      if (p.table === 1) s.partiesT1 += 1;
      s.forme.push({ table: p.table, place: c.place });
    }
  }
  const lignes = [...stats.values()].map((s) => ({
    ...s,
    moyenne: s.parties ? s.points / s.parties : 0,
    forme: s.forme.slice(-5),
  }));
  lignes.sort(
    (a, b) =>
      b.points - a.points ||
      b.moyenne - a.moyenne ||
      b.victoires - a.victoires ||
      joueurs.indexOf(a.id) - joueurs.indexOf(b.id),
  );
  lignes.forEach((l, i) => {
    const prec = lignes[i - 1];
    l.rang = prec && prec.points === l.points && prec.moyenne === l.moyenne && prec.victoires === l.victoires ? prec.rang : i + 1;
  });
  return lignes;
}

/** Tailles des tables pour n joueurs : 7 → [4, 3], 8 → [4, 4], 6 → [3, 3], 5 → [3, 2]. */
export function taillesTables(n) {
  if (n <= 0) return [];
  if (n <= 4) return [n];
  const k = Math.ceil(n / 4);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Propose les tables du prochain tour par montée / descente :
 * le dernier de la table k descend, le premier de la table k+1 monte.
 *
 * @param {object} p
 * @param {{table: number, classement: {id: number, place: number}[]}[]|null} p.dernierTour
 * @param {number[]} p.presents  joueurs présents, par ordre de priorité (classement général)
 * @returns {{tables: number[][], mouvements: Record<number, 'monte'|'descend'|'nouveau'|'reste'>}}
 */
export function proposerTables({ dernierTour, presents }) {
  const avant = {}; // id -> table du tour précédent
  let echelle = [];
  if (dernierTour?.length) {
    const tables = [...dernierTour].sort((a, b) => a.table - b.table);
    const blocs = tables.map((t) => [...t.classement].sort((a, b) => a.place - b.place).map((c) => c.id));
    tables.forEach((t, i) => blocs[i].forEach((id) => (avant[id] = t.table)));
    for (let i = 0; i < blocs.length; i++) {
      if (i > 0 && echelle.length && blocs[i].length) {
        // échange à la frontière : le dernier du dessus contre le premier du dessous
        const dernier = echelle.pop();
        const [premier, ...reste] = blocs[i];
        echelle.push(premier, dernier, ...reste);
      } else {
        echelle.push(...blocs[i]);
      }
    }
  }
  const presentsSet = new Set(presents);
  const ordre = [...echelle.filter((id) => presentsSet.has(id)), ...presents.filter((id) => !echelle.includes(id))];
  return repartir(ordre, avant);
}

/** Répartit une liste ordonnée de joueurs en tables (les premiers en table 1). */
export function repartir(ordre, avant = {}) {
  const tailles = taillesTables(ordre.length);
  const tables = [];
  let i = 0;
  for (const t of tailles) {
    tables.push(ordre.slice(i, i + t));
    i += t;
  }
  return { tables, mouvements: mouvements(tables, avant) };
}

export function mouvements(tables, avant = {}) {
  const res = {};
  tables.forEach((t, i) =>
    t.forEach((id) => {
      const prec = avant[id];
      res[id] = prec == null ? 'nouveau' : prec > i + 1 ? 'monte' : prec < i + 1 ? 'descend' : 'reste';
    }),
  );
  return res;
}

export function melanger(liste, aleatoire = Math.random) {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(aleatoire() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
