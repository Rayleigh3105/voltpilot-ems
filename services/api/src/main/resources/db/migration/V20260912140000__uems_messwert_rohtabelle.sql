-- UEMS AP-07 IP-6 — die Messwert-Rohtabelle bekommt ihre REIHE je Komponente,
-- ihre HERKUNFTSSPALTEN und einen neuen DOPPEL-ERKENNUNGSSCHLÜSSEL.
--
-- Vertrag: docs/contracts/v2/messwert-herkunft.md (IP-1, PR 654) mit den
-- Vektoren messwert-herkunft-vectors.json. Captain-Entscheide vom 10.09.2026
-- (Konzept vp-uems-ap07-messdaten §5):
--
--   E2 = A  Die REIHE ist Mandant + Komponente + Messkanal. Gerät samt Einbau,
--           lesende Box, Einstellungs-Fassung und Katalogstand sind
--           HERKUNFTSSPALTEN JE WERT, nie Teil des Schlüssels. Die Gerätegrenze
--           ist ein Ereignis (`device_boundary`), keine Schlüsselspalte — ein
--           Zählerwechsel bricht damit keine Reihe.
--   E3 = A  Der Doppel-Erkennungsschlüssel ist REIHE + MESSZEIT; die Sequenz ist
--           Kennzeichen, nicht Schlüssel. Gleiches Paket zweimal = EIN Wert
--           (gezählt, kein Ereignis). Gleiche Messzeit mit ABWEICHENDEM Wert =
--           der erste bleibt, der zweite wird abgewiesen (`duplicate_conflict`).
--
-- STRENG ADDITIV. Es wird keine Zeile gelöscht, kein Wert geändert, kein
-- bestehender Index angetastet und kein Recht verschoben:
--
--   * Der alte Schlüssel `uq_device_measurement_sample_idempotency`
--     (device_id, point_key, time, edge_sequence) BLEIBT STEHEN, bis der Writer
--     umgeschaltet ist (IP-7). Diese Migration schaltet NICHTS um: der Writer
--     schreibt unverändert weiter, seine neuen Spalten bleiben leer.
--   * RLS + FORCE, die Mandanten-Policy und die Rechte sind unverändert: diese
--     Migration vergibt kein einziges GRANT. Die bestehenden Rechte sind
--     tabellenweit, die neuen Spalten liegen damit ohne ein weiteres GRANT genau
--     im bisherigen Zaun.
--   * Kein Fremdschlüssel auf `entity_id`/`device_install_id`: die Löschwege
--     der Messreihen gehören IP-11 (`ON DELETE RESTRICT`, Unclaim/Purge). Ein
--     CASCADE-Verweis würde HEUTE einen neuen Löschweg für Kundenmesswerte
--     aufmachen, ein RESTRICT-Verweis das heutige Löschen einer Komponente
--     brechen — beides wäre eine Verhaltensänderung, die dieses Paket nicht hat.
--     Es ist dasselbe Muster wie bei der append-only Papier-Spur
--     `device_measurement_selection_event` (V20260855000000): der Messwert
--     überlebt, worüber er berichtet.
--
-- ⚠ GROSS-MIGRATION (so eingeplant, AP-07 §8): der Nachtrag unten schreibt jede
-- Bestandszeile der Rohtabelle neu — genau EINMAL (Schritt 1 ODER Schritt 3; nur
-- eine doppelte Messzeit wird zweimal angefasst). Laufzeit und vorübergehender
-- Plattenbedarf wachsen deshalb mit den 90 Tagen Rohwerten, die die Tabelle hält.
--
-- NIE GERATEN. Der Bestand bekommt nur, was aus GESPEICHERTEN Fakten folgt:
-- die Komponente, wenn sie aus der Auswahl EINDEUTIG folgt; sonst bleibt die
-- Zeile ohne Komponente und trägt die Rolle `spiegel` (die Spur außerhalb der
-- zuständigen Reihe — sie fließt nie in Verbrauch oder Bilanz). Die übrigen
-- Herkunftsspalten bleiben für den Bestand LEER: `null` heißt „nicht
-- nachgeschlagen", nie ein erfundener Einbau, keine erfundene Fassung und
-- keine aus `aggregation_kind` abgeschriebene Wertart. Nachgeschlagen wird
-- ab IP-7, zur MESSZEIT.

