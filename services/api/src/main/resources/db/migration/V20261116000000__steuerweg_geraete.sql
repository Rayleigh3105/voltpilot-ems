-- =============================================================================
-- V20261116000000 - Steuerlogik Stufe 6, Zusammenführen, dritter Teil: Steuerarten
-- und Heizstab-Regler am Schalter der Anlage.
-- -----------------------------------------------------------------------------
-- Die Verbraucherregel einer Steuerart (der generierte Flow, origin
-- consumer-policy) und der Heizstab-Regler der Box (Parameterblock heizstab im
-- Registry-Push) laufen als Logik des Kerns, nach demselben Schalter je Anlage
-- wie die Regeln (docs/contracts/v2/steuerlogik.md). Ihre Übersetzung ist eine
-- abgeleitete Logik mit herkunft 'steuerart' oder 'heizstab'.
--
-- Keine Anlage wechselt still: die Gruppe der Geräte hat ihren eigenen Stand
-- am Schalter (geraete_modus), ab Werk 'alt' - auch an einer Anlage, deren
-- Regeln schon im Kern laufen, und auf Edge Light (dort gibt es für beide den
-- alten Weg). Ein Schritt am Schalter bewegt jede Gruppe, die ihn gehen kann.
--
-- herkunft_stand hält fest, woraus eine Übersetzung entstand (der generierte
-- Flow und seine Fassung, der Block und die Stufen des Heizstabs); stimmt er
-- nicht mehr, übersetzt die API neu, sonst bleibt der alte Weg.
-- herkunft_geraet ist das Gerät, dessen alten Weg die Übersetzung ersetzt.
-- =============================================================================

ALTER TABLE steuerweg ADD COLUMN IF NOT EXISTS geraete_modus TEXT NOT NULL DEFAULT 'alt';
ALTER TABLE steuerweg DROP CONSTRAINT IF EXISTS steuerweg_geraete_modus_check;
ALTER TABLE steuerweg ADD CONSTRAINT steuerweg_geraete_modus_check
    CHECK (geraete_modus IN ('alt', 'mitlauf', 'kern'));
ALTER TABLE steuerweg ADD COLUMN IF NOT EXISTS geraete_seit TIMESTAMPTZ;

ALTER TABLE steuerlogik DROP CONSTRAINT IF EXISTS steuerlogik_herkunft_check;
ALTER TABLE steuerlogik ADD CONSTRAINT steuerlogik_herkunft_check
    CHECK (herkunft IS NULL OR herkunft IN ('regel', 'steuerart', 'heizstab'));
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS herkunft_stand TEXT;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS herkunft_geraet UUID;
