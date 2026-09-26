# NW-3 — das ausgelieferte Box-Image gegen die neue Cloud (AP-14 IP-6)

Werkzeug: [`tools/nw3-box-image/`](../../../tools/nw3-box-image/README.md) · Tor **G1**
und noch einmal **GA** · Regeln X1, X2, X7, H7 · Referenzfall U4.

Die Frage ist eng und sie war bis hierher unbeantwortet: **erträgt die Box, die
heute im Feld steht, das, was die neue Cloud ihr schickt?** Jeder
Mischbetrieb-Nachweis im Baum fährt Quellstand gegen Quellstand; keiner startet
ein ausgeliefertes Artefakt. Dieses Werkzeug startet die echte Box-Software
eines Release-Standes als Prozesse und lässt sie die festgenagelten Nutzlasten
dieses Repo-Standes lesen.

## Die vier Fallen

1. **„Aus dem Release-Tag gebaut" ist nicht „das Release-Artefakt".** Ein Release
   ist ein Paar signierter Images in der privaten Registry `git.tecmaxx.de`
   (anonym `HTTP 401`). Der Lauf baut reproduzierbar aus dem Tag, mit der
   Bauanleitung **des Tags** und dem Versionsstempel der CI
   (`<tag>-<12 Zeichen der SHA>`). Was daran prüfbar bleibt, steht im
   Protokoll unter `was_sich_am_paar_pruefen_laesst` — entscheidend der Stand,
   den die **Box selbst meldet**. Wer das echte Artefakt prüfen will, setzt
   `VP_EDGE_CORE_IMAGE`/`VP_EDGE_NODERED_IMAGE` auf den Digest aus der Registry.
2. **Die Mess-Auswahl ist der scharfe Punkt.** Der Core liest sie mit
   `DisallowUnknownFields` (`edge-app/core/internal/measurements/measurements.go:71`):
   ein einziges neues Feld der Cloud, und die alte Box lehnt die ganze Auswahl
   ab. Wer am Erzeuger `MeasurementConfigPublisher` etwas ergänzt, bricht damit
   jede Box im Feld — bis zum Edge-Release, das sie lesen kann.
3. **Eine angenommene Auswahl ist keine gelesene Auswahl.** Die Box quittiert
   `accepted: [...]`, `rejected: []` — und sendet trotzdem nichts. Zwei
   unabhängige Gründe dafür sind gemessen: ohne **gewählten Wechselrichter** gibt
   es kein retained `edge/inverter/config`, und die Messlaufzeit löst die
   Verbindung erst zur LESEZEIT auf (`resolveDevice`), also liest sie gar nichts;
   und ein **modell-relativer** `sunspec.*`-Punkt braucht eine Modell-Erkennung,
   die der Simulator des Tags nicht bedient (er ist eine kompakte
   64-Register-Karte ohne SID-Marke). Wer NW-3 oder einen Messnachweis liest:
   **die Quittung ist nicht der Beweis, die Sample-Umschläge sind es.**
4. **`driver` ist `json.RawMessage`.** Der Zusatz `driver.data_source_id`
   (`EntityRegistryService.java:1243`) wandert unverändert durch den Core in die
   Palette; „die alte Box überliest ihn" heißt: sie parst ihn nie. Der Lauf
   belegt es an der Wirkung — Revision geechot, alle Entitäten angewandt, keine
   verworfen — und fährt dafür zwei Pushes, ohne und mit dem Feld. Der zweite
   legt den `driver`-Block auch dort an, wo vorher keiner war (der schärfere
   Fall).

## Der gemessene Befund zu X7

Für eine Ruhe sendet die neue Cloud **zwei** Felder: `automation_paused_until_revoked`
(das der ausgelieferte Stand nicht kennt) und daneben ein rollierendes Ende
`jetzt + 4 h`, `RuheRegel.ENDE_FUER_AELTERE_BOX` — „das Ende existiert NUR für
eine ältere Box". Die Cloud erneuert es mit dem `DeviceOverrideRenewalRunner`.

Der Lauf staucht die vier Stunden auf Sekunden, trennt die Box vom Netz, lässt
das Ende verstreichen und hängt sie wieder ein. Ergebnis, jetzt gemessen statt
angenommen (ist/C §6 führte es als **ungeprüft**): **die Ruhe läuft an der
ausgelieferten Box ab, und die Automatik setzt von selbst wieder ein** — der
Schiedsspruch der Batterie steht danach wieder auf `plan`, während die Cloud
weiter „bis auf Widerruf" hält. Das ist keine Verschlechterung gegenüber `main`
(dort gibt es gar keine Ruhe), aber die schwächere Zusage aus X7 ist real und
die Fläche muss sie an Boxen ohne die Fähigkeit sagen.

## Punkt 4: die ganze Strecke, mit einer benannten Grenze

