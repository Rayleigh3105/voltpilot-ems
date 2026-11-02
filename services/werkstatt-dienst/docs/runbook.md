# Runbook: Werkstatt-Dienst

Betrieb des [Werkstatt-Dienstes](../README.md) im Cluster (Namespace `werkstatt-prod`) und der
[Werkbank-Brücke](../bruecke/README.md). Stand V1a: Brücke, Freigabe, Anzeige und der Lauf an der Mango von der
Werksfirmware bis zur Neustart-Probe. Die drei Griffe der Fernwartung und die Abnahme machst du noch im Portal.

Alle Befehle mit `kubectl` laufen am Rechner des Betreibers gegen das Produktionscluster.

## Einmal einrichten

Reihenfolge: Schlüssel → Brücke → gitops → Sync → prüfen. Danach nie wieder, außer ein Schlüssel wird getauscht.

### Schlüssel

Vier SSH-Schlüssel, jeder für eine Aufgabe; die privaten Teile liegen nur im Cluster (SOPS), nie auf der Brücke.

```sh
mkdir -m 700 werkstatt-schluessel && cd werkstatt-schluessel
for k in werkbank-status werkbank-weiterleitung werkbank-pflege werkbank-einrichten; do
  ssh-keygen -t ed25519 -N '' -C "werkstatt-dienst-$k" -f "$k"
done
```

| Schlüssel | darf auf der Brücke | wohin |
|---|---|---|
| `werkbank-status` | nur `vp-werkbank-status` | Secret |
| `werkbank-weiterleitung` | nur Verbindungen zu 192.168.8.1:22/80, 192.168.1.1:22/80, 10.213.0.1:22/8484 | Secret |
| `werkbank-pflege` | nur ein Paket mit genannter Prüfsumme einspielen | Secret |
| `werkbank-einrichten` (Werkstatt-Schlüssel) | als Benutzer des Imagers das erste Einrichten | öffentlicher Teil in den Imager, privater ins Secret |

Die öffentlichen Teile der ersten drei braucht niemand von Hand: Der Dienst leitet sie ab und schreibt sie beim
Einrichten auf die Brücke. Dazu kommt der öffentliche Notfall-Schlüssel (`voltpilot-notfall.pub` aus der
Passwortablage, Entscheid K2 a) als einziger Schlüssel mit Shell auf der Brücke.

### Brücke aufstellen

Siehe [bruecke/README.md](../bruecke/README.md): Karte mit dem Raspberry Pi Imager schreiben, Pi ins WLAN, feste
Adresse im Router. Diese Adresse kommt in `VP_WERKBANK_ADRESSE` (ConfigMap) und in die NetworkPolicy.

### Keycloak

Ab V1 liest der Dienst die Freigabe aus der API (`VP_WERKSTATT_API_URL`), und später holt er dort Einmal-Codes und
legt Abnahmen ab. Dafür braucht er ein Dienstkonto im Muster von `voltpilot-tunnel-dienst`. Der Realm-Import
(`infra/prod/keycloak/voltpilot-realm.json`) bringt Rolle, Client und Dienstkonto mit, den Client **abgeschaltet**;
im bestehenden Live-Realm `voltpilot` legst du sie von Hand an (der Import fasst ein bestehendes Realm nicht an).
Ohne `VP_WERKSTATT_API_URL` bleibt der Dienst bei der Datei (V1a) und braucht das Konto nicht. Mit ihr muss der Pod
Portal und Keycloak erreichen: über die öffentliche Adresse deckt das die HTTPS-Regel der NetworkPolicy, solange die
Adresse nicht in ein privates Netz auflöst; sonst die auskommentierte Regel für den Weg im Cluster einsetzen
(`deploy/gitops/apps/werkstatt/base/networkpolicy.yaml`).

| Einstellung | Wert |
|---|---|
| Client ID | `voltpilot-werkstatt-dienst` |
| Name | VoltPilot Werkstatt-Dienst |
| Client authentication | an (vertraulich) |
| Standard flow, Implicit, Direct access grants | aus |
| Service accounts (client_credentials) | an |
| Redirect URIs, Web origins | leer |
| Rolle des Dienstkontos | Realm-Rolle `werkstatt-dienst` (neu anlegen), **nicht** `platform-admin` |

