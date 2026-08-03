# OTA Stufe 3 „Autonom" — Betreiber-Handbuch

Stufe 0 hat den Stand SICHTBAR gemacht, Stufe 1 hat ihn KRYPTOGRAFISCH GEDECKT,
Stufe 2 hat ihn VERTEILT — angewandt hat ihn immer noch ein Mensch am Gerät
(`update.sh --from-target`). Stufe 3 baut die Maschine, die das selbst tut:
den Sidecar **`vp-edge-updater`**.

> **Sie ist gebaut und im Labor geprüft — und NIRGENDWO eingeschaltet.**
> Autonomes Anwenden hat zwei unabhängige Tore, und beide sind zu:
> das Compose-Profil `ota` (der Container läuft sonst gar nicht) und der
> Schalter je Gerät (Vorgabe AUS). Eine Box ohne beides verhält sich
> zeichengleich wie vor dieser Stufe.

Zeremonie und Signaturkette: [`ota-signing.md`](ota-signing.md).
Rollout-Steuerung im Portal: dort §6b und die Seite „Edge-Updates".

---

## 1. Was der Sidecar ist — und was er ausdrücklich nicht ist

| | |
|---|---|
| **Er besitzt** | `/var/run/docker.sock` — er ist der EINZIGE, der Container tauscht |
| **Er hat NICHT** | Netz (`network_mode: none`), Host-Port, MQTT-Verbindung, Geräte-Identität |
| **Er spricht mit dem Kern** | ausschließlich über Dateien in `/data/ota` — jede Datei hat genau EINEN Schreiber |
| **Er entscheidet** | nichts allein: jede Regel liegt im reinen `internal/otaapply` und ist ohne Container prüfbar |

**Ehrlich zur Privilegien-Lage.** `docker.sock` ist Host-root. Ein übernommener
Sidecar *kann* einen privilegierten Container starten. Der Schutz ist deshalb
ausdrücklich **nicht** die Netz-Grenze, sondern: er handelt ausschließlich auf
Eingaben, die er **selbst** gegen **seine eigene eingebackene Wurzel**
signaturgeprüft hat — er glaubt dem Kern nichts —, und seine Angriffsfläche ist
minimal (kein Zuhörer, kein Netz-Stack, ein Parser).

**Wer aktualisiert den Aktualisierer?** Nicht er selbst. Sein eigenes Image
steht bewusst nicht in der Artefakt-Liste, die er tauscht
(`otaapply.UpdaterComponent` lässt es heraus und protokolliert das laut) — ein
Prozess, der sich mitten in einer Orchestrierung ersetzt, verliert genau den
Zustand, mit dem er den Vorgang zu Ende fahren müsste. Sidecar-Updates sind
selten, beaufsichtigt und out-of-band:

```bash
cd /srv/voltpilot-edge
./update.sh --ota                     # zieht auch das Sidecar-Image
# oder gezielt:
docker compose --profile ota up -d updater
```

---

## 2. Der Ablauf eines autonomen Updates

```
Zuweisung (retained, Stufe 2)
   │
   ├─ Sidecar verifiziert SELBST  (eigene Wurzel, eigener Anti-Rollback-Boden)
   ├─ Tore: Schalter · Backend · state_schema · Kern meldet sich · Platte ·
   │        Neutral-Zeit T · „nicht mitten im Schreiben" · schon zurückgerollt?
   │
   ├─ HOLEN  (beide Images, VOR jedem Stopp) → Digest gegengeprüft
   ├─ SICHERN  Rückfallziel dreifach: :lkg-Tag · gestoppter Halter-Container ·
   │           `docker save`-Archiv   +   Gruppen-Sicherung des /data-Bestands
   ├─ BROTKRUME  pending-confirm.json — VOR dem ersten Tausch
   ├─ MELDEN  der Kern setzt `applying` DURABEL ab (QoS1, mit Ack)
   ├─ TAUSCHEN  eine Komponente nach der anderen: core, dann nodered
   ├─ SELBSTTEST  der NEUE Kern urteilt über sich (inkl. Steuer-Trockenlauf)
   │
   ├─ bestanden → BESTÄTIGEN (Rückfallziel wandert auf den neuen Stand)
   └─ nicht bestanden / Frist / Flattern → ZURÜCKNEHMEN (offline, ohne Registry)
```

Fünf Eigenschaften, auf die es ankommt:

