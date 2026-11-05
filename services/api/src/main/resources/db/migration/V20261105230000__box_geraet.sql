-- Geräte & Updates G8: auf welchem Gerät eine Box läuft (update.geraet,
-- Vertrag docs/contracts/v2/box-geraet.md).
--
-- geraet_modell: die Angabe des Geräts (OpenWrt sysinfo, Device-Tree, die
--   Model-Zeile des Pi, DMI), nie geraten; NULL = nicht gemeldet.
-- geraet_arch:   runtime.GOARCH des laufenden Programms (amd64, arm64, mipsle …).
-- loader:        nur Edge Light - 'update' (der Loader kennt das Update-
--   Protokoll, Stufe 2) oder 'flash' (startet immer die Fassung aus dem Flash,
--   Stufe 1). Damit muss die Cloud die Stufe nicht mehr aus dem Vertrauens-Set
--   raten.
--
-- Geschrieben nur, wenn ein Herzschlag den Block trägt (UpdateStatusRepository
-- .geraet); fehlt er (ältere Box, Sofort-Bericht), bleibt die zuletzt gemeldete
-- Angabe stehen - das Gerät wechselt nicht mit jedem Herzschlag. Tabelle,
-- Rechte und RLS bestehen seit V20260803010000.
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS geraet_modell TEXT;
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS geraet_arch TEXT;
ALTER TABLE device_update_status ADD COLUMN IF NOT EXISTS loader TEXT;
