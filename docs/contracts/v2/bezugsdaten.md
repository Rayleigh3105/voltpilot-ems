# Bezugsdaten-Vertrag: aus einer gelieferten Zeile wird ein Wert (UEMS AP-09)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap09-bezugsgroessen` §4 (U1–U6, Z1–Z7,
F1–F6, C1–C9, K1–K7, Invarianten 1–12), Entscheide E1–E17 vom 12.09.2026 · Beispielwelt
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Kunststoffwerk Ahrenberg
GmbH).

Eine **Bezugsgröße** ist die Zahl, mit der Energie verglichen wird: 312 400 kg Granulat,
48 200 Gutteile, 3 100 m² Halle, 4,97 Stunden Ladezeit. Dieser Vertrag sagt, wie aus einer
gelieferten Zeile — getippt oder aus einer CSV-Datei — so ein Wert wird. Und, mindestens
genauso wichtig: **wann er keine Zahl wird, sondern ein Befund.**

**Die Regel steht nicht in diesem Text, sie steht in der Vektor-Datei.** Dieses Dokument
erklärt, was dort steht, und benennt die Fallen; es ist bewusst **keine zweite
Regelbeschreibung**, die von der Datei wegdriften könnte. Wo Text und Datei sich
widersprechen, gilt die Datei.

| Datei | Rolle |
|---|---|
| [`bezugsdaten-vectors.json`](./bezugsdaten-vectors.json) | **die eine Wahrheit**: 14 handgerechnete Referenzfälle (B1–B14) mit Eingang und erwartetem Ergebnis je Prüfung |
| [`bezugsdaten.schema.json`](./bezugsdaten.schema.json) | das Schema für Eingang, Ergebnis und die Vektor-Datei selbst (JSON-Schema 2020-12) |
| `services/api/.../uems/BezugsdatenRegeln.java` | der **Java-Zwilling** (rein: ohne Spring, ohne DB, ohne Uhr) |
| `frontend/portal/src/bezugsdaten.ts` | der **TypeScript-Zwilling** (rein: dieselben Regeln für die Vorschau im Portal) |
| `…/uems/BezugsEinheit.java` ⟷ `…/src/bezugsEinheit.ts` | seit **AP-09 IP-3** das eigene Modul der Regel `einheit` (Vokabular je Größe, feste Faktoren, Synonyme) — die Zwillinge oben RUFEN es an |
| `…/uems/BezugsPeriode.java` ⟷ `…/src/bezugsPeriode.ts` | seit **AP-09 IP-3** das eigene Modul der Regeln `periode`, `zeit` und `stunden` (Deutung, Zeitzone des Standorts, 23/25 h) |
| `…/uems/BezugsdatenVectorsTest.java` · `…/src/bezugsdaten.test.ts` | beide fahren DIESELBE Vektor-Datei, per Pfad |
| `…/uems/BezugsEinheitTest.java` · `…/BezugsPeriodeTest.java` ⟷ `…/src/bezugsEinheit.test.ts` · `bezugsPeriode.test.ts` | dieselben Familien noch einmal, DIREKT am Modul — plus die Zusagen ohne Referenzfall |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> **Wer anruft (Stand AP-09 IP-3): niemand.** Dieses Paket legt die Wahrheit fest, gegen die
> IP-4 … IP-19 gebaut werden. Es gibt keine Tabelle, keine Route, keine Portal-Fläche und
> keinen CSV-Leser; die Kern-Telemetrie, ihre Verdichtungen, das Cockpit, die Erlöse und der
> Messwert-Export sind unberührt. Der **Messwert-Herkunftsvertrag**
> ([`messwert-herkunft.md`](./messwert-herkunft.md)) ist ausdrücklich NICHT angefasst: E3
> entscheidet, dass die Bezugsdaten ihren **eigenen** Vertrag bekommen.

## 1. Warum es zwei Umsetzungen gibt

