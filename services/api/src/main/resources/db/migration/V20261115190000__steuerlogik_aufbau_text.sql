-- =============================================================================
-- V20261115190000 - Steuerlogik Stufe 4: Aufbau und Text im Portal.
-- -----------------------------------------------------------------------------
-- Eine Logik wird im Portal geschrieben (Aufbau und Text sind zwei Ansichten
-- desselben Textes) und als Fassung gespeichert, bevor sie läuft. Der Lebenslauf
-- des Konzepts (Bericht 8.1): geprüft, läuft mit, scharf, stillgelegt.
--
-- steuerlogik bekommt den Zustand 'geprueft': eine gespeicherte Fassung, die die
-- Prüfung bestanden hat und noch nicht läuft. Gespeichert wird nur, was die
-- Prüfung nicht sperrt; ein Entwurf ohne Fassung bleibt im Browser. Dazu je
-- Fassung die Rolle ihres Urhebers (Bericht 17.4: lesbar, ob die laufende
-- Fassung vom Fachbetrieb oder vom Kunden stammt), eine kurze Notiz und, für
-- "zur Freigabe vorlegen" (scharf schaltet in Stufe 4 die Plattform), wer wann
-- vorgelegt hat.
--
-- steuerlogik_protokoll kennt die neuen Schritte: gespeichert, mitlaufen,
-- vorgelegt, anfrage (eine Änderung angefragt) und erledigt (eine Anfrage).
--
-- steuerlogik_anfrage: "Änderung anfragen" (Bericht 6.5, 8.8): Bedienberechtigte
-- sehen die Logik, schreiben sie aber nicht; sie fragen eine Änderung an, zu
-- einem Wert oder zur ganzen Logik. Wer die Logik bearbeitet, sieht offene
-- Anfragen an der Logik und hakt sie ab. Mandantenbezogen mit RLS wie die
-- übrigen Tabellen der Steuerlogik; der Index beginnt mit tenant_id
-- (LoeschzugIndexdeckungTest) vor dem Zugriffspfad der Leser (je Logik nach Zeit).
-- =============================================================================

ALTER TABLE steuerlogik DROP CONSTRAINT IF EXISTS steuerlogik_zustand_check;
ALTER TABLE steuerlogik ADD CONSTRAINT steuerlogik_zustand_check
    CHECK (zustand IN ('geprueft', 'mitlaufend', 'scharf', 'stillgelegt'));

ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS angelegt_rolle TEXT;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS notiz          TEXT CHECK (notiz IS NULL OR length(notiz) <= 500);
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS vorgelegt_am   TIMESTAMPTZ;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS vorgelegt_von  TEXT;

ALTER TABLE steuerlogik_protokoll DROP CONSTRAINT IF EXISTS steuerlogik_protokoll_was_check;
ALTER TABLE steuerlogik_protokoll ADD CONSTRAINT steuerlogik_protokoll_was_check
    CHECK (was IN ('angenommen', 'scharf', 'zurueck', 'stillgelegt', 'stellwert',
                   'gespeichert', 'mitlaufen', 'vorgelegt', 'anfrage', 'erledigt'));

CREATE TABLE IF NOT EXISTS steuerlogik_anfrage (
    id            UUID        PRIMARY KEY,
    tenant_id     UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id       UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    logik_id      UUID        NOT NULL,
    kennung       TEXT,
    text          TEXT        NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1000),
    am            TIMESTAMPTZ NOT NULL,
    von           TEXT,
    rolle         TEXT,
    erledigt_am   TIMESTAMPTZ,
    erledigt_von  TEXT
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_anfrage_tenant_logik_am ON steuerlogik_anfrage (tenant_id, logik_id, am);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_anfrage_site ON steuerlogik_anfrage (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik_anfrage TO ${appDbUser};

ALTER TABLE steuerlogik_anfrage ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_anfrage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_anfrage_isolation ON steuerlogik_anfrage;
CREATE POLICY steuerlogik_anfrage_isolation ON steuerlogik_anfrage
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
