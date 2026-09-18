# UEMS-Fläche: die Welt „Berichte“ — Liste und Berichtsseite (AP-12 IP-13)

Neu am 15.09.2026. Portfolio-Welt `#/portfolio/berichte` (Liste) und `#/portfolio/berichte/{kennung}` (Berichtsseite);
seit AP-13 IP-2 dieselbe Liste als „Berichte dieses Standorts“ unter `#/standort/{id}/berichte`
(`uems-oberflaechen-ebenen.md`). Die Fläche LIEST nur: `GET /api/v1/berichte`, `…/{kennung}`, `…/staende/{nr}`
bzw. `…/entwurf` (IP-7, `uems-bericht-routen.md`), für „heute: …“ das Messstellen-Register und die Kennzahlen, erst auf
„heutigen Wert zeigen“ `GET /api/v1/messstellen/{kennzeichen}/werte`. Spezifikation: AP-12 §8 IP-13, §5.1–§5.6, §5.8, E14.

| Datei (`frontend/portal/…`) | Was |
|---|---|
| `src/berichtSeite.ts` | reine Ableitung: Listen-Karte, Reiter der Stände, Seitenkopf, Abschnitte nach Vorlage mit Nachweis je Zahl (Form `uemsWerteKarte.Karte`), Tagesverlauf, Verlauf der Stände, PDF/CSV-Ableitung, „heutigen Wert zeigen“ |
| `src/pages/BerichtePage.tsx`, `src/pages/BerichtSeite.tsx`, `BerichtePage.css` | Liste und Seite; `WerteKarte`, `ZeitSegment` und `MiniBarSpark` wiederverwendet, Aufklappen als natives `<details>` |
| `src/test/berichtFixtures.ts`, `src/test/berichtAbzuege.json` | Antworten entlang der Zeitachse der Referenzdatei 1.4 (10.11. Nr. 1 · 12.11. K-2026-0007 · 16.11. Nr. 2); die Abzüge sind die Vektor-Abzüge BR-2026-0001/1 und /2, byte-gleich |
| `src/berichtSeite.test.ts` | B1 Nr. 1/Nr. 2, B10 („heute: …“), B16 (nach den Fristen) gegen `bericht-vectors.json`; beweist auch die Gleichheit der Fixture-Kopie |
| `e2e/berichte.spec.ts` | Bühne `startansicht`: `ansicht=berichte`, `ansicht=bericht&br=BR-2026-0001`, `heute=b10`, `tagesverlauf=gefuellt`; vier Uhren (13.11., 20.11., 03.12.2026, 02.11.2036) |

```bash
(cd frontend/portal && npx vitest run src/berichtSeite.test.ts src/copy.test.ts src/ebenenNav.test.ts src/uemsBericht.test.ts)
(cd frontend/portal && npx playwright test e2e/berichte.spec.ts --project=desktop-chromium --project=mobile-chromium)
```

## Die Fallen

- **Der Abzug IST das Dokument.** Die Seite spricht ihn wörtlich (Zahl nach DA1 über `uemsBericht.anzeige`, Zustand,
  Kennzeichen, Namen und Orte zum Datenstand) und prüft ihn NICHT gegen `uemsErgebnis.pruefe` nach — „berechnet“ kennt der
  Wert-Vertrag nicht, und eine Zahl eines freigegebenen Stands wird nie stumm. Nichts wird aus lebenden Zeilen ersetzt.
- **Abschnitte nach Vorlage, nur wenn der Vertrag sie kann.** Ein Abzug nach 1.0/1.1 ohne `tagesverlauf` zeigt den
  Abschnitt nicht (`abschnitte(...).ohneInhalt`). Vertrag 1.2 zeigt dagegen jede Reihe; `tage: []` bleibt als sichtbare
  Lücke stehen. Tagesmengen werden mit `MiniBarSpark` nur aus dem Abzug gezeichnet, `null` bleibt eine Lücke.
- **Laden/Entladen:** MS-04 steht als EINE Gruppe mit den zwei Kundenwörtern aus `MessstelleRegeln.RICHTUNGSPAAR`.
  Fehlt eine gespeicherte Menge, nennt die Gruppe den Grund und zeigt einen Strich, nie 0; „heutigen Wert zeigen“ fehlt
  dort, weil der heutige Leseweg die beiden Richtungen nicht trennt.
