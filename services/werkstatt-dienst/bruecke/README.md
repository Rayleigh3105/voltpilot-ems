# Werkbank-Brücke

Der Werkstatt-Anschluss: ein Raspberry Pi an der Werkbank (WI-13 B). Er hängt per **WLAN** im Netz, seine
**Netzwerkbuchse** ist der Werkstatt-Anschluss. Dort steckt das orange Kabel WERKSTATT, dessen anderes Ende in die
Buchse LAN der neuen Mango kommt. Die Buchse WAN der Mango bleibt frei.

Warum so: Eine Mango ab Werk lässt nur über LAN jemanden herein, verteilt dort aber selbst Adressen (192.168.8.x)
und darf deshalb nicht ins normale Netz. Die Brücke ist ein eigenes kleines Netz nur für diese eine Mango; der
Dienst im Cluster spricht durch sie mit der Mango, und die Mango kommt über sie ins Internet.

Auf der Brücke läuft **kein eigenes Programm**, nur Konfiguration. Alles Denken bleibt im
[Werkstatt-Dienst](../README.md): Er richtet die Brücke ein, prüft sie und spielt neue Fassungen auf.

## Was auf der Brücke ist

| Teil | Was | Datei (Vorlage) |
|---|---|---|
| Netz | `wlan0` ins Netz, wie vom Imager eingerichtet, Energiesparen aus (PS-13). `eth0` mit festen Adressen 192.168.8.2, 192.168.1.2 und 10.213.0.2 (je /24), kein DHCP, kein Standardweg, kein IPv6 | `netz/vp-werkstatt.nmconnection`, `netz/90-werkbank.conf`, `sysctl/90-werkbank.conf` |
| Firewall und Durchleitung | Von `eth0` nur ins Internet (NAT über `wlan0`), nie in private Netze; auf die Brücke nur SSH aus dem Cluster; vom Werkstatt-Anschluss nichts | `nftables/werkbank.nft`, `systemd/vp-werkbank-firewall.service` |
| SSH | nur der Benutzer `werkstatt`, nur mit Schlüssel, Weiterleitung nur zu den Werkstatt-Adressen der Box; die Schlüssel root-eigen in `/etc/ssh/vp-werkbank/werkstatt` | `ssh/10-werkbank.conf` |
| Status | `vp-werkbank-status`: Kabel, Adressen, WLAN, Durchleitung, Firewall und wer an den Box-Adressen antwortet (je zwei ARP-Anfragen, kein Absuchen), als eine JSON-Zeile | `sbin/vp-werkbank-status` |
| Pflege | `vp-werkbank-pflege` / `vp-werkbank-einrichten`: ein Paket mit genannter Prüfsumme einspielen | `bin/`, `sbin/` |
| sudo | `werkstatt` darf als root genau Status und Einrichten | `sudoers/vp-werkbank` |
| Einrichten, Prüfen | `einrichten.sh` (wiederholbar), `pruefen.sh` (als `vp-werkbank-pruefen`: Durchleitung, Sperren, kein DHCP, SSH, sudo) | `einrichten.sh`, `pruefen.sh` |

Die drei Schlüssel des Dienstes, jeder für eine Aufgabe (erzwungen in `authorized_keys`):

| Schlüssel | darf | darf nicht |
|---|---|---|
| Status | nur `vp-werkbank-status` (über sudo) | keine Shell, keine Weiterleitung |
| Weiterleitung | Verbindungen zu 192.168.8.1:22/80, 192.168.1.1:22/80, 10.213.0.1:22/8484 | keine Shell, kein anderes Ziel |
| Pflege | nur `einrichten <sha256>` mit dem Paket auf der Standardeingabe | sonst nichts |

Dazu der Notfall-Schlüssel mit einer Shell als `werkstatt` (ohne sudo außer den zwei Befehlen).

**Nicht auf der Brücke:** kein VoltPilot-Programm, kein Docker, keine Kundendaten, kein DHCP-Server, kein Weg für
die Mango ins Netz der Werkbank, kein Geheimnis außer dem eigenen Host-Schlüssel und dem WLAN-Kennwort.

## Einmal aufstellen

Du brauchst: einen Raspberry Pi 3B+, 4 oder 5 mit WLAN, eine SD-Karte, ein Netzteil, das orange Kabel WERKSTATT
und ein USB-Netzteil für die Mango. Keinen USB-Netzwerkadapter, keinen Switch.

1. **Karte schreiben** mit dem Raspberry Pi Imager ab 2.0 (ein älterer überspringt die Einstellungen bei Trixie
   still, PS-7):
   - Gerät: dein Pi; System: **Raspberry Pi OS Lite (64-bit)**.
   - Einstellungen: Hostname `vp-werkbank`; Benutzer `vpwerkstatt` mit einem langen Zufallspasswort (wird nicht
     gebraucht); **WLAN** mit Name und Kennwort des Werkstatt-Netzes, Land DE; Zeitzone Europe/Berlin.
   - SSH: an, **nur mit öffentlichem Schlüssel**, und dort den öffentlichen Werkstatt-Schlüssel
     (`werkbank-einrichten.pub`, [Runbook](../docs/runbook.md#schlüssel)) eintragen.
2. Karte in den Pi, das orange Kabel WERKSTATT in seine Netzwerkbuchse (das andere Ende bleibt frei, bis eine Mango
   kommt), Strom.
3. Im Router die Adresse des Pi suchen (`vp-werkbank`) und ihm eine **feste Adresse** geben.
4. Diese Adresse als `VP_WERKBANK_ADRESSE` eintragen ([Runbook](../docs/runbook.md#gitops)).

Den Rest macht der Dienst: Er meldet sich als `vpwerkstatt` mit dem Werkstatt-Schlüssel an, hält den
Host-Schlüssel der Brücke fest, spielt das Paket auf und ruft `einrichten.sh` auf. Danach kommt `vpwerkstatt` nicht
mehr herein, nur noch `werkstatt` mit den Schlüsseln oben. In der Anzeige steht „Brücke bereit“.

`einrichten.sh` installiert fehlende Pakete (`nftables`, `iputils-arping`) über das WLAN, legt nur seine eigenen
Dateien an und bricht ab, bevor es eine kaputte SSH-Konfiguration übernimmt (`sshd -t`). Liegt das Netz des WLANs
selbst in 192.168.8.x, 192.168.1.x oder im LAN-Netz der Boxen, richtet es nicht ein: Die Antworten der Mango fänden
dann nicht zurück.

## Prüfen

Auf der Brücke (mit dem Notfall-Schlüssel als `werkstatt`): `sudo -n /usr/local/sbin/vp-werkbank-status`. Als
root: `vp-werkbank-pruefen` – jede Zeile `ok:` oder `FEHLER:`. In der Werkstatt-Anzeige des Dienstes stehen
dieselben Werte.

Im Container geprüft: `../test/bruecke-probe.sh` (Debian trixie, echtes `einrichten.sh`, nftables, OpenSSH,
eingerichtet vom echten Programm). Nicht im Container geprüft ist der Weg über NetworkManager (die Probe nutzt
den Rückfall mit `ip`) und das echte WLAN: Prüfsteine PS-11 bis PS-13 im
[Runbook](../docs/runbook.md#prüfsteine-am-echten-gerät).

## Neu aufsetzen

Karte neu schreiben wie oben. Weil die Brücke damit einen neuen Host-Schlüssel hat, den festgehaltenen im Dienst
löschen ([Runbook, Störungen](../docs/runbook.md#störungen)); der Werkstatt-Schlüssel muss dafür wieder im Secret
stehen.
