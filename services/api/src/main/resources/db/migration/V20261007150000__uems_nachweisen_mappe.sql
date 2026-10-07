-- =============================================================================
-- Konzept Nachweisen n1, Runde 2, PR 6 (Entscheid 7): „Unterlagen zusammenstellen“ - die Mappe für eine Prüfung
-- von außen (Vertrag energiemanagement 1.6, Vokabular `mappe_anlass`).
--
-- 1. Neu und leer: energiemanagement_mappe. Eine Mappe hält fest, wer wann wofür (Anlass) welche Gruppen des
--    Verzeichnisses für welchen Zeitraum zusammengestellt hat, mit den Teilen, die dabei offen waren, und die beiden
--    Dateien, die daraus entstanden: das PDF mit Inhaltsverzeichnis und die Verzeichnis-CSV, je mit Prüfsumme.
--    Abrufbar sind die Dateien 30 Tage (`abrufbar_bis`, echte Zeit); danach leert die App-Rolle die beiden
--    Datei-Spalten, die Angaben bleiben als Nachweis, dass es die Mappe gab. Sonst ändert sich nie etwas.
-- 2. Neu und leer: energiemanagement_mappe_abruf. Jeder Abruf einer Datei (PDF oder CSV) wird protokolliert: welche
--    Mappe, welches Format, wer und wann. Nur anhängen.
--
-- Keine bestehende Tabelle, kein CHECK und keine Zeile ändert sich (Invariante 1). Wer keine Mappe anlegt, merkt nichts.
-- Späte Ankunft: beide Tabellen brauchen nur `tenant` und `uems_zugriff_unternehmensweit()` (V20260925013500);
-- ihre CHECKs nennen die Wörter des Vertrags wörtlich (UemsMappeMigrationTest prüft sie gegen
-- `EnergiemanagementRegeln.VOKABULARE`), die Funktion energiemanagement_vokabular() bleibt unberührt.
-- =============================================================================

CREATE TABLE energiemanagement_mappe (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    anlass TEXT NOT NULL,
    von DATE,
    bis DATE NOT NULL,
    gruppen TEXT[] NOT NULL,
    offen TEXT[] NOT NULL DEFAULT '{}',
    stichtag TIMESTAMPTZ NOT NULL,
    eintraege INTEGER NOT NULL,
    gilt INTEGER NOT NULL,
    pdf BYTEA,
    pdf_sha256 TEXT NOT NULL,
    csv BYTEA,
    csv_sha256 TEXT NOT NULL,
    abrufbar_bis TIMESTAMPTZ NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_mappe_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energiemanagement_mappe_anlass_chk CHECK (anlass IN ('audit_von_aussen', 'anfrage_behoerde', 'eigene_ablage')),
    CONSTRAINT energiemanagement_mappe_zeitraum_chk CHECK (von IS NULL OR von <= bis),
    -- Die Gruppen des Verzeichnisses (Vokabular `verzeichnis_gruppe`), mindestens eine.
    CONSTRAINT energiemanagement_mappe_gruppen_chk CHECK (cardinality(gruppen) >= 1 AND gruppen <@ ARRAY['grundlagen',
        'verantwortung', 'risiken_chancen', 'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung',
        'bewertung_messplanung', 'kennzahlen_bezugsbasen', 'ziele_massnahmen_abweichungen', 'audits_feststellungen',
        'managementbewertung', 'berichte']::TEXT[]),
    -- Die Teile des Überblicks (Vokabular `teil`), die beim Zusammenstellen offen waren.
    CONSTRAINT energiemanagement_mappe_offen_chk CHECK (offen <@ ARRAY['energiepolitik', 'anwendungsbereich',
        'rechtliche_anforderungen', 'kontext', 'risiken_chancen', 'aufgaben', 'kompetenz', 'kommunikation', 'betrieb',
        'auslegung', 'beschaffung', 'energetische_bewertung', 'bezugsbasen', 'massnahmen', 'interne_audits',
        'feststellungen', 'managementbewertung', 'berichte']::TEXT[]),
    CONSTRAINT energiemanagement_mappe_zahlen_chk CHECK (eintraege >= 0 AND gilt >= 0),
    CONSTRAINT energiemanagement_mappe_sha_chk CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$' AND csv_sha256 ~ '^[0-9a-f]{64}$'),
    -- Die Dateien gehen nur gemeinsam (nach der Frist), nie eine allein.
    CONSTRAINT energiemanagement_mappe_dateien_chk CHECK ((pdf IS NULL) = (csv IS NULL)),
    CONSTRAINT energiemanagement_mappe_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_mappe_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb',
         'einsicht')),
    CONSTRAINT energiemanagement_mappe_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_mappe_tenant_idx ON energiemanagement_mappe (tenant_id, created_at DESC);

