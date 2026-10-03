# Start aus dem RAM und Updates

## Stufe 1 (heute, Pilot)

```mermaid
sequenceDiagram
    participant procd
    participant boot as boot.sh (Flash)
    participant srv as HTTPS-Server
    participant bin as vp-edge-light (RAM)
    procd->>boot: Start (und nach jedem Ende)
    boot->>boot: häufig geschriebene Verzeichnisse → /tmp
    boot->>srv: vp-edge-light-linux-mipsle.sha256
    boot->>srv: vp-edge-light-linux-mipsle
    boot->>boot: Prüfsumme vergleichen
    boot->>bin: exec (Umgebung aus /etc/config/vp-edge-light)
    Note over bin: endet das Programm, startet procd den Loader nach 10 s neu
```

- **Im Flash** liegen der Loader (~4 KB), der Dienst, die Konfiguration, die gepackte Kopie des Programms (~4,4 MB) und der dauerhafte Zustand der Box (Identität, Zertifikat, Auswahl, Freigaben, OCPP-Befehlsbuch).
- **Im RAM** liegen das Programm (~14 MB) und die häufig geschriebenen Verzeichnisse.
- Schlägt der Download fehl, versucht der Loader es mit Pausen (5 / 15 / 30 / 60 s). Liegt aus einem früheren Start noch eine Fassung im RAM (Neustart des Dienstes ohne Neustart des Geräts), wird sie weiterverwendet. Danach – und ohne `base_url` immer – entpackt er die **lokale Kopie aus dem Flash** (`/usr/share/vp-edge-light/*.gz`, Prüfsumme des ungepackten Programms). So startet die Box auch nach einem Neustart ohne Internet; vorher war das die Kehrseite des RAM-Starts.
- **Grenze von Stufe 1:** Die Prüfsumme kommt vom selben Server wie das Programm. Sie schützt gegen abgebrochene Downloads, nicht gegen einen kompromittierten Server. Die Echtheit hängt allein an HTTPS.

## Stufe 2: signierte Kette wie bei der Docker-Box

Ziel: Edge Light vertraut einem Programm aus dem Netz nur, wenn es mit derselben Kette signiert ist wie die Releases der Docker-Box ([`docs/ota-signing.md`](../../docs/ota-signing.md)): kalte Wurzel → Trust-Set → Release-Manifest.

```mermaid
flowchart LR
    root["eingebackene Wurzel<br/>(im Prüfprogramm)"] --> ts["Trust-Set<br/>(beim Einrichten)"]
    ts --> man["Release-Manifest<br/>(signiert)"]
    man -- "sha256 je Architektur" --> bin["vp-edge-light<br/>(geladen in RAM)"]
```

Bausteine:

1. **Kleines Prüfprogramm `vp-light-boot` im Flash** (Go, nur `internal/otaverify` + SHA-256, ~2 MB statt der ~14 MB des ganzen Programms). Es ersetzt die Prüfsummen-Prüfung in `boot.sh`: Manifest und Signatur laden, gegen die **eingebackene Wurzel** prüfen (exakt die Funktion, die Gerät und Werkzeug `vp-ota` schon teilen), Anti-Rollback-Boden prüfen, dann den SHA-256 des Programms mit dem Manifest vergleichen und erst dann starten. Es ändert sich selten und wird wie heute das Trust-Set beim Einrichten aufgespielt.
2. **Additive Vertragserweiterung** in `docs/contracts/ota-release-manifest.schema.json`: Das Feld `artifacts` ist ausdrücklich für weitere Typen vorgesehen. Neu: `{"type": "binary", "name": "vp-edge-light", "arch": "linux/mipsle", "sha256": "…", "size": …}` und `compat.backends: ["light"]`. Ein Docker-Gerät ignoriert Artefakte seines Backends nicht, die es nicht kennt – das muss der Vertragstest beweisen, bevor die Erweiterung gemergt wird.
3. **Verteilung:** Der Release-Lauf (`edge-images.yaml`) baut zusätzlich die drei Programme, signiert sie im selben Manifest und legt sie ab. Wo, ist zu entscheiden: als Forgejo-Release-Anhang (braucht ein Token auf dem Gerät – ungünstig) oder über eine Portal-Route, die die Dateien unauthentifiziert ausliefert (wie heute schon das Trust-Set). Da Echtheit über die Signatur entsteht, darf der Transport offen sein.
4. **Updates:** Der Core empfängt Zuweisungen bereits über `ems/…/v2/update` und schreibt `target.json`. Auf Edge Light lädt `vp-light-boot` beim nächsten Start die zugewiesene Fassung statt `latest`; der Core beendet sich nach einer neuen Zuweisung kontrolliert, procd startet neu. Kein Docker, keine Images, kein Updater-Container.
5. **Rückfall:** Startet die neue Fassung nicht sauber (Selbsttest des Cores, wie bei der Docker-Box), lädt `vp-light-boot` beim nächsten Versuch die zuletzt bestätigte Fassung (`current.json` im Flash). Der Selbsttest selbst existiert im Core schon (synthetischer Steuer-Trockenlauf).

## Offene Entscheidungen für Stufe 2

| Frage | Vorschlag |
|---|---|
| Wo liegen die Programme? | Portal-Route, unauthentifiziert, nur signierte Artefakte |
| Kommt `vp-light-boot` per OTA? | Nein – wie das Trust-Set beim Einrichten (es ist die Vertrauenswurzel des Geräts) |
| Was, wenn nach einem Stromausfall kein Internet da ist? | Gebaut in Stufe 1: die gepackte Kopie im Flash (4,4 MB gzip, [mango.md](mango.md)). Stufe 2: dort die zuletzt **bestätigte** Fassung ablegen und vor dem Start gegen die Signatur prüfen |