1. **Sequenziert.** Es wird immer nur EINE Komponente getauscht. Während der
   Kern getauscht wird, lebt die Staleness-Failsafe von Node-RED — und danach
   umgekehrt. Beide Failsafe-Kopien sind NIE gleichzeitig weg.
2. **Nur was sich unterscheidet** wird getauscht.
3. **Die Brotkrume liegt vor dem ersten Tausch.** Ein Neustart mitten im
   Vorgang führt ihn deterministisch zu Ende, statt etwas Neues zu beginnen
   (Einzelschreiber-Semantik).
4. **Der durable `applying`-Bericht** ist die letzte Handlung vor dem Stoppen.
   Nur dadurch ist „im Update verstummt" ein eigener Zustand statt
   ununterscheidbar von „die Box ist weg". Ohne Broker wird nach einer
   begrenzten Frist trotzdem getauscht — eine Box ohne Cloud-Verbindung muss
   aktualisierbar bleiben.
5. **Was hier einmal zurückgerollt wurde, läuft nie wieder von selbst an**
   (`/data/ota/failed.json`). Ohne diese Regel drehte sich die Anlage im Kreis:
   die Zuweisung liegt ja noch, das Release läuft nach der Rücknahme immer noch
   nicht — der nächste Takt begänne denselben Tausch. Weiter geht es über ein
   ANDERES Release oder dadurch, dass ein Betreiber die Datei entfernt.

---

## 3. Die Inverter-Neutral-Zeit **T** — das eine, was noch fehlt

Während eines Tausches erneuert für Sekunden niemand den Sollwert. Hängt sich
die getauschte Komponente auf, bleibt genau ein Rückhalt: der Wechselrichter
fällt nach seiner **Kommunikations-Verlust-Zeit T** von selbst auf neutral
zurück. Die Wachhund-Frist liegt deshalb **strikt unter T** — das ist
Arithmetik, keine Absicht (`otaapply.WatchdogDeadline`, Marge = T/5, mind. 5 s).

**Heute ist für KEINE Familie ein T belegt.** Also gilt:

> Eine Anlage, die wirklich **steuert** (Not-Aus an UND Freigabe erteilt UND
> Wechselrichter gewählt), wird ohne belegtes T **nicht** autonom aktualisiert.
> Eine Anlage, die nur **liest** — das ist die heutige Flotte — hat kein
> gehaltenes Kommando, das T überleben könnte, und darf.

### T am Prüfstand belegen

1. Anlage steuert nachweislich (First-Light-Freigabe erteilt, Sollwert ≠ 0).
2. Layer 1 hart trennen (Node-RED stoppen bzw. Kabel ziehen) — **nicht** den
   Sollwert auf 0 setzen: gemessen wird das Verhalten bei KOMMUNIKATIONSVERLUST.
3. Messen, ab wann der Wechselrichter nachweislich neutral ist (Batterie-
   leistung an einem unabhängigen Messpunkt, nicht am selben Register).
4. Mehrfach wiederholen, den GRÖSSTEN gemessenen Wert nehmen, aufrunden.
5. Eintragen:

```bash
# .env auf dem Gerät
VP_OTA_NEUTRAL_VERIFIED=hybrid_3p:90,sunspec:45
```

Format `familie:sekunden`, mehrere durch Komma. **Ein unlesbarer Eintrag bricht
den Sidecar-Start ab** — eine still verworfene Zeile hieße „nicht verifiziert",
während der Betreiber glaubt, verifiziert zu haben. Ein T, unter dem keine
brauchbare Frist Platz hat (< ~19 s), wird ebenfalls abgelehnt.

Für eine Familie, deren T sich nicht belegen lässt, bleibt der Weg des
Vorentwurfs: ein winziger externer Neutral-Herzschlag außerhalb des
tauschbaren Satzes. Der ist **nicht gebaut**.

---

## 4. Der Registry-Zugang je Gerät

Der autonome Pull braucht stehende Zugangsdaten. Forgejos Token-Modell ist
**benutzer-** und nicht repository-bezogen (es gibt keine Deploy-Token für die
Paket-Registry), also gibt es zwei ehrliche Möglichkeiten. Gewählt ist:

> **Ein reiner Lese-Bot-Benutzer (`read:package`) — und daran EIN BENANNTES
> TOKEN JE GERÄT.** Forgejo erlaubt beliebig viele benannte Token je Benutzer
> und das Zurücknehmen eines einzelnen. „Gerät X den Zugang entziehen" ist damit
> ein Klick, ohne die übrige Flotte zu berühren.

