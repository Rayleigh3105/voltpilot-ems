# Simulator-Aufbau der Gemeinsamen Steuerung (AP-15 IP-28, NW-3)

Zwei **echte** Box-Container in **einer** Anlage, ein Mosquitto, ein
Anlagenmodell. Der Aufbau fährt dieselbe Anlage wie der Zwei-Agenten-Test
(`edge-app/core/internal/agent/zwei_agenten_test.go`, NW-2) — nur regeln hier
der gebaute Go-Core und die gebaute Node-RED-Palette, über Modbus und MQTT, in
echten Sekunden. Auf ihm fährt IP-29 das Ergebnisblatt je Matrixzeile.

```
            wan                                  box-e1 (LAN Halle 1)
 ┌──────────────┐   ems/…/e1/#   ┌─────────┐  core:1883 ┌────────────┐
 │ cloud-broker │◄──────────────►│ core-e1 │◄──────────►│ nodered-e1 │──┐ Modbus
 │  (Mosquitto) │                └─────────┘            └────────────┘  │ edge-sim:502
 │   Nutzlasten │   ems/…/e4/#   ┌─────────┐  core:1883 ┌────────────┐  │ Reg 0..8 lesen
 │   Mitschnitt │◄──────────────►│ core-e4 │◄──────────►│ nodered-e4 │──┤ Reg 40/41/42 schreiben
 └──────────────┘                └─────────┘            └────────────┘  │
                                             box-e4 (LAN Verwaltung)     ▼
                                                              ┌──────────────────────┐
   NA-1 Netzpunkt = Netzzähler an E-1 (Reg 0)                  │ anlage               │
   ├── Halle 1: Last, K-1 PV 100 kW, K-2 Speicher 100 kW       │ uems_verbund.py      │
   └── Verwaltung: K-12 PV 60 kW, K-13.1…6 Ladepunkte          │ misst M-1 / M-2      │
       = Abgangszähler an E-4 (Reg 0)                          └──────────────────────┘
```

| Glied | im Lauf | Bemerkung |
|---|---|---|
| Go-Core ×2 | **echter Prozess** | aus dem aktuellen Stand gebaut; Marke = letzter Commit an `edge-app/`, `edge/sim` |
| Node-RED-Palette ×2 | **echter Prozess** | Tab „SunSpec (Simulator)“: liest `edge-sim:502` alle 2 s, schreibt Reg 40/41/42 |
| Anlage | Modell | `uems_verbund.py` an der Stelle von `edge/sim`, dieselbe Registerkarte |
| Broker | **echter Prozess** | `edge-app/test/Dockerfile.broker` |
| Cloud | *kein Prozess* | Nutzlasten aus den Vertrags-Beispielen und -Vektoren (`nutzlast.py`) |
| Ladepunkte (OCPP) | **echter Prozess** am Bezugs-Punkt | sechs `vp-ocpp-sim` (Dienst `ladepunkte`, IP-29); im Profil „mittag“ ohne Auto und nicht angeschlossen |

## Start

```bash
cd tools/uems-verbund-sim
make test        # ohne Broker: Physik, Profile, Messung, Modbus, Nutzlasten gegen die Schemas
make bilder      # einmal: Box-Bilder aus dem aktuellen Stand (nicht je Lauf)
make r1          # hoch → Nutzlasten → R1 (5 min Anlauf + 45 min Messung) → Protokoll → down
make a7          # wie r1 mit 30 min Messung, dazu A7: Netzzähler friert ab T0 bis zum Ende
```

`make r1` schreibt das Protokoll nach `$TMPDIR/uems-verbund-r1.json`
(`PROTOKOLL=…` ändert das). Der Ablauf von `verbund.sh r1`:

1. **Fenster prüfen** — höchstens zwei Container laufen schon, kein zweiter
   Aufbau (sonst Exit 75). Container mit `mem_limit`: Box 192 + 320 MiB, Broker
   128 MiB, Anlage 128 MiB.
2. **Hoch** — `docker compose -p uems-verbund -f verbund.yml up -d`; warten, bis
   beide Boxen einen Herzschlag mit ihrem Stand senden; Mitschnitt `ems/#` im
   Broker beginnt (jede Zeile mit Empfangszeit).
3. **Zustellen** — je Box retained, QoS 1: Registry-Push, Anteils-Dokument
   (Epoche 1, Revision 1, 40/60 kW Einspeisung, 0/77 kW Bezug), Ladepark-Dokument,
   v1-Fahrplan, Plan v2 (dieselbe `plan_id` für beide). Gewartet wird auf
   `verbund-anteile-result` und `plan-result` beider Boxen. Danach der **Takt der
   Cloud**: zu jeder Viertelstunde der Wanduhr ein neuer Lauf (Fahrplan v1 +
   Plan v2, neue `plan_id`, `lauf_nr` + 1) für beide Boxen. Ohne ihn fährt die
   Box einen Plan nur 20 Minuten und fällt dann auf `execution.mode: fallback` —
   genau das hat der erste Lauf gezeigt (Speicher lädt ab Minute 20 mit 100 kW).
