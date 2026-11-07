import * as api from './api.js';
import {
  calculerPartie,
  proposerTables,
  repartir,
  mouvements,
  melanger,
  taxiphones,
  scoreDuGagnant,
  REGLAGES_PAR_DEFAUT,
} from './rules.js';

const app = document.getElementById('app');
let etat = null;
let signature = '';
const ui = {
  brouillons: {}, // saisies en cours, par formulaire
  edition: null, // { partieId, mancheId } quand on corrige une manche
  nouveau: null, // composition du prochain tour
  vus: {}, // partieId -> dernier état affiché (sortis, taxiphones, fin) pour repérer ce qui vient de changer
  effets: [], // animations à jouer après le prochain affichage
  distribuer: new Set(), // parties dont on montre la distribution des cartes
  occupe: false,
  journaux: {}, // clé -> événements du journal
  journauxPerimes: new Set(),
  journauxEnChargement: new Set(),
  journauxOuverts: {},
};

// ---------------------------------------------------------------- utilitaires

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nom = (id) => esc(etat.joueurs.find((j) => j.id === Number(id))?.nom ?? '?');
const pluriel = (n, mot, motPluriel = `${mot}s`) => `${n} ${n > 1 ? motPluriel : mot}`;
const fmtDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtHeure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dateCourte = (iso) => fmtDate.format(new Date(iso));
function quand(iso) {
  const d = new Date(iso);
  const jour = (x) => x.toDateString();
  const hier = new Date();
  hier.setDate(hier.getDate() - 1);
  if (jour(d) === jour(new Date())) return `aujourd’hui à ${fmtHeure.format(d)}`;
  if (jour(d) === jour(hier)) return `hier à ${fmtHeure.format(d)}`;
  return `${dateCourte(iso)} à ${fmtHeure.format(d)}`;
}
const ordinal = (n) => (n === 1 ? '1er' : `${n}e`);

const SUITES = {
  pique: '<path d="M12 2.5C9.2 6.4 4.5 9.2 4.5 13.3a3.9 3.9 0 0 0 6.6 2.8L10 21.5h4l-1.1-5.4a3.9 3.9 0 0 0 6.6-2.8c0-4.1-4.7-6.9-7.5-10.8z"/>',
  coeur: '<path d="M12 21.2S3.5 15.8 3.5 9.6A4.6 4.6 0 0 1 12 7.1a4.6 4.6 0 0 1 8.5 2.5c0 6.2-8.5 11.6-8.5 11.6z"/>',
  carreau: '<path d="M12 2.2 19 12l-7 9.8L5 12z"/>',
  trefle:
    '<path d="M12 2.8a3.7 3.7 0 0 0-3.4 5.2 3.7 3.7 0 1 0 2.1 6.6L9.7 21.5h4.6l-1-6.9a3.7 3.7 0 1 0 2.1-6.6A3.7 3.7 0 0 0 12 2.8z"/>',
};
const ORDRE_SUITES = ['pique', 'coeur', 'carreau', 'trefle'];
function suite(siege) {
  const s = ORDRE_SUITES[siege % 4];
  const rouge = s === 'coeur' || s === 'carreau';
  return `<svg class="couleur" viewBox="0 0 24 24" fill="${rouge ? 'var(--rouge)' : 'currentColor'}" aria-hidden="true">${SUITES[s]}</svg>`;
}

function trouverPartie(id) {
  for (const tour of etat.tours) {
    const partie = tour.parties.find((p) => p.id === id);
    if (partie) return { partie, tour };
  }
  return null;
}
const numeroTour = (tour) => etat.tours.length - etat.tours.indexOf(tour);

function toast(message, erreur = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast${erreur ? ' erreur' : ''}`;
  t.setAttribute('role', erreur ? 'alert' : 'status');
  t.textContent = message;
  document.body.append(t);
  setTimeout(() => t.remove(), erreur ? 5000 : 2500);
}

// ---------------------------------------------------------------- données

function appliquer(nouvelEtat) {
  etat = nouvelEtat;
  signature = JSON.stringify(nouvelEtat);
  render();
}

async function rafraichir({ force = false } = {}) {
  try {
    const e = await api.etat();
    const sig = JSON.stringify(e);
    if (!force && sig === signature) return;
    // Ne pas redessiner sous les doigts de quelqu'un qui tape un score.
    if (!force && etat && document.activeElement?.matches?.('input, select, textarea')) return;
    perimerJournaux();
    appliquer(e);
  } catch (err) {
    if (!etat) {
      app.innerHTML = `<div class="section vide-etat"><h1>rimarami</h1><p>${esc(err.message)}</p>
        <button class="btn principal" data-action="recharger">Réessayer</button></div>`;
    }
  }
}

/** Lance une écriture ; demande qui saisit, et le code d'accès si le serveur l'exige. */
async function ecrire(fn, message) {
  if (ui.occupe) return false;
  if (!api.auteur() && !(await demanderAuteur())) {
    toast('Modification annulée : indique qui fait la modification.', true);
    return false;
  }
  ui.occupe = true;
  document.querySelectorAll('button[type="submit"]').forEach((b) => (b.disabled = true));
  try {
    let resultat;
    for (let essai = 0; ; essai++) {
      try {
        resultat = await fn();
        break;
      } catch (err) {
        if (essai >= 2) throw err;
        if (err.status === 401) {
          api.enregistrerPin(null);
          if (!(await demanderPin())) {
            toast('Modification annulée : il faut le code d’accès.', true);
            return false;
          }
        } else if (err.status === 428) {
          if (!(await demanderAuteur())) {
            toast('Modification annulée : indique qui fait la modification.', true);
            return false;
          }
        } else {
          throw err;
        }
      }
    }
    perimerJournaux();
    appliquer(resultat);
    if (message) toast(message);
    return true;
  } catch (err) {
    toast(err.message, true);
    if (err.status === 409) await rafraichir({ force: true });
    return false;
  } finally {
    ui.occupe = false;
    document.querySelectorAll('button[type="submit"]').forEach((b) => (b.disabled = false));
  }
}

function demanderPin() {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form>
      <h2>Code d’accès</h2>
      <p class="doux petit">Il faut le code pour modifier les scores. Il restera enregistré sur ce téléphone.</p>
      <div class="champ"><label for="pin">Code</label>
        <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" required></div>
      <p class="alerte" hidden></p>
      <div class="actions"><button type="button" class="btn" data-annuler>Annuler</button>
        <button type="submit" class="btn principal">Valider</button></div>
    </form>`;
    document.body.append(d);
    const input = d.querySelector('input');
    const alerte = d.querySelector('.alerte');
    const fin = (ok) => {
      d.close();
      d.remove();
      resolve(ok);
    };
    d.querySelector('[data-annuler]').addEventListener('click', () => fin(false));
    d.addEventListener('cancel', () => fin(false));
    d.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pin = input.value.trim();
      try {
        await api.verifierPin(pin);
        api.enregistrerPin(pin);
        fin(true);
      } catch (err) {
        alerte.hidden = false;
        alerte.textContent = err.status === 401 ? 'Code incorrect.' : err.message;
        input.select();
      }
    });
    d.showModal();
    input.focus();
  });
}

/** Demande qui utilise ce téléphone : son nom signe les modifications. */
function demanderAuteur() {
  return new Promise((resolve) => {
    const actuel = api.auteur();
    const d = document.createElement('dialog');
    d.innerHTML = `<form>
      <h2>Qui saisit ?</h2>
      <p class="doux petit">Ton nom signe les modifications faites depuis ce téléphone. Tu pourras le changer dans Réglages.</p>
      <div class="puces">
        ${etat.joueurs
          .filter((j) => j.actif)
          .map((j) => `<button type="button" class="puce" data-nom="${esc(j.nom)}" aria-pressed="${j.nom === actuel}">${esc(j.nom)}</button>`)
          .join('')}
      </div>
      <div class="champ"><label for="autre-nom">Autre nom</label>
        <input id="autre-nom" maxlength="30" autocomplete="off" placeholder="Un invité, par exemple"></div>
      <div class="actions"><button type="button" class="btn" data-annuler>Annuler</button>
        <button type="submit" class="btn principal">Valider</button></div>
    </form>`;
    document.body.append(d);
    const fin = (nom) => {
      if (nom) api.enregistrerAuteur(nom);
      d.close();
      d.remove();
      resolve(nom || null);
    };
    d.querySelectorAll('[data-nom]').forEach((b) => b.addEventListener('click', () => fin(b.dataset.nom)));
    d.querySelector('[data-annuler]').addEventListener('click', () => fin(null));
    d.addEventListener('cancel', () => fin(null));
    d.querySelector('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const nom = d.querySelector('#autre-nom').value.trim().replace(/\s+/g, ' ');
      if (nom) fin(nom);
      else d.querySelector('#autre-nom').focus();
    });
    d.showModal();
  });
}

