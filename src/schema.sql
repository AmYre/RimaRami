-- Schéma rimarami. Exécuté à chaque démarrage : uniquement des opérations idempotentes.

CREATE TABLE IF NOT EXISTS joueurs (
  id         SERIAL PRIMARY KEY,
  nom        TEXT NOT NULL,
  actif      BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS joueurs_nom_unique ON joueurs (lower(nom));

CREATE TABLE IF NOT EXISTS reglages (
  cle    TEXT PRIMARY KEY,
  valeur JSONB NOT NULL
);

-- Un tour = les parties lancées ensemble (table 1 + table 2).
CREATE TABLE IF NOT EXISTS tours (
  id       SERIAL PRIMARY KEY,
  cree_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parties (
  id        SERIAL PRIMARY KEY,
  tour_id   INT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  num_table INT NOT NULL CHECK (num_table >= 1),
  seuil     INT NOT NULL,
  restants  INT NOT NULL DEFAULT 2,
  bareme    JSONB NOT NULL,           -- points de classement par place, figés à la création
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parties_tour ON parties (tour_id);

CREATE TABLE IF NOT EXISTS partie_joueurs (
  partie_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  joueur_id INT NOT NULL REFERENCES joueurs(id),
  siege     INT NOT NULL,
  PRIMARY KEY (partie_id, joueur_id)
);

CREATE TABLE IF NOT EXISTS manches (
  id        SERIAL PRIMARY KEY,
  partie_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  num       INT NOT NULL,
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partie_id, num)
);

CREATE TABLE IF NOT EXISTS manche_scores (
  manche_id INT NOT NULL REFERENCES manches(id) ON DELETE CASCADE,
  joueur_id INT NOT NULL REFERENCES joueurs(id),
  points    INT NOT NULL,
  PRIMARY KEY (manche_id, joueur_id)
);
