# Bauen und ändern

Das Gehäuse ist ein Python-Programm. Alles, was man druckt oder ansieht, entsteht daraus:
Druckdateien, Bilder, Zeichnungen, Prüfbericht.

## Einrichten

Ohne Root-Rechte, ohne Bildschirm. Gebaut und geprüft auf Debian 13 mit Python 3.13.

```bash
./einrichten.sh            # Python-Umgebung in .venv (rund 1,1 GB)
./einrichten.sh --bambu    # zusätzlich Bambu Studio für die Kontrolle der 3MF (rund 0,8 GB, lädt 230 MB)
```

- Debian liefert `python3` ohne `ensurepip`. Die Umgebung entsteht deshalb mit
  `python3 -m venv --without-pip` und wird vom pip des Benutzers gefüllt
  (`pip --python .venv/bin/python install -r anforderungen.txt`, pip ab 23).
- Bambu Studio läuft als entpacktes AppImage. Die Laufzeitbibliotheken, die auf Debian 13 fehlen
  (WebKit, GStreamer), holt `werkzeug/bambu_einrichten.sh` mit `apt-get download` und entpackt sie
  mit `dpkg -x` nach `.werkzeug/bambu/sysroot`. Nichts wird im System installiert.
- `.venv/`, `.werkzeug/` und `aus/` stehen in `.gitignore`.

### Fassungen der Werkzeuge

| Werkzeug | Fassung | festgelegt in |
|---|---|---|
| Python | 3.13 (geprüft mit 3.13.5) | — |
| build123d | 0.13.0 (zieht den Geometriekern `cadquery-ocp-novtk` nach, geprüft mit 8.0.1.1.0) | `anforderungen.txt` |
| lib3mf | 2.5.0 | `anforderungen.txt` |
| numpy, shapely, pillow, cairosvg | 2.5.3, 2.2.0, 12.2.0, 2.9.1 | `anforderungen.txt` |
| qrcode, zxing-cpp | 8.2 (QR-Code der Kennung, wie für die Vektoren des Portals), 3.1.1 (liest ihn aus dem G-Code zurück) | `anforderungen.txt` |
| scikit-image | 0.26.0 (nur für `werkzeug/logo_vektor.py`) | `anforderungen.txt` |
| Bambu Studio | 02.08.02.61, AppImage für Ubuntu 24.04, SHA-256 `d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd` | `werkzeug/bambu_einrichten.sh` |

Der Geometriekern ist nicht eigens festgeschrieben. Liefert eine andere Fassung andere Netze, meldet
es der Schritt `abgleich` (und die Prüfung über den festgehaltenen Stand der gedruckten Teile).

## Bauen

```bash
./bauen.sh                     # alles
./bauen.sh entwurf pruefung    # einzelne Schritte
./bauen.sh --hilfe             # Liste der Schritte
./bauen.sh --referenz edge-…   # das Gehäuse einer Box mit Referenz und QR-Code (Kennung)
```

| Schritt | Ergebnis unter `aus/` |
|---|---|
| `massbild` | `massmodell/`: Zeichnung der Platine, Messblatt mit den eingetragenen Messwerten, Tabelle aller Zahlen mit Herkunft |
| `probeplatte` | `probe-platte/`: Platte 60 × 60 mm für Farben, Strichbreiten und Schwund |
| `passproben` | `passproben/`: Schablone, Steckerwand, Schachtprobe, je 3MF, STL und Bild |
| `schriftprobe` | `schriftprobe/`: die Wörter des Deckels in 4,5, 3,8 und 3,0 mm, zwei Plättchen in einer 3MF |
| `entwurf` | `gehaeuse-v04/`: Unterteil, Deckel (Schrift 3,8 mm), beide zusammen in einer 3MF, Zubehör; der Deckel in den anderen Schriftgrößen; in `vergleich/` der Deckel ohne Beschriftung; Ansichten, Zeichnungen der Beschriftung, Schnitte durch den Lichtschacht. `kennung/edge-wrk7abg/`: das Unterteil mit Kennung für die erfundene Probe-Referenz |
| `pruefung` | `pruefung/pruefbericht.md`: Durchdringungen, Regeln, Stege je Druckschicht, Logo, Varianten, Gedrucktes gegen den festgehaltenen Stand, Lichtschacht, Beschriftung, Kennung (Inhalt gleich dem Portal, Abstände am Netz) |
| `bambu` | `pruefung/bambu.md`: jede 3MF durch Bambu Studio (kommen Teile und Farbplätze an? Zeit, Wechsel, Abfall; druckt der Slicer den Fuß des Lichtschachts und jedes Zeichen als geschlossene Bahn? liest sich der QR-Code der Kennung aus dem G-Code?). Wird übersprungen, wenn Bambu Studio nicht eingerichtet ist |
| `abgleich` | `pruefung/abgleich.md`: Gehören die eingecheckten 3MF unter `druck/`, ihre Prüfsummen und die Tabelle `docs/massmodell-tabelle.md` noch zum Programm? |

