-- =============================================================================
-- V20260804000000 - Signatur-Felder am Release-Register (OTA Stufe 1
-- „Vertrauen", Scout vp-ota-rollout-h4 §5/§8, Captain-Entscheid D3). ADDITIV -
-- genau das reine ALTER TABLE ADD COLUMN, das V20260803020000 angekündigt hat.
-- -----------------------------------------------------------------------------
-- WOFÜR: Stufe 0 hat die ORDNUNG geschaffen (release_seq), aber ein Eintrag
-- konnte nicht sagen, ob das Release überhaupt SIGNIERT ist - und Stufe 2 hätte
-- nichts, was sie einem Gerät hinlegen könnte. Beides steckt in genau drei
-- Feldern:
--
--   manifest        die EXAKTEN Bytes des signierten release.json,
--                   unverändert, so wie sie signiert wurden.
--   signature       die abgetrennte Signaturdatei (release.json.sig) daneben.
--   signing_key_id  welcher Release-Schlüssel unterschrieben hat - für die
--                   Oberfläche („signiert (rel-2026-a)") ohne JSON-Parserei.
--
-- ⚠ manifest IST BEWUSST `text`, NIEMALS `json`/`jsonb`. jsonb normalisiert
-- Schlüsselreihenfolge, Leerraum und Zahlenformat - die Bytes kämen ANDERS
-- wieder heraus, als sie hineingingen, und die Signatur wäre unprüfbar. Die
-- Signatur geht über die ROHEN Bytes (docs/ota-signing.md), also muss jede
-- Station auf dem Weg sie unverändert durchreichen. Wer hier auf jsonb
-- umstellt, zerstört die gesamte Vertrauenskette lautlos.
--
-- ⚠ Die api PRÜFT die Signatur NICHT. Das ist Absicht, keine Lücke: der
-- einzige Verifizierer, auf den es ankommt, ist das GERÄT (es hat die
-- eingebackene Wurzel), und ein Register, das ein Manifest „segnet", erzeugte
-- ein falsches Sicherheitsgefühl an einer Stelle, die gar nichts garantieren
-- kann. Das Register ist Papier-Spur und Transportweg, nie eine Autorität.
--
-- Die Felder sind NULLABLE: Stufe-0-Einträge (hand gepflegt, ohne Manifest)
-- bleiben gültig und lesen sich ehrlich als „nicht signiert".
--
-- Global wie die Tabelle selbst: kein tenant_id, keine RLS; die App-Rolle darf
-- nur LESEN (die V2-Default-Privilegien vergeben SELECT auf neue Spalten
-- automatisch mit, geschrieben wird ausschließlich über die BYPASSRLS-Rolle
-- voltpilot_admin aus dem platform-admin-Endpunkt).
--
-- Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

ALTER TABLE edge_release ADD COLUMN IF NOT EXISTS manifest       TEXT;
ALTER TABLE edge_release ADD COLUMN IF NOT EXISTS signature      TEXT;
ALTER TABLE edge_release ADD COLUMN IF NOT EXISTS signing_key_id TEXT;

-- Entweder beides oder nichts: eine Signatur ohne die Bytes, über die sie geht,
-- ist wertlos, und Bytes ohne Signatur wären ein Release, das sich signiert
-- NENNT. Ein Stufe-0-Eintrag (beide NULL) bleibt erlaubt.
ALTER TABLE edge_release DROP CONSTRAINT IF EXISTS edge_release_signed_pair;
ALTER TABLE edge_release ADD CONSTRAINT edge_release_signed_pair CHECK (
    (manifest IS NULL AND signature IS NULL AND signing_key_id IS NULL)
    OR (manifest IS NOT NULL AND signature IS NOT NULL AND signing_key_id IS NOT NULL)
);
