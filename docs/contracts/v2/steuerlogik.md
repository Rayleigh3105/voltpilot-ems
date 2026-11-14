# Steuerlogik: die Regelsprache und ihr Kern (Vertrag)

Eine Logik ist ein Text, der frei beschreibt, wie mehrere Geräte einer Anlage zusammen gesteuert werden: Stellwerte, Formeln, gemerkte Zustände, Ausgänge und der Satz für den Kunden.
Herkunft: Steuerlogik-Konzept, entschieden am 14.11.2026 (E1 = A Regelsprache mit Kern auf der Box, E9 = B englische Wörter).
Der Kern liest die kanonische JSON-Form, prüft sie und wertet sie im Takt aus: `edge-app/core/internal/logik`, lauffähig auf beiden Box-Arten.
Die YAML-Schreibform für Menschen liest `edge-app/core/internal/logik/textform`; die Box selbst braucht kein YAML.
In dieser Ausbaustufe schaltet der Kern nichts und ist an keine Auslieferung angeschlossen; er äußert je Takt nur, was die Geräte tun sollen.

Gemeinsame Vektoren: [steuerlogik-vectors.json](steuerlogik-vectors.json) mit den sechs Beispiel-Logiken unter [steuerlogik/](steuerlogik/) (je Schreibform und kanonische Form) und ihren 50 Proben, dazu drei nachgebaute Tage sekundengenau in `edge-app/core/internal/logik/testdata/tage/`.
Die Box liest sie in `logik_vectors_test.go`, `tage_test.go` und `textform/textform_test.go`; jeder spätere Leser der Sprache (der Dienst neben der API, Stufe 2 zweiter Teil) muss dieselben Vektoren bestehen.
Die Vektoren stammen aus dem Referenzlabor des Konzepts; der Kern muss jeden Vektor genau wie das Labor entscheiden, Abweichungen sind Fehler, keine Auslegung.
Alle Namen in den Beispielen sind erfunden.

## Das Dokument

Schema: [steuerlogik.schema.json](steuerlogik.schema.json), Sprachversion `logic: 1`.
Wortliste: [steuerlogik-woerter.json](steuerlogik-woerter.json) (deutsch → englisch, eine Tabelle je Stelle; geschlossenes Vokabular, Zwilling `woerter_test.go`).
Nach der Lesart zu E9 ist die Wortliste mit der ersten Auslieferung fest; bis dahin lässt sich ein einzelnes Wort nur zusammen mit Schema, Kern und Vektoren ändern.

| Abschnitt | Inhalt |
|---|---|
| `devices` | was die Logik schaltet; je Gerät ein Anspruch (`entity`, `name`) |
| `inputs` | was sie liest, je mit `source`, `name`, `max_age`; ohne frischen Wert gilt unbekannt |
| `settings` | Stellwerte: `default`, `range`, `step`, `editable_by`, `help`; Arten `boolean`, `select`, `schedule`, sonst Zahl mit Einheit oder Uhrzeit |
| `constraints` | was zwischen Stellwerten gelten muss |
| `formulas` | benannte Formeln; sie gelten immer mit den aktuellen Werten |
| `states` | was sich die Logik merkt: `boolean`, `timer`, `counter`, je mit `after_restart` |
| `outputs` | je Gerät, was gelten soll: `level`, `on_off`, `setpoint`, `mode`, `percent` als Formel |
| `display` | optional: was die Karte zusätzlich zeichnet |
| `notifications` | Nachricht, wenn etwas eintritt; frühestens nach `repeat_after` erneut |
| `status` | Titel und Satz für den Kunden; die erste zutreffende Zeile gilt, die letzte ist `else` |
| `tests` | Proben: `given`, `after`, `expect` |

Die kanonische Form ist JSON; YAML ist die Schreibform für Menschen und wird ohne Verlust gewandelt.
Die Reihenfolge der Einträge unter `states` ist die Reihenfolge der Auswertung und bleibt erhalten; dasselbe gilt für `given` einer Probe.
Der Leser ist streng: unbekannte Schlüssel, doppelte Schlüssel und verletzte Grenzen des Schemas sind Fehler.

