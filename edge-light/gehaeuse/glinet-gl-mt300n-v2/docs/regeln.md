# Regeln für Druck, Schrift und Logo

Die Regeln, nach denen das Gehäuse gebaut ist und gegen die die Prüfung rechnet
(`gehaeuse/pruefung.py`, Abschnitt 2 des Prüfberichts). Sie gelten für einen Bambu Lab P1S mit
0,4-mm-Düse: Bahnbreite 0,42 mm, erste Schicht 0,50 mm, Schichthöhe 0,20 mm. Die meisten hängen am
Drucker und am Verfahren, nicht an der Mango, und gelten für ein Gehäuse zu einem anderen Gerät
genauso.

Zur Herkunft: **Probeslicen** heißt, an Bambu Studio 02.08.02.61 selbst geprüft und aus dem G-Code
gelesen. **Faustregel** ist ein Konstruktionsleitfaden oder Erfahrungswert. **Vorschlag** ist eine
Ableitung daraus. **Druck** heißt: an einem gedruckten Teil bestätigt, mit Datum.

## Farben und Drucklage

| Regel | Herkunft |
|---|---|
| Das Logo gehört auf den Deckel, und der Deckel wird mit der Sichtseite nach unten gedruckt | Probeslicen einer Probe-Platte in drei Lagen: einfarbig 0 Wechsel und 18,6 min; dreifarbig mit der Sichtseite auf der Platte 6 Wechsel, 34,1 min, 2,7 g Abfall; dreifarbig hochkant 183 Wechsel, 414 min, 78 g Abfall |
| Alles Farbige liegt in den ersten drei Schichten (Einlage 0,6 mm, bündig) | Jede weitere Schicht mit drei Farben kostet zwei Wechsel, rund fünf Minuten und ein Gramm (Probeslicen). Das gilt für jede Idee mit Farbe, auch Beschriftung an Seitenwänden |
| Hinter der Einlage bleibt mindestens 1,0 mm Weiß | Vorschlag |
| Teile für die Drucklage wenden (halbe Drehung), nie spiegeln; Logo und Schrift sind dafür gespiegelt modelliert | folgt aus der Lage |
| ASA und PETG nicht in einem Druck mischen | Probeslicen: Der Slicer bricht ab |
| Kanten in z liegen auf ganzen Schichten, vom Deckel aus gezählt | folgt aus der Schichthöhe |

## Striche, Stege, Abstände

| Regel | Herkunft |
|---|---|
| Farbiger Strich mindestens 0,45 mm, Abstand zwischen zwei Einlagen mindestens 0,6 mm | Probeslicen einer Strichprobe (Stege und Spalte von 0,30 bis 1,20 mm): 0,30 mm entfällt in allen Schichten; ein weißer Spalt von 0,45 mm fehlt in der ersten Schicht, also auf der Sichtseite; ab 0,60 mm wird alles gedruckt |
| Dünne Wände und Stege sind Vielfache der Bahnbreite: 0,42 / 0,84 / 1,26 mm | Faustregel |
| **Nichts genau eine Bahn breit bauen**; tragende Wände mindestens zwei Bahnen (0,84 mm) | Probeslicen: Mit dem Wandgenerator „klassisch“ (Voreinstellung) fährt Bambu Studio eine Wand von genau einer Bahn doppelt oder lässt sie weg. Die Stegprüfung meldet das nicht; erst der G-Code zeigt es |
| Eine einzelne Bahn druckt nur der Wandgenerator „Arachne“ | Probeslicen; die 3MF kann die Einstellung je Objekt tragen, geprüft an der Kommandozeile |

## Schrift der Beschriftung

Die Schrift ist eine eigene Strichschrift (`gehaeuse/schrift.py`): Großbuchstaben und Ziffern aus
Linien fester Breite. Nur so hat jeder Strich die Breite, die der Slicer braucht; eine Schrift aus
dem Rechner hat das nicht.

| Regel | Herkunft |
|---|---|
| Strich zwei Bahnen (0,84 mm) mit der Voreinstellung des Slicers | Probeslicen: „klassisch“ fährt um jeden Strich eine Schleife, also zwei Bahnen. In einen schmaleren Strich legt er dieselben zwei Bahnen (bei 0,5 mm die anderthalbfache Menge) |
| Kleinste Höhe = 3 × Strich + 2 × 0,6 mm | Drei Querstriche übereinander (B, S, 5) brauchen zweimal den kleinsten Abstand. Mit zwei Bahnen 3,72 mm, daraus die Vorgabe 3,8 mm; mit einer Bahn von 0,5 mm 2,7 mm, daraus 3,0 mm (nur mit Arachne) |
| Weiß zwischen zwei Buchstaben 0,84 mm; Lücken unter 0,6 mm zwischen Strichen gelten als gefüllt | folgt aus der Regel für Abstände |
| Kein Buchstabe läuft zu: je Buchstabe höchstens 10 % der Fläche gefüllt | Prüfung; für kleine Schrift gibt es offenere Formen (A als Bogen, S und 5 mit kürzeren Enden) |
| Kleinste schwarze Insel 1,8 mm² | Vorschlag; so groß ist das Dreieck, das auf den Anschluss zeigt |
| Jedes Wort steht mittig vor seinem Anschluss, mindestens 1 mm frei von Logo, Fenstern, Schraubenköpfen, Nachbarwort und Rand | Prüfung meldet einen Verstoß als Fehler |
| Im G-Code liegt an mindestens 95 % der Mittellinien jedes Zeichens eine schwarze Bahn, und der Slicer legt höchstens das 1,3-Fache dessen ab, was in das Zeichen passt | Probeslicen, je Zeichen und Schicht der Einlage |
| Gewählte Größe: 3,8 mm | **Druck, 12.10.2026** (gefragt war nach der Schriftprobe mit 4,5, 3,8 und 3,0 mm): „wir nehmen 3,8“ |

