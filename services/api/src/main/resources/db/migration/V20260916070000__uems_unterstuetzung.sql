-- =============================================================================
-- UEMS AP-03 IP-8 — die Unterstützung: Anfrage, Notfall-Zugriff und der Hinweis
-- an die Kundenadministratoren
-- =============================================================================
--
-- Eine Unterstützung IST eine Zuweisung (V20260915030000, IP-2): eine Zeile
-- `zugriff` je Standort mit rolle = 'unterstuetzer', art, umfang und einem Ende.
-- Diese Migration legt KEINE zweite Wahrheit daneben — wer hineindarf, sagt
-- weiterhin allein `zugriff` über `zugriff_zeitraum(…) @> jetzt` (IP-4). Sie
-- bringt nur, was dort keinen Platz hat:
--
--   1. die ANFRAGE von VoltPilot (E8, A5) — ein Wunsch, noch kein Zugriff;
--   2. den HINWEIS an die Kundenadministratoren (E8, A14) — das Postfach,
--      solange kein SMTP steht (vp-login-smtp-reset-d6). Steht es, versendet
--      der Sender dieselben Zeilen und trägt `email_versandt_am` nach.
--
-- ⚠ Die Gewährung selbst hat KEINE eigene Tabelle und KEINE eigene Kennung:
--   ihr Griff ist die kleinste `zugriff.id` der Zeilen, die (benutzer_sub, art,
--   umfang, gueltig_ab, gueltig_bis, endet_am, beendet_am) teilen — dieselbe
--   Gruppierung, mit der die Selbstauskunft seit IP-4 ihre Banner baut. Zeilen
--   werden nie umgeschrieben, also ist der Griff stabil.
--
-- ⚠ Kein `site_scope` (IP-5) auf den beiden Tabellen: beide werden allein vom
--   Kundenadministrator gelesen und geschrieben, und der ist unternehmensweit
--   (Matrix-Zeile `unterstuetzung.verwalten` = U). Der Mandantenzaun gilt.