`./bauen.sh` endet mit **Rückgabewert 1**, wenn ein Schritt einen Fehler meldet: Durchdringung,
verletzte Regel, Steg schmaler als eine Bahn, ein gedrucktes Teil weicht vom festgehaltenen Stand
ab, ein Wort der Beschriftung passt nicht an seinen Platz, eine 3MF kommt im Slicer nicht an wie
geschrieben, der Slicer fährt ein Zeichen nicht sauber, die Kennung weicht vom Portal ab, stößt an
oder ist aus dem G-Code nicht lesbar, oder Eingechecktes gehört nicht mehr zum Programm.

`./bauen.sh --referenz edge-…` baut nur das Gehäuse dieser einen Box nach `aus/kennung/<referenz>/`
und prüft es wie die Probe-Referenz (Inhalt, Abstände, Bambu Studio, QR-Code aus dem G-Code); Bericht
`pruefung.md` daneben. Rückgabewert 1 bei einem Fehler und, wenn Bambu Studio fehlt. Einzelheiten:
[Kennung](kennung.md).

Die Maschine nicht überlasten: Bauen und Slicen einzeln, nicht parallel. Die Schritte laufen mit
niedriger Priorität.

## Aufbau des Programms

| Datei | Inhalt |
|---|---|
| `gehaeuse/massmodell.py` | Maße der Platine als Daten, jede Zahl mit Herkunft ([Maßmodell](massmodell.md)) |
| `gehaeuse/parameter.py` | Stellgrößen des Gehäuses: Wände, Luft, Spiel, Schwund je Material, Wandmontage, Füße, Lüftung, LED-Anzeige und Lichtschacht, Etikett, Logo, Clip, die Wörter der Beschriftung und ihre Schrift; dazu die Sätze von Schaltern für die Varianten |
| `gehaeuse/entwurf.py` | Unterteil, Deckel samt Beschriftung, Bohrlehre, Clip als Körper; das Unterteil mit Kennung |
| `gehaeuse/kennung.py` | Inhalt der Kennung einer Box wie im Portal: Prüfung der Referenz, Klarschrift, Link, QR-Code; Abgleich mit `docs/contracts/werkstatt-beschriftung.json` |
| `gehaeuse/schrift.py`, `schriftprobe.py` | die Strichschrift der Beschriftung und die Schriftprobe |
| `gehaeuse/passproben.py`, `passproben_gedruckt.json` | Passproben als Ausschnitte von Unterteil und Deckel; der festgehaltene Stand der gedruckten Teile |
| `gehaeuse/platine.py` | die Platine als Körper, zum Einlegen und Prüfen |
| `gehaeuse/pruefung.py` | Durchdringung, Abstände, Regeln, Stege je Druckschicht, Zahlen zum Lichtschacht |
| `gehaeuse/bambu.py` | Läufe durch Bambu Studio, Kontrolle des G-Codes, QR-Code aus dem G-Code lesen |
| `gehaeuse/abgleich.py` | Eingechecktes gegen den Bau |
| `gehaeuse/logo.py`, `logo/logo-vektor.svg` | das Logo als Flächen; die SVG ist die einzige Quelle |
| `gehaeuse/ausgabe.py`, `mehrfarb_3mf.py`, `vorschau.py`, `formen.py` | Netz, Drucklage, STL, 3MF mit benannten Teilen und Farbplätzen, Bilder ohne Grafikkarte |
| `gehaeuse/massbild.py`, `schachtbild.py`, `schriftbild.py`, `probe_platte.py` | Zeichnungen und Probe-Platte |
| `werkzeug/` | Bambu Studio einrichten und aufrufen, Logo nachzeichnen, Strichprobe aus dem G-Code |