// ---------------------------------------------------------------- journal des modifications

function perimerJournaux() {
  for (const cle of Object.keys(ui.journaux)) ui.journauxPerimes.add(cle);
}

function requeteJournal(cle) {
  if (cle.startsWith('p')) return api.journalPartie(Number(cle.slice(1)));
  if (cle === 'supprimees') return api.journal({ actions: ['partie.supprimee'], limite: 30 });
  return api.journal({ actions: ['joueur.ajoute', 'joueur.modifie', 'reglages.modifies'], limite: 20 });
}

/** Charge les journaux affichés à l'écran qui manquent ou ne sont plus à jour. */
function chargerJournauxVisibles() {
  for (const el of document.querySelectorAll('[data-journal]')) {
    const cle = el.dataset.journal;
    if ((ui.journaux[cle] && !ui.journauxPerimes.has(cle)) || ui.journauxEnChargement.has(cle)) continue;
    ui.journauxEnChargement.add(cle);
    requeteJournal(cle)
      .then((evts) => {
        ui.journaux[cle] = evts;
        ui.journauxPerimes.delete(cle);
      })
      .catch(() => {})
      .finally(() => {
        ui.journauxEnChargement.delete(cle);
        document.querySelectorAll(`[data-journal="${cle}"]`).forEach((e) => (e.innerHTML = contenuJournal(cle)));
      });
  }
}

const blocJournal = (cle) => `<div data-journal="${cle}">${contenuJournal(cle)}</div>`;

const scoresTexte = (s) =>
  Object.entries(s ?? {})
    .map(([id, p]) => `${nom(id)} ${p}`)
    .join(', ');

function diffScores(a = {}, b = {}) {
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const changes = ids
    .filter((id) => Number(a[id]) !== Number(b[id]))
    .map((id) => `${nom(id)} ${a[id] ?? '–'} → <b>${b[id] ?? '–'}</b>`);
  return changes.length ? changes.join(', ') : 'Aucun changement';
}

const memesScores = (a = {}, b = {}) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Number(a[k]) === Number(b[k]));
};

function decrire(e) {
  const a = e.avant ?? {};
  const b = e.apres ?? {};
  switch (e.action) {
    case 'partie.creee':
      return { texte: 'a lancé la partie', detail: (b.joueurs ?? []).map(nom).join(', ') };
    case 'manche.ajoutee':
      return { texte: `a enregistré la manche ${e.mancheNum}`, detail: scoresTexte(b.scores) };
    case 'manche.corrigee':
      return { texte: `a corrigé la manche ${e.mancheNum}`, detail: diffScores(a.scores, b.scores) };
    case 'manche.supprimee':
      return { texte: `a supprimé la manche ${e.mancheNum}`, detail: scoresTexte(a.scores) };
    case 'manche.retablie':
      return {
        texte: e.avant ? `a remis les anciens scores de la manche ${e.mancheNum}` : `a rétabli la manche ${e.mancheNum}`,
        detail: e.avant ? diffScores(a.scores, b.scores) : scoresTexte(b.scores),
      };
    case 'partie.supprimee': {
      const p = a.partie;
      return {
        texte: p ? `a supprimé la table ${p.table} du ${dateCourte(a.tour.creeLe)}` : 'a supprimé la partie',
        detail: p ? `${p.joueurs.map(nom).join(', ')}. ${pluriel(p.manches.length, 'manche')} jouée${p.manches.length > 1 ? 's' : ''}.` : '',
      };
    }
    case 'partie.retablie':
      return { texte: 'a rétabli la partie', detail: '' };
    case 'joueur.ajoute':
      return { texte: `a ajouté ${esc(b.nom)} aux joueurs`, detail: '' };
    case 'joueur.modifie':
      if (a.nom !== b.nom) return { texte: `a renommé ${esc(a.nom)} en ${esc(b.nom)}`, detail: '' };
      return { texte: b.actif ? `a remis ${esc(b.nom)} parmi les joueurs` : `a retiré ${esc(b.nom)} des joueurs`, detail: '' };
    case 'reglages.modifies': {
      const changes = [];
      if (a.seuil !== b.seuil) changes.push(`seuil ${a.seuil} → <b>${b.seuil}</b>`);
      if (a.restants !== b.restants) changes.push(`joueurs restants ${a.restants} → <b>${b.restants}</b>`);
      for (const t of ['1', '2']) {
        const av = (a.bareme?.[t] ?? []).join(', ');
        const ap = (b.bareme?.[t] ?? []).join(', ');
        if (av !== ap) changes.push(`table ${t} : ${av || '–'} → <b>${ap || '–'}</b>`);
      }
      const mx = (m) => (m ? `+${m.rien}, ${m.fermeSeul} et ${m.ferme}` : '–');
      if (mx(a.manche) !== mx(b.manche)) changes.push(`manche ${mx(a.manche)} → <b>${mx(b.manche)}</b>`);
      const tx = (t) => (t ? `${t.fois} fois` : '–');
      if (tx(a.taxiphone) !== tx(b.taxiphone)) changes.push(`taxiphone ${tx(a.taxiphone)} → <b>${tx(b.taxiphone)}</b>`);
      return { texte: 'a modifié les règles', detail: changes.join(' ; ') };
    }
    default:
      return { texte: esc(e.action), detail: '' };
  }
}

/** Pour les suppressions, seule la plus récente d'un même élément peut être rétablie. */
function suppressionsRecentes(evts = []) {
  const vus = new Set();
  const ids = new Set();
  for (const e of evts) {
    const cle = e.action === 'manche.supprimee' ? `m${e.mancheId}` : e.action === 'partie.supprimee' ? `p${e.partieId}` : null;
    if (!cle || vus.has(cle)) continue;
    vus.add(cle);
    ids.add(e.id);
  }
  return ids;
}

function boutonRetablir(e, partie, recentes) {
  if (e.action.endsWith('.supprimee') && !recentes.has(e.id)) return '';
  let texte = null;
  if (e.action === 'manche.corrigee' && partie) {
    const m = partie.manches.find((x) => x.id === e.mancheId);
    if (m && !memesScores(m.scores, e.avant?.scores)) texte = 'Remettre les scores d’avant';
  } else if (e.action === 'manche.supprimee' && partie) {
    if (!partie.manches.some((x) => x.id === e.mancheId)) texte = 'Rétablir cette manche';
  } else if (e.action === 'partie.supprimee') {
    if (!trouverPartie(e.partieId)) texte = 'Rétablir cette partie';
  }
  return texte
    ? `<button type="button" class="btn retablir" data-action="retablir" data-evt="${e.id}" data-texte="${texte}">${texte}</button>`
    : '';
}

function ligneJournal(e, partie, recentes) {
  const { texte, detail } = decrire(e);
  return `<li>
    <p><b>${e.auteur ? esc(e.auteur) : 'Quelqu’un'}</b> ${texte}</p>
    ${detail ? `<p class="detail">${detail}</p>` : ''}
    <p class="meta"><time datetime="${esc(e.le)}">${quand(e.le)}</time>${e.appareil ? `, ${esc(e.appareil)}` : ''}</p>
    ${boutonRetablir(e, partie, recentes)}
  </li>`;
}