Das Client-Secret kommt als `keycloak-client-secret` in das SOPS-Secret. Die Rolle erreicht nur den Baum
`/api/v1/werkstatt-dienst/**`: die laufende Freigabe lesen, Einmal-Codes nur in einer laufenden Freigabe für
ungekoppelte Boxen holen, lesen, was eine Box beim Einlösen gemeldet hat, das Probe-Fenster einer Einlösung
schließen, die Abnahme mit Belegen schreiben (`POST /api/v1/werkstatt-dienst/abnahmen/{ref}`) und jeden Takt seine
Ansicht für die Werkstatt-Bildschirme melden (`PUT /api/v1/werkstatt-dienst/ansicht`). Nie: freigeben,
Fenster öffnen, Kunden, Kopplung, Updates, `/api/v1/admin/**`.

### Techniker-Zugang „Werkstatt-Dienst“

Die Einlösung einer Box öffnet 30 Minuten Probe-Fenster für **einen** Techniker-Zugang: den des Dienstes (WI-5).
Ohne ihn gibt die API keine Einmal-Codes aus (409 „kein Techniker-Zugang eingerichtet“).

1. Die Schlüssel einmal erzeugen, auf deinem Rechner oder in einem Wegwerf-Container mit dem Image des Dienstes:
   `vp-werkstatt-dienst techniker-schluessel /tmp/techniker`. Der Befehl schreibt `techniker-wireguard` und
   `techniker-ssh` (RSA 3072, nie überschrieben) und zeigt die öffentlichen Teile.
2. Im Portal unter Fernwartung einen Techniker-Zugang „Werkstatt-Dienst“ anlegen, mit diesen öffentlichen Schlüsseln.
3. Seine UUID bekommt die API als `VP_WERKSTATT_TECHNIKER_ZUGANG` (`voltpilot.werkstatt.techniker-zugang`), seine
   Adresse im Techniker-Netz der Dienst als `VP_WERKSTATT_TECHNIKER_ADRESSE`; die beiden Dateien kommen ins
   SOPS-Secret und danach vom Rechner weg.

Mit allen drei Teilen macht der Dienst die Probe selbst: Er meldet sich durch den Tunnel als dieser Zugang an,
liest den Host-Schlüssel dort, schließt das Probe-Fenster und prüft, dass der neue Versuch mit „Connection timed
out“ endet; das Log der Box nennt Anmeldung und Ende. WireGuard läuft dabei im Prozess (ohne `NET_ADMIN`), der Pod
braucht nur UDP 51820 nach draußen (NetworkPolicy). Ohne sie bleibt die Probe ein Handgriff im Portal.

### gitops

Die Entwürfe liegen unter [deploy/gitops/](../deploy/gitops/README.md) in der Form des gitops-Repos. Dort von
Hand übernehmen und mergen (nur der Betreiber merged gitops):

1. `apps/werkstatt/` kopieren; in `overlays/prod/kustomization.yaml` `newTag` auf den Commit des Laufs
   „Werkstatt-Dienst“ setzen (`.forgejo/workflows/werkstatt-dienst.yaml`).
2. `VP_WERKBANK_ADRESSE` in `base/configmap.yaml` und die Adresse in `base/networkpolicy.yaml` auf die feste
   Adresse der Brücke setzen; den Namespace des Monitorings in der NetworkPolicy prüfen.
3. Secret: Vorlage kopieren, die vier privaten Schlüssel einsetzen, `sops --encrypt --in-place`, einchecken.
4. `werkstatt-dienst-oeffentlich.yaml`: den öffentlichen Notfall-Schlüssel einsetzen.
5. Pull-Secret der Forgejo-Registry wie in `voltpilot-prod` auch in `werkstatt-prod` anlegen (Name im Deployment:
   `forgejo-registry`).
6. `clusters/prod/project.yaml`: Ziel `werkstatt-prod` unter `spec.destinations` (Ausschnitt in
   `clusters/prod/appproject-ziel.yaml`); `clusters/prod/werkstatt-application.yaml` mit der Adresse des
   gitops-Repos.
7. In Argo CD die Application `werkstatt-prod` von Hand synchronisieren.

### Prüfen

```sh
kubectl -n werkstatt-prod logs deploy/werkstatt-dienst | grep -E 'Brücke|Freigabe'
kubectl -n werkstatt-prod port-forward deploy/werkstatt-dienst 8101:8101   # dann http://localhost:8101
```