Koordinaten überall wie im Maßmodell: Ursprung ist die linke untere Platinenecke, z = 0 auf der
Platinenoberseite.

## Regeln beim Ändern

- **Maße der Platine stehen nur in `massmodell.py`**, Stellgrößen des Gehäuses nur in
  `parameter.py`. Keine Maßzahl in `entwurf.py` oder `passproben.py` verstecken.
- **Der festgehaltene Stand schützt, was gedruckt ist.** `passproben_gedruckt.json` hält die Form der
  Passproben, des Unterteils und des Deckelkörpers fest (Volumen, Oberfläche, Hülle, Schwerpunkt,
  Prüfsumme der STL). Ändert eine Stellgröße eines dieser Teile, bricht die Prüfung ab. Ist die
  Änderung gewollt: erst `./bauen.sh passproben entwurf`, dann
  `.venv/bin/python -m gehaeuse.passproben "Anlass"`; der Anlass sagt, welche gedruckten Teile weiter
  gelten.
- **Die eingecheckten Druckdateien gehören zum Programm.** Nach einer gewollten Änderung:
  `.venv/bin/python -m gehaeuse.abgleich uebernehmen`, dann in [`druck/README.md`](../druck/README.md)
  eintragen, was vom neuen Stand gedruckt ist. Ein geändertes Teil ist bis zum nächsten Druck nicht
  bestätigt. Der Name des Standes (`NAME` in `gehaeuse/bau.py`, heute `gehaeuse-v04`) ist auch der
  Name des Ordners unter `aus/` und der gemeinsamen Druckdatei.
- **Nach jeder Änderung an der Geometrie** `./bauen.sh entwurf pruefung` laufen lassen, vor dem
  Einchecken alles.
- Unterteil und Lichtschacht nur ändern, wenn eine Rückmeldung es verlangt: Beide sind gedruckt und
  bestätigt. Die Passproben sind das Unterteil ohne Anbauten (`unterteil(anbauten=False)`): Alles
  Äußere (Sockel, Säulen, Schlüssellöcher) gehört in diesen Zweig.
- Der Deckel der Vorgabe muss ohne jede Einstellung im Slicer drucken.
- Die Zeichen der Schrift von v0.3 (`FORMEN["v03"]`) nicht ändern; neue Formen gehören nach `OFFEN`.
- Keine fremden Druckmodelle übernehmen.

## Rückmeldungen eintragen

- **Ein Maß der Platine** (Messschieber, Passprobe): in `gehaeuse/massmodell.py` den Wert ersetzen,
  Herkunft und Datum eintragen (`M(wert, nr, alt="…")` für eine Messung, `P(…)` für eine Bestätigung
  oder Berichtigung am Probedruck), die alte Zahl als `alt` stehen lassen. Danach
  `.venv/bin/python -m gehaeuse.abgleich uebernehmen`: Das schreibt die Tabelle neu.
- **Passung, Spiel, Schwund:** in `gehaeuse/parameter.py`. Der gemessene Schwund (Probe-Platte, Soll
  60,00 mm) kommt je Material nach `MATERIALIEN`; die Druckdateien werden dann um diesen Anteil
  vergrößert geschrieben. Bis dahin steht dort 0.
- **Lichtschacht:** Liegt er nicht auf, `led_schacht_luft` in ganzen Schichten ändern (0 = liegt im
  Nennmaß auf, 0,2 = eine Schicht kürzer).
- **Beschriftung:** Die Wörter stehen in `parameter.py` und nur dort (`text_wan`, `text_lan`,
  `text_strom`, `text_usb`; `text_reset` und `text_leds` sind leer). Ein leerer Text lässt Wort und
  Dreieck weg. Erlaubt sind A bis Z, 0 bis 9, Leerzeichen und `- + / .`. Ob ein Wort an seinen Platz
  passt, sagt die Prüfung, nicht das Auge.

## Varianten