function contenuJournal(cle) {
  const evts = ui.journaux[cle];

  if (cle.startsWith('p')) {
    const partie = trouverPartie(Number(cle.slice(1)))?.partie ?? null;
    const resume = !evts
      ? 'Chargement…'
      : evts.length
        ? `${pluriel(evts.length, 'modification')}, la dernière par ${esc(evts[0].auteur ?? 'quelqu’un')} ${quand(evts[0].le)}`
        : 'Aucune modification';
    return `<details class="feuille journal" data-cle="${cle}" ${ui.journauxOuverts[cle] ? 'open' : ''}>
      <summary><span class="titre"><h2>Historique des modifications</h2><span class="doux petit">${resume}</span></span></summary>
      ${evts?.length ? `<ol class="journal-liste">${evts.map((e) => ligneJournal(e, partie, suppressionsRecentes(evts))).join('')}</ol>` : ''}
    </details>`;
  }

  if (cle === 'supprimees') {
    const recentes = suppressionsRecentes(evts);
    const absentes = (evts ?? []).filter((e) => recentes.has(e.id) && !trouverPartie(e.partieId));
    if (!absentes.length) return '';
    return `<div class="feuille">
      <h2>Parties supprimées</h2>
      <ol class="journal-liste">${absentes.map((e) => ligneJournal(e, null, recentes)).join('')}</ol>
    </div>`;
  }

  return `<div class="feuille">
    <h2>Modifications des règles et des joueurs</h2>
    ${
      !evts
        ? '<p class="doux petit">Chargement…</p>'
        : evts.length
          ? `<ol class="journal-liste">${evts.map((e) => ligneJournal(e, null, new Set())).join('')}</ol>`
          : '<p class="doux petit">Aucune modification pour l’instant.</p>'
    }
  </div>`;
}

// ---------------------------------------------------------------- composants

const COMBINE =
  '<svg class="combine" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';

const regleManche = () => etat.reglages.manche ?? REGLAGES_PAR_DEFAUT.manche;
const regleTaxi = () => ({ rien: regleManche().rien, fois: (etat.reglages.taxiphone ?? REGLAGES_PAR_DEFAUT.taxiphone).fois });
const infosTaxi = (partie) => taxiphones(partie.joueurs, partie.manches, partie.etat.detail, regleTaxi());

function badgeTaxi(n) {
  return `<span class="taxi" title="Taxiphone : ${n} fois +${regleTaxi().rien}">${COMBINE}<b>${n}</b></span>`;
}

function carte(partie, c, { compact = false, anime = false, taxi = 0 } = {}) {
  const siege = partie.joueurs.indexOf(c.id);
  const badge = taxi >= regleTaxi().fois ? badgeTaxi(taxi) : '';
  const libelleTaxi = badge ? `, taxiphone (${taxi} fois)` : '';
  if (c.sorti) {
    return `<div class="carte sortie${anime ? ' vient-de-sortir' : ''}" data-joueur="${c.id}" role="group" aria-label="${nom(c.id)}, sorti avec ${c.total} points${libelleTaxi}">
      <div class="etiquette"><div class="nom">${nom(c.id)}</div><div class="total">${c.total}</div>
      ${compact ? '' : `<div class="reste">sorti</div>`}</div>${badge}</div>`;
  }
  const ratio = Math.min(1, Math.max(0, c.total / partie.seuil));
  const danger = c.reste <= 100 && !partie.etat.terminee;
  const gagnante = partie.etat.terminee && c.place === 1;
  return `<div class="carte${danger ? ' danger' : ''}${gagnante ? ' gagnante' : ''}" data-joueur="${c.id}" role="group" aria-label="${nom(c.id)}, ${c.total} points, ${ordinal(c.place)}${gagnante ? ', gagnant' : ''}${libelleTaxi}">
    ${badge}
    <div class="coin" aria-hidden="true"><span class="rang">${c.place}</span>${suite(siege)}</div>
    <div class="milieu">
      <div class="total">${c.total}</div>
      <div class="nom">${nom(c.id)}</div>
      <div class="jauge" aria-hidden="true"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>
      <div class="reste">reste ${c.reste}</div>
    </div>
  </div>`;
}

function jeu(partie, { compact = false, animer = [], distribuer = false } = {}) {
  const parId = Object.fromEntries(partie.etat.classement.map((c) => [c.id, c]));
  const { compte } = infosTaxi(partie);
  const n = partie.joueurs.length;
  return `<div class="jeu${compact ? ' compact' : ''}${distribuer ? ' distribue' : ''}" style="--n:${n}">
    ${partie.joueurs
      .map((id, i) => {
        // Chaque carte est posée un peu de travers ; à la distribution elle part du centre de la table.
        const style = `--i:${i};--pose:rotate(${i % 2 ? 1 : -1.2}deg);--dx:${Math.round(((n - 1) / 2 - i) * 70)}px`;
        return `<div class="place" style="${style}">${carte(partie, parId[id], { compact, anime: animer.includes(id), taxi: compte[id] })}</div>`;
      })
      .join('')}
  </div>`;
}

function statut(partie) {
  const e = partie.etat;
  if (e.terminee) return `Terminée en ${pluriel(partie.manches.length, 'manche')}`;
  if (!partie.manches.length) return 'Première manche à jouer';
  return `Manche ${partie.manches.length + 1}, encore ${pluriel(e.sortisRestants, 'joueur')} à sortir`;
}

/** Le mur du café (titre) puis, posé sur la table juste en dessous, le contenu éventuel (les cartes). */
function bandeau({ titre, sousTitre = '', retour = null, contenu = '' }) {
  return `<header class="bandeau">
    <div class="mur">
      ${
        retour
          ? `<a class="marque" href="${retour.href}">‹ ${esc(retour.texte)}</a>`
          : `<span class="marque"><span class="ar" lang="ar" dir="rtl" aria-hidden="true">رامي</span> rimarami</span>`
      }
      <h1>${titre}</h1>
      ${sousTitre ? `<p class="sous-titre">${sousTitre}</p>` : ''}
    </div>
    <div class="frise" aria-hidden="true"></div>
  </header>
  ${contenu ? `<div class="tapis">${contenu}</div>` : ''}`;
}

// ---------------------------------------------------------------- vue : accueil

function vueAccueil() {
  const tour = etat.tours[0];
  if (!tour) {
    const n = etat.joueurs.filter((j) => j.actif).length;
    return `${bandeau({ titre: 'Aucune partie', sousTitre: `${n} joueurs prêts à jouer` })}
      <div class="section vide-etat">
        <p>Lance un tour pour répartir les joueurs entre la table 1 (4 joueurs) et la table 2 (3 joueurs).</p>
        <a class="btn principal plein" href="#/nouveau">Lancer le premier tour</a>
      </div>`;
  }
  const enCours = !tour.termine;
  const top = etat.classement.filter((l) => l.parties > 0).slice(0, 3);
  return `${bandeau({
    titre: enCours ? `Tour ${numeroTour(tour)}` : `Tour ${numeroTour(tour)} terminé`,
    sousTitre: dateCourte(tour.creeLe),
  })}
  <div class="section">
    ${tour.parties
      .map(
        (p) => `<a class="table-bloc" href="#/partie/${p.id}">
          <div class="rangee entre"><h2>Table ${p.table}</h2><span class="statut">${statut(p)}</span></div>
          ${jeu(p, { compact: true, distribuer: consommerDistribution(p.id) })}
        </a>`,
      )
      .join('')}
    <a class="btn ${enCours ? '' : 'principal'} plein" href="#/nouveau">${enCours ? 'Lancer un autre tour' : 'Lancer le tour suivant'}</a>
  </div>
  ${
    top.length
      ? `<div class="section"><div class="feuille">
          <div class="rangee entre"><h2>Classement</h2><a href="#/classement">Tout voir</a></div>
          ${listeClassement(top)}
        </div></div>`
      : ''
  }`;
}

// ---------------------------------------------------------------- vue : partie

