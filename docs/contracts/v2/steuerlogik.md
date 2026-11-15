# Steuerlogik: die Regelsprache und ihr Kern (Vertrag)

Eine Logik ist ein Text, der frei beschreibt, wie mehrere Geräte einer Anlage zusammen gesteuert werden: Stellwerte, Formeln, gemerkte Zustände, Ausgänge und der Satz für den Kunden.
Herkunft: Steuerlogik-Konzept, entschieden am 14.11.2026 (E1 = A Regelsprache mit Kern auf der Box, E9 = B englische Wörter).
Der Kern liest die kanonische JSON-Form, prüft sie und wertet sie im Takt aus: `edge-app/core/internal/logik`, lauffähig auf beiden Box-Arten.
Die YAML-Schreibform für Menschen liest `edge-app/core/internal/logik/textform`; die Box selbst braucht kein YAML.
Seit Stufe 2, zweiter Teil, wird eine Logik ausgeliefert und läuft auf der Box mit (siehe [Auslieferung und Mitlauf](#auslieferung-und-mitlauf)); sie schaltet nichts und beansprucht kein Gerät, sie äußert je Takt nur, was die Geräte tun sollen.
Seit Stufe 3 lässt sich eine Fassung [scharf](#scharf) schalten: dann gehen ihre Wünsche durch Schiedsrichter und Schutzgrenzen der Box, und ihre Geräte gehören ihr.
Seit Stufe 4 wird eine Logik im Portal geschrieben, im [Aufbau und im Text](#aufbau-und-text-stufe-4), geprüft und als Fassung gespeichert.
Seit Stufe 5 entsteht eine Logik auch aus einem [Baustein](#bausteine-stufe-5): ein Satz mit Lücken, dahinter eine Logik dieser Textform.
Seit Stufe 6 entsteht sie auch [aus den Dateien einer Anlage von Home Assistant](#aus-home-assistant-stufe-6).

Gemeinsame Vektoren: [steuerlogik-vectors.json](steuerlogik-vectors.json) mit den sechs Beispiel-Logiken unter [steuerlogik/](steuerlogik/) (je Schreibform und kanonische Form) und ihren 50 Proben, dazu drei nachgebaute Tage sekundengenau in `edge-app/core/internal/logik/testdata/tage/`.
Für Geräte mit Sollwert und Betriebsart (K2/K3) kommen [steuerlogik-geraete-vectors.json](steuerlogik-geraete-vectors.json) und das siebte Beispiel `waermepumpe-modbus` dazu, von Hand geschrieben; dort ist der Kern die Referenz (`geraete_vectors_test.go`, im Dienst `logikdienst_test.go`).
Die Box liest sie in `logik_vectors_test.go`, `tage_test.go` und `textform/textform_test.go`; der Dienst neben der API besteht sie in beiden Schreibformen (`logikdienst/logikdienst_test.go`), weil er dieselben Leser benutzt.
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
| `states` | was sich die Logik merkt: `boolean`, `timer`, `counter`, je mit `after_restart`; für das Blatt „Warum?“ je Schalter `on_text` und `off_text`, je Zählerschritt `text` (Sätze für den Kunden) |
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
Feste Quellen: `site.grid` (kW, + Bezug), `site.pv` (kW), `battery.power` (kW, + laden), `battery.soc` (%), `sun.elevation` (°), `price.current` (Börsenpreis in ct/kWh als Zahl ohne Einheit, [Preis-Zuleitung](mqtt-price-current.md)); dazu `gerät.signal` mit den Signalen der Wortliste: `temperature`, `room_temperature`, `outdoor_temperature`, `supply_temperature`, `return_temperature` (°C), `humidity` (%), `open`, `door_open`, `defrost`, `fault`, `running` (Ja/Nein).
Geräte-Eigenschaften: `gerät.on`, `.level`, `.power`, `.kw_per_output`, `.output_hours_today` (Summe der Einschaltzeit aller Ausgänge seit Mitternacht), `.requested` (was die Logik im letzten Takt wollte), `.setpoint` (der zurückgelesene Sollwert in °C) und `.mode` (die zurückgelesene Betriebsart); ohne Rücklesung sind die beiden unbekannt.
`clock` ist die Uhrzeit; die Wochentage heißen `mon` bis `sun`; die Betriebsarten `normal`, `boost`, `cool`, `heat`, `fan_only`, `dry`, `auto`, `start`.

## Zustände und Takt

Ein Takt, jede Sekunde, in dieser Reihenfolge: Werte lesen und ihr Alter prüfen; Zustände in der Reihenfolge des Textes fortschreiben; Ausgänge bilden; Meldungen prüfen; Lage bestimmen.

- **Schalter** (`boolean`): geht an, wenn alles unter `on_when` wahr ist (und eines unter `on_when_any`) und nichts für aus spricht; aus gewinnt.
- **Zeitgeber** (`timer`): wird von einem Zählerschritt gestartet (`then: start(name) if …`); die Dauer wird beim Start gerechnet, eine Dauer von 0 oder unbekannt startet nicht.
- **Zähler** (`counter`): je Takt gilt der erste zutreffende Schritt; `not_before` zählt ab dem letzten Wechsel und darf eine Formel sein; `set` rundet halbe Werte zur nächsthöheren Zahl; das Ziel wird auf `min` bis `max` begrenzt; ein Schritt ohne Änderung zählt nicht als Wechsel.
- **`after_restart`**: `on`/`off`/Zahl setzt den Wert, `keep` behält nur den Wert (beim Zeitgeber die Frist); `since` und `last` zählen nach einem Neustart ab dem Neustart; beim allerersten Start heißt `keep` aus, `min` beziehungsweise Zeitgeber steht.
  Stellwerte und Tageszähler bleiben bei einem Neustart erhalten.
- **Ausgänge**: `level` wird gerundet und auf die Ausgänge des Geräts begrenzt, `setpoint` auf die Schrittweite des Geräts gerundet (ab dem unteren Ende seines Bereichs, halbe Schritte nach oben) und auf seinen Bereich begrenzt, `percent` auf 0 bis 100.
  Eine Betriebsart, die das Gerät nicht kennt (die Liste nennt die Anlage), ist kein Wunsch und ein Fehler-Ereignis; es gilt der Ruhewert des Geräts.
- **Meldungen** gehen einmal hinaus, wenn die Bedingung eintritt, und frühestens nach `repeat_after` (Vorgabe eine Stunde) erneut.
- **Lage**: die erste zutreffende Zeile gilt; im Satz steht `{formel}` für einen Wert in deutscher Schreibweise mit Einheit.
- **Sätze für „Warum?“**: `on_text` und `off_text` eines Schalters und `text` eines Zählerschritts sind die Überschriften der Gruppen im Blatt „Warum?“, mit Platzhaltern wie die Lage („Heizt aus dem Netz bis {netz_ziel}“).
  Fehlt einer, bildet der Kern einen Satz aus dem Wortschatz („„Netzheizen“ beginnt“, „Heizstufe um 1 höher“, „Auf 0“); die Kennung eines Zustands oder Schritts erscheint nie vor dem Kunden.
  Die Prüfung nennt jede Gruppe, die das Blatt zeigt und für die der Text keinen Satz hat, in einem Hinweis.
  Ebenso jede Bedingung: eine benannte trägt ihren Namen, eine ohne Namen übersetzt der Kern aus dem Wortschatz (Vergleiche mit Eingängen, Stellwerten und benannten Zuständen, `unknown`/`known`, `holds`, `time_window`, `running`, `since`, `and`/`or`; „„Netzbezug“ liegt über 0,3 kW, seit mindestens 10 min“).
  Was sich nicht übersetzen lässt (eine Formel aus `formulas`, ein Zustand ohne Namen, Rechnen jenseits von „Wert ± Zahl“), heißt im Blatt „Eine Bedingung Ihres Fachbetriebs“, und die Prüfung nennt die Stelle mit ihrer Formel; die Formel selbst steht nie in „Warum?“, sie gehört in die Ansicht des Texts für den Fachbetrieb.

Anzeige der Werte: deutsche Schreibweise (Komma, schmales Leerzeichen vor der Einheit, echtes Minus), Leistungen unter 10 kW mit einer oder zwei Stellen, Hälften runden vom Nullpunkt weg (wie das Referenzlabor); die Lagesätze der Tagesvektoren prüfen das Zeichen für Zeichen.

## Prüfung

Pflicht vor dem Scharfschalten ist die Prüfung (E5 = C); der Kern baut ihre sperrenden Punkte:

1. **Aufbau und Einheiten**: jeder Ausdruck lesbar, jeder Name bekannt, Einheiten passen, keine Formel hängt von sich selbst ab; jedes beanspruchte Gerät hat einen Ausgang und umgekehrt; die letzte Lage-Zeile ist `else`; Sätze und Hilfen mit `{formel}` sind rechenbar; kein Wort verdeckt einen Namen; eine Betriebsart, die fest im Text eines Ausgangs `mode` steht, kennt das Gerät, wenn die Anlage seine Liste nennt.
2. **Stellwerte**: die Vorgabe liegt im Bereich; die Bedingungen unter `constraints` gelten mit den Vorgaben; dazu die Angabe, ob sie sich im erlaubten Bereich verletzen lassen (dann begrenzt die Oberfläche den Regler).
   Ein Stellwert in °C ist ein Zielwert und braucht einen Bereich, weil der Kunde ihn immer stellt (E2 = B); `editable_by` hat an ihm keine Wirkung.
3. **Proben**: jeder Fall wird durchgespielt, mit einem Gerät, das jedem Wunsch folgt.
   Proben sind freiwillig; eine Logik ohne Proben kann scharf gehen und bekommt nur den Hinweis „Keine Proben: Verhalten nicht belegt“.
   Eine vorhandene Probe, die nicht besteht, sperrt weiter (Lesart zu E5).
   Ein Wert unter `given` und ein erwarteter Sollwert (`<gerät>.setpoint` unter `expect`) dürfen eine Formel über Stellwerte sein (`t: mindest - 2 K`, `clock: netz_ab`, `regler.setpoint: normal - vorrat`), gerechnet mit den Stellwerten der Probe; Stellwerte unter `given` gelten zuerst.
   So bleibt eine Probe wahr, wenn jemand den Wert stellt (Stufe 5: die Proben eines Bausteins gelten für jeden Wert, den der Satz anbietet).
   Eine solche Formel kennt nur Stellwerte, feste Werte, Wörter und `min`, `max`, `if`; ihre Größe muss zum Eingang passen, `clock` ist eine Uhrzeit (über Mitternacht gerechnet).
   Die Box führt keine Proben aus; für sie ändert sich nichts.

Die Punkte 4 bis 6 des Konzepts (Ausfall je Eingang, Flattern, Schutzzeiten) sind Hinweise im Dialog und kommen mit der Oberfläche (Stufe 4); bis dahin nennt der Dialog „Scharf schalten“ ausdrücklich, dass sie nicht geprüft sind.
Ob ein Gerät existiert, zum Steuern freigegeben und von keinem anderen Herrn beansprucht ist, prüft die API beim Scharfschalten ([Besitz](#besitz-ein-gerät-hat-nie-zwei-herren)), nicht der Kern.

## Geräte mit Sollwert und Betriebsart (K2/K3)

Klima, Heizung, Kälte (Bericht Abschnitt 15): Das Gerät regelt selbst; die Logik verschiebt seinen Sollwert, wählt seine Betriebsart, gibt frei und meldet.

- **Angaben der Anlage**: Bereich und Schrittweite des Sollwerts und die Liste der Betriebsarten kommen aus den Fähigkeiten des Geräts im Registry-Push (`setpoint_c` mit `min`, `max`, `step`; `mode` mit `modes`), auf der Box (`agent/steuerlogik.go`) wie im Dienst neben der API (`anlageAusRegistry`); die Proben sehen dieselbe Klemme wie die Box.
- **Eingänge**: ein [eigenes Modbus-Gerät mit Schreibwerten](modbus-geraet.md) liefert jedes Signal, das seine Definition einem Kanal zuordnet, als `<gerät>.<signal>`; die Rücklesung seiner Schreibwerte ist `.on`, `.setpoint` und `.mode`.
- **Ausgänge als Befehle** (`agent/steuerlogik_befehle.go`, für das Scharfschalten): `on_off` wird `on_off`, ein Sollwert in °C wird `setpoint_c`, einer in kW `setpoint_kw`, eine Betriebsart `mode`; ohne Wunsch kein Befehl. Band, Schritt, Liste, Abstand zwischen Änderungen und Ruhewerte setzt der Arbiter durch ([Arbitrierung](edge-desired-arbitration.md#geräte-die-selbst-regeln-steuerlogik-k2)).
- **Mitlauf**: der Vergleich „würde schalten“ gegen „ist geschaltet“ umfasst Sollwert (gleich innerhalb 0,05 K) und Betriebsart, wo das Gerät sie zurückliest.
- **Beleg**: die Beispiele Kühlraum und Klimagerät laufen in `agent/modbusgeraet_test.go` gegen ein gestelltes Modbus-Gerät (`modbusgeraet/geraetsim`) mit echten Ausgängen: Sollwert schreiben, Betriebsart wechseln, Band und Abstand greifen, Störung und Steuerung aus.

## Rechte und Rollen (entschieden 14.11.2026)

`editable_by` kennt `customer`, `customer_admin`, `installer`; ohne Angabe stellt der Fachbetrieb.
Temperaturen stellt der Kunde immer, in ihrem Bereich (E2 = B).
Der Kundenadministrator darf an einer Logik alles, was der Fachbetrieb darf, einschließlich Bereiche und `editable_by` (E3 = B und ihre Lesart); seit Stufe 4 trägt das Recht `logik.bearbeiten` das ([Aufbau und Text](#aufbau-und-text-stufe-4)), der Kern unterscheidet nicht nach Rolle.

Gebaut in Stufe 3, für das Stellen von Werten (Recht `betriebsweise.aendern`, Route `PUT /api/v1/sites/{siteId}/steuerlogik/{logikId}/stellwerte/{kennung}`):

| Wert | Wer stellt ihn |
|---|---|
| Zielwert (°C) | jeder mit `betriebsweise.aendern`: Kundenadministrator, Bedienberechtigte, Unterstützer mit „Einrichten und Bedienen“, Plattform |
| `editable_by: customer` | dieselben |
| `editable_by: customer_admin` oder `installer` (oder ohne Angabe) | Kundenadministrator, Unterstützer, Plattform; nicht Bedienberechtigte (403 `recht_fehlt`) |

`customer_admin` und `installer` sind damit in Stufe 3 gleich (Lesart zu E3: der Kundenadministrator darf, was der Fachbetrieb darf).
Die Karte des Portals zeigt Zielwerte und Werte `customer` unter „Das stellen Sie ein“, die übrigen unter „Das legt Ihr Fachbetrieb fest“ - gesperrt, für Kundenadministrator und Fachbetrieb hinter „Ändern“.
Scharfschalten, Zurücknehmen und Stilllegen bleiben in Stufe 3 Sache der Plattform.

## Auslieferung und Mitlauf

Stufe 2, zweiter Teil (gebaut): Die Logik kommt noch als Datei von VoltPilot, eine Oberfläche für Kunden folgt in den Stufen 3 bis 5.

- **Dienst neben der API** (`edge-app/core/cmd/vp-logik-dienst`, Paket `internal/logikdienst`, Compose-Dienst `logik-dienst`, Port 8101): nimmt den Text als YAML-Schreibform oder kanonisches JSON, liest ihn mit denselben Lesern wie die Box, prüft ihn und baut das Artefakt; eine Logik, die die Prüfung sperrt, verlässt den Dienst nicht.
  `POST /pruefe {text, anlage?, registry?}` liefert kanonische Form und Bericht, `POST /artefakt {text, anlage?, registry?, flow_id, flow_version, compiled_at?, site?}` das Artefakt (422 bei unlesbar oder gesperrt, mit Bericht), `POST /quellen {registry?}` was eine Logik an der Anlage lesen und schalten kann (Stufe 4), `GET /health`.
  Der Bericht trägt seit Stufe 4 `meldungen`: je Befund, nicht bestandener Probe und Hinweis `{art, text, ort?, zeile?}` mit der Zeile im Text, wie der Mensch ihn schrieb; ein unlesbarer Text kommt mit `meldungen` an der Zeile, die der Leser nennt.
  Die Geräte der Proben (Ausgänge, kW je Ausgang) liest der Dienst aus `registry`, dem Registry-Inhalt der Anlage, wie die Box ihn bekommt, mit dem Treiber-Leser der Box (`shelly.Config.OutputFacts`); `anlage` je Gerät der Logik geht vor. Ohne diese Angaben gelten die Vorgaben der Proben, und eine Probe, die an der Leistung hängt, sperrt.
  Die API liest die Sprache nirgends selbst; sie ruft nur diesen Dienst (`SteuerlogikDienstClient`).
- **Annahme** (nur Plattform): `POST /api/v1/admin/sites/{siteId}/steuerlogik {text}` legt eine Logik an, `POST …/{logikId}/fassungen` eine neue Fassung, die die laufende ablöst, `POST …/{logikId}/stilllegen` legt sie still.
  Abgelegt in `steuerlogik` als Text (wie gekommen), kanonische Form und Artefakt, alle drei als TEXT: JSONB ordnete Schlüssel um.
  Ehrliche Halte vor jeder Änderung: keine eindeutige führende Box, die Box meldet `steuerlogik_mitlauf` nicht, der Dienst lehnt ab oder ist nicht erreichbar.
- **Auslieferung**: über den vollständigen Satz auf `v2/flows` ([Flow-Artefakt](flow-artifact.md#steuerlogik)), Bündelformat `steuerlogik`, nur an eine führende Box mit der Fähigkeit `steuerlogik_mitlauf` ([supports](edge-supports.md)).
  Die Logik reist als JSON-Text, damit der Hash auch die Reihenfolge der Zustände schützt; dazu der Ort der Anlage (Zeitzone, Lage für den Sonnenstand).
  `required_entities` nennt die Geräte der Logik ohne Fähigkeit: die Box prüft nur, dass sie sie kennt.
- **Mitlauf** (`internal/logiklauf`, beide Box-Arten): jede Sekunde mit den echten Eingängen; was fehlt, ist unbekannt.
  Erzwungen, nicht eingestellt: das Paket importiert nur den Kern, den Sonnenstand und die Herzschlag-Typen (Test der Importliste), seine Abhängigkeiten sind reine Lesewege, und `agent/steuerlogik_test.go` belegt am echten Weg, dass weder der Schiedsrichter einen Wunsch noch das Gerät einen Schaltbefehl sieht.
  Der gemerkte Zustand liegt gedrosselt in `<data_dir>/logik-laeufe.json` (bei Wechseln, höchstens alle 30 s, beim Angleichen und Beenden); nach einem Neustart gelten die Regeln von `after_restart`.
- **Rückmeldung**: der Herzschlag-Block `logik` mit Fassung, Lage, Zuständen und dem Vergleich „würde schalten“ gegen „ist geschaltet“ ([Rückmeldung](steuerlogik-rueckmeldung.md)).

## Scharf

Stufe 3 (gebaut): Scharfschalten ist ein eigener, protokollierter Schritt je Fassung, getrennt vom Mitlaufen.

- **Pflicht** ist nur die Prüfung (E5 = C): der Dienst baut das Artefakt erneut, und was sie sperrt, geht nicht scharf. Die Hinweise stehen gesammelt im Dialog (`GET …/{logikId}/scharf`): Hinweise des Berichts, im Bereich verletzbare Bedingungen, „Die bisherige Steuerung dieser Geräte muss aus sein“ (das Portal kann es nicht prüfen) und was nicht geprüft ist (Punkte 4 bis 6). Eine Bestätigung genügt (`POST …/{logikId}/scharf {fassung, bestaetigt: true}`); sie steht mit wer und wann an der Fassung (`scharf_am`, `scharf_von`, `hinweise`) und im Protokoll.
- **Bündel**: das scharfe Artefakt trägt `armed: true` ([Flow-Artefakt](flow-artifact.md#steuerlogik)) und verlangt je Gerät die Befehle, mit denen die Box es schaltet (`logikdienst.SchaltRecht`): `actuate:setpoint_kw` für eine Stufe an einer Shelly-Ausgangsmenge, `actuate:on_off` für jede andere Stufe und für Ein/Aus, `actuate:setpoint_c` für einen Sollwert in °C, `actuate:setpoint_kw` für einen in kW, `actuate:mode` für eine Betriebsart, an einer SG-Ready-Wärmepumpe ohne eigene Betriebsart `actuate:on_off` (der Kontakt). Die Box nimmt das Bündel nur an, wenn ihr Registry-Eintrag jeden davon nennt. Es geht nur an eine Box mit `steuerlogik_scharf`; eine Box mit nur `steuerlogik_mitlauf` schaltet nie nach einer Logik.
- **Auf der Box** (`agent/steuerlogik_scharf.go`) gilt das Muster des [Heizstab-Reglers](heizstab-regler.md): Klasse `flow` (Rang 40), TTL 45 s, in jedem Takt erneuert, Quelle `steuerlogik` nur intern (ein Wunsch auf dem Bus mit dieser Quelle wird abgelehnt). Ausgänge: `level` an einer Ausgangsmenge die kW der größten Stufe, die passt, an einem einfachen Relais Ein/Aus; `mode` `boost`/`normal` am SG-Ready-Kontakt einer Wärmepumpe ohne eigene Betriebsart (E10 = A) als Ein/Aus; alles andere über die Naht der K2 ([Ausgänge als Befehle](#geräte-mit-sollwert-und-betriebsart-k2k3)): `on_off`, `setpoint_c`, `setpoint_kw`, `mode`, mit Band, Schritt, Liste, Abstand und Ruhewerten aus dem Arbiter. Einen Befehl, den das Gerät nicht ausführt, und einen Anteil (`percent`) sendet die Box nicht: das Gerät bekommt dann keinen Wunsch, und der Herzschlag nennt es (`konflikt.code: ausgang_offen`). Beleg für ein Gerät, das selbst regelt: `agent/steuerlogik_scharf_test.go` (das Klimagerät-Beispiel scharf am gestellten Modbus-Gerät).
- **Darüber** behalten alle ihr Wort: ein Eingriff von Hand (75), die Schutzgrenzen und der Zyklen-Guard (Mindestlauf, Mindestpause, Starts je Tag), „Automatik pausieren“ und die zwei Schalter der Box. Ohne `VP_CONSUMER_CONTROL_ENABLED` geht kein Wunsch hinaus.
- **Freigeben**: ein Gerät, das die Logik nicht mehr wünscht (stillgelegt, zurück im Mitlauf, kein Wunsch in diesem Takt, ein zweiter Herr), lässt die Box sofort los, nicht erst nach der TTL.

### Besitz: ein Gerät hat nie zwei Herren

Steuerart (auch der Heizstab-Regler, der eine Steuerart ausführt), Verbraucherregel oder Regel und eine scharfe Logik schließen sich je Gerät aus.
Beim Scharfschalten (und bei einer neuen scharfen Fassung oder „Zurück“) prüft die API je Gerät aus dem Prüfbericht (`SteuerlogikBesitz`): ein steuerbarer Verbraucher der Anlage, zum Steuern freigegeben (ein Typ, der nur am Simulator belegt ist, bleibt das auch für eine Logik), kein Ladepunkt (Laden hat seinen eigenen Ort), kein Anteil, jeder Befehl, den das scharfe Artefakt verlangt, in den Fähigkeiten des Geräts im Registry-Push (dieselbe Prüfung, mit der die Box das Bündel annimmt; sonst `ausgang_offen`), keine aktive Steuerart, kein Heizstab-Regler, keine Regel, keine andere scharfe Logik.
Jeder Konflikt kommt mit Namen zurück (409 `zweiter_herr`, `konflikte[]`), nie still aufgelöst.
Danach materialisiert die API den Besitz in `flow_claim` (Flow-Kennung = Logik): der Registry-Push trägt `owner_claimed`, Fahrplan und Fristen-Rückfall lassen die Geräte in Ruhe.
In der Gegenrichtung lehnen Steuerart (409) und Regel (V-5) ein Gerät ab, das einer scharfen Logik gehört.
Die Box selbst gibt einem Gerät, das ihr Heizstab-Regler führt, keinen Wunsch einer Logik und meldet den Konflikt (`konflikt.code: zweiter_herr`); zwei scharfe Logiken mit demselben Gerät nimmt sie nicht an.

### Fassungen, Zurück, Stilllegen

- Eine neue Fassung einer scharfen Logik geht nur scharf (`POST …/fassungen {text, scharf: true, bestaetigt: true}`, sonst 409 `scharf_abloesen`): sonst fielen ihre Geräte still aus der Steuerung.
- „Zurück zur vorigen Fassung“ (`POST …/{logikId}/zurueck`) liefert die Fassung davor erneut aus, im selben Zustand (scharf bleibt scharf); „Stilllegen“ (`POST …/{logikId}/stilllegen`) liefert den Satz ohne sie. Beide gehen in derselben Anfrage an die Box und wirken im nächsten Takt; eine laufende Mindestlaufzeit hält ein Gerät bis zu ihrem Ende.
- Auf der Box behält dieselbe Fassung mit gleichem Text ihren Lauf, auch wenn sich Zustand oder Werte ändern; eine neue Fassung (auch „Zurück“) übernimmt die Zustände gleichen Namens und gleicher Art samt letztem Wechsel und Frist eines Zeitgebers, ein Zähler bleibt in seinen neuen Grenzen; alles andere beginnt nach `after_restart` (Bericht 8.9).
- Jeder Schritt steht im Protokoll (`steuerlogik_protokoll`: angenommen, scharf, zurueck, stillgelegt, stellwert; wer, wann, Rolle, Daten), lesbar über `GET …/{logikId}/protokoll` und im Verlauf des Kunden.

### Stellwerte

Ein gestellter Wert ist keine Fassung (Bericht 6.6 Punkt 4): er reist im Bündel (`settings: {revision, values}`) in der Form des Dokuments (`"72 °C"`, `"on"`, `"06:00"`, ein Wort, ein Zeitplan) und startet die Logik nicht neu.
Der Dienst prüft vor dem Speichern Art, Einheit, Bereich, Schritt, Auswahl und die Bedingungen unter `constraints` mit allen Werten zusammen (422 `stellwerte_passen_nicht`); die Box prüft beim Annehmen dasselbe und nimmt ein Bündel mit einem unpassenden Wert nicht an.
Eine neue Fassung übernimmt die Werte, die passen; die anderen fallen auf ihre Vorgabe, die Antwort und das Protokoll nennen sie (`verworfen`).
Die API hält je Logik die Werte und ihren Stand (`steuerlogik_einstellung`); die Box meldet den Stand zurück (`stellwerte.stand` im Herzschlag), und erst dann zeigt das Portal einen Wert als übernommen.
Regler und Schalter zeigen den Wert, der auf der Box gilt; solange eine Änderung offen ist, ihr Ziel mit „wird übernommen …“, nie den alten Wert.
Die Beschreibung der Werte (Name, Art, Einheit, Bereich, Schritt in der Einheit der Vorgabe, `editable_by`, Zielwert) steht im Prüfbericht (`bericht.stellwerte`), so liest das Portal die Sprache nicht.

### Für den Kunden

`GET /api/v1/sites/{siteId}/steuerlogik` liefert je scharfe Logik eine Karte: die Lage der Box mit ihrem Alter, die Störungen (die Box lehnt die Fassung ab, die Logik läuft nicht, die Box schaltet nicht, die Lage ist `fault`, ein Eingang hat keinen Wert, ein Gerät bekommt keinen Wunsch), je Gerät Wunsch, gelesener Stand, Befehl, Halter, Schutz und Konflikt, die Werte mit dem Recht DIESES Aufrufers, die Liste „Warum?“ und die Meldungen der Logik; `GET …/{logikId}/verlauf?tag=` die Schaltungen des Tages und wer welchen Wert gestellt hat.
Beispiel: [steuerlogik-karte.valid.wasser.json](examples/steuerlogik-karte.valid.wasser.json) (gepinnt von `SteuerlogikScharfApiTest` aus dem Block der Box und der Antwort des Dienstes; das Portal liest sie in seinen Tests).
Satz der Lage und Hilfesätze der Werte setzen beide die Werte von jetzt ein, also widersprechen sie sich auf einer Karte nie; belegt mit [steuerlogik-karte-saetze.heizung-winter.json](examples/steuerlogik-karte-saetze.heizung-winter.json) (beide aus einem Lauf des Heizungs-Beispiels, gepinnt von `logik/karte_saetze_test.go`).
Eine Störung (ohne die gewollte Pause und ohne die Box, die sich nicht meldet - das meldet `box.erreichbar`) wird nach zwei Minuten eine Meldung der Überwachung (`steuerlogik.stoerung`, ab Werk eingeschaltet an Anlagen mit scharfer Logik).

Ende zu Ende mit den echten Programmen und einem gestellten Shelly Pro 3: `edge-light/test/steuerlogik-scharf-probe.sh` (scharf, echte Schaltanfragen, Mindestlaufzeit, gestellter Wert ohne Neustart, Fassung 2 und „Zurück“, „Stilllegen“, zweiter Herr).

## Aufbau und Text (Stufe 4)

Gebaut am 15.11.2026 (Bericht Abschnitte 6, 12.3, 13, 17.7): eine Logik entsteht und ändert sich im Portal, im Reiter „Regeln“ neben den Regeln (E7 = A).
„Logik bearbeiten“ öffnet zwei Ansichten desselben Textes, dazu Mitlaufen, Fassungen und Protokoll (`frontend/portal/src/steuerung/logik/`, Adresse `#/anlage/{id}/logik?id=…&ansicht=…`).

- **Aufbau**: jeder Abschnitt als Liste, jeder Eintrag über ein Formular (Gerät, Eingang, Stellwert mit Bereich und `editable_by`, Regel zwischen Stellwerten, abgeleiteter Wert, Schalter, Zähler mit Schritten, Zeitgeber, Ausgang, Erklärsatz, Meldung, Probe).
  Eine Änderung schreibt nur die geänderten Felder in den Text; Kommentare und die übrigen Zeilen bleiben, wie sie sind (`logik/text.ts`).
  Was kein Formular darstellt (ein Zeitplan, `display`, eine fremde Gestalt), bleibt Text und steht als „im Text festgelegt“ da; ein Text, den YAML nicht liest, steht lesbar mit seiner Zeile.
  Die Auswahl der Geräte und Quellen kommt vom Dienst (`/quellen`), mit den Regeln, mit denen die Box liest und schaltet.
- **Text**: die YAML-Schreibform mit Zeilennummern, eigener Einfärbung (keine Editor-Bibliothek, Inhaltsrichtlinie des Portals) und den `meldungen` des Dienstes an ihrer Zeile; am Telefon nur lesbar.
  Daneben die Wortliste als Nachschlageseite, aus einer byte-gleichen Kopie von [steuerlogik-woerter.json](steuerlogik-woerter.json) (`woerter.sync` in `werkzeuge.test.ts`).
- **Prüfen** fragt den Dienst (`POST /api/v1/sites/{siteId}/steuerlogik/pruefe`) mit dem Registry-Inhalt der Anlage, beim Schreiben kurz nach der letzten Änderung; nichts wird gespeichert.
  Der Entwurf liegt bis zum Speichern im Browser.
- **Lebenslauf** einer Fassung: `geprueft` (gespeichert, läuft nicht), `mitlaufend`, `scharf`, `stillgelegt` (V20261115190000).
  Gespeichert wird nur, was die Prüfung nicht sperrt; eine vorhandene Probe, die nicht besteht, sperrt (Lesart zu E5), Proben zu schreiben ist freiwillig.
  Jede Fassung trägt Urheber, Rolle, Zeit, Notiz und Prüfbericht.

| Route unter `/api/v1/sites/{siteId}/steuerlogik` | Recht | Was |
|---|---|---|
| `GET /logiken`, `GET /{logikId}`, `GET /{logikId}/fassungen/{n}`, `GET /{logikId}/protokoll?von=&bis=`, `GET /quellen` | lesend wie die Steuerung | Überblick, Fassungen mit Bericht, Text, Protokoll (90 Tage), was die Anlage bietet |
| `POST /pruefe {text}` | `logik.bearbeiten` | prüfen ohne zu speichern |
| `POST {text, notiz?}`, `POST /{logikId}/fassungen {text, notiz?, basis}` | `logik.bearbeiten` | eine neue Logik, eine neue Fassung (`geprueft`); ist `basis` nicht die neueste, 409 `fassung_veraltet` |
| `POST /{logikId}/fassungen/{n}/mitlaufen` | `logik.bearbeiten` | sie löst die aktive ab und läuft mit; eine scharfe Logik löst sie nicht ab (409 `scharf_abloesen`) |
| `POST /{logikId}/fassungen/{n}/vorlegen` | `logik.bearbeiten` | zur Freigabe vorlegen; scharf schaltet in Stufe 4 die Plattform |
| `POST /{logikId}/fassungen/{n}/zurueck` | `logik.bearbeiten` | zurück auf Fassung n, im Zustand der aktiven; ist sie scharf, nur auf eine Fassung, die schon scharf war (409 `nicht_freigegeben`, die Plattform darf jede) |
| `POST /{logikId}/stilllegen` | `logik.bearbeiten` | die aktive Fassung stilllegen |
| `POST /{logikId}/anfragen {kennung?, text}` | `betriebsweise.aendern` | „Änderung anfragen“ (Bedienberechtigte) |
| `POST /{logikId}/anfragen/{id}/erledigt` | `logik.bearbeiten` | eine Anfrage abhaken |

`logik.bearbeiten` haben Kundenadministrator, Unterstützer mit „Einrichten und Bedienen“ und die Plattform ([Rechte-Matrix](rechte-matrix.md), Nachtrag „Steuerlogik v1 §8.8“).
Bedienberechtigte sehen Aufbau, Text, Fassungen und Protokoll und fragen eine Änderung an; offene Anfragen stehen an der Logik.
Die Plattform schaltet eine vorgelegte Fassung scharf (`GET …/admin/sites/{siteId}/steuerlogik/{logikId}/scharf?fassung=n`, `POST …/scharf {fassung, bestaetigt}`); sie löst dabei die aktive Fassung ab und übernimmt die gestellten Werte, die passen.
Jeder Schritt steht im Protokoll (`gespeichert`, `mitlaufen`, `vorgelegt`, `anfrage`, `erledigt` kommen zu den Schritten aus Stufe 3).

Ende zu Ende mit dem echten Dienst: `frontend/portal/e2e/steuerlogik-bearbeiten.spec.ts` (eine Beispiel-Logik im Aufbau ändern, die Probe anpassen, im Text einen Fehler an seiner Zeile sehen und beheben, als Fassung speichern, mitlaufen lassen; Rollen; eine neue Logik, die die Prüfung besteht).
API: `SteuerlogikBearbeitenApiTest`, Rechte: `RechtMatrixApiTest`, Zeilen: `logikdienst/zeilen_test.go`, Quellen: `logikdienst/quellen_test.go`.

## Bausteine (Stufe 5)

Gebaut am 15.11.2026 (Bericht Abschnitte 6.7, 7, 9 und 12, E4 = A): ein Baustein ist eine Logik dieser Textform mit Lücken und einem Satz für die Oberfläche.
Unter „Neue Regel“ im Reiter „Regeln“ wählt man einen Satz, füllt die Lücken mit Geräten und Werten der Anlage und liest „So verhält sie sich“; gespeichert wird eine gewöhnliche Logik (Fassung 1, `geprueft`), die danach mitläuft und vorgelegt wird wie jede andere (`frontend/portal/src/steuerung/logik/BausteineAbschnitt.tsx`, `BausteinBlatt.tsx`).

**Die Form** ([steuerlogik-baustein.schema.json](steuerlogik-baustein.schema.json), `block: 1`): `name`, wahlweise `description`, `sentence` und `logic` - der Text einer Logik als Zeichenkette (Schreibform oder kanonisches JSON), mit Kommentaren, genau so, wie er gespeichert wird.
Die Lücken bestimmt der Dienst aus der Logik, nicht der Verfasser:

- jedes Gerät unter `devices` (Kandidaten: Geräte der Anlage, an denen die Box jeden Ausgang ausführt, den die Logik ihm stellt, mit derselben Einheit des Sollwerts, jeder fest gewählten Betriebsart und jedem Signal, das die Logik an ihm liest);
- jeder Eingang, der ein Signal eines Geräts der Anlage liest (Kandidaten: Fühler und Signale mit demselben Signal); liest er ein Signal eines Geräts der Logik (`<gerät>.room_temperature`), folgt er dem Gerät und ist keine eigene Lücke;
- jeder Stellwert, den der Satz mit `{name}` nennt (kein Zeitplan; den stellt der Kunde an der Karte).

Geräte und Fühler, die der Satz nicht nennt, stehen unter ihm.
Platzhalter im Text eines Bausteins sind beliebige Kennungen; beim Speichern aus einer Logik schreibt der Dienst `geraet-<name>` und `quelle-<name>`, damit keine Kennung einer Anlage die Anlage verlässt.

**Einsetzen** (Dienst `POST /baustein {baustein, fuellung: {name?, werte}, registry}`): der Dienst ersetzt im Text genau die Werte unter `devices.<x>.entity` und `.name`, `inputs.<x>.source` und `settings.<x>.default` (und `name`, wenn gegeben) - jeweils einzeilig, Kommentare und alle übrigen Zeilen bleiben.
Ohne Füllung schlägt er je Gerät und Fühler das erste passende der Anlage vor (wer genau kann, was die Logik braucht, zuerst; danach, wessen Name zur Lücke passt; verschiedene Geräte für verschiedene Lücken).
Ein Stellwert ohne Füllung behält seine Vorgabe; ein Wert außerhalb von Bereich oder Schritt steht als `fehler` an seiner Lücke.
Antwort: Satz, Lücken (mit Wert, Wert für Menschen, Kandidaten), `vollstaendig`, der Text, sein Prüfbericht und `verhalten` - die Proben nach ihrer Uhrzeit, je mit `uhr` und `lage` (Titel, Art, Satz mit den Werten des Falls).
Gespeichert wird nur `vollstaendig` und was die Prüfung nicht sperrt.
`POST /bausteine` liest mehrere für die Liste (`passt`: jedes Gerät und jeder Fühler hat ein Gegenüber), `POST /baustein/aus-logik` macht aus dem Text einer Logik einen Baustein.

**Die Sammlung** (E4 = A): die Bausteine von VoltPilot für den Start stehen unter [steuerlogik/bausteine/](steuerlogik/bausteine/), die API legt sie ins Jar; ihre Kennung ist der Dateiname.
Was jemand aus einer Logik speichert, liegt in `steuerlogik_baustein` (V20261115200000): ein Partner-Konto für seine Kunden, die Plattform für alle.
Einen Fachbetrieb als Einheit über mehrere Kunden gibt es im Portal nicht (Bericht 8.8); die Sammlung hängt am Partner-Konto (Keycloak-Subject), seine Kunden sind die Kundenbereiche, die ihm eine Unterstützung der Art Installateur gewährt haben, die begonnen hat und nicht vorzeitig beendet wurde (abgelaufen zählt weiter), solange sein Konto dort nicht gesperrt oder entfernt ist.
Die Datenbank setzt das durch (FORCE RLS über `zugriff` und `benutzer` des Kundenbereichs der Anfrage).
Ein Kundenkonto setzt Bausteine ein, speichert aber keine.

| Route unter `/api/v1/sites/{siteId}/steuerlogik/bausteine` | Recht | Was |
|---|---|---|
| `GET` | lesend wie die Steuerung | die Bausteine mit Satz und Lücken für diese Anlage, `darfEinsetzen`, `darfSpeichern` |
| `POST /{bausteinId}/vorschau {fuellung}` | `logik.bearbeiten` | füllen ohne zu speichern: Prüfung und „So verhält sie sich“ |
| `POST /{bausteinId}/logik {fuellung}` | `logik.bearbeiten` | einsetzen: der Dienst füllt erneut, gespeichert wird Fassung 1 mit der Notiz „Aus dem Baustein …“ |
| `POST {logikId, fassung, name, satz, beschreibung?}` | `logik.bearbeiten` und ein Partner- oder Plattform-Konto | eine Fassung als Baustein speichern |
| `DELETE /{bausteinId}` | `logik.bearbeiten`; den eines Fachbetriebs nur sein Konto, einen von VoltPilot nur die Plattform | aus der Sammlung entfernen (die Zeile bleibt mit wer und wann; die Bausteine des Vertrags ändern sich nur mit ihm) |

Gemeinsame Vektoren: [steuerlogik-baustein-vectors.json](steuerlogik-baustein-vectors.json) - je Baustein eine Füllung an einer Anlage und was daraus entsteht (Satz mit Werten, je Probe Uhrzeit, Titel und Satz der Lage); dazu die Antwort des Dienstes [steuerlogik-baustein.valid.eingesetzt.json](examples/steuerlogik-baustein.valid.eingesetzt.json), die API und Portal lesen.
Der Dienst belegt, dass jeder Baustein des Vertrags gefüllt die Prüfung besteht und seine Proben für jeden Wert im Bereich gelten (`logikdienst/baustein_test.go`); API: `SteuerlogikBausteineApiTest`; Ende zu Ende mit dem echten Dienst: `frontend/portal/e2e/steuerlogik-bausteine.spec.ts`.
Eine Wallbox hat keinen Baustein: Laden hat seinen eigenen Ort, eine scharfe Logik beansprucht keinen Ladepunkt ([Besitz](#besitz-ein-gerät-hat-nie-zwei-herren)).

## Aus Home Assistant (Stufe 6)

Gebaut am 15.11.2026 (Bericht Abschnitte 12.4, 13.4 und 14, E8 = A: eigene Form, Bausteine wie in Home Assistant, ein Helfer übersetzt vorhandene Dateien, die Prüfung urteilt).
Unter „Neue Logik“ und auf der Seite einer Logik („Aus Home Assistant“) lädt man configuration.yaml, automations.yaml und scripts.yaml hoch; daraus entsteht eine Logik dieser Textform oder eine Liste, was sich nicht übersetzen lässt, mit Datei, Zeile und Grund.
Übernommen wird der Text als Entwurf; danach geht es weiter wie bei jeder Logik (Aufbau und Text, Prüfen, Proben, Mitlaufen, Vorlegen).
Die Dateien werden nirgends gespeichert.

**Was woraus wird** (Übersetzer `edge-app/core/internal/logikdienst/homeassistant`, nur im Dienst, nie auf der Box):

| Home Assistant | in der Logik |
|---|---|
| `input_boolean`, `input_number`, `input_datetime` (Uhrzeit), `input_select`, die keine Automation ändert | Stellwert mit Name, Vorgabe (`initial`, sonst das Minimum), Bereich, Schritt und Einheit (`W` bleibt `W`, Temperatur-Schritte in K) |
| `input_boolean`, den Automationen ein- und ausschalten | Schalter: `on_when` aus den Bedingungen der einschaltenden Automation, `off_when`/`off_when_any` aus der ausschaltenden; die Prüfung auf den eigenen Stand fällt weg |
| `input_number` mit `increment`, `decrement`, `set_value` | Zähler, je Automation ein Schritt; die zurücknehmenden zuerst |
| `timer` | Zeitgeber; die Dauer aus `timer.start` (Minuten mal 60 bleibt die Dauer des Stellwerts), gestartet mit `then: start(…)` des Schritts |
| Automation nur beim Start von Home Assistant | `after_restart` der Zustände, die sie setzt |
| Vorlagen-Sensor | Formel; einer, der nur einen Messwert weitergibt, ist der Eingang selbst |
| Vorlagen-Binärsensor mit `this.state` | Schalter: an, wenn die Vorlage mit „aus“ wahr ist, aus, wenn sie mit „an“ falsch ist |
| Vorlagen-Sensor mit Texten | die Lage, je Zweig eine Zeile; die Art der Zeile ist aus dem Titel geschätzt, den Satz schreibt man dazu |
| `history_stats` über alle Ausgänge eines Geräts | `<gerät>.output_hours_today` |
| `numeric_state`, `state`, `template`, `time`, `and`/`or`/`not` | Bedingungen; ein Auslöser mit `for:` wird `holds()` der gleichen Bedingung |
| `(now() - states.x.last_changed).total_seconds() > N` am eigenen Zähler | `not_before`; prüft Home Assistant nur im Raster (`time_pattern`), steht das Raster darin (über 300 s zur vollen Minute: 6 min) |
| Skript, das Schalter `<gerät>_l1` … `_ln` nach „k ≤ Stufe“ setzt | Ausgang `level` des Geräts; ein einzelner Schalter `on_off`; Schalter, die Automationen einzeln ein- und ausschalten, ein Schalter-Zustand |
| Messwert, Schalter | Lücke, die man einem Eingang oder Gerät der Anlage zuordnet |

Formeln aus Jinja: `{% set %}`, `{% if %}`, Schleifen über `range()` (ausgerollt), `namespace`, Filter wie `float`, `int`, `min`, `max`, `count`, `reject('in', …)`.
`x|float(d)` gegen eine feste Zahl wird genau so geschrieben, wie Home Assistant ohne Wert rechnet (`p1|float(-1) < 0` wird `unknown(p1) or p1 < 0 °C`); sonst ist ein fehlender Wert unbekannt.
Ein Zeitfenster aus `today_at()` und `now()` wird `time_window()`; ein Schalter, der nur das Vorzeichen eines Messwerts dreht, entfällt, das Vorzeichen legt die Zuordnung fest.
Was die Sprache nicht hat (Warten in Abläufen, Wochentage als Bedingung, Sonnenereignisse, Attribute, einzelne Ausgänge lesen, einen Zeitgeber anhalten), ist „nicht übersetzbar“.

**Hinweise**: wo Home Assistant anders rechnet als die Sprache, steht ein Hinweis an der Stelle, als Kommentar im Text und in der Antwort mit seiner Zeile: Auswertung nur bei Auslösern und im Raster, Ersatzwerte ohne Messwert, Rundung, die Reihenfolge zweier Automationen am selben Zähler, ein Zeitgeber mit der Dauer 0, Schalter, die Home Assistant nur bei Läufen setzt.
Jeder Eintrag nennt seine Herkunft (`# automations.yaml:118`).

**Lücken**: je Gerät (Ausgänge, `level` oder `on_off`) und Messwert (Temperatur, Leistung, Prozent, Ja/Nein; sagen die Dateien nichts, entscheidet die Zuordnung).
Kandidaten nennt der Dienst aus `Quellen` (dieselben Regeln wie die Box); ohne Zuordnung schlägt er Geräte (gleiche Zahl von Ausgängen zuerst, dann der ähnlichste Name) und Fühler mit passendem Namen vor, eine Leistung nie: ihr Vorzeichen wählt der Mensch (`site.grid` oder `-site.grid`, `battery.power` oder `-battery.power`, `site.pv`).
Eine Quelle anderer Größe passt nicht (`fehler` an der Lücke).

Dienst `POST /home-assistant {dateien: [{name, text}], zuordnung?: {kennung: {wert, name?}}, registry?}` (höchstens 8 Dateien, zusammen 1 MB): `{luecken (mit kandidaten, vorgeschlagen), vollstaendig, text, bericht, nicht_uebersetzt, nicht_uebernommen, hinweise (mit zeile), kennungen, dateien}`; nicht lesbares YAML ist 422 `grund: home_assistant`.
Übernehmen lässt sich nur `vollstaendig`: eine Logik ist entstanden, jede Lücke passt, die Prüfung sperrt nicht.

| Route unter `/api/v1/sites/{siteId}/steuerlogik` | Recht | Was |
|---|---|---|
| `POST /home-assistant {dateien, zuordnung?}` | `logik.bearbeiten` | übersetzen mit dem Registry-Inhalt der Anlage, ohne etwas zu speichern; 400 `dateien_fehlen`/`dateien_zu_gross`, 422 `home_assistant_unlesbar` |

Beispiel: [steuerlogik-home-assistant.valid.solarheizung.json](examples/steuerlogik-home-assistant.valid.solarheizung.json) (gepinnt vom Dienst, gelesen von API und Portal).
Maßstab: die Test-Anlage des Übersetzers (`homeassistant/testdata/solarheizung`, erfunden, gleich aufgebaut wie die Vorlage des Konzepts) ergibt eine Logik, die sich wie `heizung-treu` verhält - die elf Proben mit den Namen der Übersetzung bestehen wie dort, die drei Tage sind in jeder Sekunde gleich, 177 Stufenwechsel zur selben Sekunde (`vergleich_test.go`; mit `VP_HA_VORLAGE` und `VP_HA_VORLAGE_NAMEN` misst derselbe Test eine echte Anlage, die nur auf dem eigenen Rechner liegt).
Je Baustein von Home Assistant ein Test: `bausteine_test.go`; Dienst: `logikdienst/homeassistant_test.go`; API: `SteuerlogikBearbeitenApiTest`; Ende zu Ende mit dem echten Dienst: `frontend/portal/e2e/steuerlogik-home-assistant.spec.ts`.

## Versionsregeln

`logic: 1` ist die Sprachversion; der Kern lehnt jede andere ab.
Additive Erweiterungen (neue Funktionen, neue Felder) erhöhen die Version nicht, solange jedes alte Dokument unverändert gilt und die Vektoren unverändert bestehen.
Neue oder geänderte Vektoren, Wörter und Schemaregeln nur gemeinsam ändern: Wortliste, Schema, Kern, Vektoren und diese Seite.
