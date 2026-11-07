// Accès à l'API. Le code d'accès (s'il y en a un) est gardé sur le téléphone.

const CLE_PIN = 'rimarami.pin';

export function pinEnregistre() {
  try {
    return localStorage.getItem(CLE_PIN);
  } catch {
    return null;
  }
}

export function enregistrerPin(pin) {
  try {
    if (pin) localStorage.setItem(CLE_PIN, pin);
    else localStorage.removeItem(CLE_PIN);
  } catch {
    /* stockage indisponible : le code sera redemandé */
  }
}

export class ErreurApi extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function appel(methode, chemin, corps) {
  const entetes = {};
  if (corps !== undefined) entetes['Content-Type'] = 'application/json';
  const pin = pinEnregistre();
  if (pin) entetes['X-Pin'] = pin;
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
  if (!rep.ok) throw new ErreurApi(rep.status, donnees.erreur || `Erreur ${rep.status}`);
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