**Die Grenze wird benannt, nicht versteckt:** alle diese Token tragen denselben
Umfang, ein gestohlenes Gerät kann also jedes Edge-Image ziehen. Bei dieser
Flottengröße ist das vertretbar — es ist Lesezugriff auf Software, die ohnehin
auf jeder Box liegt.

*Rückfall, falls die Token-Pflege zu viel wird:* EIN flottenweites
Nur-Lese-Token mit dokumentierter Rotation. Am Code ändert das nichts — er
liest ohnehin je Gerät eine Datei.

### Einrichten (einmal je Box, beim TOFU-Crossover)

1. In Forgejo als Bot-Benutzer `voltpilot-edge-pull` ein Token anlegen,
   Umfang **nur** `read:package`, Name = die Geräte-Referenz.
2. Auf dem Gerät ablegen (0600, im `vp-edge-data`-Volume neben `device.key`):

```bash
docker run --rm -v vp-edge-data:/data alpine:3.20 sh -c \
  'mkdir -p /data/ota && cat > /data/ota/registry-auth.json <<JSON
{ "registry": "git.tecmaxx.de", "username": "voltpilot-edge-pull", "token": "<TOKEN>" }
JSON
chmod 600 /data/ota/registry-auth.json'
```

3. Rotation = neues Token anlegen, Datei ersetzen, altes Token in Forgejo
   löschen. Der Sidecar liest die Datei bei jedem Start.

Fehlt die Datei, benutzt der Sidecar die Anmeldung des Docker-Daemons (der
Zustand, in dem eine heute von Hand gepflegte Box ohnehin ist).

---

## 5. Einschalten — die Reihenfolge ist bindend

**Nichts davon gehört auf eine Kundenanlage, bevor die Matrix aus §6 auf der
Canary-Box (Pilsting) mit echten Steuerzyklen bestanden ist.**

```bash
cd /srv/voltpilot-edge

# 1. Sidecar-Image holen und starten (Tor 1) - er beobachtet nur.
./update.sh --ota

# 2. Beobachten: was sagt er über sich?
docker compose --profile ota logs -f updater
docker run --rm -v vp-edge-data:/data alpine cat /data/ota/updater-state.json

# 3. Erst wenn das stimmt: der Schalter je Gerät (Tor 2).
docker run --rm -v vp-edge-data:/data alpine sh -c \
  'printf "{\"enabled\":true,\"note\":\"Canary Pilsting, Soak <Datum>\"}\n" \
   > /data/ota/autonomy.json'
```

**Wieder ausschalten** — sofort wirksam, ohne Neustart:

```bash
docker run --rm -v vp-edge-data:/data alpine \
  sh -c 'printf "{\"enabled\":false}\n" > /data/ota/autonomy.json'
```

Ein laufender Vorgang wird davon **nicht** abgebrochen (er wird zu Ende
gefahren oder zurückgenommen — beides endet in einem definierten Zustand). Der
harte Not-Aus ist `docker compose --profile ota stop updater`.

### Alle Stellschrauben

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `VP_OTA_AUTONOMOUS` | `false` | Not-Ein aus der Umgebung. Der eigentliche Schalter ist `autonomy.json`. |
| `VP_OTA_NEUTRAL_VERIFIED` | leer | Belegte Neutral-Zeiten, `familie:sekunden` (§3). |
| `VP_OTA_WATCHDOG_SECONDS` | `600` | Wachhund-Frist; wird durch T zusätzlich gedeckelt. |
| `VP_OTA_DISK_GUARD_MB` | `2048` | Freier Platz, unter dem nicht getauscht wird. |
| `VP_OTA_COMPOSE_FILES` | `docker-compose.yml` | Bei Host-Netz-Overlay BEIDE Dateien, durch `:` getrennt. |
| `VP_OTA_ACK_WAIT_SECONDS` | `45` | Wartezeit auf den durablen `applying`-Bericht. |
| `VP_OTA_TICK_SECONDS` | `5` | Takt. |

---

## 6. Die Fehlerinjektions-Matrix

`edge-app/test/ota-soak/run.sh` fährt den **echten** Sidecar gegen einen
**echten** docker-Daemon, mit einer **echten** Signaturkette und einer
**echten** Registry; nur die beiden getauschten Komponenten sind winzige
Stellvertreter (geprüft wird die Orchestrierung, nicht Node-RED).

