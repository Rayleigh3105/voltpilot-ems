-- UEMS AP-20 IP-18 — Vertragsende III: der Löschnachweis (E10 = A, BT4, RF-08, §4.2 kundenbereich_ende).
--
-- Der Löschweg (POST /api/v1/admin/tenants/{id}/delete) löscht einen Kundenbereich nur noch im Zustand „beendet"
-- (V20260925170000) mit abgelaufener Frist. Im SELBEN Zug schreibt er EINE Zeile hier: was nach dem Löschen bleibt.
--
--   * Ohne Personendaten des Kunden: der Kundenbereich nur als Kennung (kein Name — ein Firmenname kann der Name
--     einer Person sein), keine Konten, keine Auftrags- und Begründungstexte (Freitext). Wer gelöscht hat, ist der
--     Betrieb (platform-admin), nicht der Kunde.
--   * `kundenbereich` heißt bewusst NICHT `tenant_id`: der Nachweis ist keine Kundenzeile (kein RLS-Mandant, der
--     Gesamtabzug und die Katalog-Zählung des Löschwegs nehmen ihn nicht mit) und hat keinen Fremdschlüssel — der
--     Kundenbereich ist danach weg, der Nachweis bleibt.
--   * `zaehlungen`: Zeilen je Tabelle vor dem Löschen (Katalog: jede Tabelle mit `tenant_id`, dazu `tenant`);
--     `verblieben`: Zeilen je Tabelle, die der Löschweg NICHT entfernt hat (append-only-Protokolle ohne
--     Fremdschlüssel) — leer heißt vollständig gelöscht. Der Nachweis sagt, was geschah, nicht was sein sollte.
--   * `abzug_sha256`: `manifest_sha256` des letzten abgeschlossenen Gesamtabzugs (IP-17), falls einer geladen wurde.
--   * Kennzeichen LN-JJJJ-nnnn (§4.1), je Jahr der Löschung gezählt.
--
-- Nur der Betrieb: die Admin-Rolle liest und schreibt ein; niemand ändert oder löscht (Trigger), die App-Rolle sieht
-- die Tabelle nicht. Neue, leere Tabelle — der Bestand bleibt unberührt.

CREATE TABLE IF NOT EXISTS mandant_loeschnachweis (
    id                     BIGSERIAL   PRIMARY KEY,
    kennzeichen            TEXT        NOT NULL,
    kundenbereich          UUID        NOT NULL,
    beendet_am             TIMESTAMPTZ NOT NULL,
    frist_tage             INTEGER     NOT NULL,
    loeschung_fruehestens  DATE        NOT NULL,
    geloescht_am           TIMESTAMPTZ NOT NULL DEFAULT now(),
    geloescht_von          TEXT        NOT NULL,
    zaehlungen             JSONB       NOT NULL,
    verblieben             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    abzug_sha256           TEXT,
    abzug_am               TIMESTAMPTZ,
    CONSTRAINT mandant_loeschnachweis_kennzeichen_uq UNIQUE (kennzeichen),
    CONSTRAINT mandant_loeschnachweis_kundenbereich_uq UNIQUE (kundenbereich),
    CONSTRAINT mandant_loeschnachweis_kennzeichen_chk CHECK (kennzeichen ~ '^LN-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT mandant_loeschnachweis_frist_chk
        CHECK (frist_tage > 0 AND geloescht_am >= beendet_am AND btrim(geloescht_von) <> ''),
    CONSTRAINT mandant_loeschnachweis_zaehlungen_chk
        CHECK (jsonb_typeof(zaehlungen) = 'object' AND jsonb_typeof(verblieben) = 'object'),
    CONSTRAINT mandant_loeschnachweis_abzug_chk
        CHECK ((abzug_sha256 IS NULL AND abzug_am IS NULL)
               OR (abzug_sha256 ~ '^[0-9a-f]{64}$' AND abzug_am IS NOT NULL))
);

CREATE OR REPLACE FUNCTION mandant_loeschnachweis_bleibt() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Ein Löschnachweis bleibt, wie er geschrieben wurde (%)', OLD.kennzeichen
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mandant_loeschnachweis_bleibt';
END
$$;
DROP TRIGGER IF EXISTS mandant_loeschnachweis_bleibt ON mandant_loeschnachweis;
CREATE TRIGGER mandant_loeschnachweis_bleibt BEFORE UPDATE OR DELETE ON mandant_loeschnachweis
    FOR EACH ROW EXECUTE FUNCTION mandant_loeschnachweis_bleibt();

REVOKE ALL ON mandant_loeschnachweis FROM ${appDbUser};
REVOKE ALL ON mandant_loeschnachweis FROM ${adminDbUser};
GRANT SELECT, INSERT ON mandant_loeschnachweis TO ${adminDbUser};
REVOKE ALL ON SEQUENCE mandant_loeschnachweis_id_seq FROM ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE mandant_loeschnachweis_id_seq TO ${adminDbUser};
