# Rollen-Zuordnung · 1.0

Verbindlicher Vertrag für H-1 (Entscheide E4–E7, E10/E11 und W1–W5,
16.09.2026). [Vektoren](./rollen-zuordnung-vectors.json),
[Schema 2020-12](./rollen-zuordnung.schema.json), reine Zwillinge
`uems/RollenZuordnungRegeln.java` und `uemsRollen.ts`.
**H-1 hat keine Laufzeit-Aufrufer.** Routen, Persistenz und Protokoll schreibt H-2;
Cockpit H-3, Assistent H-5, Karten H-7 und Dialog H-8 folgen getrennt.

## Rolle und Wirkung

| Kennung | Kundenwort | Anlagenwert |
|---|---|---|
| `pv` | PV-Produktion | Summe unabhängiger Beiträge |
| `consumer` | Verbrauch | Summe unabhängiger Beiträge |
| `grid` | Netz | höchstens ein maßgeblicher Wert, niemals eine Summe |
| `keine` | keine Rolle | Vorgabe; keine gespeicherte Rollen-Zuordnung |

`keine` ist die ausdrückliche Auswahl ohne Rolle, kein Alias für einen unbekannten
String und keine vierte Topologie-Rolle. `null`, unbekannte Rollen, `storage`,
`charging` und `charging-own` sind hier nicht zuordenbar. Deren bestehende
Topologie-Semantik bleibt erhalten. Ein Summenwert darf ohne Rolle existieren.

Die Zuordnung wirkt **allein auf die Live-Anzeige der Anlagen-Übersicht**.
Sie ist die ausdrückliche Bestätigung des Kunden nach W3. Sie ändert weder
Vergangenheit, Periodenwerte, Erlösrechnung, Optimierer noch Box-Schutzgrenzen.
Ohne Zuordnung bleibt der bestehende Rückfall auf die Roh-Telemetrie erhalten;
mit einer stummen Zuordnung bleibt die Zahl unbekannt, kein stiller Rückfall.

Folgensätze für spätere Flächen: „Ersetzt in der Anlagen-Übersicht die PV-Zahl
dieses Geräts.“, entsprechend die Verbrauchszahl; Netz: „Wird der Netzwert
dieser Anlage.“ Ein Teilverbrauch ist nur nach ausdrücklicher Wahl Verbrauch
der Anlage; aus einem Ortsnamen wird keine Rolle abgeleitet.

## Identität und Zählregel

Eine Zuordnung gehört zu **Anlage × Gerät × Rolle**. Pro Gerät und Rolle ist
höchstens ein Wert maßgeblich; Ersetzen löst den bisherigen Wert ab.
Der Wert ist **Kanal XOR Summenwert**:

- Kanal: `entity_id` + `point_key`, `quell_messstelle_id = null`.
- Summenwert: `quell_messstelle_id`, beide Kanalfelder `null`.

Nichtleer heißt mindestens ein Nicht-Leerzeichen. Kanalidentität bezieht sich
auf die messende Komponente, nicht auf Box, Port, Namen oder Rolle. Native
Capabilities müssen vor der Regel auf dieselbe Kanalidentität wie die
Formel-Terme aufgelöst sein. Umbenennung erzeugt keine neue Identität.
Ein Summenwert bleibt dieselbe Messstelle über seine Formel-Fassungen hinweg.
Die Auflösung ist mandantengebunden und ausschließlich innerhalb einer Anlage.

**Ein Wert zählt je Anlage und Rolle einmal.** Ein Summenwert über mehrere
Geräte wird jedem gelesenen Gerät zugeordnet, aber nur einmal addiert. Auch
ein zusätzlich zugeordneter Kanal oder innerer Summenwert, der in diesem
Summenwert steckt, zählt nicht nochmals. Die äußere Summe hat Vorrang,
unabhängig von Listen-Reihenfolge, Vorzeichen und Faktoren. Es wird nichts
nachträglich aus einer Summe herausgerechnet. Unabhängige Beiträge bleiben.
Die Zuordnung anderer Anlagen oder anderer Rollen berührt diese Zählung nicht.

