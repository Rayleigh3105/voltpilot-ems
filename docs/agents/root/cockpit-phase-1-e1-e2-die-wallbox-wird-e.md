# Cockpit Phase 1 / E1+E2: die Wallbox wird eine MESSENDE Komponente

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 111).


Konzept `data/vp-verbraucher-cockpit-k1` §8 Phase 1 (Captain-Entscheide E1-E7).
Bis hierher lebten die Kilowatt eines Ladepunkts AUSSCHLIESSLICH im
`chargers`-Herzschlag - ein zweiter Lesepfad, den das Portal sonderbehandeln
musste, und einer, der weder `telemetry_v2` noch die Rollups, die
Entitäts-Historie oder die Topologie je erreichte. **Alles ist ADDITIV: eine
Anlage ohne Ladepunkt und eine Box ohne die neuen Felder verhalten sich
zeichengleich wie vorher**, und beide Richtungen sind als Test festgenagelt.

- **⚠ DIE BINDUNG IST DIE DER CLOUD, NIE EINE VERMUTUNG.** Der Registry-Push
  trägt je Ladepunkt-Komponente additiv **`charge_point_id`**
  (`edge-entity.schema.json` Descriptor; gefüllt aus der Bindung
  `device_charge_point.entity_id`, die `ChargerComponentComposer` längst legt).
  Es ist der ZWILLING von `edge_source_id` einen Transport weiter: eine
  Ladesäule ist keine Quelle in `sources.json` (sie wählt die Box AN), ihre
  Messwerte liessen sich also über keinen anderen Schlüssel auf die Komponente
  abbilden. **Ohne dieses Feld veröffentlicht die Box GAR NICHTS** - eine Box an
  einer älteren Cloud bleibt byte-identisch, und es gibt keinen Rückfall, der
  Messwerte auf die falsche Komponente pinnen könnte.
- **Die Regel liegt rein in `agent.ocppEntityReadings`** (`ocpp_entities.go`,
  ohne Uhr/IO - das `otaapply`/`probe`-Muster); veröffentlicht wird am Ende von
  `ocppStep`, neben `publishOcppState`, also aus DERSELBEN Momentaufnahme wie
  Karte und Herzschlag. Von da an trägt die BESTEHENDE E1b-Kette den Rest
  (Puffer → v2-Uplink → `telemetry_v2` → Rollups → Entitäts-Historie/Topologie),
  byte-gleich wie bei einem messenden Shelly.
- **Drei Ehrlichkeitsregeln:** nur FRISCHE Messwerte zählen (dasselbe
  `ocppMeterMaxAge`, das `ChargingTotal` benutzt - „gemessen" darf nicht zwei
  Bedeutungen haben) · **nicht gemessen ist nie 0, und eine TEIL-Summe ist keine
  Messung** (ein Stecker, der NIE gemessen hat, gehört schlicht nicht zur Summe;
  einer, der gemessen HAT und verstummt ist, macht die Säulen-Summe unvollständig
  - dann veröffentlicht die GANZE Säule nichts, statt seinen Anteil still fallen
  zu lassen; eine GEMESSENE 0 ist dagegen ein Faktum und wird veröffentlicht) ·
  der Zeitstempel ist die BEOBACHTUNG
  (`MeteredAt`), nicht der Takt - eine unveränderte Probe ist damit am
  idempotenten `(entity, channel, time)`-Insert ein No-op.
- **⚠ `soc_pct` wird ABSICHTLICH nicht publiziert**, obwohl der `ev-charger`-
  Katalogtyp ihn deklariert: er ist der Ladestand des AUTOS, und
  `topology.DefaultRole` bildet eine `soc_pct`-Fähigkeit unabhängig von der
  Kategorie auf den SPEICHER-Knoten ab - eine Wallbox begänne, den Ladestand der
  Hausbatterie zu füllen. Über zwei Stecker gemittelt wäre er ohnehin Unsinn.
- **E2 - zwei additive Herzschlag-Felder je Stecker** (`session_kwh`,
  `metered_at`; Migration `V20260857000000`, beide NULLABLE OHNE DEFAULT):
  `energy_kwh` daneben ist ein KUMULATIVES Register, was in der laufenden
  Sitzung floss weiss nur die Box (nur sie kennt den Registerstand bei
  `StartTransaction`) - die Cloud brauchte dafür bis hierher einen
  Slice-10-Join. Ein RÜCKWÄRTS gesprungenes Register liefert KEINE Bilanz statt
  einer negativen. `metered_at` ist das ALTER von `power_kw`/`energy_kwh`/
  `soc_pct`; **`NULL` heisst „nicht gemeldet", NIE „gerade eben"**.
- **Portal:** `ladepunkte.messwertAlter`/`aktuelleLeistung` machen daraus die
  eine Regel - ein VERALTETER Messwert fällt auf den Zustand zurück, den es
  dafür längst gibt (`laedt_ohne_messung`, Detail „Leistung veraltet") und geht
  in KEINE Summe ein; ohne Stempel ist alles byte-identisch. `ladepunkte.ts` ist
  import-frei und führt das Live-Fenster deshalb als dokumentierten ZWILLING von
  `api.ts` `ONLINE_WINDOW_MS` - **beide zusammen ändern** (gepinnt in
  `ladepunkte.test.ts`). `heuteAusEntitaet` liest jetzt zuerst den
  `energy_kwh`-ZÄHLER (`max − min`, mit der Monotonie-Regel des Registers - eine
  fallende Reihe ergibt GAR KEINE Zahl) und fällt sonst auf die
  Leistungs-Integration zurück; `gemesseneEntitaeten` schliesst Ladepunkte
  seither EIN. Der OCPP-Register-Abruf bleibt daneben, weil nur er die Zahl JE
  STECKER kennt - **die Säulen-Summe wird NIE auf einen von zwei Steckern
  geschrieben** (eine erfundene Aufteilung).
- **Beweise:** Go `agent/ocpp_entities_test.go` (10: die Reise, die Summe zweier
  Stecker, „nicht gemessen ist nie 0" in beide Richtungen, die unvollständige
  Säule gegen den nie messenden Stecker, kein `soc_pct`, ohne Bindung nichts,
  die Draht-Form auf dem lokalen Bus + Dedupe) +
  `agent/ocpp_heartbeat_test.go` (+2) · api `EntityRegistryChargePointTest` (4,
  rein: die Kennung reist, eine Anlage ohne Ladepunkt sendet das Feld gar nicht,
  keine erfundene Bindung) + `ChargerStatusListenerTest` (+2) · Portal
  `ladepunkte.test.ts` (+10), `verbrauchHeute.test.ts` (+6),
  `verbrauchKomposition.test.ts` (+6).
- **Ops:** keine neue Pflicht-Variable, kein Flag. Die EDGE-Hälfte reist mit dem
  nächsten Edge-Release (eine laufende Box behält ihr Image); Cloud und Portal
  sind sofort lieferbar und degradieren auf „nicht gemeldet".

