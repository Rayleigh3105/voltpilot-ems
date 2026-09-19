# NW-3 — das ausgelieferte Box-Image gegen die neue Cloud (AP-14 IP-6)

Werkzeug: [`tools/nw3-box-image/`](../../../tools/nw3-box-image/README.md) · Tor **G1**
und noch einmal **GA** · Regeln X1, X2, X7, H7 · Referenzfall U4.

Die Frage ist eng und sie war bis hierher unbeantwortet: **erträgt die Box, die
heute im Feld steht, das, was die neue Cloud ihr schickt?** Jeder
Mischbetrieb-Nachweis im Baum fährt Quellstand gegen Quellstand; keiner startet
ein ausgeliefertes Artefakt. Dieses Werkzeug startet die echte Box-Software
eines Release-Standes als Prozesse und lässt sie die festgenagelten Nutzlasten
dieses Repo-Standes lesen.

## Die drei Fallen

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
3. **`driver` ist `json.RawMessage`.** Der Zusatz `driver.data_source_id`
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

## Was der Lauf NICHT deckt

* **Punkt 4 (Samples 2.0 im Writer) ist nicht gefahren.** Die festgenagelte
  Mess-Auswahl der Cloud wählt einen Deye-Punkt, der Simulator des Tags spricht
  SunSpec: die Box nimmt die Auswahl an (`rejected` leer) und findet keine
  Quelle, also sendet sie keine Samples. Dafür fehlen eine am SunSpec-Simulator
  lesbare Auswahl und die Strecke Datenannahme → Redpanda → Writer →
  TimescaleDB als zweite Container-Gruppe. Die Zähler beider Verwurf-Familien
  (PR 972) gehören dann ins Protokoll.
* **Die Paar-Liste ist heute das eine Tag-Paar.** Welche Paare im Feld laufen,
  sagt **Q07** des Bestandsblatts, und diese Abfrage fährt allein der Betreiber.
  Die Liste ist darum ein Parameter (`--paare`), kein eingebauter Wert.
* **Kein api-Prozess.** Die Cloud-Seite sind die festgenagelten Bytes unter
  `docs/contracts/v2/examples/`, an die der Erzeuger per Test gebunden ist. Die
  Naht zur api-Antwort für X2 zieht
  `services/api/src/test/java/com/voltpilot/api/uems/Nw3AusgeliefertesBoxImageTest.java`
  mit genau dem Stand, den die Box im Lauf gemeldet hat.

## Der Lauf als Beleg

Protokoll des Laufs vom 19.09.2026 gegen `origin/uems` `5ea736be`:
[`docs/rollout/nw3-protokoll-edge-2026.09.4.json`](../../rollout/nw3-protokoll-edge-2026.09.4.json)
— **9 grün, 0 rot, 1 Befund, 1 nicht gefahren**. Jeder Punkt trägt seinen Beleg
(die Nachricht, die die Box wirklich gesendet hat). Die Naht zur api-Antwort für
Punkt 7 fährt `Nw3AusgeliefertesBoxImageTest` (3 Fälle).

## X2 ist kein Fehlerbild

Beide Fähigkeiten der Tabelle `docs/contracts/v2/edge-capabilities.json` tragen
`ab_release: null`. Darum sagt die Fläche „Update nötig für: Rückmeldung je
Datenquelle, Zuständigkeit ab Zeitpunkt" auch für die **neueste ausgelieferte**
Box, und ob ihr Release im Register steht, ändert daran nichts. Das ist der
Zustand der ganzen Flotte bis zum Edge-Release, das eine Fähigkeit mitbringt.