4. **Start** — erst jetzt läuft die Uhr der Anlage. T0 (die Wolkenlücke über der
   Verwaltung, 5 s danach: K-12 30 → 60 kW) liegt bei Messsekunde 600.
5. **Protokoll** — M-1/M-2 der Anlage, Quittungen und gemeldeter Stand aus dem
   Mitschnitt, eine Reihe alle 10 s; dazu `mitschnitt.txt`, `core.log`, die
   Nutzlasten unter `$VB_ARBEIT`.
6. **Down** — `docker compose down -v`, auch bei Abbruch (trap).

## Takt

**1 Simulator-Sekunde = 1 echte Sekunde.** Kein Zeitraffer: die Box rechnet
ausschließlich in echten Sekunden (Frische 30 s, Geräte-Rückfall 60 s,
Einfrierprobe 30 + 20 s, Node-RED-Lesetakt 2 s). Ein gestauchter Simulator
verschöbe die Physik gegen diese Uhren und verfälschte M-2. Ein R1 dauert darum
50 Minuten Wand-Zeit. Die Viertel von M-1 zählen ab Messbeginn (900
Simulator-Sekunden), nicht ab der Wanduhr-Viertelstunde.

## Störungen

```bash
./verbund.sh hoch && ./verbund.sh zustellen && ./verbund.sh start   # Aufbau stehen lassen
./stoerung.sh A7         # Netzzähler friert ein
./stoerung.sh zurueck    # jede aktive Störung aufheben
./verbund.sh protokoll /pfad/protokoll.json && ./verbund.sh runter
```

Jede Störung meldet Start und Ende bei der Anlage an und steht dadurch mit
Simulator-Sekunde und Messsekunde im Protokoll (`anlage.stoerungen`).

| Zeile | Mittel |
|---|---|
| A1 / A2 | Strom weg: `docker kill` von Core **und** Node-RED der mitsteuernden (A1) bzw. führenden Box (A2); zurück: `docker start` |
| A3 | Cloud stumm: der Viertelstunden-Lauf bleibt aus (`$VB_ARBEIT/cloud.stumm`); nach 20 min fällt die Box auf den Rückfall des Plans |
| A4 | Broker angehalten: `docker pause` (retained Nachrichten bleiben im Speicher) |
| A5 / A5f | einseitig: `docker network disconnect` des Cores vom Netz `wan` (E-4 bzw. E-1) |
| A7 / A7x | Netzzähler an E-1 friert ein (derselbe Wert, frisch gelesen; A7e im NW-2) bzw. Netz- und Abgangszähler antworten nicht (A7 im NW-2) |
| A8± | **nicht fahrbar** — siehe Grenzen |
| A13 / A13v | Neustart mitten im Eingriff: `docker kill` + `docker start` der Box |
| A15 | Box lebt, erreicht ihr Gerät nicht: die Anlage beantwortet Modbus nicht |

## Drehbuch und Ergebnisblatt (AP-15 IP-29)

`szenarien.py` fährt jede Zeile der Ausfallmatrix als eigenen Lauf und schreibt
daraus [das Ergebnisblatt](../../docs/rollout/gemeinsame-steuerung-ausfalltests.md).

```bash
python3 szenarien.py liste                     # Läufe, Betriebspunkt, T0, Messfenster
python3 szenarien.py drehbuch A10 --aus /tmp/x # Drehbuch + Dokumente ansehen, ohne Aufbau
make blatt                                     # alle Läufe nacheinander (~14 h), dann das Blatt
make blatt-md                                  # nur das Blatt aus protokolle/*.json
```

- **Ein Lauf je Zeile, nacheinander.** Vor jedem `up`: höchstens zwei
  Testcontainers anderer Bahnen und ≥ 3 GiB frei, sonst wartet der Läufer;
  nach jedem Lauf `down -v`. Die Bilder baut er EINMAL je Reihe
  (`VB_BILDER_FEST`), das Werkzeug fährt er aus einem Schnappschuss unter
  `$TMPDIR` (eine Reihe dauert Stunden, bash liest ein laufendes Skript
  stückweise).
- **Messfenster** = `nach_zeit` der Matrix auf volle Viertelstunden aufgerundet
  plus zwei volle Viertelstunden (30/45/60 min); R1 und A7 wie `make r1`/`make a7`.
- **Drehbuch** (`verbund.sh lauf --drehbuch`): je Zeile „<Messsekunde> <Aktion>“ —
  `stoerung <zeile>`, `zurueck`, `sende <box> <leaf> <datei>` (wie die Cloud,
  retained), `lokal <box> <topic> <datei>` (lokaler Bus, A11), `lauschen`,
  `anlage <json>` (z. B. K-1-Rückfall für A10), `cloud stumm|ungueltig` (A3/A9),
  `tausch` (A14: Nachfolgerin `core-e5` mit neuer Kennung). Nach der Messung
  hebt der Lauf jede Störung auf, dann schreibt er das Protokoll.
