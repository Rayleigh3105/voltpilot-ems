-- =============================================================================
-- UEMS AP-19 IP-12 — die Rolle „Einsicht“ (RE3, RE5, E8 = A, R6).
--
-- Eine unternehmensweite Rolle, die nur lesen darf — für die Leitung und für
-- Prüfende. Welche Aktionen sie trägt, sagt die Spalte `einsicht` der Matrix
-- (docs/contracts/v2/rechte-matrix.json): U an den lesenden Zeilen, E am eigenen
-- Konto, sonst −. Die Datenbank kennt davon nur zwei Dinge:
--
--   1. zugriff_rolle() — Zeile für Zeile `rollen` der Matrix-Datei — bekommt die
--      achte Zeile. Die VEREINIGUNG: die sieben Zeilen von V20260915030000 stehen
--      unverändert (Nummer, Wort, Geltungsbereich, zuweisbar); `einsicht` kommt
--      als Nummer 8 dazu, Geltungsbereich `unternehmen`, zuweisbar. Jeder CHECK,
--      der über zugriff_rolle_geltung() fragt (zugriff_rolle_chk,
--      zugriff_geltungsbereich_chk, zugriff_unterstuetzung_chk,
--      zugriff_protokoll_rolle_chk, zugriff_protokoll_actor_rolle_chk), kennt
--      damit das neue Wort; eine Zuweisung `einsicht` trägt keinen Standort
--      (mandantenweit, „alle Standorte, auch künftige“) und darf ein Enddatum
--      tragen (`gueltig_bis`, befristbar — zugriff_ende_chk gilt wie für jede
--      Rolle).
--
--   2. bericht_abruf_actor_rolle_chk (V20260915050000:417) trug eine eigene,
--      feste Liste der sieben Rollen. Einsicht darf das PDF eines Stands abrufen,
--      und der Abruf wird mit ihrer Rolle protokolliert (R6 Schritt 2) — darum
--      der CHECK-TAUSCH: dieselbe Liste plus `einsicht`, keine Bestandszeile wird
--      ungültig.
--
-- Alle anderen festen Rollen-Listen (actor_rolle der Schreib-Protokolle, die
-- Freigeber-Rolle des Berichtsstands) bleiben: Einsicht schreibt nie (jede
-- Schreibroute 403 recht_fehlt), also steht ihr Wort dort nie.
--
-- Bestand: keine Zeile wird geschrieben oder geändert, keine Tabelle angelegt;
-- die Funktion bleibt IMMUTABLE mit derselben Signatur (CREATE OR REPLACE hält
-- Grants und Abhängigkeiten). Beide Reihenfolgen: V20260915030000 und
-- V20260915050000 liegen auf `main` nicht, auf `uems` vor dieser Version — diese
-- Migration läuft auf frischer DB und nach späterer Ankunft gleich.
-- =============================================================================

CREATE OR REPLACE FUNCTION zugriff_rolle()
RETURNS TABLE (nr INTEGER, rolle TEXT, geltungsbereich TEXT, zuweisbar BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    (1, 'kundenadministrator', 'unternehmen', true),
    (2, 'energiemanager', 'unternehmen', true),
    (3, 'bearbeiter', 'standort', true),
    (4, 'bedienberechtigt', 'standort', true),
    (5, 'leser', 'standort', true),
    (6, 'unterstuetzer', 'standort_befristet', false),
    (7, 'voltpilot_betrieb', 'plattform', false),
    (8, 'einsicht', 'unternehmen', true)
$$;

ALTER TABLE bericht_abruf DROP CONSTRAINT IF EXISTS bericht_abruf_actor_rolle_chk;
ALTER TABLE bericht_abruf ADD CONSTRAINT bericht_abruf_actor_rolle_chk
    CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
           'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb', 'einsicht'));

COMMENT ON FUNCTION zugriff_rolle() IS
    'Die Rollen von docs/contracts/v2/rechte-matrix.json (kennung, geltungsbereich, zuweisbar), Zeile fuer Zeile; '
    'seit V20260925030000 mit einsicht (AP-19 IP-12).';