-- Eine Mappe ändert sich nie; nach der Frist werden nur ihre beiden Dateien geleert, einmal.
CREATE FUNCTION energiemanagement_mappe_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['pdf', 'csv']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['pdf', 'csv'])
        OR NEW.pdf IS NOT NULL OR NEW.csv IS NOT NULL OR OLD.pdf IS NULL THEN
        RAISE EXCEPTION 'Eine Mappe ändert sich nie; nach der Frist werden nur ihre Dateien geleert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_mappe_nur_leeren';
    END IF;
    IF OLD.abrufbar_bis > now() THEN
        RAISE EXCEPTION 'Die Mappe ist noch abrufbar'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'energiemanagement_mappe_frist';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energiemanagement_mappe_eingefroren BEFORE UPDATE ON energiemanagement_mappe
    FOR EACH ROW EXECUTE FUNCTION energiemanagement_mappe_eingefroren();

CREATE TABLE energiemanagement_mappe_abruf (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    mappe_id UUID NOT NULL,
    format TEXT NOT NULL,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energiemanagement_mappe_abruf_mappe_fk FOREIGN KEY (mappe_id, tenant_id)
        REFERENCES energiemanagement_mappe(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energiemanagement_mappe_abruf_format_chk CHECK (format IN ('pdf', 'csv')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb',
         'einsicht')),
    CONSTRAINT energiemanagement_mappe_abruf_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energiemanagement_mappe_abruf_mappe_idx ON energiemanagement_mappe_abruf (tenant_id, mappe_id, created_at);

-- RLS + FORCE und der Zaun wie bei den Vermerken (V20261007004500): die Mappe gehört dem ganzen Unternehmen, im
-- engen Standort-Zaun ist sie nicht sichtbar.
ALTER TABLE energiemanagement_mappe ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_mappe FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_mappe_tenant_isolation ON energiemanagement_mappe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_mappe AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

ALTER TABLE energiemanagement_mappe_abruf ENABLE ROW LEVEL SECURITY;
ALTER TABLE energiemanagement_mappe_abruf FORCE ROW LEVEL SECURITY;
CREATE POLICY energiemanagement_mappe_abruf_tenant_isolation ON energiemanagement_mappe_abruf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY site_scope ON energiemanagement_mappe_abruf AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit())
    WITH CHECK (uems_zugriff_unternehmensweit());

-- Grants: die App-Rolle liest und legt an, leert nach der Frist nur die Dateien und löscht nie; nur das
-- administrative Offboarding löscht (TenantRepository.offboard, das Protokoll vor der Mappe).
REVOKE ALL ON energiemanagement_mappe, energiemanagement_mappe_abruf FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energiemanagement_mappe TO ${appDbUser};
GRANT UPDATE (pdf, csv) ON energiemanagement_mappe TO ${appDbUser};
GRANT SELECT, INSERT ON energiemanagement_mappe_abruf TO ${appDbUser};
GRANT SELECT, DELETE ON energiemanagement_mappe, energiemanagement_mappe_abruf TO ${adminDbUser};
