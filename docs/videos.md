# Videos: Werkzeug, Aussehen, Bewegung, Regeln

So entsteht jedes Video, das VoltPilot nach außen zeigt: Erklärvideos zu Themen des Energiemanagements, Produkt- und Funktionsvideos, kurze Clips.
Das Thema ist frei, zum Beispiel Normen, Lastspitzen, PV und Speicher, Tarife, Verbrauchersteuerung, Druckluft, Förderung oder Nachweise.
Fest sind drei Dinge:

1. **Werkzeug:** HyperFrames, also HTML und GSAP, aus dem ein Video gerendert wird.
2. **Aussehen:** die Design-Tokens, Schriften und das Logo aus dem Designsystem des Portals.
3. **Bewegung:** Motion Design mit vollem Einsatz. Ein Video soll zeigen, was Bewegung kann, und jede Bewegung erklärt etwas.

Das erste Video dieser Art ist "ISO 50001 einfach erklärt" (Oktober 2026).
Es dient als Beispiel, nicht als Schablone: Ein neues Thema bekommt neue Bilder.

Die Videoprojekte liegen nicht in diesem Repo, weil sie überwiegend aus Ton- und Bilddateien bestehen.
Jedes Projekt trägt vier eigene Dokumente: `BRIEF.md` (Auftrag und Grenzen), `design.md` (Aussehen), `STORYBOARD.md` (Szenen mit Zeitmarken) und `README.md` (Aufbau und Befehle).

## 1. Werkzeug: HyperFrames

- Ein Video ist ein HyperFrames-Projekt mit einer `index.html` als Bühne und einer einzigen pausierten GSAP-Timeline.
- Die Version steht fest im Projekt, alle Befehle laufen mit `npx hyperframes@<version>`.
  Die zugehörigen Skills kommen mit `npx skills add heygen-com/hyperframes` ins Projekt.
- Der Arbeitsablauf ist immer derselbe: `lint`, `check`, `snapshot . --at <Sekunden>`, `preview`, `render --quality draft`, dann `render --quality delivery`.
- Format ist 1920 x 1080 mit 50 Bildern je Sekunde, H.264, Ton AAC mit 48 kHz.
  Ein anderes Format, etwa hochkant, nennt der Auftrag.
- Jedes Bild ist eine reine Funktion der Zeit: keine Uhr, kein Zufall ohne festen Startwert, das Layout wird einmal beim Aufbau gemessen.
  Nur so stimmen Vorschau, Standbild und Render überein.
- Schriften, Skripte, Bilder und Ton liegen lokal im Projekt, nichts kommt aus dem Netz.
- Einfache Elemente bewegt die Timeline direkt.
  Zusammengesetzte Zustände wie Kamera, Cursor und Verwandlungen schreibt eine Funktion einmal je Bild aus der Timeline-Zeit.
- Sprache und Musik sind eigene Spuren.
  Die Musik weicht der Sprache aus (Carve gegen die Sprechergruppe), nach dem Render bringt ein Mastering-Schritt den Ton auf -16 LUFS mit Spitzen unter -1,5 dBFS.

Bekannte Fallen:

- Szenen sind einfache Ebenen, deren Sichtbarkeit die Timeline setzt.
  Zeitgesteuerte Hüllen mit Kindern meldet der Lint als Fehler.
- Verstecken heißt immer Deckkraft null und unsichtbar zusammen.
  Die Studio-Vorschau erzwingt sonst Sichtbarkeit.
- Wertspuren für Kamera oder Fenster werden in Filmreihenfolge beschrieben, weil jeder Schritt beim vorigen beginnt.
- Schreiber mit Zeitfenster setzen auch außerhalb des Fensters den verborgenen Zustand, sonst zeigt ein Sprung alte Reste.
- Gewollte Überlagerungen wie Erklärkarten werden für die Layout-Prüfung als solche markiert, und zwar jedes Element einzeln.
- Nach jeder Änderung an Sprache oder Musik wird das Ausweichen der Musik neu berechnet.
- Szenen, deren Aufnahme gleich bleibt, behalten ihre Zeitmarken und werden als Block verschoben.
  Der Abschluss wandert dabei um ganze Takte, damit das Logo auf dem Schlag bleibt.

## 2. Aussehen: Design-Tokens

Quelle ist das Designsystem des Portals, nicht das Gedächtnis:

| Was | Wo |
|---|---|
| Farben, Schrift, Abstände, Effekte | `frontend/portal/designsystem/tokens/` |
| Flächenfarben des aktuellen Portals (`--vp-c-*`) und Energiefarben (`--vp-flow-*`, `--vp-c-chart-*`) | `frontend/portal/src/index.css` |
| Schriftdateien (Inter, Inter Tight, Plus Jakarta Sans) und Logo | `frontend/portal/designsystem/assets/` |

