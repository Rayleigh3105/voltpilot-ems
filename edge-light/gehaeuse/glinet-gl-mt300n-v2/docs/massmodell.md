# Maßmodell der Platine

Das Maßmodell ist die Grundlage des Gehäuses: die Platine des GL-MT300N-V2 mit allem, was das
Gehäuse durchlassen, erreichen oder umgehen muss. Es steht als Daten in
[`gehaeuse/massmodell.py`](../gehaeuse/massmodell.py), **jede Zahl mit ihrer Herkunft**. Diese Seite
erklärt Quellen, Bezug und Verfahren; die Zahlen selbst stehen in der
[Tabelle](massmodell-tabelle.md), die aus dem Programm erzeugt ist.

Vom Hersteller gibt es weder Zeichnung noch 3D-Datei der Platine. Fremde Druckmodelle sind nicht
übernommen, zwei dienten als Gegenprobe für Abstände.

## Bezug

Blick auf die Bestückungsseite, Netzwerkbuchsen oben. **Ursprung ist die linke untere
Platinenecke**, x nach rechts, y nach oben, z = 0 auf der Platinenoberseite, z nach oben. Dieselben
Koordinaten gelten im ganzen Programm und im Prüfbericht.

| Kante | Lage | trägt |
|---|---|---|
| Netzwerk-Kante | oben, y = 50,75 | Doppel-RJ45 (rechts: LAN innen, WAN an der freien Kante), Micro-USB für den Strom (links) |
| USB-Kante | links, x = 0 | USB-A hochkant, Reset-Taster, Schiebeschalter |
| LED-Kante | unten, y = 0 | drei LEDs, UART-Stiftleiste mit drei Stiften, beide Antennen in den Ecken |
| freie Kante | rechts, x = 50,75 | unbestückte Lochreihe, kein Stecker |

## Wie sicher ist welche Zahl

Die Spalte „Herkunft“ der Tabelle hat fünf Stufen:

| Herkunft in der Tabelle | Bedeutung |
|---|---|
| am Probedruck bestätigt, Betreiber 09.10.2026 | mit dem Messschieber an einer geöffneten Mango gemessen **und** an einer gedruckten Passprobe mit der Platine geprüft. Bestätigt heißt: passt in den gedruckten Ausschnitt (je Seite 0,3 bis 0,5 mm Luft), nicht: auf ein Zehntel gemessen. Wo die Passprobe den Messwert berichtigt hat, steht der alte Wert daneben |
| gemessen vom Betreiber, 09.10.2026 | mit dem Messschieber gemessen, an keiner Passprobe sichtbar (Platinendicke, tiefster Punkt der Unterseite) |
| Schätzung aus dem Herstellerfoto, 10.10.2026 | aus dem Platinenbild des Herstellers abgelesen; Maßstab aus dem Abstand der drei gemessenen LEDs, ±0,15 mm. Das Foto zeigt ein Seriengerät, nicht die vermessene Platine |
| Schätzung aus Fotos | nach Verhältnis aus Hersteller-, Zulassungs- und OpenWrt-Fotos; flache Teile ±0,4 mm, hohe Teile ±1 mm |
| übliches Bauteilmaß, ungeprüft | Maß, das solche Bauteile üblicherweise haben; an diesem Gerät nicht belegt (vor allem Höhen) |

Die Spalte „Messung Nr.“ nennt die Nummer auf dem Messblatt (1 bis 17), „vorher geschätzt“ den Wert
vor der Messung. Zeichnung der Platine und ausgefülltes Messblatt erzeugt `./bauen.sh massbild`
(`aus/massmodell/`).

## Was durch welchen Druck bestätigt ist

