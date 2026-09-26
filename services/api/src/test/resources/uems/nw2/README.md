# NW-2: Steuerung aus einem Stück

`UemsBestandSteuerungAusEinemStueckTest` ist der gemeinsame API-Nachweis für
AP-14 IP-5, H4/H5, Referenzfall U1. Ein Testfehler ist ein Befund für Tor G0;
Referenzdateien dürfen nicht aus dem UEMS-Lauf neu geschrieben werden.

## Herkunft der Referenz

- Produktivcode: `main`, Commit `4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3` (bytegleich nachgemessen auf `8b8b6a03b`, siehe unten).
- Schema: genau dessen 168 Produktionsmigrationen, ohne Dev-Seeds.
- Saat: `main-seed.sql`, direkt auf diesem Schema, keine UEMS-Route. Der alte
  V2-Startmarker ist vorhanden, wie bei einer auf main schon gestarteten Anlage.
  `seedContracts()` liest Fähigkeiten/Schutzgrenzen aus den bestehenden
  `edge-entity.valid.registry-push*.json`-Vektoren und die vollständige aktive
  Heizstab-Regel aus `consumer-policy.valid.heater.json`; ihr Hash stammt aus
  dem bestehenden `ConsumerService.contentHash`. Das freie Register entspricht
  der Definition in `MeasurementSelectionApiTest`.
- Anwendung: vollständiger Spring-Kontext, echte Dienste/Repositories,
  `voltpilot_app` mit RLS; Keycloak-Kontenliste und MQTT-Netzverbindung ersetzt.
- Zeit der Befehle: `2090-09-18T10:00:00Z`, Registry-Uhr ebenfalls fest.
  Das ferne Datum hält den bereits laufenden Handeingriff unabhängig vom
  Ausführungstag lebend. Läufer laufen mit der tatsächlichen Uhr.
- Aufnahme: dieselbe Testklasse wurde unversioniert auf dem obigen Main-Commit
  ausgeführt, mit `./mvnw clean test -Dtest=UemsBestandSteuerungAusEinemStueckTest
  -Dnw2.capture=/tmp/nw2-main-reference.json` und JDK 21.
  Danach wurde die aufgenommene Datei hierher kopiert. Reguläre Tests lesen sie
  ausschließlich. Aufnahme ist ausdrücklich kein Update-Modus auf UEMS.

Die Werte der JSON-Datei enthalten die originalen UTF-8-Ausgaben als Strings;
die Zusicherungen vergleichen Bytes, nicht geparste JSON-Objekte. Damit zählen
auch Reihenfolge und Formatierung. Bei Registerbefehlen wird ausschließlich die
zufällige Hex-Korrelation durch `0000000000000000` ersetzt; vorher werden ihr
Vertragsformat und die Antwortkorrelation geprüft. Die einzige fachliche
HTTP-Ausnahme steht in der folgenden Tabelle. Registry-Bytes werden überhaupt nicht normalisiert, insbesondere
nicht `driver.data_source_id`.

## Nachgemessen beim Nachzug main 8b8b6a03b (26.09.2026)

Die Referenzdatei ist **unverändert**. Beim Nachzug von `main` `8b8b6a03bcf757a241d60567080259ccb2163422`
(62 Commits, `main-migrations.txt` jetzt 169 Migrationen) wurde die Aufnahme auf diesem Commit
wiederholt — dieselbe Testklasse unversioniert in einem frischen Klon von main, `MAIN` auf den neuen
Commit, `-Dnw2.capture=…` — und mit `main-reference.json` verglichen: **bytegleich** (12 005 Bytes,
alle 13 Einträge). Die 62 main-Commits ändern also keine der acht geschützten Ausgaben; die Referenz
gilt für main 8b8b6a03b wie für 4aa1e7fb, `MAIN` nennt seither den jüngeren Commit. Für eine spätere
Aufnahme: auf main fehlen die UEMS-Sender `VerbundAnteilePublisher` und `SprungprobePublisher`; ihre
zwei `@MockBean`-Zeilen und ihre Namen in `senders()` müssen in der Kopie entfallen (die Klasse
übersetzt sonst nicht).

## Bewusste Differenzen main → uems

Entscheid vom 18.09.2026; weitere Unterschiede benötigen einen eigenen Befund.

