# Werkstatt: eine Box einrichten, bevor sie die Werkstatt verlässt

Stand 26.10.2026. Erster Schnitt aus dem Bericht `voltpilot-box-einrichtung-portal` (Abschnitt 3.5), mit den
Entscheiden des Kapitäns vom 26.10.2026. Die Seite liegt im Portal unter **Geräte › Werkstatt**
(`#/werkstatt`, eine Box: `#/werkstatt?box=<referenz>`), nur für VoltPilot-Admins.

## Was die Seite tut

| Teil | Was | Wo |
|---|---|---|
| Ablauf | Die 13 Schritte für ein Edge Light (GL.iNet Mango mit OpenWrt) als Liste mit fertigen Befehlen, je Schritt „was man sehen sollte“ und ein Haken. Die Befehle laufen weiter am eigenen Rechner, mit dem Repository. | `frontend/portal/src/werkstatt.ts` (`schritte`) |
| Register | Jede Box kommt mit ihrer Referenz in die Liste (Schritt 5); die Haken davor nimmt sie mit. Die Liste zeigt je Box den Fortschritt, den Tunnel und die Abnahme. | Tabelle `werkstatt_box` |
| Tunnel | Tunnel-Schlüssel hinterlegen und die Befehlszeile für `service-tunnel.sh` über die Routen der [Fernwartung](fernwartung.md); die Befehlszeile bleibt stehen und nennt die Box beim Namen am Tisch (`mango`). | `PUT /api/v1/admin/fernwartung/boxen/{ref}/schluessel` |
| Werkstatt-Probe | Ein Knopf öffnet ein Fenster für 30 Minuten (wie die Werkstatt-Regel in `mango.md`) mit dem Grund „Werkstatt-Probe“ für einen Zugang mit SSH-Schlüssel, die Seite zeigt den Stand aus Portal und Tunnel-Dienst, ein zweiter Knopf schließt es wieder. Anmelden muss sich ein Mensch; „Alles bereit“ allein genügt nicht. | Fenster der Fernwartung |
| Root-Passwort (Entscheid 3a) | Je Box ein eigenes, im Browser erzeugt (20 Zeichen ohne verwechselbare, rund 116 Bit), einmal angezeigt; abgelegt wird es in der Passwortablage. Es geht nie an die API und steht in keinem Speicher. Gespeichert wird nur der Haken. | `erzeugePasswort` |
| LAN-Netz (Entscheid 6a) | Vorschlag `10.213.0.1/24` (wie an der Labor-Mango). Die API lehnt übliche Heimnetze (192.168.0/1/2/8/178.x, 10.0.0.x), die Netze des Wartungsservers und alles außerhalb von RFC 1918 ab. Die Seite schreibt den `uci`-Befehl samt Neustart. Kein Skript tut das; ein eigenes lohnt erst mit dem Einmal-Code. | `LanNetz.java`, `lanBefehl` |
| Beschriftung (Entscheid 8, geändert) | Kein Aufkleber: Referenz in Klarschrift und QR-Code mit dem Direktlink kommen aufs Gehäuse. Die Seite zeigt den Inhalt und den QR-Code, gibt eine SVG-Vorlage in echter Größe (Modul 0,84 mm) zum Probedruck auf Papier und nennt den Befehl für die Druckdatei des Gehäuses (`bauen.sh --referenz <referenz>` im Gehäuse-Programm, [Kennung](../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)). Was gedruckt wird, ist Modul für Modul, was die Seite zeigt: beide prüfen gegen [werkstatt-beschriftung.json](contracts/werkstatt-beschriftung.json). | `BeschriftungKarte`, `qrCode.ts` |
| Abnahme | Das Abnahmeprotokoll (das „Übergabeprotokoll“ der Werkstatt-Regel in `edge-light/docs/mango.md`): Host-Schlüssel, Fassung, die acht Prüfungen der Regel, Tunnel-Adresse, LAN-Netz, das Fenster der Probe mit dem, was der Tunnel-Dienst dazu gemeldet hatte, wer, wann. Append-only; eine neue Abnahme ist ein neuer Eintrag. | Tabelle `werkstatt_abnahme` |
| Versand (Entscheid 5c) | Der Ablauf endet mit der Abnahme. Oben auf der Seite und am Ende steht: keine Box mit Stufe 1 an einen Kunden, bevor Stufe 2 steht. Es gibt keinen Zustand „versandbereit“. | `VERSAND_SATZ` |
| Docker-Box (Entscheid 9a) | Steht im Register (`boxArt: edge-app`), hat aber keinen Ablauf und keine Abnahme: Für sie gibt es keinen Wartungstunnel und damit keine Anmeldeprobe. | – |

## Die Abnahme

Die API nimmt eine Abnahme nur an, wenn

