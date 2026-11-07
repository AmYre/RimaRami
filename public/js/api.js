// Accès à l'API. Le code d'accès, le nom de la personne qui saisit et l'identifiant
// du téléphone sont gardés sur l'appareil.

const CLE_PIN = 'rimarami.pin';
const CLE_AUTEUR = 'rimarami.auteur';
const CLE_APPAREIL = 'rimarami.appareil';

function lire(cle) {
  try {
    return localStorage.getItem(cle);
  } catch {
    return null;
  }
}
function ecrireLocal(cle, valeur) {
  try {
    if (valeur) localStorage.setItem(cle, valeur);
    else localStorage.removeItem(cle);
  } catch {
    /* stockage indisponible : la valeur sera redemandée */
  }
}

export const pinEnregistre = () => lire(CLE_PIN);
export const enregistrerPin = (pin) => ecrireLocal(CLE_PIN, pin);
export const auteur = () => lire(CLE_AUTEUR);
export const enregistrerAuteur = (nom) => ecrireLocal(CLE_AUTEUR, nom);

/** Identifiant court et aléatoire du téléphone, pour distinguer les appareils dans le journal. */
let appareilMemoire = null;
function idAppareil() {
  let id = lire(CLE_APPAREIL) ?? appareilMemoire;
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(3))].map((o) => o.toString(16).padStart(2, '0')).join('');
    appareilMemoire = id;
    ecrireLocal(CLE_APPAREIL, id);
  }
  return id;
}

export class ErreurApi extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function appel(methode, chemin, corps) {
  const entetes = { 'X-Appareil': idAppareil() };
  if (corps !== undefined) entetes['Content-Type'] = 'application/json';
  const pin = pinEnregistre();
  if (pin) entetes['X-Pin'] = pin;
  const nom = auteur();
  if (nom) entetes['X-Auteur'] = encodeURIComponent(nom);
  let rep;
  try {
    rep = await fetch(chemin, {
      method: methode,
      headers: entetes,
      body: corps === undefined ? undefined : JSON.stringify(corps),
      cache: 'no-store',
    });
  } catch {
    throw new ErreurApi(0, 'Pas de connexion au serveur. Vérifie le réseau et réessaie.');
  }
  const donnees = await rep.json().catch(() => ({}));
  if (!rep.ok) throw new ErreurApi(rep.status, donnees.erreur || `Erreur ${rep.status}`, donnees.code);
  return donnees;
}

export const etat = () => appel('GET', '/api/etat');
export const verifierPin = (pin) => appel('POST', '/api/pin', { pin });
export const ajouterJoueur = (nom) => appel('POST', '/api/joueurs', { nom });
export const modifierJoueur = (id, champs) => appel('PATCH', `/api/joueurs/${id}`, champs);
export const enregistrerReglages = (r) => appel('PUT', '/api/reglages', r);
export const lancerTour = (tables) => appel('POST', '/api/tours', { tables });
export const supprimerPartie = (id) => appel('DELETE', `/api/parties/${id}`);
export const ajouterManche = (partieId, num, scores) => appel('POST', `/api/parties/${partieId}/manches`, { num, scores });
export const corrigerManche = (id, scores) => appel('PUT', `/api/manches/${id}`, { scores });
export const supprimerManche = (id) => appel('DELETE', `/api/manches/${id}`);
export const journalPartie = (id) => appel('GET', `/api/parties/${id}/journal`);
export const journal = ({ actions = [], limite = 50 } = {}) =>
  appel('GET', `/api/journal?actions=${encodeURIComponent(actions.join(','))}&limite=${limite}`);
export const retablir = (evenementId) => appel('POST', `/api/journal/${evenementId}/retablir`);