## Logo

- Quelle ist allein `logo/logo-vektor.svg`: vier benannte Pfade (`schrift`, `unterzeile`, `flieger`,
  `blitz`), nachgezeichnet aus dem Rasterbild des Portals
  (`frontend/portal/designsystem/assets/voltpilot-logo.png`). Neu erzeugen:
  `.venv/bin/python werkzeug/logo_vektor.py <voltpilot-logo.png> logo/logo-vektor.svg`. Die
  Nachzeichnung weicht höchstens 0,35 Bildpunkte der Vorlage ab, bei 50 mm Breite 0,009 mm.
- Farben des Logos: Schwarz `#000000`, Hellblau `#95B9FF` (dasselbe wie `--vp-primary` im
  Designsystem des Portals).
- Auf den Deckel passt die Wortmarke **ohne** Unterzeile, 48 mm breit: Der schmalste Strich (Blitz) ist
  rund 0,73 mm breit, der kleinste Abstand zwischen zwei Einlagen 0,68 mm (Prüfbericht, Abschnitt 4). Die Unterzeile hätte bei dieser Breite
  0,25 mm Strich und wäre nicht druckbar; druckbar würde sie erst bei rund 100 mm Logobreite.
- Das Hellblau gibt es in ASA nicht. Rechnerisch am nächsten liegen ABS „Azure“ (`#489FDF`) für das
  Zeichen bei einem Gehäuse aus ASA oder ein durchscheinendes Hellblau (`#61B0FF`) bei einem
  Gehäuse ganz aus PETG. Wie genau der Ton treffen muss, ist eine Frage der Marke und offen.

## Wände, Spiel, Öffnungen

| Regel | Wert | Herkunft |
|---|---|---|
| Gehäusewand, Boden, Deckel | 2,0 mm, überall etwa gleich | Faustregel |
| Luft um die Platine | 0,5 mm; an der Bezugsseite (USB-Kante) und an den Anschlagrippen 0,3 mm | Faustregel, Vorschlag; **Druck, 09.10.2026**: Platine passt |
| Bezugskante | Die Platine schlägt an der Steckerseite an; Schwund und Toleranz sammeln sich gegenüber, wo nichts durch die Wand muss | Vorschlag |
| Luft um den Körper einer Buchse | 0,5 mm je Seite, für den Griff des Steckers eine Senkung, in der zwei Bahnen Wand stehen bleiben | Faustregel; **Druck, 09.10.2026**: „kein stecker stößt an eine kante“ |
| Gedrucktes Teil in gedrucktem Teil (Falz) | 0,25 mm je Seite | Faustregel (0,2 bis 0,3); **Druck, 11.10.2026**: „sitzt perfekt“ |
| Kanten auf der Druckplatte | Fase 45°, keine Rundung | Faustregel |
| Senkrechte Gehäuseecken | Radius 3,5 mm | Vorschlag |
| Überhang ohne Stütze, Brücke | 45°, bis etwa 5 mm | Faustregel |
| Schwundausgleich | je Material ein Faktor, bis zur Messung 0 | **Druck, 09.10.2026**: „Außenmaß passt“ |

## Verschluss und Befestigung

| Regel | Wert | Herkunft |
|---|---|---|
| Selbstfurchende Schraube in Kunststoff | Kernloch 0,84 × Durchmesser, Dom außen 2 ×, Einschraubtiefe mindestens 2 × | Angabe eines Schraubenherstellers für Spritzguss |
| Rand um die Kopfsenkung, Deckel unter dem Kopf | je mindestens 1,0 mm | Vorschlag |
| Kein Rasthaken am Deckel | Er stünde beim Druck senkrecht, in der schwächsten Richtung | Faustregel |
| Metall weg von den Antennen | Schrauben und Schraubenköpfe bei y über 25 | Vorschlag; welchen Abstand Metall halten muss, nennt keine Quelle |
| Kein Metall in den Raum der Platine | Wandschrauben in geschlossenen Taschen, 1 mm Boden dazwischen | folgt aus der unvermessenen Unterseite |
| Lüftungsschlitz | 2,0 mm breit (unter 2,5 mm), Stege mindestens 0,84 mm | Vorschlag |
| Hutschienen-Clip | oben ein breiter fester Haken, unten der Federriegel (bricht er, hängt das Gerät noch); Feder liegend drucken; hinter der Schienenkante höchstens 7 mm dick; greift Kanten von 1,0 und 1,5 mm; Randdehnung des Federarms unter 1,5 % | Vorschlag nach zwei veröffentlichten gedruckten Clips; unerprobt |
| Gesamttiefe auf der Schiene, Breite | höchstens 40 mm, höchstens 3,5 Teilungseinheiten (63 mm) | Vorschlag |

## LEDs

| Regel | Herkunft |
|---|---|
| Fenster über jeder LED: eine Schicht (0,2 mm) der Gehäusefarbe | **Druck, 09.10.2026** (Fensterstufen 0,2 bis 1,0 mm): „0,2 mm dicke ist am besten“ |
| Um die LEDs ein Schacht bis auf die Platine, damit die drei Lichter getrennt bleiben und nichts zur Seite leuchtet | **Druck, 10.10.2026** (verlangt) und **11.10.2026**: „Licht passt auch“ |
| Der Schacht steht nur, wo die Platine frei ist, und hält 0,45 mm Abstand zu den Lötflächen der LEDs | Vorschlag (so weit können Deckel und Platine versetzt sein); Füße der ersten Schachtprobe: „stehen auf freier platine“ |
