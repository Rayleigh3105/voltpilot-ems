# UEMS-Bezugsdaten: Einheiten und Perioden als reine Module (AP-09 IP-3)

Angelegt am 12.09.2026. IP-1 hat die Bezugsdaten-Regeln als **eine** Datei je Sprache abgelegt,
damit die 14 Referenzfälle prüfbar sind ([`uems-bezugsdaten-vertrag-java-ts-zwill.md`](./uems-bezugsdaten-vertrag-java-ts-zwill.md)).
Dieses Paket schneidet daraus **zwei eigenständige, wiederverwendbare Module** heraus — später
brauchen sie viele Stellen: der Import (IP-11 ff.), die Eingabe (IP-7), die Kennzahlen und die
Berichte. Ein Modul, das jeder aufruft, statt vier Kopien derselben Umrechnung.

| Sprache | Einheiten (U1–U5) | Perioden und Zeitpunkte (Z1–Z5) | exakte Dezimalrechnung |
|---|---|---|---|
| Java | `services/api/.../uems/BezugsEinheit` | `…/uems/BezugsPeriode` | JDK-`BigDecimal` |
| TypeScript | `frontend/portal/src/bezugsEinheit.ts` | `…/src/bezugsPeriode.ts` | `…/src/dez.ts` |

Beide Module sind **rein**: ohne Spring, ohne Datenbank, ohne Netz und ohne Uhr — „jetzt“ und die
Zeitzone werden übergeben. Der Vertrag bleibt `docs/contracts/v2/bezugsdaten-vectors.json`
(Familien `einheit`, `periode`, `zeit`, `stunden`); die Datei wurde für dieses Paket **nicht
angefasst**, und ihre Fälle sind vorher wie nachher grün.

## Die drei Regeln, die man kennen muss

- **Die Umrechnungsgrenze (E4/U1): nur innerhalb derselben Größe, nur mit festem Faktor.** Das
  Vokabular ist geschlossen und gilt JE GRÖSSE (Masse `kg`/`t` · Stückzahl `Stück` · Zeit
  `h`/`min` · Fläche `m²` · Volumen `m³`/`l` · Personen · Schichten · Gradtage `Kd` ·
  Temperatur `°C`). Gerechnet wird ausschließlich mit den Faktoren aus `umrechnung`
  (t ↔ kg × 1 000, l ↔ m³ ÷ 1 000, min ↔ h ÷ 60), in beide Richtungen, **exakt**: 312,4 t sind
  genau 312 400 kg. Alles andere — ein fremdes Wort (`lbs`, `Paletten`), eine andere Größe, oder
  dieselbe Größe ohne Faktor im Vertrag — ist `einheit_unbekannt` und wird abgelehnt. **Ein vom
  Kunden eingegebener Faktor ist ausgeschlossen:** „48 Stück je Palette“ ist eine Annahme, und
  eine Annahme, die im Wert verschwindet, ist später nicht mehr von einer Messung zu
  unterscheiden. Ein **Synonym** einer Vorlage („Stk“ = Stück, „Std“ = h) ist eine
  Text-Ersetzung VOR der Prüfung — es ändert das Wort, nie den Betrag, und erweitert das
  Vokabular nicht.
- **Die Zeitzone ist die des STANDORTS (E7/Z1/Z5).** Ein Zeitstempel ohne Zone wird in der
  Zeitzone des Standorts gelesen; eine Vorlage darf eine feste Zone oder UTC setzen, und ein
  Offset in der Datei gewinnt immer. Deshalb nimmt jede Funktion die Zone als Parameter — keine
  liest sie aus Maschine oder Browser.
- **„Passt nicht“ ist etwas anderes als „noch nicht zu Ende“.** `periode_passt_nicht`: der
  gelieferte Zeitraum ist keine Periode dieser Bezugsgröße (KW 40 in einer Monatsreihe) — er
  wird NIE geteilt, verteilt oder nach Mehrheit zugeordnet. `periode_nicht_zu_ende` (Z4/E16):
  die Periode läuft noch; nichts ist falsch an ihr, sie kommt später wieder. Zwei Befunde, zwei
  Kundensätze, zwei verschiedene nächste Schritte des Kunden — nie einer.

