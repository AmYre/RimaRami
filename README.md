# rimarami

Feuille de score et classement pour nos parties de rami tunisien.

- **Pendant la partie** : on saisit les points de chaque manche, l’appli tient les totaux, annonce qui sort et quand la partie se termine.
- **Après la partie** : chaque place rapporte des points au classement général, plus à la table 1 qu’à la table 2.
- **Au tour suivant** : l’appli propose les tables par montée / descente.
- **Historique des modifications** : chaque changement est signé (qui, quand, depuis quel téléphone, avant → après) et peut être annulé.

Appli web pensée pour le téléphone (on peut l’ajouter à l’écran d’accueil). Node.js + PostgreSQL, sans étape de build.

## Règles appliquées

| | |
|---|---|
| Sortie | Un joueur dont le total **dépasse 701** est sorti (701 pile, il reste en jeu). Il ne marque plus de points. |
| Fin de partie | Quand il ne reste que **2 joueurs** sous le seuil : au 2e sorti à 4 joueurs, au 1er sorti à 3 joueurs. |
| Places | Les 2 restants sont classés au plus petit total. Le premier sorti finit dernier. Deux sortis dans la même manche : le plus gros total est derrière. Égalité parfaite : même place. |
| Points de classement | Table 1 (4 joueurs) : 10, 7, 5, 3. Table 2 (3 joueurs) : 5, 3, 1. |
| Classement général | Somme des points. À égalité : meilleure moyenne par partie, puis plus de victoires. |
| Tables | Le 1er de la table 2 monte, le dernier de la table 1 descend. Avec 7 présents : 4 + 3 (8 : 4 + 4, 6 : 3 + 3). La proposition se modifie à la main ou se tire au sort. |

Seuil, nombre de joueurs restants et barèmes se changent dans **Réglages**. Une partie garde les règles en vigueur au moment où elle a été lancée.

Joueurs créés au premier démarrage : Amir, Youns, Riadh, Mo Salah, Adel, Fares, Jelel.

## Déployer sur Dokploy

1. **Base de données** : dans le projet Dokploy, *Create Service → Database → PostgreSQL*. Une fois créée, copier son **Internal Connection URL**.
2. **Application** : *Create Service → Application*, source GitHub `AmYre/rimarami`, branche `main`, build type **Dockerfile**.
3. **Variables d’environnement** de l’application :
   ```
   DATABASE_URL=<Internal Connection URL de l’étape 1>
   APP_PIN=1234        # facultatif, voir plus bas
   ```
4. **Domaine** : port du conteneur **3000**.
5. *Deploy*. Les tables sont créées automatiquement au premier démarrage. Activer l’auto-deploy pour redéployer à chaque push sur `main`.

### Code d’accès

Sans `APP_PIN`, toute personne qui a le lien peut modifier les scores. Avec `APP_PIN`, la consultation reste libre mais toute modification demande le code ; il est ensuite retenu sur le téléphone.

### Historique des modifications

Chaque téléphone indique une fois qui l’utilise (on touche son nom, modifiable dans *Réglages*). Toute modification est ensuite enregistrée dans un journal : auteur, date, appareil (« iPhone, Safari (a3f9c2) », l’identifiant distingue deux téléphones du même modèle) et valeurs avant / après.

- Dans chaque partie, *Historique des modifications* liste les manches enregistrées, corrigées et supprimées.
- Une correction peut être annulée (*Remettre les scores d’avant*), une manche supprimée rétablie à sa place.
- Une partie supprimée se rétablit depuis *Historique → Parties supprimées*.
- Les changements de règles et de joueurs apparaissent en bas de *Réglages*.

Le nom est déclaratif : c’est un outil de confiance entre amis, pas une authentification. Le code d’accès (`APP_PIN`) reste la barrière pour les personnes extérieures.

### Sauvegardes

*Réglages → Télécharger la sauvegarde* donne tout l’historique en JSON (`/api/export`). Les sauvegardes automatiques de la base se configurent aussi dans Dokploy.

## Lancer en local

```bash
docker compose up            # appli + Postgres sur http://localhost:3000
```

ou, avec un Postgres existant :

```bash
npm install
DATABASE_URL=postgres://… npm run dev
npm test                     # tests des règles
```

## Organisation du code

```
public/js/rules.js   règles du jeu, classement, montée/descente (partagé serveur + navigateur)
src/server.js        API Express et fichiers statiques
src/db.js            accès Postgres, chargement et calcul de l’état
src/journal.js       journal des modifications et retour en arrière
src/schema.sql       schéma (idempotent, exécuté à chaque démarrage)
public/              interface (HTML, CSS, JS sans build)
test/                tests (node --test)
```

Les places et points ne sont jamais stockés : ils sont recalculés à partir des manches. Corriger ou supprimer une manche met donc tout à jour, classement compris.

### API

| Méthode | Route | |
|---|---|---|
| GET | `/api/etat` | Joueurs, réglages, tours, parties calculées, classement, proposition de tables |
| POST | `/api/tours` | `{ tables: [[ids table 1], [ids table 2]] }` |
| POST | `/api/parties/:id/manches` | `{ num, scores: { joueurId: points } }` |
| PUT / DELETE | `/api/manches/:id` | Corriger / supprimer une manche |
| DELETE | `/api/parties/:id` | Supprimer une partie |
| POST / PATCH | `/api/joueurs[/:id]` | Ajouter, renommer, activer un joueur |
| PUT | `/api/reglages` | `{ seuil, restants, bareme: { 1: [...], 2: [...] } }` |
| GET | `/api/parties/:id/journal` | Historique des modifications d’une partie |
| GET | `/api/journal?actions=a,b&limite=n` | Journal filtré par type d’action |
| POST | `/api/journal/:id/retablir` | Annuler une correction, rétablir une manche ou une partie supprimée |
| GET | `/api/export` | Sauvegarde JSON (journal compris) |
| GET | `/healthz` | Santé (vérifie la base) |

Les écritures demandent l’en-tête `X-Auteur` (nom, encodé URL), et `X-Pin` si `APP_PIN` est défini. `X-Appareil` (6 caractères hexadécimaux) est facultatif.

Police : Bricolage Grotesque (SIL Open Font License, `public/fonts/OFL.txt`).
