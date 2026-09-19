# NW-3 — das ausgelieferte Box-Image gegen die neue Cloud

AP-14 IP-6, Regeln X1/X2/X7 und H7, Referenzfall U4 des entschiedenen Konzepts
„Erste Produktfreigabe". Tor-Bedingung an **G1** und noch einmal an **GA**.

Der Grundsatz dahinter: *das Einschalten der Cloud zwingt keiner Box ein Update
auf.* „Bestehende Steuerung funktioniert weiter" gilt auch für die Box, die
heute im Feld steht — und bis hierher gab es dafür keinen Nachweis. Jeder
Mischbetrieb-Test im Baum fährt **Quellstand gegen Quellstand**; keiner startet
ein ausgeliefertes Artefakt.

## Aufruf

```bash
tools/nw3-box-image/nw3.sh                     # die Paare aus paare.json
tools/nw3-box-image/nw3.sh --strecke           # PLUS Datenannahme->Redpanda->Writer->DB
tools/nw3-box-image/nw3.sh --paare q07.json    # die Paare des Betreibers
tools/nw3-box-image/nw3.sh --protokoll /pfad/nw3.json
tools/nw3-box-image/nw3.sh --behalten          # Stack stehen lassen (Fehlersuche)
```

Gebraucht werden Docker und `python3`; sonst nichts. Der Lauf dauert rund
fünf Minuten je Paar (der erste länger: er baut die Bilder), mit `--strecke`
rund drei Minuten mehr. **`--strecke` fährt zwei Container-Gruppen zugleich** —
die Box-Gruppe und die Strecke —, also nur bei reichlich freiem Speicher starten.

## Die Paar-Liste ist ein Parameter, kein eingebauter Wert

Welche `(core, palette)`-Paare im Feld laufen, sagt **Q07** des Bestandsblatts
(`tools/betriebsabfragen/bestand-vor-uems.sql`) — und diese Abfrage fährt allein
der Betreiber gegen Produktion. `paare.json` trägt darum heute genau das eine
Paar, das ohne Q07 belegbar ist: das letzte Release-Tag `edge-2026.09.4`. Der
Betreiber trägt die Paare seiner Q07-Ausgabe nach oder gibt eine eigene Datei
mit `--paare`; das Werkzeug fährt sie der Reihe nach und schreibt ein Protokoll
über alle.

Core und Palette werden **gemeinsam** ausgeliefert (X6), darum trägt ein Paar
zwei gleiche Tags. Ein gemischtes Paar lehnt das Werkzeug ausdrücklich ab,
statt still etwas anderes zu bauen.

## Was echt ist — und was nicht

| Glied | im Lauf | Bemerkung |
|---|---|---|
| Go-Core | **echter Prozess** | aus dem Release-Tag gebaut |
| Node-RED-Palette | **echter Prozess** | aus dem Release-Tag gebaut |
| SunSpec-Simulator | **echter Prozess** | die simulierte Anlage DES TAGS, keine Hardware |
| MQTT-Broker | **echter Prozess** | Mosquitto, `edge-app/test/Dockerfile.broker` |
| Cloud-Nutzlasten | **festgenagelte Bytes dieses Standes** | `docs/contracts/v2/examples/*` |
| api | *kein Prozess* | siehe unten |
| Datenannahme, Redpanda, Writer, TimescaleDB | **echte Prozesse** (mit `--strecke`) | aus DIESEM Arbeitsbaum gebaut |

**Warum kein api-Prozess.** Die Frage von NW-3 ist nicht „läuft die api", sondern
„erträgt die ausgelieferte Box, was die neue Cloud ihr schickt". Was die Cloud
schickt, steht byte-genau in den Beispiel-Nutzlasten unter
`docs/contracts/v2/examples/` — an die der Erzeuger in der api per Test gebunden
ist (`MeasurementContractsTest.publisherPayloadIsTheCommittedValidFixture`,
`RegistryPushJeBoxBestandTest`). Das Werkzeug stellt genau diese Bytes über den
echten Broker zu und ändert daran nur, was der jeweilige Fall verlangt — jede
Änderung steht in `nutzlast.py` mit der Cloud-Zeile, aus der sie stammt
(z. B. `EntityRegistryService.java:1243` für `driver.data_source_id`,
`RuheRegel.push` für die zwei Ruhe-Felder).

