# Gerätesuche, API-Seite: vier Routen, drei Tabellen, ein eigener Listener (Paket 3)

Konzept `vp-portal-geraetesuche-konzept` (30.10.2026, DP-1 C, DP-2 bis DP-7 A). Vertrag:
[`mqtt-geraetesuche.md`](../../contracts/v2/mqtt-geraetesuche.md), OpenAPI-Tag `geraetesuche`,
[OCPP „klopft an“](../../contracts/ocpp-klopft-an.md). Box: Paket 2, Portal: Paket 4.

| Was | Wo |
|---|---|
| Routen | `web/GeraetesucheController`: `POST/GET /sites/{siteId}/geraetesuche`, `GET/DELETE …/{suchId}` |
| Dienst | `geraetesuche/GeraetesucheDienst` (Starten, Abbrechen, Antwort, Verlauf, Meldungen der Box) |
| Abgleich | `geraetesuche/GeraetesucheAbgleich` (rein: Fund ↔ Komponente, Vorlagen je Fund) |
| Tabellen | `V20261030140000__geraetesuche.sql`: `geraetesuche`, `geraetesuche_fund`, `geraetesuche_protokoll`; `V20261030181500__geraetesuche_herkunft.sql`: Protokoll-Arten `uebernommen`/`adresse_uebernommen` mit `entity_id`, `fund_schluessel`, `gesucht_am` |
| Herkunft | `geraetesuche/GeraetesucheHerkunft` (`pruefen`, `protokollieren`, `herkunft`), gerufen aus `ComponentService` und `SelfBuildComponentService` |
| Aktivität | `geraetesuche/GeraetesucheAktivitaet`, eingemischt von `CommandLogReader` als fünfter Strom `geraetesuche` |
| MQTT | `GeraetesuchePublisher` (Auftrag, nicht retained), `GeraetesucheListener` (Stand + Ergebnis) |
| Läufer | `GeraetesucheAufraeumen` → `geraetesuche_aufraeumen(now() - 30 Tage)` |
| Klopft an | `KlopftAnSpeicher`, gefüttert von `ChargerStatusListener` |

## Was gilt

- **Recht `geraet.einrichten` an der Anlage (DP-4 A):** POST und DELETE über `@Recht`; die zwei GET-Routen prüfen im
  Handler (`RechtPruefung#pruefen`), weil `RechtRoutenArchitekturTest` `@Recht` an Leserouten ablehnt. Außerhalb und
  unbekannt sind dieselbe 404 `nicht_gefunden` (`RechtMatrixApiTest#dieLesendenRoutenDerGeraetesuchePruefen…`).
- **Ablehnungen in dieser Folge:** 404 → `nicht_unterstuetzt` (Fähigkeit) → `box_offline` (kein Status-Herzschlag
  seit 5 min) → `laeuft_schon` → 429 `zu_oft` (6 Starts je Stunde ohne die abgelehnten, `wiederAb` + `Retry-After`).
- **Der Auftrag geht als letzter Schritt der Transaktion hinaus** (nach Suche, Protokoll und Anfrage-Kennung).
  Erreicht er die Box nicht, rollt alles zurück und die Route sagt 409 `box_offline`; ein eigenes Wort dafür hat der
  Vertrag nicht.
- **`keine_antwort` wird gelesen, nicht gespeichert:** 30 s ohne Meldung seit dem letzten Stand (sonst seit dem
  Auslösen). Eine spätere Meldung der Box gilt noch; so eine Suche sperrt keinen neuen Start.
- **Gruppen werden beim Lesen gebildet** (Detail und Verlauf), gegen die Komponenten von heute; das Protokoll
  `beendet` hält die Zähler zum Zeitpunkt des Ergebnisses fest.
- **Datenschutz (DP-3 A):** keine Spalte für MAC, Hostname oder Gerätenamen; die Verbindung steht in Spalten, nicht als
  JSON. Suchen und Funde gehen nach 30 Tagen, das Protokoll bleibt (Person, Zähler, Übernahmen).