Was nicht als Datei eingecheckt ist, bleibt als Schalter baubar. Eine Variante ist die Vorgabe mit
geänderten Stellgrößen (`STANDARD.mit(...)`): So baut sie die Prüfung (`VARIANTEN` in
`gehaeuse/pruefung.py`), und so baut `bau.bau_entwurf(p, name)` einen ganzen Stand in einen eigenen
Ordner unter `aus/`. Wird eine Variante zur Vorgabe, ändert man die Vorgabe in `parameter.py` und
baut neu.

| Schalter in `parameter.py` | baut |
|---|---|
| `SCHRIFTGROESSEN` | die Schriftgrößen, die zur Wahl standen: 4,5 mm (`SCHRIFT_V03`), 3,8 mm (Vorgabe), 3,0 mm (`SCHRIFT_FEIN`, eine Bahn je Strich, braucht den Wandgenerator „Arachne“; die 3MF trägt die Einstellung). `./bauen.sh entwurf` baut die beiden anderen Deckel mit |
| `MIT_RESET_UND_LEDS` | auch Reset-Loch und LEDs beschriftet (abgewählt am 11.10.2026) |
| `beschriftung` | `"eingelegt"` (Vorgabe), `"vertieft"`, `"erhaben"` (in dieser Drucklage nicht druckbar), `"keine"` |
| `DECKEL_V02`, `SCHACHT_V01`, `FORM_V0` | der Deckel ohne Beschriftung, der kurze Lichtschacht von v0.1, die Form mit Schraublaschen |
| `wandmontage`, `fuesse`, `lueftung` | ohne Sockel (dann 23,5 mm hoch), ohne Mulden, ohne Schlitze |
| `led_anzeige`, `led_schacht` | Fenster (Vorgabe), offene Löcher oder keine Anzeige; ohne Schacht |
| `etikett`, `ETIKETT_DECKEL` | Etikettfeld auf der Unterseite (Vorgabe), auf dem Deckel (dann ohne „USB“), an der freien Seite oder keins |
| `material` | `"asa"` (Vorgabe) oder `"petg"` |

Die Prüfung baut diese Varianten bei jedem Lauf mit und meldet, wenn eine nicht mehr als ein Körper
baut oder die Platine durchdringt (Prüfbericht, Abschnitt 5).

## Fallen

- Dateien immer mit `encoding="utf-8"` schreiben: Die Kommandozeile von Bambu Studio läuft mit
  `LC_ALL=C`.
- Zwei Bauten derselben 3MF sind nie Byte für Byte gleich (neue `p:UUID` bei jedem Schreiben). STL
  und Bilder dagegen sind es.
- Mehrere Objekte einer 3MF rückt der Slicer auf dem Bett zurecht. Wo ein Objekt liegt, sagt
  `bambu.objekte_auf_dem_bett` (aus den Objektmarken im G-Code).
- Der G-Code von Bambu Studio enthält Kreisbögen (G2/G3) und Bahnen wechselnder Breite; wer Bahnen
  auswertet, nimmt `bambu.bahnen_mit_breite`.
- Schnittkörper um `UEBER` überlappen lassen, damit kein Schnitt auf einer Fläche endet.
- Weitere Regeln, die am Drucker hängen: [Regeln](regeln.md).

## Was geprüft ist und was nicht

Gerechnet wird bei jedem Bau: die Platine als Körper gegen Unterteil, Deckel, Wandschrauben und
Clip; die [Regeln](regeln.md); jede Druckschicht jedes Teils auf schmale Stege; die gedruckten Teile
gegen den festgehaltenen Stand; der Lichtschacht; die Beschriftung in jeder Schriftgröße; jede 3MF
durch die Kommandozeile von Bambu Studio samt einem Blick in den G-Code.

Nicht prüfbar ohne Druck und bisher nicht gemeldet: wie sauber die Schrift in der ersten Schicht
wird, ob die Büroklammer den Reset trifft, ob das Gehäuse an zwei Schrauben sicher hängt, die
Federkraft des Clips, Verzug, Wärme im geschlossenen Gehäuse, und ob die Oberfläche von Bambu Studio
die Farbplätze aus der 3MF übernimmt ([offen](entscheidungen.md#offen)).
