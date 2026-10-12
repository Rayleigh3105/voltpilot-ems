# Fernwartung: Wartungstunnel über das Portal

Der Wartungstunnel der VoltPilot-Boxen wird im Portal verwaltet. Das Portal führt den **Soll-Zustand**; ein kleiner **Tunnel-Dienst** auf einer eigenen VM holt ihn regelmäßig ab und setzt ihn auf WireGuard und nftables um. Die Plattform schreibt nie selbst auf den Server. Der Dienst meldet dem Portal zurück, welche Box verbunden ist und welches Fenster seinen Schlüssel abgeholt hat; das ist Anzeige und ändert am Soll-Zustand nichts ([Rückmeldung](#rückmeldung-des-tunnel-dienstes)).

Grundlage sind die Entscheide des Kapitäns vom 07.10.2026:

- **E5:** Fernwartung über das Portal verwalten.
- **Endpunkt:** ein neuer Name auf einer eigenen kleinen VM (Vorgabe `wartung.voltpilot.de`, konfigurierbar). Dort läuft WireGuard ohne Weboberfläche plus der Tunnel-Dienst; Techniker bekommen dort eigene Zugänge. **`vpn.voltpilot.de` mit WireGuard UI bleibt unberührt.**
- **O3:** Der Kunde stimmt der Fernwartung einmal generell zu (Vertrag/AGB) und sieht die einzelnen Zeitfenster nicht. Intern wird jedes Fenster mit Grund, Techniker und Zeit protokolliert.

```mermaid
flowchart LR
    subgraph P["Plattform"]
        portal["Portal (nur platform-admin):<br/>Boxen, Techniker-Zugänge,<br/>Fenster, Protokoll"] --> api["API: Soll-Zustand<br/>fernwartung_*"]
    end
    subgraph V["Wartungs-VM (wartung.voltpilot.de)"]
        dienst["Tunnel-Dienst<br/>holt Soll alle 30 s"]
        wg["wg-wartung · UDP 51820<br/>Boxen 10.10.16.0/20<br/>Techniker 10.10.32.0/24"]
        nft["nftables: Techniker → Box<br/>nur im offenen Fenster,<br/>Mengen mit Ablaufzeit"]
        dienst --> wg
        dienst --> nft
    end
    dienst -- "HTTPS, Rolle tunnel-dienst<br/>Soll lesen, Zustand melden,<br/>nur ausgehend" --> api
    box["Box (wg_wartung)"] -- "WireGuard ausgehend" --> wg
    tech["Techniker-Gerät"] -- "WireGuard" --> wg
```

## Netze und Server

| Einstellung | Vorgabe | API (`voltpilot.fernwartung.*`) |
|---|---|---|
| Box-Netz, Server auf `.1` | `10.10.16.0/20` | `box-netz` / `VP_FERNWARTUNG_BOX_NETZ` |
| Techniker-Netz, Server auf `.1` | `10.10.32.0/24` | `techniker-netz` / `VP_FERNWARTUNG_TECHNIKER_NETZ` |
| Längstes Fenster | 24 h (Datenbank-Grenze 7 Tage) | `max-fenster-dauer` / `VP_FERNWARTUNG_MAX_FENSTER_DAUER` |
| Servername | `wartung.voltpilot.de` | `server-endpunkt` / `VP_FERNWARTUNG_SERVER_ENDPUNKT` |
| UDP-Port | `51820` | `server-port` / `VP_FERNWARTUNG_SERVER_PORT` |
| Öffentlicher Server-Schlüssel | leer, bis die VM steht | `server-public-key` / `VP_FERNWARTUNG_SERVER_PUBLIC_KEY` |

Der Servername zeigt direkt auf die öffentliche Adresse des Servers (kein HTTP-Proxy davor: WireGuard ist UDP), und die VM hat eine feste Adresse, an der eine Portweiterleitung hängen kann. Der Tunnel-Dienst sichert nur den Verkehr durch den Tunnel; eine eigene Firewall der VM richtet er nicht ein ([Installation](../services/tunnel-dienst/README.md#installation-auf-der-vm)).

Beide Netze überschneiden sich nicht mit dem alten Service-VPN `10.10.1.0/24`; ein Techniker-Gerät kann in beiden VPNs zugleich hängen. Die Netze müssen mit der Konfiguration des Tunnel-Dienstes übereinstimmen, sonst verwirft er den Soll-Stand. Ein widersprüchliches Netz bricht den Start der API ab.

## Datenmodell

Migrationen `V20261007163700__fernwartung.sql`, `V20261008213500__fernwartung_zugang_loeschen.sql`, `V20261009074500__fernwartung_ssh_schluessel.sql` und `V20261010203000__fernwartung_rueckmeldung.sql`; plattformweite Betriebsdaten ohne `tenant_id`.

| Tabelle | Inhalt |
|---|---|
| `fernwartung_zugang` | ein WireGuard-Peer: `art` `box` (mit `edge_ref`) oder `techniker` (mit `name`); öffentlicher Schlüssel und `/32`-Adresse, beide über **beide Arten** eindeutig; `status` `aktiv`/`gesperrt`, für Techniker-Zugänge zusätzlich `geloescht`; für Techniker-Zugänge wahlweise `ssh_public_key`, nicht eindeutig |
| `fernwartung_fenster` | Box, Techniker, Grund, Beginn, Ende, wer geöffnet und wer geschlossen hat; zusammengesetzte Fremdschlüssel erzwingen „Box“ und „Techniker“ |
| `fernwartung_protokoll` | jede Änderung, append-only per Trigger und ohne `UPDATE`/`DELETE`-Recht |
| `fernwartung_dienst_abruf` | wann welcher Tunnel-Dienst den Soll-Stand zuletzt abgeholt hat |
| `fernwartung_rueckmeldung_dienst`, `…_box`, `…_fenster` | was der Tunnel-Dienst zuletzt gemeldet hat: je Dienstkonto, je Box (verbunden seit, zuletzt gefragt), je Fenster (Schlüssel abgeholt), jeweils mit der Zeit, zu der die API es angenommen hat. Nur der letzte Stand, kein Verlauf |

- **O3 an der Datenbankgrenze:** Die App-Rolle hat auf keine dieser Tabellen ein Recht; RLS ohne Policy ist der zweite Riegel. Geschrieben und gelesen wird nur über `voltpilot_admin`.
- **Die Tabellen der Rückmeldung stehen für sich.** Sie verweisen auf Box und Fenster, aber weder der Soll-Stand noch eine Regel der Fernwartung liest sie ([Rückmeldung](#rückmeldung-des-tunnel-dienstes)).
- **Keine Zeile wird entfernt, keine Adresse neu vergeben.** Eine Adresse und ein Schlüssel bleiben ihrem Zugang, gesperrt wie gelöscht. Eine wiedervergebene Adresse ließe einen Techniker bei einem fremden Gerät landen. Die Admin-Rolle hat auf keiner Tabelle ein `DELETE`-Recht.
- **„Löschen“ ist ein Zustand, kein `DELETE`.** Ein gelöschter Techniker-Zugang trägt `status = 'geloescht'`; seine Zeile hält Adresse und Schlüssel über die `UNIQUE`-Constraints fest, und Fenster wie Protokoll verweisen weiter auf sie. Ein Trigger macht den Zustand endgültig: gelöscht wird nur aus `gesperrt`, und eine gelöschte Zeile ändert sich nie wieder. Eine Box kann den Zustand nicht annehmen (`CHECK`).

## Routen und Rollen

| Route | Rolle | Zweck |
|---|---|---|
| `/api/v1/admin/fernwartung/**` | `platform-admin` | Boxen, Techniker-Zugänge, Fenster, Protokoll, Übersicht |
| `GET /api/v1/fernwartung/soll` | `tunnel-dienst` | Soll-Stand für den Tunnel-Dienst |
| `PUT /api/v1/fernwartung/rueckmeldung` | `tunnel-dienst` | der Dienst meldet seinen Zustand: nur Anzeige ([Rückmeldung](#rückmeldung-des-tunnel-dienstes)) |

Das Dienstkonto ist der Keycloak-Client `voltpilot-tunnel-dienst` (nur `client_credentials`) im Muster von `voltpilot-release-publisher`. Seine Routen liegen bewusst **nicht** unter `/api/v1/admin/**`: Die Rückfallregel des Admin-Baums lässt nur `platform-admin` und `edge-release-publisher` durch, und das soll so bleiben. Kunden-, Publisher- und Admin-Token bekommen auf beiden Routen 403. Die Rolle hat damit genau ein Schreibrecht, und es umfasst genau diese Meldung. Vertrag: [OpenAPI](contracts/openapi.yaml), Tag `fernwartung`.

## Regeln

- **Schlüssel entstehen auf dem Gerät.** Hier kommen nur öffentliche Schlüssel an: WireGuard für Boxen und Techniker, dazu der SSH-Schlüssel des Technikers ([Anmeldung an der Box](#anmeldung-an-der-box-fenster-schlüssel)).
- **Box-Schlüssel hinterlegen** (`PUT …/boxen/{ref}/schluessel`) ist der Übergang bis zur Werkstatt-Registrierung D2; D2 soll genau diese Regel aufrufen.
  - Neu: Adresse aus dem Box-Netz zuteilen.
  - Derselbe Schlüssel noch einmal: unverändert.
  - Ein anderer Schlüssel: nur mit `schluesselTausch: true`. WireGuard verschiebt die Adresse dann zum neuen Peer.
  - Referenz wie bei der Kopplung: `edge-` mit Prüfzeichen, sonst muss die Plattform die Referenz kennen.
- **Fenster:** Box, Techniker-Zugang, Grund (3–500 Zeichen) und Dauer sind Pflicht.
  - Dauer höchstens `max-fenster-dauer`; Beginn jetzt oder bis 30 Tage im Voraus.
  - Ein überlappendes Fenster für dasselbe Paar wird abgelehnt: erst schließen, dann neu öffnen.
  - Vorzeitig schließen jederzeit; ein geplantes Fenster wird damit abgesagt.
- **Sperren** einer Box oder eines Zugangs schließt deren offene und geplante Fenster. Der Tunnel-Dienst entfernt den Peer beim nächsten Abruf.
- **Löschen** (`DELETE …/techniker/{id}`) gibt es nur für einen **gesperrten Techniker-Zugang**; ein aktiver muss erst gesperrt werden (409). Es ist endgültig.
  - Der Zugang fehlt danach in jeder Liste, Auswahl und Zählung des Portals und lässt sich nicht mehr entsperren; jede Route antwortet für ihn mit 404.
  - Seine Adresse und sein Schlüssel bleiben dauerhaft vergeben. Wer denselben Schlüssel noch einmal einträgt, bekommt 409 mit dem Hinweis, auf dem Gerät ein neues Schlüsselpaar zu erzeugen.
  - Das Protokoll bekommt den Eintrag `techniker_geloescht` mit Zeit und Akteur. Frühere Fenster- und Protokolleinträge bleiben lesbar und nennen den Zugang weiter beim Namen.
  - Für den Tunnel-Dienst ändert sich nichts: Schon der gesperrte Zugang stand nicht mehr im Soll-Stand.
  - Boxen lassen sich nicht löschen.

## Anmeldung an der Box (Fenster-Schlüssel)

Ein offenes Fenster öffnet den **Netzweg** zur Box. Die **Anmeldung** an der Box ist eine zweite Schranke: Ihr SSH-Server im Tunnel (Dropbear, Port 2222) lässt nur hinein, wessen öffentlicher Schlüssel auf der Box liegt. Entscheid des Kapitäns vom 09.10.2026: Der Techniker hinterlegt seinen öffentlichen SSH-Schlüssel einmal im Portal; solange ein Fenster offen ist, holt sich die Box ihn über den Wartungstunnel und behält ihn nur bis zum Ende des Fensters.

| Schritt | Inhalt | Stand |
|---|---|---|
| 1 | Portal und API: der SSH-Schlüssel steht am Techniker-Zugang und geht im Soll-Stand mit | umgesetzt |
| 2 | Tunnel-Dienst: gibt einer Box die Schlüssel der Techniker aus, für die gerade ein Fenster zu ihr offen ist | umgesetzt; auf der Wartungs-VM seit dem 09.10.2026 eingeschaltet (`10.10.32.1:8022`) |
| 3 | Box (`service-tunnel.sh`): holt die Schlüssel ab, hält sie nur im Arbeitsspeicher und führt die Frist selbst | umgesetzt für OpenWrt mit Dropbear ab 2025.89 (Mango, 25.12); eine Box holt erst ab, wenn ihr Tunnel mit diesem Skript eingerichtet ist |
| 4 | Rückmeldung des Tunnel-Dienstes ans Portal: Box verbunden, zuletzt gefragt, Schlüssel abgeholt | umgesetzt ([Rückmeldung](#rückmeldung-des-tunnel-dienstes)); wirkt, sobald Portal und Tunnel-Dienst beide auf diesem Stand laufen |
| 5 | Regeln: Werkstatt-Regel (Root-Passwort, Anmeldeprobe über Portal und Tunnel), ein Notfall-Schlüssel als einziger dauerhafter Schlüssel | beschrieben in [mango.md](../edge-light/docs/mango.md#bevor-eine-box-die-werkstatt-verlässt); je Box vom Kapitän umzusetzen, an keinem Gerät ausgeführt |
| 6 | Box: Mit einem Fenster-Schlüssel enden die Sitzungen, die mit ihm begonnen wurden ([unten](#was-mit-einer-laufenden-anmeldung-geschieht)) | umgesetzt im Box-Skript, belegt im Container; gilt für eine Box erst nach einem erneuten Lauf von `service-tunnel.sh` ([Ausrollen](../edge-light/docs/mango.md#sitzungen-beenden-ausrollen-je-box)); am 11.10.2026 an der Labor-Mango eingespielt und am 12.10.2026 vom Kapitän mit einem echten Fenster erprobt ([Stand](../edge-light/docs/mango.md#stand-an-der-labor-mango-sitzungen-beenden)), an keiner anderen Box |
| 7 | Box: Die Ereignisse der Fernwartung bleiben in einer eigenen, begrenzten Liste nachlesbar; cron füllt das Protokoll der Box nicht mehr ([unten](#wer-wann-auf-einer-box-war)) | umgesetzt im Box-Skript, belegt im Container; gilt für eine Box erst nach einem erneuten Lauf von `service-tunnel.sh` ([Ausrollen](../edge-light/docs/mango.md#protokoll-und-ereignisliste-ausrollen-je-box)); am 12.10.2026 an der Labor-Mango eingespielt und vom Kapitän mit einem echten Fenster erprobt ([Stand](../edge-light/docs/mango.md#stand-an-der-labor-mango-12102026)), an keiner anderen Box. Neustart und Update am echten Gerät sind nicht belegt |

Die Schritte 1 bis 3 sind ausgerollt und am 10.10.2026 vom Kapitän an der Labor-Mango abgenommen ([Belege](../edge-light/docs/mango.md#belegt)).

**Eine Box holt nur ab, wenn zwei Dinge stimmen:** Ihr Tunnel ist mit dem `service-tunnel.sh` ab Schritt 3 eingerichtet, und die Schlüsselausgabe läuft am Wartungsserver. Fehlt eines davon, gelingt die Anmeldung wie vorher nur mit einem Schlüssel, der schon auf der Box liegt. Das Portal verspricht die Anmeldung deshalb nicht pauschal. Seit der Rückmeldung zeigt es am offenen Fenster, ob die Box den Schlüssel abgeholt hat, und nennt sonst den Grund, den die Meldung hergibt: Die Box fragt gar nicht nach Schlüsseln, oder die Schlüsselausgabe ist aus. An einer Box zeigt `service-tunnel.sh <ziel> status`, ob sie eingerichtet ist und wann der Server zuletzt geantwortet hat.

**Die Schlüsselausgabe des Tunnel-Dienstes** (Schritt 2): Eine Box fragt im Tunnel die Server-Adresse im Techniker-Netz (`10.10.32.1`, eigener Port) und bekommt die Schlüssel der Paare, die gerade in der Kernel-Menge `fenster` stehen, mit deren Restlaufzeit. Der Dienst prüft jeden Schlüssel noch einmal selbst, antwortet nur Box-Adressen und gibt ohne frisch abgeholten Soll-Stand keine Liste aus. Einzelheiten, Grenzen und das Einschalten auf der VM: [Tunnel-Dienst](../services/tunnel-dienst/README.md#schlüsselausgabe); Anfrage und Antwort für das Box-Skript: [Vertrag](contracts/fernwartung-schluessel-v1.md).

**Die Box-Seite** (Schritt 3, [mango.md](../edge-light/docs/mango.md#fenster-schlüssel-auf-der-box)): `service-tunnel.sh` legt einen Abholer, ein Startskript und eine cron-Zeile auf die Box. Geprüft mit echter SSH-Anmeldung durch einen echten Tunnel in `edge-light/test/wartung-anmeldung-probe.sh`.

- **Der Abholer fragt nur durch den Tunnel**, mit `uclient-fetch`. Führt die Route zum Server nicht über die Tunnel-Schnittstelle, fragt er nicht; eine Regel in der Firewall der Box weist die Anfrage auf jedem anderen Weg zusätzlich ab.
- **Die Schlüsseldatei liegt nur im Arbeitsspeicher**, in einem eigenen tmpfs, das allein die SSH-Instanz im Tunnel liest (`dropbear -D`). Ein Neustart der Box löscht jeden Fenster-Schlüssel.
- **Die Frist läuft in Laufzeit der Box, nicht in Uhrzeit.** Ohne gültige Antwort kommt nichts dazu, und was da ist, verfällt zur Frist: auch ohne Server und auch, wenn der Abholer hängt (ein cron-Lauf je Minute streicht unabhängig von ihm).
- **Die Antwort ist die ganze Liste.** Ein Schlüssel, den sie nicht mehr nennt, ist sofort gestrichen: bei vorzeitig geschlossenem Fenster und bei einem im offenen Fenster ersetzten oder entfernten Schlüssel.
- **Mit dem Schlüssel enden seine Sitzungen.** Auf jedem Weg, auf dem ein Fenster-Schlüssel von der Box verschwindet, beendet sie die Sitzungen, die mit genau ihm begonnen wurden ([Einzelheiten](#was-mit-einer-laufenden-anmeldung-geschieht)).
- **Dauerhafte Schlüssel:** Was in `/etc/dropbear/authorized_keys` der Box steht, gilt im Tunnel weiter; das Skript liest die Datei nur. Solche Schlüssel umgehen die Schranke „kein Fenster, kein Schlüssel“: Öffnet ein Fehler der Server-Firewall den Port, kommt damit hinein, wer so einen Schlüssel hat. Entschieden (K2 a, 08.10.2026): In der Pilotphase bleibt auf jeder Box genau einer, ein Notfall-Schlüssel des Kapitäns, getrennt aufbewahrt; nach einigen Monaten Betrieb wird neu entschieden. Zielzustand und der Weg dorthin je Box: [mango.md](../edge-light/docs/mango.md#dauerhafte-schlüssel-ein-notfall-schlüssel).
- **SSH 2222 kommt nur aus dem Tunnel an** (Entscheid vom 09.10.2026). Die Box weist den Port auf jedem anderen Weg ab, ob der Tunnel oben ist oder unten. Port 22 im LAN ändert sich nicht.

- **Der Schlüssel am Zugang** (`sshPublicKey` beim Anlegen, `PUT`/`DELETE …/techniker/{id}/ssh-schluessel`) ist freiwillig. Ohne ihn öffnet ein Fenster für diesen Zugang nur den Netzweg; das Portal nennt das in der Zugangsliste, beim Öffnen eines Fensters und unter der Box, solange das Fenster offen ist.
- **Nur RSA, 2048 bis 4096 Bit.** Der Dropbear der Boxen (OpenWrt 25.12.5 auf der Mango) nimmt nur `ssh-rsa` an. Ein Ed25519-, ECDSA- oder FIDO-Schlüssel wird mit dem Befehl abgelehnt, der einen passenden erzeugt (`ssh-keygen -t rsa -b 3072`). 4096 Bit ist die größte Länge, mit der die Anmeldung an diesem Dropbear belegt ist.
- **Eine Zeile, keine Optionen davor.** Mehrzeiliges, ein privater Schlüssel und Optionen wie `command="…"` werden abgelehnt. Das Portal prüft dieselben Regeln schon im Browser; ein versehentlich eingefügter privater Schlüssel verlässt ihn nicht.
- **Gespeichert wird die Normalform** `ssh-rsa <Base64>`: ohne Kommentar, der Schlüssel neu kodiert. Dropbear vergleicht Bytes; nur die Normalform passt sicher zu dem, was der SSH-Client anbietet. Regeln: `SshSchluessel.java`, grob als `CHECK` in der Migration, im Portal `sshSchluesselPruefen`.
- **Der Fingerabdruck** ist der von `ssh-keygen -lf` (`SHA256:…`). Das Portal zeigt ihn am Zugang und nennt den Befehl zum Vergleich; im Protokoll steht nur er, nie der Schlüssel.
- **Nicht eindeutig.** Zwei Zugänge desselben Technikers dürfen denselben SSH-Schlüssel tragen. Wer im Box-Log unterscheiden will, welches Gerät sich angemeldet hat, gibt jedem Gerät einen eigenen.
- **Protokoll:** `techniker_ssh_schluessel_gesetzt` (mit neuem und vorherigem Fingerabdruck) und `techniker_ssh_schluessel_entfernt`; beim Anlegen steht der Fingerabdruck im Eintrag `techniker_angelegt`. Derselbe Schlüssel noch einmal ändert nichts und steht nicht im Protokoll.
- **Sperren und Löschen** ändern den Schlüssel nicht. Ein gesperrter oder gelöschter Zugang steht nicht im Soll-Stand, sein SSH-Schlüssel also auch nicht.
- **Befehle im Portal.** Der Dialog am Zugang nennt die Befehle zum Erzeugen für Windows (PowerShell) und Linux/macOS, mit dem Dateinamen `id_rsa_voltpilot`, damit kein vorhandener Schlüssel überschrieben wird. Unter einer Box mit offenem Fenster stehen die fertigen Befehle, je Fenster mit dem Satz, ob der Zugang einen SSH-Schlüssel trägt: `ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@<Box-Adresse>` und für die Web-App der Box dieselbe Anmeldung mit `-L 8484:127.0.0.1:8484`, danach `http://127.0.0.1:8484` im eigenen Browser.

### Was mit einer laufenden Anmeldung geschieht

Nach dem Ende eines Fensters gelten **zwei Schranken**, jede für sich (Entscheid des Kapitäns vom 10.10.2026):

1. **Der Wartungsserver trennt den Weg.** Seine Firewall prüft **jedes** Paket gegen die Kernel-Menge `fenster`, in beiden Richtungen; steht das Paar nicht mehr darin, kommt nichts mehr durch.
2. **Die Box beendet die Sitzungen des Fensters.** Streicht sie einen Fenster-Schlüssel, beendet sie die Sitzungen, die mit genau diesem Schlüssel begonnen wurden. Das gilt für eine Box, deren Tunnel mit dem `service-tunnel.sh` ab dieser Änderung eingerichtet ist ([Box mit älterem Skript](#eine-box-mit-älterem-skript)).

Die zweite Schranke schließt den Befund vom 10.10.2026: Bis dahin strich die Box nur den Schlüssel. Fehlte nach dem Ende eines Fensters auch die Tabelle des Wartungsservers (`nft flush ruleset`; mit laufendem Dienst bis zu ein Abrufintervall, bei angehaltenem Dienst dauerhaft, siehe [Betrieb](../services/tunnel-dienst/README.md#nftables-neu-laden-oder-stoppen)), lief eine vorher begonnene Sitzung wieder. Jetzt gibt es sie nicht mehr.

| Fall | Schranke 1: der Server trennt den Weg | Schranke 2: die Box beendet die Sitzung | Belegt |
|---|---|---|---|
| Fenster im Portal geschlossen | der Tunnel-Dienst nimmt das Paar beim nächsten Abruf aus der Menge, spätestens ein Abrufintervall (30 s) nach dem Schließen | sobald der Server der Box die Liste ohne den Schlüssel nennt, im selben Lauf, der den Schlüssel streicht | `integration.sh`, Schritt 3; `wartung-anmeldung-probe.sh`, Schritt 4 |
| Fenster abgelaufen | der Kernel lässt das Element ablaufen, auch ohne Dienst und API, zum Ende des Fensters | zur Frist, die die Box selbst führt | `integration.sh`, Schritt 4; Probe, Schritt 4c |
| Dienst auf der VM angehalten | zunächst nichts: Der Dienst baut beim Beenden nichts ab, das Fenster bleibt bis zu seinem geplanten Ende offen, und die Sitzung läuft so lange weiter. Dann trennt der Kernel | zur Frist der Box. Hängt auch der Abholer, streicht der cron-Lauf, höchstens eine Minute später | Probe, Schritt 5 |
| Schlüssel im offenen Fenster ersetzt oder entfernt | nichts: Das Fenster bleibt offen | sobald der Server die neue Liste nennt. Die Sitzung des bisherigen Schlüssels endet, obwohl der Weg offen ist | Probe, Schritt 4b |

- **Solange der Dienst steht, wirkt ein Schließen im Portal nicht.** Es wirkt erst, wenn er wieder abholt, spätestens aber zum geplanten Ende des Fensters: Dann trennt der Kernel, und die Box streicht zu ihrer Frist. Das Portal sagt es in der Zeile „Tunnel-Dienst holt nicht mehr ab“.
- **Was der Techniker sieht.** Ist der Weg noch offen (Schlüssel ersetzt), endet sein `ssh` sofort. Hat der Server den Weg schon getrennt, kommt das Ende bei ihm nicht mehr an: Sein Client merkt es an seinem eigenen Lebenszeichen (`ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=2` endet nach rund 10 s), sonst hängt er.
- **Auf der Box** steht im Log, was geschah: `logread -e vp-wartung` nennt `Sitzung beendet (Dropbear-Prozess …): ihr Fenster-Schluessel ist gestrichen`, `logread -e dropbear` zum selben Prozess `Exit (root) from <Absender>: Terminated by signal`. Beide Zeilen stehen auch in der [Ereignisliste](#wer-wann-auf-einer-box-war) und bleiben dort, wenn das Log längst überschrieben ist.

**Welche Sitzungen enden, welche bleiben.** Gemeint sind nur Sitzungen der SSH-Instanz im Tunnel (Port 2222).

| Sitzung | Wenn ein Fenster-Schlüssel gestrichen wird |
|---|---|
| begonnen mit dem gestrichenen Fenster-Schlüssel | endet |
| begonnen mit einem anderen, noch gültigen Fenster-Schlüssel (zweiter Techniker) | bleibt |
| begonnen mit einem dauerhaften Schlüssel aus `/etc/dropbear/authorized_keys` | bleibt. Auch dann, wenn derselbe Schlüssel zugleich Fenster-Schlüssel war: Dropbear nimmt die erste passende Zeile, und das ist die dauerhafte |
| nicht zuzuordnen | **endet** (im Zweifel endet die Sitzung) |
| alles an Port 22 im LAN | unberührt |

- **Wie die Box zuordnet.** Jede Zeile der Schlüsseldatei im RAM trägt hinter dem Schlüssel eine Marke: `vpf-<Kennzahl>` für einen Fenster-Schlüssel, `vpd-<Kennzahl>` für einen dauerhaften; die Kennzahl ist aus dem Schlüssel berechnet. Dropbear gibt den Prozessen einer Sitzung das erste Wort hinter dem Schlüssel als `SSH_PUBKEYINFO` mit. Der Abholer liest es aus `/proc` und vergleicht es mit dem, was jetzt in der Schlüsseldatei steht.
- **Kein Protokoll, kein gemerkter Zustand.** Die Zuordnung hängt weder am Log der Box (es liegt im RAM und läuft über) noch an einem Arbeitsstand. Sie übersteht einen Neustart von Abholer und Lauscher; ein Neustart der Box beendet ohnehin jede Sitzung. Am Dropbear der Labor-Mango nur gelesen und bestätigt (2025.89 setzt `SSH_PUBKEYINFO`), sonst im Container belegt.
- **Nicht zuzuordnen** ist eine Sitzung, an der kein Prozess mit gültiger Marke hängt:
  - nur eine Weiterleitung (`ssh -N -L …`), ohne Befehl oder Shell auf der Box;
  - begonnen, bevor dieses Skript auf der Box lief;
  - begonnen mit einer dauerhaften Zeile, vor deren Schlüssel Optionen stehen (`no-pty ssh-rsa …`). Solche Zeilen gelten weiter, bekommen aber keine Marke;
  - mitten im Anmelden.

  Sie endet beim nächsten Streichen irgendeines Fenster-Schlüssels. Begründung des Entscheids: Eine zu Unrecht beendete Sitzung meldet sich mit ihrem gültigen Schlüssel sofort wieder an; eine zu Unrecht gelassene höbe die Schranke auf. Ohne ein Streichen bleibt sie.
- **Beenden heißt: wie ein Verbindungsabbruch, nur sofort.** Der Anmeldeprozess von Dropbear bekommt `SIGTERM` (nach 3 s `SIGKILL`). Eine Shell am Terminal endet mit `SIGHUP`; ein Befehl ohne Terminal scheitert an seiner nächsten Ausgabe oder läuft zu Ende. Ein Skript, das der Techniker gestartet hat, wird also nicht mittendrin abgeschossen. Was jemand als root bewusst abgekoppelt gestartet hat, bleibt: Dagegen ist diese Schranke nicht gebaut.
- **Bei jedem Lauf, nicht nur im Augenblick des Streichens.** Der Abholer prüft bei jeder Antwort des Servers, der cron-Lauf jede Minute; bricht ein Lauf zwischen Streichen und Beenden ab, holt es der nächste nach. `service-tunnel.sh <ziel> status` zählt die Sitzungen im Tunnel nach der Art ihres Schlüssels.
- **Die Instanz der Fenster-Schlüssel abräumen** (`abbauen wg_wartung`, `VP_SERVICE_SCHLUESSEL=aus`, Rückfall beim Einrichten) beendet alle ihre Sitzungen, auch die mit dauerhaftem Schlüssel: Danach ist niemand mehr da, der sie zum Ende eines Fensters beendet. Ausgenommen ist nur die Sitzung, über die das Skript selbst läuft.
- **Was bleibt, wie es war:** Das Lebenszeichen von Dropbear (`-K 300`) und die Firewall des Servers sind unverändert. Ein dauerhafter Schlüssel meldet sich in einer Lücke der Server-Firewall weiterhin **neu** an ([oben](#anmeldung-an-der-box-fenster-schlüssel)).

#### Eine Box mit älterem Skript

Eine Box, deren Tunnel vor dieser Änderung eingerichtet wurde, hat nur die erste Schranke:

- Sie streicht den Fenster-Schlüssel und beendet **keine** Sitzung. Jede neue Anmeldung mit dem Schlüssel wird abgewiesen.
- Der Anmeldeprozess einer getrennten Sitzung bleibt stehen, bis Dropbear nach drei unbeantworteten Lebenszeichen aufgibt (`-K 300`: 15 Minuten nach dem letzten Paket, im Log `Keepalive timeout`). So war es bei der Abnahme am 10.10.2026: Fenster-Schlüssel gestrichen 17:40:38, Prozess beendet 17:55:37 (UTC).
- Fehlt in dieser Zeit die Tabelle des Wartungsservers, läuft die Sitzung wieder. Die Probe hält das als Gegenprobe fest (Schritt 11b, mit dem Skript von vorher).
- **Woran man den Stand erkennt:** `service-tunnel.sh <ziel> status` nennt die Zeile `Sitzungen im Tunnel: …` nur mit dem neuen Skript.
- **Der Wechsel** ist ein erneuter Lauf der Befehlszeile aus dem Portal, je Box: [Ausrollen](../edge-light/docs/mango.md#sitzungen-beenden-ausrollen-je-box). Portal, API und Tunnel-Dienst ändern sich nicht.

### Wer wann auf einer Box war

Entscheid des Kapitäns vom 12.10.2026. Befund vom 11.10.: Das Log der Box (`logread`) liegt im Arbeitsspeicher, fasst 128 KiB und reichte an der Labor-Mango vier Stunden zurück. Gefüllt wurde es von Zeilen, die jede Minute kamen, vor allem von cron, das jeden Start eines Zeitauftrags protokolliert. Eine Anmeldung war neun Stunden später an der Box nicht mehr belegbar.

**Wo man nachliest:**

| Wo | Was | Wie lange |
|---|---|---|
| Box: `service-tunnel.sh <ziel> status` (die letzten zehn) oder auf der Box `/usr/libexec/vp-wartung/schluessel-holen.sh ereignisse` (alle) | die Ereignisliste: wann welcher Fenster-Schlüssel kam und ging (Zugang), jede Anmeldung durch einen Wartungstunnel (Fingerabdruck des Schlüssels, Absender, Zeit), jedes Ende einer Sitzung mit Grund, welche Sitzung die Box beendet hat | die letzten 200 bis 250 Zeilen, also mindestens die letzten rund 35 bis 50 Sitzungen, ohne Frist. Übersteht Neustart und `sysupgrade`; `abbauen wg_wartung` und `VP_SERVICE_SCHLUESSEL=aus` löschen sie |
| Box: `logread` | alles Übrige, auch Anmeldungen an Port 22 im LAN, abgewiesene Versuche und Meldungen des Abholers | Stunden; leer nach einem Neustart |
| Wartungs-VM: Journal des Tunnel-Dienstes | Fenster geöffnet und geschlossen, Schlüssel an eine Box ausgegeben (mit Zugang und Fingerabdruck) | dauerhaft |
| Portal: Protokoll der Fernwartung | wer wann für welchen Zugang ein Fenster geöffnet oder geschlossen hat, mit Grund | dauerhaft |

- **Die Anmeldung selbst steht nur auf der Box.** Portal und VM wissen, dass ein Fenster offen war und der Schlüssel abgeholt wurde; ob sich jemand angemeldet hat, von wo und wann die Sitzung endete, sagt nur die Liste der Box. Weitergemeldet wird davon nichts.
- **Kein Schlüssel in der Liste,** nur der Zugang (in der Zeile des Fenster-Schlüssels) und der Fingerabdruck (in der Zeile der Anmeldung). Das Portal zeigt denselben Fingerabdruck am Zugang.
- **Die Zeit ist die Uhr der Box.** Direkt nach einem Neustart ohne Zeitabgleich kann sie falsch gehen; die Reihenfolge der Zeilen stimmt trotzdem.
- **cron protokolliert die Starts seiner Zeitaufträge nicht mehr** (`cronloglevel 9`, für alle Zeitaufträge der Box). Fehler von cron selbst stehen weiter im Log. Bleibt der cron-Lauf aus, der verfallene Fenster-Schlüssel streicht, meldet es der Abholer im Log, und `status` zeigt es.
- **Was der Liste fehlen kann:** was in der letzten Minute vor einem Stromausfall geschah, und ein Ereignis aus einer Minute, in der die Box mehr als 200 Zeilen protokolliert hat (der Abholer liest nur das Ende des Logs, [Begründung](../edge-light/docs/mango.md#proben-von-der-box-busybox-unter-2512)).
- **Die Liste ist kein Beweis gegen jemanden mit root auf der Box:** Wer dort root ist, kann sie ändern oder löschen.

Aufbau, Obergrenze, die Abwägung gegen einen größeren Protokollspeicher und gegen eine Liste im RAM: [mango.md](../edge-light/docs/mango.md#protokoll-der-box-wer-wann-auf-einer-box-war).

**Wer das Portal verwaltet, verwaltet damit die Anmeldung.** Sobald die Boxen Fenster-Schlüssel abholen, genügt ein Konto mit der Rolle `platform-admin`, um als root auf eine verbundene Box zu kommen: Zugang mit eigenem Schlüssel anlegen, Fenster öffnen. Vorgesehen sind deshalb ein zweiter Faktor für Portal-Administratoren vor der ersten Kundenbox auf diesem Weg und, vorgemerkt, vom Portal signierte Freigaben. Beides ist nicht umgesetzt.

## Web-App der Box im Fenster

Entscheid des Kapitäns vom 09.10.2026: Die Web-App der Box (Port 8484) ist im offenen Fenster für **jeden** Techniker frei, nicht mehr je Techniker-Adresse. `service-tunnel.sh` gibt sie beim Einrichten des Tunnels für das ganze Techniker-Netz frei.

- **Die Schranke ist allein das Fenster am Wartungsserver.** Die Box prüft nur, dass ein Paket durch den Tunnel und aus dem Techniker-Netz kommt. Wer es ist und ob ein Fenster offen ist, prüft sie nicht. Einzelheiten und die engere Wahl: [mango.md](../edge-light/docs/mango.md#was-die-box-im-tunnel-selbst-prüft).
- **Die Web-App hat keine Anmeldung.** Anders als bei SSH gibt es hier keine zweite Schranke. Ein Konto mit der Rolle `platform-admin` genügt damit schon heute, um die Web-App einer verbundenen Box zu bedienen: Zugang anlegen, Fenster öffnen.
- **Im Browser des Technikers:** `http://<Box-Adresse>:8484`, solange das Fenster offen ist. Das Portal nennt bisher nur den Weg über `ssh … -L 8484:127.0.0.1:8484`; er funktioniert weiter und braucht die Anmeldung an der Box.
- **Eine Box, deren Tunnel vor dem 09.10.2026 eingerichtet wurde,** bekommt die Freigabe, wenn die Befehlszeile aus dem Portal noch einmal läuft. Der Lauf fasst den Tunnel nicht an, wenn sich an ihm nichts ändert.

## Entscheide zum Betrieb (09.10.2026)

Nach dem Gesamttest mit der Labor-Box hat der Kapitän entschieden:

| Punkt | Entscheid | Stand |
|---|---|---|
| SSH zur Wartungs-VM | aus `192.168.0.0/24` und `192.168.178.0/24` erlaubt, sonst von nirgends | Regel in `/etc/nftables.d/vm-firewall.nft` auf der VM; am 09.10. aus beiden Netzen geprüft |
| Web-App 8484 im Tunnel | im offenen Fenster für alle Techniker | Box-Seite umgesetzt ([oben](#web-app-der-box-im-fenster)) |
| Paket `nftables` auf der VM | von den automatischen Updates ausgenommen, wird von Hand aktualisiert | `/etc/apt/apt.conf.d/53vp-nftables-von-hand` auf der VM |
| Labor-Mango `edge-5t2dcy6` | bleibt als Test-Box am Wartungsserver | verbunden, `10.10.16.2` |
| SSH 2222 der Box außerhalb des Tunnels | die Box weist es ab, auch im LAN und auch bei Tunnel unten | Box-Seite umgesetzt (`service-tunnel.sh`, eigene Firewall-Kette); gilt für eine Box, sobald das Skript erneut läuft |

**`nftables` von Hand aktualisieren.** Das Paket startet bei einer Aktualisierung `nftables.service` neu. Das leert den ganzen Regelsatz und schließt offene Fenster, bis der Tunnel-Dienst sie wieder öffnet ([Betrieb](../services/tunnel-dienst/README.md#betrieb)). `unattended-upgrades` übergeht deshalb `nftables` und die versionsgleiche Bibliothek `libnftables1`; alle anderen Sicherheitsupdates laufen weiter von selbst. Von Hand, wenn kein Fenster offen ist:

```bash
vp-tunnel-dienst status          # Offene Fenster: 0
apt update && apt install --only-upgrade nftables libnftables1
vp-tunnel-dienst status          # Firewall-Basis stimmt: ja
```

## Soll-Stand

`GET /api/v1/fernwartung/soll` liefert Version 1, Vektor: [`fernwartung-soll-v1.example.json`](contracts/fernwartung-soll-v1.example.json).

- `peers`: alle aktiven Zugänge mit `art`, `id`, `kennung`, `publicKey`, `adresse`. Gesperrte und gelöschte Zugänge stehen nicht darin.
- `sshPublicKey` an einem Techniker-Peer: sein öffentlicher SSH-Schlüssel in Normalform. Das Feld steht nur dort, wo einer hinterlegt ist; sonst fehlt es ganz, an einer Box immer. Für WireGuard und die Firewall spielt es keine Rolle.
- `fenster`: nur die **jetzt** offenen Fenster, deren Box und Techniker aktiv sind. Sie verweisen über `boxId`/`technikerId` auf Peers.
- Geplante Fenster stehen bewusst nicht darin. Der Dienst öffnet nur, was ein frisch abgeholter Stand jetzt verlangt.

Den Vektor lesen beide Seiten: `FernwartungRegelnTest` (Java) prüft die Felder der Serialisierung, der Tunnel-Dienst liest ihn in seinem Test streng ein.

**Der Soll-Stand wächst nur additiv, die Version bleibt 1.** Im Betrieb überliest der Dienst Felder, die er nicht kennt; sein Test liest den Vektor dagegen streng. Ein neues Feld braucht deshalb Vektor, Java-Test und Go-Struktur in derselben Änderung. Vor dem Ausliefern des Portals belegt `services/tunnel-dienst/test/vertraeglichkeit.sh <commit>`, dass der Stand, der gerade auf der VM läuft (`vp-tunnel-dienst version`), den heutigen Vektor genauso umsetzt wie ohne die neuen Felder. Für `sshPublicKey` ist das mit dem Stand `db32a784ce55` belegt: Das Portal darf vor dem Tunnel-Dienst ausgeliefert werden.

## Rückmeldung des Tunnel-Dienstes

Entscheid des Kapitäns (K3 a, 08.10.2026): Der Tunnel-Dienst darf dem Portal Rückmeldung geben, nur Zustandsangaben, über eine eigene Route. Damit sieht der Techniker im Portal, **warum** er nicht hineinkommt. Vertrag mit Vektor: [`fernwartung-rueckmeldung-v1.md`](contracts/fernwartung-rueckmeldung-v1.md); Seite des Dienstes: [Tunnel-Dienst](../services/tunnel-dienst/README.md#rückmeldung-ans-portal).

**Was der Dienst meldet, und sonst nichts:** je Box „verbunden seit“ und „zuletzt gefragt um“, je Fenster „Schlüssel abgeholt um“; dazu, seit wann er läuft und ob er Schlüssel ausgibt. Kein Schlüssel, kein Fingerabdruck, keine Adresse: Box und Fenster sind nur über die `id` benannt, die das Portal selbst vergeben hat.

| Angabe | Woran der Dienst sie festmacht |
|---|---|
| verbunden | der letzte WireGuard-Handshake der Box ist höchstens 3 Minuten alt |
| zuletzt gefragt | die Box hat die Schlüsselausgabe aufgerufen. Das tut nur eine Box mit dem `service-tunnel.sh` ab Schritt 3 |
| Schlüssel abgeholt | die Box hat in einer späteren Anfrage den Prüfwert der Liste genannt, die den Schlüssel enthält. Das tut sie erst, nachdem sie die Liste geprüft und in ihre Schlüsseldatei geschrieben hat |

**Was das Portal daraus zeigt,** an jeder Box (Spalte „Verbindung“, auf der Box-Seite in der Karte „Fernwartung“) und an jedem offenen Fenster, immer mit dem Alter der Angabe („Stand: vor 20 s“):

| Am offenen Fenster | Wann |
|---|---|
| Alles bereit | die Box ist verbunden und hat den Schlüssel abgeholt |
| Schlüssel noch nicht abgeholt | die Box ist verbunden, der Schlüssel fehlt ihr noch. Der Satz nennt den Grund: Sie fragt und bekommt ihn gleich; sie hat nie gefragt (Tunnel mit einem älteren Skript eingerichtet); die Schlüsselausgabe am Wartungsserver ist aus |
| Box nicht verbunden | der Dienst meldet die Box ohne Handshake in den letzten 3 Minuten. Das Fenster ist offen, aber niemand erreicht die Box |
| Kein SSH-Schlüssel am Zugang | am Techniker-Zugang steht keiner. Das weiß das Portal selbst, mit und ohne Meldung |
| Stand unbekannt | keine Meldung, eine veraltete, oder die letzte nennt Box oder Fenster nicht |

- **Unbekannt ist kein „nicht verbunden“.** Kam nie eine Meldung (auf dem Wartungsserver läuft ein Dienst ohne Rückmeldung), ist die letzte älter als 3 Minuten (VM oder Dienst nicht erreichbar) oder nennt sie die Box nicht, sagt das Portal genau das. Bei einer veralteten Meldung nennt es, was damals galt, als Vergangenes. Die Regeln: `adminFernwartung.ts` (`rueckmeldungLage`, `boxVerbindung`, `boxAnmeldung`).
- **Die Seite holt den Stand alle 20 s neu,** solange sie sichtbar ist. Nach dem Öffnen eines Fensters steht dort bis zur nächsten Meldung „Stand unbekannt“, danach folgt die Zeile ohne Zutun.
- **Das Alter misst die API.** Sie hält je Box und Fenster fest, wann sie die Meldung angenommen hat. Eine Meldung, deren Uhr um mehr als 5 Minuten von der der API abweicht, weist sie ab.
- **„Verbunden seit“ gleich dem Start des Dienstes** heißt: mindestens seit dann. Das Portal schreibt es so.

**Die Meldung ist Anzeige.** Sie fließt nie in den Soll-Stand zurück, aus dem der Dienst Peers, Fenster und Schlüsselausgabe ableitet:

- Die API hält sie in eigenen Tabellen; `FernwartungService` und `FernwartungRepository`, die den Soll-Stand bilden, kennen weder diese Tabellen noch die Klassen der Rückmeldung (`FernwartungRueckmeldungRegelnTest`).
- Gegen die laufende API belegt: Eine Meldung „nicht verbunden, nicht abgeholt“ lässt Soll-Stand, Zugänge, Fenster und Protokoll Byte für Byte unverändert (`FernwartungApiTest.dieRueckmeldungIstAnzeigeUndAendertDenSollStandNie`).
- Eine falsche Meldung kann im Portal etwas Falsches anzeigen. Einen Weg öffnen oder einen Schlüssel ausgeben lassen kann sie nicht.

**Die API prüft und begrenzt:** höchstens 2 MiB, streng gelesen (kein unbekanntes Feld), je Liste höchstens 10 000 Einträge, jede `id` eine UUID und nur einmal. Nennt die Meldung eine Box oder ein Fenster, das die API nicht kennt, wird sie als Ganzes abgewiesen (422) und nichts gespeichert.

**Die Rückmeldung stört die Arbeit des Dienstes nicht:** eigener Aufruf neben dem Abgleich, 5 s Frist, kein eigenes Token, keine Wiederholung. Scheitert er, laufen Soll-Stand, Firewall und Schlüsselausgabe unverändert weiter ([Tunnel-Dienst](../services/tunnel-dienst/README.md#rückmeldung-ans-portal)).

**VM und Cloud werden getrennt ausgerollt; jede Reihenfolge ist ohne Schaden:**

| Stand | Was geschieht |
|---|---|
| neue API, alter Dienst | es kommt keine Meldung. Das Portal zeigt „Tunnel-Dienst meldet keinen Zustand“ und an Box und Fenster „unbekannt“. Alles andere wie bisher |
| neuer Dienst, alte API | die Route gibt es nicht (404). Der Dienst schreibt es einmal als Hinweis ins Journal und fragt alle 10 Minuten wieder nach; Peers, Fenster und Schlüsselausgabe laufen wie bisher |
| beide neu | spätestens 10 Minuten nach dem zweiten Ausrollen (oder sofort nach einem Neustart des Dienstes) stehen die Angaben im Portal |

Empfohlene Reihenfolge: erst die Cloud (Migration, API, Portal), dann der Dienst auf der VM. Dann meldet der Dienst vom ersten Lauf an.

## Was das Portal weiß und was nicht

- **Weiß:** den Soll-Zustand und wann der Tunnel-Dienst ihn zuletzt abgeholt hat.
- **Weiß vom Tunnel-Dienst, mit Alter:** ob eine Box verbunden ist, wann sie zuletzt nach Schlüsseln gefragt hat und ob sie den SSH-Schlüssel eines Fensters abgeholt hat ([Rückmeldung](#rückmeldung-des-tunnel-dienstes)). Ein Fenster, das die Meldung nennt, steht in der Kernel-Menge des Servers.
- **Weiß nicht:** ob eine Anmeldung an der Box gelungen ist, und was ein Techniker dort tut. Die Anmeldung steht nur auf der Box, in ihrer [Ereignisliste](#wer-wann-auf-einer-box-war) (`service-tunnel.sh <ziel> status`); was jemand dort tut, steht nirgends. Ebenso nicht, ob die Firewall des Servers gerade filtert: Auf der VM sagt es `vp-tunnel-dienst status` („Firewall-Basis stimmt“).
- **Fehlt die Meldung oder ist sie alt,** weiß das Portal über Boxen und Fenster nur den Soll-Zustand. Die Oberfläche benennt das, statt es zu überspielen. Auf der VM selbst zeigt `vp-tunnel-dienst status`, wann eine Box zuletzt nach Schlüsseln gefragt hat, und das Journal, welcher Schlüssel ihr ausgegeben wurde.

## Bausteine

- Tunnel-Dienst mit Installationsanleitung: `services/tunnel-dienst/`. Erste Einrichtung auf einer echten VM (Debian 13) am 08.10.2026; was dabei belegt wurde und was offen ist, steht dort unter „Prüfen“.
- Box-Seite und beaufsichtigter Wechsel des Piloten: `edge-light/openwrt/service-tunnel.sh`, `edge-light/docs/mango.md`. Proben: `edge-light/test/service-tunnel-probe.sh` (Einrichtung, OpenWrt 24.10) und `edge-light/test/wartung-anmeldung-probe.sh` (Anmeldung mit Fenster-Schlüsseln, OpenWrt 25.12).