Nach dem ersten Takt: „Host-Schlüssel der Brücke beim ersten Kontakt festgehalten“, „Brücke erstmals
eingerichtet“, „Brücke bereit“. Die Anzeige zeigt die Fassung, das Kabel am Werkstatt-Anschluss und wer dort
antwortet. Danach darf `werkbank-einrichten` aus dem Secret wieder heraus.

## Eine Box einrichten

Je Mango (die Werkstatt ist freigegeben, die Brücke bereit):

1. Mango aus dem Karton: das orange Kabel WERKSTATT in ihre Buchse **LAN**, Strom. Die Buchse WAN bleibt frei.
2. Den Lauf zeigt das Portal unter **Geräte › Werkstatt › An der Werkbank** (mit der API, siehe 3), mit allen
   Belegen die Anzeige des Dienstes (`kubectl -n werkstatt-prod port-forward deploy/werkstatt-dienst 8101:8101`,
   dann http://localhost:8101). OpenWrt aufspielen und Neustart dauern einige Minuten (PS-3).
3. **Mit der API** (`VP_WERKSTATT_API_URL` gesetzt) entfällt dieser Schritt: Der Dienst holt einen Einmal-Code, die
   Box löst ihn mit `werkstatt-anmelden` selbst ein (Schritt `einloesen`). Die API hält dabei ihren Geräteschlüssel
   fest, hinterlegt ihren Tunnel-Schlüssel und teilt die Adresse zu. Weiter mit 4.

   **Ohne API (V1a):** Steht dort **„Dein Schritt“** (Lauf wartet, Metrik `vp_werkstatt_lauf_wartet`): im Portal unter
   **Geräte › Fernwartung › Tunnel-Schlüssel hinterlegen** Referenz und Schlüssel aus der Anzeige eintragen; die
   zugeteilte Adresse dann dem Dienst geben:

   ```sh
   kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe tunnel_adresse 10.10.16.5
   ```

   Der Dienst prüft die Adresse (Box-Netz `10.10.16.0/20`) und macht weiter: Tunnel, LAN, Neustart-Probe.
4. Steht wieder **„Dein Schritt“** (Probe im Fenster): im Portal unter **Geräte › Fernwartung** für die Box ein
   Fenster mit dem Grund „Werkstatt-Probe“ für deinen Zugang öffnen, dich durch den Tunnel anmelden, den Host-Schlüssel lesen und mit dem der
   Anzeige vergleichen, das Fenster schließen und den abgewiesenen Versuch machen. Dann:

   ```sh
   kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe probe erledigt
   ```

   Erst danach nimmt der Dienst den Weg über die Brücke wieder heraus; ohne ihn steht der Tunnel in der Werkstatt
   nicht mehr (beim Kunden kommt er über WAN). Mit der API schließt der Dienst danach auch das Probe-Fenster, das
   die Einlösung für seinen Techniker-Zugang geöffnet hat. **Ist der Techniker-Zugang eingerichtet** (siehe oben),
   entfällt dieser Schritt ganz: Der Dienst macht die Probe selbst.
5. Ist der Lauf **fertig**: **Mit der API** schreibt der Dienst die Abnahme selbst (Schritt `uebergabe`: je Prüfung
   der Beleg, das Passwort verschlüsselt, LAN-Netz; im Portal unter Werkstatt mit `quelle: dienst`). **Ohne API:**
   Ein Formular für die Abnahme von Hand hat das Portal nicht mehr; sie geht nur über die Routen der Werkstatt
   ([Routen](../../../docs/werkstatt.md#routen): Box aufnehmen, LAN-Netz, Abnahme) mit den Belegen des Laufs.
6. Passwort in die Passwortablage: Beleg `passwort_age` des Schritts `passwort` (Protokoll unter
   http://localhost:8101/laeufe/<lauf>.json) in eine Datei, dann `age -d -i <dein Schlüssel> passwort.age`.
7. Abziehen. Gehäuse: Mit Gehäuse-Bau liegt die Druckdatei nach ein paar Minuten in der Anzeige
   ([Gehäuse-Druckdatei](#gehäuse-druckdatei)), sonst wie bisher `bauen.sh --referenz <referenz>`. Drucken,
   einsetzen; die Box bleibt „nicht versenden“ bis Stufe 2 (Entscheid 5c).

Steckt eine Mango schon mit frischem OpenWrt am Kabel (192.168.1.1, root ohne Passwort), beginnt der Lauf dort.

**Handgriffe, wenn ein Lauf anhält** (die Anzeige nennt Grund und Handgriff):

| Grund | Handgriff |
|---|---|
| mehrere Geräte am Werkstatt-Anschluss | nur eine Mango an das orange Kabel |
| die Mango verlangt ein Passwort / root hat ein Passwort / schon Edge Light | abziehen, zur Seite legen; neu aus dem Karton: Reset-Knopf 10 s halten, erneut einstecken |
| kein GL-MT300N-V2, keine GL-Firmware | abziehen, zur Seite legen |
| die Werksfirmware nimmt das Abbild nicht an (`sysupgrade -T`) | Startlader (M4): Reset halten und Strom stecken, bis die Leuchte fünfmal blinkt; am Rechner 192.168.1.2, http://192.168.1.1, Abbild der Freigabe hochladen; danach mit frischem OpenWrt an das orange Kabel |
| kein Internet über die Brücke (PS-12) | WLAN und Router der Brücke prüfen, dann abziehen und neu einstecken |
| `einloesen`: das Portal hat abgewiesen, `schluessel_festgehalten` | die Box wurde neu aufgespielt oder ist eine andere unter derselben Kennung: abziehen, zur Seite legen; einen Tausch gibt es nur ausdrücklich und solange sie ungekoppelt ist |
| `einloesen`: nicht freigegeben, Obergrenze, gekoppelt | Freigabe prüfen bzw. neu erteilen; eine gekoppelte Box bekommt keinen Code |
| der Dienst wurde mitten im Lauf neu gestartet | abziehen, zur Seite legen: der Stand der Box ist unbekannt; ein gesetztes Passwort steht in `passwort_age` |

Nach jedem Ende (fertig oder angehalten) fasst der Dienst dieselbe Box erst wieder an, wenn sie abgezogen war. Eine
Box unter dem LAN-Netz (10.213.0.1) ist eingerichtet und wird nie angefasst.

## Fassungen der Freigabe

Der Dienst legt die drei Dateien der Freigabe nach Prüfsumme im Datenverzeichnis ab
(`/var/lib/vp-werkstatt-dienst/fassungen/<sha256>`) und lädt sie nur, wenn sie dort fehlen: das OpenWrt-Abbild von
`openwrt.quelle`, Programm und Skriptstand von `edge_light.quelle` (Anhänge: README, „Release-Anhänge“). Eine Datei
mit anderer Prüfsumme benutzt er nie. Ist das Release-Repo privat, gehört ein Lese-Token als `download-token` ins
Secret (nur an git.tecmaxx.de geschickt). Ohne Internet für den Pod: die Dateien von Hand ablegen,

```sh
kubectl -n werkstatt-prod cp ./vp-edge-light-linux-mipsle werkstatt-dienst-<pod>:/var/lib/vp-werkstatt-dienst/fassungen/<sha256>
```

Eine neue Edge-Light-Fassung: in Forgejo den Lauf **„Edge-Light-Fassung“** von Hand starten (legt den Tag
`edge-light-JJJJ.MM.N` an, nächste freie Nummer des Monats) oder den Tag selbst anlegen und pushen. Der Tag-Lauf prüft
Edge Light, baut und hängt `vp-edge-light-linux-mipsle`, `vp-edge-light-linux-arm64`, `edge-light-openwrt.tar.gz`,
`sha256sums` und `freigabe-edge-light.json` an das Release. Den Inhalt von `freigabe-edge-light.json` als Block
`edge_light` in die Freigabe übernehmen; dazu das OpenWrt-Abbild mit seiner Prüfsumme aus `sha256sums` von
downloads.openwrt.org. Ohne Forgejo-Lauf geht dasselbe lokal: `edge-light/scripts/release.sh <fassung> <ausgabe>`.

## Werkstatt freigeben

**Mit der API (V1, `VP_WERKSTATT_API_URL` gesetzt):** Die Freigabe liegt im Portal. „Werkstatt freigeben“ ist
`POST /api/v1/admin/werkstatt/freigaben` (nur `platform-admin`; Fassungen, Tage, Obergrenze, siehe OpenAPI), „Freigabe
beenden“ `POST /api/v1/admin/werkstatt/freigaben/<kennung>/ende`; die Knöpfe stehen unter **Geräte › Werkstatt**.
Ins Feld „Edge Light“ kommt der Block `edge_light` aus `freigabe-edge-light.json` der Fassung, die Prüfsumme des
OpenWrt-Abbilds aus `sha256sums` der OpenWrt-Fassung. Je Box-Art läuft höchstens eine Freigabe; eine neue verlangt, die laufende erst zu
beenden. Der Dienst fragt die laufende Freigabe je Takt ab.

**Ohne API (V1a):** Die Freigabe ist eine Datei (`freigabe.json`) in der ConfigMap `werkstatt-freigabe`. Sie steht
bewusst nicht im gitops-Repo: Argo CD verwaltet sie nicht und setzt sie nicht zurück. Vorlage:
[deploy/freigabe.beispiel.json](../deploy/freigabe.beispiel.json).

```sh
# Werkstatt freigeben (Fassungen und Prüfsummen aus dem Release eintragen)
kubectl -n werkstatt-prod create configmap werkstatt-freigabe \
  --from-file=freigabe.json=./freigabe.json --dry-run=client -o yaml | kubectl apply -f -

# Freigabe beenden (sofort; alternativ beendet_am in der Datei setzen)
kubectl -n werkstatt-prod delete configmap werkstatt-freigabe
```

- Eine Freigabe gilt für jede Box, die du bis `gueltig_bis` einsteckst, eine nach der anderen; `obergrenze` ist nur
  ein Schutz. Höchstens 92 Tage.
- Neue Programm-Fassung: neue Freigabe mit neuer `kennung`. Jede Box behält im Protokoll, unter welcher Freigabe
  sie entstand.
- Eine Änderung der ConfigMap kommt nach rund einer Minute im Pod an; der Dienst liest die Datei je Takt neu.
- Unbekannte Felder oder falsche Prüfsummen-Formen lehnt der Dienst ab („Freigabe nicht lesbar“ im Log und in der
  Anzeige); dann läuft keine Freigabe.

## Gehäuse-Druckdatei

Nach der Übergabe bestellt der Lauf die Druckdatei des Gehäuses (Schritt 19, P10): Unterteil mit Referenz und
QR-Code, dazu der Deckel, gebaut und geprüft vom Gehäuse-Programm (`bauen.sh --referenz`). Ein Auftrag je Box,
einer zur Zeit; der Lauf wartet nicht darauf, die nächste Mango darf schon stecken. Im Cluster startet der Dienst
je Auftrag einen Job mit dem Bau-Image. Den Druck startest du (WI-11 A).

**Einmal einrichten:**

1. Lauf „Werkstatt-Gehäuse-Bild“ (`.forgejo/workflows/werkstatt-gehaeuse-bild.yaml`) von Hand starten. Er baut
   das Bau-Image (Debian 13, Gehäuse-Programm, Bambu Studio, nur amd64), fährt einen Auftrag für die
   Probe-Referenz wie der Job (`test/gehaeuse-bild-probe.sh`), schiebt es und nennt am Ende
   `VP_GEHAEUSE_IMAGE=…/werkstatt-gehaeuse@sha256:…`.
2. gitops ([Entwurf](../deploy/gitops/README.md)): `base/pvc-gehaeuse.yaml` und `base/rbac-gehaeuse.yaml`
   übernehmen; im Deployment `automountServiceAccountToken: true` und das Volume `gehaeuse`; in der
   NetworkPolicy den Weg zur Kubernetes-API (die Adressen aus `kubectl get endpoints kubernetes`, Port 6443) und
   die Policy `werkstatt-gehaeuse` (Bau-Pods ohne Netz); in der ConfigMap `VP_GEHAEUSE_BAU: "kubernetes"` und
   `VP_GEHAEUSE_IMAGE` mit dem Digest aus 1.
3. Sync, dann prüfen:

   ```sh
   kubectl -n werkstatt-prod logs deploy/werkstatt-dienst | grep 'Gehäuse-Bau bereit'
   kubectl -n werkstatt-prod auth can-i create jobs --as=system:serviceaccount:werkstatt-prod:werkstatt-dienst   # yes
   kubectl -n werkstatt-prod auth can-i create pods --as=system:serviceaccount:werkstatt-prod:werkstatt-dienst   # no
   ```

4. Erster Auftrag mit der Probe-Referenz, zugleich der Probedruck PS-9:
   `kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst gehaeuse edge-wrk7abg`.

**Je Box:** In der Anzeige unter „Gehäuse“ geht der Auftrag auf `wartet`, `baut`, `fertig`. Dann
`gehaeuse-<referenz>.3mf` herunterladen (Unterteil mit Kennung und Deckel auf einer Platte; nur das Unterteil:
`unterteil-<referenz>.3mf`), in Bambu Studio öffnen und am P1S drucken: Filament 1 weiß, 2 schwarz, 3 hellblau
([Druckanleitung](../../../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/drucken.md)). Mango einsetzen, den
QR-Code mit dem Telefon lesen. Der Bericht `pruefung.md` liegt daneben. Eine gescheiterte Datei bietet die Anzeige
nicht an, nur Bericht und `ausgabe.log`.

Noch einmal bauen (Nachdruck, nach einem behobenen Fehler):
`kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst gehaeuse <referenz> neu`; für eine
Box ohne Lauf dasselbe ohne `neu`.

| Grund in der Anzeige | Was | Tun |
|---|---|---|
| „Bau-Image: ErrImagePull …“ | Digest falsch oder Pull-Secret `forgejo-registry` fehlt | `VP_GEHAEUSE_IMAGE` und Pull-Secret prüfen, `… gehaeuse <referenz> neu` |
| „HTTP 403, dem Dienstkonto fehlt das Recht …“ | Role oder RoleBinding `werkstatt-dienst-gehaeuse` fehlt | aus dem gitops-Entwurf übernehmen, Sync |
| „Token des Dienstkontos …“, „Dienstkonto nicht eingehängt“ | `automountServiceAccountToken` steht auf `false` | im Deployment auf `true` |
| „nicht in 20m fertig (zuletzt: Pod nicht eingeplant …)“ | Der Knoten der PVC ist nicht amd64 oder hat keinen Platz | local-path bindet die Ablage an den Knoten des Dienstes; Dienst auf einen amd64-Knoten |
| „Job gescheitert (BackoffLimitExceeded)“ und Fehler aus dem Bericht | Eine Prüfung des Programms scheiterte (etwa Klarschrift zu breit bei fünf W) | `pruefung.md` und `ausgabe.log` lesen; eine solche Box braucht eine andere Lage ([Kennung](../../../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)) |
| `ausgabe.log` endet mitten im Bau | vermutlich zu wenig Speicher (OOMKilled) | `kubectl -n werkstatt-prod describe job <job>`; `VP_GEHAEUSE_SPEICHER` erhöhen |

Ein Job räumt sich eine Stunde nach dem Ende selbst weg (`ttlSecondsAfterFinished`); bricht ein Auftrag ab oder
endet der Dienst, löscht der Dienst den Job, damit nie zwei zugleich bauen. Nach dem Neustart kommt ein
unterbrochener Auftrag wieder in die Schlange.

## Werkstatt ruht

```sh
kubectl -n werkstatt-prod scale deploy/werkstatt-dienst --replicas=0   # ruhen
kubectl -n werkstatt-prod scale deploy/werkstatt-dienst --replicas=1   # wieder an
```

Dauerhaft: `replicas: 0` im gitops-Repo. Die Protokolle bleiben auf dem Volume.

## Störungen

| Anzeige / Log | Was | Tun |
|---|---|---|
| „Brücke … nicht erreichbar“ | Pod erreicht die Brücke nicht (Strom, WLAN, Adresse, Route vom Cluster-Netz, NetworkPolicy) | Brücke anpingen; PS-11 |
| „Host-Schlüssel der Brücke ist … festgehalten ist …“ | Die Brücke hat einen neuen Host-Schlüssel (Karte neu geschrieben) oder jemand anderes antwortet unter der Adresse | Nur wenn du die Karte neu geschrieben hast: `kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- rm /var/lib/vp-werkstatt-dienst/werkbank-hostschluessel.pub`; sonst nicht verbinden und nachsehen |
| „Brücke nimmt den Status-Schlüssel nicht an und kein Werkstatt-Schlüssel“ | Brücke neu aufgesetzt, `werkbank-einrichten` schon aus dem Secret | Schlüssel wieder ins Secret, Sync |
| „Brücke einrichten gescheitert, nächster Versuch später“ | `einrichten.sh` brach ab; Grund in der Anzeige unter „Zuletzt eingerichtet“ | Grund beheben; der Dienst versucht es nach 10 Minuten wieder, sofort mit `kubectl -n werkstatt-prod rollout restart deploy/werkstatt-dienst` |
| „Brücke nicht bereit: Firewall nicht geladen“ | Tabelle `inet werkbank` fehlt | Der Dienst spielt das Paket neu auf (nach der Pause) |
| „Brücke nicht bereit: WLAN unten“ | WLAN der Brücke | PS-13 |
| „Keine laufende Freigabe“ | keine Datei, abgelaufen, beendet, Obergrenze | Werkstatt freigeben |
| „Mango erkannt, aber die Werkstatt ist nicht freigegeben“ | wie oben | Werkstatt freigeben; der Lauf beginnt im nächsten Takt |
| Lauf hält bei `fassungen` | Datei nicht ladbar oder falsche Prüfsumme | Quelle, Prüfsumme, `download-token` prüfen oder Datei von Hand ablegen (oben) |

Einmal von Hand, ohne Schleife: `kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst werkbank`
(richtet ein bzw. prüft und gibt den Status als JSON aus).

## Alarme (Ausgangspunkte)

```promql
max(vp_werkstatt_werkbank_bereit) == 0                       # Brücke nicht bereit (nur, solange eine Freigabe läuft)
  and max(vp_werkstatt_freigabe_laufend) == 1
max(vp_werkstatt_werkbank_status_alter_seconds) > 300         # kein Status seit 5 Minuten
increase(vp_werkstatt_werkbank_einrichten_total{ergebnis="fehler"}[1h]) > 0
```

## Prüfsteine am echten Gerät

Die Proben (`test/bruecke-probe.sh`) ersetzen keinen echten Pi und keine echte Mango.

| # | Was | Wie |
|---|---|---|
| PS-11 | Erreicht ein Pod die Brücke? | Nach dem Sync: Log „Brücke bereit“. Steht die Brücke in 192.168.0.x und das Cluster in 192.168.178.x, braucht es eine Route zwischen den Netzen; sonst die Brücke ins Netz des Clusters. |
| PS-12 | Internet für die Mango über die Brücke | Ohne Mango schon messbar: einen Rechner per Kabel an die Buchse der Brücke, feste Adresse 192.168.8.10/24, Gateway 192.168.8.2, DNS 9.9.9.9. `curl -sI https://downloads.openwrt.org` antwortet; der Router (`192.168.0.1`) und andere Geräte im Netz antworten nicht. |
| PS-13 | WLAN der Brücke hält | In der Anzeige „Energiesparen aus“. Router kurz neu starten: die Anzeige geht auf „nicht erreichbar“ und nach dem WLAN von selbst wieder auf „Brücke bereit“. |
| PS-1 | Mango ab Werk: SSH als root ohne Passwort (Firmware 3.216 und 4.3.x), Board, `/etc/glversion`, root ohne Passwort | erster echter Lauf: Schritt `erkennen`; vorher mit dem Mac messbar (Mango per Kabel an den Mac, `ssh root@192.168.8.1`). Der Beleg `gl_schnittstelle` hält die Antwort der GL-Schnittstelle fest: ihre Felder sind nicht nachgemessen, entschieden wird darüber noch nichts |
| PS-2 | `sysupgrade -T` und `-n` mit dem 25.12.5-Abbild aus beiden GL-Linien, ohne `-F` | Schritte `openwrt` und `wiedererkennen` an je einer Mango mit 3.216 und 4.3.x |
| PS-3 | Dauer je Schritt | Metrik `vp_werkstatt_schritt_letzte_dauer_seconds`, Beleg `dauer_bis_openwrt`, `dauer_bis_antwort`; Fristen in `mango.VorgabeZeiten` danach stellen |
| PS-4 | Startlader-Hochladen | nur Rückfall (Handgriff M4); ein Hochladen durch den Dienst gibt es noch nicht |
| PS-8 | Gehäuse-Bau im Cluster: Laufzeit und Speicher | Vorgemessen mit `test/gehaeuse-bild-probe.sh` (amd64 emuliert auf einem arm64-Mac, 02.11.2026): 60 s je Auftrag, höchstens 853 MiB, Bericht ohne Fehler. Im Cluster: erster Auftrag (oben, Schritt 4): Dauer in der Anzeige (bestellt bis Ende), Speicher mit `kubectl top pod -l app.kubernetes.io/name=werkstatt-gehaeuse`; `VP_GEHAEUSE_FRIST` und `VP_GEHAEUSE_SPEICHER` danach stellen |
| PS-9 | Liest ein Telefon den gedruckten QR-Code? | Probedruck der Datei aus dem ersten Auftrag; [Kennung, Was nur ein Druck zeigt](../../../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md#was-nur-ein-druck-zeigt) |
