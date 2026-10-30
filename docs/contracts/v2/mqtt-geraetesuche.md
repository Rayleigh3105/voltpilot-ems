# Gerätesuche über MQTT (mqtt-geraetesuche 1.0)

Ein Knopf „Geräte suchen“ im Portal startet auf der Box einen lesenden Suchlauf im Heimnetz; das Portal zeigt die Funde
nach Nutzen gruppiert. Konzept: `vp-portal-geraetesuche-konzept` (30.10.2026), entschieden DP-1 C, DP-2 bis DP-7 A.
Schemas: [Auftrag](mqtt-geraetesuche.schema.json), [Zwischenstand](mqtt-geraetesuche-stand.schema.json),
[Ergebnis](mqtt-geraetesuche-ergebnis.schema.json). Fälle, Grenzen, Erkennungskatalog und Antwort-Vokabular:
[`geraetesuche-vectors.json`](geraetesuche-vectors.json). Bereichsregel: [`lan-range-vectors.json`](../lan-range-vectors.json).
HTTP: Tag `geraetesuche` in [`openapi.yaml`](../openapi.yaml). Abgewiesene Ladesäulen: [OCPP „klopft an“](../ocpp-klopft-an.md).

**Stand:** nur der Vertrag mit seinen Lesern und Prüfern (Go `internal/geraetesuche` und `internal/probe/bereich.go`,
Java `geraetesuche`, TS `geraetesuche.ts`). Suchmodul, Erkenner, Tabellen, Routen und Oberfläche kommen in eigenen
Paketen. Bis eine Box die Fähigkeit `geraetesuche` meldet, antwortet die Route 409 `nicht_unterstuetzt`.

## 1. Topics

| Richtung | Topic | retained | QoS |
|---|---|---|---|
| Cloud → Box | `ems/{tenant}/{site}/{device}/v2/geraetesuche` (starten, abbrechen) | **nein**: ein Einmal-Auftrag läuft nach einem Wiederverbinden nie ein zweites Mal | 1 |
| Box → Cloud | `ems/{tenant}/{site}/{device}/v2/geraetesuche-stand` (alle 2 s, solange die Suche läuft) | nein | 1 |
| Box → Cloud | `ems/{tenant}/{site}/{device}/v2/geraetesuche-ergebnis` (genau eines je `such_id`) | nein | 1 |

Topic- und Payload-Identität (`tenant_id`, `site_id`, `device_id`) müssen übereinstimmen, in beiden Richtungen; sonst
wird die Nachricht still verworfen. Jede Box darf `…/v2/#` (keine Broker-Änderung); v1-Topics bleiben unberührt.
QoS 1 darf doppelt zustellen: derselbe Auftrag startet keine zweite Suche, ein Stand mit kleinerer `nr` ist veraltet,
die Cloud nimmt je `such_id` genau ein Ergebnis an.

**Streng senden, tolerant annehmen.** Die Schemas beschreiben die Sende-Form, und jede Seite prüft vor dem Senden
streng (Box: `geraetesuche.Stand.Pruefe`, `Ergebnis.Pruefe`; API: der Auftrag kommt aus `GeraetesucheAuftrag`).
Beim Lesen gilt: unbekannte Felder und Wörter werden überlesen (additive Felder einer neueren Seite); ein
einzelner Fund, der eine Regel verletzt, wird überlesen und nie gespeichert, die übrige Suche gilt; nur eine Hülle,
die nicht zur Suche passt (Identität, Version, Grund, Netze, Grenzen), wird ganz verworfen. Die Fallklassen
`gueltig`, `ungueltig`, `fund_ueberlesen`, `toleriert` der Vektoren sind genau diese Regel.

