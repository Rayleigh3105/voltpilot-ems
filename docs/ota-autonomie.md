# Edge-Updates — Betreiber-Handbuch

> **Der ganze Ablauf in einem Satz:** Im Portal unter *Plattform → Edge-Updates*
> das Release wählen, die Geräte ankreuzen, **Aktualisieren** drücken. Die
> Geräte holen sich die Software und tauschen sich selbst aus.
>
> **Es gibt keinen zweiten Schritt.** Niemand muss auf ein Gerät, keine Shell,
> kein Passwort, keine Freigabe am Gerät, keine Wellen, kein Canary-Ring.

Seit dem **26.08.2026** ist jedes Tor entfallen, das den Zustand der ANLAGE
bewertete und dafür einen Menschen vor Ort brauchte: der Geräte-Schalter, das
Compose-Profil, der Neutral-Zeit-Nachweis, der Interlock, die Einmal-Freigabe
und die Dauersperre nach einer Rücknahme. Was bleibt, sind Eigenschaften des
**signierten Release** — die bewertet das Gerät im Takt selbst — und die
physische Grenze der Speicherkarte.

---

## 1. Was passiert, wenn Sie „Aktualisieren" drücken

```
Zuweisung geht retained an die gewählten Geräte
   │        (eine Box, die gerade offline ist, holt sie beim nächsten
   │         Verbindungsaufbau selbst ab - nichts geht verloren)
   │
   ├─ Das Gerät verifiziert SELBST  (eigene eingebackene Wurzel,
   │                                 eigener Anti-Rollback-Boden)
   ├─ HOLEN       beide Images, VOR jedem Stopp → Digest gegengeprüft
   ├─ SICHERN     Rückfallziel dreifach: :lkg-Tag · gestoppter Halter-Container ·
   │              `docker save`-Archiv   +  Sicherung des /data-Bestands
   ├─ BROTKRUME   vor dem ersten Tausch
   ├─ MELDEN      der Kern setzt `applying` durabel ab
   ├─ TAUSCHEN    eine Komponente nach der anderen: erst core, dann nodered
   ├─ SELBSTTEST  der NEUE Stand urteilt über sich (inkl. Steuer-Trockenlauf)
   │
   ├─ bestanden        → BESTÄTIGEN  (Rückfallziel wandert auf den neuen Stand)
   └─ nicht bestanden  → ZURÜCKNEHMEN (offline, ohne Registry)
```

Die vier Eigenschaften, auf die es ankommt:

1. **Sequenziert.** Es wird immer nur EINE Komponente getauscht. Während der
   Kern getauscht wird, lebt die Ausfallsicherung von Node-RED — und danach
   umgekehrt. Beide sind NIE gleichzeitig weg.
2. **Getauscht wird nur, was sich unterscheidet.**
3. **Die Brotkrume liegt vor dem ersten Tausch.** Ein Neustart mitten im
   Vorgang führt ihn zu Ende, statt etwas Neues zu beginnen.
4. **Eine Box ohne Cloud-Verbindung bleibt aktualisierbar.** Der durable
   `applying`-Bericht ist die letzte Handlung vor dem Stoppen (nur dadurch ist
   „im Update verstummt" ein eigener Zustand statt „die Box ist weg") — kommt
   er nicht durch, wird nach einer begrenzten Frist trotzdem getauscht.
5. **„Bestätigt" ist ein Beleg, kein Zeitstempel.** Der neue Core beobachtet
   die Brotkrume dauerhaft, wartet bis *beide* Komponenten getauscht sind und
   vergleicht dann den eigenen Build-Stempel mit dem zugewiesenen Release.
   Erst nach bestandenem Web-/Steuerpfad-Selbsttest zeichnet er den Stand auf.
   Dieselbe retained Zuweisung bleibt danach `bestätigt`; der angehobene
   Anti-Rollback-Boden darf den bereits laufenden Stand nicht wieder sperren.

Der Crashloop-Wächter zählt ebenfalls nur Befunde dieses Vorgangs: Beim Start
wird je Container ID und Neustart-Zähler gespeichert. Historische Neustarts
des alten Stands lösen deshalb keine Rücknahme des neuen Releases aus; drei
Neustarts eines tatsächlich neu angelegten Containers weiterhin sofort.

**Fehlschlag ist Information, keine Sperre.** Fällt ein Gerät durch, wird seine
Zeile rot und nennt den Grund; die übrigen Geräte laufen weiter, und die
nächste Zuweisung versucht es einfach wieder.

---

## 2. Was ein Update noch aufhalten kann