- **Herkunft = optionaler Bezug `geraetesuche: { suchId, fund }`** (`GeraetesucheBezug`) an drei Schreibwegen:
  `POST …/components` und `POST …/components/custom` („Vielleicht · selbst beschreiben“) schreiben die Protokollzeile
  `uebernommen`, `PUT …/components/{id}` schreibt `adresse_uebernommen`, nur wenn sich die Verbindung ändert (DP-7 A).
  `PUT …/components/custom/{id}` lehnt den Bezug mit 400 ab. Geprüft wird VOR allem anderen
  (`GeraetesucheHerkunft#pruefen`, eine Prüfung für alle Wege über `ComponentService#fundAusSuche`): Suche und Fund in
  dieser Anlage, Suche jünger als 30 Tage, sonst 422 ohne Änderung — fremd, unbekannt und abgelaufen sagen dasselbe.
  Ohne Bezug bleiben die Wege unverändert.
- **Die Wahrheit steht einmal, im Protokoll:** `herkunft` an der Komponentenzeile (`SiteComponentsDto`) ist die jüngste
  Zeile `uebernommen` je `entity_id`; keine Spalte an der Komponente. Sie überlebt den Läufer, der Suche und Fund löscht.
- **Fünfter Strom `geraetesuche` im Kommando-Verlauf:** eine Suche ist eine Zeile (`gestartet` mit `beendet`/`abbruch`
  derselben `such_id` gefaltet), jede Übernahme eine eigene (`geraet_uebernommen`, `adresse_uebernommen`). Kennungen
  `-(2^50 + id)`, Deckel 50 Zeilen; nur im ungefilterten Verlauf (`Filter#includesGeraetesuche`: ein Strom- oder
  Ergebnis-Filter oder eine Herkunft ohne `portal` schließt ihn aus). Die Box trägt ihre Suchen und was aus ihnen
  übernommen wurde, eine Komponente nur ihre Übernahmen.

## ⚠ Fallen

- ⚠ **Kennung und Adresse:** die Kennung ist `seriennummer` und bei Solarman die Logger-Seriennummer
  (`verbindung.serial`); die der Komponente ist `geraet.seriennummer` (über `geraet_komponente`, heute gültig) und
  `connection_json.serial`. Die Adresse ist die IP; verschiedene Unit-IDs (`unit_id`, bei Solarman `mb_slave_id`) an
  derselben IP sind verschiedene Ziele. Router und Zugangspunkte werden nie abgeglichen.
- ⚠ **Vorlagen je Fund:** nur bei `uebernehmen`; gleiche `communication`, Marke = `hersteller`, Bauart = `familie`, wenn
  der Katalog sie kennt. Ein WAGO-Fund (`modbus_tcp`, Marke `wago`) hat darum keine Vorlage — der WAGO-Weg ist ein
  eigener Assistent.
- ⚠ **Klopft an ist ein Spiegel im Speicher:** jede api-Instanz hört jeden Herzschlag. Ein Herzschlag ohne Block oder
  ohne `rejected` und ein Stand älter als 5 min heißen unbekannt (`null`), nie `[]`.
- ⚠ **Der Listener ist ein `Rueckmeldeweg`** mit EINEM `handle(topic, payload, Instant)` für beide Topics; das erste
  `…FILTER`-Feld ist das des Zwischenstands (`KundenbereichBeendetWegeTest` baut daraus sein Topic).
- ⚠ **Testaufbau:** eine Komponente bekommt ihr `geraet` beim Anlegen; für eine Seriennummer das vorhandene Gerät
  ändern, keine zweite `geraet_komponente`. `device.lan_host` braucht `lan_source`.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='GeraetesucheAbgleichTest,GeraetesucheAntwortFormTest,GeraetesucheVertragTest,GeraetesucheSchnittstelleVertragTest,ChargerStatusListenerTest')
(cd services/api && ./mvnw test -Dtest='GeraetesucheApiTest,GeraetesucheHerkunftApiTest,RechtMatrixApiTest,KundenbereichBeendetWegeTest')
```