**Die on/off-Regel (die YAML-Falle).**
Leser nach YAML 1.1 machen aus `on`, `off`, `yes`, `no` ohne Anführungszeichen ein Ja oder Nein, Leser nach YAML 1.2 lassen sie als Wort stehen.
Deshalb gilt: Wo ein fester Wert stehen darf, bedeuten `on` und `true` dasselbe, ebenso `off` und `false`; die gespeicherte Form schreibt immer `on` und `off` (einzige Ausnahme: `else: true`, ein Schlüsselwort des Schemas).
Kein Schlüssel der Sprache und kein Name des Verfassers ist `on`, `off`, `yes`, `no`, `true` oder `false`; die Prüfung lehnt solche Namen ab.
Die Schreibform erlaubt nur die kleingeschriebenen Formen `on`, `off`, `true`, `false`; jede andere Schreibweise von Ja und Nein ist ein Fehler, ebenso unzitierte Uhrzeiten (`06:00` wäre in YAML 1.1 eine Zahl) und Dezimalkommas.

## Werte und Rechnen

Werte tragen Einheiten: `°C`, `K` (Abstand), `kW` (`W` wird zu kW), `%`, `s`/`min`/`h`, `°`, `"HH:MM"`.
Gleiche Größen lassen sich addieren und vergleichen; Temperatur ± Abstand bleibt Temperatur, Temperatur − Temperatur ist ein Abstand; mal und geteilt nur mit einer Zahl ohne Einheit.
Vergleiche tragen ein Epsilon von 1e-9; Wörter lassen sich nur mit `==` und `!=` vergleichen.
Alles andere ist ein Fehler, den schon die Prüfung meldet.

Es gibt drei Wahrheitswerte: wahr, falsch, unbekannt.
Ein fehlender oder zu alter Wert ist unbekannt; unbekannt macht ein Ergebnis unbekannt, außer die andere Seite entscheidet schon (`false and x` ist falsch, `true or x` ist wahr).
Ein Schritt geschieht nur bei wahr; ein unbekannter Ausgang heißt bei `level` 0, sonst kein Wunsch.
Ein Ausdruck, der sich zur Laufzeit nicht rechnen lässt, gilt als unbekannt und erzeugt ein Fehler-Ereignis.

Formeln: `and`, `or`, `not`, Vergleiche, `+ - * /`, Klammern; Rangfolge von schwach nach stark: `or`, `and`, `not`, Vergleich, `+ -`, `* /`, Vorzeichen.
Funktionen: `min`, `max`, `if(bedingung, dann, sonst)`, `known`, `unknown`, `time_window(von, bis)` (über Mitternacht erlaubt; `von` zählt mit, `bis` nicht; gleich oder unbekannt heißt rund um die Uhr), `in_schedule(zeitplan)`, `holds(bedingung, dauer)`, `since(zustand)`, `running(timer)`, `last(counter)`.
Geräte-Eigenschaften: `gerät.on`, `.level`, `.power`, `.kw_per_output`, `.output_hours_today` (Summe der Einschaltzeit aller Ausgänge seit Mitternacht), `.requested` (was die Logik im letzten Takt wollte).
`clock` ist die Uhrzeit; die Wochentage heißen `mon` bis `sun`; die Betriebsarten `normal`, `boost`, `cool`, `heat`, `fan_only`, `dry`, `auto`, `start`.

## Zustände und Takt

Ein Takt, jede Sekunde, in dieser Reihenfolge: Werte lesen und ihr Alter prüfen; Zustände in der Reihenfolge des Textes fortschreiben; Ausgänge bilden; Meldungen prüfen; Lage bestimmen.

- **Schalter** (`boolean`): geht an, wenn alles unter `on_when` wahr ist (und eines unter `on_when_any`) und nichts für aus spricht; aus gewinnt.
- **Zeitgeber** (`timer`): wird von einem Zählerschritt gestartet (`then: start(name) if …`); die Dauer wird beim Start gerechnet, eine Dauer von 0 oder unbekannt startet nicht.
- **Zähler** (`counter`): je Takt gilt der erste zutreffende Schritt; `not_before` zählt ab dem letzten Wechsel und darf eine Formel sein; `set` rundet halbe Werte zur nächsthöheren Zahl; das Ziel wird auf `min` bis `max` begrenzt; ein Schritt ohne Änderung zählt nicht als Wechsel.
- **`after_restart`**: `on`/`off`/Zahl setzt den Wert, `keep` behält nur den Wert (beim Zeitgeber die Frist); `since` und `last` zählen nach einem Neustart ab dem Neustart; beim allerersten Start heißt `keep` aus, `min` beziehungsweise Zeitgeber steht.
  Stellwerte und Tageszähler bleiben bei einem Neustart erhalten.