-- -----------------------------------------------------------------------------
-- 1. Die Schlüsselspalte der Reihe und die sechs Herkunftsspalten
-- -----------------------------------------------------------------------------

-- Die Komponente, für die der Kanal gelesen wurde (§4.2 „Komponente", E2). Sie
-- ist die Reihe — nicht die lesende Box (`device_id`, die bleibt als Marker).
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS entity_id UUID;
-- Der Einbau, der zur MESSZEIT galt: eine Zeile `geraet` (AP-04 IP-10) — also
-- Gerät, Seriennummer und Einbauzeitraum in einem Verweis.
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS device_install_id UUID;
-- Die Einstellungs-Fassung, die die Box beim Erfassen ANGEWENDET hat: die Box
-- meldet sie (`applied_revision` je Umschlag, measurement-samples 2.1), eine
-- ältere Box wird aus `applied_at` der Zustellung vervollständigt (IP-7).
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS applied_revision BIGINT;
-- Die Wertart aus Katalog/Vorlage zur Messzeit (E12) — das Wort des Vertrags,
-- nicht die Verdichtungsart `aggregation_kind` daneben (die kennt zusätzlich
-- `event` und `none` und bleibt unberührt).
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS value_kind TEXT;
-- Die Rolle ZUR MESSZEIT (E4): führend · Vergleich · Beobachtung liegen in der
-- zuständigen Spur, `spiegel` außerhalb (§4.7).
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS role TEXT;
-- Die Zustellart und die ungeschönte Verzögerung (Eingangszeit − Messzeit in
-- Sekunden, auch negativ, wenn die Uhr der Box innerhalb der Toleranz vorgeht).
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS delivery TEXT;
ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS delay_s INTEGER;

-- Die geschlossenen Vokabulare des Vertrags (messwert-herkunft-vectors.json
-- → `vokabular`): ein fremdes Wort wird abgewiesen, nie aufgelöst. NULL ist in
-- allen drei Spalten erlaubt und heißt „noch nicht nachgeschlagen" (IP-7).
ALTER TABLE device_measurement_sample DROP CONSTRAINT IF EXISTS device_measurement_sample_value_kind_ck;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_value_kind_ck
    CHECK (value_kind IS NULL OR value_kind IN ('counter', 'gauge', 'state', 'bitfield', 'text'));
ALTER TABLE device_measurement_sample DROP CONSTRAINT IF EXISTS device_measurement_sample_role_ck;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_role_ck
    CHECK (role IS NULL OR role IN ('fuehrend', 'vergleich', 'spiegel', 'beobachtung'));
ALTER TABLE device_measurement_sample DROP CONSTRAINT IF EXISTS device_measurement_sample_delivery_ck;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_delivery_ck
    CHECK (delivery IS NULL OR delivery IN ('direkt', 'nachgeliefert'));
-- Zustellart und Verzögerung sind EINE Angabe (§4.2 „Zustellart"): entweder
-- beide abgeleitet oder beide offen — eine Verzögerung ohne Art wäre eine Zahl
-- ohne Aussage, eine Art ohne Verzögerung eine Aussage ohne Beleg.
ALTER TABLE device_measurement_sample DROP CONSTRAINT IF EXISTS device_measurement_sample_delay_ck;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_delay_ck
    CHECK ((delivery IS NULL) = (delay_s IS NULL));
-- Die angewendete Fassung ist die Fassungs-Nummer der Zustellung (Vertrag 2.1:
-- integer ≥ 0), nie eine negative Zahl.
ALTER TABLE device_measurement_sample DROP CONSTRAINT IF EXISTS device_measurement_sample_applied_revision_ck;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_applied_revision_ck
    CHECK (applied_revision IS NULL OR applied_revision >= 0);

-- -----------------------------------------------------------------------------
-- 2. Der Bestand wird NACHGETRAGEN — nie geraten
-- -----------------------------------------------------------------------------
-- Schritt 1: die Komponente aus der Auswahl, aber nur wo sie EINDEUTIG folgt.
-- Eindeutig heißt: zu (Gerät, Messkanal) steht GENAU EINE Auswahlzeile, und die
-- nennt eine Komponente. Zwei Zeilen (zwei baugleiche Geräte hinter einer Box,
-- Herzogau) oder eine Zeile mit `entity_id IS NULL` (die alte BOX-Semantik von
-- V20260855000000 — „die Auswahl gehört dem Gerät als Ganzem", ausdrücklich
-- nicht „unbekannt") lassen offen, für welche Komponente gelesen wurde. Eine
-- abgewählte Auswahlzeile zählt mit: der Grabstein bleibt stehen und ist der
-- Fakt, der den Punkt damals angefordert hat.
WITH auswahl AS (
    -- `count(*) = 1 AND count(entity_id) = 1` ist die Eindeutigkeit; die eine Zeile
    -- der Gruppe liefert die Komponente (kein max() — Postgres 16 aggregiert UUIDs nicht).
    SELECT tenant_id, device_id, point_key, (array_agg(entity_id))[1] AS komponente
      FROM device_measurement_selection
     GROUP BY tenant_id, device_id, point_key
    HAVING count(*) = 1 AND count(entity_id) = 1)
UPDATE device_measurement_sample s
   SET entity_id = a.komponente
  FROM auswahl a
 WHERE s.tenant_id = a.tenant_id AND s.device_id = a.device_id AND s.point_key = a.point_key
   AND s.entity_id IS NULL AND s.role IS NULL;

-- Schritt 2: E3 auf den Bestand. Der alte Schlüssel ließ zu derselben Messzeit
-- mehrere Zeilen zu, sobald sich die Sequenz unterschied (§2.4 „stille
-- Verdrängung"). Nach Schritt 1 können solche Zeilen in EINER Reihe liegen.
-- E3 sagt, welche die Reihe trägt: DER ERSTE BLEIBT — der zuerst
-- entgegengenommene Wert (`received_at`, der gespeicherte Fakt, nicht geraten).
-- Jeder weitere gibt seine Komponente wieder ab und bleibt als Spiegel stehen.
-- GELÖSCHT WIRD NICHTS: jede Zeile, jeder Wert, jede Sequenz bleibt.
WITH reihe AS (
    SELECT tenant_id, device_id, point_key, time, edge_sequence, role,
           row_number() OVER (PARTITION BY tenant_id, entity_id, point_key, time
                              ORDER BY received_at, device_id, edge_sequence) AS rang
      FROM device_measurement_sample
     WHERE entity_id IS NOT NULL)
UPDATE device_measurement_sample s
   SET entity_id = NULL
  FROM reihe r
 WHERE s.tenant_id = r.tenant_id AND s.device_id = r.device_id AND s.point_key = r.point_key
   AND s.time = r.time AND s.edge_sequence = r.edge_sequence
   AND r.rang > 1 AND r.role IS NULL;

-- Schritt 3: was keine Komponente hat, liegt außerhalb der zuständigen Reihe.
-- `spiegel` ist genau das Wort dafür (§4.7): gespeichert, lesbar, aber nie in
-- Verbrauch, Bilanz, Kennzahl oder Bericht. Kein Spiegel bekommt eine erfundene
-- Komponente, und keine Zeile verschwindet.
UPDATE device_measurement_sample
   SET role = 'spiegel'
 WHERE entity_id IS NULL AND role IS NULL;

-- Was nachgetragen wurde, steht im Log des Laufs — dieselben Zahlen, die der
-- Migrationstest prüft.
DO $$
DECLARE mit_komponente BIGINT; spiegel BIGINT;
BEGIN
    SELECT count(*) FILTER (WHERE entity_id IS NOT NULL),
           count(*) FILTER (WHERE role = 'spiegel')
      INTO mit_komponente, spiegel FROM device_measurement_sample;
    RAISE NOTICE 'UEMS AP-07 IP-6: % Rohwerte eindeutig einer Komponente zugeordnet, '
                 '% bleiben als Spiegel ohne Komponente.', mit_komponente, spiegel;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Der neue Doppel-Erkennungsschlüssel: REIHE + MESSZEIT (E3)
-- -----------------------------------------------------------------------------
-- Er gilt JE SPUR (Vertrag §1/§7.4): die zuständige Spur (führend · Vergleich ·
-- Beobachtung — und `role IS NULL`, solange der Writer noch nicht nachschlägt)
-- trägt ihn, der SPIEGEL liegt ausdrücklich AUSSERHALB. Anders wäre E3 („Reihe +
-- Messzeit") nicht zugleich mit E4 („nie in der führenden Reihe") und mit A9
-- („kein stilles Verdrängen bei identischen Messzeiten") zu halten: ein
-- Spiegelwert derselben Reihe und Messzeit darf den führenden nicht verdrängen
-- und nicht von ihm verdrängt werden — er wird gespeichert, ohne Wiederholung
-- und ohne Konflikt.
--
-- `entity_id IS NOT NULL` steht im Prädikat, weil eine Zeile ohne Komponente
-- keine Reihe hat und deshalb auch keinen Anspruch auf Idempotenz: sie wäre im
-- Index ohnehin nie ein Konflikt (NULL ist verschieden von NULL), läge aber in
-- ihm. So bleibt der Index auf den Werten, die eine Reihe haben.
--
-- Der Writer bleibt unverändert: er schreibt heute ohne `entity_id` und trifft
-- diesen Index damit nie (`ON CONFLICT DO NOTHING` sieht alle Unique-Indexe der
-- Tabelle — und dieser weist keine Zeile ab, die er vorher genommen hätte).
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_sample_reihe
    ON device_measurement_sample (tenant_id, entity_id, point_key, time)
    WHERE entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel';

-- -----------------------------------------------------------------------------
-- 4. Was die Spalten bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN device_measurement_sample.entity_id IS
    'Die Komponente, für die der Kanal gelesen wurde - zusammen mit tenant_id und '
    'point_key die REIHE (AP-07 E2). Sie überlebt Geräte-, Box- und '
    'Zuständigkeitswechsel. NULL = im Bestand nicht eindeutig aus der Auswahl '
    'ableitbar (dann role = spiegel), nie geraten.';
COMMENT ON COLUMN device_measurement_sample.device_install_id IS
    'Der Einbau (geraet.id), der zur MESSZEIT galt - Marker, nie Schlüssel. '
    'Ohne Fremdschlüssel: die Löschwege der Messreihen gehören AP-07 IP-11.';
COMMENT ON COLUMN device_measurement_sample.applied_revision IS
    'Die Einstellungs-Fassung, die die Box beim Erfassen angewendet hat '
    '(measurement-samples 2.1); bei einer älteren Box die zur Messzeit '
    'zugestellte Fassung. NULL = nicht nachgeschlagen (IP-7).';
COMMENT ON COLUMN device_measurement_sample.value_kind IS
    'Die Wertart aus Katalog/Vorlage zur Messzeit: counter, gauge, state, '
    'bitfield, text (AP-07 E12). NICHT aus aggregation_kind abgeschrieben.';
COMMENT ON COLUMN device_measurement_sample.role IS
    'Die Rolle zur Messzeit: fuehrend, vergleich, beobachtung (zuständige Spur) '
    'oder spiegel (außerhalb, fließt nie in Verbrauch/Bilanz). NULL = noch nicht '
    'nachgeschlagen (IP-7).';
COMMENT ON COLUMN device_measurement_sample.delivery IS
    'Zustellart: direkt oder nachgeliefert (Eingang später als max(300 s, '
    '3 x Kadenz) nach der Messzeit). Ein nachgelieferter Wert ist ein GEMESSENER '
    'Wert, keine Auffüllung.';
COMMENT ON COLUMN device_measurement_sample.delay_s IS
    'Eingangszeit minus Messzeit in Sekunden, ungeschönt - auch negativ, wenn '
    'die Uhr der Box innerhalb der Toleranz vorgeht.';
COMMENT ON INDEX uq_device_measurement_sample_reihe IS
    'AP-07 E3: Doppel-Erkennung über Reihe + Messzeit, JE SPUR - der Spiegel '
    'liegt außerhalb. Der alte Schlüssel uq_device_measurement_sample_idempotency '
    'bleibt bis zur Umschaltung des Writers (AP-07 IP-7) daneben stehen.';
