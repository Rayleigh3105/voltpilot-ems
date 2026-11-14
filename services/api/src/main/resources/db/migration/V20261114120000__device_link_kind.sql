-- Konzept vp-edge-light-wlan (E1=B, Scheibe S5): wie die Box gerade zum
-- Kundenrouter kommt - "kabel" oder "wlan" - und bei WLAN das Signal, das
-- Edge Light selbst gemessen hat. Additiv auf `device`, wie `lan_host` /
-- `lan_seen_at` / `lan_source` (V20260832000000): ein Betriebsfakt genau
-- EINES Geräts, der je Herzschlag ersetzt wird und keinen Verlauf braucht.
--
-- NULL heißt immer "die Box meldet es (noch) nicht" - NIE "keine Verbindung".
-- Nur Edge Light sendet dieses Feld überhaupt; eine Docker-Box kennt die
-- Frage nicht.
--
-- `link_weak_since` ist der eine abgeleitete Zustand, den das Portal braucht,
-- um "schon LÄNGER schwach" von einem einzelnen schwachen Herzschlag zu
-- unterscheiden (Bericht vp-edge-light-wlan-konzept, Abschnitt 0.1,
-- Bildschirm "Empfang reicht nicht"): wann das Signal zuletzt UNUNTERBROCHEN
-- unter die Schwelle fiel. Die Schwelle selbst (-70 dBm) steht im Code
-- (DeviceRepository, Portal `boxVerbindung.ts`), nicht hier.
ALTER TABLE device ADD COLUMN IF NOT EXISTS link_kind TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS signal_dbm INTEGER;
ALTER TABLE device ADD COLUMN IF NOT EXISTS link_seen_at TIMESTAMPTZ;
ALTER TABLE device ADD COLUMN IF NOT EXISTS link_weak_since TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'device_link_kind_check'
    ) THEN
        ALTER TABLE device ADD CONSTRAINT device_link_kind_check
            CHECK (link_kind IS NULL OR link_kind IN ('kabel', 'wlan'));
    END IF;
END $$;

-- Ein Signal ohne WLAN waere eine erfundene Aussage - die Box selbst sendet
-- signal_dbm laut Vertrag nur zusammen mit link_kind='wlan' (siehe
-- UpdateStatusListener), aber die Spalte bleibt auch gegen einen fehlerhaften
-- Aufrufer geschuetzt.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'device_signal_needs_wlan_check'
    ) THEN
        ALTER TABLE device ADD CONSTRAINT device_signal_needs_wlan_check
            CHECK (signal_dbm IS NULL OR link_kind = 'wlan');
    END IF;
END $$;
