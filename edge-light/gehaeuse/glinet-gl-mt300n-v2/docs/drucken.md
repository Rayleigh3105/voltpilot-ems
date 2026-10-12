# Druckanleitung

Für die fertigen Dateien unter [`druck/`](../druck/README.md), Stand v0.4.

**Woher die Zahlen stammen.** Jede Zahl auf dieser Seite trägt eine von zwei Quellen:

- **Probeslicen:** Bambu Studio 02.08.02.61 auf der Kommandozeile, ohne Drucker. Zeiten, Farbwechsel
  und Mengen sind Schätzungen des Slicers.
- **Druck:** Rückmeldung des Betreibers aus einem echten Druck, mit Datum.

Aus einem Druck gemeldet sind bisher Passform, Licht und die Wahl der Schrift, **keine** gemessene
Druckzeit, kein Verbrauch und kein Schwund. Mit welchem Filament gedruckt wurde, ist nicht gemeldet.

## Womit

| | | Quelle |
|---|---|---|
| Drucker | Bambu Lab P1S, 0,4-mm-Düse, mit Mehrfarbeinheit (AMS) für drei Filamente | P1S: Vorgabe des Betreibers (09.10.2026). Die Mehrfarbeinheit ist angenommen, nicht gemeldet; ohne sie lässt sich der Deckel nicht dreifarbig drucken. Alle Regeln und das Probeslicen sind auf diesen Drucker ausgelegt |
| Profil | „0.20mm Standard“: Schichthöhe 0,20 mm, Bahnbreite 0,42 mm, erste Schicht 0,50 mm | Probeslicen (aus dem G-Code gelesen) |
| Druckplatte | strukturierte PEI-Platte, Spülturm an | Probeslicen; welche Platte im Druck verwendet wurde, ist nicht gemeldet |
| Einstellungen im Slicer | keine: Die Dateien drucken mit der Voreinstellung (Wandgenerator „klassisch“) | Probeslicen |
| Stützstrukturen | aus, wie in der Voreinstellung des Profils | Probeslicen; ob im Druck Stützen verwendet wurden, ist nicht gemeldet |

## Farben

Jede 3MF bringt ihre Teile mit Namen und Filamentplatz mit:

| Platz | Teil in der Datei | Farbe | wofür |
|---|---|---|---|
| 1 | `gehaeuse_weiss` | Weiß | Gehäuse |
| 2 | `schrift_schwarz` | Schwarz | Schrift des Logos und die Wörter WAN, LAN, 5V, USB |
| 3 | `zeichen_hellblau` | Hellblau | Papierflieger und Blitz des Logos |

Unterteil, Clip und Bohrlehre sind einfarbig (Platz 1).

