# Montage und Befestigung

Stand v0.4. Zahlen ohne Vermerk sind Stellgrößen des Modells (`gehaeuse/parameter.py`). Was durch
einen Druck bestätigt ist, steht dabei; alles andere ist gerechnet.

## Was man braucht

| Teil | Anzahl | Angabe |
|---|---|---|
| Unterteil, Deckel | je 1 | gedruckt ([Druckanleitung](drucken.md)) |
| Platine des GL-MT300N-V2 | 1 | aus der Originalschale genommen |
| Schrauben für den Deckel | 4 | selbstfurchend für Kunststoff, Senkkopf, 2,5 × 10 mm (Kopf bis 4,7 mm) |
| Klebefüße (liegend) | 4 | bis 8 mm Durchmesser; ein Fuß von 2 mm steht 1,4 mm vor |
| Wandschrauben (hängend) | 2 | 3,5 bis 4 mm, Kopf höchstens 8 mm breit und 2,6 mm hoch (Senkkopf 4 mm oder Linsenkopf 3,5 mm), dazu die Bohrlehre |
| Hutschienen-Clip (Zubehör) | 1 | gedruckt, dazu zwei weitere Schrauben 2,5 × 10 mm |

## Platine aus der Originalschale nehmen

Die Schale hat keine Schrauben, nur Clips ringsum; geöffnet wird sie mit einem Hebelwerkzeug in der
Kerbe (Angabe aus dem OpenWrt-Wiki zum Gerät). Die Bodenplatte ist das flache Teil; die Platine
steckt kopfüber in der Oberschale auf einem Stift. Mit der gelben Schale bleibt auch das
Typenschild des Herstellers zurück ([offen: Etikett](entscheidungen.md#offen)).

## Zusammenbau

1. **Platine einlegen**, Bestückungsseite nach oben, Netzwerkbuchsen zu den beiden großen
   Öffnungen. Sie liegt auf Auflagen in den Ecken und auf Leisten unter der freien Kante; ein Stift des Unterteils
   (1,6 mm) greift in das Loch der Platine (2,0 mm) und hält sie gegen Verschieben. Geschraubt wird
   die Platine nicht, sie hat keine Schraublöcher. Bezugsseite ist die USB-Kante (0,3 mm Luft); an
   der Netzwerk-Seite schlägt sie an Rippen an.
   *Bestätigt im Druck (09.10.2026, Schablone): passt, kein Bauteil der Unterseite stößt an eine Auflage.*
2. **Deckel aufsetzen**, Logo so, dass es lesbar ist, wenn die Netzwerk-Seite unten liegt. Ein
   umlaufender Falz (1,5 mm) richtet ihn aus, ein Wulst am Falz der LED-Seite greift in eine Nut. Der
   Lichtschacht des Deckels setzt als Erstes auf: Er steht auf der Platine rund um die drei LEDs
   und trennt ihr Licht. Sonst berührt der Deckel die Platine nicht.
   *Bestätigt im Druck (11.10.2026): „sitzt perfekt. Licht passt auch“.*
3. **Vier Schrauben** von der Sichtseite in die Säulen außen am Gehäuse, handfest. Die Säulen liegen
   außerhalb des Innenraums; keine Schraube kommt in die Nähe der Platine.

## Anschlüsse und Bedienung

![Liegend, von der Seite der Netzwerkbuchsen](bilder/liegend-beschriftet.png)

| Beschriftung | Anschluss | Bemerkung |
|---|---|---|
| WAN | Netzwerkbuchse an der freien Seite | welche Buchse welche ist: Herstellerbild, vom Betreiber am 11.10.2026 bestätigt |
| LAN | Netzwerkbuchse neben dem Strom | |
| 5V | Micro-USB, Stromversorgung | Herstellerangabe: 5 V / 2 A |
| USB | USB-A an der Seitenwand | |

- **LEDs:** drei Fenster im Deckel, eine Schicht (0,2 mm) dünn, ohne Beschriftung. Von der
  USB-Kante aus: Power (grün), WAN (grün), WLAN (rot). *Fensterdicke im Druck gewählt (09.10.2026).*
- **Reset:** Loch von 2 mm in der Seitenwand neben dem USB-A, für eine Büroklammer. Ohne
  Beschriftung. *Lage an der Passprobe berichtigt (09.10.2026); am ganzen Gehäuse nicht einzeln bestätigt.*
- **Schiebeschalter:** bleibt verdeckt; im Gehäuse ist Raum für beide Stellungen
  (Entscheid vom 11.10.2026).

## Aufstellen: liegend

Vier Klebefüße in die Mulden der Unterseite (8,5 mm Durchmesser, 0,6 mm tief). Lüftungsschlitze
liegen dann an zwei Seitenwänden.

## Aufhängen: an der Wand

![Unterseite mit Schlüssellöchern, Mulden und Etikettfeld](bilder/unterseite-schraeg.png)

Das Gerät hängt mit der **Netzwerk-Seite nach unten**: Die Kabel gehen nach unten weg und ziehen es
in die Rast, Antennen und LEDs liegen oben, das Logo steht richtig herum, USB-A und Reset zeigen nach
rechts.

1. Bohrlehre waagerecht an die Wand halten und die beiden Löcher anzeichnen (Abstand 30 mm).
2. Bohren, Schrauben durch die Schlitze der Bohrlehre bis auf den Streifen eindrehen, Streifen nach
   oben abziehen. Die Köpfe stehen dann 2,3 mm vor der Wand.
3. Gerät von vorn auf die Köpfe setzen und 8,5 mm nach unten in die Rast schieben. Abnehmen: anheben
   und abziehen.

Platz: unter dem Gerät rund 60 mm für Stecker und Kabelbogen, darüber 10 mm zum Abheben. Die
Schraubenköpfe sitzen in geschlossenen Taschen unter dem Boden, 1 mm Kunststoff trennt sie vom
Innenraum. *Nicht im Druck bestätigt: die Wandmontage und die Bohrlehre.*

## Hutschiene (Zubehör)

Der Clip für die Schiene TH 35 wird von hinten mit zwei Schrauben 2,5 × 10 mm in die beiden mittleren
Säulen geschraubt (Kernlöcher von unten). Oben greift ein fester Haken, unten ein Federriegel mit
Zuglasche; die Tiefe auf der Schiene ist 38 mm. Auf der Schiene ohne Klebefüße; der Clip verdeckt das
Etikettfeld. *Kein Druck gemeldet; Federkraft unerprobt.*

Der Einbauort ist seit dem 09.10.2026 entschieden: an der Wand oder liegend, **nicht im Verteiler**.
Der Hersteller gibt für den Router 0 bis 40 °C Umgebungstemperatur an.

## Was man beim Befestigen beachten muss

- **Kein Metall an die LED-Seite.** Beide Antennen sind Leiterbahnen an der LED-Kante. Alle
  Schrauben des Gehäuses sitzen deshalb in der Hälfte der Netzwerkbuchsen; das soll beim Befestigen
  so bleiben (keine Metallschelle, kein Metallwinkel über der LED-Seite).
- **Kennung statt Etikett.** Seit dem 26.10.2026 gilt: kein Aufkleber. Referenz und QR-Code werden
  mit dem Unterteil der Box gedruckt (`./bauen.sh --referenz edge-…`, [Kennung](kennung.md)); auf
  diesem Unterteil entfällt das Etikettfeld. Das Unterteil ohne Kennung (`druck/unterteil.3mf`)
  behält sein Etikettfeld, 40 × 14 mm, eine Schicht vertieft; es reicht bis unter eine Antenne: kein
  Etikett mit Metallfolie.
- **Lüftung:** Schlitze von 2 mm an LED- und Netzwerk-Seite, hängend oben und unten, sodass Luft
  durchzieht. Die Wärme im geschlossenen Gehäuse ist nicht gemessen.