- Werte werden übernommen, nicht nachgemischt.
  Das Projekt hält sie in `design.md` fest, mit Token-Namen und Wert.
- Eine Farbe, die es im Designsystem nicht gibt, kommt nicht ins Video.
- Der Kern für die meisten Videos:

| Rolle | Token | Wert |
|---|---|---|
| Grund | `--vp-c-bg` | `#f8fafc` |
| Karte | `--vp-c-card` | `#ffffff` |
| Rand | `--vp-c-border` | `#e2e8f0` |
| Text | `--vp-c-fg` | `#1e293b` |
| Nebentext | `--vp-c-muted-fg` | `#475569` |
| Akzent, Links, Messwerte | `--vp-c-primary` | `#2563eb` |
| Überschriften, große Zahlen | `--vp-navy` | `#1E3A5F` |
| Schaltflächen | `--vp-action` | `#2C5282` |
| Markenblau für Ringe und Verläufe | `--vp-primary`, `--vp-primary-dark`, `--vp-primary-deep` | `#95B9FF`, `#7BA3F7`, `#5A8DE8` |
| Auffälligkeit, Warnung | `--vp-c-warn-fg` auf `--vp-c-warn-bg` | `#9a3412` auf `#fff7ed` |
| Verbrauch, Last | `--vp-flow-load` | `#8b5cf6` |
| PV | `--vp-flow-pv` | `#f59e0b` |
| Netz | `--vp-flow-grid` | `#0ea5a3` |
| Gut, Einsparung, Speicher | `--vp-c-chart-batt` | `#16a34a` |

- Überschriften und große Zahlen stehen in Inter Tight, Fließtext in Plus Jakarta Sans, Portal-Navigation in Inter.
- Das ganze Video ist hell.
  Eine dunkle Bühne wurde verworfen.
- Farbe trägt Bedeutung und bleibt im ganzen Video dieselbe: Blau misst, Grün spart oder bestätigt, der warme Ton zeigt, was nicht nötig ist.
- Text ist in 1080p mindestens 22 Pixel groß und erfüllt WCAG AA.
- Das Portal erscheint als Nachbau im Portal-Look mit Beispieldaten, nie als Bildschirmfoto mit Kundendaten.
  Maße und Farben des Nachbaus werden am echten Portal abgelesen.

## 3. Bewegung: Motion Design mit vollem Einsatz

Der Maßstab des Auftraggebers: dynamisch, zeigt Können, und der Inhalt bleibt im Vordergrund.
Ein Video, das nur einblendet und schiebt, ist zu wenig.

Grundsätze:

- Jede Szene hat eine Bewegungsidee, die den Inhalt erklärt.
  Ein Kreislauf dreht sich, ein Weg wird gefahren, ein Signal läuft durch die Stationen.
- Der Raum gehört dazu: eine Bühne mit Perspektive, eine Kamera mit Ort, Zoom und Neigung, Ebenen in verschiedener Tiefe.
- Szenen gehen ineinander über.
  Ein Element der alten Szene wird zum Element der neuen, statt dass ein Bild das andere ablöst.
- Bewegung führt den Blick: Was gerade gesagt wird, bewegt sich; alles andere ruht oder wird unscharf.
- Vor einem Höhepunkt steht das Bild einen Moment still.
- Die Sprache gibt den Takt.
  Jede Bewegung sitzt auf dem Wort, zu dem sie gehört, und die Marke steht als Kommentar im Code.
- Heißt der Auftrag "frei gestalten", ändern sich die Bilder selbst, nicht nur ihre Bewegung.
  Zwei oder drei Standbilder gehen vor dem Animieren zur Ansicht.

Bewährtes Vokabular (Werte aus dem ersten Video):

| Mittel | So |
|---|---|
| Wörter schnellen herein | von unten, 36 bis 72 Pixel Weg, 0,12 bis 0,18 s, `power4.out`, sofort deckend statt eingeblendet |
| Platz machen | drei Phasen: langsam an, kurzer Stoß, langer Auslauf |
| Szenenwechsel in einer Richtung | das Alte beschleunigt 230 Pixel nach links und ist kurz vor dem Schnitt weg, das Neue zündet mitten im Weg und bremst, je 0,32 s |
| Themenwechsel | Unschärfe-Schnitt: unscharf werden, hart tauschen, länger scharf werden |
| Durch etwas hindurch | die Kamera fährt durch eine Form in die nächste Szene |
| Verwandlung | Bänder schließen sich zum Ring, ein Signalweg öffnet sich zum Kreis, ein Fenster wird zum Bildschirm einer Station |
| Fenster als Gegenstand | das Portalfenster hat eine eigene Lage im Raum und eine innere Kamera; zum Kapitelwechsel tritt es gekippt zur Seite |
| Cursor als Akteur | kommt von außerhalb ins Bild, drückt sichtbar, und das Ziel reagiert im selben Bild |
| Zahlen | zählen hoch und wachsen dabei, mit Tabellenziffern |
| Linien und Wege | zeichnen sich, ein Punkt oder die Kamera fährt mit |
| Fluss | Werte fahren als Chips auf ihrer Bahn von Station zu Station |
| Musik | selbst komponiert, eigenes Taktraster, Logo und Wendepunkte auf dem Schlag |