-- -----------------------------------------------------------------------------
-- 1. Das Vokabular `aenderung` bekommt zwei Wörter (rechte-vectors.json,
--    Block `vokabular.aenderung`, Zwilling RechteAbleitung.AenderungsArt):
--
--      verlaengern  ein neues Enddatum (§4.6) — die alte Zeile wird beendet,
--                   eine neue beginnt; das Protokoll nennt es beim Namen statt
--                   „entzogen" zu behaupten.
--      ablaufen     das Ende durch Zeitablauf (A4: „endete durch Zeitablauf").
--                   Niemand entzieht hier etwas: die Zeile war zu ihrem
--                   `endet_am` von selbst unwirksam; der Läufer schreibt nur
--                   die Zeile ins Protokoll.
--
-- CREATE OR REPLACE einer IMMUTABLE-Funktion prüft bestehende CHECKs nicht neu —
-- und muss es nicht: das Vokabular wächst, es verliert nie ein Wort.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION zugriff_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('konto', 1, 'benutzer'),
    ('konto', 2, 'partner'),
    ('konto', 3, 'plattform'),
    ('konto_zustand', 1, 'angelegt'),
    ('konto_zustand', 2, 'aktiv'),
    ('konto_zustand', 3, 'gesperrt'),
    ('konto_zustand', 4, 'entfernt'),
    ('art', 1, 'installateur'),
    ('art', 2, 'voltpilot'),
    ('art', 3, 'notfall'),
    ('umfang', 1, 'ansehen'),
    ('umfang', 2, 'einrichten'),
    ('umfang', 3, 'einrichten_und_bedienen'),
    ('aenderung', 1, 'zuweisen'),
    ('aenderung', 2, 'entziehen'),
    ('aenderung', 3, 'sperren'),
    ('aenderung', 4, 'entfernen'),
    ('aenderung', 5, 'verlaengern'),
    ('aenderung', 6, 'ablaufen')
$$;

-- Auch die beiden neuen Wörter nennen ihre Zuweisung: ein Protokolleintrag über
-- eine Unterstützung ohne ihre Zeile wäre keine Spur.
ALTER TABLE zugriff_protokoll DROP CONSTRAINT IF EXISTS zugriff_protokoll_zugriff_chk;
ALTER TABLE zugriff_protokoll ADD CONSTRAINT zugriff_protokoll_zugriff_chk
    CHECK (aktion NOT IN ('zuweisen', 'entziehen', 'verlaengern', 'ablaufen')
           OR (zugriff_id IS NOT NULL AND rolle IS NOT NULL));

-- -----------------------------------------------------------------------------
-- 2. unterstuetzung_anfrage — VoltPilot fragt, der Kundenadministrator
--    entscheidet (E8, A5). Der Zustand wird ABGELEITET, nicht gespeichert:
--
--      entschieden_am IS NULL                       → offen (Vertrag: entwurf)
--      entschieden_am, zugriff_id IS NOT NULL       → bestätigt
--      entschieden_am, zugriff_id IS NULL           → abgelehnt
--
--    Damit gibt es kein zweites Zustands-Vokabular, das mit dem des Vertrags
--    auseinanderlaufen könnte.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unterstuetzung_anfrage (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL,
    -- Anfragen kann nur VoltPilot (E8); ein Installateur wird gewährt, nie gefragt.
    art              TEXT        NOT NULL,
    umfang           TEXT        NOT NULL,
    -- Das Subject des anfragenden VoltPilot-Kontos und sein Name im Protokoll.
    angefragt_von    TEXT        NOT NULL,
    angefragt_name   TEXT        NOT NULL,
    angefragt_email  TEXT,
    gueltig_ab       TIMESTAMPTZ NOT NULL,
    -- Enddatum, letzter Tag EINSCHLIESSLICH — dieselbe Zeitform wie zugriff.
    gueltig_bis      DATE        NOT NULL,
    zeitzone         TEXT        NOT NULL,
    grund            TEXT,
    entschieden_am   TIMESTAMPTZ,
    entschieden_von  TEXT,
    -- Der Griff der gewährten Unterstützung (kleinste zugriff.id der Gewährung).
    zugriff_id       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_unterstuetzung_anfrage_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT unterstuetzung_anfrage_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_anfrage_zugriff_fk FOREIGN KEY (zugriff_id, tenant_id)
        REFERENCES zugriff (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_anfrage_art_chk CHECK (art = 'voltpilot'),
    CONSTRAINT unterstuetzung_anfrage_umfang_chk
        CHECK (coalesce(zugriff_wort('umfang', umfang), false)),
    CONSTRAINT unterstuetzung_anfrage_von_chk
        CHECK (angefragt_von <> '' AND btrim(angefragt_name) <> ''),
    CONSTRAINT unterstuetzung_anfrage_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT unterstuetzung_anfrage_grund_chk CHECK (grund IS NULL OR btrim(grund) <> ''),
    -- Entschieden heißt: Zeit UND Person; ein Zugriff nur mit Entscheidung.
    CONSTRAINT unterstuetzung_anfrage_entschieden_chk
        CHECK ((entschieden_am IS NULL) = (entschieden_von IS NULL)
               AND (entschieden_von IS NULL OR entschieden_von <> '')
               AND (zugriff_id IS NULL OR entschieden_am IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_unterstuetzung_anfrage_offen
    ON unterstuetzung_anfrage (tenant_id, created_at DESC) WHERE entschieden_am IS NULL;

-- Die gewünschten Standorte einer Anfrage (E5: ausdrückliche Liste).
CREATE TABLE IF NOT EXISTS unterstuetzung_anfrage_standort (
    anfrage_id   UUID NOT NULL,
    tenant_id    UUID NOT NULL,
    standort_id  UUID NOT NULL,
    PRIMARY KEY (anfrage_id, standort_id),
    CONSTRAINT unterstuetzung_anfrage_standort_anfrage_fk FOREIGN KEY (anfrage_id, tenant_id)
        REFERENCES unterstuetzung_anfrage (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_anfrage_standort_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- 3. unterstuetzung_hinweis — das Postfach der Kundenadministratoren.
--
--    Ein Hinweis je Anlass und Empfänger. `email_versandt_am` bleibt NULL,
--    solange kein SMTP steht — der Hinweis ist dann die Karte im Portal, nicht
--    weniger sichtbar, nur ein anderer Weg (E8: „E-Mail sobald SMTP, sonst
--    Portal-Hinweis").
--
--    Das Wort `anlass` ist ein eigenes, geschlossenes Vokabular dieses Pakets
--    (kein Block des Rechte-Vertrags); sein Zwilling ist
--    unterstuetzung/Hinweis.Anlass und die Aufzählung in openapi.yaml/api.ts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unterstuetzung_hinweis (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL,
    anlass            TEXT        NOT NULL,
    -- Das Subject des Kundenadministrators, der den Hinweis bekommt.
    empfaenger_sub    TEXT        NOT NULL,
    empfaenger_email  TEXT,
    -- Der Griff der betroffenen Unterstützung bzw. die Anfrage; genau eines.
    zugriff_id        UUID,
    anfrage_id        UUID,
    -- Der Kundensatz, wie er im Portal steht — beim Versand der Text der E-Mail.
    text              TEXT        NOT NULL,
    gelesen_am        TIMESTAMPTZ,
    email_versandt_am TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_unterstuetzung_hinweis_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT unterstuetzung_hinweis_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_hinweis_zugriff_fk FOREIGN KEY (zugriff_id, tenant_id)
        REFERENCES zugriff (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_hinweis_anfrage_fk FOREIGN KEY (anfrage_id, tenant_id)
        REFERENCES unterstuetzung_anfrage (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT unterstuetzung_hinweis_anlass_chk
        CHECK (anlass IN ('anfrage', 'gewaehrt', 'notfall', 'erinnerung', 'abgelaufen', 'beendet')),
    CONSTRAINT unterstuetzung_hinweis_empfaenger_chk CHECK (empfaenger_sub <> ''),
    CONSTRAINT unterstuetzung_hinweis_text_chk CHECK (btrim(text) <> ''),
    -- Genau ein Bezug: eine Anfrage ODER eine gewährte Unterstützung.
    CONSTRAINT unterstuetzung_hinweis_bezug_chk
        CHECK ((zugriff_id IS NULL) <> (anfrage_id IS NULL))
);
-- Der Läufer schreibt je Anlass und Empfänger EINEN Hinweis - auch wenn er den
-- Takt zweimal fährt (Neustart, zwei Instanzen). Zwei Teil-Indizes, weil ein
-- NULL in einem gewöhnlichen UNIQUE nie kollidiert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_unterstuetzung_hinweis_zugriff
    ON unterstuetzung_hinweis (tenant_id, anlass, empfaenger_sub, zugriff_id)
    WHERE zugriff_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_unterstuetzung_hinweis_anfrage
    ON unterstuetzung_hinweis (tenant_id, anlass, empfaenger_sub, anfrage_id)
    WHERE anfrage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_unterstuetzung_hinweis_offen
    ON unterstuetzung_hinweis (tenant_id, empfaenger_sub, created_at DESC)
    WHERE gelesen_am IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE unterstuetzung_anfrage ENABLE ROW LEVEL SECURITY;
ALTER TABLE unterstuetzung_anfrage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unterstuetzung_anfrage_tenant_isolation ON unterstuetzung_anfrage;
CREATE POLICY unterstuetzung_anfrage_tenant_isolation ON unterstuetzung_anfrage
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE unterstuetzung_anfrage_standort ENABLE ROW LEVEL SECURITY;
ALTER TABLE unterstuetzung_anfrage_standort FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unterstuetzung_anfrage_standort_tenant_isolation ON unterstuetzung_anfrage_standort;
CREATE POLICY unterstuetzung_anfrage_standort_tenant_isolation ON unterstuetzung_anfrage_standort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE unterstuetzung_hinweis ENABLE ROW LEVEL SECURITY;
ALTER TABLE unterstuetzung_hinweis FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unterstuetzung_hinweis_tenant_isolation ON unterstuetzung_hinweis;
CREATE POLICY unterstuetzung_hinweis_tenant_isolation ON unterstuetzung_hinweis
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- 5. Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede
--    neue Tabelle — hier wird ALLES genommen und eng neu gegeben (wie IP-2).
-- -----------------------------------------------------------------------------
REVOKE ALL ON unterstuetzung_anfrage, unterstuetzung_anfrage_standort, unterstuetzung_hinweis
    FROM ${appDbUser}, ${adminDbUser};

-- Die Anfrage: stellen und EINMAL entscheiden; Wunsch und Urheber nie ändern.
GRANT SELECT, INSERT ON unterstuetzung_anfrage TO ${appDbUser};
GRANT UPDATE (entschieden_am, entschieden_von, zugriff_id) ON unterstuetzung_anfrage TO ${appDbUser};
GRANT SELECT, INSERT ON unterstuetzung_anfrage_standort TO ${appDbUser};
-- Der Hinweis: anlegen, lesen, als gelesen und als versandt markieren.
GRANT SELECT, INSERT ON unterstuetzung_hinweis TO ${appDbUser};
GRANT UPDATE (gelesen_am, email_versandt_am) ON unterstuetzung_hinweis TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: nur das Offboarding räumt ab.
GRANT SELECT, DELETE ON unterstuetzung_anfrage, unterstuetzung_anfrage_standort, unterstuetzung_hinweis
    TO ${adminDbUser};

COMMENT ON TABLE unterstuetzung_anfrage IS
    'AP-03 IP-8 (E8, A5): VoltPilot fragt eine Unterstuetzung an; der Zustand wird abgeleitet, nie gespeichert.';
COMMENT ON TABLE unterstuetzung_hinweis IS
    'AP-03 IP-8 (E8, A14): der Hinweis an die Kundenadministratoren - Portal-Karte heute, E-Mail sobald SMTP steht.';