- die Box im Register steht und ein Edge Light ist,
- jede Prüfung der geschlossenen Liste abgehakt ist (Vektor [`contracts/werkstatt-pruefungen.json`](contracts/werkstatt-pruefungen.json),
  Zwillinge `WerkstattPruefungen.java` und `werkstatt.ts`, beide Tests lesen den Vektor),
- der Host-Schlüssel die Form `SHA256:` + 43 Zeichen hat (wie `ssh-keygen -lf` ihn zeigt) und die Fassung die
  Form eines Programmnamens (`edge-light-g…`),
- ein LAN-Netz festgehalten und ein Tunnel-Schlüssel hinterlegt ist,
- das Fenster der Probe zu dieser Box gehört, offen war und jetzt zu ist (Werkstatt-Regel 6: erst schließen, dann
  der abgewiesene Versuch). Ein abgesagtes Fenster war nie offen und zählt nicht.

Die Abnahme beruht auf den Haken des Technikers. Ob ein Passwort gesetzt ist und welcher Schlüssel auf der Box
liegt, kann das Portal nicht prüfen. Was der Tunnel-Dienst zum Fenster gemeldet hatte, steht im Protokoll als
Anzeige (`schluesselAbgeholtUm` null = keine Meldung nannte es abgeholt) und entscheidet nichts.

## Routen

Alle unter `/api/v1/admin/werkstatt`, nur `platform-admin` (`AdminWerkstattController`). Die Referenz wird wie bei
der Kopplung geschrieben (`edge-` klein); ein falsches Prüfzeichen ist 422.

| Route | Was |
|---|---|
| `GET /grundlagen` | die Kennungen der Prüfungen und der Vorschlag fürs LAN |
| `GET /boxen`, `GET /boxen/{ref}` | das Register mit Schritten und Abnahmen (neueste zuerst) |
| `POST /boxen` | aufnehmen: 201 neu, 200 schon da (unverändert); `schritte` = was vorher erledigt war |
| `PUT /boxen/{ref}/schritte/{schritt}` | `{"erledigt": true\|false}`, idempotent |
| `PUT /boxen/{ref}/lan-netz` | `{"lanNetz": "10.213.0.1/24"}`; 422 mit Grund |
| `POST /boxen/{ref}/abnahme` | das Protokoll; 201, sonst 404/409/422 mit Grund |

## Daten

Wie die Tabellen der Fernwartung globale Betriebsdaten ohne Mandant (eine Box in der Werkstatt gehört noch
niemandem): keine Rechte für die App-Rolle, RLS mit `FORCE` und ohne Policy als zweiter Riegel, gelesen und
geschrieben nur über die BYPASSRLS-Rolle `voltpilot_admin` (`WerkstattRepository`). Keine Zeile wird gelöscht;
`werkstatt_abnahme` ist append-only an der Datenbankgrenze. Migration `V20261026200000__werkstatt.sql`.

## Direktlink vom Gehäuse (Plan D3)

Der QR-Code trägt `https://portal.voltpilot.de/k/<referenz>` (42 Zeichen, QR-Code Fassung 3, 29 × 29 Module,
Fehlerkorrektur M). nginx leitet `/k/<referenz>` auf `/#/k/<referenz>` um (`frontend/portal/nginx.conf`). Das
Portal liest die Referenz beim Start, prüft ihr Prüfzeichen, legt sie in den `sessionStorage` dieses Tabs und nimmt
den Link aus der Adresse (`koppelLink.ts`). So übersteht sie die Anmeldung und das Neuladen nach der
Selbstregistrierung (K1). Danach:

- ein Kunde ohne Anlage: der Einrichtungs-Assistent, im Schritt „Box“ steht die Referenz im Feld;
- ein Kunde mit Anlage: der Aufbau der ersten Anlage mit „VoltPilot-Box hinzufügen“ (`?neu=box&ref=`);
- ein VoltPilot-Admin: die Werkstatt bei genau dieser Box.

Verbunden wird nie von selbst; der Kunde drückt selbst auf „Verbinden“.

## Was fehlt

| Was | Warum noch nicht |
|---|---|
| Probedruck der Kennung | Die Druckdatei je Box gibt es (`bauen.sh --referenz <referenz>`, [Kennung](../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)); geprüft ist sie bis zum G-Code, gedruckt nicht. Ob ein Telefon den gedruckten Code liest, zeigt erst der Probedruck des Betreibers. |
| Einmal-Code (Weg 2) | nächster Schnitt nach dem Bericht; die Box löst ihn selbst ein |
| Geräteschlüssel festhalten (D2, Entscheid 7a) | eigener Schnitt; heute kann jeder, der die Referenz kennt, eine Zertifikatsanfrage hinterlegen |
| Zweiter Faktor am Portal | Entscheid 10b: später |
| Die kleinen Korrekturen aus Abschnitt 3.5 | laufen in einem eigenen PR (`install.sh`, `schluessel-holen.sh`, `mango.md`) |
