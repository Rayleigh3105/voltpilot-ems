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
| `…/uems/BezugsArt.java` ⟷ `…/src/bezugsArt.ts` (Tests `BezugsArtTest` · `bezugsArt.test.ts`) | seit dem **13.09.2026** das Vokabular der ARTEN (Block `arten`, §8) — ruft das Einheiten-Modul an; noch ruft niemand das Modul an |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> **Wer anruft (Stand AP-09 IP-5):** die Bezugsgrößen-Schnittstelle `/api/v1/bezugsgroessen`
> — sie urteilt über Anlegen, Ändern, Archivieren und Löschen mit `uems/BezugsgroesseRegeln`
> (Block `verwalten`, §7) und liest den Stand einer Fassungskette mit
> `BezugsdatenRegeln.fassungen`. Werte schreibt noch niemand (IP-7), es gibt keine
> Portal-Fläche und keinen CSV-Leser; die Kern-Telemetrie, ihre Verdichtungen, das Cockpit, die Erlöse und der
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
Lesemodell gelesen), `stammdatum_eintrag` (ein Wert ab einem Tag ist der Schreibweg des Servers,
AP-09 IP-6), `kanal` (die Zustandsdauer entsteht aus Rohwerten, die das Portal nie
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
| `stammdatum` | E17/S3: Welchen Wert hat die Fläche für die Periode Oktober 2026 — und welcher Übergang liegt in der Periode? |
| `stammdatum_eintrag` | E15/S4: Was ändert ein neuer Wert ab einem Tag an den Intervallen eines Stammdatums? |
| `kanal` | K1–K7: Wie lange war der Ladepunkt „Charging“? |
| `vorschau` | C2–C5/C8 (seit IP-12, §10): Was sagt die Vorschau über eine ganze Datei — je Zeile, je Datei, mit beiden Fingerabdrücken? |

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

**Ein Übergang in der Periode wird genannt, nicht gemittelt (S3, nachgetragen mit AP-09 IP-6).**
Ändert sich ein Stammdatum NACH dem ersten Tag einer Periode (bis einschließlich zum Stichtag),
trägt die Periode je Übergang ein Kennzeichen aus `stammdatum_saetze`: „Fläche geändert am
01.01.2027 (3.100 → 3.400 m²)“ (Woche 2026-W53), „Fläche erst ab 01.10.2026 erhoben
(3.100 m²)“ (Jahr 2026), „Fläche nur bis 31.12.2026 erhoben (3.100 m²)“ — dann ist der Stichtag
„keine Werte“. Gelesen wird trotzdem nur der Stichtag; ein zeitgewichtetes Mittel ist eine
AP-11-Formel. Ein Übergang GENAU am ersten Tag liegt nicht in der Periode (Januar 2027 liest
3 400 m² ohne Kennzeichen). Die Zahl steht wie jede angezeigte Zahl (Tausenderpunkt, Komma),
ungerundet.

**Ein Stammdatum, das AP-09 selbst hält, folgt dem Flächen-Muster (S4, E15).** Mitarbeitende
u. a. stehen in `bezugsgroesse_stammdatum` mit „gültig ab“ und LETZTEM Tag; die Regel
`stammdatum_eintrag` ist dieselbe Mechanik wie die Fläche der Ortsstruktur
(`OrtsbaumAbleitung.flaecheEintrag`, `StammdatumEintragWieFlaecheTest` hält beide aneinander):
das laufende Intervall endet am VORTAG, das neue erbt dessen Ende; ein Wert am Beginntag eines
Intervalls ist eine Korrektur (aufgehoben, lesbar); derselbe Wert ändert nichts. Die
Verwaltung prüft in `verwalten.pruefreihenfolge.stammdatum`: `archiviert` → `kein_stammdatum`
(S1) → `flaeche_aus_struktur` (M4) → `wert_ungueltig` (Zahl größer als 0 — „nicht erhoben“ ist
keine Zeile). ⚠ Eine **Bezugsfläche** wird nie hier gespeichert: sie wird aus der Ortsstruktur
GELESEN (E17) — `GET /api/v1/bezugsflaechen`.

**„keine Werte“ ist nie 0.** Ein Tag ohne Werte am Zustands-Kanal hat keine Ladezeit — nicht
0 h (K4, B7). Eine zurückgenommene Fassung hat keinen Betrag — nicht 0 (C7, B14).

**Die Abdeckung eines Zustandskanal-Werts ist ZEITBASIERT.** 23 von 24 gemessenen Stunden sind
95,8 %. Die Abdeckung der Verbrauchsregel ist *wertbasiert* und abgeschnitten (erhaltene ÷
erwartete Werte, AP-08 Z9). Zwei verschiedene Zahlen mit demselben Namen — die Datei hält
beide Nachkommastellen-Regeln getrennt (`abdeckung_nachkommastellen`).

**Gradtage (K7, AP-09 IP-18).** Ein gemessener Temperaturkanal (`gauge`,
`quantity=temperature`, °C) am Standort der Bezugsgröße liefert Gradtage in Kd; seit AP-17
E9 = C auch die von VoltPilot bezogene Tagesreihe (§ „Wetter-Archiv“ unten).
Vorhersage-Wetter ist keine Messquelle. AP-08 M1–M6 bildet das Tagesmittel über gute
Rohwerte in der Ortszone einschließlich 23-/25-Stunden-Tagen. Die Heizgrenze wird gegen
das ungerundete Mittel geprüft, nicht gegen AP-08s auf 0,1 gerundete Anzeige. Unterhalb der Heizgrenze
zählt `Raumtemperatur − Tagesmittel`, an oder über der Heizgrenze 0 Kd. Vorgabe G20/15;
Raumtemperatur und Heizgrenze werden je Bindung der Bezugsgröße dauerhaft gespeichert.
Ein fehlendes Tagesmittel liefert keinen Betrag. Die Summe vorhandener Tage bleibt
„unvollständig“, wenn ein Tagesmittel fehlt oder unvollständig ist; ohne Tagesmittel bleibt
sie NULL. Die Abdeckung der Temperatur übernimmt AP-08s wertbasierte Tagesabdeckung,
gewichtet nach tatsächlicher Tageslänge. Ein angeschnittener Kalendertag liefert keinen
vollen Gradtag; das Kennzeichen nennt fehlende oder unvollständige Tagesmittel.
`GradtagRegeln` und `gradtage.ts` prüfen die konstruierten Annahmen in B7 (`kanal`,
Regel `gradtage`); das Portal zeigt gespeicherte Zahlen und rechnet keine Rohwerte.

**Nichts wird gelöscht.** Jede Änderung ist eine Fassung n + 1 mit Begründung (≥ 10 Zeichen);
Fassung n bleibt lesbar. Mit eingeschaltetem Vier-Augen-Prinzip (AP-08 E8, Vorgabe AUS) ist
die neue Fassung ein `vorschlag`, bis eine **zweite** Person freigibt — der Urheber kann sich
nie selbst freigeben. Eine **Rücknahme** ist ebenfalls nur die nächste Fassung: ohne Betrag,
wenn sie einen Erstwert trifft; mit dem Betrag der Vorfassung, wenn sie eine Berichtigung
trifft (F1–F4, C7, B14).

**Die Vorschau schreibt nichts.** Eine Datei ohne Datenzeilen hat keine Übernahme und
hinterlässt nicht einmal einen Import-Datensatz (B12). Werden nicht alle Zeilen übernommen,
verlangt E10 eine ausdrückliche Bestätigung mit der Zahl: „1 von 3 Zeilen übernehmen“.

### Betriebszeit aus Leistung (AP-16 E9 = A)

Seit 22.09.2026 ergänzt `betriebszeit_aus_leistung` die bestehenden Arten (AP-09 E13,
Lesart LA6). Einheiten h/min, Tag/Woche/Monat, Geltung Prozess/Bereich/Messstelle,
ausschließlich Herkunft `messkanal`. Statuskanal und Handeingabe der Art `betriebszeit`
bleiben bestehen; keine bestehende Bezugsgröße wird umgedeutet.

Die vorhandene Route `POST /api/v1/bezugsgroessen/{id}/kanalbindung` nimmt bei dieser Art
`messstelle_id`, `schwelle_kw` (nicht negativ), `von` (volle Minute, inklusive) und
`begruendung` (10–2000 Zeichen) entgegen. `entity_id` und `kanal` werden aus genau einer
führenden Wirkleistungsquelle der Messstelle gelesen; falls mitgesendet, müssen sie passen.
Der Katalog muss `gauge`, `active_power`, W oder kW bestätigen. Der Akteur kommt aus der
Anmeldung; Recht `bezugsgroesse.verwalten`, Quellstandort zusätzlich sichtbar, fremd = 404.
GET liest mit `messwerte.ansehen` dieselben Fassungen einschließlich Grund und `regel`.

Fassung n+1 beendet n am neuen `von`; sie trägt `fassung` und `ersetzt_bindung_id`.
Schwelle, Quelle, Grund und Akteur werden niemals überschrieben. Der bestehende Schutz
gegen Neubinden über bereits gebildete Periodenwerte gilt weiter. Minutenintervalle
sind `[von,bis)`, also zählt am Wechsel genau die neue Schwelle. Jede Änderung ist im
vorhandenen Bezugsgrößen-Protokoll. Die Datenbank erzwingt die Fassungsfolge und Art.

`BetriebszeitRegeln` ⟷ `betriebszeit.ts`: Zeit mit **Leistung > Schwelle**, W vorher in kW.
Rohwerte gelten höchstens eine gespeicherte Messkadenz und enden früher beim nächsten
Rohwert; keine Interpolation über Lücken. Schlechte Werte, explizite Lücken, ausgelaufene
Kadenz und Zeiten ohne gültige Quelle zählen weder als Betrieb noch als Stillstand.
Abdeckung = gemessene Zeit / Periodendauer; keine gemessene Zeit ergibt NULL/„keine Werte“,
Teilabdeckung „unvollständig“, gemessener Stillstand darf 0 sein. Stunden werden mit sechs
Nachkommastellen gespeichert. Disjunkte Fassungsabschnitte werden je Periode summiert.

Jede Zahl trägt **„aus Leistung über x kW (Annahme)“** in `kennzeichen` (Dezimalkomma).
Eine Periode mit mehreren Schwellen nennt jede. Jede Kennzahl, die diese Zahl nutzt,
erbt alle Annahmen — auch über weitere Kennzahlen und gröbere Perioden. Das geschlossene
Kennzeichen-Vokabular steht in `ergebnis-zustand-vectors.json`, Schlüssel
`betriebszeit_annahme`, Rang 53. Lücken des neuen Nenners machen eine daraus gebildete
Kennzahl zur Obergrenze; bei fehlendem Nenner bleibt sie ohne Zahl.

Die E9-Prüfungen im B7-Block von `bezugsdaten-vectors.json` sind ausdrücklich konstruierte
Annahmen, keine neuen Ahrenberg-Messwerte: dieselben Leistungen liefern bei 5 kW 0,25 h,
bei 2 kW 0,75 h; ein Wechsel zur Monatsmitte bewahrt beide Kennzeichen; Lücken bleiben
sichtbar. API-Konfiguration gehört zu IP-26; das Portal zeigt die gespeicherten Zahlen und
Kennzeichen auf bestehenden Flächen, ohne einen neuen Schwellen-Dialog einzuführen.

### Wetter-Archiv (AP-17 E9 = C)

Seit 23.09.2026 hat die Gradtagzahl eine dritte Herkunft neben Messkanal und Import:
**`bezogen`** — das Tagesmittel der Außentemperatur je Standort, von VoltPilot aus einem
Wetter-Archiv bezogen, nicht vom Kunden belegt. Die Quelle ist Konfiguration des Betreibers
(Quelle, Lizenz, Schlüssel als gitops-Werte); zuerst das Open-Meteo-Archiv, die
DWD-Schnittstelle bleibt als zweite wählbar (LA1). Der Bezug läuft über die Koordinaten des
Standorts. Eine Temperatur-Datei des Kunden gibt es nicht (bewusst nicht gebaut).

- **Nur Archiv-Tage bis gestern.** Ein Tag ist nur dann ein Archiv-Tag, wenn er VOR dem
  Kalendertag des Abrufs in der Ortszone liegt. Heute und jeder spätere Tag wird nie
  geschrieben, auch wenn die Quelle ihn liefert — Vorhersage-Wetter bleibt ausgeschlossen
  (AP-09 E13, LA2). Ein Abruf am 03.11.2027 um 00:30 schreibt den 02.11., nie den 03.11.
- **Gradtage über die bestehende Regel.** Jedes Tagesmittel wird mit `GradtagRegeln` ⟷
  `gradtage.ts` zu Kd (Vorgabe G20/15); der Monat ist die Summe seiner geschriebenen Tage.
- **Kennzeichen an jeder Zahl.** Jeder Tages- und Monatswert trägt
  **„Temperatur von VoltPilot bezogen (Quelle, abgerufen am TT.MM.JJJJ hh:mm)“** — Abrufzeit
  in der Ortszone, ohne Sekunden. Ein Monat nennt je Quelle den spätesten Abruf seiner Tage.
  Das Kennzeichen ist `temperatur_bezogen`, Rang 54 im Kennzeichen-Vokabular von
  `ergebnis-zustand-vectors.json` (`kennzahl_kennzeichen`), geerbt: jede Kennzahl mit dieser
  Zahl als Nenner trägt es weiter — auch über weitere Kennzahlen und gröbere Perioden (R3).
  An der gespeicherten Fassung stehen Quelle und Abrufzeit wie beim Import die Kennung:
  `bezug_quelle`, `abgerufen_am` neben `herkunft_art: bezogen`.
- **Ausfall: der Tag fehlt, nie 0** (LA3). Liefert das Archiv einen Tag nicht oder ohne
  Tagesmittel, wird nichts geschrieben und nichts interpoliert. Der Monat ist
  `unvollständig` und trägt „x von y Tagen“ (y = Kalendertage des Monats). Der nächste
  Abruf holt den Tag nach; danach ist der Monat vollständig und nennt den späteren Abruf.
  Fehlt der ganze Monat, gibt es keine Zahl: Grund `variable_fehlt`.
- **Standort ohne Koordinaten: kein Abruf.** Kein Wert, Grund `variable_fehlt`, und der
  Satz aus AP-17 §5.8 (`UEMS_KOORDINATEN_FEHLEN_SATZ` in `glossar.ts`): „Für den Standort
  Lindach kann VoltPilot kein Wetter beziehen: die Koordinaten fehlen. Eine
  Wetterbereinigung über Gradtage ist hier erst möglich, wenn der Standort Koordinaten hat.“
- **Eine Quelle: keine Eingabe, kein Import** (Nachlese 1). Eine Gradtagzahl mit Zeile in
  `bezugsgroesse_wetterbezug` wird behandelt wie eine kanalgebundene: Eingabe
  (`POST …/werte`), Berichtigung, CSV-Übernahme (`POST /api/v1/bezugsdaten/importe`) und die
  Freigabe eines Vorschlags darauf lehnen mit 409 `wetterbezug_vorhanden` ab — für die ganze
  Bezugsgröße, nicht erst ab `von` — mit dem Satz „Diese Gradtagzahl bezieht ihr Wetter von
  VoltPilot. Werte werden hier nicht eingegeben oder importiert; lösen Sie zuerst den
  Wetterbezug.“ Nur der Abruf des Archivs schreibt. Eine Ablehnung schreibt nichts
  (`WetterbezugSperre`; Nachweis `BezugswertEingabeApiTest`, `BezugsdatenImportUebernahmeApiTest`).

`WetterArchivRegeln` ⟷ `wetterArchiv.ts` (Regel `wetter_archiv`, Prüfungen im B7-Block,
Block `wetter_archiv` der Vektor-Datei) sind reine Regeln: Grenze, Kennzeichen,
Vollständigkeit je Monat, Grund ohne Koordinaten. Der Archiv-Client, sein Abruf-Takt, die
Speicherung und die Migration, die `bezogen` in `bezugsdaten_vokabular()` und in die
Herkünfte der Art `gradtagzahl` aufnimmt, kommen mit IP-12b; die Standort-Zeile „Wetter“
im Portal mit IP-12c. Bis dahin spiegeln `vokabulare.herkunft_art` und `arten` die
Datenbank unverändert (`_nicht_geprueft`).

**Binden und lesen (IP-12c).** Der Kunde bindet eine Gradtagzahl selbst an das Archiv (Recht
`bezugsgroesse.verwalten`, wie die Kanalbindung):

- `PUT /api/v1/bezugsgroessen/{id}/wetterbezug` mit `von` (Tag, höchstens gestern; bei
  Monatswerten der Erste) und optional `raumtemperatur`/`heizgrenze` (Vorgabe G20/15). Nur
  Art `gradtagzahl`, Geltung Standort, Periodenart Tag oder Monat — sonst 422
  `art_passt_nicht`; ohne Koordinaten 422 `koordinaten_fehlen` mit dem Satz oben. Eine
  Bezugsgröße hat eine Quelle: mit Kanalbindung (`kanalbindung_vorhanden`), mit Werten
  anderer Herkunft (`werte_vorhanden`) oder mit einer anderen Wetter-Bindung
  (`wetterbezug_vorhanden`) 409; dieselbe Bindung noch einmal ist 200 ohne Änderung.
  Umgekehrt lehnt `POST …/kanalbindung` an einer Gradtagzahl mit Wetter-Bindung mit 409
  `wetterbezug_vorhanden` ab. Binden ruft nichts ab — der tägliche Läufer holt die Tage.
- `DELETE …/wetterbezug` löst die Bindung (204); die bezogenen Werte bleiben mit Kennzeichen.
  Protokoll `wetter_gebunden` / `wetter_geloest` im Änderungsprotokoll der Bezugsgröße.
- `GET …/wetterbezug` (Recht `messwerte.ansehen`): `moeglich`, `koordinaten`, ohne
  Koordinaten `satz`, und `bindung` mit Regel, `von`, `quelle`, `letzter_abruf` und `stand`
  des letzten Monats mit bezogenen Tagen („x von y Tagen“; bei Tageswerten zählt y ab `von`
  bis gestern, bei Monatswerten steht die gespeicherte Fassung).
- `GET /api/v1/standorte/{id}/wetter`: die Zeile „Wetter“ — Koordinaten ja/nein (ohne: der
  Satz), die gebundenen Gradtagzahlen im Zugriff und der späteste Abruf.

## 5. Was hier NICHT steht

Die Datei trennt drei Dinge sauber:

- **`pruefungen`** — was ein Zwilling nachrechnet. 100 Prüfungen über 14 Fälle (78 aus der Vorlage, seit IP-5 dazu 13 der Regel `verwalten`, seit IP-11 neun der Regel `csv`).
- **`beschreibend`** — was die Vorlage erwartet, aber keine reine Regel dieses Pakets bildet:
  Anzeigesätze, die Herkunfts-Angaben je Wert (Spalten der Tabelle aus IP-4), die
  Kennzahlen (AP-11 bildet sie, nicht dieser Vertrag) und die Lesemodell-Aussagen aus IP-8.
- **`_nicht_geprueft`** — je Eintrag, *warum* keine reine Regel ihn prüfen kann und welches
  Paket ihn einlöst. Eine Erwartung der Vorlage verschwindet nie, nur weil heute niemand sie
  prüft.

Bei den beiden Plan-Abnahmen ist genau der geprüfte Teil der Kern: bei B2 ist es der
unveränderte Betrag 312 400 kg samt `aenderungen: 0`, bei B6 der **Nenner** 3 100 / 3 100 /
3 400 m². Die Division daraus ist AP-11.

Ebenfalls nicht hier: den CSV-Leser C1 trägt seit IP-11 §9, die Vorschau mit beiden Fingerabdrücken
(C2) seit IP-12 §10, die Tabellen (IP-4), die Routen (IP-5 ff.), die Portal-Flächen (IP-9 ff.) und die
Rechte-Zeilen (W8, `rechte-matrix.json` seit IP-5). Dieser Vertrag beginnt bei der schon zerlegten Zeile; ob eine Datei
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

## 7. Verwalten einer Bezugsgröße (seit AP-09 IP-5)

Der Block **`verwalten`** trägt, was §4.2 des Konzepts als M1–M6 nennt und die Schnittstelle
`/api/v1/bezugsgroessen` braucht — nachgetragen, weil die Vorlage nur Werte rechnet:

- **`ablehnungen`** — der GESCHLOSSENE Satz der Ablehnungen mit Status (400 Form · 404 nicht da,
  auch fremd · 409 Zustand · 422 Regel) und **Kundensatz**. Keine Umsetzung schreibt einen
  eigenen Fehlertext; eine Ablehnung schreibt nichts. `einheit_unbekannt` ist dasselbe Wort
  mit demselben Satz wie der Befund.
- **`pruefreihenfolge`** je Vorgang (`anlegen` · `aendern` · `archivieren` · `loeschen`) — die
  erste nicht bestandene Prüfung ist die Antwort. Danach prüft der Schreibweg, ob das Objekt
  des Geltungsbereichs im Kundenbereich da ist (`geltung_unbekannt`).
- **`kennzeichen`** (M2) — `BZ-` und die Nummer nach der HÖCHSTEN je belegten, vierstellig;
  nie an eine andere Bezugsgröße weitergegeben, auch nicht das einer gelöschten.
- **`fest_nach_erstem_wert`** (M1) — Wertart, Einheit, Periodenart, Geltungsbereich; Name und
  Kennzeichen bleiben änderbar.
- **`lesarten`** — `GET …/{id}/werte?fassungen=wirksam|alle`.

Die Regel **`verwalten`** in den Fällen B4, B5, B6, B7, B8, B13 und B14 prüft das mit dem
Java-Zwilling `uems/BezugsgroesseRegeln`; das Portal hat dafür keinen Zwilling
(`zwillinge_grund`), aber `frontend/portal/src/bezugsgroesse.ts` spricht den Satz der
Ablehnungen und wird gegen diese Datei geprüft. ⚠ Welche Geltungsbereiche **wählbar** sind,
ist ein Eingang (`waehlbar`), kein Vokabular (E1 „wählbar, sobald gebaut“): seit AP-10 IP-7
haben auch Prozess und Kostenstelle ihr Objekt, die Schnittstelle wählt alle sieben; die Fälle mit
`waehlbar` ohne sie bleiben gültige Prüfungen der Regel. ⚠ Die **Art** („Produktionsmenge“,
„Gutteile“) prüft `verwalten` nicht: ihr Vokabular steht seit dem 13.09.2026 im Block `arten`
(§8), eine Spalte und ein Feld der Schnittstelle dafür gibt es nicht.

## 8. Die Arten einer Bezugsgröße (§4.2 des Konzepts, nachgetragen am 13.09.2026)

Der Block **`arten`** ist das Vokabular der Arten — die Schlüssel von `je_art`, in der
Reihenfolge der Konzept-Tabelle: Produktionsmenge · Gutteile · Betriebszeit · Schichten ·
Bezugsfläche · Mitarbeitende · Gradtagzahl · Zählerstand (Ablesung) · Sonstige Menge. Je Art
steht, was möglich ist: **Einheiten**, **Wertart**, **Perioden**, **Geltungsbereiche** und
**Herkünfte**. Daraus folgt, was der Anlege-Dialog (IP-9) zur Wahl stellt — aus der Art die
Einheiten und die Perioden.

- **Nur vorhandene Wörter.** Jede Angabe ist ein Wort von `einheiten` bzw. `vokabulare.wertart`
  · `periode_art` · `geltung_art` · `herkunft_art`. Keine Art bringt ein eigenes Wort mit, und
  keine Umsetzung führt eine zweite Liste: `BezugsArt` ⟷ `bezugsArt.ts` bekommen Arten und
  Vokabulare hereingereicht und fragen die Einheiten bei `BezugsEinheit` ⟷ `bezugsEinheit.ts`
  an. Beide Tests lesen die Quelltexte und verlangen, dass dort kein Wort steht.
- **Zwei Verweise statt Aufzählung.** `einheiten: "alle"` (Sonstige Menge: jede Einheit des
  Vokabulars), `einheiten: "messstelle"` (Zählerstand: die Einheit der Messstelle, die selbst im
  Vokabular stehen muss), `geltung: "alle"` (jedes Objekt). Leere `perioden` heißt: keine
  Periode — bei Stand und Stammdatum (M1).
- **`konzept`** hält die Zellen der Tabelle §4.2 Zeichen für Zeichen fest, auch die Beispiele aus
  Ahrenberg. Was nur dort steht, ist Beleg, keine Regel: die Zusätze „Dauer“, „Anzahl“,
  „abgeleitet“, die Kadenz „monatlich“ und die Art des Kanals (Zähler, Zustand, Betriebsstunden,
  Temperatur, §4.9) — `herkunft_art` kennt dafür das eine Wort `messkanal`. Die bezogene
  Temperatur (AP-17 E9 = C) ist das Wort `bezogen` (§ „Wetter-Archiv“). „Tag → Monat“ der
  Gradtagzahl ist gelesen als: Tag und Monat, nicht Woche und Jahr.
- **`pruefungen`** — passt eine Bezugsgröße zu ihrer Art? `abweichend` nennt ALLE Felder, die
  nicht passen (art · wertart · geltung_art · einheit · periode_art · herkunft_art), leer heißt
  passt. Die fünf Bezugsgrößen des Referenzunternehmens (BZ-1 … BZ-5) stehen als `beispiel`
  darin; beide Tests prüfen sie gegen `uems-referenzunternehmen.json`. BZ-4 steht dort mit
  `geltung_art` „ort“ (eine Größe an vielen Orten) und ist hier am Gebäude geprüft — der
  `hinweis` sagt es.
- ⚠ **Die Art schränkt ein, sie rechnet nicht um.** Gutteile in kg passen nicht, obwohl kg im
  Vokabular steht; ein Zählerstand in l an einer Messstelle in m³ passt nicht, obwohl l und m³
  dieselbe Größe sind. Die Umrechnung eines gelieferten Werts bleibt die Regel `einheit`.
- **Keine Regel der Fälle.** Die Prüfungen gehören zu keinem Abnahmefall (BZ-3 hat keinen), darum
  stehen sie nicht in `cases` und `zwillinge`; beide Umsetzungen fahren jede.

Seit `V20260918110000` trägt `bezugsgroesse.art` die gewählte Art als nullable Spalte ohne
Default. Produktionsmenge, Gutteile und Sonstige Menge können dieselbe Einheit, Wertart,
Periode und Geltung haben; eine verlustfreie Rekonstruktion ist unmöglich. Der Bestandsnachtrag
setzt deshalb nur genau einen passenden Kandidaten, sonst bleibt `art` null.
`bezugsarten()` ist der vollständig gegen `arten.je_art` geprüfte Datenbank-Katalog;
`bezugsart_passt()` prüft die Kombination. Die Herkunft bleibt am Wert.

POST und PUT nehmen `art` additiv an; GET/Liste geben sie mit null für ungeklärten Bestand
zurück. Ohne Art bleibt POST kompatibel. Bei PUT erhält eine fehlende oder null gesetzte Art
die vorhandene Art. Unbekannte Wörter antworten mit `wort_unbekannt`, unpassende Kombinationen
mit `anfrage_ungueltig` (jeweils `feld: art`). Nach dem ersten Wert oder einer Kanalbindung
bleibt die Art fest (M1), auch eine zuvor fehlende Art. Name/Kennzeichen bleiben änderbar.
Die Liste zeigt „Art nicht angegeben“, wenn keine gespeichert ist. Kennzahl-Nenner,
Import-Zuordnungen und freigegebene Berichts-Abzüge benötigen die Art nicht zur Rechnung;
ihre bestehenden Zahlen, Fassungen und Prüfsummen bleiben unverändert.

## 9. Der CSV-Leser (C1, nachgetragen mit AP-09 IP-11 am 13.09.2026)

**Die Datei kommt von draußen.** Der Block **`csv`** legt fest, wie aus den Bytes einer
hochgeladenen Datei Zeilen werden — und welche benannte, ruhige Antwort jede Datei bekommt, die
das nicht hergibt. Umsetzung: Java `uems/CsvLeser` (rein, ohne Spring); einen TS-Zwilling gibt es
nicht, das Portal liest keine Datei (`zwillinge_grund.csv`). Die Regel `csv` steht an B1 (die
ERP-Datei in Windows-1252, als UTF-8 mit BOM, mit Tab, mit Komma), B12 (nur Kopfzeile, 0 Byte,
nur Leerzeilen) und B13; die übrigen Erkennungs-Fälle stehen in `csv.pruefungen`.

- **Grenzen (E14):** höchstens 5 MB = 5 242 880 Bytes und 100 000 Datenzeilen (ohne Kopfzeile,
  ohne Leerzeilen). Darüber: `datei_zu_gross`.
- **Reihenfolge — die erste Stufe, die nicht passt, spricht:** Größe → leer → Kodierung →
  Trennzeichen → Anführungszeichen → Leerzeilen → Kopfzeile → Datenzeilen. Was vorher feststand,
  steht im Ergebnis; alles danach ist null.
- **Kein neues Befund-Wort.** C8 bleibt geschlossen: jede Ablehnung ist `datei_zu_gross`,
  `kodierung_unlesbar` oder `keine_datenzeilen` mit ihrem Satz aus `befund_saetze`. Der
  **Zusatz** (`csv.zusaetze`) sagt, woran es lag — nach dem Vorbild von B12 („Die Datei ist
  leer (0 Byte).“) —, `zeile` die Zeile der Datei. Ein nicht geschlossenes Anführungszeichen ist
  `kodierung_unlesbar`: hinter ihm ist keine Zeilengrenze mehr sicher.
- **Kodierung:** ein UTF-8-BOM entscheidet (auch gegen die Vorlage); sonst die Vorlage, sonst
  UTF-8, sonst Windows-1252 — beide streng, nie ein Ersatzzeichen. ⚠ Eine Datei nur aus
  ASCII-Bytes heißt UTF-8, auch wenn sie aus einem Windows-1252-ERP kommt (B1, `_abweichungen`).
  Steuerzeichen machen jede Datei unlesbar: eine Excel-Mappe und „Unicode-Text“ (UTF-16) gehen
  nicht als Text durch.
- **Trennzeichen:** `;`, `,`, Tab — Mehrheit der ersten 20 Zeilen mit Inhalt, jede Zeile für das
  Zeichen, das sie in die meisten Felder zerlegt; Gleichstand entscheidet diese Reihenfolge. Die
  Zeilen der Minderheit bleiben ungeteilt — der Leser rät nicht um.
- **Kopfzeile:** die erste Zeile, wenn keines ihrer Felder nach Zahl oder Datum aussieht und die
  zweite fehlt oder eines hat. Kodierung, Trennzeichen und Kopfzeile kann die Vorlage festhalten.
- **RFC 4180:** Trennzeichen, `""` und Zeilenumbruch im Feld in Anführungszeichen; Zeilenenden
  `\r\n`, `\n` und `\r`. `nr` ist die Zeile der Datei, `text` der Zeilentext, `felder` sind
  unverändert — kein Trimmen, keine Zahl.
- ⚠ **Formel-Neutralisierung beim ANZEIGEN, nicht beim Lesen:** ein Feld, das mit `=` `+` `-` `@`
  (und wie der Export mit Tab oder `\r`) beginnt, wird mit vorangestelltem `'` angezeigt —
  derselbe Schutz wie im Export (`MeasurementHistoryService.csv`). Gelesen und gespeichert wird,
  was in der Datei steht.

Keine Route, keine Tabelle, keine Migration, kein Fingerabdruck: das beginnt mit IP-12.

## 10. Die Vorschau eines Imports (C2–C5, C8, nachgetragen mit AP-09 IP-12 am 14.09.2026)

**Die Vorschau zeigt alles und schreibt nichts.** Die Regel **`vorschau`** legt fest, was aus einer
ganzen Datei und einer Zuordnung wird: je Datenzeile ein Urteil mit Befunden, je Datei ein
Fingerabdruck und die Zähler der Regel `import`. Sie steht an B1 (neu; dieselben Werte in anderer
Spaltenreihenfolge), B2 (`datei_bekannt`; nur ein Import, der etwas geschrieben hat, macht die Datei
bekannt), B9 (t statt kg; Gegenprobe ohne Einheitsspalte), B10 (Zeitumstellung in einer Datei; Offset
in der Datei), B11 (KW 40), B12 (nur Kopfzeile; 0 Byte) und B13 („lbs“/„Paletten“; Gegenprobe
widersprüchliche Datei) — 14 Prüfungen. Umsetzung: Java `uems/ImportVorschau` (rein), die Route
`POST /api/v1/bezugsdaten/importe/vorschau` (multipart) liest in einer Nur-Lese-Transaktion; einen
TS-Zwilling gibt es nicht (`zwillinge_grund.vorschau`).

- **Aufgerufen, nicht nachgebaut:** Bytes → `CsvLeser` (§9); Zahl, Einheit, Periode, Zeit,
  Plausibilität, Urteil, Zähler → die Regeln dieses Vertrags. Die Vorschau fügt nur die Zuordnung
  der Spalten, die Dubletten INNERHALB der Datei und die Fingerabdrücke hinzu.
- **Die Zuordnung** (`$defs/vorschau_zuordnung`): Spalten 1-basiert je Rolle (`periode`, `bis` nur bei
  `von_bis`, `wert`, `einheit`, `bezug`, `bemerkung`), Deutung, Zahlformat, feste Einheit (U3), feste
  Bezugsgröße ODER Bezug-Spalte mit `bezug_tabelle` (Text → Kennzeichen; ein Text, der selbst ein
  Kennzeichen ist, trifft auch), Synonyme (U2), und was der Leser nicht erkennen soll (`csv`). Dieselbe
  Form wird eine Vorlage (C9, IP-14).
- **Prüfreihenfolge je Zeile:** Zahl → Einheit → Periode bzw. Zeit, dann die Plausibilität → Bezug →
  Schlüssel. Die erste Stufe mit einem Befund, der die Zeile verhindert, spricht; ein Hinweis läuft
  weiter. Ohne auflösbaren Bezug gibt es keine Zieleinheit: nach der Zahl spricht der Bezug. Ein
  gelesener Betrag bleibt an der abgelehnten Zeile stehen (B10, B11), damit man sieht, was geliefert
  wurde.
- **Dubletten in der Datei (§4.7):** Zeilen, die die Stufe Schlüssel erreichen, mit gleichem Schlüssel
  und anderem Betrag → ALLE `konflikt_anderer_wert`, abgelehnt; mit gleichem Betrag zählt die erste,
  jede weitere ist ihre `wiederholung`. Eine früher abgelehnte Zeile vergleicht sich mit niemandem (B13).
- ⚠ **Zwei Fingerabdrücke (C2/E8).** Die DATEI: SHA-256 der hochgeladenen Bytes. Die ZEILE: SHA-256
  von `<bezugsgroesse_id>|<schluessel>|<betrag>` — Schlüssel = Periodenschlüssel (`2026-10`) bzw.
  Zeitpunkt in UTC, Betrag in der Einheit der Bezugsgröße ohne nachlaufende Nullen. **Nie der
  Zeilentext:** andere Spaltenreihenfolge, anderes Trennzeichen oder t statt kg sind dieselbe Zeile
  (B1, B9 tragen denselben Wert).
- ⚠ **`datei_bekannt` ist eine Auskunft, keine Abweisung** (Hinweis): der jüngste gespeicherte Import
  derselben Datei mit dem Status `uebernommen`, `teilweise_uebernommen` oder `zurueckgenommen`. Eine
  Wiederholung und ein verworfener Import haben nichts geschrieben und machen die Datei nicht bekannt.
- **Bestand:** der wirksame Stand je Schlüssel aus dem Lesemodell (§7); ein zurückgenommener Wert hat
  keinen Betrag, der Schlüssel ist frei.
- ⚠ **Die Vorschau-Kennung** (`VS1.<Sekunde>.<32 hex>`) bindet Kundenbereich, Ergebnis-Fingerabdruck
  und Ausstellungszeit und gehört **30 Minuten** zu genau diesem Ergebnis
  (`ImportVorschau.kennungPruefen`: `gueltig` · `abgelaufen` · `veraltet` · `unlesbar`). Sie ist
  kein Auftrag und keine Reservierung, kein Geheimnis und keine Berechtigung: die Übernahme (IP-13)
  bringt die Datei noch einmal mit, rechnet die Vorschau neu und vergleicht.
- **E14:** die Datei wird nie gespeichert. Die Tabellen `bezugsdaten_import`/`_zeile`/`bezugsdaten_vorlage`
  (V20260914173000) nehmen erst die Übernahme und die Vorlagen auf — Fingerabdruck, Metadaten, je Zeile
  Urteil, Befunde, Schlüssel und der Zeilentext für zwei Jahre.

## 11. Lesart als Nenner (nachgetragen mit AP-11 IP-1 am 14.09.2026)

Eine Kennzahl ([`kennzahl.md`](./kennzahl.md)) liest eine Bezugsgröße als Nenner. Dafür ändert dieser Vertrag
nichts an Werten, Fassungen oder Befunden — er legt fest, WIE sie gelesen werden:

- **Status → Zustand (AP-11 Q1).** Die wirksame Fassung der Periode ist „vollständig“. Kein wirksamer Wert —
  nicht eingegeben, nur `vorschlag`, `zurueckgenommen`, `abgelehnt` — ist „keine Werte“ mit Grund `nenner_fehlt`;
  eine zurückgenommene Fassung nennt zusätzlich „Nenner zurückgenommen (BZ-… <Periode>)“. Ein Wert aus einem
  Messkanal (§8, B7) trägt seinen Zustand und seine Abdeckung aus AP-08 mit.
- **Stichtag (E17).** Ein Stammdatum gilt am LETZTEN Tag der Periode — gelesen über `BezugsdatenRegeln.wertAm`.
  Ändert es sich in der Periode, erbt die Kennzahl den Satz „… geändert am …“ (S3) und rechnet trotzdem nur mit dem
  Stichtag; ein zeitgewichtetes Mittel gibt es nicht.
- **Perioden als Wertregel.** Ein Periodenwert wird nie verteilt oder interpoliert (Z2). Eine Kennzahl hat nur die
  Perioden, in denen die Periode ihres Nenners restlos aufgeht (Tag → Woche · Monat · Jahr, Monat → Jahr; eine Woche
  geht in nichts auf); sonst `periode_passt_nicht` — dasselbe Wort wie hier. Ein Wochen-Nenner speist nur
  Wochen-Kennzahlen.
- **Laufende Periode (Z4).** Ein Periodenwert entsteht erst nach dem Ende seiner Periode; bis dahin ist die Kennzahl
  „keine Werte“ mit Grund `periode_nicht_zu_ende` — nie eine Hochrechnung. Ein Stammdatum-Nenner gibt einen
  vorläufigen Wert.
- **Einheiten (§6.6).** Die Einheit einer Bezugsgröße wird nie umgerechnet; das Einheiten-Paar der Kennzahl spricht
  sie in der Einzahl („kWh je Person“).
- **Korrektur des Nenners.** Eine wirksame Fassung ≥ 2 und eine Rücknahme melden `correction` mit Bezug
  `bezugsgroesse` — seit AP-09 IP-7 im Ereignis-Vokabular angelegt (§12); die Kaskade der Kennzahl
  (AP-11 IP-9) bildet daraufhin Version n + 1. Eine Fassung 1 ist keine Korrektur (F1/F4).

Die Fälle stehen in `kennzahl-vectors.json`: K8 (Nenner fehlt), K9 (Nenner 0), K12 (Stichtag), K13 (Periode passt
nicht), K19 (zurückgenommen), K21 (laufende Periode).

## 12. Einen Wert eingeben und berichtigen (F1–F5, nachgetragen mit AP-09 IP-7 am 14.09.2026)

Der Block **`verwalten`** trägt seitdem auch den Schreibweg der Werte:

- **`pruefreihenfolge.eingeben`** (`POST /api/v1/bezugsgroessen/{id}/werte`) und **`.berichtigen`**
  (`POST …/{id}/werte/{periode}/berichtigung`) — die erste nicht bestandene Prüfung ist die Antwort.
  Die Regel `verwalten` prüft beide Vorgänge in B4 und B5 mit `uems/BezugsgroesseRegeln.eingeben|berichtigen`.
- **Zehn Ablehnungen mehr** im geschlossenen Satz. Fünf davon sind Befunde und sprechen deren Satz aus
  `befund_saetze` (`periode_passt_nicht`, `periode_nicht_zu_ende`, `zahl_unlesbar`, `wert_negativ`,
  `konflikt_anderer_wert`); `zahl_unlesbar` trägt bei Stück, Personen und Schichten zusätzlich den Satz
  `eingabe.ganze_zahlen` („Stück sind ganze Zahlen.“, U5).
- **`eingabe.urteile`** — was die Schnittstelle nach einem Wert sagt: `neu` (Fassung 1, F1 — ohne Begründung,
  ohne Freigabe), `wiederholung` (derselbe Betrag: nichts wird geschrieben, F5), `berichtigung` (Fassung n + 1
  sofort wirksam, Vier-Augen aus) und `vorschlag` (Vier-Augen an: bis zur Freigabe gilt der bisherige Wert).
- **`eingabe.kennung`** — jede Berichtigung ist ein Vorgang `BK-<Jahr>-<lfd. Nr.>`; freigegeben wird er über
  `POST /api/v1/korrekturen/{kennung}/freigeben` (AP-08 IP-15). Erst die Freigabe schreibt die Wert-Fassung —
  in der Nummerierung der Regel `fassung` (B5: Fassung 2 wirksam, Urheber UND Freigeber an derselben Fassung)
  — und das Ereignis `correction` mit Bezug `bezugsgroesse` (`events-vocabulary.md`).
