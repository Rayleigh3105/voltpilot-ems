# Fernlauf durch den Wartungstunnel (v1)

Neue Software für eine Box ohne Kundenkonto, aufgespielt vom Werkstatt-Dienst durch den Wartungstunnel: Edge Light auf der Mango, Edge Industrie auf dem WAGO PFC200.
Konzept `vp-update-vor-zuordnung`, entschieden 18.11.2026 (E1 = A, E2 = A); dieser Vertrag ist die Stufe S1, der Knopf in der Geräteakte.
Vokabulare: [`werkstatt-fernlauf.json`](werkstatt-fernlauf.json); Zwillinge `FernlaufRegel.java` (API), `internal/fernlauf` (Werkstatt-Dienst), `werkstattFernlauf.ts` (Portal).
Routen und Formen: [`openapi.yaml`](openapi.yaml) (`/api/v1/admin/geraete/{ref}/fernlauf`, `/api/v1/admin/geraete/ohne-kundenkonto` - Karte „Ohne Kundenkonto", S2, derselbe Stand für jede Box, keine zweite Logik - `/api/v1/werkstatt-dienst/fernlaeufe/…`, Schema `FernlaufAuftrag`).

## Ablauf

1. **Auftrag** (API, nur `platform-admin`): Die Vorprüfung verlangt eine Box ohne Gerätezeile und ohne Zertifikat, Edge Light oder Edge Industrie (Werkstatt-Register oder `deviceInfo`, siehe [Zwei Geräte](#zwei-geräte-eine-linie-je-gerät)), eine gemeldete Fassung, die im Register steht und älter ist als die neueste zuweisbare Fassung ihrer Linie mit Skriptstand (`WerkstattRegel.neueste(geraet)`, dieselbe wie in der Werkstatt), einen aktiven Tunnel-Zugang, eine Rückmeldung des Tunnel-Dienstes höchstens 3 Minuten alt mit „verbunden“ und einer Schlüsselfrage in den letzten 3 Minuten, einen aktiven Techniker-Zugang des Dienstes, einen Dienst, der sich in den letzten 60 s gemeldet hat und `fernlauf.bereit` meldet, einen Host-Schlüssel aus Abnahme oder Einlösung und keinen offenen Auftrag.
   Dann öffnet sie ein Fenster von 30 Minuten für den Zugang „Werkstatt-Dienst“ mit dem Auslöser als Akteur und legt den Auftrag an (Fassung, Quelle, Prüfsummen fest am Auftrag).
2. **Abholen**: Die Antwort auf `PUT …/werkstatt-dienst/ansicht?auftraege=1` nennt jeden abholbaren Auftrag (`art` `aufspielen`, `id` der Auftrag, `lauf` die Referenz), bis der Dienst ihn mit `POST …/fernlaeufe/{id}/beginnen` annimmt oder die Abholfrist (10 Minuten) endet.
   Hat die Box inzwischen ein Kundenkonto oder ein Zertifikat, oder ist das Fenster zu, endet der Auftrag beim Annehmen ohne Änderung.
3. **Fernlauf** (Werkstatt-Dienst, ein Auftrag zur Zeit): die Schritte unten; jeder Schritt geht als `laeuft`, dann `belegt` oder `gescheitert` mit einer Zeile Beleg an die API.
4. **Ende**: Der Dienst schließt das Fenster seines Auftrags (`…/fenster/schliessen`, nur dieses) und schreibt das Ergebnis (`…/ergebnis`, genau eins je Auftrag, nur angehängt).

Die Tabelle beschreibt die Mango; was am PFC200 anders ist, steht unter [Zwei Geräte](#zwei-geräte-eine-linie-je-gerät).

| Schritt | Was | Bei Fehler |
|---|---|---|
| `anmelden` | WireGuard im Prozess, SSH als root an 2222 mit dem Schlüssel des Zugangs, Versuche im Takt bis die Box den Schlüssel des Fensters abgeholt hat; Host-Schlüssel genau der aus der Werkstatt | nichts geändert |
| `bestand` | Referenz = Auftrag, kein Zertifikat auf der Box, `/health` nennt die laufende Fassung, Stand aus `current.json`; nur aufwärts | nichts geändert |
| `fassungen` | Programm und Skriptstand nach sha256, Manifest und Vertrauens-Set laden, Signaturkette gegen die eingebackene Wurzel (`fassungen.PruefeSignatur`, dieselbe Prüfung wie im Werkstatt-Schritt), dann Fassung, Stand, Programm, Skriptstand, Boden | nichts geändert |
| `sichern` | genug Fenster übrig; Stand des Tunnels (`service-tunnel.sh status`); was `install.sh` und das Einrichtungs-WLAN ändern, als tar.gz in den Speicher des Dienstes, ohne Identität, ohne WLAN-Einstellung (vom Funkmodul nur das Land) | nichts geändert |
| `aufspielen` | `install.sh` des Skriptstands über die Durchreiche (wie Schritt `programm` der Werkstatt) mit genau den geprüften Bytes, dann Land DE und `relayd` (wie `einrichtung_wlan`) | zurück |
| `neustart` | `/etc/init.d/vp-edge-light restart`, `/health` mit Referenz und neuer Fassung, update-bereit | zurück |
| `meldet_sich` | binnen 3 Minuten eine neue Zertifikatsanfrage mit `vp-edge-core <neue Fassung>` und danach eine weitere Abfrage (`…/meldung`) | zurück |
| `tunnel` | `service-tunnel.sh status`: nichts fehlt, was vor dem Lauf da war | zurück |
| `zurueck` | nur nach einem Fehler ab `aufspielen`: Programm anhalten, Neues entfernen, Sicherung einspielen, Land zurück, Firewall und cron neu laden, Programm starten; `/health` und die Plattform nennen wieder die alte Fassung | Ergebnis `offen` |
| `fenster_zu` | das Fenster dieses Auftrags schließen | Fenster läuft nach 30 Minuten ab |

Ergebnisse: `fertig` (neue Fassung läuft), `zurueck` (alte Fassung läuft wieder), `unveraendert` (vor dem Aufspielen beendet), `offen` (Stand unbekannt: Rücknahme gescheitert, Tunnel gerissen, Dienst neu gestartet).
Zustände in der Akte zusätzlich: `erteilt`, `laeuft` und `nicht_abgeholt`; ein angenommener Auftrag ohne Ergebnis nach dem Ende seines Fensters heißt `offen`.
Der nächste Auftrag für dieselbe Box schreibt für solche Aufträge das Ergebnis mit Quelle `portal` und schließt ein noch offenes Fenster.

## Zwei Geräte, eine Linie je Gerät

Welches Gerät eine Box ist, sagt `FernlaufRegel.geraet`: das Werkstatt-Register (`edge-light`, `edge-industrie`) und die Linie der gemeldeten Fassung (`edge-light-…`, `edge-industrie-…`).
Nennt nur eines von beiden ein Gerät, gilt es.
Widersprechen sie sich, gibt es keinen Knopf (Grund `keine_edge_light`): Die API rät nicht, welche Linie auf das Gerät gehört.
Eine Mango bekommt nur Edge Light, ein PFC200 nur Edge Industrie, auch wenn die andere Linie den höheren Stand hat.
Der Code `keine_edge_light` stammt aus der Zeit, als nur Edge Light den Tunnel hatte; er bleibt, sein Satz nennt beide.

Der Auftrag trägt kein Feld für das Gerät.
Der Dienst liest es an der Linie von `ziel.fassung` (`fernlauf.IstIndustrie`) und fährt dieselben Schritte mit denselben Namen.
Am PFC200 ist anders:

| Schritt | Am PFC200 (Edge Industrie) |
|---|---|
| `bestand` | Referenz, Zertifikat und Stand aus `/home/voltpilot/daten`; meldet `/health` keine Edge-Industrie-Fassung, endet der Lauf hier ohne Änderung (andere Linie) |
| `fassungen` | Programm `linux/arm` und Skriptstand `edge-industrie-skripte.tar.gz`, Manifest der Linie `industrie`; das Tunnel-Programm lädt der Fernlauf nicht. Bringt der geprüfte Skriptstand `fernlauf.sh` nicht mit, endet der Lauf hier ohne Änderung: Eine Fassung, die er nicht sichern und nicht zurücknehmen kann, spielt er nicht auf |
| `sichern` | Stand des Tunnels aus `vp-wartung status werte`; `fernlauf.sh sichern` holt genau, was `install.sh` schreibt (Loader, Dienst-Skript mit seinem Start-Link, Einstellungen, Vertrauens-Set und Stand, bestätigte Fassung). Der Dienst prüft die Sicherung Eintrag für Eintrag gegen dieselbe Liste und bricht ab, wenn sie Identität, Referenz, Tunnel oder Zugänge enthielte |
| `aufspielen` | `install.sh` des Skriptstands mit `VP_INDUSTRIE_ARCH`, `VP_INDUSTRIE_MANIFEST` und Vertrauens-Set; kein Land, kein `relayd` |
| `neustart` | `fernlauf.sh neustart`: nur `/etc/init.d/vp-edge-industrie restart`, dann `/health` und update-bereit für die Linie `industrie` |
| `tunnel` | `vp-wartung status werte`: nichts fehlt, was vor dem Lauf da war |
| `zurueck` | `fernlauf.sh zurueck`: Sicherung auf dem Gerät prüfen (ein unlesbares oder fremdes Archiv ändert nichts), Dienst anhalten, Verzeichnisse als Ganzes tauschen, Dateien ersetzen, Dienst starten |

Am PFC200 läuft neben dem Programm von VoltPilot die Steuerung.
Darum gilt dort zusätzlich:

- Neu startet nur der Dienst `vp-edge-industrie`. Nie das Gerät, nie die SPS-Laufzeit.
- Firmware, SPS-Programm, Firewall, Netze, Passwörter und der Dropbear des Geräts bleiben, wie sie sind.
- Das Tunnel-Programm `vp-wartung` und sein Dienst bleiben, wie sie sind: Durch den Tunnel läuft der Fernlauf. Ein neues Tunnel-Programm kommt nur an der Werkbank auf ein Gerät.

Das Skript `edge-industrie/fernlauf.sh` gehört zum signierten Skriptstand; der Dienst führt es erst nach der Prüfung der Signaturkette aus.
`edge-industrie/test/fernlauf-probe.sh` belegt es im BusyBox-Container für ARMv7 (kein Neustart des Geräts, Prozesse von Steuerung und Tunnel behalten ihre Nummer, Rücknahme Byte für Byte).
Dass Skript und Dienst zueinander passen (Befehle, Liste des Gesicherten), bindet `TestEchtesSkriptPasstZumDienst`.

## Regeln

- Nie angefasst: OpenWrt, Passwort, Notfall-Schlüssel, Tunnel (WireGuard, Dropbear 2222, Abholer, Tunnel-Ketten), LAN, `/etc/vp-edge-light/identity` und `ref`; am PFC200 dazu, was oben steht, und `/home/voltpilot/daten/identity` und `ref`.
- Kein Schlüssel und kein Passwort in Log, Protokoll, Schritt oder Ergebnis; die API weist Schlüsselmaterial ab (422).
- Der Akteur ist ein Feld (`akteur_sub`, `akteur_name`): Sammellauf (S2) und Nachtlauf (S4) legen denselben Auftrag an.
  Der Nachtlauf trägt `akteur_sub` `nachtlauf` und `akteur_name` „Automatik · nachts“; die Akte liest daraus `nachts: true` (Regeln in [Werkstatt](../werkstatt.md#neue-software-durch-den-tunnel-box-ohne-kundenkonto), Schalter `/api/v1/admin/geraete/ohne-kundenkonto/nachtlauf`).
- Was der Dienst meldet, ist Anzeige und Beleg; den Weg zur Box gibt allein das Fenster der API.
