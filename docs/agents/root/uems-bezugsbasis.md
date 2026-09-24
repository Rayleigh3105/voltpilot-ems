# Bezugsbasis (AP-17): Wegweiser und Abschluss

Einstieg in alle 26 Pakete von AP-17 (Konzept `vp-uems-ap17-fundament`, entschieden 23.09.2026). Grundgedanke:
eine Energieleistungskennzahl ist eine Kennzahl mit freigegebener Bezugsbasis — die Kennzahl selbst ändert sich nie
(Invariante 1), ein Urteil gibt es nur bereinigt, mit Band und Bedingung (E8 = A). Kundenwörter nach SP1–SP3 aus
`frontend/portal/src/glossar.ts` (`UEMS_BEZUGSBASIS` …); nie „ISO“, „EnPI“, „Baseline“ auf einer Kundenfläche außer dem
Grenz-Satz (Wächter `copy.test.ts`, IP-4). Begriffe: Glossar `docs/fachmodell/glossar.md` (Energieleistungskennzahl,
Bezugsbasis, Referenzperiode, Einflussgröße, statischer Faktor, Leistungsvergleich, Wetterbezug).

## Einstieg je Paket

| Pakete | Schicht | Wegweiser |
|---|---|---|
| IP-1 | Referenzunternehmen 1.8 (Bezugsbasen, BZ-8/KZ-0006, Leistungsvergleich, W12) | `docs/contracts/v2/uems-referenzunternehmen.json` |
| IP-2, IP-10, IP-13 | Vertrag `bezugsbasis-vectors.json`, Zwillinge Java/TS/Python · Modelle M2–M5 · Grenzen G1–G5 | `uems-bezugsbasis-vertrag.md` |
| IP-3 | Nachträge Phase 1: Glossar (W9), Bericht-Vertrag 1.3 (W10), Gradtag-Vektor K23 (W11) | `uems-kennzahl-vertrag.md`, `uems-bericht-vertrag.md` |
| IP-4 | Sprach-Wächter und Kundenwörter | `frontend/portal/src/copy.test.ts` (Block „Bezugsbasis“), `glossar.ts` |
| IP-5 | Methoden-Katalog (vier Methoden, drei byte-gleiche Kopien) | `uems-bezugsbasis-methoden.md` |
| IP-6 | Datenhaltung: sieben Tabellen, BB-Zähler, Einfrieren per Trigger | `uems-bezugsbasis-datenhaltung.md` |
| IP-7 | Grundlage einfrieren, Verhältnis, Entwurf mit Vorschau | `uems-bezugsbasis-grundlage.md` |
| IP-8, IP-17 | Freigabe, Vier-Augen, Fassung n + 1, Verantwortlicher · Wiedervorlage, Beenden, Übersichts-Baustein | `uems-bezugsbasis-freigabe.md`, Zeilen in `uems-uebersicht.md` |
| IP-9 | Portal: Reiter „Bezugsbasis“ an der Kennzahl, Assistent anlegen/freigeben, Basis-Zeile im Register | `frontend/portal/src/components/BezugsbasisReiter.tsx`, `BezugsbasisAssistent.tsx`, `bezugsbasisAnlegen.ts` |
| IP-14 | Portal: Modell-Ansicht der Bezugsbasis (Punkte und Gerade, Modellgüte) | `frontend/portal/src/components/BezugsbasisModell.tsx`, `bezugsbasisModell.ts` |
| IP-11a | Variablen-Vorschlag aus dem Energieeinsatz | Zeile in `uems-uebersicht.md` |
| IP-12a/b/c | Wetter-Archiv: Vertrag (`bezogen`), Client und Takt, Binden/Lösen am Standort | `uems-bezugsgroesse-kanalbindung.md`, `uems/WetterArchivAbruf.java`, `web/WetterbezugController.java` |
| IP-15 | Anstoß: Kaskade (Pfad 1) und Struktur-Läufer (Pfad 2), Wasserzeichen `bezugsbasis_struktur_gelesen` | `uems/BezugsbasisAnstoss.java` (Kopf-Javadoc) |
| IP-16a/b | Faktoren-Vorschlag aus der Struktur, Kopie zum Stichtag | `uems/FaktorenVorschlag.java`, `uems/BezugsbasisFaktoren.java` |
| IP-19 | Vergleich-Leser `GET /api/v1/kennzahlen/{id}/vergleich` | Zeile in `uems-uebersicht.md` |
| IP-20 | Portal: Reiter „Vergleich mit Bezugsbasis“ an der Kennzahl | `frontend/portal/src/components/BezugsbasisVergleich.tsx`, `bezugsbasisVergleich.ts` |
| IP-21a/b, IP-22 | Vorlage `leistungsvergleich`, Quellenart `bezugsbasis`, Abzug, Belegschutz · PDF/CSV | Zeile in `uems-uebersicht.md`, `uems/BerichtLeistungsvergleich.java` |
| IP-25a | Bestandsschutz, Flag-Nachweis, dieser Wegweiser, Glossar, W2 | unten |
| offen am 24.09.2026 | IP-18, IP-24 (Portal), IP-23 (Kaskade Leistungsvergleich, A5), IP-26 (Abnahme NW-6), IP-25b (Drehbuch-Abschnitt, Release-Notiz) | beim Merge hier nachtragen |