Alles davon bewertet das Gerät **selbst, im Takt** — keiner dieser Punkte
braucht jemanden vor Ort.

| Grund im Portal | Bedeutung | Ihr Hebel |
|---|---|---|
| `kette` | Signatur, Trust-Set oder Form stimmen nicht. **Sicherheits-Ereignis.** | Signaturkette prüfen (`docs/ota-signing.md`) |
| `politik` | Gültig signiert, gilt für diese Box aber nicht (Anti-Rollback-Boden, Rückschritt) | ein passendes Release zuweisen |
| `backend` | Das Release ist nicht für dieses Apply-Backend gemacht | — |
| `state_schema` | Das Release kann den Datenstand dieser Box nicht lesen (nur bei Rückschritt) | ein neueres Release zuweisen |
| `platte` | Zu wenig Platz — **nachdem** die Box ihre abgelösten Abbilder selbst weggeräumt hat. Eine physische Grenze. | Karte aufräumen, `VP_OTA_DISK_GUARD_MB` prüfen |
| `zurueckgenommen` | Genau **diese** Zuweisung wurde hier schon einmal zurückgenommen (kein endloser Kreis). | erneut aktualisieren — auch mit demselben Release — startet einen neuen Versuch |

Dazu die drei Tore der **Vorbereitung** (`laden`, `rueckfallziel`, `sicherung`):
sie halten den Tausch auf, **bevor** irgendetwas gestoppt wird — die Anlage
läuft dabei ununterbrochen weiter.

> **Boxen mit älterem Image** melden gelegentlich noch ein Wort aus der alten
> Welt (`neutralzeit`, `interlock`, `kern_still`, `freigabe_release`). Das
> Portal sagt dann ausdrücklich, dass es diese Sperre nicht mehr gibt und dass
> sie mit genau diesem Update wegfällt.

---

## 3. Bestandsboxen: EIN Befehl, danach nie wieder

Eine **frisch installierte** Box bringt den Apply-Sidecar von selbst mit
(`install.sh` startet ihn als gewöhnlichen Dienst). Boxen, die vor dem
26.08.2026 eingerichtet wurden, brauchen ihn **einmal**:

```bash
cd /srv/voltpilot-edge && ./update.sh
```

(bzw. das Deploy-Verzeichnis dieser Box). Der Befehl zieht die neue
`docker-compose.yml`, holt die Images und startet den `updater` dauerhaft mit.
Ab dann läuft jedes weitere Update über das Portal.

**Der Registry-Zugang wird dabei automatisch eingerichtet:** `install.sh` und
`update.sh` lesen den Eintrag aus der `docker login`-Anmeldung des Hosts und
legen ihn als `/data/ota/registry-auth.json` ab. Kein zusätzliches Geheimnis,
keine Handarbeit. *Ehrliche Grenze:* benutzt der Host einen Credential-Helper
(`credsStore`), steht dort kein Klartext — der Installer warnt dann laut und
nennt den Befehl, mit dem Sie die Datei von Hand ablegen.

---

## 4. Alte Abbilder: die Box räumt hinter sich auf

Jedes Update holt **zwei** neue Abbilder und hebt das Rückfallziel dreifach
auf. Ohne Aufräumen wächst die Karte mit jeder Runde — auf der Canary-Box
gemessen (Raspberry Pi 5, 15-GB-Karte, 09.08.2026): 58 Abbilder, 3 in Benutzung,
5,8 GB rückgewinnbar, und der Plattenwächter verweigerte deshalb einen
legitimen Rollout.

**Wann es läuft:** nach einem **bestätigten** Tausch — nie vorher, nie mitten
drin, und nach einer **Rücknahme gar nicht** (dort ist jedes Abbild potenziell
das, worauf gleich zurückgefallen wird).

**Was nie entfernt wird**, in dieser Reihenfolge geprüft:

1. jedes Abbild, auf das **irgendein** Container zeigt — laufend ODER gestoppt
   (das deckt die `vp-edge-lkg-*`-Halter ohne Sonderregel ab);
2. alles im Rückfall-Namensraum `vp-edge-lkg-*`, auch ohne Halter;
3. der laufende Stand und eine bereits vorab geholte **nächste** Zuweisung;
4. **alles, was nicht älter ist als der laufende Stand**;
5. je Repository die `VP_OTA_PRUNE_KEEP` (Vorgabe 1) jüngsten Verwaisten.