function vuePartie(id) {
  const trouve = trouverPartie(id);
  if (!trouve) {
    return `${bandeau({ titre: 'Partie introuvable', retour: { href: '#/', texte: 'Parties' } })}
      <div class="section"><p>Cette partie a peut-être été supprimée. Si c’est le cas, tu peux la rétablir depuis l’<a href="#/historique">historique</a>.</p></div>`;
  }
  const { partie, tour } = trouve;
  const e = partie.etat;

  const { animer, distribuer } = reperer(partie);

  const enEdition = ui.edition?.partieId === partie.id ? partie.manches.find((m) => m.id === ui.edition.mancheId) : null;
  let principal = '';
  if (enEdition) {
    principal = formulaireManche(partie, { type: 'correction', manche: enEdition, index: partie.manches.indexOf(enEdition) });
  } else if (!e.terminee) {
    principal = formulaireManche(partie, { type: 'nouvelle' });
  }

  return `${bandeau({
    titre: `Table ${partie.table}`,
    sousTitre: `Tour ${numeroTour(tour)}, ${dateCourte(tour.creeLe)}<br>${statut(partie)}`,
    retour: { href: '#/', texte: 'Parties' },
    contenu: jeu(partie, { animer, distribuer }),
  })}
  <div class="section">
    ${principal}
    ${e.terminee ? resultats(partie, tour) : ''}
    ${tableauManches(partie, enEdition)}
    ${blocJournal(`p${partie.id}`)}
    <button class="btn danger plein" data-action="supprimer-partie" data-partie="${partie.id}">Supprimer cette partie</button>
  </div>`;
}

function consommerDistribution(partieId) {
  return ui.distribuer.delete(partieId);
}

/**
 * Compare la partie à ce qui était affiché la dernière fois pour lancer les animations :
 * joueur qui sort, taxiphone, fin de partie. Le premier affichage ne déclenche rien
 * (sauf la distribution si la partie n'a pas encore de manche).
 */
function reperer(partie) {
  const e = partie.etat;
  const avant = ui.vus[partie.id];
  const { compte } = infosTaxi(partie);
  const regle = regleTaxi();
  let animer = [];
  let distribuer = consommerDistribution(partie.id);
  if (!avant) {
    distribuer ||= partie.manches.length === 0;
  } else {
    animer = e.ordreSortie.filter((id) => !avant.sortis.has(id));
    for (const id of animer) ui.effets.push({ type: 'sortie', id, total: e.totaux[id] });
    for (const id of partie.joueurs) {
      if (compte[id] >= regle.fois && compte[id] > (avant.compte[id] ?? 0)) ui.effets.push({ type: 'taxiphone', id, n: compte[id] });
    }
    if (e.terminee && !avant.terminee) ui.effets.push({ type: 'victoire', partie });
  }
  ui.vus[partie.id] = { sortis: new Set(e.ordreSortie), compte, terminee: e.terminee };
  return { animer, distribuer };
}

function joueursDeLaManche(partie, mode) {
  if (mode.type === 'nouvelle') return partie.etat.enJeu;
  const d = partie.etat.detail[mode.index];
  return d && !d.horsPartie ? d.actifs : partie.joueurs.filter((id) => id in mode.manche.scores);
}

const estScore = (v) => /^-?\d+$/.test(String(v ?? '').trim());

/**
 * Saisie → scores. Chaque joueur est « ferme » (il a fermé), « rien » (rien posé, +100)
 * ou un nombre (cartes restées en main). Le score de celui qui ferme dépend des autres.
 */
function scoresDuBrouillon(joueurs, brouillon) {
  const r = regleManche();
  const scores = {};
  for (const id of joueurs) {
    const v = brouillon[id];
    if (v === 'rien') scores[id] = r.rien;
    else if (v !== 'ferme' && estScore(v)) scores[id] = Number(v);
  }
  const gagnant = joueurs.find((id) => brouillon[id] === 'ferme') ?? null;
  if (gagnant != null) scores[gagnant] = scoreDuGagnant(joueurs.filter((id) => id !== gagnant).map((id) => scores[id]), r);
  return { scores, gagnant, manquants: joueurs.filter((id) => !(id in scores)) };
}

/** Pour corriger une manche : retrouve qui a fermé et qui n'a rien posé à partir des scores. */
function brouillonDepuisScores(joueurs, scores) {
  const r = regleManche();
  const brouillon = {};
  let gagnantVu = false;
  for (const id of joueurs) {
    const v = scores[id];
    if (v === undefined) continue;
    if (!gagnantVu && (v === r.ferme || v === r.fermeSeul)) {
      brouillon[id] = 'ferme';
      gagnantVu = true;
    } else if (v === r.rien) brouillon[id] = 'rien';
    else brouillon[id] = String(v);
  }
  return brouillon;
}

function modeDuFormulaire(form, partie) {
  return form.dataset.manche
    ? { type: 'correction', manche: partie.manches.find((m) => m.id === Number(form.dataset.manche)), index: Number(form.dataset.index) }
    : { type: 'nouvelle' };
}

function formulaireManche(partie, mode) {
  const correction = mode.type === 'correction';
  const joueurs = joueursDeLaManche(partie, mode);
  const cle = correction ? `c${mode.manche.id}` : `n${partie.id}`;
  ui.brouillons[cle] ??= correction ? brouillonDepuisScores(joueurs, mode.manche.scores) : {};
  const brouillon = ui.brouillons[cle];
  const { scores } = scoresDuBrouillon(joueurs, brouillon);
  const r = regleManche();
  const num = correction ? mode.manche.num : partie.manches.length + 1;
  return `<form class="feuille" data-form="manche" data-cle="${cle}" data-partie="${partie.id}" data-num="${num}"
      ${correction ? `data-manche="${mode.manche.id}" data-index="${mode.index}"` : ''} novalidate>
    <h2>${correction ? `Correction de la manche ${num}` : `Manche ${num}`}</h2>
    <p class="doux petit">Les cartes restées en main pour ceux qui sont descendus. <b>Fermé</b> : −${-r.ferme}, ou −${-r.fermeSeul} si personne d’autre n’est descendu. <b>+${r.rien}</b> : rien posé.</p>
    <div class="saisie">
      ${joueurs
        .map((id) => {
          const v = brouillon[id];
          const auto = v === 'ferme' || v === 'rien' ? v : '';
          const valeur = auto ? scores[id] : (v ?? '');
          return `<label for="s-${cle}-${id}">${suite(partie.joueurs.indexOf(id))}<span>${nom(id)}</span></label>
          <input id="s-${cle}-${id}" inputmode="numeric" autocomplete="off" enterkeyhint="next" class="${auto}"
            value="${esc(valeur)}" data-cle="${cle}" data-joueur="${id}" aria-label="Points de ${nom(id)}">
          <button type="button" class="btn mode" data-action="ferme" data-cle="${cle}" data-joueur="${id}"
            aria-pressed="${auto === 'ferme'}" aria-label="${nom(id)} a fermé">Fermé</button>
          <button type="button" class="btn mode" data-action="rien" data-cle="${cle}" data-joueur="${id}"
            aria-pressed="${auto === 'rien'}" aria-label="${nom(id)} n’a rien posé, +${r.rien}">+${r.rien}</button>`;
        })
        .join('')}
    </div>
    <p class="apercu" id="apercu-${cle}" aria-live="polite">${apercu(partie, mode, brouillon)}</p>
    <div class="actions">
      ${correction ? `<button type="button" class="btn" data-action="annuler-correction">Annuler</button>` : ''}
      <button type="submit" class="btn principal">${correction ? 'Enregistrer la correction' : `Enregistrer la manche ${num}`}</button>
    </div>
    ${correction ? `<button type="button" class="btn danger plein" data-action="supprimer-manche" data-manche="${mode.manche.id}">Supprimer la manche ${num}</button>` : ''}
    ${ligneSignature()}
  </form>`;
}

function ligneSignature() {
  const qui = api.auteur();
  return qui
    ? `<p class="signature">Enregistré au nom de <b>${esc(qui)}</b>. <button type="button" class="lien" data-action="changer-auteur">Changer</button></p>`
    : `<p class="signature">Ton nom sera demandé à l’enregistrement.</p>`;
}

