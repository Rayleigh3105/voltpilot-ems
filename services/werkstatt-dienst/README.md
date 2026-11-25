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
| Freigabe | Welche Fassungen (OpenWrt, Edge Light, Skripte, je mit Prüfsumme) der Dienst aufspielt. Ohne laufende Freigabe richtet er keine Box ein. Mit der API legt das Portal sie selbst an: die Werkstatt nimmt immer die neueste signierte Fassung, bis jemand sie anhält (`werkstatt_freigabe`, gelesen über das Dienstkonto); ohne API eine Datei aus einer ConfigMap. | `internal/freigabe`, `internal/apikonto`, [Runbook](docs/runbook.md#werkstatt-anhalten-und-fortsetzen) |
| Werkbank-Brücke | Ein Raspberry Pi im WLAN, seine Netzwerkbuchse ist der Werkstatt-Anschluss (WI-13 B). Kein eigenes Programm, nur Konfiguration; der Dienst richtet sie ein und pflegt sie. | [bruecke/](bruecke/README.md), `internal/werkbank` |
| Anzeige | Betriebsseite für Kubernetes (`/health`, `/ready`, `/metrics`) und die Werkstatt-Anzeige (Brücke, Freigabe, Läufe mit Belegen), die nur im Pod auf Loopback lauscht: `kubectl port-forward`. | `internal/anzeige` |
| Betrieb | gitops-Entwurf (Namespace `werkstatt-prod`, PodSecurity `restricted`, Application mit Sync von Hand, SOPS-Vorlage, NetworkPolicy) und Runbook. | [deploy/gitops/](deploy/gitops/README.md), [docs/runbook.md](docs/runbook.md) |
| Mango einrichten | Erkennen, OpenWrt aufspielen, Passwort, Notfall-Schlüssel, Edge Light, Tunnel, LAN, Neustart-Probe – die Schritte unten. | `internal/mango` |
| Box-Verbindung | SSH als root durch die Brücke; nach OpenWrt gilt für den ganzen Lauf genau ein Host-Schlüssel. | `internal/box` |
| Durchreiche | Die Skripte des Release-Stands (`install.sh`, `service-tunnel.sh`) rufen `ssh <ziel> <befehl>` auf; ein `ssh`-Verweis auf dieses Programm reicht jeden Aufruf über eine Unix-Socket an die Verbindung des Laufs. | `internal/durchreiche` |
| Fassungen | OpenWrt-Abbild, Programm und Skriptstand der Freigabe, geprüft nach sha256, im Zwischenspeicher nach Prüfsumme. | `internal/fassungen` |
| Fernlauf | Neue Software für eine Edge-Light-Box ohne Kundenkonto durch den Wartungstunnel, auf Auftrag aus der Geräteakte (Konzept vp-update-vor-zuordnung S1): als Techniker-Zugang im Fenster des Auftrags anmelden, Stand lesen, Fassung laden und ihre Signatur prüfen (dieselbe Prüfung wie Schritt `fassungen`), sichern, `install.sh` wie Schritt `programm` samt Land DE und relayd, Neustart, update-bereit, „meldet sich mit der neuen Fassung“, Tunnel wie vorher; bei einem Fehler ab dem Aufspielen die Sicherung zurück. Einer zur Zeit, neben der Werkbank; Protokoll `fernlaeufe/<kennung>.jsonl`. Dieselben Schritte für einen WAGO PFC200 (Edge Industrie), erkannt an der Linie der Fassung des Auftrags (`fernlauf_industrie.go`): Sichern, Neustart und Rücknahme macht `fernlauf.sh` aus dem signierten Skriptstand, neu startet nur der Dienst `vp-edge-industrie` (nie das Gerät, nie die SPS-Laufzeit), und das Tunnel-Programm bleibt, wie es ist. | `internal/fernlauf`, [Vertrag](../../docs/contracts/werkstatt-fernlauf-v1.md), [Runbook](docs/runbook.md#fernlauf-durch-den-wartungstunnel) |
| Gehäuse | Nach der Übergabe die Druckdatei des Gehäuses mit Referenz und QR-Code (Schritt 19, P10): ein Auftrag je Box, einer zur Zeit, im Cluster als Job mit dem [Bau-Image](gehaeuse/Dockerfile) (Debian 13, Gehäuse-Programm, Bambu Studio, nur amd64). Fertig nur mit dem Prüfbericht ohne Fehler; die Dateien liegen in der Ablage, Abruf in der Werkstatt-Anzeige, drucken tust du (WI-11 A). Mit API lädt der Dienst danach die Box-Druckdatei (mit Referenz und QR-Code, sha256 geprüft) zur Portal-API hoch (`PUT …/werkstatt-dienst/gehaeuse/{edgeRef}`, vp-mango-3mf-pro-box) - die Werkstatt-Box-Seite bietet GENAU sie zum Download an; ein Fehlschlag blockiert den Lauf nicht, im eigenen Takt holt `Laufe` ihn nach, auch ohne Neustart. Derselbe Takt gleicht mit dem Portal ab (`GET …/werkstatt-dienst/gehaeuse/offen`): eine abgenommene Box ohne Druckdatei UND ohne Auftrag in der Ablage reiht er von selbst ein - auch eine, deren Lauf die Bestellung nie ausgelöst hat (zu alt für diese Funktion). Ein schon gescheiterter Auftrag wird dabei NICHT endlos neu gebaut; dafür „Erneut erstellen“ auf der Box-Seite (`POST …/admin/werkstatt/boxen/{ref}/gehaeuse/neu`, Auftrag-Art `gehaeuse` in `werkstatt_auftrag`, wie „Nochmal versuchen“ abgeholt). Die Ansicht trägt additiv die offenen Aufträge (`gehaeuse`, referenz/zustand/grund). | `internal/gehaeuse`, [Runbook](docs/runbook.md#gehäuse-druckdatei), [openapi.yaml](../../docs/contracts/openapi.yaml) (Tag werkstatt-dienst) |

Stand der Pakete aus dem Konzept (Abschnitt 8): P1 Grundgerüst, P2 Werkbank-Brücke, P11 Betrieb, P3
(Werksfirmware → OpenWrt), P5 (Box einrichten) und P4 (Edge-Light-Fassung je Release) sind gebaut: Der Lauf
[`edge-light-release.yaml`](../../.forgejo/workflows/edge-light-release.yaml) baut zu einem Tag `edge-light-JJJJ.MM.N`
die Anhänge unten ([Runbook](docs/runbook.md#fassungen-der-freigabe)). Damit ist V1a vollständig. Aus V1 dazu: Freigabe und Abnahme über
die Portal-API, Einmal-Code (D2), Probe über den Tunnel und die Gehäuse-Druckdatei (P10).

## Ein Lauf an der Mango

Steckt am orangen Kabel genau eine Mango ab Werk (192.168.8.1) oder mit frischem OpenWrt (192.168.1.1) und läuft
eine Freigabe, beginnt ihr Lauf von selbst. Jeder Schritt endet mit einem Beleg; fehlt er, hält der Lauf an.

| Schritt | Was | Beleg |
|---|---|---|
| `erkennen` | genau ein Gerät mit einer MAC; SSH als root ohne Passwort (bis die Box SSH annimmt, wartet der Lauf); Board `glinet,gl-mt300n-v2`; GL-Firmware (`/etc/glversion`); root hat kein Passwort (nicht eingerichtet). Verlangt sie ein Passwort: Handgriff Zurücksetzen (Fall `gl_passwort`). Weist sie SSH ab (ab GL 4.3.30 der Werkszustand), fragt der Dienst ihre Web-Schnittstelle (`/rpc` `ui.check_initialized`, ohne Anmeldung): noch nicht eingerichtet und Modell `mt300n-v2` heißt Ersteinrichtung im Schritt `openwrt`; schon eingerichtet heißt Zurücksetzen; sonst Startlader (`ssh_zu`). Hier ändert sich an der Box nichts | MAC, Werksfassung aus der Web-Schnittstelle, bei SSH Board, GL-Fassung, Host-Schlüssel ab Werk; sonst `ersteinrichtung: nötig` |
| `fassungen` | OpenWrt-Abbild, Programm, Skriptstand der Freigabe bereitlegen, je sha256 geprüft – bevor die Box angefasst wird | Prüfsummen, Herkunft |
| `openwrt` | nur ab GL 4.3.30 zuerst die Ersteinrichtung: `ui.init` mit einem Einmal-Passwort je Lauf (Paket `geheim`, nie in Log oder Beleg), dann SSH mit ihm und dieselben Prüfungen wie in `erkennen`; mit `sysupgrade -n` ist es samt GL-Firmware weg. Dann Abbild nach `/tmp`, sha256 auf der Box, `sysupgrade -T`, dann `sysupgrade -n` (nie `-F`) | `ersteinrichtung`, Host-Schlüssel ab Werk, sha256 vorher und auf der Box, Ausgaben |
| `wiedererkennen` | bis frisches OpenWrt unter 192.168.1.1 antwortet: Fassung der Freigabe, root ohne Passwort; ab jetzt gilt sein Host-Schlüssel | `openwrt_release`, Board, Host-Schlüssel |
| `internet` | befristet: Standardweg und DNS über die Brücke (192.168.1.2) | Standardweg, `https://downloads.openwrt.org` erreichbar (PS-12) |
| `passwort` | zufällig (20 Zeichen wie das Portal), erst verschlüsselt für den age-Schlüssel „Box-Passwörter“ (WI-6 A), dann über die Standardeingabe gesetzt | „ohne Passwort abgewiesen“, `passwort_age` |
| `notfall` | der Notfall-Schlüssel als einziger dauerhafter Schlüssel | eine Zeile, Fingerabdruck |
| `programm` | `install.sh` aus dem Skriptstand, Neustart von `vp-edge-light` | „Pruefsumme auf dem Geraet bestaetigt“, `/health` mit Referenz (Prüfzeichen gültig) und der Fassung der Freigabe |
| `einrichtung_wlan` | `wireless.radio0.country=DE` setzen, `apk add relayd`, solange die Brücke noch Internet gibt (S1, Konzept `vp-edge-light-wlan`) | Land DE, Paket relayd auf der Box |
| `tunnel_schluessel` | `service-tunnel.sh … key` | öffentlicher Schlüssel, Referenz |
| `tunnel_adresse` (ohne API) | **wartet auf dich**: Schlüssel im Portal hinterlegen, Adresse eintragen | die Adresse |
| `einloesen` (mit API, statt `tunnel_adresse`) | Einmal-Code holen, die Box löst ihn mit `werkstatt-anmelden` selbst ein (Code über die Standardeingabe): Geräteschlüssel festgehalten (D2), Tunnel-Schlüssel hinterlegt, Adresse zugeteilt, Probe-Fenster offen | Freigabe, Adresse, Probe-Fenster, sha256 des Geräteschlüssels; der Code nie |
| `tunnel` | `service-tunnel.sh … <adresse>`, dann `status` | Handshake, „SSH 2222 ausserhalb der Tunnel: abgewiesen“, Abholer mit gültiger Antwort, ein dauerhafter Schlüssel |
| `lan` | LAN auf das LAN-Netz (Entscheid 6a), Weg über die Brücke dort, Neustart | LAN-Netz |
| `neustart` | Neustart-Probe unter der neuen Adresse | derselbe Host-Schlüssel, dieselbe Referenz, Startdienste, ein dauerhafter Schlüssel, frischer Handshake |
| `probe` | mit Techniker-Zugang: der Dienst meldet sich durch den Tunnel an (WireGuard im Prozess), liest den Host-Schlüssel, schließt das Probe-Fenster, der neue Versuch endet mit „Connection timed out“; sonst **wartet auf dich**: Probe im Fenster im Portal (Werkstatt-Regel 4–6), dann `eingabe probe erledigt` | Host-Schlüssel durch den Tunnel und im LAN, Box-Log zu Anmeldung und Ende, der abgewiesene Versuch (bzw. deine Bestätigung) |
| `internet_weg` | Werkstatt-Internet wieder aus der Netz-Einstellung | kein Gateway, kein DNS über die Brücke |
| `uebergabe` | Belege für die Abnahme, je Prüfung der Werkstatt-Regel; mit API schließt der Dienst vorher das Probe-Fenster der Einlösung und schreibt die Abnahme selbst (`quelle: dienst`, Passwort nur verschlüsselt); mit Gehäuse-Bau bestellt er danach die Druckdatei, ohne auf sie zu warten | Host-Schlüssel, Fassung, Tunnel-Adresse, LAN-Netz, die zehn Prüfungen, mit API die Kennung der Abnahme, die Bestellung des Gehäuses |

Bei dir bleiben in V1a: die Tunnel-Adresse aus dem Portal eintragen, die Probe im Fenster der Fernwartung (der
Lauf wartet darauf, bevor er den Weg über die Brücke entfernt: ohne ihn steht der Tunnel in der Werkstatt nicht
mehr), das Fenster schließen und die Abnahme im Portal mit diesen Belegen ([Runbook](docs/runbook.md#eine-box-einrichten)).
Ein Lauf beginnt erst, wenn die Box fertig gestartet ist (dieselbe MAC zwei Takte unter derselben Adresse, SSH nimmt
an; ab Werk genügt die Web-Schnittstelle der GL-Firmware, weil ab 4.3.30 SSH bis zur Ersteinrichtung zu ist). Hält ein Lauf an, nennt die Ansicht den Fall (`lauf.fall`) und die Lösung (`lauf.loesung`: Titel, Schritte, ob
der Dienst danach von selbst weitermacht, ob die Box zur Seite kommt); ohne Lauf dasselbe am Anschluss
(`anschluss_fall`, `anschluss_loesung`). Codes: [Vertrag](../../docs/contracts/werkstatt-ansicht-v1.md#fälle),
`internal/faelle`. Eine Box, deren Lauf zu Ende ist, fasst der Dienst erst wieder an, wenn ihre MAC einen Takt lang
weg war (abgezogen oder neu gestartet). Eine Box mit Passwort lässt er nur zurücksetzen (ein Handgriff am
Reset-Knopf, Entscheid NA-1 B), wenn sie unter 192.168.8.1 steht (GL-Firmware) oder nachweislich eine ist, die
diese Werkstatt begonnen und nicht fertig gemacht hat (Protokoll, Host-Schlüssel, im Portal nicht abgenommen und nicht
gekoppelt; [Runbook](docs/runbook.md#eine-box-einrichten)). Eine eingerichtete Box unter dem LAN-Netz fasst er nie an.

Release-Anhänge einer Edge-Light-Fassung (unter `edge_light.quelle` der Freigabe; `edge-light/scripts/release.sh`
baut sie, dazu `sha256sums`). Mit der API nennt das Portal die Prüfsummen aus dem signierten Manifest der Fassung:

| Anhang | Inhalt | Prüfsumme in der Freigabe | im signierten Manifest |
|---|---|---|---|
| `vp-edge-light-linux-<bauart>` | das Programm, wie `edge-light/dist/` (`mipsle` für die Mango) | `programm_sha256` | `artifacts[]` (`binary`, `linux/<bauart>`, `sha256`) |
| `edge-light-openwrt.tar.gz` | `edge-light/openwrt/` als `openwrt/…` (`install.sh`, `service-tunnel.sh`, `files/`) | `skripte_sha256` | `skripte.sha256` |

## Ein Lauf am WAGO PFC200 (Edge Industrie)

Ausgeschaltet, bis `VP_WERKSTATT_GERAETE=mango,pfc200` gesetzt ist.
Dann sieht der Dienst auch unter 192.168.1.17 nach; dort steht ein PFC200 750-8212 nach dem Handgriff „feste Adresse“ (Betriebsartenschalter auf STOP, Reset-Taster länger als 8 s, Schalter zurück auf RUN).
Das orange Kabel steckt in der Buchse **X2**.
Paket `internal/pfc200`, die Texte für Menschen an einer Stelle in `internal/pfc200/texte.go` und `internal/faelle`.

| Schritt | Was | Beleg |
|---|---|---|
| `erkennen` | genau ein Gerät von WAGO unter 192.168.1.17, Anmeldung mit dem Werkspasswort; hier ändert sich nichts. Hält an bei: anderer Bestellnummer, schon eingerichtet, Notfall-Schlüssel der falschen Art. Wartet (von selbst weiter) auf: Kabel in X2, Schalter auf RUN | MAC, Bestellnummer, Firmware (nur Angabe), Seriennummer, Host-Schlüssel, Docker-Stand (nur Angabe) |
| `docker` | läuft Docker, schaltet der Dienst ihn mit `config_docker deactivate` aus (stoppt dockerd, nimmt ihn aus dem Start; nie `remove`/`install` - die deinstallieren das Paket und löschen `/home/docker`), bevor ein späterer Schritt sich auf Weiterleitung und Firewall verlässt; fremde Container fasst er dabei nie an. Läuft kein Docker, ändert sich nichts. Scheitert das Ausschalten oder läuft Docker danach weiter: hält an | Container vor dem Ausschalten (Name, Abbild, Stand), Docker-Stand vorher und nachher |
| `fassungen` | Programm, Skriptstand und Tunnel-Programm nach Prüfsumme, signiertes Manifest geprüft, bevor das Gerät angefasst wird | Prüfsummen, Herkunft |
| `internet` | Weg und Namen über die Brücke (befristet), Uhr nach der des Dienstes gestellt (ab Werk steht sie Jahre zurück, jede TLS-Verbindung scheiterte), Zeitabgleich ein | Portal erreichbar mit geprüftem Zertifikat, Uhr vorher und nachher |
| `zugaenge` | ein Schlüssel nur für diesen Lauf; drei Zufallspasswörter für `root`, `admin`, `user`: erst verschlüsselt, dann als Hash gesetzt; Anmeldung mit Passwort aus | jedes Werkspasswort an SSH abgewiesen, das Gerät meldet „nicht mehr ab Werk“, `passwort_age` |
| `notfall` | der Notfall-Schlüssel als einziger dauerhafter (daneben bis zum Ende der Lauf-Schlüssel) | Fingerabdruck |
| `programm` | `install.sh` des Release-Stands, Dienst starten | Prüfsumme auf dem Gerät bestätigt, `/health` mit Referenz und Fassung, update-bereit |
| `tunnel_schluessel`, `einloesen`, `tunnel` | wie bei der Mango, mit `wartung.sh` und dem Programm `vp-wartung` | Handshake, Port 2222 lauscht an keiner Netzbuchse, Abholer mit gültiger Antwort |
| `netze` | Buchsen trennen: X1 Kundennetz per DHCP, X2 Anlagennetz (`VP_WERKSTATT_LAN_NETZ`); Firewall ein; Start nur vom internen Speicher | Netze je Buchse; am Kundennetz kein Dienst des Geräts offen, am Anlagennetz nur `ssh`, `https`, `codesysr`; dazu Web-App 8484 und OCPP 8887; Weiterleitung aus; Modbus 502 von außen zu |
| `neustart` | Neustart, danach unter der Adresse des Anlagennetzes | derselbe Host-Schlüssel, dieselbe Referenz, Dienste laufen, Tunnel frisch, Schalter auf RUN |
| `probe` | Anmeldung durch den Tunnel, Fenster schließen, neuer Versuch | Host-Schlüssel auf zwei Wegen gleich, Ereignisliste der Box |
| `internet_weg` | Weg über die Brücke heraus; zuletzt der Lauf-Schlüssel | genau ein dauerhafter Schlüssel, der Lauf-Schlüssel wird abgewiesen |
| `uebergabe` | Abnahme mit je einem Beleg je Prüfung, Firmware und Seriennummer als Angaben | Kennung der Abnahme |

Was der Lauf am PFC200 nie anfasst: die SPS-Laufzeit (CODESYS), ihre Einstellungen, ihr Programm, ihren Modbus-Server; die Firmware; fremde Container, Abbilder und Datenträger (Schritt `docker` schaltet nur den Docker-Dienst selbst aus).
Einen Schritt für SPS, Koppelprobe oder Firmware gibt es nicht.

Drei Stellen sind so gebaut, dass der Lauf sich nicht aussperrt:

- **SSH-Dienst.** Das Werkzeug `config_ssh` der Firmware startet den SSH-Dienst neu und beendet dabei jede Sitzung. Der Dienst ruft es losgelöst von seiner Sitzung auf und meldet sich danach mit dem Lauf-Schlüssel neu an.
- **Netze.** Trennen und Adresse laufen als ein Befehl auf dem Gerät. Bestätigt der Dienst die neue Adresse nicht innerhalb der Frist, stellt das Gerät sich selbst zurück (beide Buchsen in einer Brücke, feste Adresse 192.168.1.17).
- **Firewall.** Nach dem Einschalten muss eine **neue** Anmeldung gelingen; sonst schaltet das Gerät die Firewall selbst wieder aus.

Die Passwörter stehen als **ein** verschlüsselter Text im Beleg `passwort_age` und an der Abnahme: entschlüsselt je Zugang eine Zeile `benutzer: passwort`.
Das von `admin` brauchst du für CODESYS und die Web-Oberfläche des Geräts; du entschlüsselst es selbst mit dem Schlüssel „Box-Passwörter“, es steht an keiner Route.

Release-Anhänge einer Edge-Industrie-Fassung (Linie `edge-industrie-JJJJ.MM.N`), die die Freigabe für den PFC200 nennt (`box_art` `pfc200`, Feld `edge_industrie`):

| Anhang | Inhalt | Prüfsumme in der Freigabe |
|---|---|---|
| `vp-edge-industrie-linux-arm` | das Programm, wie `edge-industrie/dist/` | `programm_sha256`, im signierten Manifest unter `artifacts[]` |
| `edge-industrie-skripte.tar.gz` | `edge-industrie/` als `edge-industrie/…` (`install.sh`, `wartung.sh`, `files/`) | `skripte_sha256` |
| `vp-wartung-linux-arm` | das Tunnel-Programm | `wartung_sha256` |

Der Release-Lauf `edge-industrie-release.yaml` hängt alle drei an; die Prüfsummen der beiden letzten stehen signiert im Manifest (Felder `skripte` und `wartung`).
Der Dienst verlangt sie dort: Im Schritt `fassungen` prüft er die Signaturkette des Manifests und dass es genau das Programm, den Skriptstand und das Tunnel-Programm der Freigabe beschreibt.
Eine Fassung ohne signiertes Manifest oder ohne diese Felder richtet er auf einem PFC200 nicht ein (anders als bei der Mango, wo eine nicht signierte Fassung läuft und nur keine Abnahme bekommt): Das Tunnel-Programm läuft als root und öffnet den Fernzugang.
Die Freigabe für den PFC200 kommt aus dem Portal wie die der Mango: `GET /api/v1/werkstatt-dienst/freigabe?boxArt=pfc200`.
Die Regel der API legt sie selbst an, aus der neuesten zuweisbaren signierten Edge-Industrie-Fassung, deren Manifest Skriptstand und Tunnel-Programm nennt; fehlt eine solche Fassung, wartet die Werkstatt für dieses Gerät, und die Mango läuft weiter.
Den Einmal-Code holt der Dienst mit `boxArt: pfc200`; die Box steht damit als `edge-industrie` im Register, und die API nimmt ihre Abnahme nur mit der Prüfliste des PFC200 (`geraete.pfc200` in `docs/contracts/werkstatt-pruefungen.json`, Zwilling `pfc200.Pruefungen`).
Anhalten und die Tagesgrenze gelten für beide Geräte zusammen.
Ohne API (`VP_WERKSTATT_API_URL` leer) liest der Dienst die Freigabe aus der Datei `VP_WERKSTATT_FREIGABE_PFC200`.

Getestet gegen die Attrappe „PFC200 ab Werk“ (`internal/attrappe/pfc200.go`): Sie führt jeden Befehl des Dienstes mit einem echten `sh` aus, gegen Nachbauten der Werkzeuge der WAGO-Firmware (`internal/attrappe/pfc200/config-tools`, gebaut nach den Hilfetexten und Skripten eines 750-8212 mit Firmware 03.10.08(22), dort nur gelesen).
Nicht an einem echten Gerät gelaufen: alles ab `zugaenge`, weil es das Gerät ändert.
Die echten Skripte `install.sh` und `wartung.sh` prüfen `edge-industrie/test/install-probe.sh` und `wartung-probe.sh` im BusyBox-Container.

## Was der Dienst nie tut

- das Netz absuchen: Die Brücke fragt nur nach den festen Box-Adressen ihres Werkstatt-Anschlusses (192.168.8.1,
  192.168.1.1, das LAN-Netz), je zwei ARP-Anfragen;
- Passwörter raten, sich an einer Box mit einem Passwort anmelden, das nicht dieser Lauf gesetzt hat, an der
  Werkbank ein eingerichtetes Gerät anfassen (eine eingerichtete Box erreicht er nur im Fernlauf, siehe unten), zwei
  Geräte am Werkstatt-Anschluss bedienen;
- ohne Freigabe oder ohne den Beleg des vorigen Schritts weitermachen;
- im Fernlauf etwas anderes tun als dessen feste Schritte: nie OpenWrt, Passwort, Notfall-Schlüssel, Tunnel, LAN oder
  die Identität der Box anfassen, nie ohne Auftrag des Portals und nie außerhalb des Fensters dieses Auftrags; an
  einem PFC200 dazu nie das Gerät neu starten und nie SPS-Laufzeit, Firmware oder Tunnel-Programm anfassen;
- ein Root-Passwort an eine Route geben oder in einen Beleg schreiben (Entscheid WI-6 A: nur verschlüsselt für den
  age-Schlüssel „Box-Passwörter“, ab P5); das Einmal-Passwort der Ersteinrichtung ab Werk steht nirgends, nicht
  einmal verschlüsselt: Es lebt nur im Speicher des Laufs und ist mit dem Aufspielen von OpenWrt weg.

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
| `VP_WERKSTATT_GERAETE` | `mango` | `mango,pfc200`: Der Dienst richtet auch WAGO PFC200 ein. Die Brücke bekommt dann zwei Ziele mehr (192.168.1.17:22, LAN:502) und damit eine neue Fassung; der Dienst spielt sie selbst auf |
| `VP_WERKSTATT_FREIGABE_PFC200` | `/etc/vp-werkstatt/freigabe/freigabe-pfc200.json` | die Freigabe für den PFC200 als Datei, nur ohne API; mit API kommt sie aus dem Portal (`freigabe?boxArt=pfc200`) |
| `VP_WERKSTATT_NOTFALL_PUB_PFC200` | `VP_WERKSTATT_NOTFALL_PUB` | Notfall-Schlüssel für den PFC200 (Datei). Der SSH-Dienst des PFC200 nimmt nur RSA und ECDSA; ist der allgemeine Schlüssel Ed25519, startet der Dienst mit eingeschaltetem PFC200 nicht, bis hier ein passender steht |
| `VP_WERKSTATT_ZEITSERVER` | `ptbtime1.ptb.de,ptbtime2.ptb.de,ptbtime3.ptb.de` | Zeitserver, die der Lauf im PFC200 einträgt (höchstens vier); der Zeitabgleich bleibt nach dem Lauf an |
| `VP_WERKSTATT_STEUERUNG` | `/tmp/vp-werkstatt-dienst.sock` | Unix-Socket für Eingaben (`vp-werkstatt-dienst eingabe`) |
| `VP_WERKSTATT_ARBEIT` | `/tmp/vp-werkstatt` | Arbeitsverzeichnis der Läufe (Skriptstand, Durchreiche) |
| `VP_WERKSTATT_GEHEIM` | `/etc/vp-werkstatt/geheim` | Verzeichnis mit `werkbank-status`, `werkbank-weiterleitung`, `werkbank-pflege` (Pflicht), `werkbank-einrichten` (nur fürs erste Einrichten) und `download-token` (optional: Lese-Token für die Release-Anhänge auf git.tecmaxx.de) |
| `VP_WERKSTATT_NOTFALL_PUB` | – (Pflicht) | öffentlicher Notfall-Schlüssel (Datei) |
| `VP_WERKSTATT_FREIGABE` | `/etc/vp-werkstatt/freigabe/freigabe.json` | die Freigabe als Datei (V1a); fehlt die Datei, läuft keine |
| `VP_WERKSTATT_API_URL` | leer | Portal-API (V1): gesetzt, liest der Dienst die laufende Freigabe dort (`GET /api/v1/werkstatt-dienst/freigabe`) statt aus der Datei |
| `VP_WERKSTATT_PORTAL_URL` | `VP_WERKSTATT_API_URL` | Portal, von dem der DIENST SELBST (im Cluster) das Vertrauens-Set (`/api/v1/edge/trust-set/…`) lädt und die Signatur des Release-Manifests prüft. Leer: `install.sh` lädt das Vertrauens-Set selbst vom Standard-Portal. Kann eine nur im Cluster aufgelöste Adresse sein (Fallback auf `VP_WERKSTATT_API_URL`) - gilt NIE für ein Gerät, siehe `VP_WERKSTATT_GERAET_PORTAL_URL` |
| `VP_WERKSTATT_GERAET_PORTAL_URL` | `https://portal.voltpilot.de` | Portal, wie ein GERÄT hinter der Werkbank-Brücke es erreicht: der befristete Internet-Check (Zertifikat des Portals) und das dauerhaft mit `install.sh`/`VP_PORTAL_URL` auf die Box gelegte `portal_url` (Update-bereit, Entscheid 5c; Fernlauf). Fällt NIE auf `VP_WERKSTATT_PORTAL_URL` oder dessen In-Cluster-Fallback zurück - ein Gerät kann eine Cluster-interne Adresse nie auflösen |
| (Ansicht ans Portal) | – | mit `VP_WERKSTATT_API_URL` meldet der Dienst jeden Takt seine Ansicht (`PUT /api/v1/werkstatt-dienst/ansicht`, [Vertrag](../../docs/contracts/werkstatt-ansicht-v1.md)) für die Werkstatt-Bildschirme; ein Fehler dabei hält nichts an und steht einmal im Log |
| `VP_WERKSTATT_TOKEN_URL` | – (Pflicht mit API) | Token-Endpunkt von Keycloak (`…/realms/voltpilot/protocol/openid-connect/token`) |
| `VP_WERKSTATT_TECHNIKER_ADRESSE` | leer | Probe über den Tunnel (V1, nur mit API): Adresse des Techniker-Zugangs „Werkstatt-Dienst“ im Techniker-Netz; dazu `techniker-wireguard` und `techniker-ssh` im Geheimnis-Verzeichnis (`vp-werkstatt-dienst techniker-schluessel <dir>` erzeugt sie). Leer: die Probe bleibt ein Handgriff |
| `VP_WERKSTATT_CLIENT_ID` | `voltpilot-werkstatt-dienst` | Dienstkonto (client_credentials, Rolle `werkstatt-dienst`); Secret als `keycloak-client-secret` im Geheimnis-Verzeichnis |
| `VP_WERKSTATT_DATEN` | `/var/lib/vp-werkstatt-dienst` | Protokolle, Host-Schlüssel der Brücke (PVC) |
| `VP_WERKSTATT_HTTP` | `:8100` | Betriebsseite |
| `VP_WERKSTATT_ANZEIGE` | `127.0.0.1:8101` | Werkstatt-Anzeige, nur eine Loopback-Adresse |
| `VP_WERKSTATT_TAKT` | `10s` | Takt der Schleife (2 s bis 5 min) |
| `VP_GEHAEUSE_BAU` | leer | Gehäuse-Druckdatei je Box: `kubernetes` (Job mit dem Bau-Image), `befehl` (Gehäuse-Programm auf diesem Rechner) oder leer (kein Bau, wie bisher `bauen.sh --referenz` von Hand) |
| `VP_GEHAEUSE_IMAGE` | – (Pflicht mit `kubernetes`) | Bau-Image fest nach Digest (`…/werkstatt-gehaeuse@sha256:…`, Lauf `werkstatt-gehaeuse-bild.yaml`) |
| `VP_GEHAEUSE_ABLAGE` | `/var/lib/vp-werkstatt-gehaeuse` | Ablage der Aufträge und Dateien; im Cluster die PVC `werkstatt-gehaeuse` |
| `VP_GEHAEUSE_PVC`, `VP_GEHAEUSE_PULL_SECRET` | `werkstatt-gehaeuse`, `forgejo-registry` | PVC der Ablage und Pull-Secret für den Job |
| `VP_GEHAEUSE_SPEICHER` | `4Gi` | Grenze des Arbeitsspeichers je Job (PS-8) |
| `VP_GEHAEUSE_FRIST` | `20m` | je Auftrag (1 min bis 2 h); danach wird der Job gelöscht und der Auftrag scheitert |
| `VP_GEHAEUSE_PROGRAMM` | – (Pflicht mit `befehl`) | Ordner des Gehäuse-Programms mit `bauen.sh` (eingerichtet mit `./einrichten.sh --bambu`) |
| `VOLTPILOT_LOGGING_FORMAT` | `text` | `json`: eine JSON-Zeile je Ereignis |

Befehle: `vp-werkstatt-dienst dienst` (Vorgabe), `werkbank` (Brücke einmal einrichten bzw. prüfen, Status als
JSON), `eingabe <name> <wert>` (an den laufenden Lauf, etwa `eingabe tunnel_adresse 10.10.16.5`), `gehaeuse
<referenz> [neu]` (Druckdatei bestellen; `neu` baut eine fertige noch einmal), `pruefe-konfig`, `fassung`.

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
test/dienst-container-probe.sh          # Dienst-Bild unter PodSecurity restricted; VP_PROBE_BILD=<bild:commit> prüft ein geschobenes Bild
test/box-probe.sh                       # ganzer Lauf ab frischem OpenWrt: echtes OpenWrt, Brücke, Wartungsserver, Skripte
VP_PROBE_FERNLAUF=1 test/box-probe.sh   # dazu (mit API) zwei Fernläufe durch den Tunnel: Rücknahme, dann aufgespielt
test/gehaeuse-bild-probe.sh             # Bau-Image (amd64): ein Auftrag wie der Job, Druckdateien, Bericht ohne Fehler
```

Die Go-Tests sprechen nur mit Attrappen im Prozess (`internal/attrappe`: SSH-Server, die sich wie die Brücke und
wie eine Mango ab Werk bis zur Neustart-Probe verhalten, ab Werk mit der Web-Schnittstelle der GL-Firmware nach dem
Befund PS-1, dazu Attrappen der beiden Skripte). Die Box-Probe fährt
einen ganzen Lauf ab frischem OpenWrt gegen ein echtes OpenWrt 25.12.5 (x86-64) mit den echten Skripten und einem
echten Wartungsserver (`vp-tunnel-dienst`); die GL-Werksfirmware, `sysupgrade` und das Funkmodul (kein Land DE, Schritt `einrichtung_wlan`) gibt es nur in der Attrappe bzw. an der echten Mango. Die Brücken-Probe braucht Docker mit `--privileged` (Netz-Namensräume im Container) und baut ein
Debian-trixie-Bild; beide Proben räumen ihre Bilder wieder weg. Am echten Gerät ersetzen sie nichts: Prüfsteine
PS-1 bis PS-14 im [Runbook](docs/runbook.md#prüfsteine-am-echten-gerät).
Schlägt die Dienst-Bild-Probe fehl, zeigt sie Zustand und Log des Dienst-Containers und den freien Platz am
Datenvolume: Auf einem vollen Runner-Host schreiben Docker und `chown` als root noch, der Dienst als 10001 nicht.
