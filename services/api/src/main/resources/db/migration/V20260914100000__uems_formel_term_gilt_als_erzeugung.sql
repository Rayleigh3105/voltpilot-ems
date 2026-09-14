-- =============================================================================
-- UEMS AP-10 / AP-08: der per-Term-Haken „gilt als Erzeugung" am Formel-Term
-- (messstelle_formel_term, V20260912093000). Additiv, rein additiv: eine neue
-- Spalte mit Default FALSE — jeder Bestandsterm verhaelt sich unveraendert.
--
-- WOZU. Ein Messkanal OHNE Vertrags-Richtung (der Katalog gibt keine — z. B. der
-- Deye Gen-Port `generator-power`, direction: null) ist nach dem Formel-Vertrag
-- KEIN Term (docs/contracts/v2/messstelle-formel.md §2 „ohne Vertrags-Richtung …
-- wartet auf AP-08"). Genau diese reservierte AP-08-Stelle loest der Haken ein:
-- der Kunde bestaetigt „an diesem richtungslosen Kanal haengt Erzeugung"
-- (Mikrowechselrichter am Gen-Port), dann DARF er Term werden und zaehlt in der
-- Richtungs-Ableitung der Summe als `Erzeugung` — so bleibt „PV1+PV2+PV3+Gen-Port"
-- eine Summe aus lauter Erzeugungs-Termen (Richtung `Erzeugung`) statt zu
-- `richtungslos` zu degradieren.
--
-- ⚠ NUR fuer einen richtungslosen Kanal. Der Dienst (MessstelleFormelService,
-- Regeln in MessstelleFormelRegeln, Zwilling frontend/portal/src/
-- uemsMessstelleFormel.ts) weist den Haken auf einem Kanal MIT Katalog-Richtung
-- ab — ein wirkungsloser Schalter waere unehrlich. Die DB traegt hier nur das
-- Flag; die Richtungs-Kopplung ist eine Regel der Zwillinge, nicht der Spalte.
-- =============================================================================

ALTER TABLE messstelle_formel_term
    ADD COLUMN IF NOT EXISTS gilt_als_erzeugung BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN messstelle_formel_term.gilt_als_erzeugung IS
    'AP-08-Haken: ein richtungsloser Messkanal (Katalog ohne Richtung) zaehlt mit '
    'gesetztem Haken als Erzeugung. Nur an einem richtungslosen Kanal zulaessig '
    '(vom Dienst geprueft). Vertrag docs/contracts/v2/messstelle-formel.md §2/§1.1.';