| Datum | Gedruckt | Was das belegt | Wörtlich |
|---|---|---|---|
| 09.10.2026 | Schablone (flaches Unterteil) | Umriss der Platine, Loch und Stift, seitliche Lage aller Stecker, Lage der LEDs; keine Auflage trifft ein Bauteil der Unterseite | „passt“, „sitzt mittig im ausschnitt“, „kerben LED passen“, „Außenmaß passt“ |
| 09.10.2026 | Steckerwand (die beiden Wände mit Steckern, volle Höhe) | Höhen von Netzwerkblock und USB-A; Stecker stoßen nirgends an. Berichtigt: Der Reset-Taster sitzt 1,0 statt 0,5 mm über der Platine | „kein stecker stößt an eine kante“, „höhen stimmen“, „Resetöffnung muss noch 0,5mm nach oben“ |
| 09.10.2026 | Fensterstufen (0,2 bis 1,0 mm) | Fenster über den LEDs: eine Schicht | „0,2 mm dicke ist am besten“ |
| 09.10.2026 | erste Schachtprobe | Schachtwände bis 2,675 mm hinter der LED-Kante kommen an der Stiftleiste vorbei; die Fenster sitzen über den LEDs; die Stiftleiste hat drei Stifte | „stehen auf freier platine“, „3 stifte hat die leiste“ |
| 10.10.2026 | ganzes Gehäuse v0.1 | keine Zahl. Der Lichtschacht endete 1,2 mm über der Platine | „Die LEDs leuchten stark zur seite aufgrund eines spaltes“ |
| 11.10.2026 | ganzes Gehäuse v0.2 | Unterteil und Deckel mit dem Lichtschacht, der auf der Platine steht, sitzen; das Licht stimmt. WAN und LAN sind richtig zugeordnet | „ich habe das komplette gehäuse v0.2 gedruckt und es sitzt perfekt. Licht passt auch.“ |
| 12.10.2026 | Schriftprobe (gefragt war nach ihr; gemeldet ist „gedruckt“, ohne zu sagen, was) | Schriftgröße und Buchstabenformen (kein Maß der Platine) | „gedruckt - 1. wir nehmen 3,8 2. ja“ |

Der Satz vom 11.10.2026 bestätigt das Gehäuse als Ganzes, **keine einzelne Zahl**. Die Herkunft „am
Probedruck bestätigt“ tragen deshalb weiter nur die Maße, die am 09.10.2026 einzeln gemeldet
wurden. Bei den geschätzten Höhen unter dem Lichtschacht (LEDs, Sockel der Stiftleiste, kleine
Bauteile) steht als Bemerkung, dass sie sich mit dem gedruckten Gehäuse vertragen.

## Was angenommen ist und woran es hängt

- **Unterseite der Platine.** Gemessen ist nur der tiefste Punkt (3,0 mm unter der Platine), nicht,
  wo er liegt. Die Unterseite ist durchgehend bestückt. Folge im Gehäuse: Die Köpfe der Wandschrauben
  sitzen in geschlossenen Taschen unter dem Boden, kein Metall kommt in den Raum der Platine.
- **Stiftleiste hinter den LEDs.** Die Vorderkante ihres Sockels ist nicht gemessen (bei der Schachtprobe war kein Messschieber zur Hand), sondern aus dem Probedruck abgeleitet: rund 3,2 mm hinter der
  LED-Kante, mindestens 2,9 mm. Das Herstellerfoto zeigt 3,15 bis 3,25 mm.
- **Überstand von Micro-USB und USB-A.** Am Probedruck „bündig“, ohne Zahl und ohne Bezug; beide
  bleiben Schätzung. Die Stecker rasten an der Steckerwand ein, das Gehäuse hängt daran nicht.
- **Schiebeschalter.** Die beiden Stellungen liegen bei y = 22,0 und 20,75. Welche Kerbe der
  Schablone „die rechte“ war, ist nicht gesagt; der Kanal im Gehäuse deckt auch die andere Deutung
  (19,5) ab.