Mit `--strecke` fährt eine **zweite** Container-Gruppe aus **diesem**
Arbeitsbaum: `services/ingest`, Redpanda, `services/timescale-writer` und eine
TimescaleDB. Die Datenannahme hängt zusätzlich im Netz der Box-Gruppe und hört
an demselben Broker mit, an dem die ausgelieferte Box sendet. Gemessen wird
dann: die Quittung nennt die Auswahl angewandt und trägt den Stempel des Tags ·
die Umschläge der Box tragen Vertrag 2.0 und die Identität des Topics · die
Messzeiten am Draht und die Zeilen in `device_measurement_sample` sind dieselbe
Menge · **beide Verwurf-Familien des Writers bleiben 0**
(`voltpilot_writer_verworfen_total`, `voltpilot_writer_verworfene_samples_total`
aus `/metrics`).

Gelesen wird ein `custom.`-Punkt auf Halteregister 4 des Simulators (Ladezustand,
uint16, 0,1 %) — die Bytes der Auswahl schreibt der echte
`MeasurementConfigPublisher` in
`MeasurementContractsTest#nw3AuswahlAmSimulatorIstDieFestgenagelteNutzlast`.
**Die Grenze:** ein Katalogpunkt über die SunSpec-Modell-Erkennung ist damit
NICHT gefahren; dafür braucht es ein Gerät, das die Modell-Liste bedient. Und das
Datenbankschema der Strecke ist der Writer-Spiegel plus die vier api-Migrationen
der Ereignis-Tabelle, kein Flyway-Lauf der api.

## Was der Lauf NICHT deckt
* **Die Paar-Liste ist heute das eine Tag-Paar.** Welche Paare im Feld laufen,
  sagt **Q07** des Bestandsblatts, und diese Abfrage fährt allein der Betreiber.
  Die Liste ist darum ein Parameter (`--paare`), kein eingebauter Wert.
* **Kein api-Prozess.** Die Cloud-Seite sind die festgenagelten Bytes unter
  `docs/contracts/v2/examples/`, an die der Erzeuger per Test gebunden ist. Die
  Naht zur api-Antwort für X2 zieht
  `services/api/src/test/java/com/voltpilot/api/uems/Nw3AusgeliefertesBoxImageTest.java`
  mit genau dem Stand, den die Box im Lauf gemeldet hat.

## Der Lauf als Beleg

Protokoll des Laufs vom 19.09.2026 gegen `origin/uems` `2edc6e1d`, mit
`--strecke`:
[`docs/rollout/nw3-protokoll-edge-2026.09.4.json`](../../rollout/nw3-protokoll-edge-2026.09.4.json)
— **12 grün, 0 rot, 1 Befund, 0 nicht gefahren**. Jeder Punkt trägt seinen Beleg
(die Nachricht, die die Box wirklich gesendet hat). Die Naht zur api-Antwort für
Punkt 7 fährt `Nw3AusgeliefertesBoxImageTest` (4 Fälle, beide Stände).

Protokoll des Laufs vom 26.09.2026 gegen `origin/uems` `f694b525` (PR 1287), mit
`--strecke`:
[`docs/rollout/nw3-protokoll-edge-2026.09.5.json`](../../rollout/nw3-protokoll-edge-2026.09.5.json)
— **9 grün, 3 rot, 1 Befund, 0 nicht gefahren**. Rot sind 3, 4a und 4b, alle mit
`rejected: unsupported_catalog`: seit AP-05 IP-6b (PR 1135) tragen die festgenagelten
Konfig-Beispiele den Stand `2026.09.23.3`, die Palette des Tags hat `2026.08.26.3`, und der
Planer verlangt exakte Gleichheit. Das ist die dokumentierte Kopplung api-Deploy ↔ Box-Release
(`docs/rollout/uems-erste-freigabe.md` §2.8), kein Feld- oder Schemafehler; die Bytes der
Auswahl unterscheiden sich vom 09.4-Lauf nur im `catalog_version`. Ein neuer Lauf von 09.4
(gleicher Palettenstand) träfe dasselbe; gefahren ist er nicht. Grün wird der Punkt erst mit dem Box-Release, das den Stand der api trägt
(Tor GA). Der Befund 6c (X7) steht wie bei 09.4.

## X2 ist kein Fehlerbild

Die Fähigkeit der Tabelle `docs/contracts/v2/edge-capabilities.json` trägt
`ab_release: null`. Darum sagt die Fläche „Update nötig für: Rückmeldung je
Datenquelle" (bis B06, 23.09.2026, zusätzlich „Zuständigkeit ab Zeitpunkt“; das
Protokoll vom 19.09.2026 zeigt noch den alten Satz) auch für die **neueste ausgelieferte**
Box, und ob ihr Release im Register steht, ändert daran nichts. Das ist der
Zustand der ganzen Flotte bis zum Edge-Release, das eine Fähigkeit mitbringt.