## Bestandsschutz und Schalter (IP-25a, NW-5, R10)

- **`UemsBezugsbasisBestandsschutzTest`** (Docker, ohne Spring): Ahrenberg aus `infra/local/seed/ahrenberg.sql` auf der
  Fassung VOR `V20260924071500`, dazu KZ-0003 ohne Basis, BZ-1 mit einem Monatswert, eine Gradtagzahl ohne
  Wetterbezug, eine `bezugsgroesse_aenderung` (bearbeitet), eine Ortskorrektur und ein Monatsbericht. Danach alle
  späteren Migrationen. Jede Bestandstabelle ist byte-gleich (`Bestandsschutz.fingerabdruck`) — **ohne benannte
  Ausnahme**: `bericht.kennzahl_id` und `bezugsgroesse_wert.bezug_*` sind in jeder Bestandszeile NULL. Die neun neuen
  Tabellen sind leer; die Vorlage `leistungsvergleich` und die neuen Wörter sind Funktionen (`bericht_vorlage()`,
  `bericht_vokabular()`, `bezugsdaten_vokabular()`) — jedes alte Wort bleibt mit seiner Nummer, dazu genau die
  genannten. Mutationsprobe auf `bezugsgroesse` und `kennzahl`.
- **Kein Läufer schreibt für die Bezugsbasis:** Pfad 2 liest nur Protokollzeilen eines Kundenbereichs mit einer VOR
  ihnen freigegebenen Fassung — der Bestand hat keine, also kein Wasserzeichen, mit Schalter an und aus; der
  Struktur-Läufer liest weiter nur die AP-12-Ortskorrektur. Der Wetter-Abruf fragt ohne Wetterbezug kein Archiv.
- **Schalter `voltpilot.uems.bezugsbasis.enabled`** (`VOLTPILOT_UEMS_BEZUGSBASIS_ENABLED`, Vorgabe AN, surefire setzt
  nichts): gelesen nur in `BezugsbasisAnstoss`. Aus: Pfad 1 schweigt, Pfad 2 setzt nur das Wasserzeichen mit Urteil
  `abgeschaltet`, nichts wird nachgeholt (`UemsBezugsbasisAnstossTest`).
  **`voltpilot.uems.wetter-archiv.enabled`** (`VOLTPILOT_UEMS_WETTER_ARCHIV_ENABLED`, Vorgabe AN, surefire AUS): Bean-
  Bedingung nur an `WetterArchivLaeufer`, dazu `UemsLaeuferMelder` für den Zustand. Routen, DTOs und Portal kennen
  keinen der beiden — Wächter `UemsBezugsbasisFlagArchitekturTest`; er hält auch die Not-Aus-Tabelle §12 von
  `docs/rollout/uems-erste-freigabe.md` gleich `application.yml` (26 Schalter, dieselbe Reihenfolge — W14).
- **Die einzige Formänderung einer bestehenden Antwort:** der Register-Eintrag der Kennzahl trägt `bezugsbasis`
  (`KennzahlDto.Kennzahl`, `@JsonInclude(ALWAYS)`) — für eine Kennzahl ohne Basis `null`. Ohne Basis zeigen
  Übersicht und Vergleich nur den Satz (`BezugsbasisPflegeApiTest` R10, `BezugsbasisVergleichApiTest.ohneBasisBasisFehlt`).
- **Wer ein Paket nach IP-25a baut:** eine neue AP-17-Tabelle kommt in `NEUE_TABELLEN`, ein neues Vokabular-Wort in die
  Erwartung von `vorlageUndVokabulareWachsenNurUmDieGenanntenWoerter`; ein neuer Leser eines der beiden Schalter
  (etwa IP-23 an der Berichts-Kaskade) in `UemsBezugsbasisFlagArchitekturTest`.

## Vermerke

- **W2 erledigt (E10 = A):** AP-09 §6.5 wies Betriebskalender, Arbeitszeitmodell und Wetterbereinigung AP-17 zu. Es gibt
  keinen Kalender und kein Arbeitszeitmodell als Stammdatum: die Betriebszeit ist eine Bezugsgröße und als
  Einflussgröße eine Variable wie jede, ein Schichtmodell höchstens ein Wortlaut-Faktor; die Wetterbereinigung ist mit
  Gradtagen eingelöst, die Temperatur bezieht VoltPilot aus dem Wetter-Archiv (E9 = C). AP-09 E2 bleibt.
- **W14:** beide Schalter stehen in der Not-Aus-Tabelle des Drehbuchs (§12), Vorgabe AN. `BEZUGSBASIS` und
  `WETTER_ARCHIV` fehlen noch in gitops PR 37 — ohne Eintrag gilt die Vorgabe; ein abweichender Wert ist die Hand des
  Betreibers.
