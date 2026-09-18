-- =============================================================================
-- DEV-ONLY Demo-Daten: Kunststoffwerk Ahrenberg GmbH (AP-00 IP-7 + AP-02 IP-16)
-- -----------------------------------------------------------------------------
-- Ein DRITTER Kundenbereich neben den beiden Demo-Mandanten, abgeschrieben aus
-- `docs/contracts/v2/uems-referenzunternehmen.json` (Fassung 1.4). Diese Datei
-- ERFINDET NICHTS: jede Zahl, jedes Kurzzeichen und jeder Tag steht dort.
-- `DevSeedGuardTest` vergleicht den eingelaufenen Seed mit der Referenzdatei,
-- damit beide nicht auseinanderlaufen.
--
-- WARUM HIER und nicht in `db/dev` oder `infra/local/timescale`:
--   * `db/dev` ist die Flyway-Kette des `local`-Profils — sie liegt in JEDEM
--     Testlauf unter den 100 Testklassen mit `@ActiveProfiles("local")`. Ein
--     dritter Mandant dort änderte still die Ausgangslage jeder dieser Klassen.
--     Der Bestandsschutz verlangt das Gegenteil: die Demo-Mandanten bleiben,
--     wie sie sind. (Auftrag: der Seed darf in KEINE Flyway-Migration geraten.)
--   * `infra/local/timescale/` läuft als `docker-entrypoint-initdb.d` VOR
--     Flyway. Die UEMS-Tabellen (`unternehmen`, `standort`, `ort`, …) gibt es
--     dort noch gar nicht.
-- Deshalb: ein eigenständiges, additives Skript, eingespielt vom Ein-Weg-Dienst
-- `demo-seed` in `docker-compose.yml` (siehe dort) — ohne `down -v`.
--
-- IDEMPOTENT: jede Zeile trägt ihre feste ID und `ON CONFLICT (id) DO NOTHING`.
-- Ein zweiter Lauf ändert nichts und scheitert nicht. Die AFTER-Trigger für die
-- Kurzzeichen-Belegung feuern dabei nicht, weil keine Zeile geschrieben wird.
--
-- STICHTAG 20.10.2026 10:15 (`unternehmen.momentaufnahme` der Referenz,
-- „Dienstag, 20.10.2026, 10:15 Uhr“). Er gilt NUR für die zustandslosen Zeilen
-- (`site`, `device`): an diesem Tag sind genau DREI Boxen in Betrieb — E-1,
-- E-2 und E-3. Die Nachfolgerin E-2′ geht laut Referenz erst am 04.11.2026 um
-- 09:38 in Betrieb, wenn E-2 ausgebaut wird; sie steht deshalb nicht hier.
-- Die ZEITGÜLTIGEN Tabellen (`ort_zuordnung`, `flaeche_gueltigkeit`,
-- `anlage_standort`) tragen dagegen den GANZEN Verlauf der Referenz, auch den
-- künftigen — die Flächenänderung von G-2 zum 01.01.2027 ist Prüfdatum, kein
-- Zustand.
--
-- NICHT enthalten, weil die Referenz sie nicht trägt bzw. nicht ohne Deutung
-- abschreibbar sind — siehe PR-Text:
--   * Standort ST-3 „Werk Ahrenberg Nord“: die Referenz lässt ihn AUSDRÜCKLICH
--     weg (`_herkunft.bewusst_ausgelassen`: „AP-00 §4.4 führt das Referenz-
--     unternehmen mit ZWEI Standorten“).
--   * Archivierung von B-5: die Referenz kennt keinen archivierten Bereich.
--   * Messstellen, Datenquellen, Geräte, Komponenten, Netzanschlüsse,
--     Kostenstellen, Prozesse, Personen: folgen.
-- =============================================================================

BEGIN;

-- ---- Kundenbereich ---------------------------------------------------------
INSERT INTO tenant (id, name, segment) VALUES
    ('20000000-0000-0000-0000-000000000001', 'Kunststoffwerk Ahrenberg GmbH', 'CI')
ON CONFLICT (id) DO NOTHING;

