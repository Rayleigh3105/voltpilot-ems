-- UEMS AP-06 IP-4: die Vorschlagsliste der Bestands-Übernahme — was sie beim
-- Bestätigen braucht, und nur das.
--
-- Der Schreibweg ist DatenquelleVorschlagService (GET/POST
-- /api/v1/sites/{siteId}/data-sources/vorschlag[/uebernehmen]); die Gruppierung
-- ist Vertrag (docs/contracts/v2/data-source-assignment.md §8, Familie
-- `bestand` in data-source-vectors.json, DatenquelleRegeln.vorschlagsliste).
-- Das GET schreibt nichts. Erst die Bestätigung legt je Vorschlag die Quelle
-- an, beginnt ihre Zuständigkeit AB REIHENBEGINN, setzt
-- measurement_point.data_source_id und geraet.data_source_id der laufenden
-- Speisung — alles in EINER Transaktion.
--
-- REIN ADDITIV — drei Weitungen, keine Zeile ändert sich:
--
-- 1. data_source_aenderung bekommt das Wort `aus_bestand_uebernommen`: EIN
--    Eintrag je Quelle, der sagt, was die Bestätigung festgehalten hat (neu:
--    Kennzeichen, Weg, Geräte-IDs, Takt, Steuerquelle, Box, Beginn, die
--    Komponenten). Die Box ist Pflicht wie bei den Zuständigkeits-Einträgen.
--    `gilt_ab` ist der REIHENBEGINN — die EINZIGE Stelle, an der ein Eintrag
--    in der Vergangenheit beginnt (Vertrag §4: „Einzige Ausnahme ist die
--    Vorschlagsliste der Bestands-Übernahme"); wann bestätigt wurde, sagt
--    `created_at`. Geweitet wird, indem der AKTUELLE Stand (V20260911180000)
--    abgeschrieben und um das eine Wort ergänzt wird.
--
-- 2. data_source.kadenz_s wird NULL-fähig: NULL = „nicht erhoben". Eine Quelle
--    aus dem Bestand übernimmt den Lesetakt ihrer Komponenten
--    (connection_json.interval_s — von dort hebt ihn der Registry-Push auf die
--    Treiber-Ebene); wo keine ihn nennt, liest die Box nach der Vorgabe ihres
--    Treibers, die die Cloud nicht kennt — ein erfundener Takt wäre eine Zahl
--    ohne Beleg (die Spalte measurement_point.interval_s trägt die Vorgabe 5
--    jeder Zeile und erreicht die Box nicht). Der CHECK
--    data_source_kadenz_chk (1 … 86400) gilt weiter für jeden genannten Takt;
--    angelegt oder bearbeitet über die Schnittstelle wird weiterhin nur MIT
--    Takt (DatenquelleService verlangt ihn).
--
-- 3. Das Protokoll-Vokabular bekommt `solarman_v5` („Solarman-Datenlogger": Deye
--    über seinen Datenlogger, Modbus-RTU im Solarman-V5-Rahmen über TCP 8899).
--    Nach AP-06 Soll-Regel 8 (Konzept vom Captain am 10.09.2026 abgenommen: „JEDE vorhandene
--    Komponente wird … genau einer Datenquelle zugeordnet"): ein Vokabular, das
--    einen realen Bestands-Transport auslässt, verfehlt die Regel — und ihn auf
--    `modbus_tcp` abzubilden wäre falsch (anderer Rahmen, anderer Port, die
--    Seriennummer des Datenloggers gehört zum Weg). Die Adresse ist
--    `host:port/seriennummer` (DatenquelleAdresse), die Slave-ID eine Geräte-ID.
--    Geweitet wie oben: der AKTUELLE Stand (V20260911150000) abgeschrieben.

ALTER TABLE data_source_aenderung DROP CONSTRAINT IF EXISTS data_source_aenderung_art_chk;
ALTER TABLE data_source_aenderung ADD CONSTRAINT data_source_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
    'zustaendigkeit_gewechselt', 'aus_bestand_uebernommen'));

ALTER TABLE data_source_aenderung DROP CONSTRAINT IF EXISTS data_source_aenderung_box_chk;
ALTER TABLE data_source_aenderung ADD CONSTRAINT data_source_aenderung_box_chk CHECK (
    device_id IS NOT NULL
    OR art NOT IN ('erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
                   'zustaendigkeit_gewechselt', 'aus_bestand_uebernommen'));

ALTER TABLE data_source ALTER COLUMN kadenz_s DROP NOT NULL;

ALTER TABLE data_source DROP CONSTRAINT IF EXISTS data_source_protokoll_chk;
ALTER TABLE data_source ADD CONSTRAINT data_source_protokoll_chk
    CHECK (protokoll IN ('modbus_tcp', 'sunspec_modbus', 'mqtt', 'http', 'ocpp', 'solarman_v5'));