Das `docker save`-Archiv ist eine Datei und per Konstruktion außer Reichweite.
Entfernt wird **je Name**, nie mit `-f`, nie pauschal. Schalter:
`VP_OTA_PRUNE` / `VP_OTA_PRUNE_KEEP` in der `.env`, oder je Gerät
`/data/ota/prune.json` (fehlende Datei = an, **unlesbare Datei = nichts
entfernen**).

> **Bekannte Grenze:** eine schon blockierte Bestandsbox kommt hierüber nicht
> frei (ohne Tausch kein Aufräumen). Dort einmal von Hand
> `docker image prune -a` — durch den Halter-Container nachweislich sicher.

---

## 5. Alle Stellschrauben

Alles hat brauchbare Vorgaben; im Normalfall fassen Sie nichts davon an.

| Variable | Vorgabe | Wozu |
|---|---|---|
| `VP_OTA_TICK_SECONDS` | 5 | Wie oft der Sidecar nachsieht |
| `VP_OTA_WATCHDOG_SECONDS` | 600 | Frist bis zur Rücknahme, wenn der Selbsttest ausbleibt |
| `VP_OTA_DISK_GUARD_MB` | 2048 | Freiraum, unter dem nicht getauscht wird |
| `VP_OTA_ACK_WAIT_SECONDS` | 45 | Wie lange auf den durablen `applying`-Bericht gewartet wird |
| `VP_OTA_HEALTH_WAIT_SECONDS` | 120 | Wie lange der neue Stand Zeit hat, gesund zu werden |
| `VP_OTA_PRUNE` / `_KEEP` | `true` / 1 | Aufräumen abgelöster Abbilder (§4) |

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
| `happy` | nichts | v2 bestätigt |
| `selftest_fail` | Selbsttest urteilt „nicht bestanden" | zurückgenommen, v1 läuft, kein erneuter Versuch auf dieselbe Zuweisung |
| `prune` | Rückfall-Image + Halter + Tags entfernt | Rücknahme aus dem `docker save`-Archiv |
| `registry_outage` | Registry gestoppt | verschoben, nichts gestoppt, kein Vorgang hinterlassen |
| `wedged_pull` | Pull gegen ein nicht geroutetes Netz | Aufruf gedeckelt, verschoben, v1 läuft |
| `mid_flip_reboot` | Sidecar mitten im Tausch hart abgeschossen | Vorgang FORTGESETZT, v2 bestätigt |
| `clock_skew` | uralter Kern-Zustand · abgelaufenes `valid_until` | (a) verschoben (b) angewandt — `valid_until` ist advisory |
| `broker_outage` | durabler Bericht nicht absetzbar | nach der Frist trotzdem getauscht |
| `disk_full` | Plattenwächter über dem Freiraum | verschoben, nicht einmal geholt |
| `image_cleanup` | zwei bestätigte Updates hintereinander | nur laufender + EIN abgelöster Stand bleiben; Rückfall-Tag, Halter und Archiv unangetastet (§4) |

**Rechner-Disziplin, im Skript verdrahtet:** eigenes Compose-Projekt, eigene
hohe Ports, eigene Volumes; immer nur EIN Stapel gleichzeitig; **es wird nie ein
`docker system prune` ausgeführt**. Ein Fehlschlag legt Protokollstand und
Sidecar-Log unter `edge-app/test/ota-soak/last-failure/` ab.

---

## 7. Nachsehen, wenn etwas klemmt

Zuerst im Portal: die Geräte-Zeile trägt Zustand, Grund und Hebel. Wenn das
nicht reicht:

```bash
docker compose logs --tail 100 updater
docker run --rm -v vp-edge-data:/data alpine sh -c 'cat /data/ota/updater-state.json'
docker run --rm -v vp-edge-data:/data alpine sh -c 'ls -la /data/ota'
```

| Meldung | Bedeutung |
|---|---|
| `kein Vertrauensanker eingebacken` | Das Image trägt keine Wurzel — das Trust-Set fehlt (`docs/ota-signing.md` §6.0). |
| `Zu wenig freier Speicherplatz` | §4 — Karte aufräumen bzw. `VP_OTA_DISK_GUARD_MB` prüfen. |
| `wurde … bereits zurueckgenommen` | Diese Zuweisung ist verbraucht; im Portal erneut aktualisieren. |
| Zustand bleibt `self_test` | Der neue Stand urteilt noch bzw. gar nicht — dann greift die Frist und es wird zurückgenommen. |

**Von Hand übernehmen** geht weiterhin: `update.sh --from-target` benutzt
dieselben geprüften Digests, die das Gerät verifiziert hat. Ein autonom
angewandter Stand ist von einem von Hand angewandten nicht zu unterscheiden.