Nicht verwenden:

- Überschwingen und Gummiband-Kurven.
- Langsames Einblenden für etwas, das ankommt.
- Denselben Übergang für jede Szene.
- Bewegung ohne Aussage.

## 4. Aufbau und Text

- Einstieg mit einer Frage, die das Publikum sich selbst stellt.
- Erst das Konzept, dann das Produkt an einem Beispiel, dann der Beleg, dann eine Handlung.
- Ein Beispiel trägt das ganze Video.
  Es soll etwas zeigen, das ohne Messen und Steuern nicht geht.
- Ein Gedanke pro Bild.
  Eine große Zahl steht neben dem Bild, das sie belegt.
- Kapitelwörter und Fragen bleiben mindestens zwei Sekunden groß stehen.
  Die aktuelle Frage bleibt danach klein im Bild.
- Eine Technikszene wächst aus dem, was vorher im Bild war, und nennt nur Bausteine, die es gibt.
- Anrede ist "Sie", die Sätze sind kurz.
- Titel und Thumbnail versprechen keine Laufzeit, die das Video nicht einhält.
- Der Abschluss nennt die Marke, einen Satz und eine Handlung.
  Die Hinweise bleiben stehen, das Bild blendet nicht ab.

## 5. Aussagen, Beispiel und Zahlen

- Nie sagen oder zeigen, dass VoltPilot eine Norm erfüllt, konform oder zertifiziert ist.
  VoltPilot unterstützt das Energiemanagement; ob eine Norm erfüllt ist, stellt eine Zertifizierungsstelle fest.
- Geht es um eine Norm, steht am Ende lesbar: "VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden."
- Keine gesetzlichen Schwellenwerte nennen.
  Sie ändern sich, und ein Video ist keine Rechtsauskunft.
- Keine Preise, Softwarekosten, Förderquoten und Amortisationszeiten.
  Solche Zahlen veralten, und eine Quote im Video ist ein Versprechen.
  Die volle Rechnung gehört auf eine Seite, die aktuell gehalten wird.
- Erlaubt ist der Hinweis "BAFA-förderfähig" im Wortlaut der Geschäftsführung, ohne Programm, Quote und Betrag.
- Ein Video zeigt nur, was das Produkt kann oder was für dieses Video ausdrücklich freigegeben ist.
  Offene Punkte stehen in `BRIEF.md` und werden vor der Veröffentlichung geklärt.
- Steuerung immer mit der echten Aufgabenteilung zeigen: Die Regel entsteht in der Cloud, die Box vor Ort führt aus, Schutzgrenzen bleiben gewahrt.
- Wirkung wird gemessen und mit einer Bezugsbasis verglichen, nicht behauptet.
- Beispielunternehmen und Daten sind fiktiv und im Bild so gekennzeichnet.
  Jede Einsparung trägt das Wort "Beispielrechnung" und den Strompreis, mit dem gerechnet wurde.
- Einsparungen bleiben in der Größe, die eine gängige Faustregel trägt.
  Wirkt die Zahl zu klein, wird das Beispielwerk größer, nicht der Prozentwert.
- Eine Geldzahl ist erlaubt, wenn sie sich im Bild aus dem gerade Gezeigten herleitet.
- Gesprochene und gezeigte Zahlen stimmen überein.
  Ein Datensatz gilt für alle Seiten: Anteile, Summen, Kennzahl und Rechnung gehen auseinander hervor.
- Einheiten und Vorzeichen stimmen: kW ist nicht kWh, Bezug ist nicht Einspeisung.
- Produktbegriffe bekommen einmal den Fachbegriff zur Seite, den das Publikum kennt.

## 6. Stimme und Musik

Stimme:

- Die Sprecherstimme ist der Stimmklon einer Person aus dem Team.
  Erzeugt wird sie lokal auf deren Rechner mit `mlx_audio.tts.generate`.
- Braucht ein Video neue Sätze, liefert der Agent die fertigen Befehle zum Erzeugen, einen je Aufnahme.
  Die Person führt sie selbst aus; der Agent erzeugt keine Aufnahmen in dieser Stimme.
- Jeder Befehl hat diese Form, nur `--text` und `--file_prefix` wechseln:

```bash
mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit --ref_audio ~/Stimmen/praezise_referenz.wav --ref_text 'Energie ist das Fundament jedes modernen Unternehmens. In diesem Video zeige ich Ihnen, wie Sie Ihren Verbrauch intelligent steuern.' --text 'Der Satz für diese Aufnahme.' --lang_code German --output_path <Ordner der Aufnahmen> --file_prefix s07_messen < /dev/null
```

- `--file_prefix` trägt die Szenennummer und ein Stichwort; die Datei heißt danach `s07_messen_000.wav`.
  Eine geänderte Fassung bekommt die Endung `_v2`, die alte Aufnahme bleibt liegen.
- `< /dev/null` am Ende gehört dazu, damit der Befehl nichts von der Tastatur liest und mehrere eingefügte Befehle nacheinander durchlaufen.
- Zu jedem Befehl nennt der Agent die Szene und wofür der Satz gebraucht wird.
- Die Befehle stehen zusätzlich im Videoprojekt in `generate_vo.sh`, damit die Texte nicht nur im Terminal-Verlauf liegen.
- Im Sprechtext sind Zahlen, Einheiten und Normnamen ausgeschrieben, zum Beispiel "fünfzigtausendeins", "sieben bar" und "fünfzehn Minuten".
  Pausen entstehen durch Satzzeichen.
- Vor einem neuen Text die vorhandenen Aufnahmen prüfen.
  Ein Satz ohne Bezug auf das Beispiel lässt sich oft weiterverwenden.
- Nach dem Erzeugen prüft der Agent jede Datei: Länge, Pausen passend zu den Satzzeichen, Pegel.
  Anhören kann er sie nicht; Aussprache und Betonung beurteilt die Person.
- Die Aufnahmen bestimmen alle Zeitmarken.
  Sie werden nicht geschnitten, gestreckt oder umgestellt.

Musik:

- Die Musik komponiert der Agent für jedes Video selbst.
  Keine Musik aus Bibliotheken, keine fremden Aufnahmen, keine Samples.
- Sie entsteht vollständig aus einem Skript im Projekt (`scripts/music.py`, reine Klangsynthese), damit sie sich mit dem Video ändern lässt.
- Tonart, Tempo und Instrumente passen zum Thema und zur Marke: hell, ruhig vorantreibend, nie aufdringlich.
- Das Taktraster richtet sich nach dem Film: Taktstriche liegen auf den Wendepunkten und auf dem Logo.
  Wird das Video länger, wächst die Musik um ganze Takte.
- Die Musik folgt dem Bogen des Videos: leiser Einstieg, mehr Antrieb im Hauptteil, ein ruhigerer Abschnitt unter langen Erklärungen, ein Akzent auf dem Höhepunkt, ein Schlag auf dem Logo.
- Sprache geht vor Musik.
  Die Musik weicht der Stimme aus, und der Agent misst nach dem Render Lautheit und Verhältnis von Sprache zu Musik.

## 7. Abnahme und Veröffentlichung

- Vor jeder Lieferung läuft `npx hyperframes check` ohne Befund.
- Neue Szenen werden an Standbildern in voller Größe geprüft, Übergänge an Bildfolgen.
- Die Lage der Sprachaufnahmen wird im gerenderten Ton nachgemessen.
- Erst ein Entwurf, dann der Render in Lieferqualität.
- Eine gelieferte Fassung bleibt liegen; die nächste bekommt einen eigenen Dateinamen, der Quellstand der alten wird gesichert.
- Wer liefert, sagt, was geprüft wurde und was nicht.
  Standbilder und Messwerte ersetzen nicht, das Video einmal in Echtzeit anzusehen und anzuhören.
- Zum Video gehören Titel, Beschreibung mit Kapiteln, Tags, Untertitel und Thumbnail.
- Kapitel beginnen bei 0:00, es sind mindestens drei, und jedes dauert mindestens zehn Sekunden.
- Die Beschreibung wiederholt die Hinweise aus dem Video.
- Untertitel entstehen aus den Sprechmarken der Aufnahmen.
- Das Thumbnail ist schlicht und handelt vom Thema des Videos.
  Keine Zahl aus dem Beispiel und kein Bildschirmfoto im Vordergrund.
- Ob ein Video mit geklonter Stimme als veränderter Inhalt zu kennzeichnen ist, entscheidet die Person, der die Stimme gehört.
- Platzhalter für Link, Webadresse und Kontakt sind vor dem Veröffentlichen ersetzt.

## Vor dem Hochladen

1. Abschnitt 5 Punkt für Punkt gegen Bild und Ton geprüft.
2. Offene Punkte aus `BRIEF.md` geklärt, gezeigte Funktionen freigegeben.
3. Farben und Schriften stammen aus dem Designsystem.
4. `npx hyperframes check` ohne Befund, Ton bei -16 LUFS.
5. Einmal in Echtzeit angesehen und angehört.
6. Titel, Kapitel, Untertitel und Thumbnail passen zur gelieferten Fassung und ihrer Länge.