-- ---- Unternehmen (die Wurzel des Ortsbaums) --------------------------------
-- Sitz ohne PLZ: die Referenz lässt `sitz.plz` leer (null).
INSERT INTO unternehmen (id, tenant_id, name, kurzname, zeitzone,
                         sitz_strasse, sitz_plz, sitz_ort, sitz_land, rechtsform,
                         created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001',
     'Kunststoffwerk Ahrenberg GmbH', 'Ahrenberg', 'Europe/Berlin',
     'Gewerbering 7', NULL, 'Ahrenberg', 'DE', 'GmbH',
     TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Standorte ST-1, ST-2 --------------------------------------------------
-- `created_at` = „aktiv seit“ der Referenz. ST-1 besteht seit der
-- Bestandsanlage AN-1 (12.03.2024), eingetragen erst bei der Einführung am
-- 01.10.2026 — darum trägt seine Zuordnung unten den frühen Tag.
INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen,
                      strasse, plz, ort, land, zeitzone, nutzung, notiz,
                      lage_breitengrad, lage_laengengrad, zustand, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000010', 'Werk Ahrenberg', 'ST-1',
     'Gewerbering 7', NULL, 'Ahrenberg', 'DE', 'Europe/Berlin',
     ARRAY['produktion', 'buero']::TEXT[], 'Zwei Netzanschlüsse (NA-1, NA-2)',
     48.250000, 11.430000, 'aktiv', TIMESTAMPTZ '2024-03-12 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000010', 'Werk Lindach', 'ST-2',
     'Am Bahndamm 12', NULL, 'Lindach', 'DE', 'Europe/Berlin',
     ARRAY['lager', 'logistik', 'montage']::TEXT[], NULL,
     NULL, NULL, 'aktiv', TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Gebäude G-1 … G-5 -----------------------------------------------------
INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, nutzung, baujahr, notiz,
                 zustand, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-000000000001',
     'gebaeude', 'Halle 1', 'G-1', ARRAY['produktion']::TEXT[], 1998, NULL,
     'aktiv', TIMESTAMPTZ '2024-03-12 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000102', '20000000-0000-0000-0000-000000000001',
     'gebaeude', 'Halle 2', 'G-2', ARRAY['produktion', 'montage', 'lager']::TEXT[], 2019, NULL,
     'aktiv', TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000103', '20000000-0000-0000-0000-000000000001',
     'gebaeude', 'Verwaltung', 'G-3', ARRAY['buero']::TEXT[], 2004, NULL,
     'aktiv', TIMESTAMPTZ '2024-03-12 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000104', '20000000-0000-0000-0000-000000000001',
     'gebaeude', 'Lagerhalle Lindach', 'G-4', ARRAY['lager', 'logistik']::TEXT[], 2011, NULL,
     'aktiv', TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000105', '20000000-0000-0000-0000-000000000001',
     'gebaeude', 'Montagehalle Lindach', 'G-5', ARRAY['montage']::TEXT[], 2011, NULL,
     'aktiv', TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Bereiche B-1 … B-7 (Notiz = `beschreibung` der Referenz) ---------------
INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, nutzung, baujahr, notiz,
                 zustand, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Halle 1 Nord', 'B-1', ARRAY['produktion']::TEXT[], NULL,
     'Maschinenreihe SG01–SG06', 'aktiv', TIMESTAMPTZ '2024-03-12 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000202', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Halle 1 Süd', 'B-2', ARRAY['technik']::TEXT[], NULL,
     'Technikraum: Druckluft, Kühlung, Box', 'aktiv', TIMESTAMPTZ '2024-03-12 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000203', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Halle 2 Montage', 'B-3', ARRAY['montage']::TEXT[], NULL,
     'Montagelinie M1', 'aktiv', TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000204', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Halle 2 Spritzguss', 'B-4', ARRAY['produktion']::TEXT[], NULL,
     'Maschinenreihe SG07–SG10', 'aktiv', TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000205', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Halle 2 Lager', 'B-5', ARRAY['lager']::TEXT[], NULL,
     'Lager + Allgemeinstrom', 'aktiv', TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000206', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Lager Lindach', 'B-6', ARRAY['lager', 'logistik']::TEXT[], NULL,
     'Tore, Förderer, Beleuchtung', 'aktiv', TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000207', '20000000-0000-0000-0000-000000000001',
     'bereich', 'Montage Lindach', 'B-7', ARRAY['montage']::TEXT[], NULL,
     'Montagelinie M2', 'aktiv', TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Ortsbaum: „gültig ab“ je Ort (Referenz `zuordnungen`, art=ort_eltern) --
-- G-1, G-3, B-1 und B-2 sind Orte der Bestandsanlage AN-1: sie gelten
-- rückwirkend ab dem Beginn des Verlaufs (12.03.2024), damit MS-03 … MS-08 nie
-- an einem Ort hängen, den es noch nicht gibt.
INSERT INTO ort_zuordnung (id, tenant_id, ort_id, eltern_standort_id, eltern_ort_id,
                           gueltig_ab, gueltig_bis, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000301', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-0000000000a1', NULL,
     DATE '2024-03-12', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000302', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000102', '20000000-0000-0000-0000-0000000000a1', NULL,
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000303', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000103', '20000000-0000-0000-0000-0000000000a1', NULL,
     DATE '2024-03-12', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000304', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000104', '20000000-0000-0000-0000-0000000000a2', NULL,
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000305', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000105', '20000000-0000-0000-0000-0000000000a2', NULL,
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000311', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000201', NULL, '20000000-0000-0000-0000-000000000101',
     DATE '2024-03-12', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000312', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000202', NULL, '20000000-0000-0000-0000-000000000101',
     DATE '2024-03-12', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000313', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000203', NULL, '20000000-0000-0000-0000-000000000102',
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000314', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000204', NULL, '20000000-0000-0000-0000-000000000102',
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000315', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000205', NULL, '20000000-0000-0000-0000-000000000102',
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000316', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000206', NULL, '20000000-0000-0000-0000-000000000104',
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000317', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000207', NULL, '20000000-0000-0000-0000-000000000105',
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Bezugsflächen (Referenz `bezugsflaechen`) ------------------------------
-- Werk Lindach (ST-2) hat AUSDRÜCKLICH keine eigene Bezugsfläche: die 2 600 m²
-- sind die Summe seiner Gebäude (1 800 + 800) und entstehen im Leseweg.
-- G-2 wechselt zum 01.01.2027 von 3 100 auf 3 400 m² (Anbau), eingetragen am
-- 15.01.2027 — die 14 Tage davor gelten nachträglich anders („rückwirkend“).
INSERT INTO flaeche_gueltigkeit (id, tenant_id, standort_id, ort_id, m2,
                                 gueltig_ab, gueltig_bis, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000000a1', NULL, 8450,
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000411', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000101', 4200,
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000412', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000102', 3100,
     DATE '2026-10-01', DATE '2026-12-31', TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000413', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000102', 3400,
     DATE '2027-01-01', NULL, TIMESTAMPTZ '2027-01-15 00:00:00+01', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000414', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000103', 1150,
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000415', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000104', 1800,
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000416', '20000000-0000-0000-0000-000000000001',
     NULL, '20000000-0000-0000-0000-000000000105', 800,
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Anlagen AN-1 … AN-3 ---------------------------------------------------
-- `created_at` = „seit“ der Referenz; die Bestandsübernahme liest genau diese
-- Spalte. `bidding_zone` und `plant_kind` bleiben auf ihrer Vorgabe: die
-- Referenz nennt für die Anlage weder Gebotszone noch Anlagenart, und der Seed
-- erfindet nichts. PV 240 kWp und Speicher 200 kWh/100 kW von AN-1 hängen an
-- den Komponenten K-1 …; die folgen.
INSERT INTO site (id, tenant_id, name, created_at) VALUES
    ('20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000001',
     'Werk Ahrenberg – Halle 1', TIMESTAMPTZ '2024-03-12 00:00:00+01'),
    ('20000000-0000-0000-0000-000000000502', '20000000-0000-0000-0000-000000000001',
     'Werk Ahrenberg – Halle 2', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000503', '20000000-0000-0000-0000-000000000001',
     'Werk Lindach', TIMESTAMPTZ '2026-10-15 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

-- ---- Anlage → Standort (Referenz `zuordnungen`, art=anlage_standort) --------
INSERT INTO anlage_standort (id, tenant_id, site_id, standort_id,
                             gueltig_ab, gueltig_bis, created_at, created_by) VALUES
    ('20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-0000000000a1',
     DATE '2024-03-12', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000602', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000502', '20000000-0000-0000-0000-0000000000a1',
     DATE '2026-10-01', NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', 'demo-seed'),
    ('20000000-0000-0000-0000-000000000603', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000503', '20000000-0000-0000-0000-0000000000a2',
     DATE '2026-10-15', NULL, TIMESTAMPTZ '2026-10-15 00:00:00+02', 'demo-seed')
ON CONFLICT (id) DO NOTHING;

-- ---- Boxen E-1, E-2, E-3 zum Stichtag 20.10.2026 ---------------------------
-- `external_ref` = Seriennummer der Referenz. `kind` bleibt auf der Vorgabe der
-- Spalte, wie bei jeder über den Claim-Weg angelegten Box (`device.kind` ist
-- ein Altbestandsetikett; kein Leser verzweigt darauf).
INSERT INTO device (id, tenant_id, site_id, external_ref, status, created_at) VALUES
    ('20000000-0000-0000-0000-000000000701', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000501', 'VP-BOX-2024-0117', 'claimed',
     TIMESTAMPTZ '2024-03-12 00:00:00+01'),
    ('20000000-0000-0000-0000-000000000702', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000502', 'VP-BOX-2026-0482', 'claimed',
     TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000703', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000503', 'VP-BOX-2026-0503', 'claimed',
     TIMESTAMPTZ '2026-10-15 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

COMMIT;