## 2. Auftrag (Cloud → Box)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "…",
  "aktion": "starten",
  "such_id": "44444444-4444-4444-8444-444444444444",
  "ausgeloest_am": "2026-11-02T09:00:00Z",
  "gueltig_bis": "2026-11-02T09:02:00Z",
  "erkenner": ["solarman", "shelly", "goe"],
  "ausgeloest_von": "8c4f0d2e-…"
}
```

- `aktion`: `starten` oder `abbrechen` (dann ohne `gueltig_bis`, `erkenner`; ein Abbruch verfällt nicht, er kann nur
  Lesen beenden; ohne laufende Suche dieser `such_id` tut die Box nichts).
- `gueltig_bis` = `ausgeloest_am` + 120 s, nie später (die Box lehnt eine längere Frist als ungültig ab). Danach beginnt
  die Box nicht mehr und meldet `abgelehnt`/`abgelaufen`: eine nachgelieferte Nachricht ist bei ihrer Ankunft verfallen.
- `erkenner` (wahlfrei) engt nur ein; fehlt das Feld, laufen alle Erkenner der Box. Unbekannte Namen überliest die Box.
- `ausgeloest_von`: das JWT-Subject, nur Papier-Spur im Log der Box. Name und Rolle bleiben in der Cloud.
- **Es gibt kein Feld für Netze, Ports, Takt oder Dauer.** Ein solches Feld überliest die Box (Fall `netze_vorgeben`):
  sie glaubt der Cloud nichts, sonst würde jede Box „ein Portscanner“ (`probe.go`).

## 3. Pflichten der Box

| Regel | Wert (`grenzen` der Vektoren) |
|---|---|
| Netze | nur eigene private Netze (Bereichsregel §4), je höchstens /24, höchstens 2: `kundennetz` und `box_netz` (DP-5 A, automatisch) |
| Takt | ≤ 20 neue Verbindungen/s, ≤ 2 gleichzeitig je Gerät, ≤ 3 Erkennungsanfragen je Gerät, 1,5 s Zeitlimit |
| Dauer | eine Suche je Box, höchstens 180 s (`zeitlimit`), Zwischenstand alle 2 s |
| Häufigkeit | höchstens 6 angenommene Starts je Stunde und Box (`zu_oft`) |
| Nur lesen | TCP-Verbindungsaufbau, HTTP-GET auf feste Pfade, Modbus FC 3/4 auf Kennungsregister, Solarman V5 FC 3 auf 0x0000–0x0007, mDNS/SSDP-Anfragen. Nie: Anmeldung, Standardpasswort, Schreibfunktion, AT-Befehl, Konfigurationsseite. 401/403 endet mit `hindernis: geschuetzt`. |
| Ein-Client-Geräte | Logger, die die Box schon liest, werden nicht neu verbunden (`liest_box_schon: true`); neue nur über die Logger-Spur bzw. den Bus-Arbiter, nie parallel |
| Neustart | Docker-Box: der offene Auftrag liegt auf der Platte, nach einem Neustart meldet sie `abgebrochen`/`neustart`. Edge Light hält ihn nur im RAM (kein Flash-Schreiben): dort endet die Suche ohne Ergebnis, die Cloud sagt nach 30 s ohne Stand „nicht zu Ende gemeldet“ |

**Je Box-Art.** Das Suchmodul ist derselbe Go-Code; es unterscheidet sich nur darin, was die Box sieht (DP-2 A):

| | Edge Light (Router) | Docker-Box (Core im Bridge-Container) |
|---|---|---|
| Netze | Schnittstellen mit privater IPv4 ohne Tunnel und Container; Kundennetz = Standardroute | nur das /24 um `VP_LAN_HOST`; fehlt er: `abgelehnt`/`lan_host_fehlt` |
| Nachbarn | UDP-Anstoß + `/proc/net/arp` (`schritt: nachbarn_finden`), kein Raw-Socket | entfällt; TCP zu allen Adressen durch NAT |
| Wege `mdns`, `ssdp`, `funkmodul` | ja | nie (Multicast und MAC kommen nicht durch die Bridge) |
| `ausschnitt` | bekannt | fehlt (Maske des Hosts unbekannt) |

Welche Erkenner und Wege wirklich liefen, steht im Ergebnis (`erkenner`). Fehlt einer, heißt das „nicht gesucht“, nie
„nichts da“ (Unbekannt ist keine Null).

## 4. Bereichsregel

Die Privat-Ziel-Regel des Probe-Kanals (`lan-host-vectors.json`, ein Host-String) gilt für einen Bereich strenger
([`lan-range-vectors.json`](../lan-range-vectors.json)): nur RFC1918-IPv4, Präfix 24 bis 30, ein größeres Netz nur als
/24 um die eigene Adresse (`ausschnitt: true`); keine Tunnel- (`wg*`, `tun*`) und Container-Schnittstellen (`docker*`,
`veth*`, `br-` + zwölf Hex-Zeichen). Ein Ziel ist eine IPv4-Host-Adresse in einem Bereich, nie die Box selbst (damit
auch nie ihre Ports 502, 1883/1884, 8484, 8887), nie Netz- oder Broadcast-Adresse. Die Box bildet damit ihre Netze
(`SuchBereich`) und prüft jedes Ziel (`ZielImBereich`); die API prüft gemeldete Netze (`PruefeBereich`) und speichert nur
Funde, deren Adresse ein erlaubtes Ziel ist.

## 5. Zwischenstand (Box → Cloud)

`such_id`, `nr` (ab 1 steigend), `ts`, `schritt` (`netze_bestimmen` · `nachbarn_finden` · `geraete_ansprechen` ·
`geraete_erkennen`), `erledigt` ≤ `gesamt` (eigene Zählung der Box), `rest_s` (fehlt = unbekannt), `netze[]` (jedes Mal
vollständig) und die **neuen** `funde[]` seit dem vorigen Stand. Der Stand ist Anzeige; verbindlich ist das Ergebnis.

## 6. Ergebnis (Box → Cloud)

```json
{
  "schema_version": "1.0", "tenant_id": "…", "site_id": "…", "device_id": "…",
  "such_id": "44444444-…", "ts": "2026-11-02T09:00:40Z",
  "zustand": "fertig", "dauer_ms": 38120,
  "erkenner": ["solarman", "shelly", "goe", "netztechnik", "modbus_offen", "…"],
  "netze": [{"rolle": "kundennetz", "netz": "192.168.178.0/24", "box_adresse": "192.168.178.20", "erreichbar": true, "aktiv": 9}],
  "funde": [{"schluessel": "solarman:3115580613", "erkenner": "solarman", "art": "wechselrichter", "hersteller": "deye",
             "familie": "hybrid_3p", "spannung": "hv", "seriennummer": "2409066698", "erkennung": "sicher",
             "merkmale": ["v5_kopf_seriennummer", "deye_typ_0x0006", "deye_seriennummer_0x0003"], "anbindung": "uebernehmen",
             "verbindung": {"communication": "solarman_v5", "ip": "192.168.178.34", "port": 8899, "serial": 3115580613, "unit_id": 1},
             "liest_box_schon": false}],
  "weitere": {"unbekannt": 4}
}
```

| `zustand` | `grund` |
|---|---|
| `fertig` | fehlt |
| `abgebrochen` (Funde bis dahin gelten) | `auf_wunsch` · `neustart` · `zeitlimit` |
| `abgelehnt` (nicht gesucht: Funde leer, `dauer_ms` 0) | `laeuft_schon` · `zu_oft` · `abgelaufen` · `lan_host_fehlt` · `kein_privates_netz` |
| `fehlgeschlagen` | `interner_fehler` |

### Der Fund

| Feld | Regel |
|---|---|
| `schluessel` | eindeutig in der Suche: `<erkenner>:<Seriennummer, Logger-Seriennummer oder ip:port>` |
| `erkenner`, `art` | ein Paar aus dem `erkennungskatalog` der Vektoren; sonst wird der Fund überlesen |
| `erkennung` | `sicher` (Selbstauskunft: Register, `/shelly`, `/api/status`), `wahrscheinlich` (Merkmale ohne Selbstauskunft; Übernehmen nur mit Bestätigung), `unbekannt` (nur erreichbar) |
| `anbindung` | was diese Box-Art damit kann: `uebernehmen`, `selbst_beschreiben` (genau bei `unbekannt`), `nicht_mit_dieser_box` (die andere Box-Art liest es schon), `kein_leseweg` (keine Box-Art liest es), `nur_anzeige` (genau bei Netz-Technik) |
| `verbindung` | in den Schlüsseln der Vorlagen (`communication`, `ip`, `port`, `serial`, `unit_id`). `communication` ist die des Katalog-Paars und Pflicht bei `uebernehmen`/`selbst_beschreiben`; `solarman_v5` braucht `serial` (Logger) |
| `hindernis` | `geschuetzt` (Anmeldung verlangt), `lokale_api_aus` (go-e ohne lokale API v2) |
| `merkmale` | 1 bis 8 Wörter, woran erkannt („Woran erkannt?“) |

**„Erkannt, mit dieser Box noch nicht anbindbar“** ist `anbindung` `nicht_mit_dieser_box` oder `kein_leseweg`. Der
Katalog legt je Paar und Box-Art fest, welches Wort die Box meldet: SunSpec, Fronius, KACO/AISWEI, KOSTAL, Huawei und
das WAGO-Registerbild liest heute nur die Docker-Box; SMA, Victron, OpenDTU/Ahoy und die Shelly-Zähler liest keine.

### Datenschutz (DP-3 A)

- **Keine MAC, kein Hostname, kein Gerätename**: kein Schema hat ein solches Feld (die Tests suchen danach). Die Identität
  trägt die Seriennummer. Ein Shelly und ein eByte nennen ihre Identität nur als MAC; ihr Fund trägt dann keine
  Seriennummer, und der Abgleich läuft über die Adresse (`abgleich: adresse_bekannt_kennung_offen`).
- Netz-Technik (`router`, `zugangspunkt`) nur mit Hersteller, Modell und Adresse.
- Telefone, Tablets, Rechner und Unbekanntes sind nie ein Fund, nur eine Zahl in `weitere` (`telefon_tablet`,
  `rechner`, `unbekannt`). Die Docker-Box kann sie nicht unterscheiden und zählt alles als `unbekannt`.
- Sendet eine fehlerhafte Box doch eine MAC, überliest die API das Feld (Fall `fund_mit_mac`); ein Telefon als Fund wird
  überlesen (`telefon_als_fund`). Gespeichert wird nur, was dieser Vertrag nennt; Funde 30 Tage (B2).

## 7. Antwort an das Portal

Die API gleicht jeden Fund mit den Komponenten der Anlage ab und ordnet ihn einer Gruppe zu
(`GeraetesucheVertrag.gruppe`, Fälle `api.gruppe_faelle`). Ein Fund ist nie wegen derselben Adresse „derselbe“
(Hausregel: ein Port, eine Adresse beweist keine Gerätegleichheit).

| `abgleich` | Bedeutung |
|---|---|
| `neu` | keine Komponente passt über Kennung oder Adresse |
| `schon_eingerichtet` | Seriennummer bzw. Logger-Seriennummer passt zu einer Komponente an derselben Adresse |
| `adresse_geaendert` | die Kennung passt zu einer Komponente an einer anderen Adresse: Vorschlag, ein Tipp übernimmt die neue Adresse über den Bearbeiten-Weg, dieselbe Komponente (DP-7 A; nie still) |
| `anderes_geraet_an_bekannter_adresse` | an einer bekannten Adresse antwortet ein Gerät mit anderer Kennung |
| `adresse_bekannt_kennung_offen` | an der Adresse ist eine Komponente eingerichtet, aber einer von beiden fehlt die Kennung: nicht belegbar, ob es dasselbe Gerät ist |

Gruppen in fester Reihenfolge (`api.gruppen`): `braucht_hilfe` · `bereit` · `nicht_anbindbar` · `vielleicht` ·
`schon_eingerichtet` · `weitere` (Netz-Technik; die Zahlen stehen daneben). Die Zuordnung prüft in dieser Folge:
(1) `adresse_geaendert` oder `anderes_geraet_an_bekannter_adresse` → `braucht_hilfe`; (2) `schon_eingerichtet` oder
`adresse_bekannt_kennung_offen` → `schon_eingerichtet`; (3) ein Hindernis an einem neuen, übernehmbaren Fund →
`braucht_hilfe` (ein schon eingerichteter, geschützter Shelly ist kein Problem); (4) sonst nach `anbindung`. Abgewiesene Ladesäulen kommen nicht aus der Suche, sondern aus dem Herzschlag ([OCPP „klopft an“](../ocpp-klopft-an.md)),
und stehen in der Antwort als eigene Liste `ladesaeulenKlopfenAn`.

Routen (alle `@Recht geraet.einrichten` an der Anlage, DP-4 A: das bestehende Recht deckt Starten, Abbrechen und
Verlauf wie Verbindungstest und Probe; Mandant aus JWT, Standort-Zaun):

| Route | Antwort |
|---|---|
| `POST /api/v1/sites/{siteId}/geraetesuche` (`deviceId`, `Idempotency-Key`) | 202 · 409 `laeuft_schon` (mit `suchId`) / `nicht_unterstuetzt` / `box_offline` · 429 `zu_oft` |
| `GET …/geraetesuche/{suchId}` | 200: Zustand, Schritt, Netze, Funde gruppiert und abgeglichen |
| `DELETE …/geraetesuche/{suchId}` | 202 (abbrechen; eine beendete Suche bleibt, wie sie ist) |
| `GET …/geraetesuche?deviceId=` | 200: Verlauf der letzten 30 Tage |

## Prüfen

```bash
(cd edge-app/core && go test ./internal/geraetesuche/ ./internal/probe/ && go test ./internal/cloud/ -run BuiltSupports)
(cd services/api && ./mvnw test -Dtest='GeraetesucheVertragTest,GeraetesucheSchnittstelleVertragTest,SuchbereichTest,KlopftAnTest,EdgeSupportsListenerTest')
(cd frontend/portal && npx vitest run --minWorkers=1 --maxWorkers=2 src/geraetesuche.test.ts src/edgeSupportsVectors.test.ts)
```