- **Ausgänge**: `level` wird gerundet und auf die Ausgänge des Geräts begrenzt, `setpoint` vom Gerät auf seinen Bereich, `percent` auf 0 bis 100.
- **Meldungen** gehen einmal hinaus, wenn die Bedingung eintritt, und frühestens nach `repeat_after` (Vorgabe eine Stunde) erneut.
- **Lage**: die erste zutreffende Zeile gilt; im Satz steht `{formel}` für einen Wert in deutscher Schreibweise mit Einheit.

Anzeige der Werte: deutsche Schreibweise (Komma, schmales Leerzeichen vor der Einheit, echtes Minus), Leistungen unter 10 kW mit einer oder zwei Stellen, Hälften runden vom Nullpunkt weg (wie das Referenzlabor); die Lagesätze der Tagesvektoren prüfen das Zeichen für Zeichen.

## Prüfung

Pflicht vor dem Scharfschalten ist die Prüfung (E5 = C); der Kern baut ihre sperrenden Punkte:

1. **Aufbau und Einheiten**: jeder Ausdruck lesbar, jeder Name bekannt, Einheiten passen, keine Formel hängt von sich selbst ab; jedes beanspruchte Gerät hat einen Ausgang und umgekehrt; die letzte Lage-Zeile ist `else`; Sätze und Hilfen mit `{formel}` sind rechenbar; kein Wort verdeckt einen Namen.
2. **Stellwerte**: die Vorgabe liegt im Bereich; die Bedingungen unter `constraints` gelten mit den Vorgaben; dazu die Angabe, ob sie sich im erlaubten Bereich verletzen lassen (dann begrenzt die Oberfläche den Regler).
   Ein Stellwert in °C ist ein Zielwert und braucht einen Bereich, weil der Kunde ihn immer stellt (E2 = B); `editable_by` hat an ihm keine Wirkung.
3. **Proben**: jeder Fall wird durchgespielt, mit einem Gerät, das jedem Wunsch folgt.
   Proben sind freiwillig; eine Logik ohne Proben kann scharf gehen und bekommt nur den Hinweis „Keine Proben: Verhalten nicht belegt“.
   Eine vorhandene Probe, die nicht besteht, sperrt weiter (Lesart zu E5).

Die Punkte 4 bis 6 des Konzepts (Ausfall je Eingang, Flattern, Schutzzeiten) sind Hinweise im Dialog und kommen mit der Oberfläche (Stufe 4).
Ob ein Gerät existiert, zum Steuern freigegeben und von keiner anderen Regel beansprucht ist, prüft die Auslieferung (Regel V-5 im [Graphvertrag](flow-graph.md)), nicht der Kern.

## Rechte und Rollen (entschieden 14.11.2026)

`editable_by` kennt `customer`, `customer_admin`, `installer`; ohne Angabe stellt der Fachbetrieb.
Temperaturen stellt der Kunde immer, in ihrem Bereich (E2 = B).
Der Kundenadministrator darf an einer Logik alles, was der Fachbetrieb darf, einschließlich Bereiche und `editable_by` (E3 = B und ihre Lesart); das setzt die Oberfläche in Stufe 4 um, der Kern unterscheidet nicht nach Rolle.

## Ausführung (die nächsten Teile der Stufe 2)

Der Kern äußert nur Wünsche; Schiedsrichter und Schutzgrenzen der Box bleiben, wie sie sind.
Für die Anbindung gilt das Muster des [Heizstab-Reglers](heizstab-regler.md): Klasse `flow` (Rang 40), TTL 45 s, in jedem Takt erneuert, Quelle nur intern; die Geräte einer Logik tragen `owner_claimed`; ohne die Schalter der Box geht kein Wunsch hinaus.
Auslieferung über `v2/flows` mit Hash und Fähigkeit in `supports[]`, Rückmeldung im Herzschlag und der Zustand auf der Platte folgen im zweiten Teil der Stufe 2 und sind hier noch nicht gebaut.

## Versionsregeln

`logic: 1` ist die Sprachversion; der Kern lehnt jede andere ab.
Additive Erweiterungen (neue Funktionen, neue Felder) erhöhen die Version nicht, solange jedes alte Dokument unverändert gilt und die Vektoren unverändert bestehen.
Neue oder geänderte Vektoren, Wörter und Schemaregeln nur gemeinsam ändern: Wortliste, Schema, Kern, Vektoren und diese Seite.
