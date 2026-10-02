# MiSpeL-Check je Anlage (MP-48)

Stand 02.10.2026 · Vertrag 1.0 · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und Ladepunkten
(„MiSpeL“, Az. 618-25-02, Beschluss 01.10.2026) — Anlage 1 (Abgrenzungsoption), Tenor Ziff. 9a; EEG § 19 Abs. 3b,
§ 20 S. 2, Anlage 1 Nr. 2 S. 2. Konzept: MiSpeL-Fundament § 3 (Kundentypen, Annahmen), Bauplan § 8 Zeilen MP-13
und MP-48; Bedienkonzept BK-48 Variante A (abgestimmt 02.10.2026); Entscheid firstmate `mp48-datenweg` = A.

Der Check beantwortet vor dem Wechsel die Frage „lohnt sich die Abgrenzungsoption für **genau diese Anlage**?“.
Er vergleicht dieselbe Anlage mit demselben Speicher und VoltPilot **heute** gegen **mit Abgrenzungsoption** über
ein Ganzjahr echter Viertelstundenpreise — nie gegen „ohne Speicher“. Gerechnet wird er von MP-13
(`services/optimization/voltpilot_optimization/simulation/mispel_check.py`); dieser Vertrag ist nur der
Ablageort und die nur lesende Route. **Wer ihn je Anlage rechnet und hier ablegt, ist das Folgepaket MP-13b.**

| Datei | Rolle |
|---|---|
| `services/api/src/main/resources/db/migration/V20261002234100__mispel_check_ergebnis.sql` | Tabelle `site_mispel_check` (eine Zeile je Anlage, RLS + FORCE), beginnt leer |
| `services/api/.../mispel/MispelCheckRepository.java` | liest die Zeile unter RLS |
| `services/api/.../web/SiteMispelCheckController.java` | `GET /api/v1/sites/{siteId}/mispel-check` |
| `frontend/portal/src/mispelCheck.ts` · `components/MispelCheckKarte.tsx` | Typen, Satz und Karte in Schritt 1 des Dialogs „Förderweg ändern“ |
| `…/mispel/MispelCheckApiTest.java` · `src/mispelCheck.test.ts` · `e2e/foerderweg.spec.ts` | Route + Tabelle · Satz und Karte · Fläche bei 375/1440 px |
| `services/optimization/voltpilot_optimization/simulation/mispel_check_lauf.py` | der Schreiber (MP-13b, § 6): rechnet je Anlage und legt ab |
| `docs/contracts/v2/mispel-check-beispiel.json` | Zeilen, wie der Schreiber sie ablegt — gelesen von `MispelCheckApiTest`, Form geprüft von `test_mispel_check_lauf_db.py` |

## 1. Stand

| `stand` | heißt | Beträge | Portal |
|---|---|---|---|
| *(keine Zeile)* | noch nie gerechnet | — | „wird gerechnet“ |
| `wird_gerechnet` | ein Lauf ist angestoßen | leer (Pflicht) | „wird gerechnet“ |
| `fertig` | Ergebnis liegt vor | alle drei gesetzt (Pflicht) | Urteil, Spanne, Posten |
| `fehlgeschlagen` | der Lauf ist gescheitert | leer (Pflicht) | Satz aus `hinweis`, kein Betrag |
| `nicht_unterstuetzt` | Formelsatz rechnet der Check nicht (MP-13: nur A1, A10, A11) | leer (Pflicht) | Satz aus `hinweis`, kein Betrag |

`stand_seit` ist der Zeitpunkt des Standes. **Nie ein Betrag von 0 € statt „wird gerechnet“:** die Datenbank
verbietet Beträge außerhalb von `fertig` (`site_mispel_check_fertig_chk`), und ohne Zeile antwortet die Route
mit `stand = wird_gerechnet` (nicht 404 — die Anlage gibt es).

## 2. Beträge

`differenz_{niedrig,mittel,hoch}_eur` ist der **Unterschied im Jahr = mit Abgrenzungsoption − heute** in €/Jahr
netto, je Annahmen-Fall von MP-13 (`spanne`, `STANDARD_FAELLE`). Positiv = die Abgrenzungsoption bringt mehr.
Das Portal zeigt `mittel` als Betrag („mittlere Schätzung“) und die Spanne **ungünstig = kleinster, günstig =
größter** der drei Werte. `fenster_von`/`fenster_bis` ist das Preisfenster, tagesgenau, einschließlich des
letzten Tages; `formelsatz` der Formelsatz der Anlage 1, mit dem gerechnet wurde (angenommen, solange die Anlage
keinen gewählt hat — dann steht er in `datenbasis` als `angenommen`).

