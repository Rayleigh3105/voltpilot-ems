# Laborbeweis P1–P11 an der Labor-Mango

Bevor eine Box mit Edge Light zum Kunden geht (Entscheid 5c, U-6), muss jeder Fehlerfall des Updates einmal an der echten Labor-Mango `edge-5t2dcy6` gezeigt sein. Konzept `vp-edge-light-update`, Abschnitt 8; der Ablauf steht in [boot-und-updates.md](../docs/boot-und-updates.md).

**Nie mit dem echten Release-Schlüssel, nie gegen das Produktiv-Portal.** Der Labor-Bau hat eine eigene Wegwerf-Wurzel; die Labor-Mango hängt für den Beweis am lokalen Entwicklungs-Stapel.

## Werkzeuge

| Datei | Zweck |
|---|---|
| `laborbau.sh <ausgabe> <erste-seq> [mipsle\|amd64]` | Wegwerf-Kette (`root-labor`, `rel-labor`, `rel-fremd`), Labor-Vertrauens-Set, neun Fassungen mit eingebackener Labor-Wurzel, signierte Manifeste, `hochladen.sh` |
| `<ausgabe>/hochladen.sh` | trägt die Fassungen in Reihenfolge ins **lokale** Portal ein und lädt die Programme hoch (`VP_LABOR_PORTAL`, `VP_LABOR_TOKEN`; verweigert `*.voltpilot.de`) |
| `labor-probe.sh [<ausgabe amd64>]` | Trockenlauf des Pakets im OpenWrt-25.12.5-Container mit den echten Programmen: Einrichten, Laden, Tausch, Probe ohne Cloud → zurück, fremde Signatur → abgelehnt. Vor jedem Laborbeweis einmal fahren |
| `../test/boot-update-probe.sh` | alle Zweige des Loaders im Container |

Die Fassungen (`fassungen.txt` nennt Stand und Wirkung):

| Name | Fall | Fassung | Wirkung |
|---|---|---|---|
| `ausgang` | Ausgang, P11 | `edge-light-2099.01.0` | wird eingerichtet; später als Rückschritt zugewiesen |
| `gut` | P1, P7, P9 | `.1` | neuere gute Fassung |
| `arch` | P2 | `.2` | arm64-Programm, als `linux/mipsle` signiert |
| `absturz` | P3 | `.3` | endet sofort mit Fehler |
| `keincloud` | P4 | `.4` | echtes Programm in einer Hülle mit leerem Datenverzeichnis im RAM, ohne Dev-Identität: läuft, erreicht die Cloud nie |
| `speicher` | P5 | `.5` | belegt Speicher bis zum OOM-Killer |
| `haenger` | P6, P8 | `.6` | läuft, Selbsttest wird nie grün |
| `faelschung` | P10a | `.7` | echt; die Bytes werden nach dem Hochladen im Labor-Portal verändert |
| `fremd` | P10b | `.8` | mit `rel-fremd` signiert (nicht im Labor-Vertrauens-Set) |

## Vorbereiten (einmal)

1. Lokalen Entwicklungs-Stapel starten ([docs/development.md](../../docs/development.md)), mit K1–K5 auf dem Stand von `main`. Im lokalen Portal die Labor-Mango als Gerät anlegen und einem Standort zuordnen; Mandant, Standort und Geräte-ID notieren.
2. Paket bauen: `next-seq` des lokalen Portals lesen (`GET /api/v1/admin/edge-releases/next-seq`), dann
   ```bash
   edge-light/labor/laborbau.sh ~/labor/edge-light <next-seq> mipsle
   edge-light/labor/laborbau.sh /tmp/labor-amd64 900 amd64 && edge-light/labor/labor-probe.sh /tmp/labor-amd64
   ```
   Der Trockenlauf muss grün sein (`14 bestanden`).
