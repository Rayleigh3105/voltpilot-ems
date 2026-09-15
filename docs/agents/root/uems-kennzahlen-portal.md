# UEMS-Fläche: die Welt „Kennzahlen“ — Liste und Kennzahl-Seite (AP-11 IP-13)

Neu am 15.09.2026. Portfolio-Welt `#/portfolio/kennzahlen` (Liste) und `#/portfolio/kennzahlen/{id}` (Kennzahl-Seite);
seit AP-13 IP-2 dieselbe Liste als „Kennzahlen dieses Standorts“ unter `#/standort/{id}/kennzahlen`
(`uems-oberflaechen-ebenen.md`). Die Fläche LIEST nur: `GET /api/v1/kennzahlen`, `…/{id}`, `…/{id}/fassungen`,
`…/{id}/werte` und — erst im geöffneten Dialog — `…/{id}/werte/versionen` (IP-5/IP-7, `uems-kennzahl-werte-lesen.md`).
Spezifikation: AP-11 §8 IP-13, §5.3 (Kennzahl-Seite bei 375 px), §5.5 (Versionen), §4.13 und E12 (Wörter).

| Datei (`frontend/portal/…`) | Was |
|---|---|
| `src/kennzahlKarte.ts` | reine Ableitung: Listen-Karte, Werte-Karte (Form `uemsWerteKarte.Karte`), Satz ohne Zahl, Verlauf, Herkunft, Berechnung, Stammdaten, Versionen |
| `src/pages/KennzahlenPage.tsx`, `src/pages/KennzahlSeite.tsx`, `KennzahlenPage.css` | Liste und Seite; `WerteKarte` (neue Prop `grund`) und `VersionenModal` wiederverwendet |
| `src/test/kennzahlWerteFixtures.ts` | K1, K7, K8, K10, K11, K2, K3 aus `docs/contracts/v2/kennzahl-vectors.json`; `kennzahlKarte.test.ts` beweist die Gleichheit |
| `e2e/kennzahlen.spec.ts` | Bühne `startansicht`: `ansicht=kennzahlen`, `ansicht=kennzahl&kz=KZ-0001`, `ausserhalb=KZ-0003`; zwei Uhren (10.11. und 03.12.2026) |

```bash
(cd frontend/portal && npx vitest run src/kennzahlKarte.test.ts src/pages/KennzahlenPage.test.tsx src/copy.test.ts src/ebenenNav.test.ts)
(cd frontend/portal && npx playwright test e2e/kennzahlen.spec.ts --project=desktop-chromium --project=mobile-chromium)
```

## Die Fallen

- **Die Kachel „Kennzahlen“ steht, sobald ein Standort misst UND eine lebende Kennzahl existiert** (`EBENEN_SEITEN` trägt
  jetzt die Route, `ebenenBereiche` die Bedingung): Ahrenberg hat VIER Kacheln, am Rechner den Reiter „Kennzahlen“ neben
  „Messstellen“. `ebenenNav.test.ts`, `messstellen.spec.ts` und `telefonleiste.spec.ts` tragen das mit — wer die Welt
  umzieht (AP-13), zieht diese Erwartungen mit.
- **Nichts wird gerechnet.** Die Zahl spricht `uemsKennzahl.anzeige` (zwei Stellen, „mindestens“/„höchstens“); die
  Versionen sprechen mit den Vergleichs-Stellen (vier) — sonst läsen K7 Version 1 (0,1488) und Version 2 (0,1473) beide
  „0,15“ (§5.5 „vorher 0,1488“). Die Balkenhöhe nutzt `Number()` nur fürs Bild, nie für einen Satz.
- **Ein Kennzeichen, das `kennzeichenPruefen` nicht kennt, macht Karte und Balken stumm** (wie die Tageskarte). Wer ein
  neues Kennzahl-Kennzeichen einführt (IP-9 Berichtigung, IP-11 Paare über Zeit), trägt es zuerst in den Zwilling ein.
- **Der Satz ohne Zahl braucht die Eingänge der Fassung DER Periode** (`eingaengeDer` über `definition_fassung`): „Für
  November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.“ Die Liste lädt keine Fassungen und zeigt
  darum nur „— · keine Werte“. Die Gründe des Lesers (`noch_nicht_gebildet`, `version_nicht_gespeichert`) haben keinen
  Satz — dort steht „—“ allein.
- **Herkunft ohne „gemessen“ und ohne „eingegeben von … am …“**, obwohl §5.3 beides druckt: `kennzahlwert-herkunft`
  trägt es nicht. Befund — wer es will, erweitert den Vertrag; das Portal leitet es nicht aus Kennzeichen ab.
- **R-A7 ohne Feld.** `Kennzahl` kennt keine Sichtbarkeit; die Liste nimmt ein 404 der Werte-Route als „umfasst Standorte
  außerhalb Ihres Zugriffs“ (ohne Wert). Bringt AP-03 IP-11 ein Feld, ersetzt es diese Brücke.
- **Liste = jüngster Schritt MIT Zeile im Fenster des Verlaufs** (31 Tage · 12 Wochen · 12 Monate · 5 Jahre), mit seiner
  Periode daneben; der Verlauf beginnt beim ersten Schritt mit Zeile. Ohne jede Zeile steht jede Periode als „—“.
- **`WertVersionen.tsx`:** `VersionenDialog` (Messstelle) ist eine Hülle um `VersionenModal` (`laden` + `schluessel`);
  die Kennzahl ruft `VersionenModal` mit `kennzahlHistorie`. Eine geänderte Berechnung (`vorgang: berechnung`) spricht
  „Berechnung Fassung n · eingetragen von …“; eine Version ohne Entscheidung zeigt ihren Anlass.
- **`copy.test.ts`** (§4.13): nie KPI/Metrik/Kenngröße/Dashboard/Widget/Template in der Kundensicht (Hilfe-Suchwörter
  ausgenommen), auf Kennzahl-Flächen nie Durchschnitt/Mittel und nie Zähler/Nenner als Rolle. `KENNZAHL_BESTAND` nennt die
  Flächen, die „Kennzahl“ heute schon außerhalb der Welt sagen — IP-14 hat die Eigene Auswertung auf „3 · Zeitbezug“ umbenannt und dort gestrichen.
- **Die Playwright-Spec importiert keine Fixtures**: sie laden `api.ts`, und dem fehlt im Node-Lauf `import.meta.env`.
- **Abweichung:** §5.5 schreibt „freigegeben von Jonas Wendlinger“; die Referenzdatei 1.4 hat K-2026-0007 von Ines
  Kaltenbach freigegeben — die Fixtures folgen der Datei.
- **Seit IP-15 gebaut:** „Berechnung ändern ab …“, Stammdaten ändern, Archivieren und Löschen — `uems-kennzahl-aendern.md`
  (kein Wiederherstellen: keine Route, also kein Knopf). Die Paare einer Jahres-Zusammenfassung (K14) zeigt die Herkunfts-Karte seit IP-11 (`kennzahlKarte.herkunft` → `paare`). „Kennzahl anlegen“ und „Kopieren“ stehen seit IP-14 im
  Kopf von Liste und Seite: `uems-kennzahl-anlegen.md`.