## 3. Posten

`posten` ist eine Liste `{art, niedrig_eur, mittel_eur, hoch_eur, herkunft}` mit Vorzeichen (+ bringt, − kostet);
die Summe je Fall ist der Unterschied des Falls. Geschlossenes Vokabular `art`:

| `art` | MP-13-Posten | Wort im Portal |
|---|---|---|
| `handel_saldierung` | „Netzladen-Handel mit Saldierung“ (A1) · „Handel mit Saldierung (MiSpeL)“ (A10/A11) | Netzladen-Handel mit Saldierung |
| `handel_heute` | „abzüglich Handel heute ohne Saldierung“ (A10/A11) | abzüglich Handel heute ohne Saldierung |
| `jahresmarktwert` | „Jahresmarktwert statt Monatsmarktwert“ (A1; EEG Anlage 1 Nr. 2 S. 2, A1 S. 21) | Jahresmarktwert statt Monatsmarktwert |
| `zaehler_z2` | „Zweiter Zähler Z2“ (A1 S. 32–33) | Zweiter Zähler Z2 |
| `bilanzkreis` | „Gesonderter Bilanzkreis“ (§ 20 S. 2 EEG) | Gesonderter Bilanzkreis |
| `vermarktungsentgelt` | „Mehr Vermarktungsentgelt auf die zusätzliche Rückspeisung“ (A10/A11) | Mehr Vermarktungsentgelt |

Eine unbekannte `art` zeigt das Portal mit ihrem Schlüssel und rechnet sie in die Summe — ein Posten fällt nie still
heraus.

## 4. Datenbasis

`datenbasis` ist eine Liste `{angabe, wert, einheit, herkunft, quelle}` — woraus gerechnet wurde. `herkunft` ist
`gemessen` (Messwerte der Anlage), `stammdaten` (Anlage, Speicher, anzulegender Wert, Förderweg) oder
`angenommen` (z. B. Jahresverbrauch ohne Messreihe, Formelsatz vor der Wahl; `quelle` nennt die Herkunft der
Annahme, etwa „Konzept § 3 a2“). Das Portal nennt die angenommenen Angaben unter der Rechnung.

## 5. Route

`GET /api/v1/sites/{siteId}/mispel-check` — nur lesend, Leseweg der Anlage (`messwerte.ansehen`, außerhalb des
Zugriffs 404, wie `GET …/foerderweg`). Antwort (snake_case):

```json
{ "site_id": "…", "stand": "fertig", "stand_seit": "2026-10-02T12:00:00Z", "formelsatz": "A1",
  "fenster_von": "2025-10-01", "fenster_bis": "2026-09-30",
  "differenz": { "niedrig_eur": 158.0, "mittel_eur": 1899.0, "hoch_eur": 8043.0 },
  "posten": [ { "art": "handel_saldierung", "niedrig_eur": 1658.0, "mittel_eur": 2749.0, "hoch_eur": 8343.0,
                "herkunft": "Simulation …" } ],
  "datenbasis": [ { "angabe": "Jahresverbrauch", "wert": 60000, "einheit": "kWh", "herkunft": "angenommen",
                    "quelle": "Konzept § 3 a2" } ],
  "hinweis": null }
```

Ohne Zeile: `stand = wird_gerechnet`, `stand_seit = null`, `differenz = null`, Listen leer. Außerhalb von `fertig`
ist `differenz` immer `null`.

## 6. Schreiben (MP-13b)

Die App-Rolle darf `INSERT`/`UPDATE` im eigenen Mandanten (RLS), die Admin-Rolle mandantenübergreifend — der
Schreiber braucht keine weitere Migration. Er setzt vor dem Lauf `wird_gerechnet` (Beträge leer), danach `fertig`
mit allen Beträgen oder `fehlgeschlagen`/`nicht_unterstuetzt` mit `hinweis`; immer mit neuem `stand_seit`.
Gelöscht wird die Zeile mit der Anlage (`ON DELETE CASCADE`) oder im Offboarding.

**Der Schreiber** ist ein eigener Lauf des Optimierers, kein Dienst: `python -m voltpilot_optimization mispel-check
[--site <uuid>] [--max-anlagen 4] [--workers 2] [--neu] [--eingang]` (Rolle wie `plan`: das vertraute
Backend-Konto `POSTGRES_USER`). Er läuft **nie** im Prozess von `simulate-serve` — der Simulations-JobStore (ein
Auftrag zur Zeit) bleibt frei — und rechnet mit höchstens **zwei** Solver-Prozessen. Ein Postgres-Advisory-Lock
lässt nie zwei Läufe zugleich rechnen; ein zweiter Lauf endet sofort mit `{"lauf": "belegt"}`.