**Warum das Bild nicht „das Release-Artefakt" ist.** Ein Edge-Release ist ein
Paar signierter Multi-Arch-Images in der **privaten** Registry
`git.tecmaxx.de` (`.forgejo/workflows/edge-images.yaml`,
`edge-app/docker-compose.yml`). Anonym antwortet sie `HTTP 401`, die Release-API
des Repos `HTTP 404`. Das Werkzeug fragt **keine Zugangsdaten an und probiert
keinen Login**; es baut statt dessen reproduzierbar aus dem Tag — mit der
Bauanleitung **des Tags** und dem Versionsstempel, den die CI vergibt
(`<tag>-<12 Zeichen der SHA>`). Das ist eine **benannte Grenze**, kein Mangel:
prüfbar bleibt daran

* der Stempel im Core-Binary und im OCI-Label der Palette,
* die Inhaltsmarke `.vp-template-version` über den ganzen Palette-Baum,
* `package_edge_runtime.py --check` **des Tags** (Box-Sicht gegen Katalog),
* und vor allem: **der Stand, den die Box im Lauf selbst meldet** — er steht in
  jedem Herzschlag (`version`), im `update`-Block und in der Quittung der
  Mess-Auswahl (`edge_version`).

Wer das echte Artefakt prüfen will, zieht es mit Zugangsdaten aus der Registry
und setzt `VP_EDGE_CORE_IMAGE` / `VP_EDGE_NODERED_IMAGE` auf den Digest; das
Werkzeug fährt dann denselben Lauf gegen dieselben Bytes.

## Was geprüft wird

1. **Registry-Push** — einmal ohne und einmal **mit** `driver.data_source_id`
   (der Zusatz nach bestätigter Quellen-Übernahme, AP-06 IP-13). Die alte Box
   muss das Feld überlesen, die Revision undurchsichtig echoen und alle
   Entitäten anwenden. *Das „überliest" ist hier der eigentliche Beweis.*
2. **Ein Planzyklus** — Plan zugestellt, angenommen, gegen die simulierte
   Anlage ausgeführt (Sollwert geschrieben und zurückgelesen).
3. **Mess-Auswahl** im Vertrag 2.0. Der Tag-Core liest die Mess-Auswahl mit
   `DisallowUnknownFields` (`internal/measurements/measurements.go:71`): schickt
   die neue Cloud auch nur EIN neues Feld mit, lehnt die alte Box die ganze
   Auswahl ab. Das ist dann ein **roter Befund**, nicht zu umgehen.
4. **Samples 2.0 im Writer** (nur mit `--strecke`) — die Quittung nennt die
   Auswahl als angewandt und trägt den Stempel des Tags · die Sample-Umschläge
   der echten Box laufen über die **echte** Datenannahme, Redpanda und den
   **echten** Writer dieses Standes in eine echte TimescaleDB · dieselben
   Messzeiten am Draht wie in `device_measurement_sample` · **beide
   Verwurf-Familien des Writers bleiben 0** (`voltpilot_writer_verworfen_total`
   und `voltpilot_writer_verworfene_samples_total` aus `/metrics`). Siehe
   „Die Auswahl, die der Simulator wirklich hergibt".
5. **Handeingriff setzen und aufheben** (H7): Pause mit Ende zugestellt, dann
   aufgehoben.
