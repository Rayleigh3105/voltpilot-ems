# UEMS-Bezugsgrößen-Tabellen: Werte als Fassungen, Kennzeichen-Verlauf, Protokoll (AP-09 IP-4)

Neu angelegt am 13.09.2026. Migration
`services/api/src/main/resources/db/migration/V20260913104500__uems_bezugsgroesse.sql`, Beweis
`UemsBezugsgroesseMigrationTest` (Testcontainers). Die Regeln sind der Vertrag
`docs/contracts/v2/bezugsdaten.md` + `bezugsdaten-vectors.json` (siehe
`uems-bezugsdaten-vertrag-java-ts-zwill.md`, `uems-einheiten-perioden-module.md`); die Tabellen sagen
dieselbe zeitlose Hälfte als Constraint, und der Test spielt die Vektoren gegen die Datenbank.

## Was es gibt — und was (noch) nicht

- `bezugsgroesse`: Kennzeichen (BZ-…), Name, `wertart`, `einheit`, `periode_art` (nur bei
  `periodenwert`), `geltung_art` + GENAU EINE Verweis-Spalte (`unternehmen_id` · `standort_id` ·
  `ort_id` für Gebäude/Bereich, Art per FK über `ort_art` · `messstelle_id`), `archiviert_am`.
- `bezugsgroesse_kennzeichen_verlauf`: jedes je getragene Kennzeichen (Trigger, SECURITY DEFINER,
  Muster `messstelle_kennzeichen`). Kein eigener Zähler: die automatische Vergabe (IP-5) folgt auf
  die höchste hier je belegte Nummer.
- `bezugsgroesse_wert`: die Werte als Fassungen — Periodenwert (`periode_von`/`periode_bis`) oder
  Stand (`zeitpunkt`), `fassung`/`ersetzt_fassung`, `vorgang`, `status`, `betrag` in der Einheit der
  Bezugsgröße, Herkunft (`herkunft_art`, `import_kennung`, `import_zeile`, geliefert), `kennzeichen`
  (jsonb-Array), Urheber `actor_*`, Freigeber `freigeber_*`, `created_at`.
- `bezugsgroesse_aenderung`: das Protokoll der Bezugsgröße (`angelegt` · `bearbeitet` · `archiviert`).
- Keine Route, kein Lesemodell (IP-5), keine Stammdaten mit Gültigkeit (IP-6), keine Eingabe/
  Vier-Augen (IP-7), kein Import (IP-11 ff.), keine Kanalbindung (IP-17). Kein Aufrufer.

## ⚠ Die Fassungs-Eigenschaft

- **Ein Wert wird nie überschrieben (E6).** Trigger `bezugsgroesse_wert_append_only` lehnt JEDES
  UPDATE ab — auch der Verwaltungsrolle MIT Recht und dem Eigentümer (der Test gibt das Recht in
  einer zurückgerollten Transaktion). Eine Berichtigung ist Fassung n + 1, eine Rücknahme Fassung
  n + 1 `ruecknahme` (E11), nach einer Rücknahme darf wieder ein `erstwert` folgen (Vertrag B14).
  Fassungen je Schlüssel lückenlos (`bezugsgroesse_wert_fassung_lueckenlos`). DELETE nur die
  Verwaltungsrolle, benutzt nur vom Offboarding.
- **`status` ist das Wort bei Entstehen, der Stand ist eine Ableitung.** „wirksam bis Fassung 2"
  ist die Lesart des Vertrags und nie gespeichert; eine Entscheidung (Freigabe) ist wieder eine
  Zeile. Wirksamer Betrag = höchste Fassung mit `wirksam`/`zurueckgenommen`.
