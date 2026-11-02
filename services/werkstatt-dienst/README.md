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
| Freigabe | Dein Okay, Boxen einzurichten: Fassungen (OpenWrt, Edge Light, Skripte, je mit Prüfsumme) und bis wann; gilt für jede Box, die du in der Zeit einsteckst. Ohne laufende Freigabe richtet der Dienst keine Box ein. In V1a eine Datei aus einer ConfigMap. | `internal/freigabe`, [Runbook](docs/runbook.md#werkstatt-freigeben) |
| Werkbank-Brücke | Ein Raspberry Pi im WLAN, seine Netzwerkbuchse ist der Werkstatt-Anschluss (WI-13 B). Kein eigenes Programm, nur Konfiguration; der Dienst richtet sie ein und pflegt sie. | [bruecke/](bruecke/README.md), `internal/werkbank` |
| Anzeige | Betriebsseite für Kubernetes (`/health`, `/ready`, `/metrics`) und die Werkstatt-Anzeige (Brücke, Freigabe, Läufe mit Belegen), die nur im Pod auf Loopback lauscht: `kubectl port-forward`. | `internal/anzeige` |
| Betrieb | gitops-Entwurf (Namespace `werkstatt-prod`, PodSecurity `restricted`, Application mit Sync von Hand, SOPS-Vorlage, NetworkPolicy) und Runbook. | [deploy/gitops/](deploy/gitops/README.md), [docs/runbook.md](docs/runbook.md) |

Stand der Pakete aus dem Konzept (Abschnitt 8): P1 Grundgerüst, P2 Werkbank-Brücke und P11 Betrieb sind gebaut.
Es folgen P3 (Werksfirmware → OpenWrt), P5 (Box einrichten) und P4 (Edge-Light-Fassung je Release). Solange
P3 fehlt, erkennt der Dienst noch keine Box am Werkstatt-Anschluss; er zeigt nur, wer dort antwortet.

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
| `VP_WERKSTATT_LAN_NETZ` | `10.213.0.1/24` | LAN, auf das eine Box gestellt wird (Entscheid 6a); die Brücke nimmt dort die `.2` |
| `VP_WERKSTATT_GEHEIM` | `/etc/vp-werkstatt/geheim` | Verzeichnis mit `werkbank-status`, `werkbank-weiterleitung`, `werkbank-pflege` (Pflicht) und `werkbank-einrichten` (nur fürs erste Einrichten) |
| `VP_WERKSTATT_NOTFALL_PUB` | – (Pflicht) | öffentlicher Notfall-Schlüssel (Datei) |
| `VP_WERKSTATT_FREIGABE` | `/etc/vp-werkstatt/freigabe/freigabe.json` | die Freigabe; fehlt die Datei, läuft keine |
| `VP_WERKSTATT_DATEN` | `/var/lib/vp-werkstatt-dienst` | Protokolle, Host-Schlüssel der Brücke (PVC) |
| `VP_WERKSTATT_HTTP` | `:8100` | Betriebsseite |
| `VP_WERKSTATT_ANZEIGE` | `127.0.0.1:8101` | Werkstatt-Anzeige, nur eine Loopback-Adresse |
| `VP_WERKSTATT_TAKT` | `10s` | Takt der Schleife (2 s bis 5 min) |
| `VOLTPILOT_LOGGING_FORMAT` | `text` | `json`: eine JSON-Zeile je Ereignis |

Befehle: `vp-werkstatt-dienst dienst` (Vorgabe), `werkbank` (Brücke einmal einrichten bzw. prüfen, Status als
JSON), `pruefe-konfig`, `fassung`.

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
| `vp_werkstatt_schritt_letzte_dauer_seconds{schritt}` | Dauer des letzten belegten Schritts dieser Art (PS-3) |
| `vp_werkstatt_info{fassung}` | Fassung des Dienstes |

## Prüfen

```sh
cd services/werkstatt-dienst
go vet ./... && go test -race ./...     # Go 1.24; ohne Docker, ohne Netz
test/bruecke-probe.sh                   # Brücke im Container: einrichten.sh, nftables, OpenSSH, echtes Programm
test/dienst-container-probe.sh          # Dienst-Bild unter PodSecurity restricted
```

Die Go-Tests sprechen nur mit Attrappen im Prozess (`internal/attrappe`: ein SSH-Server, der sich wie die Brücke
verhält). Die Brücken-Probe braucht Docker mit `--privileged` (Netz-Namensräume im Container) und baut ein
Debian-trixie-Bild; beide Proben räumen ihre Bilder wieder weg. Am echten Gerät ersetzen sie nichts: Prüfsteine
PS-11 bis PS-13 im [Runbook](docs/runbook.md#prüfsteine-am-echten-gerät).
