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
| Werkbank (M1–M6) | Die geführten Bildschirme für die Person an der Werkbank: Box-Art wählen (Raspberry Pi kommt mit V2), Mango anschließen, Fertig mit Referenz und QR-Code. Kein „Weiter“-Knopf: Der Dienst merkt Handgriffe selbst. Fachwörter stehen nur unter „Details für Technik“. | `WerkstattBank.tsx`, `werkstattBank.ts` |
| Lauf-Seite (Konzept `vp-werkstatt-lauf-seite`, E1–E4 A, 05.11.2026) | Während des Laufs: „Jetzt“ (Schritt, seit wann, wie lange er meist dauert – Median der gemessenen Dauern der letzten Läufe –, Frist, was danach kommt), alle Schritte nach Phasen mit einer Zeile Beleg und Dauer (`lauf.belege`, E3) und die Software-Karte „Kommt auf diese Box“ (Freigabe, OpenWrt mit Prüfsumme, Edge Light, je „vorher“ aus `lauf.vorher`, ein neueres signiertes Release nur als Hinweis). Am Rechner zwei Spalten, am Telefon eine (E4). Hält der Lauf an oder steht am Anschluss ein Fall, zeigt sie eine Seite je Code (`lauf.fall`/`anschluss_fall`, [Vertrag](contracts/werkstatt-ansicht-v1.md#fälle)) in drei Arten: „Der Dienst wartet“, „Einmal kurz du“, „Zur Seite legen“; Titel und Schritte aus `loesung`, ob der Dienst von selbst weitermacht, ein Bild bei Reset, Startlader, Kabel oder Pi. Den Reset nennt sie nur bei `gl_passwort` und `halb_eigene`. „Nochmal versuchen“ (E1) ist ein Auftrag an den Dienst, nur wenn er den Lauf als `nochmal_moeglich` meldet (kein Handgriff an der Box); er tut, was das Abziehen des Kabels täte. „Box zur Seite legen“ (E2) hält Fall, Lösung und Zeit in der API fest; die Übersicht listet sie. Kein Knopf löscht etwas an einer Box. Ein Dienst ohne diese Felder: keine Belegzeilen, kein „Nochmal“, der Fall aus `handgriff` wie bisher. | `WerkstattBank.tsx`, `werkstattLauf.ts` |
| Übersicht (D1) | Freigabe („Werkstatt freigeben“, „Freigabe beenden“), Werkbank-Brücke und die Boxen mit ihrem Stand (läuft, Problem, abgenommen, nur im Register). Eine Box in der Liste öffnet ihre Detailseite. | `WerkstattPage.tsx` |
| Einrichtungs-Detailseite (`?box=<referenz>`) | Alles zu einer Box an einem Ort, nur Anzeige. Oben steht, ob ein Kunde die Box schon eingerichtet hat (`kunde` der Box: Claim über den QR-Einstieg, Zeile in `device`; die Vorab-Registrierung zählt nicht; fehlt das Feld, „nicht bekannt“); wenn nicht, stehen dort der Direktlink des Gehäuse-QR-Codes (`https://portal.voltpilot.de/k/<referenz>`, siehe unten) mit „Link kopieren“ und derselbe QR-Code: Der Kunde richtet die Box darüber ein, ein Admin öffnet ihn in einem privaten Fenster (angemeldet führt er zurück in die Werkstatt). Dann Einrichtung (Hardware, Edge-Light-Fassung, OpenWrt und Freigabe, LAN-Netz, Tunnel-Adresse, Host-Schlüssel), Bindung und Fernwartung (Tunnel-Schlüssel, Zugang, Kunde und Anlage, Verbindung laut Tunnel-Dienst; ohne Tunnel-Schlüssel steht dort „noch nicht gekoppelt“), die Phasen des Laufs, die Abnahme mit den Belegen samt früheren Abnahmen, die Beschriftung und der Download der Gehäuse-Druckdatei (3MF, siehe unten). Fehlt die Abnahme, bleiben ihre Felder leer („–“): Unbekannt ist keine Angabe. Das Root-Passwort steht nur verschlüsselt da, wie an der Abnahme. | `WerkstattBoxSeite.tsx`, `werkstattEinrichtung.ts` |
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

## Gehäuse-Druckdatei zum Herunterladen

Die Detailseite einer Mango bietet GENAU die Druckdatei dieser Box an, mit Referenz in Klarschrift und
QR-Code im Unterteil (vp-mango-3mf-pro-box) - nie eine allgemeine Datei ohne Kennung.
Der Werkstatt-Dienst baut sie nach der Übergabe (`gehaeuse-<referenz>.3mf`,
[Runbook](../services/werkstatt-dienst/docs/runbook.md#gehäuse-druckdatei)) und lädt sie, sobald der Auftrag ohne
Fehler fertig ist, zur API hoch (`PUT /api/v1/werkstatt-dienst/gehaeuse/{edgeRef}`, Prüfsumme serverseitig
geprüft, Nachdruck überschreibt). Die API legt sie in `werkstatt_gehaeuse_datei` ab; die Karte lädt sie über
`GET /api/v1/admin/werkstatt/boxen/{ref}/gehaeuse` (platform-admin, `model/3mf`).
Ein Fehlschlag beim Hochladen blockiert den Werkstatt-Lauf an der Box nicht; der Dienst holt ihn im eigenen Takt
nach, auch ohne Neustart (`services/werkstatt-dienst/internal/gehaeuse`, `Laufe`).

Derselbe Takt gleicht mit dem Portal ab (`GET /api/v1/werkstatt-dienst/gehaeuse/offen`): eine abgenommene Box
ohne Druckdatei und ohne Auftrag in der Ablage des Dienstes reiht er von selbst ein - auch eine Box, die vor
dieser Funktion abgenommen wurde und deren Werkstatt-Lauf die Bestellung nie ausgelöst hat; kein Handgriff, kein
Rück-Import nötig. Liegt noch keine Datei vor, sagt die Karte „Druckdatei wird erstellt …“ mit einer
Läuft-Anzeige statt eines toten Knopfs. Ein schon gescheiterter Auftrag wird NICHT automatisch wieder
eingereiht (sonst bauten persistente Fehler endlos neu); die Karte zeigt dann einen ruhigen Satz mit dem Grund
und „Erneut erstellen“ (`POST /api/v1/admin/werkstatt/boxen/{ref}/gehaeuse/neu`), das wie „Nochmal versuchen“
der Lauf-Seite einen Auftrag an den Dienst anlegt.
Was von den Teilen gedruckt und bestätigt ist, steht in [druck/README.md](../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/README.md), die Seite wiederholt es nur.

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
| `DELETE /boxen/{ref}` | eine Box löschen, etwa einen Fehlversuch (Portal: „Löschen“): 204; 409 mit Grund, solange sie abgenommen oder gekoppelt ist (Zertifikat, Gerät eines Kunden, Vorab-Registrierung), `inGebrauch` an der Box nennt dieselben Gründe. Mit ihr gehen Tunnel-Zugang (Zustand `geloescht`, offene Fenster schließen), nicht eingelöste Codes, festgehaltener Geräteschlüssel und offene Zertifikatsanfrage; `loeschtMit` an der Box nennt sie. Läufe und Einlösungen bleiben |
| `PUT /boxen/{ref}/schritte/{schritt}` | `{"erledigt": true\|false}`, idempotent |
| `PUT /boxen/{ref}/lan-netz` | `{"lanNetz": "10.213.0.1/24"}`; 422 mit Grund |
| `POST /boxen/{ref}/abnahme` | das Protokoll; 201, sonst 404/409/422 mit Grund |
| `POST /dienst/nochmal` | `{"lauf": "<kennung>"}`: Auftrag „Nochmal versuchen“ an den Dienst (E1 A); 201 neu, 200 schon offen; 409, wenn der Dienst sich nicht meldet, der Lauf nicht mehr der letzte ist oder der Dienst ihn nicht als `nochmal_moeglich` meldet |
| `POST /zur-seite` | `{"lauf": "<kennung>"}`: einen angehaltenen Lauf zur Seite legen (E2 A); 201 neu, 200 schon da; 404 unbekannt, 409 nicht angehalten. `GET /dienst` trägt die Liste als `zurSeite` |

## Daten

Wie die Tabellen der Fernwartung globale Betriebsdaten ohne Mandant (eine Box in der Werkstatt gehört noch
niemandem): keine Rechte für die App-Rolle, RLS mit `FORCE` und ohne Policy als zweiter Riegel, gelesen und
geschrieben nur über die BYPASSRLS-Rolle `voltpilot_admin` (`WerkstattRepository`). Gelöscht wird nur eine Box,
die weder abgenommen noch gekoppelt ist (`DELETE /boxen/{ref}`), unter der Werkstatt-Sperre in einer Transaktion
(die Fernwartung nimmt ihre Sperre darin): Register-Zeile, nicht eingelöste `werkstatt_code`,
`werkstatt_geraeteschluessel` und eine `device_enrollment` ohne Zertifikat; der Box-Zugang der Fernwartung wird
`geloescht` (Adresse und Schlüssel bleiben vergeben, dieselbe Referenz bekommt später einen neuen Zugang).
Vorher steht alles mit wer und wann in `werkstatt_box_entfernt` (`mitgeloescht`: Tunnel-Zugang mit geschlossenen
Fenstern, Codes, Geräteschlüssel, Zertifikatsanfrage). `werkstatt_lauf` und die append-only `werkstatt_einloesung`
(mit ihrem Code) bleiben als Verlauf; die Einlösung zählt weiter zur Obergrenze ihrer Freigabe.
`werkstatt_abnahme` und `werkstatt_box_entfernt` sind append-only an der Datenbankgrenze, und eine abgenommene Box
hält ihre Abnahme per Fremdschlüssel fest. Migrationen `V20261026200000__werkstatt.sql`,
`V20261105170000__werkstatt_box_entfernen.sql`, `V20261106080000__werkstatt_fehlversuch_loeschen.sql`,
`V20261105200000__werkstatt_auftrag_zur_seite.sql` (`werkstatt_auftrag`:
Aufträge an den Dienst, nur `abgeholt_am` ändert sich; `werkstatt_zur_seite`: append-only).

**Aufträge an den Dienst.** Eine eingehende Verbindung zum Werkstatt-Dienst gibt es nicht. Er holt offene Aufträge mit
seiner Meldung der Ansicht ab (`PUT /api/v1/werkstatt-dienst/ansicht?auftraege=1`: 200 mit `auftraege`, jeder genau
einmal, verfallen nach 10 Minuten); ohne den Parameter bleibt die Antwort 204 wie für einen älteren Dienst. Der Dienst
führt „nochmal“ nur für seinen letzten, angehaltenen Lauf mit einem Fall ohne Handgriff an der Box aus
(`faelle.Nochmal`): Er gibt die Sperre der Box frei, wie beim Abziehen des Kabels; ins Protokoll des beendeten Laufs
schreibt er nichts.

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