- **Die Bedeutung eines Betrags bleibt nach dem ersten Wert (M1).** Wertart, Einheit, Periodenart
  reisen als Kopie in jede Wert-Zeile und sind per FK (`bezugsgroesse_wert_bedeutung_fk`,
  `…_periode_fk`) gebunden — eine Änderung an der Bezugsgröße scheitert, sobald ein Wert besteht.
  Den Geltungsbereich hält `bezugsgroesse_identitaet_bleibt` fest. Gleichzeitigkeit: die
  Geltungs-Spalten stehen in `bezugsgroesse_geltung_uq` und sind damit Schlüssel-Spalten — ihre
  Änderung wartet auf das FOR KEY SHARE eines unbestätigten ersten Werts (Test mit zwei Sitzungen).
  **Wer diesen Unique-Schlüssel entfernt, öffnet das Rennen.**
- **`created_at` setzt die Datenbank** (INSERT-Spaltenrecht ohne `created_at`); E16 hängt daran.

## ⚠ Die Vokabular-Bindung

- `bezugsdaten_vokabular()` ist die EINE Stelle in der DB: Zeile für Zeile `vokabulare.wertart|
  geltung_art|periode_art|herkunft_art|vorgang|status` und `einheiten` der Vektor-Datei. Jeder CHECK
  auf ein solches Wort fragt `bezugsdaten_wort(…)`, keiner trägt eine Liste (der Test prüft beides).
- **Weitet der Vertrag ein Vokabular:** der Test wird rot und druckt den VALUES-Block; eine NEUE
  Migration ersetzt nur die Funktion. Eine neue Periodenart braucht zusätzlich ihre Form in
  `bezugsgroesse_wert_genau_eine_periode_chk` (der Test fordert eine Beispielperiode).
- Nicht Vertragswörter und darum Literale: Urheber-Art/-Rolle (AP-03, wie `messstelle_aenderung`),
  `bezugsgroesse_aenderung.art` (§6.1), Zeitzonen (wie `standort`).
- **Prozess und Kostenstelle** stehen im Vokabular, haben aber keine Tabelle → keine Verweis-Spalte →
  `bezugsgroesse_geltung_objekt_chk` lehnt ab (E1 „wählbar, sobald gebaut"). Ahrenbergs BZ-1…BZ-3
  (P-1/P-2) passen darum noch nicht; BZ-5 (MS-14) passt. Der Test wird rot, sobald `prozess` oder
  `kostenstelle` als Tabelle existiert.
- **Keine Art-Spalte** („Produktionsmenge", „Gutteile"): der Vertrag hat dafür kein Vokabular.
- Herkunft `stammdatum_ap02` und Wertart `stammdatum` haben hier keine Werte (E17/M4, S1).

## ⚠ Die Zeitformen

- **Periodenwert: Tage, geschlossen, letzter Tag einschließlich** — genau EINE Kalenderperiode
  ihrer Art (Tag · Woche ab Montag · Monat · Jahr, CHECK). Der Vertrag spricht dieselbe Periode
  halboffen in Instanten (`2026-10-01T00:00+02:00` … `2026-11-01T00:00+01:00`); `periode_bis` =
  lokaler Tag von `bis` minus 1. Die Zone steht je Zeile in `zeitzone`.
- **Stand: `zeitpunkt` auf die volle Minute.**
- **E16 in der DB:** `(periode_bis + 1) 00:00` in `zeitzone` ≤ `created_at`; ein Stand liegt nicht in
  der Zukunft. Welche Zone gilt (Z1), prüft der Schreibweg.
- Postgres prüft CHECKs in NAMENSreihenfolge (`…_abgeschlossen_chk` spricht zuerst).

## Offboarding

`TenantRepository.offboard` löscht `bezugsgroesse_wert`, `bezugsgroesse_kennzeichen_verlauf`,
`bezugsgroesse`, `bezugsgroesse_aenderung` VOR Messstellen, Orten, Standort und Unternehmen. Anders
als die älteren Journale hält das Protokoll den Mandanten per FK (RESTRICT) und geht mit dem
Kundenbereich; ohne diese Zeilen ließe sich ein Kundenbereich mit Bezugsgrößen nicht löschen (PR 706).