Dieselbe Regel wird an zwei Stellen gebraucht: der Server entscheidet, was gespeichert wird
(IP-5 … IP-13), und das Portal zeigt die **Vorschau**, bevor irgendetwas gespeichert ist
(IP-15/IP-16) — „312.400,0 kg wurden gelesen als 312 400 kg“, „diesen Zeitpunkt gibt es an
diesem Tag zweimal“, „1 von 3 Zeilen übernehmen“. Zwei Umsetzungen einer Regel driften
auseinander, sobald sie nicht beide gegen dieselbe Datei geprüft werden — dasselbe Muster wie
beim Messstellen-Vertrag (`messstelle-vectors.json` mit `uems/MessstelleRegeln` ⟷
`uemsMessstelle.ts`) und beim Verbrauchsvertrag (`verbrauch-vectors.json` mit
`uems/VerbrauchRegeln` ⟷ `voltpilot_optimization/verbrauch.py`).

**`zwillinge` in der Datei sagt je Regel, wer sie prüft.** Vier Regeln haben bewusst keinen
TypeScript-Zwilling, und `zwillinge_grund` nennt je Regel den Grund: `fassung` (Fassungen,
Vier-Augen, Rücknahme sind der Schreibweg des Servers), `stammdatum` (der Stichtag wird im
Lesemodell gelesen), `kanal` (die Zustandsdauer entsteht aus Rohwerten, die das Portal nie
sieht) und `menge` (dazu unten). Beide Zwillings-Tests lesen diese Angabe und prüfen genau
die Regeln, die sie nennt — **eine Regel, die nur eine Seite kennt, ist deklariert und nicht
stillschweigend übersprungen.** Beide Tests sind grün; es gibt keinen roten und keinen
ausgeschalteten Test.

## 2. Die Menge rechnet dieser Vertrag NICHT

Zwei Zahlen dieses Pakets kommen aus dem schon gemergten **Verbrauchsvertrag** AP-08:

- die **Menge eines Ablesezeitraums** (B8: 49 451 m³ − 48 211 m³ = 1 240 m³) aus
  `VerbrauchRegeln.mengeZaehlerstand` — mit allem, was dort schon gilt: ein kleinerer Stand
  ist eine Rücksetzung und macht die Periode unvollständig, statt eine negative Menge zu
  erzeugen;
- die **Länge einer Periode in Stunden** aus `VerbrauchRegeln.stunden` — am Umstellungstag
  23 oder 25 Stunden, nie 24 (B10).

Sie werden **aufgerufen, nicht nachgebaut.** Zwei Zahlen für dieselbe Aussage wären genau die
Drift, die diese Verträge verhindern sollen. Aus demselben Grund sind die Zustandswörter
`vollständig` · `unvollständig` · `keine Werte` wörtlich die der Verbrauchsregel, und der
Java-Test prüft das.

## 3. Die dreizehn Regeln

Je Prüfung nennt die Datei ihre `regel`, ihren `eingang` und ihr `ergebnis`. Was die Regeln
tun, in einem Satz:

| Regel | Was sie beantwortet |
|---|---|
| `zahl` | U4/U5: Was ist „312.400,0“ für ein Betrag — und wann ist ein Text keine Zahl? |
| `einheit` | U1–U3: Was ist „312,4 t“ in einer Bezugsgröße, die kg führt? |
| `periode` | Z1–Z4: Für welche Periode gilt „2026-10“, „31.10.2026“, „28.09.–04.10.2026“ — und passt sie überhaupt? |
| `zeit` | Z5/E7: Welcher Zeitpunkt ist „25.10.2026 02:30“ ohne Zone? |
| `stunden` | P3: Wie lang ist ein Kalendertag? (aus der Verbrauchsregel) |
| `plausibilitaet` | U6: Ist dieser Betrag auffällig — und ist er überhaupt erlaubt? |
| `zuordnung` | Z6/E5: Zu welchem Kalendermonat gehört ein Ablesezeitraum? |
| `urteil` | C5/§4.7: Ist diese Zeile neu, eine Wiederholung, ein Konflikt — oder abgelehnt? |
| `import` | C4/C6: Was sagt die Vorschau, und was würde die Übernahme schreiben? |
| `menge` | Die Menge eines Ablesezeitraums (aus der Verbrauchsregel) |
| `fassung` | F1–F4/C7: Welche Fassungen hat dieser Wert — und welche ist wirksam? |
| `stammdatum` | E17: Welchen Wert hat die Fläche für die Periode Oktober 2026? |
| `kanal` | K1–K7: Wie lange war der Ladepunkt „Charging“? |

