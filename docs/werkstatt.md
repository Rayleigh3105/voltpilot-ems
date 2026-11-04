# Werkstatt: eine Box einrichten, bevor sie die Werkstatt verlässt

Stand 02.11.2026. Erster Schnitt aus dem Bericht `voltpilot-box-einrichtung-portal` (Abschnitt 3.5) vom 26.10.2026,
seit der Werkstatt-Automatik (WI-8 A) mit den Bildschirmen des Werkstatt-Dienstes. Die Seite liegt im Portal unter
**Geräte › Werkstatt** (`#/werkstatt`, eine Box: `#/werkstatt?box=<referenz>`, die Werkbank:
`#/werkstatt?werkbank=1`), nur für VoltPilot-Admins (WI-10 B).

## Was die Seite tut

Die Box richtet der [Werkstatt-Dienst](#automatisch-der-werkstatt-dienst-v1a) ein, jeden Schritt mit Beleg. Die
Seite zeigt, was er tut; Handschritte, Passwort-Generator und Probe-Knöpfe gibt es im Portal nicht mehr.

| Teil | Was | Wo |
|---|---|---|
| Werkbank (M1–M6) | Die geführten Bildschirme für die Person an der Werkbank: Box-Art wählen (Raspberry Pi kommt mit V2), Mango anschließen, Fortschritt in sechs Phasen mit Restzeit, der eine Handgriff am Startlader, Fertig mit Referenz und QR-Code, Problem mit Grund. Kein „Weiter“-Knopf: Der Dienst merkt Handgriffe selbst. Fachwörter stehen nur unter „Details für Technik“. „Nochmal versuchen“ heißt: Kabel kurz abziehen; einen Befehlsweg vom Portal zum Dienst gibt es nicht. | `WerkstattBank.tsx`, `werkstattBank.ts` |
| Übersicht (D1) | Freigabe („Werkstatt freigeben“, „Freigabe beenden“), Werkbank-Brücke, die Boxen mit ihrem Stand (läuft, Problem, abgenommen, nur im Register) und, für die gewählte Box, ihre Phasen, die Abnahme mit den Belegen und die Beschriftung. | `WerkstattPage.tsx` |
| Stand des Dienstes | Die [Ansicht](contracts/werkstatt-ansicht-v1.md) über `GET /api/v1/admin/werkstatt/dienst`, die Seite fragt alle 5 s nach. Ist die letzte Meldung älter als 60 s, steht dort „Der Werkstatt-Dienst meldet sich nicht“ statt eines alten Stands. | – |
| Beschriftung (Entscheid 8, geändert) | Kein Aufkleber: Referenz in Klarschrift und QR-Code mit dem Direktlink kommen aufs Gehäuse. Die Seite zeigt den Inhalt und den QR-Code, gibt eine SVG-Vorlage in echter Größe (Modul 0,84 mm) zum Probedruck auf Papier und nennt den Befehl für die Druckdatei des Gehäuses (`bauen.sh --referenz <referenz>` im Gehäuse-Programm, [Kennung](../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)). Was gedruckt wird, ist Modul für Modul, was die Seite zeigt: beide prüfen gegen [werkstatt-beschriftung.json](contracts/werkstatt-beschriftung.json). | `BeschriftungKarte`, `qrCode.ts` |
| Abnahme | Das Abnahmeprotokoll (das „Übergabeprotokoll“ der Werkstatt-Regel in `edge-light/docs/mango.md`): Host-Schlüssel, Fassung, die neun Prüfungen der Regel (seit K5 mit „Update-bereit“: signierte Fassung als bestätigter Stand, Vertrauens-Set geprüft, Box-Art Edge Light; ohne diesen Beleg nimmt der Dienst keine Abnahme an), beim Dienst je Prüfung sein Beleg, Tunnel-Adresse, LAN-Netz, das Fenster der Probe, wer, wann. Append-only; eine neue Abnahme ist ein neuer Eintrag. | Tabelle `werkstatt_abnahme` |
| Versand (Entscheid 5c, U-6) | Der Ablauf endet mit der Abnahme. Oben auf der Seite und am Ende steht: keine Box mit Stufe 1 an einen Kunden, bevor Stufe 2 steht. Es gibt keinen Zustand „versandbereit“. Der Satz bleibt, bis der Laborbeweis P1–P11 grün und das erste Update über das Portal auf `edge-tgjn9gd` gelungen ist ([Updates](../edge-light/docs/boot-und-updates.md#versand-entscheid-5c-u-6)); dann ersetzt ihn die Prüfung „Update-bereit“. | `VERSAND_SATZ` |
| Docker-Box (Entscheid 9a) | Steht im Register (`boxArt: edge-app`), hat aber keinen Ablauf und keine Abnahme: Für sie gibt es keinen Wartungstunnel und damit keine Anmeldeprobe. | – |

Die Routen für Schritte, LAN-Netz und die Abnahme von Hand (unten) bleiben in der API für den Weg ohne Dienst; die
Seite ruft sie nicht mehr auf. Die Handschritte selbst stehen in der Werkstatt-Regel (`edge-light/docs/mango.md`).

## Automatisch: der Werkstatt-Dienst (V1a)

Die Schritte an der Box übernimmt der [Werkstatt-Dienst](../services/werkstatt-dienst/README.md) im Cluster: Eine
Mango ab Werk kommt mit dem orangen Kabel WERKSTATT an die [Werkbank-Brücke](../services/werkstatt-dienst/bruecke/README.md),
der Dienst spielt OpenWrt ohne Startlader auf (`sysupgrade -n` aus der Werksfirmware), setzt Passwort und
Notfall-Schlüssel, spielt Edge Light und den Tunnel ein, stellt das LAN um und macht die Neustart-Probe, jeden
Schritt mit Beleg. Das Root-Passwort erzeugt dann der Dienst (Entscheid WI-6 A statt 3a): Es steht nur
verschlüsselt für den age-Schlüssel „Box-Passwörter“ im Protokoll des Dienstes und geht an keine Route. Diese
Seite zeigt, was er tut, und die Abnahme mit seinen Belegen ([Runbook](../services/werkstatt-dienst/docs/runbook.md#eine-box-einrichten)).

Ob der Dienst überhaupt Boxen einrichtet, sagt die **Freigabe** (WI-4 A): „Werkstatt freigeben“ legt fest, welche
Fassungen (OpenWrt-Abbild, Edge Light, je mit Prüfsumme) und bis wann, „Freigabe beenden“ hält ihn an. Ab V1 liegt
sie in der API (`/api/v1/admin/werkstatt/freigaben`, nur `platform-admin`; Tabelle `werkstatt_freigabe`, nur das
Ende ändert sich, nichts wird gelöscht); der Dienst liest die laufende über sein Dienstkonto im eigenen Baum
`/api/v1/werkstatt-dienst/**` und kann dort nicht freigeben ([Runbook](../services/werkstatt-dienst/docs/runbook.md#werkstatt-freigeben)).

Was der Dienst gerade tut (Werkbank, Anschluss, laufender Lauf), meldet er jeden Takt als
[Ansicht](contracts/werkstatt-ansicht-v1.md); `GET /api/v1/admin/werkstatt/dienst` gibt sie mit ihrem Alter und den
letzten Läufen an die Werkstatt-Bildschirme (älter als 60 s: „der Dienst meldet sich nicht“).

**Einmal-Code und D2** ([Vertrag](contracts/werkstatt-einloesen-v1.md)): In einer laufenden Freigabe holt der Dienst
für genau eine ungekoppelte Box einen Code (30 Minuten, einmal, in der API nur gehasht). Die Box löst ihn ohne Konto
selbst ein, signiert mit ihrem Geräteschlüssel und mit ihrer Zertifikatsanfrage. Die API hält dabei den
Geräteschlüssel fest, hinterlegt den Tunnel-Schlüssel über dieselbe Regel wie „Tunnel-Schlüssel hinterlegen“ und
öffnet 30 Minuten Probe-Fenster für den Techniker-Zugang des Dienstes (`VP_WERKSTATT_TECHNIKER_ZUGANG`). Danach
nimmt die Zertifikatsanfrage nur noch diesen Schlüssel an (409 `schluessel_festgehalten`), und ausgestellt wird nur
dafür. Ein anderer Schlüssel braucht einen Code für einen Tausch, solange die Box ungekoppelt ist. Für eine
gekoppelte Box gibt es keinen Code. Boxen, die nie eingelöst haben, verhalten sich wie bisher. Auf dem Weg der
Zertifikatsanfrage prüft die API jetzt auch das Prüfzeichen einer erzeugten Kennung.

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

Die Abnahme von Hand (`quelle: hand`) beruht auf den Haken des Technikers. Ob ein Passwort gesetzt ist und welcher
Schlüssel auf der Box liegt, kann das Portal nicht prüfen. Was der Tunnel-Dienst zum Fenster gemeldet hatte, steht im
Protokoll als Anzeige (`schluesselAbgeholtUm` null = keine Meldung nannte es abgeholt) und entscheidet nichts.

**Die Abnahme des Werkstatt-Dienstes** (`quelle: dienst`, WI-7 A, `POST /api/v1/werkstatt-dienst/abnahmen/{ref}`)
liegt in derselben append-only Tabelle. Statt Haken trägt sie je Prüfung den Beleg des Dienstes, die Freigabe, die
Einlösung und das Root-Passwort verschlüsselt für den age-Schlüssel „Box-Passwörter“ (WI-6 A; entschlüsseln kann nur
der Betreiber, das Passwort selbst geht an keine Route). Sie bezieht sich auf die letzte Einlösung der Box:
Host-Schlüssel und Fassung wie beim Einlösen gemeldet, der dort hinterlegte Tunnel-Schlüssel, und das Probe-Fenster
der Einlösung war offen und ist zu.

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
Portal liest die Referenz beim Start, prüft ihr Prüfzeichen, legt sie in den `sessionStorage` dieses Tabs und
zusätzlich 24 Stunden in den `localStorage` dieses Browsers (`vp.koppel.vormerk`, nur die Referenz mit ihrer Frist;
Entscheid QE-3 B vom 04.11.2026) und nimmt den Link aus der Adresse (`koppelLink.ts`). So übersteht sie die
Anmeldung, das Neuladen nach der Selbstregistrierung (K1), einen geschlossenen Tab und „später verbinden“.
Gelöscht wird sie nach dem Verbinden, beim Abbruch und beim Abmelden. Auf ein anderes Gerät reist sie nicht; dafür
steht sie unten auf der Box. Die Seiten danach (Konzept `vp-qr-einstieg`, entschieden 04.11.2026):

- ohne Sitzung: die Empfangsseite „Ihre VoltPilot-Box ist da“ mit der Kennung, drei Schritten und „Konto
  erstellen“ / „Ich habe schon ein Konto“; bei falschem Prüfzeichen „Dieser Code ist nicht vollständig lesbar“
  mit Eingabefeld. Beide fragen den Server nichts und zeigen nur, was im Code steht. Registrierung und Anmeldung
  tragen ein Box-Band (die Anmeldeseite über `deploy/keycloak/…/js/box-band.js`, gleiche Herkunft `/auth/`);
- ein Kunde ohne Anlage: der Einrichtungs-Assistent, im Schritt „Box“ steht die Referenz im Feld;
- ein Kunde mit einer Anlage: deren Aufbau mit „VoltPilot-Box hinzufügen“ (`?neu=box&ref=`), mit mehreren erst
  „An welcher Anlage steht die Box?“;
- die Box steht schon in der eigenen Geräteliste: „Diese Box gehört schon zu Ihnen“; ohne Recht
  `geraet.einrichten`: „Für das Verbinden fehlt Ihnen das Recht“ mit den Kundenadministratoren;
- ein VoltPilot-Admin: die Werkstatt bei genau dieser Box.

Verbunden wird nie von selbst; der Kunde drückt selbst auf „Verbinden“. Danach zeigt das Portal ehrlich, ob sich
die Box schon gemeldet hat („wartet auf das erste Lebenszeichen“ mit Prüfliste, nach 15 Minuten der Weg zum
Ansprechpartner), und bei einer Box eines anderen Kontos eine eigene Seite, die dieses Konto nicht nennt.

## Was fehlt

| Was | Warum noch nicht |
|---|---|
| Probedruck der Kennung | Die Druckdatei je Box gibt es (`bauen.sh --referenz <referenz>`, [Kennung](../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)); geprüft ist sie bis zum G-Code, gedruckt nicht. Ob ein Telefon den gedruckten Code liest, zeigt erst der Probedruck des Betreibers. |
| Werkbank-Bildschirme für den Raspberry Pi | Der Dienst richtet in V1 nur die Mango ein; die Kachel „Raspberry Pi“ ist gesperrt, bis V2 den Ablauf bringt. |
| Zweiter Faktor am Portal | Entscheid 10b: später |
| Die kleinen Korrekturen aus Abschnitt 3.5 | laufen in einem eigenen PR (`install.sh`, `schluessel-holen.sh`, `mango.md`) |
