-- =============================================================================
-- UEMS AP-03 Befund E12: der STICHTAG der Bestandsregel — Tabelle `zugriff_bestand`
-- =============================================================================
--
-- Die Bestandsregel E12 (V20260915030000, IP-2) steht seit IP-4 auch IN DER
-- ANFRAGE: ein Kundenkonto, das in seinem Kundenbereich NIE eine Zuweisung
-- hatte, gilt als Kundenadministrator und sieht das ganze Unternehmen. Das ist
-- richtig, solange jedes Konto aus dem Bestand stammt — und es ist der Grund,
-- warum eine Störung des Start-Laufs (Not-Aus, Keycloak nicht erreichbar, Lauf
-- abgeschaltet) keinen Kunden aussperrt.
--
-- Der Regel fehlt ein STICHTAG. Sobald Benutzer im Portal angelegt werden
-- (AP-03 IP-13/IP-14), hätte ein frisch angelegtes Konto naturgemäß nie eine
-- Zuweisung — und wäre unternehmensweit. Das ist das Gegenteil dessen, was ein
-- Kundenadministrator beim Anlegen erwartet.
--
-- DER STICHTAG IST DIE ÜBERNAHME SELBST. Diese Tabelle hält je Kundenbereich
-- den Zeitpunkt, zu dem seine VOLLSTÄNDIGE Kontenliste übernommen wurde. Danach
-- trägt jedes Bestandskonto eine echte Zeile in `zugriff` — „nie zugewiesen"
-- kann dann nur noch heißen: nach dem Stichtag entstanden.
--
--   * kein Stichtag  → E12 gilt wie bisher (der Lauf ist aus, war nicht
--     erfolgreich oder kam noch nicht dazu): KEIN Bestandskonto wird
--     ausgesperrt. Die Schutzwirkung von IP-2/IP-4 bleibt unberührt;
--   * Stichtag da    → E12 gilt nicht mehr. Ein Konto ohne Zuweisung bekommt
--     den engsten Zaun und sieht nichts, bis ihm etwas zugewiesen wird.
--
-- Der Stichtag ist KEINE Zeitgrenze, gegen die gerechnet wird — er ist die
-- Aussage „der Bestand dieses Kundenbereichs ist übernommen". Er wird EINMAL
-- geschrieben (ON CONFLICT DO NOTHING, kein UPDATE-Recht) und nie zurückgesetzt:
-- ein zweiter Lauf, ein Neustart oder ein nachgezogenes Konto ändern ihn nicht.
--
-- Zwei Wege schreiben ihn (siehe `ZugriffBestand`):
--   * `bestandslauf`        — der Start-Lauf hat die vollständige Kontenliste
--     des Kundenbereichs aus Keycloak übernommen;
--   * `neuer_kundenbereich` — ein Kundenbereich, der NACH diesem Paket entsteht
--     (Selbstregistrierung): er hat keinen Bestand, sein erstes Konto bekommt
--     seine Zuweisung ausdrücklich, und er beginnt sofort ohne E12.
--
-- Additiv: keine bestehende Tabelle, Spalte, Policy oder Rechtevergabe wird
-- angefasst. Die Tabelle ist nach der Migration leer.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zugriff_bestand (
    tenant_id  UUID        NOT NULL,
    -- Der Zeitpunkt der Übernahme. „Bestandskonto" heißt: vor ihm da gewesen —
    -- bewiesen durch die Zeile in `zugriff`, die die Übernahme geschrieben hat.
    stichtag   TIMESTAMPTZ NOT NULL,
    -- Betriebsauskunft, kein Vertragswort: woher der Stichtag kommt.
    herkunft   TEXT        NOT NULL,
    -- Wie viele Konten die Übernahme betrachtet hat (für das Log und die Aufsicht).
    konten     INTEGER     NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT zugriff_bestand_pkey PRIMARY KEY (tenant_id),
    CONSTRAINT zugriff_bestand_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT zugriff_bestand_herkunft_chk
        CHECK (herkunft IN ('bestandslauf', 'neuer_kundenbereich')),
    CONSTRAINT zugriff_bestand_konten_chk CHECK (konten >= 0)
);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE zugriff_bestand ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugriff_bestand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zugriff_bestand_tenant_isolation ON zugriff_bestand;
CREATE POLICY zugriff_bestand_tenant_isolation ON zugriff_bestand
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben.
-- -----------------------------------------------------------------------------
REVOKE ALL ON zugriff_bestand FROM ${appDbUser}, ${adminDbUser};

-- Einmal setzen und lesen. KEIN UPDATE: ein Stichtag wird nie verschoben.
GRANT SELECT, INSERT ON zugriff_bestand TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: nur das Offboarding räumt ab.
GRANT SELECT, DELETE ON zugriff_bestand TO ${adminDbUser};

COMMENT ON TABLE zugriff_bestand IS
    'AP-03 Befund E12: je Kundenbereich der Stichtag, ab dem die Bestandsregel '
    '"nie zugewiesen = unternehmensweit" nicht mehr gilt. Keine Zeile = die Regel gilt.';