- **Antennen.** Beide sind Leiterbahnen an der LED-Kante. Als metallfrei behandelt werden die
  kupferfreien Zonen x 0 bis 18,2 / y 0 bis 8,4 und x 43,35 bis 50,75 / y 0 bis 19,6 (aus Fotos
  geschätzt). Welchen Abstand Metall halten muss, nennt keine Quelle; die Regel des Modells ist:
  alles Metall bei y über 25.

Nicht einzeln bestätigt sind außerdem: ob die Büroklammer den Reset-Taster trifft, ob alle Stecker
im ganzen Gehäuse einrasten, die Wandmontage, Falz, Rastwulst und Schrauben im Einzelnen
(`NICHT_EINZELN_11_10` im Modell).

## Quellen

| Kürzel | Quelle | wofür |
|---|---|---|
| H1 | [Spezifikation des Herstellers](https://docs.gl-inet.com/router/en/3/specification/gl-mt300n-v2/) | Außenmaß der Schale 58 × 58 × 25 mm, Versorgung 5 V / 2 A, Leistungsaufnahme unter 2,75 W |
| H2 | [Platinenbild „PINOUT“ des Herstellers](https://static.gl-inet.com/docs/router/en/2/hardware/mt300n-v2/src/GL-MT300N-V2_PINOUT-1.jpg) | Lage der Bauteile (entzerrt, Maßstab aus Lochreihen im Raster 2,54 mm), Namen der Buchsen: „WAN port0“, „LAN port1“ |
| H3 | [Produktseite des Herstellers](https://www.gl-inet.com/products/gl-mt300n-v2/) | Betriebstemperatur 0 bis 40 °C |
| F1 | Innenfotos aus den Zulassungsunterlagen (FCC-Kennung 2AFIW-300NV2), mit Lineal im Bild | Obergrenze für den Umriss der Platine; Anordnung |
| O1, O2 | [OpenWrt-Seite zum Gerät](https://openwrt.org/toh/gl.inet/gl-mt300n_v2) und deren Fotos | Öffnen der Schale, Unterseite der Platine, drei Gegenproben für den Maßstab |
| O3 | [Gerätebaum in OpenWrt](https://raw.githubusercontent.com/openwrt/openwrt/main/target/linux/ramips/dts/mt7628an_glinet_gl-mt300n-v2.dts) | Bedeutung und Farbe der LEDs |
| C1, C2 | zwei fremde Druckmodelle für die nackte Platine ([Printables 1419430](https://www.printables.com/model/1419430-gl-inet-mangoshadow-case), [1242542](https://www.printables.com/model/1242542-mango-travel-router-cluster-tray)) | nur als Gegenprobe: Beide kommen auf denselben Mittenabstand zwischen Netzwerkblock und Micro-USB (26,0 und 25,95 mm). Nichts daraus ist übernommen |
| M | Messung des Betreibers mit dem Messschieber an einer geöffneten Mango, 09.10.2026, nach einem Messblatt mit den Nummern 1 bis 17; einzelne Werte fehlen und sind in der Tabelle vermerkt | ersetzt die Schätzungen, wo gemessen wurde |

**Verfahren der Schätzung aus Fotos.** Das Bild H2 wurde über die vier Platinenkanten entzerrt; den
Maßstab liefern Lochreihen mit bekanntem Raster. Das ergab 50,4 × 50,4 mm für die Platine; gemessen
und an der Schablone bestätigt sind 50,75 × 50,75 mm. Wie weit Schätzung und Messung je Zahl
auseinanderlagen, zeigt die Spalte „vorher geschätzt“ der Tabelle.

## Ein Maß ändern

Ein neuer Wert ersetzt den alten in `gehaeuse/massmodell.py`, mit Herkunft und Datum; die alte Zahl
bleibt als `alt` stehen. Was nicht in Zahlen gemeldet ist, bleibt Schätzung mit Bemerkung: nicht
raten, sondern eine Passprobe bauen, an der man es sieht. Danach die Tabelle neu schreiben
([Bauen und ändern](bauen.md#rückmeldungen-eintragen)).
