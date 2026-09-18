-- =============================================================================
-- DEV-ONLY Demo-Daten: Kunststoffwerk Ahrenberg GmbH
-- (AP-00 IP-7 + AP-02 IP-16 · AP-03 IP-16 Personen · AP-01 IP-14 Funktionszustände)
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
--   * Sabine Rauch: die Referenz streicht sie zusammen mit ST-3 (siehe
--     unten bei den Personen). Die Zelle AP-03 IP-16 nennt acht Logins,
--     gebaut sind die sieben der Referenz.
--   * Messstellen, Datenquellen, Geräte, Komponenten, Netzanschlüsse,
--     Kostenstellen, Prozesse: folgen.
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

-- ---- Personen (AP-03 IP-16) ------------------------------------------------
-- Der Spiegel der SIEBEN Konten, die die Referenz unter `personen` führt. Fünf
-- Kundenkonten des Kundenbereichs, ein Partner-Konto (Installateur) und ein
-- Plattform-Konto (VoltPilot-Support); die beiden letzten haben im Realm keinen
-- Kundenbereich und bekommen ihren Spiegel hier, weil ihnen dieser
-- Kundenbereich eine Unterstützung gewährt.
--
-- `sub` ist das Subject des Logins — dieselbe Kennung trägt der Realm-Eintrag
-- als `id` (infra/local/keycloak/voltpilot-realm.json). Ohne diese feste
-- Kennung vergäbe Keycloak beim Import eine zufällige, und kein Spiegel fände
-- sein Konto wieder.
--
-- `email` ist die Adresse des lokalen Logins, nicht aus der Referenz: die kennt
-- keine Adressen. Alles andere steht dort — Name, Rolle, Geltungsbereich, Tag.
--
-- NICHT enthalten: Sabine Rauch. Die Referenz streicht sie AUSDRÜCKLICH
-- zusammen mit ihrem Standort ST-3 („_herkunft.bewusst_ausgelassen": AP-00 §4.4
-- führt das Referenzunternehmen mit ZWEI Standorten). Die Zelle AP-03 IP-16
-- nennt acht Logins, die einzige Quelle trägt sieben — der Seed folgt der
-- Quelle. Was Sabine zeigen sollte, zeigen andere: eine Zuweisung, die am
-- Stichtag noch in der Zukunft liegt, und eine Unterstützung mit Ende (beides
-- unten bei Voss und Brunner).
INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand,
                      angenommen_am, created_at) VALUES
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008a1',
     'benutzer', 'Jonas Wendlinger', 'jonas@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2024-03-12 00:00:00+01', TIMESTAMPTZ '2024-03-12 00:00:00+01'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008a2',
     'benutzer', 'Ines Kaltenbach', 'ines@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-10-01 00:00:00+02', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008a3',
     'benutzer', 'Peter Hollerbach', 'peter@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-10-15 00:00:00+02', TIMESTAMPTZ '2026-10-15 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008a4',
     'benutzer', 'Murat Demirci', 'murat@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-10-01 00:00:00+02', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008a5',
     'benutzer', 'Claudia Berger', 'claudia@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-10-01 00:00:00+02', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008b1',
     'partner', 'Thomas Brunner', 'partner-brunner@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-11-24 09:40:00+01', TIMESTAMPTZ '2026-11-24 09:40:00+01'),
    ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000008b2',
     'plattform', 'Lena Voss', 'support-voss@voltpilot.local', 'aktiv',
     TIMESTAMPTZ '2026-10-21 00:00:00+02', TIMESTAMPTZ '2026-10-21 00:00:00+02')
ON CONFLICT (tenant_id, sub) DO NOTHING;

