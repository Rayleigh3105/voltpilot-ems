# Runbook: Werkstatt-Dienst

Betrieb des [Werkstatt-Dienstes](../README.md) im Cluster (Namespace `werkstatt-prod`) und der
[Werkbank-Brücke](../bruecke/README.md). Stand V1a, erster Schnitt: Brücke, Freigabe, Anzeige. Die Schritte an der
Box (OpenWrt, Passwort, Edge Light, Tunnel) kommen mit P3 und P5 dazu; dieses Runbook wächst mit.

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

### Keycloak (erst ab V1 benutzt)

V1a spricht nicht mit der API. Ab V1 (Paket P6: Freigabe, Einmal-Code, Abnahme mit Belegen) braucht der Dienst ein
Dienstkonto, im Muster von `voltpilot-tunnel-dienst`. Im Live-Realm `voltpilot` von Hand anlegen (der
Realm-Import fasst Dienstkonten im bestehenden Realm nicht an); bis P6 ausgerollt ist, darf es deaktiviert bleiben.

| Einstellung | Wert |
|---|---|
| Client ID | `voltpilot-werkstatt-dienst` |
| Name | VoltPilot Werkstatt-Dienst |
| Client authentication | an (vertraulich) |
| Standard flow, Implicit, Direct access grants | aus |
| Service accounts (client_credentials) | an |
| Redirect URIs, Web origins | leer |
| Rolle des Dienstkontos | Realm-Rolle `werkstatt-dienst` (neu anlegen), **nicht** `platform-admin` |

Das Client-Secret kommt als `keycloak-client-secret` in das SOPS-Secret (in der Vorlage auskommentiert). Was die
Rolle darf, legt P6 fest: laufende Freigaben lesen, Einmal-Codes nur in einer laufenden Freigabe, das eigene
Probe-Fenster schließen, Lauf und Abnahme schreiben. Nicht: freigeben, Fenster öffnen, Kunden, Kopplung, Updates.

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

## Werkstatt freigeben

Die Freigabe ist eine Datei (`freigabe.json`) in der ConfigMap `werkstatt-freigabe`. Sie steht bewusst nicht im
gitops-Repo: Argo CD verwaltet sie nicht und setzt sie nicht zurück. Vorlage:
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
| PS-1 bis PS-4 | Mango ab Werk (SSH ohne Passwort, `sysupgrade -n`, Dauer je Schritt, Startlader) | mit P3; PS-1 ist schon heute mit dem Mac messbar (Mango per Kabel an den Mac, `ssh root@192.168.8.1`) |
