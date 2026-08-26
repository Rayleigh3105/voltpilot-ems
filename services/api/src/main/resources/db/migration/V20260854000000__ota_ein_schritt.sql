-- Edge-Release in EINEM Schritt: „Release wählen, Geräte wählen, fertig"
-- (Captain-Order 26.08.2026).
--
-- Diese Migration räumt weg, was zu den entfallenen TOREN gehörte. Das
-- Leitprinzip des ganzen Umbaus: **jedes Tor über den Zustand eines GERÄTS
-- fällt, jede Eigenschaft des signierten RELEASE bleibt.** Übrig bleibt genau
-- das Modell, das die Order beschreibt - ein Release, eine Menge Geräte, und
-- ein Fortschritts-Journal darüber.
--
-- Was entfällt und warum:
--
--   * WELLEN (`rollout.waves`, `rollout.current_wave`, `rollout_device.wave`)
--     samt dem Bake-Kriterium (24 h gesund + Steuerzyklus, D4). Sie waren die
--     Antwort auf „ein autonomes Update könnte eine Flotte reißen" - mit einem
--     Selbsttest und einer LKG-Rücknahme je Gerät ist der Ring nicht mehr die
--     Sicherung, sondern nur noch ein Wartezimmer.
--   * `rollout.auto_advance` - ohne Wellen gegenstandslos.
--   * `rollout.channel` / `device_update_target.channel` - ohne Canary-Ring
--     bedeutungslos. Was WIRKLICH läuft, bezeugt der gemeldete Ist.
--   * `device_update_target.pinned` - ein Gerät „festnageln" war ein Tor, das
--     ein Release verhindern konnte.
--   * `device_apply_request` - die Einmal-Freigabe „Auf Gerät anwenden". Sie
--     existierte NUR, weil die Box per Vorgabe nicht anwenden durfte; jetzt
--     wendet sie ein zugewiesenes, selbst verifiziertes Release von sich aus an.
--
-- Was BLEIBT: `rollout` + `rollout_device` + `rollout_event` als
-- Fortschritts- und Audit-Modell (die Papier-Spur ist der zweite Beleg neben
-- dem signierten Tag), `device_update_target` als der Soll-Stand je Gerät, und
-- `edge_release` mit Manifest + Signatur - die Signaturkette ist unberührt.

ALTER TABLE rollout DROP COLUMN IF EXISTS auto_advance;
ALTER TABLE rollout DROP COLUMN IF EXISTS waves;
ALTER TABLE rollout DROP COLUMN IF EXISTS current_wave;
ALTER TABLE rollout DROP COLUMN IF EXISTS channel;

-- Der Zustand kennt nur noch „läuft" und „fertig": Pause und Not-Aus waren die
-- Bedienelemente einer WELLEN-Verteilung. Bestandszeilen werden dorthin
-- überführt, statt eine tote Wort-Menge zu behalten.
UPDATE rollout SET state = 'done' WHERE state IN ('paused', 'halted');
ALTER TABLE rollout DROP CONSTRAINT IF EXISTS rollout_state_check;
ALTER TABLE rollout ADD CONSTRAINT rollout_state_check
    CHECK (state IN ('active', 'done'));
-- Der Grund eines Not-Aus - ohne Not-Aus gegenstandslos.
ALTER TABLE rollout DROP COLUMN IF EXISTS halted_reason;

-- Mehrere Verteilungen dürfen nebeneinander laufen: der Admin soll jederzeit
-- ein Release auf beliebige Geräte schieben können, ohne erst eine frühere
-- Verteilung abzuschließen. Die Eindeutigkeit je GERÄT trägt weiterhin der
-- Primärschlüssel von device_update_target.
DROP INDEX IF EXISTS uq_rollout_one_live;

DROP INDEX IF EXISTS idx_rollout_device_rollout;
ALTER TABLE rollout_device DROP COLUMN IF EXISTS wave;
CREATE INDEX IF NOT EXISTS idx_rollout_device_rollout
    ON rollout_device (rollout_id);

ALTER TABLE device_update_target DROP COLUMN IF EXISTS pinned;
ALTER TABLE device_update_target DROP COLUMN IF EXISTS channel;

DROP TABLE IF EXISTS device_apply_request;

-- `can_apply` war die vom Gerät gemeldete FÄHIGKEIT, eine Portal-Freigabe
-- aufzugreifen. Mit der Freigabe selbst ist sie gegenstandslos: ein Gerät
-- wendet ein zugewiesenes, selbst verifiziertes Release von sich aus an.
ALTER TABLE device_update_status DROP COLUMN IF EXISTS can_apply;
-- Der vom Gerät gemeldete Kanal (canary/stable) - ohne Canary-Ring
-- bedeutungslos, und der Umschlag trägt ihn seit dem Umbau gar nicht mehr.
ALTER TABLE device_update_status DROP COLUMN IF EXISTS channel;