-- ---- Zuweisungen (AP-03 IP-16) ---------------------------------------------
-- `gueltig_ab` ist das „seit" der Referenz; `gewaehrt_von` das Subject der
-- gewährenden Person. Jonas trägt NULL: er war bis 30.09.2026 der einzige
-- Benutzer des Kundenbereichs, seine Zuweisung kommt aus der Bestandsübernahme
-- (E12), und ein Bestandskonto hat keine gewährende Person.
--
-- Claudia liest BEIDE Standorte — je Standort eine eigene Zeile, so wie die
-- Tabelle es verlangt; eine Zuweisung gilt nie für zwei Standorte zugleich.
--
-- Die zwei Unterstützungen tragen Art, Umfang und ein Ende. `gueltig_bis` ist
-- der letzte Tag EINSCHLIESSLICH, `endet_am` derselbe Tatbestand als Zeitpunkt
-- (ausschließend) in der Zeitzone des Standorts — der 15.12. endet am
-- 16.12. 00:00 MEZ, der 28.10. am 29.10. 00:00 MEZ (die Sommerzeit endete am
-- 25.10.2026). Beide liegen HINTER dem Stichtag 20.10.2026 10:15: am Stichtag
-- ist Voss' Zuweisung noch künftig und Brunners erst recht.
INSERT INTO zugriff (id, tenant_id, benutzer_sub, rolle, standort_id, art, umfang,
                     gueltig_ab, gueltig_bis, endet_am, zeitzone, gewaehrt_von, created_at) VALUES
    ('20000000-0000-0000-0000-000000000901', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a1', 'kundenadministrator', NULL, NULL, NULL,
     TIMESTAMPTZ '2024-03-12 00:00:00+01', NULL, NULL, 'Europe/Berlin',
     NULL, TIMESTAMPTZ '2024-03-12 00:00:00+01'),
    ('20000000-0000-0000-0000-000000000902', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a2', 'energiemanager', NULL, NULL, NULL,
     TIMESTAMPTZ '2026-10-01 00:00:00+02', NULL, NULL, 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000903', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a3', 'bearbeiter',
     '20000000-0000-0000-0000-0000000000a2', NULL, NULL,
     TIMESTAMPTZ '2026-10-15 00:00:00+02', NULL, NULL, 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-15 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000904', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a4', 'bedienberechtigt',
     '20000000-0000-0000-0000-0000000000a1', NULL, NULL,
     TIMESTAMPTZ '2026-10-01 00:00:00+02', NULL, NULL, 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000905', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a5', 'leser',
     '20000000-0000-0000-0000-0000000000a1', NULL, NULL,
     TIMESTAMPTZ '2026-10-01 00:00:00+02', NULL, NULL, 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000906', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008a5', 'leser',
     '20000000-0000-0000-0000-0000000000a2', NULL, NULL,
     TIMESTAMPTZ '2026-10-01 00:00:00+02', NULL, NULL, 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-01 00:00:00+02'),
    ('20000000-0000-0000-0000-000000000907', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008b1', 'unterstuetzer',
     '20000000-0000-0000-0000-0000000000a1', 'installateur', 'einrichten_und_bedienen',
     TIMESTAMPTZ '2026-11-24 09:40:00+01', DATE '2026-12-15',
     TIMESTAMPTZ '2026-12-16 00:00:00+01', 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-11-24 09:40:00+01'),
    ('20000000-0000-0000-0000-000000000908', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000008b2', 'unterstuetzer',
     '20000000-0000-0000-0000-0000000000a1', 'voltpilot', 'ansehen',
     TIMESTAMPTZ '2026-10-21 00:00:00+02', DATE '2026-10-28',
     TIMESTAMPTZ '2026-10-29 00:00:00+01', 'Europe/Berlin',
     '20000000-0000-0000-0000-0000000008a1', TIMESTAMPTZ '2026-10-21 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

-- ---- Die Anfrage zur VoltPilot-Unterstützung (Referenz: „angefragt am --------
-- 21.10.2026, am selben Tag gewährt"). Nur VoltPilot fragt an; ein Installateur
-- wird gewährt, nie gefragt — Brunner hat deshalb keine Anfrage.
INSERT INTO unterstuetzung_anfrage (id, tenant_id, art, umfang, angefragt_von, angefragt_name,
                                    angefragt_email, gueltig_ab, gueltig_bis, zeitzone, grund,
                                    entschieden_am, entschieden_von, zugriff_id, created_at) VALUES
    ('20000000-0000-0000-0000-000000000a01', '20000000-0000-0000-0000-000000000001',
     'voltpilot', 'ansehen', '20000000-0000-0000-0000-0000000008b2', 'Lena Voss',
     'support-voss@voltpilot.local', TIMESTAMPTZ '2026-10-21 00:00:00+02', DATE '2026-10-28',
     'Europe/Berlin', 'Speicher-Diagnose',
     TIMESTAMPTZ '2026-10-21 00:00:00+02', '20000000-0000-0000-0000-0000000008a1',
     '20000000-0000-0000-0000-000000000908', TIMESTAMPTZ '2026-10-21 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

INSERT INTO unterstuetzung_anfrage_standort (anfrage_id, tenant_id, standort_id) VALUES
    ('20000000-0000-0000-0000-000000000a01', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000000a1')
ON CONFLICT (anfrage_id, standort_id) DO NOTHING;

-- ---- Funktionszustände (AP-01 IP-14) ---------------------------------------
-- Der Zustand, den der Umstieg „Bestand → Zustand" (AP-01 §4.3, W5, A11) aus
-- den Bestandsfakten der Referenz ABLEITET — hier abgeschrieben, weil der Seed
-- die Bestandsfakten selbst (Komponenten, Freigaben, `site_profile_state`) noch
-- nicht trägt.
--
-- AN-1 „Werk Ahrenberg – Halle 1" ist die einzige Bestandsanlage mit laufender
-- Betriebsweise: Betriebsmodell Lastspitzenkappung seit 02.05.2024
-- (`anlagen[0].betriebsmodell_seit`). Regel: eine laufende Betriebsweise →
-- Teilnahme AKTIV, übernommen, seit der frühesten. Ihr Standort ST-1 trägt den
-- höchsten Zustand seiner Anlagen, also ebenfalls aktiv.
--
-- AN-2 und AN-3 tragen in der Referenz „steuert nicht" und kein Betriebsmodell
-- → keine Teilnahme, kein Objekt. Deshalb hat ST-2 „Werk Lindach" hier gar
-- keine Zeile: kein Objekt ist keine Zeile.
--
-- „Messen & Auswerten" bekommt beim Umstieg KEIN Objekt (A11) — auch dafür
-- steht hier nichts. Seine Einrichtung ist ein eigener Weg.
--
-- `eingerichtet_am` bleibt leer: eine aus dem Bestand übernommene Funktion
-- kennt ihr Einrichtungsdatum nicht (W5).
INSERT INTO funktion (id, tenant_id, standort_id, funktion, zustand,
                      eingerichtet_am, aktiv_seit, angehalten_seit, archiviert_am,
                      geaendert_von, created_at, updated_at) VALUES
    ('20000000-0000-0000-0000-000000000b01', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-0000000000a1', 'steuern', 'aktiv',
     NULL, TIMESTAMPTZ '2024-05-02 00:00:00+02', NULL, NULL,
     'VoltPilot (Bestandsübernahme)',
     TIMESTAMPTZ '2026-10-01 00:00:00+02', TIMESTAMPTZ '2026-10-01 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

INSERT INTO funktion_teilnahme (id, tenant_id, funktion_id, funktion, site_id, zustand,
                                uebernommen, eingerichtet_am, gestartet_am, angehalten_seit,
                                beendet_am, created_at, updated_at) VALUES
    ('20000000-0000-0000-0000-000000000c01', '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000b01', 'steuern',
     '20000000-0000-0000-0000-000000000501', 'aktiv',
     true, NULL, TIMESTAMPTZ '2024-05-02 00:00:00+02', NULL,
     NULL, TIMESTAMPTZ '2026-10-01 00:00:00+02', TIMESTAMPTZ '2026-10-01 00:00:00+02')
ON CONFLICT (id) DO NOTHING;

COMMIT;
