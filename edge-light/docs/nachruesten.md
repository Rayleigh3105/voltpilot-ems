# Nachrüsten: Boxen mit Stufe 1 auf Updates aus dem Portal

Runbook für den Captain (Konzept `vp-edge-light-update`, K7, Entscheid U-5 A). Gilt für `edge-tgjn9gd` (beim Kunden, erste echte Mango) und danach gleich für den Piloten `edge-zay5sdd` und das VoltPilotGATE. Vorher **genauso** an der Labor-Mango `edge-5t2dcy6` – mit echter, signierter Fassung, nicht mit dem Labor-Bau.

Eine Box mit Stufe 1 startet für immer die Fassung aus ihrem Flash; ihr Loader kennt keine Updates. Einmal durch den Wartungstunnel nachgerüstet, kommt jede weitere Fassung über das Portal. Box-Daten bleiben: Identität, Zertifikat, Auswahl, Konfiguration.

## Voraussetzungen

1. K1 bis K5 sind gemergt und deployt (api, Portal, Werkstatt-Dienst).
2. Die Repo-Variable `EDGE_LIGHT_SIGNIEREN=true` ist gesetzt, und es gibt **zwei** signierte Edge-Light-Releases: `N` zum Nachrüsten und `N+1` für das erste Update. Im Portal unter Edge-Updates stehen beide, jedes mit fertigen Programmen (`GET /api/v1/admin/edge-releases/<fassung>/programme` → `fertig: true` für `linux/mipsle`).
3. Der Laborbeweis ist an der Labor-Mango gelaufen ([Labor](../labor/README.md)), oder er läuft unmittelbar vorher mit denselben Schritten.
4. Ein Techniker-Zugang mit RSA-SSH-Schlüssel (`~/.ssh/id_rsa_voltpilot`), WireGuard zum Wartungsserver steht ([Fernwartung](../../docs/fernwartung.md)).
5. Ein Zeitpunkt, zu dem eine Unterbrechung von rund einer Minute beim Kunden nicht stört (Überschussladen der go-e, [mango.md](mango.md)).

## Schritte

### 1. Fassung `N` holen und prüfen (am eigenen Rechner)

```bash
REL=edge-light-JJJJ.MM.N            # das signierte Release zum Nachrüsten
mkdir -p ~/nachruesten/$REL && cd ~/nachruesten/$REL
for f in vp-edge-light-linux-mipsle edge-light-openwrt.tar.gz sha256sums release.json release.json.sig; do
  curl -fL -H "Authorization: token $FORGEJO_TOKEN" -o "$f" \
    "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/$REL/$f"
done
grep -E 'vp-edge-light-linux-mipsle$|edge-light-openwrt.tar.gz$' sha256sums | shasum -a 256 -c -
tar xzf edge-light-openwrt.tar.gz && mkdir -p dist && cp vp-edge-light-linux-mipsle dist/
```

Erwartet: beide Zeilen `OK`. `release.json` nennt `"release": "$REL"` und `"backends": ["light"]`. Die Signatur prüft die Box nicht beim Einrichten; sie prüft erst Updates. Zur Kontrolle vorher: `(cd <repo>/edge-app/core && go run ./cmd/vp-ota verify --root baked --backend light --trust-set <repo>/edge-app/ota/trust-set.json --manifest ~/nachruesten/$REL/release.json)` → `Urteil: ok`.

### 2. Wartungsfenster öffnen

Portal → Geräte → Fernwartung → `edge-tgjn9gd` → Fenster öffnen (eigener Techniker-Zugang, Grund „Nachrüsten Updates (U-5)“, 60 min). Das Portal nennt die Box-Adresse im Tunnel (`10.10.16.x`).

`~/.ssh/config` (install.sh ruft `ssh <ziel>` ohne Port auf):

```
Host vp-tgjn9gd
  HostName 10.10.16.x
  Port 2222
  User root
  IdentityFile ~/.ssh/id_rsa_voltpilot
```

Probe: `ssh vp-tgjn9gd 'cat /etc/vp-edge-light/ref; df -k /usr/share/vp-edge-light | tail -1; free'` → Referenz `edge-tgjn9gd`, freier Flash (kB), freier Speicher.

### 3. Sichern

```bash
ssh vp-tgjn9gd 'tar czf - /etc/vp-edge-light /etc/config/vp-edge-light /usr/share/vp-edge-light \
  /usr/libexec/vp-edge-light/boot.sh /etc/init.d/vp-edge-light' > ~/nachruesten/edge-tgjn9gd-vorher.tar.gz
tar tzf ~/nachruesten/edge-tgjn9gd-vorher.tar.gz | head
```

Die Sicherung (~5 MB) bleibt auf dem eigenen Rechner; auf die Box passt keine zweite Kopie.

### 4. Nachrüsten