/** Ce qui se passera si on enregistre la saisie en cours. */
function apercu(partie, mode, brouillon) {
  const joueurs = joueursDeLaManche(partie, mode);
  const { scores, manquants } = scoresDuBrouillon(joueurs, brouillon);
  if (!Object.keys(scores).length) return '';
  const manches =
    mode.type === 'nouvelle'
      ? [...partie.manches, { scores }]
      : partie.manches.map((m) => (m.id === mode.manche.id ? { scores } : m));
  const apres = calculerPartie({ ...partie, manches });
  const index = mode.type === 'nouvelle' ? partie.manches.length : mode.index;
  const sortants = apres.detail[index]?.sortisIci ?? [];
  const morceaux = [];
  if (sortants.length) {
    morceaux.push(`<strong>${sortants.map((id) => `${nom(id)} sort avec ${apres.totaux[id]}`).join(', ')}.</strong>`);
  }
  const regle = regleTaxi();
  const taxiAvant = infosTaxi(partie).compte;
  const taxiApres = taxiphones(partie.joueurs, manches, apres.detail, regle).compte;
  const taxis = joueurs.filter((id) => taxiApres[id] >= regle.fois && taxiApres[id] > taxiAvant[id]);
  if (taxis.length) {
    morceaux.push(
      `<strong class="taxi-texte">${taxis
        .map((id) => (taxiApres[id] === regle.fois ? `${nom(id)} devient taxiphone !` : `${nom(id)}, encore taxiphone (${ordinal(taxiApres[id])} fois) !`))
        .join(' ')}</strong>`,
    );
  }
  if (manquants.length) {
    morceaux.push(`Il manque ${pluriel(manquants.length, 'score')}.`);
  } else if (apres.terminee) {
    morceaux.push(`Fin de la partie : ${nom(apres.classement[0].id)} gagne.`);
  } else if (!sortants.length) {
    const proche = joueurs.map((id) => ({ id, reste: partie.seuil - apres.totaux[id] })).sort((a, b) => a.reste - b.reste)[0];
    morceaux.push(`Personne ne sort. Le plus proche : ${nom(proche.id)}, reste ${proche.reste}.`);
  }
  return morceaux.join(' ');
}

/** Met à jour l'aperçu et le score de celui qui a fermé pendant la saisie. */
function majApercu(form) {
  const partie = trouverPartie(Number(form.dataset.partie))?.partie;
  if (!partie) return;
  const mode = modeDuFormulaire(form, partie);
  const brouillon = ui.brouillons[form.dataset.cle] ?? {};
  const { scores, gagnant } = scoresDuBrouillon(joueursDeLaManche(partie, mode), brouillon);
  if (gagnant != null) form.querySelector(`input[data-joueur="${gagnant}"]`).value = scores[gagnant];
  form.querySelector('.apercu').innerHTML = apercu(partie, mode, brouillon);
}

/** Redessine le formulaire (après « Fermé » ou « +100 ») et place le curseur sur le prochain score à saisir. */
function redessinerFormulaire(form) {
  const partie = trouverPartie(Number(form.dataset.partie))?.partie;
  if (!partie) return;
  const cle = form.dataset.cle;
  form.outerHTML = formulaireManche(partie, modeDuFormulaire(form, partie));
  const nouveau = document.querySelector(`form[data-cle="${cle}"]`);
  const brouillon = ui.brouillons[cle] ?? {};
  [...nouveau.querySelectorAll('input[data-joueur]')].find((i) => !(i.dataset.joueur in brouillon) || brouillon[i.dataset.joueur] === '')?.focus();
}

function resultats(partie, tour) {
  const e = partie.etat;
  const autres = tour.parties.filter((p) => p.id !== partie.id && !p.etat.terminee);
  return `<div class="feuille">
    <h2>Résultats</h2>
    <ol class="resultats">
      ${e.classement
        .map(
          (c) => `<li><span class="place">${c.place}</span><span>${nom(c.id)}</span>
            <span class="tot">${c.total}${c.sorti ? ', sorti' : ''}</span><span class="gain">+${c.points}</span></li>`,
        )
        .join('')}
    </ol>
    ${e.manchesEnTrop ? `<p class="alerte">Après correction, la partie se termine plus tôt : ${pluriel(e.manchesEnTrop, 'manche')} en trop ne ${e.manchesEnTrop > 1 ? 'comptent' : 'compte'} plus. Tu peux ${e.manchesEnTrop > 1 ? 'les' : 'la'} supprimer.</p>` : ''}
    ${
      etat.tours[0] !== tour
        ? ''
        : autres.length
          ? `<p class="doux petit">La table ${autres.map((p) => p.table).join(' et ')} joue encore.</p>`
          : `<a class="btn principal plein" href="#/nouveau">Lancer le tour suivant</a>`
    }
  </div>`;
}

function tableauManches(partie, enEdition) {
  if (!partie.manches.length) return '';
  const e = partie.etat;
  return `<div class="feuille">
    <div class="rangee entre"><h2>Manches</h2><span class="doux petit">Touche une manche pour la corriger</span></div>
    <div class="defile"><table class="manches">
      <thead><tr><th scope="col"><span class="sr">Manche</span></th>
        ${partie.joueurs.map((id, s) => `<th scope="col">${suite(s)}${nom(id)}</th>`).join('')}</tr></thead>
      <tbody>
        ${partie.manches
          .map((m, i) => {
            const d = e.detail[i];
            const cellules = partie.joueurs
              .map((id) => {
                if (!d || d.horsPartie || !d.actifs.includes(id)) return '<td class="vide">–</td>';
                const pts = m.scores[id] ?? 0;
                const texte = pts < 0 ? `−${-pts}` : pts;
                const valeur = pts === regleManche().rien ? `<span class="entoure">${texte}</span>` : texte;
                const classes = [d.sortisIci.includes(id) && 'sort', pts < 0 && 'gagne'].filter(Boolean).join(' ');
                return `<td${classes ? ` class="${classes}"` : ''}>${valeur}</td>`;
              })
              .join('');
            return `<tr data-action="corriger" data-partie="${partie.id}" data-manche="${m.id}" tabindex="0"
              ${enEdition?.id === m.id ? 'class="edite"' : ''} aria-label="Corriger la manche ${m.num}">
              <td>${m.num}</td>${cellules}</tr>`;
          })
          .join('')}
      </tbody>
      <tfoot><tr><td>Total</td>${partie.joueurs.map((id) => `<td>${e.totaux[id]}</td>`).join('')}</tr></tfoot>
    </table></div>
  </div>`;
}

// ---------------------------------------------------------------- vue : nouveau tour

function dernierTourTermine() {
  const t = etat.tours.find((x) => x.termine);
  return t ? t.parties.map((p) => ({ table: p.table, classement: p.etat.classement })) : null;
}

function tablesPrecedentes() {
  const res = {};
  for (const t of dernierTourTermine() ?? []) for (const c of t.classement) res[c.id] = t.table;
  return res;
}

function initNouveau() {
  const actifs = new Set(etat.joueurs.filter((j) => j.actif).map((j) => j.id));
  ui.nouveau = {
    presents: actifs,
    tables: etat.proposition.tables.map((t) => [...t]),
    mouvements: etat.proposition.mouvements,
    selection: null,
  };
}

function proposerDepuisPresents() {
  const presents = etat.classement.map((l) => l.id).filter((id) => ui.nouveau.presents.has(id));
  const r = proposerTables({ dernierTour: dernierTourTermine(), presents });
  Object.assign(ui.nouveau, { tables: r.tables, mouvements: r.mouvements, selection: null });
}