Die **Prüfreihenfolge** (`regeln.pruefreihenfolge`) ist Teil des Vertrags und
**ergebnisrelevant**: Zahl → Einheit → Periode → Zeit → Bezug → Schlüssel. In B13 wird die
Zeile mit „lbs“ abgelehnt, *bevor* ihr Schlüssel mit der anderen Zeile derselben Datei
verglichen wird; in der umgekehrten Reihenfolge wären beide Zeilen als widersprüchliches Paar
abgelehnt und die Datei hätte ein anderes Ergebnis.

## 4. Die Fallen

**Eine Wiederholung schreibt nichts.** Derselbe Schlüssel mit demselben Betrag ist eine
Wiederholung (`aenderungen: 0`) — dieselbe Datei zweimal hochgeladen verdoppelt keine Menge
(Plan-Abnahme 1, B2). Ein *anderer* Betrag ist ein **Konflikt**, der eine Entscheidung
braucht; die Vorgabe ist „behalten“. `entscheidung: null` heißt „noch nicht entschieden“ und
ersetzt nie etwas — **es gibt keinen Weg, bei dem ein gespeicherter Wert still verschwindet**
(E9, Invariante 2).

**„312,4 t“ und „312,4 kg“ sind zwei verschiedene Zeilen.** Der Schlüssel vergleicht den
*umgerechneten* Betrag: 312,4 t sind dieselbe Zeile wie 312 400 kg (Wiederholung), 312,4 kg
sind ein Konflikt (B9). Umgerechnet wird nur innerhalb derselben Größe mit dem Faktor aus
`umrechnung`, in beiden Richtungen. Eine Einheit derselben Größe **ohne** Eintrag ist keine
Umrechnung, sondern eine Annahme — sie wird abgelehnt wie „lbs“ und „Paletten“ (B13). Es gibt
keinen Faktor „Palette → Stück“, weil niemand ihn kennt.

**Eine Periode wird nie geteilt.** KW 40 (28.09.–04.10.2026) passt nicht in eine Monatsreihe:
`periode_passt_nicht`. Nicht 3/7 September + 4/7 Oktober, nicht „Oktober, weil mehr Tage
darin liegen“ — beides wäre eine Menge, die niemand gemessen hat (Z2, Invariante 3, B11).

**Die doppelte Stunde wird nicht geraten.** „25.10.2026 02:30“ ohne Zone gibt es zweimal:
`zeit_mehrdeutig`, und die Regel zeigt **beide** Möglichkeiten, statt eine zu wählen.
„28.03.2027 02:30“ gibt es nicht: `zeit_nicht_vorhanden` — und wird nicht auf 03:30
verschoben. Ein Offset in der Datei gewinnt immer (Z5, B10).

**Die Ablesung wird zugeordnet, nicht gerechnet.** Ein Ablesezeitraum vom 01.10. 07:15 bis
zum 02.11. 07:40 ist 32 Tage 1 h 25 min lang und berührt zwei Monate; die Vorgabe ist der
Monat mit dem größten *zeitlichen* Anteil (Oktober, 95,9 %), und der Kunde darf sie ändern
oder „keinem Monat zuordnen“. Ab drei berührten Monaten gibt es **keine** Vorgabe. Der
Ablesezeitraum wird nie auf Tage verteilt: der 20.10. hat „keine Werte“, nie 0 m³ (Z6/E5,
AP-08 E13, B8).

**Ein Stammdatum wird zum Stichtag gelesen.** Die Fläche von Halle 2 steigt am 01.01.2027 von
3 100 auf 3 400 m², eingetragen am 15.01.2027 (rückwirkend, 14 Tage). Oktober und Dezember
2026 lesen weiter 3 100 m² — ihre Kennzahlen bleiben, und es entsteht **kein** Ereignis für
sie (Plan-Abnahme 2, E17, B6). Eine Periode ohne gültiges Intervall hat „keine Werte“, nie 0.

**„keine Werte“ ist nie 0.** Ein Tag ohne Werte am Zustands-Kanal hat keine Ladezeit — nicht
0 h (K4, B7). Eine zurückgenommene Fassung hat keinen Betrag — nicht 0 (C7, B14).

