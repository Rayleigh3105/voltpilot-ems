-- AP-05 Folgepaket „WAGO-Soll speichern“ (23.09.2026, nach Entscheid firstmate B der
-- Registerbild-Verdrahtung): das Soll je WAGO-Registerbild, das die Box nur prüfen kann,
-- wenn die Cloud es kennt.
--
-- `geraet.controller_kennung` (UInt32 des Kopfes, Vertrag wago-registerbild.md §3) und
-- `geraet_teil.variante` (UInt16 des Karten-Blocks, §4). Beide kommen AUSSCHLIESSLICH aus
-- einer Lesung der Steuerung (`POST /api/v1/geraete/{id}/wago/soll-lesen`), nie aus einer
-- Eingabe. NULL = noch nicht gelesen = die Box prüft das Feld nicht (x-registerbilder-rule);
-- nie eine 0, kein Backfill, keine Bestandszeile ändert sich.
--
-- Eine neue Karte (Kartenwechsel) und ein neuer Einbau (Gerätewechsel) beginnen ohne Soll:
-- die INSERTs der beiden Wege nennen ihre Spalten, die neuen bleiben NULL.
ALTER TABLE geraet ADD COLUMN IF NOT EXISTS controller_kennung BIGINT;
ALTER TABLE geraet_teil ADD COLUMN IF NOT EXISTS variante INTEGER;

ALTER TABLE geraet DROP CONSTRAINT IF EXISTS geraet_controller_kennung_chk;
ALTER TABLE geraet ADD CONSTRAINT geraet_controller_kennung_chk
    CHECK (controller_kennung IS NULL OR controller_kennung BETWEEN 0 AND 4294967295);
ALTER TABLE geraet_teil DROP CONSTRAINT IF EXISTS geraet_teil_variante_chk;
ALTER TABLE geraet_teil ADD CONSTRAINT geraet_teil_variante_chk
    CHECK (variante IS NULL OR variante BETWEEN 0 AND 65535);

-- Nur die Soll-Lesung schreibt; die Spalten erben RLS und Standortzaun ihrer Tabellen.
GRANT UPDATE (controller_kennung) ON geraet TO ${appDbUser};
GRANT UPDATE (variante) ON geraet_teil TO ${appDbUser};

-- Das Journal am Einbau: gelesenes Soll übernommen / Lesung weicht vom gespeicherten Soll ab
-- (nichts überschrieben). Vereinigung mit dem Stand von V20260922245000.
ALTER TABLE geraet_aenderung DROP CONSTRAINT IF EXISTS geraet_aenderung_art_chk;
ALTER TABLE geraet_aenderung ADD CONSTRAINT geraet_aenderung_art_chk
    CHECK (art IN ('messmittel_angabe', 'wago_soll_gelesen', 'wago_soll_abweichung'));