- **Bezugs-Punkt** (`nacht`, `nacht_a20`): die Anlage verschiebt den Nullpunkt
  von Box Halle 1 um 400 kW (`NULLPUNKT_NACHT_KW`: Netzzähler, Last,
  Anschlussleistung), `nutzlast.py --nullpunkt` stellt E-1 die Bezugsgrenze um
  denselben Betrag tiefer zu (550 → 150 kW). Jede Differenz „Grenze − Zähler“
  bleibt gleich, gemessen wird am echten Netzpunkt; der Treiber bleibt
  unverändert. Die sechs Säulen AHR-LP-02…07 sind echte OCPP-1.6J-Ladepunkte
  (`Dockerfile.ladepunkte`, `ladepunkte.sh`); sie wählen die Box erst an, wenn
  das Ladepark-Dokument sie in ihre Freigabeliste gesetzt hat, und die lebende
  Zuteilung braucht `VP_CONSUMER_CONTROL_ENABLED` (nur am Bezugs-Punkt gesetzt).

## Grenzen (benannt, nicht übersehen)

- **A8 Uhr verstellen geht im Container nicht.** Die Uhr eines Containers ist
  die des Docker-Hosts (`CLOCK_REALTIME` hat keinen Namensraum), der Go-Core ist
  statisch gebaut (`CGO_ENABLED=0`, `edge-app/core/Dockerfile`) und liest die
  Zeit direkt — `faketime` über `LD_PRELOAD` greift nicht. Der Zeitstempel der
  Messung kommt vom Core selbst (der Simulator-Tab schickt keinen `ts`). Nötig
  wäre eine Prüf-Verstellung der Uhr im Core; `stoerung.sh A8+` sagt das und
  endet mit Exit 3.
- **Die Karte trägt nur ±327,67 kW** (int16 × 0,01 kW). Der Bezugs-Punkt (bis
  712 kW am Netzpunkt) läuft darum nur mit verschobenem Nullpunkt (siehe oben);
  ohne ihn zählt die Anlage jeden solchen Wert als `ueberlauf`, statt ihn
  abgeschnitten zu senden.
- **Die Säulen fallen nicht auf 4,1 kW.** `vp-ocpp-sim` hält ohne Box sein
  zuletzt gesetztes Profil; den OCPP-eigenen Rückfall der Referenzdatei
  (4,1 kW je Säule nach 60 s) bildet er nicht nach. Am Bezugs-Punkt fährt das
  Drehbuch darum keine Zeile, in der Box Verwaltung ausfällt.
- **Der Modell-Zähler rauscht nicht.** Ein bitgleich stehender Netzpunkt löst
  die Einfrierprobe der Box aus (Prüf-Verstellung −2,1 kW nach 30 s Stillstand,
  PR 1053) — im Protokoll als kurze Delle auf 95,9 kW sichtbar. Das ist das
  echte Verhalten der Box gegenüber einem stehenden Wert, kein Fehler der Anlage.
- **E-4 meldet einen Speicher.** Die Registerkarte trägt immer
  `battery_power`/`soc`; E-4 hat keinen Speicher, die Anlage meldet 0 kW und
  überhört Speicher-Schreibbefehle von E-4.
- **Der v1-Fahrplan trägt die Einspeisegrenze.** `grid_export_limit_kw` kennt nur
  der v1-Fahrplan (`mqtt-schedule.schema.json`); der Plan v2 hat kein Feld dafür.
  Der Aufbau stellt darum wie `zwei_agenten_test.go zaPlan` beide zu.

## Dateien

| Datei | Aufgabe |
|---|---|
| `uems_verbund.py` | das Anlagenmodell: Physik, Modbus-Server für beide Boxen, M-1/M-2, Steuer-Befehle |
| `nutzlast.py` | die Cloud-Nutzlasten je Box aus Beispielen und Vektoren |
| `protokoll.py` | Messung + Quittungen + gemeldeter Stand als ein JSON |
| `verbund.yml` | Compose: zwei Boxen (per `extends` aus `edge-app/docker-compose.yml`), Broker, Anlage |
| `verbund.sh` | Bilder, hoch, zustellen, start, stand, protokoll, runter, `r1` |
| `stoerung.sh` | die Störungen, wiederholbar, mit `zurueck` |
| `szenarien.py` | IP-29: Drehbuch je Matrixzeile, Läufer mit Fenster-Tor, Ergebnisblatt |
| `Dockerfile.ladepunkte`, `ladepunkte.sh` | IP-29: die sechs OCPP-Säulen von E-4 (`vp-ocpp-sim`, unverändert) |
| `protokolle/` | IP-29: die Protokolle der Läufe, aus denen das Blatt entsteht |
| `Dockerfile` | die Anlage (Python-Standardbibliothek, Referenzdatei als zweiter Kontext) |
| `test_uems_verbund.py`, `test_szenarien.py` | `make test` |