function vueNouveau() {
  if (!ui.nouveau) initNouveau();
  const n = ui.nouveau;
  const base = dernierTourTermine();
  const tourEnCours = etat.tours[0] && !etat.tours[0].termine ? etat.tours[0] : null;
  const actifs = etat.joueurs.filter((j) => j.actif);
  const mvt = {
    monte: '<span class="mvt monte">↑ monte</span>',
    descend: '<span class="mvt descend">↓ descend</span>',
  };
  const tailleOk = n.tables.length > 0 && n.tables.every((t) => t.length >= 2);
  return `${bandeau({
    titre: 'Nouveau tour',
    sousTitre: base
      ? 'Le 1er de la table 2 monte, le dernier de la table 1 descend.'
      : 'Premier tour : répartition dans l’ordre de la liste. Tu peux aussi tirer au sort.',
    retour: { href: '#/', texte: 'Parties' },
  })}
  <div class="section">
    ${tourEnCours ? `<p class="alerte">Le tour ${numeroTour(tourEnCours)} n’est pas terminé. Tu peux quand même en lancer un nouveau.</p>` : ''}
    <div class="feuille">
      <div class="rangee entre"><h2>Présents</h2><span class="doux petit">${n.presents.size} sur ${actifs.length}</span></div>
      <div class="puces">
        ${actifs
          .map(
            (j) => `<button type="button" class="puce" data-action="present" data-joueur="${j.id}"
              aria-pressed="${n.presents.has(j.id)}">${esc(j.nom)}</button>`,
          )
          .join('')}
      </div>
    </div>
    ${n.tables
      .map(
        (t, i) => `<div class="table-choix${i === 0 ? ' t1' : ''}">
          <div class="rangee entre"><h3>Table ${i + 1}</h3><span class="doux petit">${pluriel(t.length, 'joueur')}</span></div>
          <div class="puces">
            ${t
              .map(
                (id) => `<button type="button" class="puce${n.selection === id ? ' choisie' : ''}" data-action="choisir"
                  data-joueur="${id}" aria-pressed="${n.selection === id}">${nom(id)} ${mvt[n.mouvements[id]] ?? ''}</button>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('')}
    ${n.tables.length ? `<p class="doux petit">Touche deux joueurs pour les échanger de place.</p>` : '<p class="alerte">Choisis au moins 2 joueurs présents.</p>'}
    <div class="actions">
      <button type="button" class="btn" data-action="tirage">Tirer au sort</button>
      ${base ? `<button type="button" class="btn" data-action="reproposer">Montée / descente</button>` : ''}
    </div>
    <button type="button" class="btn principal plein" data-action="lancer" ${tailleOk ? '' : 'disabled'}>Lancer le tour</button>
  </div>`;
}

// ---------------------------------------------------------------- vue : classement

function forme(l) {
  return `<span class="forme" aria-label="Dernières parties">${l.forme
    .map((f) => `<b class="t${f.table === 1 ? 1 : 2}" title="Table ${f.table}, ${ordinal(f.place)}">${f.place}</b>`)
    .join('')}</span>`;
}

function listeClassement(lignes, { detail = false } = {}) {
  return `<ol class="classement">
    ${lignes
      .map(
        (l) => `<li class="${l.rang === 1 && l.points > 0 ? 'tete' : ''}">
          <span class="rang">${l.rang}</span>
          <span class="qui">${nom(l.id)}</span>
          <span class="pts">${l.points}<small>pts</small></span>
          ${
            detail
              ? `<span class="stats"><span>${pluriel(l.parties, 'partie')}</span><span>${pluriel(l.victoires, 'victoire')}</span>
                <span>${l.moyenne.toFixed(1).replace('.', ',')} pts par partie</span>
                ${l.taxiphone ? `<span class="taxi-stat">${COMBINE}${l.taxiphone} fois taxiphone</span>` : ''}
                ${l.forme.length ? forme(l) : ''}</span>`
              : ''
          }
        </li>`,
      )
      .join('')}
  </ol>`;
}

function vueClassement() {
  const actifs = new Set(etat.joueurs.filter((j) => j.actif).map((j) => j.id));
  const lignes = etat.classement.filter((l) => l.parties > 0 || actifs.has(l.id));
  const nbParties = etat.tours.flatMap((t) => t.parties).filter((p) => p.etat.terminee).length;
  const b = etat.reglages.bareme;
  const listeBareme = (pts = []) => pts.join(', ').replace(/, (\d+)$/, ' et $1');
  return `${bandeau({
    titre: 'Classement',
    sousTitre: nbParties ? `${pluriel(nbParties, 'partie terminée', 'parties terminées')}` : 'Aucune partie terminée pour l’instant',
  })}
  <div class="section">
    <div class="feuille">${listeClassement(lignes, { detail: true })}</div>
    <div class="legende">
      <span><span class="forme"><b class="t1">1</b></span> table 1</span>
      <span><span class="forme"><b class="t2">1</b></span> table 2</span>
      <span>le chiffre est la place</span>
    </div>
    <p class="doux petit">Points de classement par place. Table 1 : ${listeBareme(b[1])}. Table 2 : ${listeBareme(b[2])}.</p>
  </div>`;
}

// ---------------------------------------------------------------- vue : historique

function vueHistorique() {
  if (!etat.tours.length) {
    return `${bandeau({ titre: 'Historique' })}<div class="section"><p>Les tours joués apparaîtront ici.</p>${blocJournal('supprimees')}</div>`;
  }
  return `${bandeau({ titre: 'Historique', sousTitre: pluriel(etat.tours.length, 'tour joué', 'tours joués') })}
  <div class="section">
    ${etat.tours
      .map(
        (t) => `<div class="feuille tour-histo">
          <div class="rangee entre"><h3>Tour ${numeroTour(t)}</h3><span class="doux petit">${dateCourte(t.creeLe)}</span></div>
          ${t.parties
            .map((p) => {
              const noms = p.etat.terminee
                ? p.etat.classement.map((c) => `${c.place}. <b>${nom(c.id)}</b> +${c.points}`).join(', ')
                : `En cours : ${p.etat.classement.map((c) => `${nom(c.id)} ${c.total}`).join(', ')}`;
              return `<a class="ligne-partie" href="#/partie/${p.id}">
                <div class="rangee entre"><b>Table ${p.table}</b><span class="doux petit">${pluriel(p.manches.length, 'manche')}</span></div>
                <div class="noms">${noms}</div></a>`;
            })
            .join('')}
        </div>`,
      )
      .join('')}
    ${blocJournal('supprimees')}
  </div>`;
}

// ---------------------------------------------------------------- vue : réglages

function vueReglages() {
  const r = etat.reglages;
  const pin = api.pinEnregistre();
  return `${bandeau({ titre: 'Réglages' })}
  <div class="section">
    <form class="feuille" data-form="reglages" novalidate>
      <h2>Règles</h2>
      <div class="champ"><label for="r-seuil">Seuil de sortie</label>
        <input id="r-seuil" name="seuil" inputmode="numeric" value="${r.seuil}">
        <span class="aide">Un joueur qui dépasse ce total est sorti.</span></div>
      <div class="champ"><label for="r-restants">Joueurs restants en fin de partie</label>
        <input id="r-restants" name="restants" inputmode="numeric" value="${r.restants}">
        <span class="aide">Avec 2 : à 4 joueurs la partie s’arrête au 2e sorti, à 3 joueurs au 1er.</span></div>
      <div class="champ"><label for="r-b1">Points de classement, table 1</label>
        <input id="r-b1" name="b1" value="${esc((r.bareme[1] ?? []).join(', '))}">
        <span class="aide">Du 1er au dernier, séparés par des virgules.</span></div>
      <div class="champ"><label for="r-b2">Points de classement, table 2</label>
        <input id="r-b2" name="b2" value="${esc((r.bareme[2] ?? []).join(', '))}"></div>
      <p class="doux petit">Les parties déjà lancées gardent leurs règles.</p>
      <h3>Score d’une manche</h3>
      <div class="champ"><label for="r-rien">Rien posé</label>
        <input id="r-rien" name="rien" inputmode="numeric" value="${regleManche().rien}">
        <span class="aide">Points pris par celui qui n’est pas descendu.</span></div>
      <div class="champ"><label for="r-ferme-seul">Points retirés au gagnant si personne d’autre n’est descendu</label>
        <input id="r-ferme-seul" name="fermeSeul" inputmode="numeric" value="${-regleManche().fermeSeul}"></div>
      <div class="champ"><label for="r-ferme">Points retirés au gagnant sinon</label>
        <input id="r-ferme" name="ferme" inputmode="numeric" value="${-regleManche().ferme}"></div>
      <h3>Taxiphone</h3>
      <div class="champ"><label for="r-taxi-fois">Nombre de +${regleManche().rien} dans une partie</label>
        <input id="r-taxi-fois" name="taxiFois" inputmode="numeric" value="${regleTaxi().fois}">
        <span class="aide">À partir de ce nombre, le joueur est taxiphone. Compté sur toutes les parties, anciennes comprises.</span></div>
      <button type="submit" class="btn principal plein">Enregistrer les règles</button>
    </form>

    <div class="feuille">
      <h2>Joueurs</h2>
      <ul class="joueurs-liste">
        ${etat.joueurs
          .map(
            (j) => `<li class="${j.actif ? '' : 'inactif'}">
              <span class="nom">${esc(j.nom)}</span>
              <label class="interrupteur"><input type="checkbox" data-action="actif" data-joueur="${j.id}" ${j.actif ? 'checked' : ''}> joue</label>
              <button type="button" class="btn discret" data-action="renommer" data-joueur="${j.id}">Renommer</button>
            </li>`,
          )
          .join('')}
      </ul>
      <form class="rangee" data-form="joueur" novalidate>
        <div class="champ" style="flex:1"><label for="nouveau-joueur" class="sr">Nouveau joueur</label>
          <input id="nouveau-joueur" name="nom" placeholder="Nouveau joueur" maxlength="30" autocomplete="off"></div>
        <button type="submit" class="btn">Ajouter</button>
      </form>
    </div>

    <div class="feuille">
      <h2>Ton nom sur ce téléphone</h2>
      ${
        api.auteur()
          ? `<p>Les modifications faites ici sont signées <b>${esc(api.auteur())}</b>.</p>
             <button type="button" class="btn plein" data-action="changer-auteur">Changer de nom</button>`
          : `<p class="doux">Ton nom sera demandé à la première modification.</p>
             <button type="button" class="btn plein" data-action="changer-auteur">Choisir mon nom</button>`
      }
    </div>

    <div class="feuille">
      <h2>Code d’accès</h2>
      ${
        etat.pinRequis
          ? pin
            ? `<p>Ce téléphone peut modifier les scores.</p>
               <button type="button" class="btn plein" data-action="oublier-pin">Oublier le code sur ce téléphone</button>`
            : `<p>Le code est demandé à la première modification.</p>
               <button type="button" class="btn plein" data-action="saisir-pin">Saisir le code</button>`
          : `<p class="doux">Pas de code : toute personne qui a le lien peut modifier les scores. Pour en mettre un, ajoute la variable <code>APP_PIN</code> sur le serveur.</p>`
      }
    </div>

    <div class="feuille">
      <h2>Sauvegarde</h2>
      <p class="doux petit">Toutes les parties et manches dans un fichier JSON.</p>
      <a class="btn plein" href="/api/export" download>Télécharger la sauvegarde</a>
    </div>

    ${blocJournal('reglages')}
  </div>`;
}

// ---------------------------------------------------------------- animations

/** Joue dans l'ordre : sorties, taxiphones, puis la fête du vainqueur. */
function jouerEffets() {
  const effets = ui.effets.splice(0);
  if (!effets.length) return;
  const ordre = { sortie: 0, taxiphone: 1, victoire: 2 };
  effets.sort((a, b) => ordre[a.type] - ordre[b.type]);
  let delai = 650;
  for (const f of effets) {
    if (f.type === 'victoire') {
      setTimeout(() => fete(f.partie), delai);
    } else {
      setTimeout(() => annonce(f), delai);
      delai += 2500;
    }
  }
}

function annonce(f) {
  const el = document.createElement('div');
  el.className = `annonce ${f.type}`;
  el.setAttribute('role', 'status');
  if (f.type === 'taxiphone') {
    const regle = regleTaxi();
    el.innerHTML = `${COMBINE}<div><b>${nom(f.id)}, ${f.n > regle.fois ? 'encore ' : ''}taxiphone !</b>
      <span>${ordinal(f.n)} fois +${regle.rien} dans la partie</span></div>`;
    document.querySelector(`.tapis .carte[data-joueur="${f.id}"] .taxi`)?.classList.add('sonne');
    try {
      navigator.vibrate?.([90, 60, 90, 60, 90]);
    } catch {
      /* vibration indisponible */
    }
  } else {
    el.innerHTML = `<span class="dos" aria-hidden="true"></span><div><b>${nom(f.id)} sort</b><span>avec ${f.total} points</span></div>`;
  }
  document.body.append(el);
  setTimeout(() => el.classList.add('part'), 2200);
  setTimeout(() => el.remove(), 2700);
}

function confettis(n = 34) {
  const couleurs = ['var(--rouge)', '#1c1410', 'var(--jaune)', 'var(--vert)'];
  return Array.from({ length: n }, (_, i) => {
    const s = ORDRE_SUITES[i % 4];
    const style = [
      `--x:${(Math.random() * 100).toFixed(1)}%`,
      `--d:${(Math.random() * 2.2).toFixed(2)}s`,
      `--t:${(2.6 + Math.random() * 2.4).toFixed(2)}s`,
      `--r:${Math.round(Math.random() * 720 - 360)}deg`,
      `--s:${(0.6 + Math.random() * 0.9).toFixed(2)}`,
    ].join(';');
    return `<span style="${style}"><svg viewBox="0 0 24 24" fill="${couleurs[i % couleurs.length]}">${SUITES[s]}</svg></span>`;
  }).join('');
}

/** Fin de partie : « Mabrouk » au vainqueur, pluie de pique, cœur, carreau, trèfle. */
function fete(partie) {
  const e = partie.etat;
  const gagnants = e.classement.filter((c) => c.place === 1);
  const noms = gagnants.map((c) => nom(c.id)).join(' et ');
  document.querySelector('.fete')?.remove();
  gagnants.forEach((g) => document.querySelector(`.tapis .carte[data-joueur="${g.id}"]`)?.classList.add('vient-de-gagner'));
  const d = document.createElement('div');
  d.className = 'fete';
  d.innerHTML = `<div class="pluie" aria-hidden="true">${confettis()}</div>
    <div class="fete-carte" role="dialog" aria-modal="true" aria-labelledby="fete-titre">
      <p class="ar" lang="ar" dir="rtl" aria-hidden="true">مبروك</p>
      <h2 id="fete-titre">Mabrouk ${noms} !</h2>
      <p>${gagnants.length > 1 ? 'gagnent' : 'gagne'} la table ${partie.table} avec ${gagnants[0].total} points</p>
      <p class="gain">+${gagnants[0].points} au classement</p>
      <button type="button" class="btn principal plein">Voir les résultats</button>
    </div>`;
  const fermer = () => {
    d.classList.add('part');
    setTimeout(() => d.remove(), 250);
    document.removeEventListener('keydown', echap);
  };
  const echap = (ev) => ev.key === 'Escape' && fermer();
  d.addEventListener('click', (ev) => {
    if (ev.target === d || ev.target.closest('button')) fermer();
  });
  document.addEventListener('keydown', echap);
  document.body.append(d);
  d.querySelector('button').focus({ preventScroll: true });
}

// ---------------------------------------------------------------- routeur et rendu

function route() {
  const [, vue = '', id] = location.hash.split('/');
  return { vue, id: id ? Number(id) : null };
}

function render() {
  if (!etat) return;
  const { vue, id } = route();
  const vues = {
    '': vueAccueil,
    partie: () => vuePartie(id),
    nouveau: vueNouveau,
    classement: vueClassement,
    historique: vueHistorique,
    reglages: vueReglages,
  };
  app.innerHTML = (vues[vue] ?? vueAccueil)();
  chargerJournauxVisibles();
  jouerEffets();
  const onglet = { '': 'accueil', partie: 'accueil', nouveau: 'accueil' }[vue] ?? vue;
  document.querySelectorAll('nav.onglets a').forEach((a) => {
    if (a.dataset.onglet === onglet) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

window.addEventListener('hashchange', () => {
  const { vue } = route();
  if (vue !== 'partie') ui.edition = null;
  if (vue !== 'nouveau') ui.nouveau = null;
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------- événements

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.matches('input[data-cle][data-joueur]')) {
    (ui.brouillons[el.dataset.cle] ??= {})[el.dataset.joueur] = el.value;
    if (el.classList.contains('ferme') || el.classList.contains('rien')) {
      el.classList.remove('ferme', 'rien');
      el.form
        .querySelectorAll(`button.mode[data-joueur="${el.dataset.joueur}"]`)
        .forEach((b) => b.setAttribute('aria-pressed', 'false'));
    }
    majApercu(el.form);
  }
});

document.addEventListener('keydown', (ev) => {
  const el = ev.target;
  if (ev.key === 'Enter' && el.matches('input[data-cle][data-joueur]')) {
    const champs = [...el.form.querySelectorAll('input[data-joueur]')];
    const suivant = champs.slice(champs.indexOf(el) + 1).find((c) => !c.classList.contains('ferme') && !c.classList.contains('rien'));
    if (suivant) {
      ev.preventDefault();
      suivant.focus();
    }
  }
  if ((ev.key === 'Enter' || ev.key === ' ') && el.matches('tr[data-action]')) {
    ev.preventDefault();
    el.click();
  }
});

document.addEventListener(
  'toggle',
  (ev) => {
    if (ev.target.matches?.('details[data-cle]')) ui.journauxOuverts[ev.target.dataset.cle] = ev.target.open;
  },
  true,
);

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.matches('[data-action="actif"]')) {
    const id = Number(el.dataset.joueur);
    const ok = await ecrire(() => api.modifierJoueur(id, { actif: el.checked }));
    if (!ok) el.checked = !el.checked;
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  if (!form.dataset.form) return;
  ev.preventDefault();
  if (form.dataset.form === 'manche') return soumettreManche(form);
  if (form.dataset.form === 'reglages') return soumettreReglages(form);
  if (form.dataset.form === 'joueur') {
    const nouveauNom = form.nom.value.trim();
    if (!nouveauNom) return form.nom.focus();
    await ecrire(() => api.ajouterJoueur(nouveauNom), `${nouveauNom} ajouté`);
  }
});

async function soumettreManche(form) {
  const partie = trouverPartie(Number(form.dataset.partie))?.partie;
  if (!partie) return;
  const mode = modeDuFormulaire(form, partie);
  const cle = form.dataset.cle;
  const { scores, manquants } = scoresDuBrouillon(joueursDeLaManche(partie, mode), ui.brouillons[cle] ?? {});
  const champ = (id) => form.querySelector(`input[data-joueur="${id}"]`);
  if (manquants.length) {
    toast(`Il manque le score de ${nom(manquants[0])}.`, true);
    champ(manquants[0])?.focus();
    return;
  }
  const horsLimite = Object.keys(scores).find((id) => Math.abs(scores[id]) > 1000);
  if (horsLimite) {
    toast(`Score invalide pour ${nom(horsLimite)}.`, true);
    champ(horsLimite)?.focus();
    return;
  }
  const num = Number(form.dataset.num);
  const ok = form.dataset.manche
    ? await ecrire(() => api.corrigerManche(Number(form.dataset.manche), scores).then((r) => ((ui.edition = null), r)), `Manche ${num} corrigée`)
    : await ecrire(() => api.ajouterManche(partie.id, num, scores), `Manche ${num} enregistrée`);
  if (ok) delete ui.brouillons[cle];
}

async function soumettreReglages(form) {
  const liste = (v) =>
    v
      .split(/[,;\s]+/)
      .filter(Boolean)
      .map(Number);
  const reglages = {
    seuil: Number(form.seuil.value),
    restants: Number(form.restants.value),
    bareme: { 1: liste(form.b1.value), 2: liste(form.b2.value) },
    manche: {
      rien: Number(form.rien.value),
      fermeSeul: -Math.abs(Number(form.fermeSeul.value)),
      ferme: -Math.abs(Number(form.ferme.value)),
    },
    taxiphone: { fois: Number(form.taxiFois.value) },
  };
  if (!reglages.bareme[2].length) delete reglages.bareme[2];
  await ecrire(() => api.enregistrerReglages(reglages), 'Règles enregistrées');
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.matches('input')) return;
  const action = el.dataset.action;
  const joueur = el.dataset.joueur ? Number(el.dataset.joueur) : null;

  switch (action) {
    case 'recharger':
      return rafraichir({ force: true });

    case 'ferme':
    case 'rien': {
      const brouillon = (ui.brouillons[el.dataset.cle] ??= {});
      const id = el.dataset.joueur;
      if (brouillon[id] === action) delete brouillon[id];
      else {
        // Un seul joueur ferme la manche.
        if (action === 'ferme') for (const k of Object.keys(brouillon)) if (brouillon[k] === 'ferme') delete brouillon[k];
        brouillon[id] = action;
      }
      return redessinerFormulaire(el.closest('form'));
    }

    case 'corriger': {
      const partieId = Number(el.dataset.partie);
      const mancheId = Number(el.dataset.manche);
      if (ui.edition?.mancheId === mancheId) ui.edition = null;
      else {
        delete ui.brouillons[`c${mancheId}`];
        ui.edition = { partieId, mancheId };
      }
      render();
      document.querySelector('form[data-form="manche"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    case 'annuler-correction':
      ui.edition = null;
      return render();

    case 'supprimer-manche': {
      const id = Number(el.dataset.manche);
      if (!confirm('Supprimer cette manche ? Les manches suivantes seront renumérotées.')) return;
      const ok = await ecrire(() => api.supprimerManche(id).then((r) => ((ui.edition = null), r)), 'Manche supprimée');
      if (ok) delete ui.brouillons[`c${id}`];
      return;
    }

    case 'supprimer-partie': {
      const id = Number(el.dataset.partie);
      const p = trouverPartie(id)?.partie;
      if (!confirm(`Supprimer la partie de la table ${p?.table ?? ''} ? Ses ${p?.manches.length ?? 0} manches seront perdues.`)) return;
      const ok = await ecrire(() => api.supprimerPartie(id), 'Partie supprimée');
      if (ok) location.hash = '#/';
      return;
    }

    case 'present': {
      const n = ui.nouveau;
      if (n.presents.has(joueur)) n.presents.delete(joueur);
      else n.presents.add(joueur);
      proposerDepuisPresents();
      return render();
    }

    case 'choisir': {
      const n = ui.nouveau;
      if (n.selection == null) n.selection = joueur;
      else if (n.selection === joueur) n.selection = null;
      else {
        const pos = (id) => {
          for (const [t, table] of n.tables.entries()) {
            const i = table.indexOf(id);
            if (i >= 0) return [t, i];
          }
          return null;
        };
        const [ta, ia] = pos(n.selection);
        const [tb, ib] = pos(joueur);
        [n.tables[ta][ia], n.tables[tb][ib]] = [n.tables[tb][ib], n.tables[ta][ia]];
        n.selection = null;
        n.mouvements = mouvements(n.tables, tablesPrecedentes());
      }
      return render();
    }

    case 'tirage': {
      const n = ui.nouveau;
      const r = repartir(melanger([...n.presents]), tablesPrecedentes());
      Object.assign(n, { tables: r.tables, mouvements: r.mouvements, selection: null });
      return render();
    }

    case 'reproposer':
      proposerDepuisPresents();
      return render();

    case 'lancer': {
      const tables = ui.nouveau.tables;
      const ok = await ecrire(() => api.lancerTour(tables), 'Tour lancé');
      if (ok) {
        for (const p of etat.tours[0]?.parties ?? []) ui.distribuer.add(p.id);
        location.hash = '#/';
      }
      return;
    }

    case 'renommer': {
      const actuel = etat.joueurs.find((j) => j.id === joueur);
      const nouveauNom = prompt('Nouveau nom', actuel?.nom ?? '')?.trim();
      if (!nouveauNom || nouveauNom === actuel?.nom) return;
      return ecrire(() => api.modifierJoueur(joueur, { nom: nouveauNom }), 'Joueur renommé');
    }

    case 'changer-auteur':
      if (await demanderAuteur()) toast(`Modifications signées ${api.auteur()}`);
      return render();

    case 'retablir': {
      const id = Number(el.dataset.evt);
      if (!confirm(`${el.dataset.texte} ?`)) return;
      const messages = {
        'Remettre les scores d’avant': 'Anciens scores remis',
        'Rétablir cette manche': 'Manche rétablie',
        'Rétablir cette partie': 'Partie rétablie',
      };
      return ecrire(() => api.retablir(id), messages[el.dataset.texte] ?? 'Rétabli');
    }

    case 'oublier-pin':
      api.enregistrerPin(null);
      toast('Code oublié sur ce téléphone');
      return render();

    case 'saisir-pin':
      if (await demanderPin()) toast('Code enregistré');
      return render();
  }
});

// ---------------------------------------------------------------- démarrage

rafraichir({ force: true });
setInterval(() => {
  if (document.visibilityState === 'visible' && !ui.occupe) rafraichir();
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') rafraichir();
});