**Material.** Das Modell rechnet mit ASA für Weiß und Schwarz und ABS „Azure“ für das hellblaue
Zeichen (Stellgröße `material = "asa"`). Der Grund für die Mischung: Das Hellblau des Logos
(`#95B9FF`) gibt es in ASA nicht, und ASA lässt sich nicht mit PETG in einem Druck mischen (im
Slicer nachgestellt: Abbruch mit „The temperature difference of the filaments used is too large“).
Die Alternative ist alles in PETG (`material = "petg"`), mit einem durchscheinenden Hellblau näher am
Ton und weniger Wärmereserve (Formbeständigkeit laut Datenblatt 62 bis 69 °C statt 92 bis 100 °C).
Welche der beiden Mischungen es wird und wie genau das Blau treffen muss, ist nicht entschieden
([offen](entscheidungen.md#offen)).

**Beim Öffnen in Bambu Studio.** Geprüft ist die Kommandozeile: Dort kommen Objekte, Teilnamen und
Filamentplätze an wie geschrieben. Die Oberfläche kann beim Öffnen einer fremden 3MF fragen, ob nur
die Geometrie geladen werden soll, und dabei die Plätze zurücksetzen. Dann von Hand zuordnen: Teil
`schrift_schwarz` auf Filament 2, `zeichen_hellblau` auf Filament 3.

## Lage auf der Platte

Die Dateien liegen schon in Drucklage, nichts drehen:

- **Unterteil:** Standfläche (Unterseite mit Schlüssellöchern) auf der Platte.
- **Deckel:** **Sichtfläche auf der Platte.** Logo und Wörter sind deshalb gespiegelt in der Datei;
  die erste Schicht ist das, was man später sieht. Die strukturierte Platte gibt ihr eine raue
  Oberfläche.
- **Clip:** die Vorderseite auf der Platte, die Feder liegend (Schichten längs der Feder).

Alles Farbige steckt in den **ersten drei Schichten** (0,6 mm tief, bündig eingelegt). Deshalb bleibt
es bei sechs Farbwechseln, gleich wie hoch das Teil ist. Stünde das Logo an einer senkrechten Wand,
fielen in jeder Schicht zwei Wechsel an (Probeslicen an einer Probe-Platte: 183 Wechsel und knapp
sieben Stunden statt 6 Wechsel und 34 Minuten).

## Zeit, Farbwechsel, Abfall

Quelle für die ganze Tabelle: **Probeslicen** (ASA weiß und schwarz, Zeichen in ABS), kein Druck.

| Datei | Druckzeit | Filamentwechsel | Material im Teil | Abfall (Spülen und Turm) |
|---|---|---|---|---|
| `gehaeuse-v04.3mf` (Unterteil und Deckel) | 84,2 min | 6 | 22,84 g | 2,81 g |
| `unterteil.3mf` | 51,2 min | 0 | 15,28 g | 0 g |
| `deckel.3mf` | 49,0 min | 6 | 7,63 g | 2,81 g |
| `deckel.3mf`, alles in PETG | 47,2 min | 6 | 9,30 g | 3,25 g |
| `hutschienen-clip.3mf` | 21,0 min | 0 | 4,86 g | 0 g |
| `bohrlehre.3mf` | 10,6 min | 0 | 1,75 g | 0 g |

Ein Farbwechsel kostet nach dem Probeslicen rund 2,6 Minuten und knapp 0,5 g. Von Schwarz nach Weiß
spült der Slicer mehr als umgekehrt; die Reihenfolge legt er selbst fest.

## Maßhaltigkeit und Schwund

Die Dateien haben **Nennmaß**, ohne Schwundausgleich (`schwund = 0` in `gehaeuse/parameter.py`).

- **Druck, 09.10.2026:** An den Passproben „Außenmaß passt“; die Platine liegt in der Schablone.
- **Druck, 11.10.2026:** Das ganze Gehäuse „sitzt perfekt“.
- Gemessen ist der Schwund nicht. Dafür gibt es die Probe-Platte (60,00 mm Kantenlänge,
  `./bauen.sh probeplatte`); eine Rückmeldung dazu liegt nicht vor. Wer Material oder Drucker
  wechselt, druckt sie zuerst und trägt den Schwund je Material ein ([Bauen und ändern](bauen.md#rückmeldungen-eintragen)).

## Was der Slicer zur Beschriftung sagt

Die Wörter sind 3,8 mm hoch, jeder Strich zwei Bahnen breit (0,84 mm). Das ist die kleinste Schrift,
die mit der Voreinstellung druckt ([Regeln](regeln.md#schrift-der-beschriftung)).

- **Probeslicen:** Im G-Code des Deckels liegt in allen drei Schichten der Einlage an jedem Zeichen
  eine geschlossene schwarze Bahn (Abdeckung 100 %, rund zwei Bahnen je Strich, Füllung höchstens
  117 %). In den engen Feldern von W und N legt der Slicer in der ersten Schicht kein Weiß ab; die
  zweite Schicht schließt sie.
- **Druck, 12.10.2026:** Nach der Schriftprobe (die vier Wörter in 4,5, 3,8 und 3,0 mm) gewählt:
  „gedruckt - 1. wir nehmen 3,8 2. ja“ (Frage 2: ob Lage und Buchstabenformen passen).

## Nach dem Druck ansehen

Was bisher nur gerechnet ist und sich erst am Teil zeigt:

- Deckel: Sind die Ränder der Schrift glatt, schmiert Schwarz ins Weiß, haften die kleinen Inseln?
- Reset: Trifft eine Büroklammer durch das Loch den Taster?
- Wand: Hängt das Gehäuse sicher an zwei Schrauben, wenn Kabel daran ziehen? Stimmt die Bohrlehre?
- Clip: Federkraft und Halt an einer echten Schiene.
- Verzug, und die Wärme im geschlossenen Gehäuse unter Last (nicht gemessen).

Rückmeldungen gehören ins Modell, mit Datum: [Bauen und ändern](bauen.md#rückmeldungen-eintragen).