**Wann gerechnet wird** — je Lauf höchstens `--max-anlagen` Anlagen mit Speicher, zuerst die ohne Zeile:

| Grund | Bedingung |
|---|---|
| noch nie gerechnet | keine Zeile |
| verwaist | Zeile in `wird_gerechnet` (der Lauf hält den Lock — ein anderer rechnet nicht) |
| Datenbasis geändert | `formelsatz` oder `datenbasis` weicht von der neu ermittelten ab (Stammdaten, Zähler, Verlauf) |
| neues Preisfenster | `fertig` mit `fenster_bis` vor dem Ende des letzten vollen Monats |
| neuer Versuch | `fehlgeschlagen` seit mindestens 20 Stunden |

**Fenster:** die letzten zwölf vollen Kalendermonate (am 02.10.2026: 01.10.2025–30.09.2026).

**Datenbasis je Anlage** (`angabe`, in dieser Reihenfolge): `Förderweg`, `Speicher` (kWh), `Speicherleistung`
(kW, das Kleinere aus Lade- und Entladeleistung) aus den Stammdaten des Optimierers; `Jahresverbrauch` und
`Erzeugung im Jahr` **gemessen** aus `telemetry_rollup_1d`, wenn der Verlauf mindestens 90 % der Tage des Fensters
deckt (aufs Fenster hochgerechnet, `quelle` nennt die Tage), sonst `angenommen` (Verbrauch 60 000 kWh, Konzept
§ 3 a2; Erzeugung aus PV-Leistung und Wetter des Fensters). Die gemessene Erzeugung skaliert die simulierte PV-Reihe
(Form aus Wetter, Menge aus dem Verlauf). Ohne Preisblatt der Anlage sind `Netzentgelt-Arbeitspreis`, `Umlagen`,
`Konzessionsabgabe`, `Umsatzsteuer` die Gewerbe-Annahmen von MP-13 (`angenommen`); ohne Standort die Lage der
Simulation.

**Formelsatz:** der gewählte (`site_foerderweg`, `stammdaten`) — sonst aus den Zählerrollen der Messstellen, die
heute an der Anlage stehen, nach dem Gebot der Bestnutzung (Anlage 1 Abschn. 3.2.3, S. 24; wie der Vorschlag aus
MP-17), `angenommen` mit Satz in `quelle`:

| Anlage | Zähler | Formelsatz |
|---|---|---|
| mit Erzeugungsanlage | Z1, Z2, Z3 | A4 → `nicht_unterstuetzt` |
| mit Erzeugungsanlage | Z1 und Z2 — oder noch keine (Z2-Kosten stehen im Posten `zaehler_z2`) | A1 |
| ohne Erzeugungsanlage | Z1 und Z2 | A1 → `nicht_unterstuetzt` (A10/A11 ausgeschlossen, A1 rechnet nur mit Erzeugung) |
| ohne Erzeugungsanlage, mit sonstigem Verbrauch (oder ohne Messreihe) | nur Z1 | A11 (Anlage 1 Abschn. 10.3.1, S. 98) |
| ohne Erzeugungsanlage, ohne sonstigen Verbrauch (gemessen) | nur Z1 | A10 (Anlage 1 Abschn. 10.2.1, S. 95) |

`nicht_unterstuetzt` außerdem für jeden Formelsatz außer A1/A10/A11 und für A1 ohne anzulegenden Wert;
`fehlgeschlagen` mit Satz für widersprüchliche Stammdaten (A10/A11 mit PV-Anlage, A10 mit gemessenem Verbrauch)
und für jeden gescheiterten Lauf („Der Check konnte für diese Anlage nicht gerechnet werden: …“).

**Dieselbe Eingabe, derselbe Betrag:** `mispel-check --eingang` gibt je Anlage die Eingabe aus; die MP-13-
Kommandozeile rechnet sie mit `--anlage <datei> --beginn <JJJJ-MM> --monate 12` nach. Grenze: im Mischbetrieb (A1)
fällt ein Lösungslauf nach `MISCHBETRIEB_ZEITGRENZE_S` (20 s, `solver.py`) auf „ohne Gutschrift“ zurück — unter
Last können zwei Läufe derselben Eingabe darum um einige Euro abweichen (Solver-Laufzeit: MP-33b).

**Betrieb:** der Lauf braucht einen Cluster-Job (z. B. nächtlich, `concurrencyPolicy: Forbid`) mit dem Image und
den Datenbank-Variablen des Optimierers und Zugang zu `archive-api.open-meteo.com` — angelegt im gitops-Repo vom
Betreiber, nicht hier.