```bash
cd ~/nachruesten/$REL
VP_LIGHT_ARCH=mipsle VP_LIGHT_MANIFEST=$PWD/release.json sh openwrt/install.sh vp-tgjn9gd
```

`install.sh` lädt das Vertrauens-Set offen von `https://portal.voltpilot.de` (oder `VP_TRUST_SET_DIR=<repo>/edge-app/ota`). Es schreibt Loader und Dienst neu, legt das Vertrauens-Set in den Flash und schreibt die Prüfsummen **vor** der Kopie. Danach setzt es `current.json` aus dem Manifest und entfernt `base_url`.

Erwartete Zeilen:
- `--- Fassung $REL (Stand …) laut signiertem Manifest`
- `… Pruefsumme auf dem Geraet bestaetigt`
- `--- Stand vermerkt`

**Restrisiko:** Passt nur eine Kopie in den Flash, entfernt `install.sh` die alte Kopie vor dem Schreiben (10–30 s). Fällt genau dann der Strom aus, startet der neue Loader nach dem Strom die Fassung `$REL` aus dem Portal nach (Zeile 2 der Prüfsummen). Der Tunnel bleibt in jedem Fall stehen, und `install.sh` lässt sich durch ihn erneut ausführen.

### 5. Neu starten und prüfen

```bash
ssh vp-tgjn9gd '/etc/init.d/vp-edge-light restart; sleep 40; logread -e vp-edge-light | tail -n 20'
ssh vp-tgjn9gd 'wget -q -O - http://127.0.0.1:8484/health'
```

Erwartet in `/health`:
- `"version": "$REL"`
- `ota_update.backend = "light"`
- `ota_update.trust.trust_set_key_ids` nicht leer und ohne `trust_set_error`
- `ota_update.current_seq` = Stand `N`
- `cloud_connected: true`

Im Portal zeigt das Gerät unter Edge-Updates **kein** „Updates von Hand (Edge Light, Stufe 1)“ mehr.

Tunnel: `ssh vp-tgjn9gd 'wg show vp-wartung latest-handshakes'` → jünger als 3 min. Dann das Fenster schließen.

### 6. Erstes echtes Update über das Portal (U-6)

Portal → Plattform → Edge-Updates → Release `N+1` wählen → `edge-tgjn9gd` ankreuzen → „Aktualisieren“. Zusehen (Portal und, mit offenem Fenster, `logread -f -e vp-edge-light`):

| Zustand im Portal | Was die Box tut |
|---|---|
| wird geladen | Programm lädt ~5 MB aus `/api/v1/edge/light-programm/…` und prüft sie |
| wird angewandt | Programm beendet sich; der Loader tauscht (Probestart `version`) |
| Selbsttest | neue Fassung läuft zur Probe; Trockenlauf, Web-App, Cloud |
| erfolgreich | Loader legt die Fassung in den Flash (Prüfsummen zuerst), `current.json` = Stand `N+1` |

Danach: `/health` → `"version"` = `N+1`; `/etc/vp-edge-light/ota/versuche` endet mit `start <N+1> …` und `ok <N+1> …`. Die Unterbrechung dauert rund 30 s. Wenn es scheitert: Der Loader nimmt zurück (Portal „zurückgenommen“ mit Grund). Die Box läuft mit `N` weiter; der Grund steht im Portal und in `versuche`. Erst nach einer Klärung erneut „Aktualisieren“.

Mit diesem gelungenen Update und dem grünen Laborbeweis ist U-6 erfüllt: Dann wird der Satz „Nicht versenden“ in der Werkstatt durch die Abnahme-Prüfung „Update-bereit“ ersetzt (eigener kleiner PR: `VERSAND_SATZ` und der Beleg „versand“ des Werkstatt-Dienstes).

## Danach: Pilot und VoltPilotGATE

- `edge-zay5sdd` hängt noch am alten Service-VPN (`10.10.1.25`, [mango.md](mango.md)). Die Schritte 1, 3–6 gelten unverändert; `HostName` ist die VPN-Adresse, Port nach dem dortigen Stand (22 im alten VPN).
- VoltPilotGATE: nur, wenn ein Tunnel oder ein VPN-Weg besteht. Sonst vor Ort im LAN mit denselben Schritten.

## Zurück, falls nötig

Das Nachrüsten ändert nur Loader, Dienst, Vertrauens-Set, Fassung und `current.json`. Zurück auf den Stand vorher (Fenster offen):

```bash
ssh vp-tgjn9gd 'rm -rf /etc/vp-edge-light/ota /usr/share/vp-edge-light/*; tar xzf - -C /' < ~/nachruesten/edge-tgjn9gd-vorher.tar.gz
ssh vp-tgjn9gd '/etc/init.d/vp-edge-light restart'
```

Danach läuft wieder die Fassung von vorher mit dem Loader der Stufe 1.
