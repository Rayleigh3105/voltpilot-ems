# Aktueller Börsenpreis für Kundenregeln (…/v2/price)

Die Zuleitung des aktuellen Börsenpreises von der Cloud zur Box, damit Preis-Regeln des Regel-Baukastens („Negativpreise mitnehmen", „Günstig heizen") auf der Box wirklich schalten.
Schema: [mqtt-price-current.schema.json](mqtt-price-current.schema.json).

## Grundsatz

Der Fahrplan bleibt die Entscheidung der Cloud (`edge-app/core/internal/plan/plan.go`).
Dieses Dokument ist DATEN für Kundenregeln, nie ein Befehl: die Box wertet damit ausschließlich die Preis-Bedingungen ihrer Kundenregeln aus, deren Wünsche wie jeder Flow-Wunsch durch die Arbitrierung und die Schutzketten gehen.

## Weg

| Schritt | Thema | Form |
|---|---|---|
| Cloud -> Box | `ems/{t}/{s}/{d}/v2/price`, QoS1, **retained** | Schema oben; `price_ct_kwh` in ct/kWh |
| Box-intern | `edge/price/current`, retained auf dem lokalen Bus | `{schema_version, price_ct_kwh, unit, slot_start, slot_end, valid_until, bidding_zone}`; veraltet/zurückgezogen: `{schema_version:"1.0", stale:true}` |

Sender ist die API (`com.voltpilot.api.preis`), je 15-Minuten-Slotgrenze für jede berechtigte Anlage an deren führende Box; retained, damit eine offline gewesene Box den Stand beim Verbindungsaufbau selbst abholt.
Der Spiegel auf der Box ist `internal/pricefeed` (vom Cloud-Downlink `OnPriceCurrent` gespeist); Konsument ist der kompilierte `vp.price.current`-Baustein (`vp-feed` „price_current" + generierter Preis-Wächter) - und künftig der Kern der Regelsprache, der den Preis als benannten Eingang `edge/price/current` liest.

## Tarifgrundlage

Dieselbe wie Erlösanzeige und Optimierer (Projektregel in `AGENTS.md`): die `day_ahead_prices` der Gebotszone der Anlage, Viertelstunde schlägt Stunde (`SlotEconomics` / `PriceWindowSource`).
Gesendet wird der NACKTE Börsenpreis (`price_eur_mwh / 10`) - exakt die Zahl, die das Portal als „Börsenpreis" zeigt und auf der der Probelauf einer Regel rechnet.
Veröffentlicht wird nur für Anlagen mit zeitveränderlichem Bezugspreis (`SlotEconomics.importPriceSource() != 'fest'`); für Kunden mit Festtarif bleibt der Preis-Baustein im Portal gesperrt, mit dem Grund im Klartext.

## Frische

Ein Preis ist aktuell in `[slot_start, slot_end + 5 min Slack)` nach der Uhr der Box (Slack = Publikationslatenz der nächsten Slotgrenze, dieselbe Überlegung wie `plan.redeliverySlack`).
Danach, und nach einem Rückzug (leeres retained Payload), gilt jede Preis-Bedingung als **unbekannt** und die Regel handelt nicht - der Spiegel ersetzt das lokale Retained-Payload durch die ausdrückliche Marke `{"stale":true}`, und der generierte Preis-Wächter im Artefakt prüft `valid_until` zusätzlich selbst (fällt der Core aus, hielte Node-RED sonst den letzten Wert).
Unbekannt heißt im kompilierten Artefakt: die Schwellen-Bedingung antwortet AKTIV `false` (ein UND-Kombinator darf nicht auf dem letzten bekannten `true` sitzen bleiben) - exakt die Semantik des Portal-Probelaufs („unbekannt zählt nicht").
Nie auf einem alten Preis weiterschalten.

## Koexistenz

Additiv; v1 bleibt unberührt. `edge/prices` (Tagesreihe) und `edge/forecast/pv` bleiben reservierte, ungespeiste Themen.
Das Thema liegt im `v2/#`-Teilbaum der per-Gerät-ACL (D-2) - keine Broker-Änderung.