## Die Fallen

- ⚠ **Ein Tag hat nicht 24 Stunden.** An den Umstellungstagen 23 oder 25 (25.10.2026: 25 h,
  28.03.2027: 23 h), und ein Oktober mit Rückstellung hat 745 statt 744. Java **bestellt** die
  Zahl bei der Verbrauchsregel AP-08 (`VerbrauchRegeln.stunden`) statt sie ein zweites Mal zu
  zählen; im Portal gibt es diese Regel nicht, dort zählt `bezugsPeriode.ts` den Abstand zweier
  Mitternachten — aber nur dort. Nie `24 × 3600`.
- ⚠ **Der mehrdeutige und der nicht existierende Zeitpunkt sind BEFUNDE, keine Wahl.** In der
  doppelten Stunde am Sommerzeit-Ende reisen BEIDE Möglichkeiten in `varianten` mit
  (`zeit_mehrdeutig`); in der fehlenden Stunde am Sommerzeit-Beginn gibt es keine
  (`zeit_nicht_vorhanden`) — und „02:30“ wird nie still auf „03:30“ verschoben.
- ⚠ **Die Kundensätze wohnen IM MODUL** (`BezugsEinheit.SAETZE` / `BezugsPeriode.SAETZE`, TS
  gleich), nicht in der Fläche: eine Formulierung, nicht zwei. Jeder Modultest prüft sie Wort
  für Wort gegen `befund_saetze` der Vektor-Datei — wer den Satz nur an einer Stelle ändert,
  wird rot.
- ⚠ **Jeder Betrag reist als DEZIMALTEXT und wird NUMERISCH verglichen.** Java rechnet mit
  `BigDecimal` (und `stripTrailingZeros`), TypeScript mit der ganzzahligen Mantisse aus
  `dez.ts`. Die beiden Darstellungen sind NICHT textgleich: dieselbe Zahl heißt in Java
  `312.4` und in TS `312.400`. Wer zwei Beträge vergleicht, nimmt `dezVergleich`, nie den Text.
- `dez.ts` steht neben den beiden Modulen statt in einem von ihnen, damit es die Rechnung nur
  EINMAL gibt und keines der beiden Module das andere anrufen muss (in Java stellt das JDK die
  Klasse). `bezugsdaten.ts` **reicht alles weiter** (`export … from`), damit die Fläche EINEN
  Einstieg behält.

## Es bleibt keine zweite Fassung

`BezugsdatenRegeln` und `bezugsdaten.ts` **rufen** die Module an — auch der Stichtag eines
Stammdatums holt seine Periodenspanne aus `BezugsPeriode.spanneVon`. Vier Tests lesen dafür den
Quelltext der alten Datei und verlangen, dass die herausgelöste Rechnung dort nicht wieder
auftaucht (`scaleByPowerOfTen`, `getValidOffsets`, `IsoFields`, `MONATSNAMEN`, `longOffset`).

## Es ändert sich kein Verhalten

Nachweis: `BezugsdatenVectorsTest` (89 Tests) und `bezugsdaten.test.ts` (70 Tests) laufen mit
UNVERÄNDERTEN Erwartungen weiter — die TS-Testdatei wurde gar nicht angefasst, in Java nur vier
Import-Zeilen. Nichts ruft die Module aus einem Produktionsweg an; es gibt weiterhin keine
Tabelle, keine Route, keine Portal-Fläche und keinen CSV-Leser (die kommen mit IP-4 ff.).

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='BezugsEinheitTest,BezugsPeriodeTest,BezugsdatenVectorsTest')
(cd frontend/portal && npx vitest run src/bezugsEinheit.test.ts src/bezugsPeriode.test.ts src/bezugsdaten.test.ts)
```