**Die eine Zusicherung, an jedem Ausgang jedes Falles:**
*entweder der alte Stapel läuft, oder der neue ist bestätigt — nie eine tote Box.*

```bash
edge-app/test/ota-soak/run.sh            # alle Fälle
edge-app/test/ota-soak/run.sh --list     # die Liste
edge-app/test/ota-soak/run.sh happy prune
```

| Fall | Was injiziert wird | Erwartetes Ende |
|---|---|---|
| `autonomy_off` | nichts — der Auslieferungszustand | kein einziges docker-Kommando, v1 läuft |
| `happy` | nichts | v2 bestätigt |
| `selftest_fail` | Selbsttest urteilt „nicht bestanden" | zurückgenommen, v1 läuft, kein erneuter Versuch |
| `prune` | Rückfall-Image + Halter + Tags entfernt | Rücknahme aus dem `docker save`-Archiv |
| `registry_outage` | Registry gestoppt | verschoben, nichts gestoppt, kein Vorgang hinterlassen |
| `wedged_pull` | Pull gegen ein nicht geroutetes Netz | Aufruf gedeckelt, verschoben, v1 läuft |
| `mid_flip_reboot` | Sidecar mitten im Tausch hart abgeschossen | Vorgang FORTGESETZT, v2 bestätigt |
| `clock_skew` | uralter Kern-Zustand · abgelaufenes `valid_until` | (a) verschoben (b) angewandt — `valid_until` ist advisory |
| `broker_outage` | durabler Bericht nicht absetzbar | nach der Frist trotzdem getauscht |
| `disk_full` | Plattenwächter über dem Freiraum | verschoben, nicht einmal geholt |

**Rechner-Disziplin, im Skript verdrahtet:** eigenes Compose-Projekt, eigene
hohe Ports, eigene Volumes; immer nur EIN Stapel gleichzeitig (nach JEDEM Fall
wird abgeräumt); **es wird nie ein `docker system prune` ausgeführt** — der
`prune`-Fall räumt ausschließlich die eigenen Images weg und belegt die
Überlebensregel zusätzlich mit einem *label-gefilterten* echten
`docker image prune -a`. Ein Fehlschlag legt Protokollstand und Sidecar-Log
unter `edge-app/test/ota-soak/last-failure/` ab.

### Auf echter Hardware (Pilsting) — Aufgabe des Betreibers

Die Matrix ist auf einer Wegwerf-Umgebung gebaut und **ersetzt den Soak auf der
Canary-Box nicht**. Dort zusätzlich:

- die Freigabe für die Familie muss den Tausch **überleben** (der Selbsttest
  prüft es; ein Verlust ist ein Fehlschlag und führt zur Rücknahme);
- mindestens **ein echter Steuerzyklus** nach dem Tausch — das ist die
  Bake-Regel des Portals (D4), keine Aufgabe des Sidecars;
- T für die Familie **vorher** belegen (§3), sonst verweigert der Sidecar auf
  einer steuernden Anlage ohnehin.

---

## 7. Nachsehen, wenn etwas klemmt

```bash
docker compose --profile ota logs --tail 100 updater
docker run --rm -v vp-edge-data:/data alpine sh -c 'cat /data/ota/updater-state.json'
docker run --rm -v vp-edge-data:/data alpine sh -c 'ls -la /data/ota'
```

| Meldung | Bedeutung |
|---|---|
| `Autonomous: false` | Der Schalter ist aus — der Normalzustand. |
| `kein Vertrauensanker eingebacken` | Das Image trägt keine Wurzel (Auslieferungszustand vor der Zeremonie). |
| `Fuer die Familie … NICHT verifiziert` | §3: T belegen oder die Steuerung ausschalten. |
| `Der Kern meldet seinen Zustand nicht` | Der Kern läuft nicht bzw. `/data` ist nicht geteilt. |
| `wurde … bereits zurueckgenommen` | §2 Punkt 5 — ein anderes Release zuweisen oder `failed.json` entfernen. |
| `Zu wenig freier Speicherplatz` | Platte aufräumen bzw. `VP_OTA_DISK_GUARD_MB` prüfen. |
| Zustand bleibt `self_test` | Der neue Kern urteilt noch bzw. gar nicht — dann greift die Frist. |

**Von Hand übernehmen** geht jederzeit: `update.sh --from-target` benutzt
denselben `.env`-Hebel und dieselben geprüften Digests. Ein autonom angewandter
Stand ist von einem von Hand angewandten nicht zu unterscheiden.