Neue Summen aus dem Geräte-Einstieg sind auf dieses physische Gerät begrenzt
([Formelvertrag §1.2](messstelle-formel.md#12-einstiegskontext-für-neue-summenwerte-additiv-16092026)).
Der Anlagen-Einstieg bleibt geräteübergreifend. Bestehende gemeinsame Summen
erscheinen weiterhin an allen beteiligten Geräten und zählen genau einmal.


Die reine Regel bekommt vollständig aufgelöste Zuordnungen: `enthaelt` ist die
rekursive Menge aller enthaltenen Kanal- und Messstellen-Identitäten der
**jetzt wirksamen Formel-Fassung**. Auch ein nicht liefernder Eingang muss in
dieser Herkunft stehen. Ein nativer Kanal hat keine enthaltenen Werte.
Doppelte Zuordnungen derselben Quelle tragen denselben aufgelösten Zustand
und dieselbe Herkunft. Die Regel weist inkonsistente Eingaben zurück;
fehlende Auflösung darf nicht als leere Herkunft geraten werden.

Zwei eigenständige Summenwerte mit überlappender Herkunft lassen sich nicht
als unabhängige Beiträge addieren. Der reine Zwilling weist diesen Eingang
mit `ueberlappende_summenwerte` zurück; er wählt weder willkürlich einen Sieger
noch erfindet er eine Restrechnung. Das ist eine Vorbedingung der Auswertung,
kein neuer HTTP-Vertrag. H-2 muss vor dem Aufruf eindeutige Zuordnungen herstellen.

Die Vektoren verwenden symbolische Identitäten; sie sind keine Seed-Daten.
Der Zwilling bewahrt die Eingangsreihenfolge der übrig gebliebenen Quellen in
`gezaehlt`; diese Liste ist Herkunft, keine zusätzliche Liste von Summanden
pro Gerät. `gesamt` zählt verschiedene zugeordnete Geräte; `beitragend` zählt
die Geräte, deren maßgeblicher (gegebenenfalls äußerer) Wert liefert. So bleiben
„aus N von M Geräten“ und das heutige PV-Verhalten erhalten, ohne eine mehrfach
zugeordnete Summe mehrfach zu addieren.

## Netz-Eindeutigkeit

Nach derselben Identitäts- und Enthalten-Regel darf **höchstens ein Netzwert je
Anlage** verbleiben. Mehrere Zeilen für denselben Summenwert sind ein Wert.
Ein anderer Netzwert ist ein Konflikt `netz_mehrfach`, HTTP **409**. Seine
Frische ändert nichts an der Eindeutigkeit: ein stummer Netzwert bleibt
zugeordnet. Ein bestätigtes Ersetzen muss alle betroffenen Zeilen atomar
ersetzen; H-2 setzt dies auch gegen nebenläufige Anfragen durch.
Positiv bedeutet Netzbezug zur Anlage, negativ Einspeisung; kein Betrag,
kein Klemmen auf null. Keine zweite Netz-Summe neben dieser Regel.

## Ein Frische-Fenster und ehrliche Fehlwerte

Die Anlagen-Übersicht verwendet **300 Sekunden**, für Kanal und Summenwert
gleich. Genau 300 Sekunden sind frisch, eine Millisekunde darüber ist
`veraltet`. Der Auswertungszeitpunkt wird übergeben (keine versteckte Uhr);
Zeitpunkte haben Zeitzone und höchstens Millisekunden. Fehlender Wert oder
Stand sowie ein ungültiger/in der Zukunft liegender Stand ergeben `kein_wert`.
Eine echte Null liefert. Ein von der Quellenauflösung gesetzter Grund bleibt
vorrangig erhalten und unterdrückt eine eventuell mitgelieferte Zahl.

Geschlossene Beitragsgründe:

| Grund | Bedeutung |
|---|---|
| `kein_wert` | keine verwendbare Zahl mit Stand vorhanden |
| `veraltet` | älter als das Fenster der Anlagen-Übersicht |
| `kein_geraet` | Gerät oder zugeordnete Quelle nicht auflösbar |
| `archiviert` | zugeordnete Messstelle archiviert |
| `unvollstaendig` | mindestens ein Pflicht-Eingang des Summenwerts fehlt |

**Innerhalb eines Summenwerts:** `null` statt Teilsumme, wie
[messstelle-formel.md §3](./messstelle-formel.md#3-die-berechnung-cloud-messstelleformelberechnunggewichtetesumme).
Ein fehlender Summenwert wird nicht durch einen zusätzlich zugeordneten
frischen Blattkanal ersetzt. **Zwischen unabhängigen Gerätewerten:** benannte
Teilsumme der liefernden Werte, `unvollstaendig = true`, jeder stumme Beitrag
mit Grund. Liefert keiner, bleibt `wert = null`. Ohne Zuordnung gilt
`zuordnung_vorhanden = false`, `wert = null`, `unvollstaendig = false`.

`stand` des Anlagenwerts bleibt wie im PV-Bestand der jüngste Stand der
liefernden Beiträge; jede Quelle wurde zuvor einzeln auf Frische geprüft.
Er ist keine Zusicherung gleichzeitiger Messung. W4 prüft den Stand der
Summenwert-Live-Antwort gegen 300 Sekunden; die Formel-Route selbst behält
15 Minuten. H-1 ändert weder diese Route noch ihre Stand-Ableitung. Karte und
Assistent müssen den Stand als Text zeigen (H-5/H-7), nicht nur als Punkt.

## Ab jetzt, Protokoll und Größen

Setzen/Ersetzen erzeugt `rolle_gesetzt`, Entzug `rolle_entzogen`. Derselbe
Wert erneut bzw. schon fehlende Zuordnung entziehen ist idempotent ohne neuen
Eintrag. Protokoll: Anlage, Rolle, alter/neuer Wert, Zeit und Akteur. Beim
Ersetzen steht alt/neu in einem Eintrag; Rollenwechsel beendet die alte und
setzt die neue Rolle. Der Entzug führt zum Roh-Kanal-Rückfall. Keine
rückwirkende Rollenfassung; die Formel behält ihre Tagesfassungen.
Diese beiden Wörter stehen im neuen Rollen-Vokabular beider Zwillinge;
Persistenz und Einbindung ins Anlagenprotokoll folgen H-2/H-8.

Größe, Wertart, Richtung, Normierung, Vorzeichen und Faktor folgen unverändert
[messstelle-formel.md §2](./messstelle-formel.md#2-die-abgeleitete-hauptgröße-formelgroesse).
Zählerstand-Summen bleiben zulässig als Summenwert; kWh wird durch eine Rolle
nicht zu kW. Die Anlagen-Live-Zahl benötigt eine passende Leistung (PV:
Erzeugung, Netz: vorzeichenbehafteter Bezug/Einspeisung-Wert). Die Größe ist
vor diesem Zahlenzwilling geprüft. W1 (Vorzeichen-Kanal/Erzeugungs-Haken)
ändert H-4; H-1 berührt keinen Katalog und berechnet keine Formel.

Anlegen/Formel ändern: `messstelle.formel`; Rolle setzen/entziehen:
`geraet.einrichten`. Der Mandant stammt aus dem Kontext, nie aus einer
Kundeneingabe. Die reine Regel ersetzt weder Rechte noch RLS.

## Kundenwort und Übergang

Das eine Kundenwort ist **Summenwert**, Glossar-Konstante `SUMMENWERT`.
„Gesamtwert“, „PV gesamt“ und „Helfer“ sind keine neuen Produkttexte; die
Messstellen-Welt darf „berechnet (Summe)“ mit Kennzeichen sagen. „Gesamt-PV“
bleibt das Cockpit-Wort. Freie bestehende Kundennamen werden nicht umbenannt.

H-1 stellt Konstante und Textregel bereit. `GESAMTWERT` bleibt bis H-5/H-7
als veralteter Bestandsexport unverändert, damit H-1 keine Fläche umbenennt.
`copy.test.ts` erlaubt nur die einzeln erfassten bisherigen Texte in ihren
bisherigen Dateien und höchstens ihrer bisherigen Anzahl; neue Vorkommen
scheitern. H-5/H-7 ersetzen diese Texte und entfernen die Ausnahmen. Die
Wörterliste selbst wird beim Scan der Glossar-Regeldeklaration ausgeklammert.