3. Hochladen: `VP_LABOR_PORTAL=http://<stapel>:8080 VP_LABOR_TOKEN=<admin-token> ~/labor/edge-light/hochladen.sh`. Im Portal unter Edge-Updates stehen danach neun Releases `edge-light-2099.01.*`, jedes mit fertigem Programm (`GET /api/v1/admin/edge-releases/<fassung>/programme`).
4. Labor-Mango an den Stapel hängen und mit der Ausgangsfassung einrichten (durch den Wartungstunnel oder im LAN):
   ```bash
   mkdir -p /tmp/stand/dist && cp -R edge-light/openwrt /tmp/stand/
   cp ~/labor/edge-light/fassungen/ausgang/vp-edge-light-linux-mipsle /tmp/stand/dist/
   VP_SSH_KEY=<techniker-schluessel> VP_TRUST_SET_DIR=~/labor/edge-light/trust-set \
     VP_LIGHT_MANIFEST=~/labor/edge-light/fassungen/ausgang/release.json \
     sh /tmp/stand/openwrt/install.sh root@<mango>
   ssh root@<mango> "uci set vp-edge-light.main.portal_url=http://<stapel>:8080
     uci add_list vp-edge-light.main.env=VP_DEV_TENANT_ID=<mandant>
     uci add_list vp-edge-light.main.env=VP_DEV_SITE_ID=<standort>
     uci add_list vp-edge-light.main.env=VP_DEV_DEVICE_ID=<geraet>
     uci add_list vp-edge-light.main.env=VP_DEV_CLOUD_URL=tcp://<stapel>:1883
     uci commit vp-edge-light && /etc/init.d/vp-edge-light restart"
   ```
   **Wichtig:** Die echten Box-Daten der Labor-Mango (`/etc/vp-edge-light`) vorher sichern. Nach dem Beweis die `VP_DEV_*`-Einträge entfernen und die Labor-Mango mit einer echten, signierten Fassung neu einrichten – ein Labor-Programm nimmt kein echtes Release an.
5. Prüfen: `wget -q -O - http://127.0.0.1:8484/health` auf der Box zeigt `ota_update.trust.root_key_ids = ["root-labor"]`, `trust_set_key_ids = ["rel-labor"]`, `current_seq` = Stand von `ausgang`; das lokale Portal zeigt das Gerät verbunden, ohne „Updates von Hand“.

## Während jedes Falls und danach

- Auf der Box mitlesen: `logread -f -e vp-edge-light` und `cat /etc/vp-edge-light/ota/versuche`.
- Strom über eine schaltbare Steckdose oder von Hand.
- **Nach jedem Fall** (Schicht 8):
  - WireGuard-Handshake jünger als 3 min: `wg show vp-wartung latest-handshakes`.
  - SSH 2222 durch den Tunnel geht.
  - Die Web-App antwortet (`:8484`).
  - Das Portal zeigt den erwarteten Zustand.
- Zuweisen: Portal → Plattform → Edge-Updates → Release wählen, Labor-Mango ankreuzen, „Aktualisieren“. Für einen neuen Versuch desselben Release erneut „Aktualisieren“ (neue Zuweisung).

## Die Fälle

