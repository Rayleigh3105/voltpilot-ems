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
tools/nw3-box-image/nw3.sh --paare q07.json    # die Paare des Betreibers
tools/nw3-box-image/nw3.sh --protokoll /pfad/nw3.json
tools/nw3-box-image/nw3.sh --behalten          # Stack stehen lassen (Fehlersuche)
```

Gebraucht werden Docker und `python3`; sonst nichts. Der Lauf dauert rund
fünf Minuten je Paar (der erste länger: er baut die Bilder).

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
| Datenannahme, Redpanda, Writer, TimescaleDB | *nicht gefahren* | siehe „Was offen ist" |

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
4. **Samples 2.0 im Writer** — siehe „Was offen ist".
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

## Was offen ist

**Punkt 4 (Samples 2.0 im Writer) ist in diesem Stand NICHT gefahren.** Der
Grund ist benannt und kein Zufall: die festgenagelte Mess-Auswahl der Cloud
wählt einen **Deye**-Punkt (`deye.hybrid_1p.battery.battery`), der Simulator des
Tags spricht **SunSpec**. Die Box nimmt die Auswahl an (Punkt 3 ist grün und
`rejected` ist leer), findet aber keine Quelle dafür und sendet folglich keine
Samples. Für Punkt 4 fehlen zwei Dinge, die beide über diesen Schnitt hinausgehen:

* eine Mess-Auswahl auf einen Punkt, den die Palette des Tags am SunSpec-Simulator
  wirklich liest, und
* die Strecke Datenannahme → Redpanda → Writer → TimescaleDB als zweite
  Container-Gruppe (`--strecke`, im Werkzeug vorgesehen, hier nicht gefahren).
  Die Zähler beider Verwurf-Familien (PR 972) gehören dann in das Protokoll.

## Hausregeln, an die sich der Lauf hält

* **Nie der lokale Stack des Betreibers.** Eigenes Compose-Projekt `nw3-<pid>`,
  eigenes Netz, eigene Bild-Namen mit Präfix `nw3-`.
* **Kein fester Port.** Alle Port-Variablen stehen auf `0`; Docker wählt.
* **Abgeräumt wird nur Eigenes:** das eigene Projekt mit `down -v` und der eigene
  Tag-Arbeitsbaum. `--behalten` lässt beides stehen.
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

Der Nachweis selbst liegt unter
[`docs/agents/root/uems-nw3-box-image.md`](../../docs/agents/root/uems-nw3-box-image.md).
