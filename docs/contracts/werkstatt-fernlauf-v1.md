# Fernlauf durch den Wartungstunnel (v1)

Neue Software für eine Edge-Light-Box ohne Kundenkonto, aufgespielt vom Werkstatt-Dienst durch den Wartungstunnel.
Konzept `vp-update-vor-zuordnung`, entschieden 18.11.2026 (E1 = A, E2 = A); dieser Vertrag ist die Stufe S1, der Knopf in der Geräteakte.
Vokabulare: [`werkstatt-fernlauf.json`](werkstatt-fernlauf.json); Zwillinge `FernlaufRegel.java` (API), `internal/fernlauf` (Werkstatt-Dienst), `werkstattFernlauf.ts` (Portal).
Routen und Formen: [`openapi.yaml`](openapi.yaml) (`/api/v1/admin/geraete/{ref}/fernlauf`, `/api/v1/werkstatt-dienst/fernlaeufe/…`, Schema `FernlaufAuftrag`).

## Ablauf

1. **Auftrag** (API, nur `platform-admin`): Die Vorprüfung verlangt eine Box ohne Gerätezeile und ohne Zertifikat, Edge Light (Werkstatt-Register oder `deviceInfo`), eine gemeldete Fassung, die im Register steht und älter ist als die neueste zuweisbare Fassung mit Skriptstand (`WerkstattRegel.neueste()`, dieselbe wie in der Werkstatt), einen aktiven Tunnel-Zugang, eine Rückmeldung des Tunnel-Dienstes höchstens 3 Minuten alt mit „verbunden“ und einer Schlüsselfrage in den letzten 3 Minuten, einen aktiven Techniker-Zugang des Dienstes, einen Dienst, der sich in den letzten 60 s gemeldet hat und `fernlauf.bereit` meldet, einen Host-Schlüssel aus Abnahme oder Einlösung und keinen offenen Auftrag.
   Dann öffnet sie ein Fenster von 30 Minuten für den Zugang „Werkstatt-Dienst“ mit dem Auslöser als Akteur und legt den Auftrag an (Fassung, Quelle, Prüfsummen fest am Auftrag).
2. **Abholen**: Die Antwort auf `PUT …/werkstatt-dienst/ansicht?auftraege=1` nennt jeden abholbaren Auftrag (`art` `aufspielen`, `id` der Auftrag, `lauf` die Referenz), bis der Dienst ihn mit `POST …/fernlaeufe/{id}/beginnen` annimmt oder die Abholfrist (10 Minuten) endet.
   Hat die Box inzwischen ein Kundenkonto oder ein Zertifikat, oder ist das Fenster zu, endet der Auftrag beim Annehmen ohne Änderung.
3. **Fernlauf** (Werkstatt-Dienst, ein Auftrag zur Zeit): die Schritte unten; jeder Schritt geht als `laeuft`, dann `belegt` oder `gescheitert` mit einer Zeile Beleg an die API.
4. **Ende**: Der Dienst schließt das Fenster seines Auftrags (`…/fenster/schliessen`, nur dieses) und schreibt das Ergebnis (`…/ergebnis`, genau eins je Auftrag, nur angehängt).

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

## Regeln

- Nie angefasst: OpenWrt, Passwort, Notfall-Schlüssel, Tunnel (WireGuard, Dropbear 2222, Abholer, Tunnel-Ketten), LAN, `/etc/vp-edge-light/identity` und `ref`.
- Kein Schlüssel und kein Passwort in Log, Protokoll, Schritt oder Ergebnis; die API weist Schlüsselmaterial ab (422).
- Der Akteur ist ein Feld (`akteur_sub`, `akteur_name`): Sammellauf (S2) und Nachtlauf (S4) legen denselben Auftrag an.
- Was der Dienst meldet, ist Anzeige und Beleg; den Weg zur Box gibt allein das Fenster der API.
