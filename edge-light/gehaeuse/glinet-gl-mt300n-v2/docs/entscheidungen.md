# Entscheidungen und Geschichte

Vom ersten Entwurf bis zum Stand v0.4, mit Datum. Zitate sind Rückmeldungen des Betreibers aus den
Drucken, wörtlich, und stehen nur dort, wo sie ein Maß oder eine Entscheidung belegen.

## Geschichte in Kürze

| Datum | Stand | Anlass | Was sich geändert hat |
|---|---|---|---|
| 09.10.2026 | Grundlagen | Auftrag: Gehäuse mit Logo für das Edge Light auf der Mango | Entschieden: neues Gehäuse für die nackte Platine (keine Hülle um die Originalschale), Logo auf dem Deckel (Gehäuse weiß, Schrift schwarz, Zeichen hellblau), Drucker Bambu Lab P1S, Material bevorzugt ASA. Maße aus Fotos geschätzt, Logo aus dem Rasterbild des Portals nachgezeichnet, Werkzeugkette belegt |
| 09.10.2026 | v0 | Messung an einer geöffneten Mango (Messblatt) | Maßmodell mit Messwerten; Passproben (Schablone, Steckerwand, Fensterstufen); erster Entwurf mit zwei Schraublaschen und Hutschienen-Clip |
| 09.10.2026 | v0.1 | Einbauort entschieden: „wand - oder komplett ohne halterung wie das originalgehäuse“ | Keine Schraublaschen. Sockel mit zwei Schlüssellöchern, vier Mulden für Klebefüße, Etikettfeld auf der Unterseite; das Gehäuse wird dadurch 27,5 statt 23,5 mm hoch. Der Clip ist nur noch Zubehör. Bohrlehre neu |
| 09.10.2026 | v0.1 | Passproben gedruckt | Reset-Loch 0,5 mm höher („Resetöffnung muss noch 0,5mm nach oben“); LED-Fenster 0,2 mm („0,2 mm dicke ist am besten“); der Lichtschacht passt nicht mit vier Wänden zwischen LEDs und Stiftleiste und wird nach hinten offen; neue Schachtprobe, am Abend bestanden |
| 10.10.2026 | v0.2 | ganzes Gehäuse v0.1 gedruckt: „bitte den lichtschacht so lang machen dass er auf der platine aufliegt. Die LEDs leuchten stark zur seite aufgrund eines spaltes.“ | Der Lichtschacht steht auf der Platine (vorher endete er 1,2 mm darüber); Rückwand hinter den LEDs. Unterteil unverändert |
| 10.10.2026 | v0.3 | „kannst du außerdem auf der seite auf der das VoltPilot Logo aufgedruckt ist auch die anschlüsse beschriften?“ | WAN, LAN, 5V, USB vor ihrem Anschluss, 4,5 mm hoch, schwarz und bündig eingelegt in den Schichten des Logos, also ohne zusätzlichen Farbwechsel. Eigene Strichschrift |
| 11.10.2026 | v0.4 | ganzes Gehäuse v0.2 gedruckt: „es sitzt perfekt. Licht passt auch.“ Zur Beschriftung: „1. ja, 2. 5V, 3. mit USB, 4. nein, 5. nicht beschriften, 6. richtig so, 7. wenns geht lieber kleiner und schwarz ist gut“ | Schrift 3,8 statt 4,5 mm, mit offeneren Buchstabenformen (A als Bogen, S, 5, W, N). Reset und LEDs bleiben ohne Wort, der Schalter verdeckt. Unterteil und Körper des Deckels unverändert |
| 12.10.2026 | v0.4, vorerst fertig | „gedruckt - 1. wir nehmen 3,8 2. ja - damit ist das gehäuse erst mal final.“ | nichts am Modell. Das Gehäuse kommt mit Druckdateien und dieser Dokumentation ins Repository |

## Entscheidungen und ihre Gründe