| Wo | Seit wann | Warum verträglich / ausdrückliche Prüfung | Was die Box sieht |
|---|---|---|---|
| `pushReason:null` in POST/DELETE `battery-override` und `consumers/{id}/override` | [AP-06 IP-8](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/877), `439daaf4aa2dbdb75b8defbd519d075a92e7aacd`, 16.09.2026 | Additive, nullable Diagnose für das gemeinsam ausgerollte Portal (`frontend/portal/src/api.ts`, optionales Feld). Alle vier Antworten müssen das Feld mit **null** und `pushed:true` enthalten. Ausschließlich der genaue Suffix `,"pushReason":null` wird entnommen; der restliche Antwortkörper bleibt bytegleich. Jedes weitere Feld macht den Vergleich rot. | Nichts: alle vier MQTT-Nachrichten bleiben vollständig bytegleich. |
| `entities[].driver.data_source_id` im Registry-Push **nach bestätigter Quellen-Übernahme** | [AP-06 IP-13](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/939), `1309008e99483b678b7d70b3c98dd112c7a2e1cb`, 18.09.2026; AP-06-Report Zeile 723/A12 | Optionales additives Feld, das alte Boxen überlesen. Dieser Test bestätigt **keinen** Vorschlag: hier ist das Feld ausdrücklich verboten und der gesamte Push bleibt bytegleich. | Erst nach Bestätigung die zusätzliche Quellkennung; in diesem Nachweis unveränderte Bytes. |

## Ablauf und Grenze

Auf UEMS: `migration/main-migrations.txt` in ein temporäres Flyway-Verzeichnis
kopieren → SQL-Saat → Bestandsschutz-Fingerabdruck → übrige Migrationen mit
`outOfOrder(true)` → vollständigen Spring-Kontext starten → alle drei
Bestandsläufer und zehn weiteren Läufer synchron aufrufen. Ihre Menge wird
gegen `UemsLaeuferMelder.KATALOG` geprüft. Timer sind entfernt, damit kein
zufälliger Hintergrundtakt den Nachweis verfälscht. Die Produktionsmethoden
und alle bedingten Läufer-Beans bleiben aktiv; die drei Startup-Methoden werden
über ihren synchronen `lauf()`-Einstieg ausgeführt.

Alle elf MQTT-Sender werden gezählt; die Liste wird wie in `AnlageUmzugApiTest`
gegen die tatsächlichen MQTT-Sender geprüft. Der Main-Start veröffentlicht
bereits eine Freigabe-Nachricht: die Startzähler müssen deshalb exakt gleich
bleiben. Danach werden sie auf null gesetzt; keiner der 13 Läufer darf senden. Die acht Vergleiche sind eigenständige Tests: ein roter Vergleich
überspringt nicht die folgenden. Der Registry-Push erfolgt vor jedem weiteren
Testbefehl; Quellen-Vorschläge werden nicht bestätigt.

Planvergleich bedeutet hier die tatsächliche API-Ausgabe `GET /sites/{id}/schedule`
für den gespeicherten Plan samt Gerätezuordnung. Der Optimierer publiziert den
MQTT-Plan außerhalb der API. Dieser Test ist weder ein Optimierer- noch ein
Box-/Hardware-Nachweis; dafür ist NW-3 vorgesehen. Register-Rücklesen ist eine
explizite Box-Attrappe, keine Behauptung einer gemessenen physischen Wirkung.

Die expliziten Fingerabdruck-Ausnahmen sind Funktion/Teilnahme, Rechte samt
Protokoll und Bestandsstichtag, die drei Arbeitscursor und `component_template`.
Letzteres ist der globale Start-Katalog; die Bestandsanlage referenziert keine
Vorlage. Ihre gespeicherten Komponenten samt Fähigkeiten und Schutzgrenzen,
alle Overrides, Freigaben, Verbraucherregeln, Registerauswahl, Ladeeinstellungen,
Planzeilen und der gespeicherte Registry-Zustand bleiben vollständig geschützt.

Der zusätzliche UEMS-Fall bindet einen Anschluss mit 200 kW: eine vom Kunden
übermittelte Angabe von 999 kW erlaubt keine Ladegrenze von 250 kW. Die
abgelehnte Änderung sendet nichts; 150 kW werden angenommen und genau so
veröffentlicht. Die Referenz ohne Anschluss prüft ausdrücklich die alten 277 kW.

Für eine Diagnose kann `-Dnw2.observed=/tmp/nw2-uems-observed.json` alle
beobachteten Ausgaben außerhalb des Repos ablegen, auch bei fehlgeschlagenen
Vergleichen. Dies überschreibt niemals die Referenz.
