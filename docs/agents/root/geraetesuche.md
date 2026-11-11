# Gerätesuche: Wegweiser über Vertrag, Box, API, Portal und Belege

Konzept `vp-portal-geraetesuche-konzept` (Captain 30.10.2026, DP-1 C, DP-2 bis DP-7 A), gebaut in den Paketen 1–4
(#1605–#1608), auf VoltPilotGATE nachgebessert (#1609–#1612). Der Knopf „Geräte suchen“ startet auf der Box eine
lesende Suche in ihren privaten Netzen; das Portal zeigt die Funde in sechs Gruppen und übernimmt erkannte Geräte mit
einem Tipp in den bestehenden Anlege-Fluss. V3 (gezieltes Wiederfinden von der Geräteseite) ist nicht gebaut.

| Was | Wo |
|---|---|
| Vertrag | [`mqtt-geraetesuche.md`](../../contracts/v2/mqtt-geraetesuche.md) mit drei Schemas (`mqtt-geraetesuche*.schema.json`) und [`geraetesuche-vectors.json`](../../contracts/v2/geraetesuche-vectors.json) (Erkennungskatalog je Box-Art, Gruppen-Fälle, Grenzen); Bereichsregel [`lan-range-vectors.json`](../../contracts/lan-range-vectors.json); [OCPP „klopft an“](../../contracts/ocpp-klopft-an.md); Fähigkeit `geraetesuche` in [`edge-supports.md`](../../contracts/v2/edge-supports.md) und [`edge-capabilities.json`](../../contracts/v2/edge-capabilities.json); Routen im OpenAPI-Tag `geraetesuche` |
| Box (Go, beide Box-Arten) | `edge-app/core/internal/geraetesuche/vertrag.go` (Vertragswörter, `Pruefe`), `klopftan.go`; Suchmodul `…/geraetesuche/suche/` (`leitung.go` Zulassung und Ablauf, `netze.go` Bereich, `takt.go`, `werkzeug.go` Budget je Gerät, `erkenner.go`/`solarman.go`/`netztechnik.go` Erkenner, `rundruf.go` mDNS/SSDP/Speedwire nur Edge Light); Anbindung `internal/agent/geraetesuche.go`, `internal/cloud/geraetesuche.go`; Simulator `…/geraetesuche/geraetesim` (`cmd/vp-geraete-sim`) |
| Edge Light | Unterschiede je Box-Art: Vertrag §3 „Je Box-Art“ und [Paritätsliste](../../../edge-light/docs/paritaet.md) (Zeile „Gerätesuche“) |
| API | [Gerätesuche, API-Seite](geraetesuche-api.md): `web/GeraetesucheController`, Paket `com.voltpilot.api.geraetesuche`, Migrationen `V20261030140000__geraetesuche.sql` und `V20261030181500__geraetesuche_herkunft.sql` (Herkunft) |
| Portal | Routen-Typen `src/geraetesuche.ts`; Regeln und Sätze `src/geraetesucheAnsicht.ts`; Herkunft und Aktivität `src/geraetesucheHerkunft.ts`; Modal `components/GeraetesucheDialog.tsx`, Knöpfe `components/GeraetesucheEinstieg.tsx`; Bedienung in [`docs/portal.md`](../../portal.md) („Geräte suchen“); Kundenwörter `UEMS_GERAETE_SUCHEN` … in `src/glossar.ts` und im [Glossar](../../fachmodell/glossar.md) |
| Hilfe | Artikel `geraete-suchen` in `frontend/portal/src/help/content/anlage.ts` (Abschnitte `nur-lesen`, `wer-und-was-bleibt`, `gruppen`, `nicht-gefunden`, `box-auf-rechner`) und der Abschnitt `anlagenmodell` › `geraete-suchen` |

## Was gilt

- **Nur lesen, nur eigene private Netze:** Kundennetz und Box-Netz, je höchstens /24, höchstens 180 s, 6 Starts je
  Stunde und Box. Die Cloud gibt keine Netze, Ports oder Takte vor (Vertrag §2, §3).
- **Docker-Box durch NAT (DP-2 A):** nur das /24 um `VP_LAN_HOST`, nur TCP; ohne `VP_LAN_HOST` `abgelehnt`/`lan_host_fehlt`.
  mDNS, SSDP und Funkmodul-Liste gibt es nur auf Edge Light; die Docker-Box zählt Telefone und Rechner als `unbekannt`.
- **„Erkannt, mit dieser Box noch nicht anbindbar“** = `anbindung` `nicht_mit_dieser_box` oder `kein_leseweg`, festgelegt
  je Paar und Box-Art im Erkennungskatalog der Vektoren — nicht in Portal oder API nachbauen.
- **Datenschutz (DP-3 A):** keine MAC, kein Hostname, kein Gerätename; Telefone/Rechner nur als Zahl; Suchen und Funde
  30 Tage, das Protokoll bleibt. **Recht** `geraet.einrichten` an der Anlage (DP-4 A).
- **Gleichheit sagt allein der Server** (`abgleich`), nie dieselbe Adresse; eine neue Adresse ist ein Vorschlag, den ein
  Tipp übernimmt (DP-7 A).
- **Herkunft nur aus dem Protokoll:** wer aus der Suche übernimmt („Übernehmen“ und „Selbst beschreiben“), schickt den
  Bezug `{ suchId, fund }` mit; der Server prüft ihn und schreibt `uebernommen`. Daraus liest die Komponente „aus der
  Gerätesuche vom …“ und die Aktivität der Box den fünften Strom `geraetesuche`; ohne Bezug keine Herkunft, nie geraten.
- **Hilfe-Artikel und Modal sprechen dieselben Wörter:** `help.test.ts` liest die Gruppen-Überschriften
  (`GRUPPEN_TITEL`) und die Prüffragen (`nichtsGefundenFragen`) aus `geraetesucheAnsicht.ts`. Wer dort ein Wort ändert,
  ändert den Artikel mit.

## Belege

- Simulatoren und Vektoren: die Tests unten.
- VoltPilotGATE (Edge Light, Pilot von Hand, DP-6 A): die Befunde der Abnahme 5a und der Nachabnahme 5b nennen
  https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1610 und https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1611;
  die Läufe nach den Fixes stehen in den PR-Texten von
  https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1611 und https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1612 —
  (in #1612 fanden alle drei Läufe Deye, Shelly Pro 3, FRITZ!Box und TP-Link) — mit einem Wegwerf-Treiber über
  `suche.Leitung`, nicht über das Portal. Die Abnahme Ende zu Ende durch das Portal folgt nach dem Produktions-Deploy.
- Firewall: die mDNS/SSDP-Antworten kommen am GATE nur wegen `wan` `input=ACCEPT` an (Paritätsliste).

## Prüfen

```bash
(cd edge-app/core && go test ./internal/geraetesuche/... ./internal/agent/ ./internal/cloud/)
(cd frontend/portal && npx vitest run --maxWorkers=2 --minWorkers=1 src/geraetesuche.test.ts src/geraetesucheAnsicht.test.ts src/geraetesucheHerkunft.test.ts src/selbstbau.test.ts src/components/GeraetesucheDialog.test.tsx src/components/AnlegenFlow.test.tsx src/help/help.test.ts src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/geraetesuche.spec.ts)
```

API-Tests: [Gerätesuche, API-Seite](geraetesuche-api.md#prüfen).
