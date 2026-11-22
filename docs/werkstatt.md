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
| Werkbank (M1–M6) | Die geführten Bildschirme für die Person an der Werkbank: Gerät wählen (Mango oder, wenn der Dienst welche einrichtet, [WAGO PFC200](#wago-pfc200-edge-industrie-an-der-werkbank); Raspberry Pi kommt mit V2), anschließen, Fertig mit Referenz und QR-Code. Kein „Weiter“-Knopf: Der Dienst merkt Handgriffe selbst. Fachwörter stehen nur unter „Details für Technik“. | `WerkstattBank.tsx`, `werkstattBank.ts` |
| Lauf-Seite (Konzept `vp-werkstatt-lauf-seite`, E1–E4 A, 05.11.2026) | Während des Laufs: „Jetzt“ (Schritt, seit wann, wie lange er meist dauert – Median der gemessenen Dauern der letzten Läufe –, Frist, was danach kommt), alle Schritte nach Phasen mit einer Zeile Beleg und Dauer (`lauf.belege`, E3) und die Software-Karte „Kommt auf diese Box“ (Freigabe, OpenWrt mit Prüfsumme, Edge Light, je „vorher“ aus `lauf.vorher`, ein neueres signiertes Release nur als Hinweis). Am Rechner zwei Spalten, am Telefon eine (E4). Hält der Lauf an oder steht am Anschluss ein Fall, zeigt sie eine Seite je Code (`lauf.fall`/`anschluss_fall`, [Vertrag](contracts/werkstatt-ansicht-v1.md#fälle)) in drei Arten: „Der Dienst wartet“, „Einmal kurz du“, „Zur Seite legen“; Titel und Schritte aus `loesung`, ob der Dienst von selbst weitermacht, ein Bild bei Reset, Startlader, Kabel oder Pi. Den Reset nennt sie nur bei `gl_passwort` und `halb_eigene`. „Nochmal versuchen“ (E1) ist ein Auftrag an den Dienst, nur wenn er den Lauf als `nochmal_moeglich` meldet (kein Handgriff an der Box); er tut, was das Abziehen des Kabels täte. „Box zur Seite legen“ (E2) hält Fall, Lösung und Zeit in der API fest; die Übersicht listet sie. Kein Knopf löscht etwas an einer Box. Ein Dienst ohne diese Felder: keine Belegzeilen, kein „Nochmal“, der Fall aus `handgriff` wie bisher. | `WerkstattBank.tsx`, `werkstattLauf.ts` |
| Übersicht (D1) | Oben der Stand der Werkstatt: läuft (was gerade aufgespielt wird, wie viele Boxen heute), angehalten (wer, wann, warum) oder wartet (warum), mit „Werkstatt anhalten“ bzw. „Werkstatt fortsetzen“; unter „Details für Technik“ die Prüfsummen, das Protokoll von Anhalten und Fortsetzen und die Freigaben als Beleg. Darunter Werkbank-Brücke und die Boxen mit ihrem Stand (läuft, Problem, abgenommen, nur im Register). Eine Box in der Liste öffnet ihre Detailseite. | `WerkstattPage.tsx`, `werkstattStand` |
| Einrichtungs-Detailseite (`?box=<referenz>`) | Alles zu einer Box an einem Ort, nur Anzeige. Oben steht, ob ein Kunde die Box schon eingerichtet hat (`kunde` der Box: Claim über den QR-Einstieg, Zeile in `device`; die Vorab-Registrierung zählt nicht; fehlt das Feld, „nicht bekannt“); wenn nicht, stehen dort der Direktlink des Gehäuse-QR-Codes (`https://portal.voltpilot.de/k/<referenz>`, siehe unten) mit „Link kopieren“ und derselbe QR-Code: Der Kunde richtet die Box darüber ein, ein Admin öffnet ihn in einem privaten Fenster (angemeldet führt er zurück in die Werkstatt). Dann Einrichtung (Hardware, Edge-Light-Fassung, OpenWrt und Freigabe, LAN-Netz, Tunnel-Adresse, Host-Schlüssel), Bindung und Fernwartung (Tunnel-Schlüssel, Zugang, Kunde und Anlage, Verbindung laut Tunnel-Dienst; ohne Tunnel-Schlüssel steht dort „noch nicht gekoppelt“), die Phasen des Laufs, die Abnahme mit den Belegen samt früheren Abnahmen, die Beschriftung und der Download der Gehäuse-Druckdatei und des Zubehörs (3MF, siehe unten). Fehlt die Abnahme, bleiben ihre Felder leer („–“): Unbekannt ist keine Angabe. Das Root-Passwort steht nur verschlüsselt da, wie an der Abnahme. | `WerkstattBoxSeite.tsx`, `werkstattEinrichtung.ts` |
| Stand des Dienstes | Die [Ansicht](contracts/werkstatt-ansicht-v1.md) über `GET /api/v1/admin/werkstatt/dienst`, die Seite fragt alle 5 s nach. Ist die letzte Meldung älter als 60 s, steht dort „Der Werkstatt-Dienst meldet sich nicht“ statt eines alten Stands. | – |
| Beschriftung (Entscheid 8, geändert) | Kein Aufkleber: Referenz in Klarschrift und QR-Code mit dem Direktlink kommen aufs Gehäuse. Die Seite zeigt den Inhalt und den QR-Code, gibt eine SVG-Vorlage in echter Größe (Modul 0,84 mm) zum Probedruck auf Papier und nennt den Befehl für die Druckdatei des Gehäuses (`bauen.sh --referenz <referenz>` im Gehäuse-Programm, [Kennung](../edge-light/gehaeuse/glinet-gl-mt300n-v2/docs/kennung.md)). Was gedruckt wird, ist Modul für Modul, was die Seite zeigt: beide prüfen gegen [werkstatt-beschriftung.json](contracts/werkstatt-beschriftung.json). | `BeschriftungKarte`, `qrCode.ts` |
| Abnahme | Das Abnahmeprotokoll (das „Übergabeprotokoll“ der Werkstatt-Regel in `edge-light/docs/mango.md`): Host-Schlüssel, Fassung, die zehn Prüfungen der Regel (seit K5 mit „Update-bereit“: signierte Fassung als bestätigter Stand, Vertrauens-Set geprüft, Box-Art Edge Light; seit S1 mit „Einrichtungs-WLAN bereit“: Funkmodul auf Land DE, Paket relayd auf der Box; ohne diese Belege nimmt der Dienst keine Abnahme an), beim Dienst je Prüfung sein Beleg, Tunnel-Adresse, LAN-Netz, das Fenster der Probe, wer, wann. Append-only; eine neue Abnahme ist ein neuer Eintrag. | Tabelle `werkstatt_abnahme` |
| Versand (Entscheid 5c, U-6) | Der Ablauf endet mit der Abnahme. Oben auf der Seite und am Ende steht: keine Box mit Stufe 1 an einen Kunden, bevor Stufe 2 steht. Es gibt keinen Zustand „versandbereit“. Der Satz bleibt, bis der Laborbeweis P1–P11 grün und das erste Update über das Portal auf `edge-tgjn9gd` gelungen ist ([Updates](../edge-light/docs/boot-und-updates.md#versand-entscheid-5c-u-6)); dann ersetzt ihn die Prüfung „Update-bereit“. | `VERSAND_SATZ` |
| Docker-Box (Entscheid 9a) | Steht im Register (`boxArt: edge-app`), hat aber keinen Ablauf und keine Abnahme: Für sie gibt es keinen Wartungstunnel und damit keine Anmeldeprobe. | – |

Die Routen für Schritte, LAN-Netz und die Abnahme von Hand (unten) bleiben in der API für den Weg ohne Dienst; die
Seite ruft sie nicht mehr auf. Die Handschritte selbst stehen in der Werkstatt-Regel (`edge-light/docs/mango.md`).

## Automatisch: der Werkstatt-Dienst (V1a)

Die Schritte an der Box übernimmt der [Werkstatt-Dienst](../services/werkstatt-dienst/README.md) im Cluster: Eine
Mango ab Werk kommt mit dem orangen Kabel WERKSTATT an die [Werkbank-Brücke](../services/werkstatt-dienst/bruecke/README.md),
der Dienst spielt OpenWrt ohne Startlader auf (`sysupgrade -n` aus der Werksfirmware; ab GL 4.3.30 richtet er die
Werksfirmware dafür erst selbst mit einem Einmal-Passwort ein, weil sie SSH sonst nicht zulässt), setzt Passwort und
Notfall-Schlüssel, spielt Edge Light und den Tunnel ein, stellt das LAN um und macht die Neustart-Probe, jeden
Schritt mit Beleg. Das Root-Passwort erzeugt dann der Dienst (Entscheid WI-6 A statt 3a): Es steht nur
verschlüsselt für den age-Schlüssel „Box-Passwörter“ im Protokoll des Dienstes und geht an keine Route. Diese
Seite zeigt, was er tut, und die Abnahme mit seinen Belegen ([Runbook](../services/werkstatt-dienst/docs/runbook.md#eine-box-einrichten)).

### Die Werkstatt nimmt immer die neueste Fassung

Entscheid des Captains vom 16.11.2026 (A, Auftrag `vp-werkstatt-immer-neueste`): Es gibt kein Formular mehr.
Die Werkstatt läuft, bis jemand sie anhält, und spielt auf jede neue Box die neueste Fassung (`WerkstattRegel`):

- **Edge Light** ist die neueste zuweisbare signierte Fassung der Linie Edge Light, dieselbe Regel wie beim ersten Verbinden (`RolloutService.neuesteFassung`): höchste `release_seq`, Manifest und Signatur liegen vor, die Programme liegen geprüft im Portal.
  Ein unsigniertes Release zählt nie; ist die neueste noch nicht zuweisbar, wartet die Werkstatt, statt eine ältere zu nehmen.
  Die Prüfsummen kommen nur aus dem **signierten Manifest**: das Programm der Mango aus `artifacts[]` (`binary`, `linux/mipsle`, `sha256`), der Skriptstand aus `skripte` (additives Feld, das `vp-ota manifest --skripte` im Release-Lauf setzt; die Box wendet es nicht an, [Schema](contracts/ota-release-manifest.schema.json)).
  Die Quelle ist das Forgejo-Release der Fassung (`VP_WERKSTATT_EDGE_LIGHT_QUELLE`).
  Trägt die neueste Fassung keinen Skriptstand im Manifest, wartet die Werkstatt.
- **OpenWrt** steht fest im Code (`WerkstattOpenWrt`: 25.12.5, sysupgrade-Abbild der GL-MT300N-V2, sha256 aus der offiziellen `sha256sums`, gegengeprüft am 16.11.2026).
  Gehoben wird es per PR mit `WerkstattOpenWrtTest`.
- **Anhalten und Fortsetzen** (nur `platform-admin`, `POST /api/v1/admin/werkstatt/anhalten` mit optionalem Grund, `…/fortsetzen`): Angehalten bekommt der Dienst keine Freigabe und keinen Einmal-Code, und keine Box wird eingelöst; ein laufender Lauf hält spätestens beim Anmelden an.
  Jede Änderung steht mit wer, wann und Grund in `werkstatt_betrieb` (nur anhängen).
- **Tagesgrenze** statt Obergrenze je Freigabe: höchstens `VP_WERKSTATT_TAGESGRENZE` (Vorgabe 40) verschiedene Boxen, die an einem Berliner Tag eingelöst haben, über alle Freigaben.
  Begründung: eine Werkbank, ein Lauf zur Zeit; ein Lauf dauert gut zehn Minuten (OpenWrt aufspielen und der Neustart allein dauern einige Minuten, Runbook PS-3), ein Arbeitstag schafft also kaum mehr als 40; bisher stand die Obergrenze einer Freigabe meist bei 20.
  Die Grenze fängt nur einen Fehler oder Missbrauch am Werkstatt-Rechner ab, nie den Normalbetrieb.
- **Wechselt die neueste Fassung**, gilt sie ab der nächsten Box; ein laufender Lauf bleibt bei seiner Fassung (beim Einlösen gilt die Zeile, deren Fassung die Box meldet).

**Für den Dienst bleibt alles, wie es war.** Die Regel legt je Berliner Tag und Inhalt eine Zeile in `werkstatt_freigabe` an (`quelle = regel`, Kennung `JJJJ-MM-mango-N` in derselben Reihe wie die Freigaben von Hand, `edge_release_seq`, gültig bis Mitternacht und eine Stunde, Obergrenze = was von der Tagesgrenze übrig ist); der Dienst liest sie über `GET /api/v1/werkstatt-dienst/freigabe` in der Form seiner Datei (Schema `vp-werkstatt-freigabe.v1`) und braucht kein Update.
Code, Einlösung und Abnahme hängen an dieser Zeile wie bisher, und so bleibt der Beleg: Jede Abnahme nennt ihre Freigabe und damit Edge-Light- und OpenWrt-Fassung mit ihren Prüfsummen (Einrichtung der Box: „Prüfsummen (laut Freigabe)“, „Freigabe · Regel, Release N“).
An einer Zeile ändert sich nur ihr Ende, keine wird gelöscht.
`GET /api/v1/admin/werkstatt/regel` liefert der Seite den Stand, `GET …/freigaben` alle Zeilen als Verlauf.

**Übergang:** Die Freigaben von Hand bis 16.11.2026 (`quelle = formular`, etwa `2026-11-mango-3`) bleiben lesbar.
Solange die neueste Fassung ihren Skriptstand noch nicht im signierten Manifest trägt (alle Fassungen vor diesem Stand), gilt eine noch laufende Freigabe von Hand weiter, bis sie abläuft; danach wartet die Werkstatt auf die erste Fassung mit Skriptstand.
Ohne API (V1a) bleibt die Freigabe eine Datei ([Runbook](../services/werkstatt-dienst/docs/runbook.md#werkstatt-anhalten-und-fortsetzen)).

Was der Dienst gerade tut (Werkbank, Anschluss, laufender Lauf), meldet er jeden Takt als
[Ansicht](contracts/werkstatt-ansicht-v1.md); `GET /api/v1/admin/werkstatt/dienst` gibt sie mit ihrem Alter und den
letzten Läufen an die Werkstatt-Bildschirme (älter als 60 s: „der Dienst meldet sich nicht“).

**Einmal-Code und D2** ([Vertrag](contracts/werkstatt-einloesen-v1.md)): Solange die Werkstatt läuft (nicht angehalten,
unter der Tagesgrenze), holt der Dienst für genau eine ungekoppelte Box einen Code (30 Minuten, einmal, in der API nur gehasht). Die Box löst ihn ohne Konto
selbst ein, signiert mit ihrem Geräteschlüssel und mit ihrer Zertifikatsanfrage. Die API hält dabei den
Geräteschlüssel fest, hinterlegt den Tunnel-Schlüssel über dieselbe Regel wie „Tunnel-Schlüssel hinterlegen“ und
öffnet 30 Minuten Probe-Fenster für den Techniker-Zugang des Dienstes (`VP_WERKSTATT_TECHNIKER_ZUGANG`). Danach
nimmt die Zertifikatsanfrage nur noch diesen Schlüssel an (409 `schluessel_festgehalten`), und ausgestellt wird nur
dafür. Ein anderer Schlüssel braucht einen Code für einen Tausch, solange die Box ungekoppelt ist. Für eine
gekoppelte Box gibt es keinen Code. Boxen, die nie eingelöst haben, verhalten sich wie bisher. Auf dem Weg der
Zertifikatsanfrage prüft die API jetzt auch das Prüfzeichen einer erzeugten Kennung.

## WAGO PFC200 (Edge Industrie) an der Werkbank

Der Werkstatt-Dienst richtet neben der Mango auch einen WAGO PFC200 750-8212 ein, als Box „Edge Industrie“.
Schritte, Belege und Einstellungen stehen im [README des Dienstes](../services/werkstatt-dienst/README.md#ein-lauf-am-wago-pfc200-edge-industrie); hier steht, was ein Mensch dafür tut und was der Lauf nicht tut.

**Stand.**
Der Dienst kann den Lauf (ausgeschaltet, bis `VP_WERKSTATT_GERAETE=mango,pfc200` gesetzt ist), die API kennt das Gerät `pfc200` (Freigabe, Einmal-Code, Abnahme), und das Portal führt durch den Lauf.
Neue Software bekommt ein eingerichteter PFC200 ohne Kundenkonto wie die Mango durch den Tunnel, mit dem Knopf und nachts von selbst ([unten](#neue-software-durch-den-tunnel-box-ohne-kundenkonto)).

**Im Portal.**
Alle Worte und Bilder zum PFC200 stehen an einer Stelle, in `frontend/portal/src/werkstattPfc200.ts`.

| Teil | Was |
|---|---|
| Werkbank, Start | Kachel „PFC200“ neben „Mango“. Meldet der Dienst keine Freigabe für den PFC200 (`freigabe_pfc200` fehlt in der Ansicht), ist sie gesperrt und sagt, dass der Dienst hier keine einrichtet |
| Werkbank, Anschließen | Endklemme, oranges Kabel in X2, Strom. Der Handgriff „feste Adresse“ steht immer da, in drei Sätzen und drei Zeichnungen (Schalter auf STOP, Reset-Taster länger als 8 Sekunden bis SYS orange blinkt, Schalter zurück auf RUN): Ein PFC200 ab Werk hat an der Werkbank sonst keine Adresse. Wartet die Werkstatt für den PFC200, steht der Grund darüber |
| Lauf-Seite | Sechs Phasen: Erkannt, Absichern, Software, Bei VoltPilot anmelden, Netze trennen und Probe, Abnahme. Keine Phase und kein Schritt für die SPS oder die Firmware. Die Karte „Kommt auf diese Box“ nennt Edge Industrie und, nur zur Anzeige, die gelesene Firmware („bleibt, wie sie ist“). Eine Minutenzahl nennt die Seite erst, wenn frühere Läufe an einem PFC200 jeden offenen Schritt gemessen haben; eine Schätzung gibt es nicht |
| Fall-Seiten | Wartet der Lauf auf einen Handgriff (`pfc_schalter_stop`, `pfc_kabel_x1`), zeigt die Seite ihn mit Zeichnung und macht von selbst weiter; „zur Seite legen“ gibt es erst, wenn ein Lauf angehalten hat. Den Werksreset zeigt nur `pfc_passwort`, mit Zeichnung, danach die feste Adresse. Für jedes fremde Gerät (`passwort_fremd`, `pfc_schon_eingerichtet`, …) gibt es kein Bild eines Resets |
| Abschlussseite | Referenz und QR-Code für das Schild (ein gedrucktes Gehäuse hat der PFC200 nicht), dazu „CODESYS und Zugänge“: Die drei Passwörter stehen nur verschlüsselt an der Abnahme, das von `admin` entschlüsselt der Betreiber selbst, CODESYS erreicht das Gerät nur an X2, die Werkstatt hat kein SPS-Programm geladen |
| Übersicht | In der Karte „Werkstatt“ eine Zeile zum PFC200: seine Edge-Industrie-Fassung, oder worauf die Werkstatt für ihn wartet. Nur wenn der Dienst PFC200 einrichtet, einer im Register steht oder ein Lauf an einem lief; sonst fragt die Seite den Stand nicht ab |
| Seite der Box | Schild statt Druckdatei, „CODESYS und Zugänge“, Firmware, Bestellnummer und Seriennummer als Angabe („nur gelesen“), die Netze der zwei Buchsen, die zehn Prüfungen des PFC200 mit Beleg, die drei Zugänge in einem verschlüsselten Text |

Die Zeichnungen sind ein Schema der Front (Leuchte SYS, Betriebsartenschalter, Reset-Taster, Buchsen X1 und X2), kein Foto und nicht maßstäblich.
Geprüft wird das Portal gegen den Vektor [werkstatt-ansicht-v1.zustaende-pfc200.json](contracts/werkstatt-ansicht-v1.zustaende-pfc200.json): die Ansicht in jedem Zustand eines Laufs am PFC200, erzeugt aus dem Dienst selbst.
Die Bühne dazu: `frontend/portal/e2e/werkstatt-pfc200.html?zustand=<name>`.

**Freigabe, Code und Abnahme in der API.**
Die Werkstatt-Regel hat je Gerät eine eigene Zeile (`werkstatt_freigabe.box_art`: `mango` oder `pfc200`, Kennung `JJJJ-MM-pfc200-N`).
Für den PFC200 nimmt sie die neueste zuweisbare signierte Edge-Industrie-Fassung (Linie `edge-industrie-JJJJ.MM.N`, Programm für linux/arm), deren signiertes Manifest den Skriptstand (`skripte`) und das Tunnel-Programm (`wartung`) nennt.
Nennt die neueste Fassung eines davon nicht, wartet die Werkstatt für den PFC200 mit diesem Grund; eine ältere Fassung nimmt sie nicht, und die Mango läuft weiter.
Ein OpenWrt-Abbild hat die Zeile nicht: Die Firmware des PFC200 fasst die Werkstatt nicht an.
Anhalten, Fortsetzen und die Tagesgrenze gelten für beide Geräte zusammen (ein Schalter, ein Zähler).

| Route | Für den PFC200 |
|---|---|
| `GET /api/v1/werkstatt-dienst/freigabe?boxArt=pfc200` | die laufende Zeile mit `edge_industrie` (Fassung, Quelle, Prüfsummen von Programm, Skriptstand, Tunnel-Programm), ohne `openwrt` und `edge_light` |
| `POST /api/v1/werkstatt-dienst/codes` mit `boxArt: pfc200` | Code unter dieser Zeile; die Box steht als `edge-industrie` im Register. Steht die Referenz dort schon als anderes Gerät: 409 |
| `POST /api/v1/werkstatt/einloesen` | unverändert; eingelöst wird nur unter einer Zeile des Geräts, für das der Code ausgegeben wurde |
| `POST /api/v1/werkstatt-dienst/abnahmen/{ref}` | die zehn Prüfungen des PFC200 (unten), jede mit Beleg, ohne Übergangsfrist; `passwortAge` trägt die drei Zugänge; `angaben` trägt Bestellnummer, Firmware und Seriennummer als Angabe |
| `GET /api/v1/admin/werkstatt/regel?geraet=pfc200`, `…/freigaben?geraet=pfc200` | Stand und Zeilen für den PFC200; ohne `geraet` bleibt beides bei der Mango |

Die Prüfliste des PFC200 steht im selben Vektor wie die der Mango, unter `geraete.pfc200` in [werkstatt-pruefungen.json](contracts/werkstatt-pruefungen.json): `zugaenge`, `notfall_schluessel`, `tunnel_status`, `anmeldeprobe`, `host_schluessel`, `fenster_zu`, `netze`, `dienste_zu`, `neustart`, `update_bereit`.
Sie hat keine Prüfung für die SPS und keine für die Firmware, und kein Einrichtungs-WLAN.
Welche Liste für eine Abnahme gilt, sagt die Box-Art im Register, nicht der Dienst.
Fernlauf und Nachtlauf nehmen eine Edge-Industrie-Box wie eine Edge-Light-Box, jede mit der neuesten Fassung ihrer Linie (`FernlaufRegel.geraet`, [Vertrag](contracts/werkstatt-fernlauf-v1.md#zwei-geräte-eine-linie-je-gerät)).
Zwillinge der Prüfliste: `WerkstattPruefungen.PFC200` (API), `PRUEFUNGEN_PFC200` in `werkstatt.ts` (Portal), `pfc200.Pruefungen` (Dienst); alle vier gemeinsam ändern.

**Handgriffe am Gerät.**

| Wann | Handgriff |
|---|---|
| immer, vor dem Lauf | Endklemme anstecken, das orange Kabel in die Buchse **X2**, Strom an. Dann die feste Adresse: Betriebsartenschalter auf **STOP**, Reset-Taster (RST) länger als 8 Sekunden halten, bis SYS orange blinkt, Schalter zurück auf **RUN**. Das Gerät hat dann vorübergehend 192.168.1.17, bis zum nächsten Neustart |
| der Lauf wartet mit `pfc_schalter_stop` | Schalter auf RUN; der Lauf macht von selbst weiter |
| der Lauf wartet mit `pfc_kabel_x1` | Kabel in X2; der Lauf macht von selbst weiter |
| `pfc_passwort` (nur für ein Gerät, das diese Werkstatt begonnen und nicht fertig gemacht hat) | Werksreset: Reset-Taster halten, Schalter auf RESET, bis SYS abwechselnd rot und grün blinkt; danach wieder die feste Adresse |
| `pfc_docker_an` | Docker in der Web-Oberfläche des Geräts ausschalten, Kabel kurz ab |

Antwortet am Kabel niemand, zeigt die Ansicht des Dienstes den Handgriff „feste Adresse“ immer: Ein PFC200 ab Werk wartet auf DHCP und hat sonst keine Adresse.
Den Werksreset nennt der Dienst nie für ein fremdes Gerät; er löscht das SPS-Programm.

**Was der Lauf nicht tut.**
Kein Schritt für die SPS: kein Programm laden, starten oder prüfen, keine Koppelprobe; die Laufzeit (CODESYS), ihre Einstellungen und ihr Modbus-Server bleiben unberührt.
Die Firmware prüft und ändert er nicht; ihr Stand steht als Angabe im Beleg und an der Abnahme.
Fremde Container beendet er nicht.

**CODESYS nach dem Lauf.**
Die Entwicklungsumgebung erreicht das Gerät nur an der Buchse X2 (Anlagennetz, Vorgabe 10.213.0.1); zum Kundennetz an X1 sind Entwicklungsumgebung, Web-Oberfläche und SSH zu.
Das Passwort von `admin` steht mit denen von `root` und `user` nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“, an keiner Route; du entschlüsselst es selbst (`age -d -i <Schlüssel>`).

Der Satz zum Versand (Entscheid 5c) gilt für den PFC200 genauso.

## Neue Software durch den Tunnel (Box ohne Kundenkonto)

Eine Edge-Light-Box, die die Werkstatt verlassen hat, aber noch auf ihr Kundenkonto wartet, bekommt neue Software
nicht über die Updates im Portal (die brauchen eine Cloud-Verbindung in der Probe). Stattdessen spielt der
Werkstatt-Dienst sie durch den Wartungstunnel auf, wie in der Werkstatt: Geräteakte, Reiter „Software“, Karte „Durch
den Tunnel aufspielen“ (Konzept vp-update-vor-zuordnung S1, [Vertrag](contracts/werkstatt-fernlauf-v1.md)).
Immer die neueste Fassung, die auch die Werkstatt nimmt, nur aufwärts; der Dienst prüft die Signatur, sichert vorher,
prüft danach wie die Abnahme (Fassung, Referenz, update-bereit, meldet sich, Tunnel) und spielt bei einem Fehler die
Sicherung zurück. Routen: `GET/POST /api/v1/admin/geraete/{ref}/fernlauf` (Admin), `/api/v1/werkstatt-dienst/fernlaeufe/…`
(Dienst); Tabellen `werkstatt_fernlauf` (Auftrag) und `werkstatt_fernlauf_ergebnis` (nur angehängt), Rechte und RLS
wie die übrigen Werkstatt-Tabellen.

**Zusammenspiel mit dem ersten Verbinden (S3, §4.6).** Verbindet sich eine Box mit einem Kundenkonto, während für
ihre Referenz noch ein Fernlauf offen ist (`erteilt` oder `laeuft`), wartet die Regel „neueste Software beim ersten
Verbinden" (`Erstverbindung.of`, neue Eingabe `fernlaufOffen`), statt ein Urteil zu fällen oder gar zuzuweisen - kein
Wettlauf zwischen Tunnel- und Cloud-Update. Sobald der Fernlauf kein offener Auftrag mehr ist (Ergebnis, Abholfrist
oder Fensterende verstrichen), entscheidet die Regel im nächsten Takt wie gewohnt. Die Werkstatt-Seite einer Box
zeigt den letzten Fernlauf zusätzlich als eigene Zeile „Nach der Werkstatt" (`GET
/api/v1/admin/werkstatt/boxen/{ref}/fernlauf`, 204 ohne einen); die Abnahme bleibt davon unberührt. Eine wartende
Docker-Box bekommt in der Geräteakte keinen Knopf (kein Wartungstunnel): „Docker-Box · läuft … · holt beim
Verbinden die neueste Fassung".

**WAGO PFC200 (Edge Industrie).**
Für einen eingerichteten PFC200 ohne Kundenkonto gilt dasselbe, mit der neuesten Fassung der Linie Edge Industrie.
Eine Mango bekommt nie Edge Industrie, ein PFC200 nie Edge Light; widersprechen sich Werkstatt-Register und gemeldete Fassung, gibt es keinen Knopf.
Am PFC200 läuft daneben die Steuerung: Neu startet nur der Dienst `vp-edge-industrie`, nie das Gerät und nie die SPS-Laufzeit, und Firmware, SPS-Programm und Tunnel-Programm bleiben, wie sie sind.
Karte und Bestätigung im Portal sagen das („Neu startet nur das Programm von VoltPilot; das Gerät und die SPS laufen weiter“) und nennen keine Dauer, weil es für den PFC200 keine gemessene gibt.
In der Karte „Ohne Kundenkonto“ trägt die Zeile eines PFC200 die Marke „Edge Industrie“.
Voraussetzung ist eine Fassung, deren signierter Skriptstand `fernlauf.sh` mitbringt; mit einer älteren endet der Fernlauf im Schritt `fassungen`, ohne etwas zu ändern.
Ein neues Tunnel-Programm bringt der Fernlauf nicht: Das kommt nur an der Werkbank auf ein Gerät.

**Nachts von selbst (S4, Entscheid E3 = B, §11.2).**
Zusätzlich zum Knopf bekommt jede wartende Box, die der Knopf erlaubt, die neueste Fassung nachts von selbst.
Der Takt `NachtlaufWatcher` (einmal je Minute, an `voltpilot.ota.mqtt-listener-enabled` wie der `RolloutWatcher`) legt zwischen 02:00 und 05:00 Berliner Zeit je Durchlauf höchstens einen Auftrag an: denselben Auftrag „aufspielen“ wie der Knopf, mit dem Akteur „Automatik · nachts“ (`nachtlauf`) am Fenster, am Auftrag und im Fernwartungs-Protokoll.
Was erlaubt ist, entscheidet allein die reine Regel `Nachtlauf` (Tests `NachtlaufTest`):
- ein Lauf, der vor 05:00 beginnt, läuft zu Ende; solange irgendein Fernlauf offen ist, wartet der Takt;
- kein Drängeln: endete der letzte Lauf einer Box mit der neuesten Fassung zurückgenommen oder offen, versucht die Automatik diese Fassung dort nicht noch einmal, bis eine neuere Fassung kommt oder jemand „Noch einmal“ drückt;
- Halt: wurde in dieser Nacht ein Lauf mit einer Fassung zurückgenommen oder blieb er offen, bekommt in dieser Nacht keine weitere Box diese Fassung (je Fassung, also je Linie: Ein Halt bei Edge Light hält Edge Industrie nicht an und umgekehrt);
- jede Box höchstens einmal je Nacht, höchstens 20 Nachtläufe je Nacht, kein Auftrag ohne Rückmeldung des Tunnel-Dienstes aus den letzten 3 Minuten.

Bei mehreren Replikaten führt nur eins: der Takt hält eine Sitzungs-Sperre der Datenbank (`pg_try_advisory_lock`), ein zweiter Takt tut dann nichts.
Der Schalter des Betriebs steht in der Karte „Ohne Kundenkonto“ auf Geräte › Updates („Nachts von selbst: an · nächster Lauf 02:00“, „Anhalten“/„Einschalten“, `GET/POST /api/v1/admin/geraete/ohne-kundenkonto/nachtlauf`), ab Werk an; jede Umstellung ist eine Zeile in `werkstatt_nachtlauf_schalter` (nur angehängt, es gilt die jüngste).
Angehalten bleibt nur der Knopf.
Die Karte zeigt je Box „heute Nacht“, wenn die Automatik sie in der nächsten Nacht nimmt, die Akte darunter „Sonst heute Nacht von selbst“; ein zurückgenommener oder offener Nachtlauf steht morgens in „Braucht dich“ mit Grund und dem Hinweis, dass die Automatik für diese Fassung angehalten hat.

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

## Zubehör zum Herunterladen (vp-werkstatt-zubehoer-download)

Dieselbe Karte bietet, getrennt von der Box-Druckdatei, zwei Zubehörteile an: den Hutschienen-Clip
und die Bohrlehre für die Wandmontage. Beide tragen keine Kennung und sind für jede Box gleich -
anders als das Gehäuse gilt für sie deshalb NICHT die Regel „nie eine allgemeine Gehäuse-Datei ohne
Kennung“ (die betrifft nur das Gehäuse selbst, Unterteil und Deckel). Je Teil zeigt die Karte Name,
Zweck, Druckhinweis und den ehrlichen Stand aus [druck/README.md](../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/README.md)
(nicht erfunden): Beide sind nur gerechnet und zur Probe geslict, noch nie gedruckt.

Ausgeliefert werden genau die eingecheckten Dateien aus
[`edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/`](../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/README.md)
(`hutschienen-clip.3mf`, `bohrlehre.3mf`) - eine Quelle der Wahrheit, keine zweite, von Hand
gepflegte Kopie. `pom.xml` legt sie beim Bau der API unverändert ins Jar (wie die Rechte-Matrix,
`WerkstattZubehoerDatei`), das `Dockerfile` kopiert sie in die Bau-Stufe. Die Karte lädt ein Teil
über `GET /api/v1/admin/werkstatt/zubehoer/{teil}` (`teil` = `hutschienen-clip` oder `bohrlehre`,
nur `platform-admin`, `model/3mf`); `WerkstattZubehoerDateiTest` erzwingt Byte- und
Prüfsummen-Gleichheit gegen `druck/SHA256SUMS`.

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
| `GET /regel` | der Stand der Werkstatt: `zustand` (`laeuft`, `angehalten`, `wartet`) mit Grund, was sie aufspielt (Edge Light mit `releaseSeq`, OpenWrt), die Freigabe, die der Dienst gerade bekommt (`vonHand` im Übergang), `heute` und `tagesgrenze`, das Protokoll (`verlauf`); legt nichts an |
| `POST /anhalten`, `POST /fortsetzen` | `{"grund": "…"}` (wahlfrei, höchstens 500 Zeichen) bzw. ohne Inhalt: 200 mit dem Stand; ein Eintrag im Protokoll nur, wenn sich etwas ändert |
| `GET /freigaben` | alle Freigaben, neueste zuerst, mit `quelle` (`regel`, `formular`) und `edgeReleaseSeq`: der Beleg, was wann galt |
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
(mit ihrem Code) bleiben als Verlauf; die Einlösung zählt weiter zur Obergrenze ihrer Freigabe und zur Tagesgrenze.
`werkstatt_abnahme` und `werkstatt_box_entfernt` sind append-only an der Datenbankgrenze, und eine abgenommene Box
hält ihre Abnahme per Fremdschlüssel fest. Migrationen `V20261026200000__werkstatt.sql`,
`V20261105170000__werkstatt_box_entfernen.sql`, `V20261106080000__werkstatt_fehlversuch_loeschen.sql`,
`V20261105200000__werkstatt_auftrag_zur_seite.sql` (`werkstatt_auftrag`:
Aufträge an den Dienst, nur `abgeholt_am` ändert sich; `werkstatt_zur_seite`: append-only),
`V20261116150000__werkstatt_regel.sql` (`werkstatt_freigabe.quelle` und `edge_release_seq`; `werkstatt_betrieb`:
Anhalten und Fortsetzen, append-only).

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
