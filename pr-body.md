Jeder Gerätetyp bekommt sein eigenes GESICHT — die Seite beantwortet zuerst die Frage, die IHR Typ stellt

**Was der Captain am 21.08. sah** (Punkt 2 des Reviews, Scout `vp-geraeteseite-rev-b8` §2.2/§4): jede Geräteseite begann mit derselben Karte — „Verbindung & Gesundheit: Anbindung Solarman-Logger · Adresse · Lesetakt" —, egal ob dahinter ein Hybrid-Wechselrichter, ein PV-Melder, ein Zähler, ein Heizstab oder eine Ladesäule stand. Fünf grundverschiedene Fragen, EINE Sektionsliste in EINER Reihenfolge.

Der Befund ist ZUSCHNITT, nicht Gestaltung — deshalb ist die Antwort auch keine neue Farbe, sondern eine Ableitung.

## `src/geraetGesicht.ts` entscheidet, WAS oben steht — und mehr nicht

| Gattung | Erste Frage | Held |
|---|---|---|
| **B** Wechselrichter mit Speicher | Was macht mein Speicher, folgt er dem Fahrplan? | Live-Bild + der **wörtliche** `controlStrip`-Satz |
| **B'** ohne Speicher | Wie viel erzeugt er? | Live-Bild + „VoltPilot liest dieses Gerät nur." |
| **C** PV-Melder | Wie viel erzeugt er, wird er gedrosselt? | Erzeugung · kWp · Auslastungs-Balken |
| **D** Zähler | Bezug oder Einspeisung — und ist er der maßgebliche? | die Richtung als **WORT** + „maßgeblich für die Bilanz" |
| **E** Verbraucher | Läuft es, und warum? | Leistung + Zustand + die belegte Regel |
| **F** Ladepunkt | Welcher Stecker lädt, wer wartet? | Stecker-Kacheln + der Satz der Box |

Die Sektions-BAUTEILE bleiben geteilt (Zeilen-Liste, Komponenten-Zeile, Befehls-Film, Register-Tabelle, Drawer) — sechs Gesichter sind sechs Stellen, an denen eine Regel vergessen werden kann, deshalb liegt die Auswahl in **EINER reinen Datei mit einem Test je Gattung**.

## Die Ehrlichkeitsregeln, die das Ganze tragen

- **Die Gattung wird BELEGT, nie geraten.** Zuerst die vom Gerät GEMELDETE Rolle, dann die Komponenten — und die **nur, wenn sie eindeutig sind**. Alles andere ist die ehrliche Rückfall-Gattung mit der Sektions-Folge von vorher.
- **⚠ Eine Sektion, die nur ihre Nicht-Zuständigkeit erklärt, ENTFÄLLT** — die Box-Lehre der Stufe 1, verallgemeinert. Ein Shelly bekommt keine Register-Sektion, ein Zähler keinen leeren Befehls-Kasten. **Der Grund verschwindet dabei nicht: er wandert in den Technik-Aufklapper.**
- **Der eine Satz oben wird nie erfunden.** Gattung B nimmt WÖRTLICH `controlStrip` (dieselbe Ableitung wie Cockpit und Steuerungs-Karte — drei Flächen, ein Satz), die Säule reicht den Satz der Box durch. **Trägt keine Kachel einen Wert, steht der GRUND da** — eine Reihe von „—" ist keine Auskunft. Und der Auslastungs-Balken entsteht nur mit gepflegter kWp: ein Balken ohne Maßstab wäre eine erfundene Aussage.
- **⚠ Die Abregelung behauptet ohne Einheiten-Eintrag NICHTS über DIESES Gerät.** Die Zähler sind eine Aussage über die ANLAGE; sie einem von mehreren Wechselrichtern anzulasten wäre genau die erfundene Zuordnung, die `ANLAGENWEITE_BEFEHLE` vermeidet. Erst die Einheiten-Liste aus **Stufe 1 (PR 458)** macht „Begrenzt gerade auf 8,0 kW · vom Gerät bestätigt" möglich.

## Zwei Sachen, die dabei mit erledigt sind

- **Lesen und Schreiben sind EINE Sektion „Register"** (§4.2 Punkt 5) — inklusive **„Register jetzt lesen"** über die Vorschau-Route (der h6-§7.3-Knopf). Sie schreibt nichts und wird nie journalisiert, **also lebt die Zeile nur in dieser Sitzung — und der Satz daneben sagt das.** So sieht man den Ist-Wert, BEVOR man schreibt. Die Zeile „Ihr Wechselrichter begrenzt auf 33,0 kW — hinterlegt sind 70,0 kW" steht damit endlich direkt über dem Werkzeug, das sie motiviert.
- **⚠ Eine SÄULE hat GENAU IHRE eigene Komponente.** Ihre Ladepunkt-Komponente wird an der BOX komponiert; über den früheren Umweg landete die Säule bei der ganzen Grundausstattung des Wechselrichters („Misst & steuert: Speicher · Solarmodule · Hausverbrauch"). Im Browser aufgefallen.

## Beweise

- **Rein:** `geraetGesicht.test.ts` (18) — jede Gattung, die Eindeutigkeits-Regel, die entfallenden Sektionen, „ohne Messwert steht der Grund da", die vier Abregel-Fälle.
- **Render:** `GeraetSeiteSection.test.tsx` (21, davon 2 neu): der PV-Melder führt mit „Erzeugung" und bekommt die Einspeise-Begrenzung, der Zähler bekommt KEINEN Befehls-Kasten. **Mutationsgeprüft** — ohne die Rolle-führt-Regel fallen beide.
- Ganze Portal-Suite grün (4017), `tsc` sauber.
- **Im echten Chrome bei 1440 UND 375, je Gattung** (Wegwerf-Harness mit der Pilsting-Lage: Deye am Logger + Fronius + Zähler + Shelly + Säule + ein noch nicht übernommenes Gerät): **0 px horizontaler Überlauf, 0 überstehende Elemente, keine Konsolenmeldungen**. Die „Jetzt lesen"-Strecke ist dort durchgespielt (0x00E7 → Zeile „330 · 33,0 kW · Auf Abruf gelesen" plus der Nicht-gespeichert-Satz).

Dabei aufgefallen und behoben: dieselbe Aussage stand zweimal auf einem Bildschirm (die Drosselung im Held UND in ihrer Sektion; der Einspeise-Wächter in den Steuerungs-Bezügen UND in der Gattungs-Sektion), und die Grenzen-Sektion listete die Guard-Bänder eines Hybriden doppelt (die PV-Aspekt-Zeile teilt sich ihre Entität mit dem Speicher).

## Was NICHT drin ist

Die Modell-Suche im Assistenten (NACHTRAG 5) folgt als eigener PR. Die Box-Seite ist unangetastet — sie hat seit Stufe 1 (PR 457) ihre eigene Gattung.