| Entscheidung | Grund | seit |
|---|---|---|
| Gehäuse für die nackte Platine, nicht um die Originalschale | kleiner, eigenes Bild; die Hülle blieb nur als Rückfallweg bedacht | 09.10.2026 |
| Einbau an der Wand oder liegend, nicht im Verteiler | Entscheid des Betreibers. Hängend zeigt die Netzwerk-Seite nach unten: Kabel ziehen in die Rast, Antennen und LEDs liegen oben | 09.10.2026 |
| Platine geklemmt, nicht geschraubt | Die Platine hat keine Schraublöcher, nur ein Loch für einen Haltestift | v0 |
| Deckel mit vier Schrauben in Säulen außen am Gehäuse | Die Platine füllt den Innenraum bis auf 0,3 bis 0,7 mm; eine Schraube kommt nur außerhalb der Wand an ihr vorbei. Rasthaken am Deckel stünden beim Druck senkrecht, in der schwächsten Richtung | v0, Säulen seit v0.1 |
| Alles Metall bei y über 25 | Abstand zu den beiden Antennen an der LED-Kante | v0 |
| Wandschrauben in geschlossenen Taschen unter dem Boden | Die Bestückung der Platinenunterseite ist nicht vermessen; kein Schraubenkopf darf in ihren Raum | v0.1 |
| Deckel mit der Sichtseite auf der Druckplatte, Farben drei Schichten tief | sechs Farbwechsel statt zweier je Schicht ([Regeln](regeln.md#farben-und-drucklage)) | Grundlagen |
| Logo ohne Unterzeile, 48 mm breit | Die Unterzeile hätte 0,25 mm Strichbreite und ist mit einer 0,4-mm-Düse nicht druckbar | Grundlagen |
| LED-Fenster eine Schicht dünn, Lichtschacht bis auf die Platine | am Druck gewählt (09.10.) und verlangt (10.10.), bestätigt am 11.10.2026 | v0.1, v0.2 |
| Beschriftung WAN, LAN, 5V, USB; Reset, LEDs und Schalter ohne Wort | Antworten vom 11.10.2026 | v0.4 |
| Schrift 3,8 mm, Strich zwei Bahnen | kleinste Schrift, die ohne Einstellung im Slicer druckt; gewählt am 12.10.2026 | v0.4 |
| Etikettfeld auf der Unterseite | Auf dem Deckel konkurriert es mit Logo und Beschriftung; die Originalschale trägt ihr Typenschild an derselben Stelle. Bleibt ein Schalter | v0.1 |
| Kein fremdes Druckmodell übernommen | Lizenzen; das Gehäuse entsteht ohnehin aus dem eigenen Maßmodell | Grundlagen |

Verworfen und nur noch als Schalter baubar: die Form mit Schraublaschen (v0), der kurze Lichtschacht
(v0.1), die Schrift in 4,5 mm (v0.3) und 3,0 mm, die Beschriftung von Reset und LEDs, die vertiefte
oder erhabene Schrift ([Varianten](bauen.md#varianten)). Ganz gestrichen: „PWR“ statt „5V“, der
Deckel ohne „USB“.

## Offen

- **Produktsicherheit und CE.** Klärt der Betreiber selbst (09.10.2026: „CE und Produktsicherheit
  kümmere ich mich noch“). Dieses Verzeichnis trifft dazu keine Aussage, auch nicht zum Material.
- **Etikett.** Inhalt entschieden am 26.10.2026 („ich würde gerne die beschriftung und qr code per
  3d-Drucker aufs gehäuse drucken keinen aufkleber mehr zu brauchen“): die Referenz der Box in
  Klarschrift und ein QR-Code mit dem Direktlink ins Portal, gedruckt statt geklebt. Den Inhalt je Box
  zeigt die Werkstatt-Seite im Portal ([Werkstatt](../../../../docs/werkstatt.md)). **Offen ist die
  Druckdatei je Box:** ein Schritt im Programm, der QR-Code und Referenz als schwarze Einlage in die
  ersten drei Schichten der Unterseite legt (das Unterteil liegt mit ihr auf der Platte). Das
  Etikettfeld von 40 × 14 mm ist dafür zu klein: Der Code (Fassung 3, 29 × 29 Module) misst bei
  0,84 mm je Modul (zwei Bahnen) 24,4 mm, mit zwei Modulen Ruhezone auf der Fläche 27,7 mm. Zwischen
  den Mulden der LED-Seite und den Schlitzen der Schlüssellöcher sind rund 31 × 28 mm eben (aus den
  Stellgrößen gerechnet, nicht gemessen); die Klarschrift muss dann woanders hin, etwa zwischen die
  Schlüssellöcher. Bei 0,63 mm je Modul misst der Code 18,3 mm. Das ändert das gedruckte Unterteil.
  Eine Druckprobe am Slicer (Platten mit dem Code in beiden Größen, Bambu Studio 02.08.02.61, ASA) liest
  sich aus dem G-Code zurück; gedruckt ist sie nicht. Das Feld bleibt bis dahin
  ein Schalter (`etikett`); mit der Originalschale bleibt das Typenschild des Herstellers zurück.
- **Material und Blau.** Gerechnet ist mit ASA und dem Zeichen in ABS „Azure“; die Alternative ist
  alles in PETG ([Druckanleitung](drucken.md#farben)). Womit gedruckt wurde und ob der Farbton
  genügt, ist nicht gemeldet.
- **Schwund.** Nicht gemessen; die Dateien haben Nennmaß. Die Probe-Platte dafür ist baubar, eine
  Rückmeldung liegt nicht vor.
- **Nicht im Druck bestätigt:** der Deckel in der Fassung v0.4 als Ganzes (bestätigt sind sein
  Körper und die Wahl der Schrift), der Reset durch das Loch, die Wandmontage mit Bohrlehre, der
  Hutschienen-Clip.
- **Wärme.** Die Temperatur im geschlossenen Gehäuse unter Last ist nicht gemessen; die
  Lüftungsschlitze bleiben ein Schalter (`lueftung`).
- **Oberfläche des Slicers.** Dass Teilnamen und Filamentplätze ankommen, ist an der Kommandozeile
  von Bambu Studio geprüft, für die Oberfläche nicht gemeldet.
- **Logo.** Die Vektordatei ist eine Nachzeichnung des Rasterbilds. Gibt es das Original als
  Vektor, ersetzt es `logo/logo-vektor.svg` ohne weitere Änderung.
- **Funk.** Ob das Gerät im Betrieb WLAN braucht und was eine Hutschiene dicht hinter der Platine
  für die Antennen bedeutet, ist nicht untersucht.
