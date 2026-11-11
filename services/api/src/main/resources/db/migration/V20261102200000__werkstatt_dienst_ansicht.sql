-- =============================================================================
-- Werkstatt-Automatik V1, Paket P9a: was der Werkstatt-Dienst gerade tut, für
-- die Werkstatt-Bildschirme im Portal (Entscheid WI-8 A).
--
-- werkstatt_dienst_ansicht: die zuletzt gemeldete Ansicht des Dienstes
-- (docs/contracts/werkstatt-ansicht-v1.md), eine Zeile. Der Dienst meldet sie
-- jeden Takt; das Portal zeigt ihr Alter und nennt sie veraltet, wenn sie
-- ausbleibt. Anzeige, kein Beweis: die Belege stehen an der Abnahme.
--
-- werkstatt_lauf: je Lauf sein letzter Stand (für „Heute“ und die Übersicht).
--
-- Globale Betriebsdaten wie werkstatt_box: keine Rechte für die App-Rolle, RLS
-- mit FORCE und ohne Policy, nur über voltpilot_admin. Kein Geheimnis darin:
-- die API weist eine Ansicht mit Schlüsselmaterial ab.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_dienst_ansicht (
    id           SMALLINT    PRIMARY KEY DEFAULT 1,
    ansicht      JSONB       NOT NULL,
    dienst_zeit  TIMESTAMPTZ NOT NULL,
    gemeldet_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    gemeldet_von TEXT        NOT NULL,
    CONSTRAINT werkstatt_dienst_ansicht_eine_chk CHECK (id = 1),
    CONSTRAINT werkstatt_dienst_ansicht_objekt_chk CHECK (jsonb_typeof(ansicht) = 'object')
);

CREATE TABLE IF NOT EXISTS werkstatt_lauf (
    kennung         TEXT        PRIMARY KEY,
    freigabe        TEXT,
    box_art         TEXT,
    zustand         TEXT        NOT NULL,
    schritt         TEXT,
    titel           TEXT,
    grund           TEXT,
    beginn          TIMESTAMPTZ NOT NULL,
    ende            TIMESTAMPTZ,
    stand           JSONB       NOT NULL,
    aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT werkstatt_lauf_kennung_chk CHECK (kennung ~ '^[A-Za-z0-9._:-]{1,80}$'),
    CONSTRAINT werkstatt_lauf_zustand_chk CHECK (zustand IN ('laeuft', 'wartet', 'fertig', 'angehalten')),
    CONSTRAINT werkstatt_lauf_stand_chk CHECK (jsonb_typeof(stand) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_lauf_beginn ON werkstatt_lauf (beginn DESC);

REVOKE ALL ON werkstatt_dienst_ansicht FROM ${appDbUser};
REVOKE ALL ON werkstatt_dienst_ansicht FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_dienst_ansicht TO ${adminDbUser};

REVOKE ALL ON werkstatt_lauf FROM ${appDbUser};
REVOKE ALL ON werkstatt_lauf FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_lauf TO ${adminDbUser};

ALTER TABLE werkstatt_dienst_ansicht ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_dienst_ansicht FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_lauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_lauf FORCE ROW LEVEL SECURITY;
