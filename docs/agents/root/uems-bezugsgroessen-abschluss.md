# UEMS-Bezugsgrößen: Abschluss, Bestandsschutz und Betrieb (AP-09 IP-19)

Das letzte der neunzehn AP-09-Pakete. Diese Seite ist der Einstieg in Bezugsgrößen, manuelle Eingabe,
Ablesungen und CSV-Importe. Maßgeblich bleiben die verlinkten Detailwegweiser und die Verträge unter
`docs/contracts/v2/`.

## Einstieg je Schicht

| Schicht | Wegweiser | Pakete |
|---|---|---|
| Vertrag, Einheiten, Perioden und CSV-Regeln | `uems-bezugsdaten-vertrag-java-ts-zwill.md`, `uems-einheiten-perioden-module.md`, `uems-csv-leser.md` | IP-1 bis IP-3, IP-11 |
| Tabellen, Routen, Flächen und Stammdaten | `uems-bezugsgroessen-tabellen.md`, `uems-bezugsgroessen-routen.md`, `uems-bezugsflaechen-stammdaten.md` | IP-4 bis IP-6 |
| Eingabe, Berichtigung und Ablesungen | `uems-bezugswert-eingeben.md`, `uems-ablesungen.md` | IP-7, IP-8 |
| Vorschau, Übernahme und Vorlagen | `uems-import-vorschau.md`, `uems-import-uebernahme.md`, `uems-bezugsdaten-vorlagen.md` | IP-12 bis IP-14 |
| Portal: Welt, Eingabe, Import und Protokoll | `uems-bezugsgroessen-portal.md`, `uems-werte-portal.md` | IP-9, IP-10, IP-15, IP-16 |
| Messkanal, Gradtage und Portal-Bindung | `uems-bezugsgroesse-kanalbindung.md` | IP-17, IP-18 |

## Bestandsschutz

- `UemsBezugsdatenBestandsschutzTest` füllt den bestehenden Kern mit Telemetrie v1/v2 und
  Geräte-Messwerten, aktualisiert alle sechs Rollups und nimmt den bestehenden Messwert-Export in
  `decoded` und `raw` auf. Die Quellen für die spätere Kanalbindung liegen schon vor der ersten
  Aufnahme vor.
- Danach laufen eine echte CSV-Vorschau samt Übernahme und der echte `KanalbindungLauf`. Der Test
  belegt die Importzeile, den importierten Wert, Bindung und Messkanal-Wert. Anschließend sind die
  sechs Rollup-Inhalte und beide Export-Bytefolgen unverändert. Neu hinzukommende Telemetrie wird
  nicht fälschlich als Bezugsgrößenwirkung ausgegeben.
- Timescale-Hintergrundjobs sind während des Vergleichs aus. Ohne Docker meldet der Test ausdrücklich,
  dass der Abschlussnachweis nicht gelaufen ist.

## Upload-Grenze und Produktionsweg

- Der fachliche Leser und Spring erlauben je CSV-Datei genau **5 MiB = 5 242 880 Bytes**.
  `spring.servlet.multipart.max-file-size` ist `5MB`, `max-request-size` ist `6MB` für Zuordnung und
  Multipart-Rahmen; `resolve-lazily: true` hält die benannte Antwort `datei_zu_gross` erreichbar.
- Der GitOps-Stand setzt am Kubernetes-Ingress `nginx.ingress.kubernetes.io/proxy-body-size: "8m"`.
  Das ist größer als Spring und begrenzt die fachlich zulässige Datei nicht.
- **Betriebsbefund vor `uems` → `main`:** Der davorliegende Frontend-nginx proxyt `/api/`, setzt aber
  kein `client_max_body_size`. Damit gilt dort die nginx-Vorgabe von 1 MiB und eine fachlich zulässige
  CSV kann den API-Controller nicht erreichen. Im GitOps-Repository wurde nichts geändert. Vor der
  Freigabe muss der Proxy mindestens die 6-MB-Anfrage zulassen und der Upload einmal über den echten
  Produktionsweg geprüft werden. Der vollständige Betriebsvertrag steht in `docs/k8s-readiness.md`.

## Laufzeit und Schalter

- Bezugsgrößen-Routen, Eingabe, Vorschau und Übernahme haben keinen Feature-Schalter.
- `voltpilot.uems.zeilentexte.enabled` schaltet nur die tägliche Löschung abgelaufener importierter
  Zeilentexte; Vorgabe ist an, im Testlauf aus. Bindung und Bildung laufen als Schritt des vorhandenen
  Endgültigkeitslaufs und haben keinen eigenen Dunkelschalter.
- Fehlend ist keine Null: Import, Ablesung und Kanalwert bleiben getrennte Herkünfte; eine gebundene
  Periode sperrt Eingabe und Import mit `kanal_gebunden`.

## Prüfen

```bash
(cd services/api && ./mvnw clean test -Dtest=UemsBezugsdatenBestandsschutzTest)
(cd frontend/portal && npx vitest run src/copy.test.ts)
bash tools/agents-md-budget.sh
```