- **Kennzahlen-Nachweis 1.2:** `ort_zum_datenstand` und `endgueltig_ab` stehen in derselben Herkunftsliste wie an einer
  Messstellen-Zahl. Fehlen die optionalen Felder in 1.0/1.1, entsteht keine Ersatzangabe.
- **PDF und CSV ohne Ziel = kein Knopf.** `ausgabeKnoepfe` leitet ab (nur Stände, EW4; Recht über `uemsBericht.kennung`;
  Dateiname §5.4). Sichtbar erst mit `AUSGABE_EINGEHAENGT[handlung] = true` UND einer `onAbruf`-Prop an `BerichtSeite`.
  ⚠ **Stand IP-15: beide aus.** IP-10 und IP-11 haben nur die Routen gebaut; `berichtSeite.test.ts` pinnt
  `{ pdf: false, csv: false }`. Wer einhängt: `csv` mit `onAbruf` → `GET …/staende/{nr}/csv` und dem Recht `export.*`
  (`darfNachLesen` weiß nur `abrufen` sicher), dazu „zuletzt abgerufen …“ und die Spalte „letzter Abruf“ (ein Feld an
  `Bericht`, `BerichtePage.tsx` sagt es); `pdf` mit dem Recht `abrufen` (G1). Lücke am Freigabetag: `uems-berichte-abschluss.md`.
- **`copy.test.ts` liest JSX-Bedingungen als Text:** `{knoepfe.length > 0 && onAusgabe && (` trug das verbotene „Ausgabe“
  (§4.15) — die Prop heißt darum `onAbruf`. Die Typ-Namen in `berichtSeite.ts` sind kein Kundentext.
- **„heute: …“ (A5)** kommt aus `messstellenRegister()` und `kennzahlen()`; fällt eine Quelle aus, fehlt nur der Hinweis.
  B10 (MS-12 heißt ab 01.12.2026 anders) ist eine Vektor-Annahme — die Bühne nennt sie nur mit `heute=b10`.
- **B16:** seit IP-16 antwortet `…/werte` `404 wert_nicht_mehr_gespeichert` — aber ohne `version` nur, wo es keine spätere
  Version gibt (nach einer Korrektur zeigt die Route Version 2, `uems-bericht-nach-den-fristen.md`); `heutigerWert` spricht den Satz
  schon, sobald der Code kommt — jede andere Ablehnung ist „konnte nicht geladen werden“, nie „nicht mehr gespeichert“.
- **Kopf-Abschnitt zugeklappt (Variante B, 15.09.2026):** Datenstand, Stand, Freigabe und Prüfsumme trägt der Seitenkopf
  (Satz der Route, D5); die acht Angaben samt Regelwerk bleiben einen Tipp entfernt. Rundung und Sommerzeit der
  `darstellung` sind Verweise auf Konzept-Regeln („AP-08 E11“) und stehen nicht da (Befund für IP-11/Vertrag).
- **Die Bühne liest keine Vertragsdateien:** Vite serviert nur `frontend/portal` — deshalb die JSON-Kopie der Abzüge;
  die Playwright-Spec importiert keine Fixtures (`api.ts` ohne `import.meta.env` im Node-Lauf).
- **Ahrenberg hat FÜNF Kacheln** (Berichte, sobald ein Standort misst) und am Rechner den Reiter „Berichte“ vor
  „Messwerte“: `ebenenNav.test.ts`, `telefonleiste.spec.ts`, `messstellen.spec.ts`, `kennzahlen.spec.ts` tragen es.
- **Seit AP-12 IP-14 schreibt die Welt:** „Bericht anlegen“, Freigabe-Dialog, Vergleich, „Anstoß verwerfen“ und das
  Banner „Revision nötig“ — `uems-bericht-dialoge.md`. Die Liste zeigt die 403 der Unterstützung weiter mit dem Satz der
  Route (Rechte-Ableitung, nicht §5.8), ohne „Erneut versuchen“ und ohne „Bericht anlegen“.
- **`.vp-br-hebel` ist der Knopf „heutigen Wert zeigen“** (IP-13) — die Hebel-Leisten von IP-14 heißen `.vp-br-aktionen`.
