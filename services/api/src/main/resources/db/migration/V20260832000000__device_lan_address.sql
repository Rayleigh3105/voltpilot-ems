-- Anlagen-Zentrale Stufe 2, Captain-Entscheid D5: die Box meldet ihre eigene
-- Erreichbarkeit im Kundennetz - NUR zur Anzeige.
--
-- Die Lücke war belegt und hat zwei Support-Runden gekostet: das Portal zeigt
-- JEDE Geräte-Adresse (die Box speichert sie), aber nicht die eigene, und für
-- den Kunden ist sie der Weg zur lokalen Oberfläche - für den Support die
-- erste Frage am Telefon.
--
-- ⚠ WARUM DREI SPALTEN UND NICHT EINE: die Box kann die Frage auf zwei sehr
-- verschieden starke Arten beantworten, und die zwei dürfen nie unter einem
-- Wort verschwinden.
--   * 'erreicht'      = eine Adresse, unter der ein Browser die lokale
--                       Oberfläche NACHWEISLICH erreicht hat (der HTTP-Host-
--                       Kopf, den Dockers NAT nicht umschreiben kann). Das ist
--                       der stärkste mögliche Beleg - sie hat funktioniert.
--   * 'schnittstelle' = die eigene Netzwerk-Adresse der Box, gemeldet NUR auf
--                       einer Installation ohne Container (im Container ist es
--                       die Bridge-Adresse: wahr über den Container, nutzlos
--                       für den Kunden - und damit eine erfundene Antwort).
-- `lan_seen_at` ist der Frische-Anker DIESER Aussage; sie reist nie ohne ihn.
--
-- Alles nullable ohne Default: NULL heißt „die Box meldet es (noch) nicht" -
-- NIE „sie ist nicht erreichbar". Ein älterer Edge-Stand sendet den Block gar
-- nicht, und daraus darf nur „unbekannt" folgen.
--
-- Es ist ADDITIV auf `device` (wie `data_purged_before`): die Adresse ist ein
-- Betriebsfakt genau EINES Geräts, sie wird je Herzschlag ersetzt und hat
-- keinen Verlauf - eine eigene Tabelle plus Endpunkt wäre Maschinerie für zwei
-- Zeichenketten, die über `GET /devices` ohnehin schon jede Fläche erreichen.
ALTER TABLE device ADD COLUMN IF NOT EXISTS lan_host TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS lan_seen_at TIMESTAMPTZ;
ALTER TABLE device ADD COLUMN IF NOT EXISTS lan_source TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'device_lan_source_check'
    ) THEN
        ALTER TABLE device ADD CONSTRAINT device_lan_source_check
            CHECK (lan_source IS NULL OR lan_source IN ('erreicht', 'schnittstelle'));
    END IF;
END $$;

-- Beides oder keines: eine Adresse ohne Herkunft ließe die Oberfläche raten,
-- wie stark der Beleg ist, und genau diese Unterscheidung ist der Punkt.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'device_lan_complete_check'
    ) THEN
        ALTER TABLE device ADD CONSTRAINT device_lan_complete_check
            CHECK ((lan_host IS NULL AND lan_source IS NULL)
                   OR (lan_host IS NOT NULL AND lan_source IS NOT NULL));
    END IF;
END $$;
