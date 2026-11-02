# Werkstatt-Dienst

Ein Dienst im Cluster, der eine neue Box in der Werkstatt einrichtet: Du steckst eine Mango ab Werk mit dem orangen
Kabel WERKSTATT in ihre Buchse LAN, der Dienst macht den Rest und hält jeden Schritt mit einem Beleg aus der echten
Ausgabe fest. Konzept: „Werkstatt-Automatik“ (Bericht `vp-edge-image-aufspielen-konzept`, 02.11.2026), Entscheide
WI-1 bis WI-13 (WI-10 B, WI-13 B, sonst A). Gebaut wird zuerst V1a: die Mango an der Box.

Was die Portal-Seite **Geräte › Werkstatt** heute zeigt ([docs/werkstatt.md](../../docs/werkstatt.md)), gilt
weiter: Die drei Griffe der Fernwartung (Tunnel-Schlüssel hinterlegen, Fenster öffnen, Fenster schließen) und die
Abnahme machst du in V1a wie bisher im Portal, dann mit den Belegen dieses Dienstes.

| Teil | Was | Wo |
|---|---|---|
| Lauf | Je Box eine feste Folge von Schritten. Jeder Schritt endet mit einem Beleg; fehlt er oder scheitert der Schritt, hält der Lauf an. Nichts wird übersprungen. | `internal/lauf` |
| Schritt-Protokoll | Je Lauf eine Datei, eine JSON-Zeile je Ereignis, nur angehängt (`laeufe/<kennung>.jsonl` im Datenverzeichnis). | `internal/protokoll` |
| Geheimnisse | Passwörter und private Schlüssel nur als `geheim.Geheim`: jede Formatierung ergibt `[geheim]`; Log und Protokoll schwärzen jeden bekannten Wert, auch wenn ihn eine Ausgabe zitiert. Ein Test schickt ein bekanntes Passwort durch einen Lauf und sucht es in Log, Belegen, Metriken und Stand. | `internal/geheim`, `internal/lauf/passwort_test.go` |
| Freigabe | Dein Okay, Boxen einzurichten: Fassungen (OpenWrt, Edge Light, Skripte, je mit Prüfsumme) und bis wann; gilt für jede Box, die du in der Zeit einsteckst. Ohne laufende Freigabe richtet der Dienst keine Box ein. Ab V1 im Portal (`werkstatt_freigabe`), gelesen über das Dienstkonto; ohne API eine Datei aus einer ConfigMap. | `internal/freigabe`, `internal/apikonto`, [Runbook](docs/runbook.md#werkstatt-freigeben) |
| Werkbank-Brücke | Ein Raspberry Pi im WLAN, seine Netzwerkbuchse ist der Werkstatt-Anschluss (WI-13 B). Kein eigenes Programm, nur Konfiguration; der Dienst richtet sie ein und pflegt sie. | [bruecke/](bruecke/README.md), `internal/werkbank` |
| Anzeige | Betriebsseite für Kubernetes (`/health`, `/ready`, `/metrics`) und die Werkstatt-Anzeige (Brücke, Freigabe, Läufe mit Belegen), die nur im Pod auf Loopback lauscht: `kubectl port-forward`. | `internal/anzeige` |
| Betrieb | gitops-Entwurf (Namespace `werkstatt-prod`, PodSecurity `restricted`, Application mit Sync von Hand, SOPS-Vorlage, NetworkPolicy) und Runbook. | [deploy/gitops/](deploy/gitops/README.md), [docs/runbook.md](docs/runbook.md) |
| Mango einrichten | Erkennen, OpenWrt aufspielen, Passwort, Notfall-Schlüssel, Edge Light, Tunnel, LAN, Neustart-Probe – die Schritte unten. | `internal/mango` |
| Box-Verbindung | SSH als root durch die Brücke; nach OpenWrt gilt für den ganzen Lauf genau ein Host-Schlüssel. | `internal/box` |
| Durchreiche | Die Skripte des Release-Stands (`install.sh`, `service-tunnel.sh`) rufen `ssh <ziel> <befehl>` auf; ein `ssh`-Verweis auf dieses Programm reicht jeden Aufruf über eine Unix-Socket an die Verbindung des Laufs. | `internal/durchreiche` |
| Fassungen | OpenWrt-Abbild, Programm und Skriptstand der Freigabe, geprüft nach sha256, im Zwischenspeicher nach Prüfsumme. | `internal/fassungen` |

Stand der Pakete aus dem Konzept (Abschnitt 8): P1 Grundgerüst, P2 Werkbank-Brücke, P11 Betrieb, P3
(Werksfirmware → OpenWrt), P5 (Box einrichten) und P4 (Edge-Light-Fassung je Release) sind gebaut: Der Lauf
[`edge-light-release.yaml`](../../.forgejo/workflows/edge-light-release.yaml) baut zu einem Tag `edge-light-JJJJ.MM.N`
die Anhänge unten ([Runbook](docs/runbook.md#fassungen-der-freigabe)). Damit ist V1a vollständig.

## Ein Lauf an der Mango

Steckt am orangen Kabel genau eine Mango ab Werk (192.168.8.1) oder mit frischem OpenWrt (192.168.1.1) und läuft
eine Freigabe, beginnt ihr Lauf von selbst. Jeder Schritt endet mit einem Beleg; fehlt er, hält der Lauf an.

| Schritt | Was | Beleg |
|---|---|---|
| `erkennen` | genau ein Gerät mit einer MAC; SSH als root ohne Passwort; Board `glinet,gl-mt300n-v2`; GL-Firmware (`/etc/glversion`); root hat kein Passwort (nicht eingerichtet) | MAC, Board, GL-Fassung, Host-Schlüssel ab Werk, Antwort der GL-Schnittstelle (nur festgehalten, PS-1) |
| `fassungen` | OpenWrt-Abbild, Programm, Skriptstand der Freigabe bereitlegen, je sha256 geprüft – bevor die Box angefasst wird | Prüfsummen, Herkunft |
| `openwrt` | Abbild nach `/tmp`, sha256 auf der Box, `sysupgrade -T`, dann `sysupgrade -n` (nie `-F`) | sha256 vorher und auf der Box, Ausgaben |
| `wiedererkennen` | bis frisches OpenWrt unter 192.168.1.1 antwortet: Fassung der Freigabe, root ohne Passwort; ab jetzt gilt sein Host-Schlüssel | `openwrt_release`, Board, Host-Schlüssel |
| `internet` | befristet: Standardweg und DNS über die Brücke (192.168.1.2) | Standardweg, `https://downloads.openwrt.org` erreichbar (PS-12) |
| `passwort` | zufällig (20 Zeichen wie das Portal), erst verschlüsselt für den age-Schlüssel „Box-Passwörter“ (WI-6 A), dann über die Standardeingabe gesetzt | „ohne Passwort abgewiesen“, `passwort_age` |
| `notfall` | der Notfall-Schlüssel als einziger dauerhafter Schlüssel | eine Zeile, Fingerabdruck |
| `programm` | `install.sh` aus dem Skriptstand, Neustart von `vp-edge-light` | „Pruefsumme auf dem Geraet bestaetigt“, `/health` mit Referenz (Prüfzeichen gültig) und der Fassung der Freigabe |
| `tunnel_schluessel` | `service-tunnel.sh … key` | öffentlicher Schlüssel, Referenz |
| `tunnel_adresse` (ohne API) | **wartet auf dich**: Schlüssel im Portal hinterlegen, Adresse eintragen | die Adresse |
| `einloesen` (mit API, statt `tunnel_adresse`) | Einmal-Code holen, die Box löst ihn mit `werkstatt-anmelden` selbst ein (Code über die Standardeingabe): Geräteschlüssel festgehalten (D2), Tunnel-Schlüssel hinterlegt, Adresse zugeteilt, Probe-Fenster offen | Freigabe, Adresse, Probe-Fenster, sha256 des Geräteschlüssels; der Code nie |
| `tunnel` | `service-tunnel.sh … <adresse>`, dann `status` | Handshake, „SSH 2222 ausserhalb der Tunnel: abgewiesen“, Abholer mit gültiger Antwort, ein dauerhafter Schlüssel |
| `lan` | LAN auf das LAN-Netz (Entscheid 6a), Weg über die Brücke dort, Neustart | LAN-Netz |
| `neustart` | Neustart-Probe unter der neuen Adresse | derselbe Host-Schlüssel, dieselbe Referenz, Startdienste, ein dauerhafter Schlüssel, frischer Handshake |
| `probe` | mit Techniker-Zugang: der Dienst meldet sich durch den Tunnel an (WireGuard im Prozess), liest den Host-Schlüssel, schließt das Probe-Fenster, der neue Versuch endet mit „Connection timed out“; sonst **wartet auf dich**: Probe im Fenster im Portal (Werkstatt-Regel 4–6), dann `eingabe probe erledigt` | Host-Schlüssel durch den Tunnel und im LAN, Box-Log zu Anmeldung und Ende, der abgewiesene Versuch (bzw. deine Bestätigung) |
| `internet_weg` | Werkstatt-Internet wieder aus der Netz-Einstellung | kein Gateway, kein DNS über die Brücke |
| `uebergabe` | Belege für die Abnahme, je Prüfung der Werkstatt-Regel; mit API schließt der Dienst vorher das Probe-Fenster der Einlösung und schreibt die Abnahme selbst (`quelle: dienst`, Passwort nur verschlüsselt) | Host-Schlüssel, Fassung, Tunnel-Adresse, LAN-Netz, die acht Prüfungen, mit API die Kennung der Abnahme |

Bei dir bleiben in V1a: die Tunnel-Adresse aus dem Portal eintragen, die Probe im Fenster der Fernwartung (der
Lauf wartet darauf, bevor er den Weg über die Brücke entfernt: ohne ihn steht der Tunnel in der Werkstatt nicht
mehr), das Fenster schließen und die Abnahme im Portal mit diesen Belegen ([Runbook](docs/runbook.md#eine-box-einrichten)).
Hält ein Lauf an, nennt die Werkstatt-Anzeige den Grund und – wo nötig – den Handgriff (Box zur Seite legen,
Startlader). Eine Box, deren Lauf zu Ende ist, fasst der Dienst erst wieder an, wenn sie abgezogen war; eine Box
unter dem LAN-Netz nie.

Release-Anhänge einer Edge-Light-Fassung (unter `edge_light.quelle` der Freigabe; `edge-light/scripts/release.sh`
baut sie, dazu `sha256sums` und `freigabe-edge-light.json`, den fertigen Block `edge_light` für die Mango):

| Anhang | Inhalt | Prüfsumme in der Freigabe |
|---|---|---|
| `vp-edge-light-linux-<bauart>` | das Programm, wie `edge-light/dist/` (`mipsle` für die Mango) | `programm_sha256` |
| `edge-light-openwrt.tar.gz` | `edge-light/openwrt/` als `openwrt/…` (`install.sh`, `service-tunnel.sh`, `files/`) | `skripte_sha256` |

## Was der Dienst nie tut

- das Netz absuchen: Die Brücke fragt nur nach den festen Box-Adressen ihres Werkstatt-Anschlusses (192.168.8.1,
  192.168.1.1, das LAN-Netz), je zwei ARP-Anfragen;
- Passwörter raten, ein eingerichtetes Gerät anfassen, zwei Geräte am Werkstatt-Anschluss bedienen;
- ohne Freigabe oder ohne den Beleg des vorigen Schritts weitermachen;
- ein Root-Passwort an eine Route geben oder in einen Beleg schreiben (Entscheid WI-6 A: nur verschlüsselt für den
  age-Schlüssel „Box-Passwörter“, ab P5).

Er hat keinen `platform-admin`-Zugang und in V1a gar keinen Zugang zur API.

## Konfiguration

Aus der Umgebung (ConfigMap `werkstatt-dienst-konfig`), Schlüssel aus Dateien (Secret).

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `VP_WERKBANK_ADRESSE` | – (Pflicht) | Adresse der Brücke im Netz (`host` oder `host:port`), feste Adresse im Router |
| `VP_WERKBANK_HOSTSCHLUESSEL` | leer | Fingerabdruck `SHA256:…` des Host-Schlüssels der Brücke; leer: beim ersten Kontakt festhalten (`werkbank-hostschluessel.pub` im Datenverzeichnis) |
| `VP_WERKBANK_SSH_QUELLEN` | `192.168.178.241,…242,…243` | von wo die Brücke SSH annimmt (IPv4 oder Netz bis /16), Komma-Liste |
| `VP_WERKBANK_NETZ` | `wlan0` | Schnittstelle der Brücke ins Netz |
| `VP_WERKBANK_ANSCHLUSS` | `eth0` | Werkstatt-Anschluss der Brücke (Netzwerkbuchse) |
| `VP_WERKBANK_EINRICHTEN_BENUTZER` | `vpwerkstatt` | Benutzer, den der Raspberry Pi Imager angelegt hat (nur fürs erste Einrichten) |
| `VP_WERKSTATT_LAN_NETZ` | `10.213.0.1/24` | LAN, auf das eine Box gestellt wird (Entscheid 6a, Regeln wie `LanNetz.java`, dazu genau /24); die Brücke nimmt dort die `.2` |
| `VP_WERKSTATT_PASSWORT_EMPFAENGER` | – (Pflicht) | öffentlicher age-Schlüssel „Box-Passwörter“ (`age1…`, WI-6 A) |
| `VP_WARTUNG_PUBKEY` | – (Pflicht) | öffentlicher Schlüssel des Wartungsservers (Portal, Fernwartung) |
| `VP_WARTUNG_ENDPUNKT` | leer | Endpunkt des Wartungsservers; leer: Vorgabe von `service-tunnel.sh` (`wartung.voltpilot.de`) |
| `VP_WARTUNG_BOX_NETZ` | `10.10.16.0/20` | aus diesem Netz kommt die Tunnel-Adresse |
| `VP_WERKSTATT_DNS` | `9.9.9.9,1.1.1.1` | DNS für das Werkstatt-Internet der Box (öffentlich) |
| `VP_WERKSTATT_EDGE_BAUART` | `mipsle` | Bauart des Programms (Mango) |
| `VP_WERKSTATT_STEUERUNG` | `/tmp/vp-werkstatt-dienst.sock` | Unix-Socket für Eingaben (`vp-werkstatt-dienst eingabe`) |
| `VP_WERKSTATT_ARBEIT` | `/tmp/vp-werkstatt` | Arbeitsverzeichnis der Läufe (Skriptstand, Durchreiche) |
| `VP_WERKSTATT_GEHEIM` | `/etc/vp-werkstatt/geheim` | Verzeichnis mit `werkbank-status`, `werkbank-weiterleitung`, `werkbank-pflege` (Pflicht), `werkbank-einrichten` (nur fürs erste Einrichten) und `download-token` (optional: Lese-Token für die Release-Anhänge auf git.tecmaxx.de) |
| `VP_WERKSTATT_NOTFALL_PUB` | – (Pflicht) | öffentlicher Notfall-Schlüssel (Datei) |
| `VP_WERKSTATT_FREIGABE` | `/etc/vp-werkstatt/freigabe/freigabe.json` | die Freigabe als Datei (V1a); fehlt die Datei, läuft keine |
| `VP_WERKSTATT_API_URL` | leer | Portal-API (V1): gesetzt, liest der Dienst die laufende Freigabe dort (`GET /api/v1/werkstatt-dienst/freigabe`) statt aus der Datei |
| (Ansicht ans Portal) | – | mit `VP_WERKSTATT_API_URL` meldet der Dienst jeden Takt seine Ansicht (`PUT /api/v1/werkstatt-dienst/ansicht`, [Vertrag](../../docs/contracts/werkstatt-ansicht-v1.md)) für die Werkstatt-Bildschirme; ein Fehler dabei hält nichts an und steht einmal im Log |
| `VP_WERKSTATT_TOKEN_URL` | – (Pflicht mit API) | Token-Endpunkt von Keycloak (`…/realms/voltpilot/protocol/openid-connect/token`) |
| `VP_WERKSTATT_TECHNIKER_ADRESSE` | leer | Probe über den Tunnel (V1, nur mit API): Adresse des Techniker-Zugangs „Werkstatt-Dienst“ im Techniker-Netz; dazu `techniker-wireguard` und `techniker-ssh` im Geheimnis-Verzeichnis (`vp-werkstatt-dienst techniker-schluessel <dir>` erzeugt sie). Leer: die Probe bleibt ein Handgriff |
| `VP_WERKSTATT_CLIENT_ID` | `voltpilot-werkstatt-dienst` | Dienstkonto (client_credentials, Rolle `werkstatt-dienst`); Secret als `keycloak-client-secret` im Geheimnis-Verzeichnis |
| `VP_WERKSTATT_DATEN` | `/var/lib/vp-werkstatt-dienst` | Protokolle, Host-Schlüssel der Brücke (PVC) |
| `VP_WERKSTATT_HTTP` | `:8100` | Betriebsseite |
| `VP_WERKSTATT_ANZEIGE` | `127.0.0.1:8101` | Werkstatt-Anzeige, nur eine Loopback-Adresse |
| `VP_WERKSTATT_TAKT` | `10s` | Takt der Schleife (2 s bis 5 min) |
| `VOLTPILOT_LOGGING_FORMAT` | `text` | `json`: eine JSON-Zeile je Ereignis |

Befehle: `vp-werkstatt-dienst dienst` (Vorgabe), `werkbank` (Brücke einmal einrichten bzw. prüfen, Status als
JSON), `eingabe <name> <wert>` (an den laufenden Lauf, etwa `eingabe tunnel_adresse 10.10.16.5`), `pruefe-konfig`,
`fassung`.

## Betriebsvertrag

Wie [docs/k8s-readiness.md](../../docs/k8s-readiness.md):

- Liveness `GET :8100/health`, Readiness `GET :8100/ready` (die Schleife läuft; beim Beenden 503). Eine fehlende
  Brücke macht den Pod nicht unbereit: Er hat keinen Verkehr anzunehmen, er zeigt den Grund.
- Genau ein Replikat (eine Brücke, ein Werkstatt-Anschluss, Protokolle auf einem RWO-Volume), `Recreate`.
- Logs auf stdout; mit `VOLTPILOT_LOGGING_FORMAT=json` die Felder `@timestamp`, `level`, `logger`, `message` und
  `request_id` (die Kennung des Laufs; fehlt ohne Lauf). Weitere Angaben stehen als `schluessel=wert` in `message`.
  Ein Zustandswechsel (Brücke bereit/nicht bereit, Freigabe) steht einmal im Log, nicht je Takt.
- Metriken ohne Referenz, MAC oder Adresse als Label:

| Metrik | Bedeutung |
|---|---|
| `vp_werkstatt_werkbank_bereit` | 1, wenn die Brücke eingerichtet ist und ihr Status passt |
| `vp_werkstatt_werkbank_status_alter_seconds` | seit dem letzten gelesenen Status; **fehlt, solange keiner gelesen wurde** |
| `vp_werkstatt_werkbank_kabel`, `vp_werkstatt_werkbank_geraete` | Kabel am Werkstatt-Anschluss; Geräte (MACs), die an den Box-Adressen antworten; fehlen ohne Status |
| `vp_werkstatt_werkbank_einrichten_total{ergebnis}` | Einrichten und Pflegen der Brücke (`ok`, `fehler`) |
| `vp_werkstatt_freigabe_laufend` | 1, solange eine Freigabe läuft |
| `vp_werkstatt_lauf_aktiv`, `vp_werkstatt_laeufe_total{ergebnis}` | Lauf an einer Box; beendete Läufe (`fertig`, `angehalten`) |
| `vp_werkstatt_lauf_wartet` | 1, solange ein Lauf auf deine Eingabe wartet (Tunnel-Adresse) |
| `vp_werkstatt_schritt_letzte_dauer_seconds{schritt}` | Dauer des letzten belegten Schritts dieser Art (PS-3) |
| `vp_werkstatt_info{fassung}` | Fassung des Dienstes |

## Prüfen

```sh
cd services/werkstatt-dienst
go vet ./... && go test -race ./...     # Go 1.24; ohne Docker, ohne Netz
test/bruecke-probe.sh                   # Brücke im Container: einrichten.sh, nftables, OpenSSH, echtes Programm
test/dienst-container-probe.sh          # Dienst-Bild unter PodSecurity restricted
test/box-probe.sh                       # ganzer Lauf ab frischem OpenWrt: echtes OpenWrt, Brücke, Wartungsserver, Skripte
```

Die Go-Tests sprechen nur mit Attrappen im Prozess (`internal/attrappe`: SSH-Server, die sich wie die Brücke und
wie eine Mango ab Werk bis zur Neustart-Probe verhalten, dazu Attrappen der beiden Skripte). Die Box-Probe fährt
einen ganzen Lauf ab frischem OpenWrt gegen ein echtes OpenWrt 25.12.5 (x86-64) mit den echten Skripten und einem
echten Wartungsserver (`vp-tunnel-dienst`); die GL-Werksfirmware und `sysupgrade` gibt es nur in der Attrappe. Die Brücken-Probe braucht Docker mit `--privileged` (Netz-Namensräume im Container) und baut ein
Debian-trixie-Bild; beide Proben räumen ihre Bilder wieder weg. Am echten Gerät ersetzen sie nichts: Prüfsteine
PS-11 bis PS-13 im [Runbook](docs/runbook.md#prüfsteine-am-echten-gerät).