| Nr. | Fall | So erzeugt | Erwartet | Belegt durch | ✓ |
|---|---|---|---|---|---|
| P1 | Gut-Fall | `gut` zuweisen | „erfolgreich“; `versuche`: `start` dann `ok`; Prüfsummen-Datei Zeile 1/2 = `gut`; danach Strom aus/an → `gut` läuft, `current_seq` = Stand `gut` | Portal, `versuche`, `/health` | ☐ |
| P2 | Falsche Architektur | `arch` zuweisen | Probestart scheitert sofort („Probestart gescheitert: Programm startet nicht“), `zurueck` ohne `start`, bisherige Fassung läuft, „zurückgenommen“ mit Grund | `versuche`, Portal | ☐ |
| P3 | Absturz beim Start | `absturz` zuweisen | drei Starts zur Probe (procd alle 10 s), dann `zurueck … 3-mal abgestuerzt`; kein vierter Start; kein neuer Versuch von selbst | `logread`, `versuche` | ☐ |
| P4 | Keine Cloud | `keincloud` zuweisen | Urteil offen; nach 10 min `zurueck … keine Cloud-Verbindung in der Probezeit`; bisherige Fassung meldet „zurückgenommen“ | `probe-urteil.json`, `versuche`, Portal | ☐ |
| P5 | Speicherfresser | `speicher` zuweisen | der Kernel beendet das Programm (`logread`: oom-kill `vp-edge-light`), **nicht** WireGuard, SSH oder netifd; nach drei Abstürzen zurück | `dmesg \| grep -i oom`, Tunnel steht | ☐ |
| P6 | Hänger | `haenger` zuweisen | nach 10 min `zurueck … Selbsttest nicht binnen 10 min bestanden` | `versuche` | ☐ |
| P7 | Strom weg beim Laden | `gut` zuweisen (vorher auf `ausgang` zurück, s. u.), Stecker ziehen, während das Portal „wird geladen“ zeigt | bisherige Fassung startet, die Box lädt erneut und schließt ab („erfolgreich“) | Portal, `versuche` | ☐ |
| P8 | Strom weg in der Probe | `haenger` zuweisen; in der Probe (Portal „Selbsttest“) Stecker ziehen. Nach dem Neustart lädt die Box dieselbe Zuweisung von selbst erneut (kein neues „Aktualisieren“); in dieser zweiten Probe nochmals Stecker ziehen | nach dem ersten Mal `abbruch` und neuer Versuch; nach dem zweiten `abbruch` „zurückgenommen“ (Release gilt als gescheitert), bisherige Fassung läuft | `versuche` (zwei `abbruch`) | ☐ |
| P9 | Strom weg beim Flash-Tausch | auf `ausgang` zurück, `gut` zuweisen; Stecker ziehen, sobald `logread` „Probe: … startet“ zeigt plus die Zeit bis zum grünen Selbsttest (~30–60 s), mehrfach mit verschiedenen Sekunden | immer startet eine geprüfte Fassung; war die Kopie unvollständig: „bestaetigte Fassung aus dem Portal nachgeladen“; einmal ohne Netz (WAN abziehen): Programm startet nicht, Tunnel steht (über WAN zurück → startet) | `logread`, Tunnel | ☐ |
| P10a | Fälschung im Portal | `faelschung` zuweisen, nachdem im lokalen Stapel die Bytes verändert wurden: `UPDATE edge_light_programm SET daten = overlay(daten placing '\x00'::bytea from 1000) WHERE release_seq = <Stand faelschung>;` | „fehlgeschlagen“ (Prüfsumme der Lieferung passt nicht), nichts getauscht, kein `start` | Portal, `versuche` | ☐ |
| P10b | Falsche Unterschrift | `fremd` zuweisen | „fehlgeschlagen“ vor dem Laden (Signatur nicht im Vertrauens-Set), nichts geladen | Portal | ☐ |
| P11 | Rückschritt | nach P1 (es läuft `gut`) `ausgang` zuweisen | nicht angewandt: „zurückgestellt“, Grund Rückschritt ohne Freigabe (`release_seq` kleiner als der bestätigte Stand); nichts geladen, `gut` läuft weiter | Portal, `/health` | ☐ |

Zwischen den Fällen auf einen bekannten Stand zurück: die Ausgangsfassung wie in „Vorbereiten“ Schritt 4 neu einrichten (`install.sh` setzt Fassung und `current.json`; `versuche` bleibt als Verlauf).

## Ergebnis festhalten

Je Fall: Datum, Fassung, Auszug aus `versuche` und `logread`, Zustand im Portal, Tunnel-Prüfung. Erst wenn alle Zeilen ✓ tragen, ist U-6 zur Hälfte erfüllt; die andere Hälfte ist das erste echte Update auf `edge-tgjn9gd` ([Nachrüsten](../docs/nachruesten.md)).