**Die Abdeckung eines Kanal-Werts ist ZEITBASIERT.** 23 von 24 gemessenen Stunden sind
95,8 %. Die Abdeckung der Verbrauchsregel ist *wertbasiert* und abgeschnitten (erhaltene ÷
erwartete Werte, AP-08 Z9). Zwei verschiedene Zahlen mit demselben Namen — die Datei hält
beide Nachkommastellen-Regeln getrennt (`abdeckung_nachkommastellen`).

**Nichts wird gelöscht.** Jede Änderung ist eine Fassung n + 1 mit Begründung (≥ 10 Zeichen);
Fassung n bleibt lesbar. Mit eingeschaltetem Vier-Augen-Prinzip (AP-08 E8, Vorgabe AUS) ist
die neue Fassung ein `vorschlag`, bis eine **zweite** Person freigibt — der Urheber kann sich
nie selbst freigeben. Eine **Rücknahme** ist ebenfalls nur die nächste Fassung: ohne Betrag,
wenn sie einen Erstwert trifft; mit dem Betrag der Vorfassung, wenn sie eine Berichtigung
trifft (F1–F4, C7, B14).

**Die Vorschau schreibt nichts.** Eine Datei ohne Datenzeilen hat keine Übernahme und
hinterlässt nicht einmal einen Import-Datensatz (B12). Werden nicht alle Zeilen übernommen,
verlangt E10 eine ausdrückliche Bestätigung mit der Zahl: „1 von 3 Zeilen übernehmen“.

## 5. Was hier NICHT steht

Die Datei trennt drei Dinge sauber:

- **`pruefungen`** — was ein Zwilling nachrechnet. 78 Prüfungen über 14 Fälle.
- **`beschreibend`** — was die Vorlage erwartet, aber keine reine Regel dieses Pakets bildet:
  Anzeigesätze, die Herkunfts-Angaben je Wert (Spalten der Tabelle aus IP-4), die
  Kennzahlen (AP-11 bildet sie, nicht dieser Vertrag) und die Lesemodell-Aussagen aus IP-8.
- **`_nicht_geprueft`** — je Eintrag, *warum* keine reine Regel ihn prüfen kann und welches
  Paket ihn einlöst. Eine Erwartung der Vorlage verschwindet nie, nur weil heute niemand sie
  prüft.

Bei den beiden Plan-Abnahmen ist genau der geprüfte Teil der Kern: bei B2 ist es der
unveränderte Betrag 312 400 kg samt `aenderungen: 0`, bei B6 der **Nenner** 3 100 / 3 100 /
3 400 m². Die Division daraus ist AP-11.

Ebenfalls nicht hier: der CSV-Leser (C1: Kodierung, Trennzeichen, RFC 4180, SHA-256 — IP-11),
die Tabellen (IP-4), die Routen (IP-5 ff.), die Portal-Flächen (IP-9 ff.) und die
Rechte-Zeilen (W8, IP-5). Dieser Vertrag beginnt bei der schon zerlegten Zeile; ob eine Datei
bekannt ist, bekommt die Regel `urteil` als Eingang.

## 6. Herkunft der Zahlen

Die Datei ist **erzeugt** aus `data/vp-uems-ap09-bezugsgroessen/referenzfaelle.json` (14
Fälle, handgerechnet und nachgerechnet von `k_faelle.py`), nicht abgeschrieben. Jeder Fall
trägt seine Kennung, seine Familie, seinen Titel, seinen Zweck (`why`), seinen
Plan-Abnahme-Bezug, die Handrechnung (`schritte`, byte-gleich) und seine `annahmen` — alles,
was **nicht** aus dem Referenzunternehmen stammt, steht dort.

`_abweichungen` nennt jede Stelle, an der die Datei bewusst von der Vorlage abweicht, mit
Feld, Vorlagenwert, neuem Wert und Grund — heute drei, alle ohne Wirkung auf ein Ergebnis der
Vorlage.

`referenz_stand` sagt, was das Referenzunternehmen noch nicht kennt: BZ-5 „Ladezeit Ladepunkt
Halle 2“, die Ablesungen an MS-21 und die Einheiten-Kennungen trägt **IP-2** dort nach.