6. **Ruhe mit rollierendem Ende** und die Box **länger getrennt als das Ende**
   (X7/W12) im Zeitraffer. Die neue Cloud sendet für eine Ruhe zwei Felder:
   `automation_paused_until_revoked` (das die alte Box nicht kennt) und daneben
   ein rollierendes Ende `jetzt + 4 h`, „das Ende existiert NUR für eine ältere
   Box" (`RuheRegel.ENDE_FUER_AELTERE_BOX`). Der Lauf staucht die vier Stunden
   auf Sekunden — derselbe Codepfad, gestauchte Uhr —, trennt die Box vom Netz,
   lässt das Ende verstreichen und hängt sie wieder ein.
7. **„Update nötig für: …"** (X2) für den Stand, den die Box gemeldet hat. Den
   Satz bildet im Produktivcode `DatenquelleRegeln.faehigkeiten`; die Naht dorthin
   zieht `services/api/.../uems/Nw3AusgeliefertesBoxImageTest.java` mit genau
   diesem Stand.

## Die Auswahl, die der Simulator wirklich hergibt

Zwei Dinge mussten dafür stimmen, und beide waren am Anfang falsch.

**Erstens: ohne gewählten Wechselrichter liest die Box gar nichts.** Die
Messlaufzeit löst die Verbindung zur LESEZEIT auf (`resolveDevice`), und die
Verbindung des primären Wechselrichters steht im retained `edge/inverter/config`
— das der Core nur veröffentlicht, wenn am Gerät ein Wechselrichter **gewählt**
ist. Im Feld macht das der Installateur in der lokalen Weboberfläche der Box;
der Lauf geht seit jetzt über genau dieselbe Route (`POST /api/inverter` an den
echten Core des Tags) und wählt `generic_modbus` / `sunspec` — das im Core
hinterlegte Registerbild **des Simulators**. Das ist die einzige Einstellung des
Laufs, die nicht aus der Cloud kommt, und sie ist Gerätesache, keine Nutzlast.

**Zweitens: der Simulator des Tags spricht KEIN echtes SunSpec.** Er ist eine
kompakte 64-Register-Karte (`edge/sim/sunspec-sim.js`, Kopfkommentar: „not a
byte-exact full SunSpec model dump"); die SID-Marke `SunS` steht an keiner der
Basen, die `sunspec/model-discovery.js` absucht (40000, 50000, 0). Ein
modell-relativer Katalogpunkt wird darum **angenommen und nie gelesen**:

| Auswahl | Quittung der Box | gesendet |
|---|---|---|
| `deye.hybrid_1p.battery.battery` (die alte festgenagelte) | `accepted` | `raw: 0` — die Deye-Adresse liegt außerhalb der 64 Register des Simulators |
| `sunspec.model_203.totwhimp` (der Punkt des NW-4-Laufs) | `accepted`, `rejected` leer | **nichts** — die Modell-Erkennung findet keine Basis |
| `custom.sim.soc` (Halteregister 4, uint16, 0,1 %) | `accepted` | `raw: 520`, `decoded: 52` — der Ladezustand, den der Simulator wirklich hält |

**Das ist der Befund dieses Punktes: eine angenommene Auswahl ist keine gelesene
Auswahl.** Die Box meldet `rejected: []` und sendet trotzdem nichts; erst der
Blick auf die Sample-Umschläge sagt, ob ein Punkt wirklich getragen wird. Ein
`custom.`-Punkt adressiert das Halteregister absolut, braucht keine Erkennung
und ist derselbe Weg, den die Cloud für jeden nicht-katalogisierten Kunden-Punkt
geht. Die Bytes der Auswahl sind **aus dem Erzeuger** genommen, nicht von Hand
geschrieben: `MeasurementContractsTest#nw3AuswahlAmSimulatorIstDieFestgenagelteNutzlast`
schreibt sie mit dem echten `MeasurementConfigPublisher` und hält sie gegen
`docs/contracts/v2/examples/mqtt-measurement-config.valid.nw3-simulator.json`.

**Was das für NW-3 heißt und was nicht.** Gefahren ist damit die ganze Kette —
echte Box → echter Broker → echte Datenannahme → Redpanda → echter Writer →
TimescaleDB — mit einem Wert, der aus der simulierten Anlage stammt. **Nicht**
gefahren ist ein Katalogpunkt über die Modell-Erkennung; dafür braucht es ein
SunSpec-Gerät (echt oder ein Simulator, der die Modell-Liste bedient), und das
liegt jenseits dieses Werkzeugs.

## Was die Strecke ist — und was an ihr die benannte Grenze ist

Mit `--strecke` fährt ein **zweites** Compose-Projekt `nw3s-<pid>`:
`services/ingest`, Redpanda, `services/timescale-writer` und eine TimescaleDB,
alles aus **diesem** Arbeitsbaum gebaut. Verbunden sind die beiden Gruppen an
genau einer Stelle: die Datenannahme hängt zusätzlich im Netz der Box-Gruppe und
hört dort an demselben Broker mit, an dem die Box sendet (die „Broker-Brücke").
Ihr Themenfilter steht bewusst **nicht** im Environment — der Lauf prüft den
Vorgabewert aus `services/ingest/src/main/resources/application.yml`.

Die **benannte Grenze** hier ist das Datenbankschema: es ist der Spiegel, den der
Writer für seine eigenen Tests hält
(`services/timescale-writer/src/test/resources/writer-schema.sql`) plus die vier
echten api-Migrationen der Ereignis-Tabelle — dieselbe Kette, die
`EreignisTabelleImTest` fährt. Gefahren wird die **Strecke**, nicht Flyway; ein
api-Prozess kommt auch hier nicht vor. Die zwei Stammdatenzeilen, ohne die der
Writer einen Wert gar nicht annehmen *kann*, stehen in `strecke-seed.sql` mit
der Codezeile, die sie verlangt.

## Hausregeln, an die sich der Lauf hält

* **Nie der lokale Stack des Betreibers.** Eigene Compose-Projekte `nw3-<pid>`
  und `nw3s-<pid>`, eigene Netze, eigene Bild-Namen mit Präfix `nw3-`.
* **Kein fester Port.** Alle Port-Variablen der Box-Gruppe stehen auf `0`; die
  Strecke-Gruppe veröffentlicht überhaupt keinen Host-Port (kein `ports:`) und
  wird über ihr Netz bzw. `docker exec` erreicht.
* **Abgeräumt wird nur Eigenes:** die eigenen Projekte mit `down -v` und der
  eigene Tag-Arbeitsbaum. `--behalten` lässt beides stehen.
* Es wird **nichts** unter `edge-app/` oder am Katalog geändert — das Werkzeug
  liest den Tag in einem eigenen Arbeitsbaum außerhalb des Repos.

## Dateien

| Datei | Aufgabe |
|---|---|
| `nw3.sh` | der Lauf: bauen, Stack hoch, die sieben Punkte, Protokoll |
| `paare.json` | die Paar-Liste (Parameter; heute das eine Tag-Paar) |
| `nw3-overlay.yml` | Compose-Überlagerung: lokale Bilder statt Registry-Pull |
| `nutzlast.py` | die Cloud-Nutzlasten aus den festgenagelten Beispielen |
| `faehigkeiten.py` | X2: der Satz „Update nötig für: …" zum gemeldeten Stand |
| `protokoll.py` | das Protokoll als Artefakt (nur technische Angaben) |
| `nw3-strecke.yml` | die zweite Gruppe: Datenannahme, Redpanda, Writer, TimescaleDB |
| `strecke-seed.sql` | die zwei Stammdatenzeilen, ohne die der Writer nicht annehmen kann |
| `strecke_pruefen.py` | gesendet am Draht gegen geschrieben in der Datenbank |

Der Nachweis selbst liegt unter
[`docs/agents/root/uems-nw3-box-image.md`](../../docs/agents/root/uems-nw3-box-image.md).
