# Verbrauchsmanagement v1 — Paket 5: der Ladepunkt wird eine Komponente wie jede andere

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 167).


Das größte Paket des Programms (Konzept `data/vp-verbrauchsmgmt-konzept-v1` §2.2 K2/K3,
§2.3, §4; Captain-Entscheide E6 Arbiter-Brücke · E10 Rahmen read-only + Admin-Schreibweg).
Es macht aus einer OCPP-Säule eine Komponente, die dieselben Wege geht wie jeder andere
Verbraucher — **und die BOX-Hälfte davon reist mit dem nächsten Edge-Release** (siehe die
Trennung am Ende).

### K3 — die ARBITRIERUNGS-BRÜCKE (Box)

- **⚠ SIE KANN DEN PHYSISCHEN RAHMEN NUR VERENGEN, NIE WEITEN.** `ocppStep` fragt je
  Sitzung `arb.DecisionFor(entityID)` (Zuordnung über `charge_point_id` im
  Registry-Descriptor) und übersetzt das Ergebnis in ZWEI Felder der schon existierenden
  `lastmgmt.Session`: `CapKw` (der Halter DECKELT: `MaxKw = min(Stecker, L)`; `L = 0` ⇒
  pausiert mit eigenem Grund) und `SourceExempt` (ein Halter ab Rang 50 —
  `deadline-fallback`/`market`/`flow+override` und darüber — BEFREIT sie von der
  Quellen-Bahn, wörtlich der Boost-Mechanismus). Budget, Rotation, Totmann und
  TxDefault-Profil binden unverändert danach; kein Halter ⇒ die Steuerart der Säule gilt
  wie vorher.
- **Die Übersetzung ist rein** (`agent/ocpp_bridge.go` `ocppBridgeDecision`/
  `ocppBridgeReason`, Docker-frei — das `otaapply`/`probe`-Muster); `ocppApplyBridge` ist
  Verdrahtung mit einem Cache je Entität.
- **⚠ Der Grund heißt `plan` oder `regel`, nie `wartet`** (`lastmgmt.ReasonPlan`/
  `ReasonRule`): bei einem Deckel 0 fehlt keine LEISTUNG, es HÄLT etwas — und der Kunde
  muss den Hebel erkennen können. Rang 50/60 ⇒ „plan", alles andere ⇒ „regel".
- **⚠ `sessionPolicy` trägt die LEGACY-Regel, und sie ist tragend** (`lastmgmt.go`
  `splitExempt`): eine Säule ohne eigene `Source` UND ohne Anlagen-Standard hat GAR KEINE
  benannte Politik — sie bleibt dann an die Bahn gebunden, statt als „schnell" befreit zu
  werden. Ohne diese Unterscheidung hätte die Bahn eines Nachbarn eine `schnell`-Säule
  gefesselt (im Go-Test als echter Defekt gefunden).
- **⚠ `SourceAllowsMinimum` kommt vom SITE-Standard, nie von der Säule** (`ocpp.go`): das
  „Sonne zuerst"-Zugeständnis ist eine Anlagen-Aussage; je Säule gerechnet hätte eine
  einzige `sonne_zuerst`-Säule die Mindestleistung für ALLE freigegeben.

### K2 — die STILLE-REGEL (Cloud, ohne Edge-Änderung)

- **⚠ WO DER PLAN SCHWEIGT, REGIERT DIE QUELLE.** Ein Verbraucher, dessen Policy AUCH
  eine lokale Quelle trägt (`ControllableLoadEntity.has_local_source`, gesetzt von
  `consumer_inputs.compile_consumer`, wenn `compile_condition_slots(...) is None`),
  bekommt von `publisher_v2._load_entity_payload` nur noch die Slots, die der Plan
  wirklich SCHALTET. Ein volles Raster mit ausdrücklichen Aus-Slots wäre der Plan, der die
  Regel des Kunden jede Viertelstunde überstimmt, obwohl er ihr lokales Signal per
  Konstruktion nicht sehen kann.
- **⚠ Es brauchte KEINE Edge-Änderung, und das ist nachgeprüft:**
  `plan2.Plan.ActiveCommands` liefert für eine nicht abgedeckte Zeit `ok=false`, und
  `runPlanExecutors` zieht den Wunsch dann SAUBER zurück (`stale=false`) — der Arbiter
  wählt im selben Takt den nächsten Halter, also die reaktive Regel. Kein
  Failsafe-Blinzeln.
- **Ein Verbraucher OHNE lokale Quelle behält das volle Raster** — dort IST ein Aus-Slot
  die Aussage („dieses Gerät läuft jetzt nicht"), und ein Weglassen hieße „entscheide
  selbst", was er nicht kann.
- **⚠ Schweigt der Plan über die GANZE veröffentlichte Fensterbreite, fällt die ENTITÄT
  weg** (die Release-Disziplin des Producers): `slots` trägt `minItems: 1`, eine leere
  Liste wäre ein kaputter Plan statt „die Quelle regiert".
- Kontrakt: nur die BESCHREIBUNG der Slot-Zusammenhängigkeit wurde präzisiert
  (`mqtt-schedule-2.0.schema.json`) — **keine Formänderung**, `schema_version` bleibt 1.0.

### Steuerart je Ladepunkt (Cloud)

- **⚠ Die VIERTE Herkunft heißt `saeule`** (`SteuerartProjektion.HERKUNFT_SAEULE`) und
  meint „diese Säule trägt eine EIGENE Quellen-Bahn" (`charge_points[].source`),
  ausdrücklich NICHT den Anlagen-Standard. Sie ist ein eigenes Wort und nicht `policy`:
  dort entscheidet ein Policy-Dokument, hier die Bahn der Box. Für den Chip zählt allein
  `!== 'standard'` ⇒ „abweichend", also rendert jede künftige Herkunft automatisch richtig.
- **⚠ Die Steuerart einer Säule ist GETEILT, und die Teilung folgt der Maschine, die sie
  wirklich ausführt** (`SteuerartService.schreibeBahn`): die QUELLE fährt die Box
  (`sofort` → Bahn `schnell`; `ueberschuss` → `nur_sonne` bzw. `sonne_zuerst` + `min_kw`),
  das ZIEL („Bis Uhrzeit fertig") und „Günstige Stunden" fahren die Policy und erreichen
  die Säule über die K3-Brücke. `SteuerartDokument.dokument(..., quelleFaehrtDieBox)` lässt
  die Quellen-Anforderung dann weg und gibt `null` zurück, wenn nichts übrig bleibt — dann
  wird die aktive Fassung ZURÜCKGENOMMEN (der flag-unabhängige `deactivate`).
- **⚠ Eine OCPP-Säule ist „verbunden", weil sie GEMELDET ist.** Sie hat weder `device_id`
  noch `edge_source_id` — sie wählt die Box selbst an. `ConsumerPolicyActivationService`
  fragt deshalb zusätzlich `EntityRegistryService.istGebundenerLadepunkt(...)`
  (`device_charge_point.entity_id`); ohne diese Ausnahme wären „Günstige Stunden" und „Bis
  Uhrzeit fertig" an einer Säule STRUKTURELL unmöglich — genau das, was P5 behebt.
- Die komponierte `ev-charger`-Entität bekommt beim ersten Schreiben ein
  `consumer_profile` (`ConsumerService.ensureProfile`), damit die Policy-Maschine sie
  überhaupt tragen kann; die P2-Ablehnung (422 `OCPP_NOCH_NICHT`) ist entfallen und heißt
  nur noch `OCPP_OHNE_KENNUNG` (eine Komponente ohne gemeldete ChargePointId).
- Verteilweg unverändert: das BESTEHENDE retained `charging-config`-Dokument, jetzt mit
  `charge_points[].source`/`min_kw` je Säule (additiv, `schema_version` bleibt 1.0;
  Fixture `mqtt-charging-config.valid.steuerart-je-saeule.json`, vom Go-Parser PER PFAD
  gelesen). **Ein unbekanntes Quellen-Wort überspringt den EINTRAG** statt auf `schnell`
  aufzulösen — das wäre eine Netzstrom-Freigabe, die niemand erteilt hat.
- Migration `V20260864000000`: nullable `source`/`min_kw` auf der Allowlist + die sechs
  Rahmen-Spalten auf `site_charging_config`, alle mit CHECK. **`NULL` heißt überall „das
  Portal äußert sich nicht und die Box behält ihre eigene Zahl", nie 0.**

### E10 — der Ladepark-RAHMEN

- **Neue Routen:** `PUT /api/v1/sites/{siteId}/charging-config/charge-points/{id}/source`
  (Kunde, RLS-gefenced) und `PUT /api/v1/admin/sites/{siteId}/charging-frame`
  (`AdminChargingFrameController`, platform-admin). Beide in `openapi.yaml`.
- **⚠ ZWEI QUELLEN, und ihr Unterschied ist die Aussage:** das **IST** (der Budget-Block,
  den die Box meldet) ist das, wonach sie wirklich rechnet; das **SOLL**
  (`ChargingConfigDto.frame`) ist das, was das Portal hinterlegt hat. Gezeigt wird
  bevorzugt das IST; wo nur ein Soll vorliegt, wird es BENANNT („hinterlegt, von Ihrer Box
  noch nicht gemeldet") statt als Messung ausgegeben (`src/ladeparkRahmen.ts`).
- **⚠ Die ROTATION meldet die Box in ihrem Budget-Block NICHT** — sie steht deshalb nur
  als Soll und trägt dann ausdrücklich das Soll-Wort. Eine erfundene „alle 15 Minuten"
  wäre schlimmer als keine Zeile.
- **Die alte Ladepark-KAPSEL ist ERSATZLOS entfallen** (`components/LadeparkKapsel.tsx`),
  ihre zwei Radio-Gruppen haben bessere Wohnorte bekommen: die QUELLE ist der
  Anlagen-Standard bzw. die Steuerart je Säule (die seit P5 auch je Ladepunkt abweichen
  kann — was ein anlagenweiter Radio nie ausdrücken konnte), der VORRANG ist die Rangliste
  aus P4. Nachfolgerin ist `components/LadeparkRahmenKarte.tsx`: die Anschlussgrenze (die
  EINE Zahl, die dem Kunden gehört) plus die Rahmen-Werte zum LESEN, der Betreiber-Editor
  hinter dem EINEN Tor `rollen.showTechnicalLayer()`.
- **⚠ Im Betreiber-Editor ist ein LEERES Feld „nichts sagen", nicht „auf 0 setzen"** — es
  wird gar nicht erst gesendet, damit ein versehentlich geleertes Feld nie eine gepflegte
  Zahl löscht.

### Was SOFORT wirkt und was ein EDGE-RELEASE braucht

| | wirkt mit dem Deploy | braucht das nächste Edge-Release |
|---|---|---|
| K3 Brücke | — | die ganze Brücke (`ocppStep`) |
| K2 Stille-Regel | der Publisher lässt die Slots weg | — (der Edge liest eine Lücke schon heute richtig) |
| Steuerart je Säule | Portal, Policy, Journal, das retained Dokument | dass die Box `source`/`min_kw` je Säule LIEST |
| E10 Rahmen | Lesen + Admin-Schreibweg | dass die Box `frame` übernimmt |

**Ohne das Release verhält sich jede laufende Anlage byte-identisch:** eine ältere Box
überliest die neuen Felder (`encoding/json` ohne `DisallowUnknownFields`), und der
Kompatibilitäts-Beweis ist als Test festgenagelt
(`agent/charging_config_test.go`: ein Dokument OHNE die neuen Felder ändert NICHTS).

### Beweise

Go rein `internal/lastmgmt/perstation_test.go` (5, mutationsgeprüft: die Legacy-Bahn und
„verengt nie nach oben") · `agent/ocpp_bridge_test.go` (6, AN DEN SÄULEN gemessen:
Halter deckelt · Halter befreit · kein Halter folgt der Quelle · eine eigene Bahn bindet
NUR sich selbst · `schnell` ist von der Solar-Bahn der Anlage befreit) ·
`internal/chargingcfg` + `agent/charging_config_test.go` (PATCH-Semantik für
source/min_kw/frame, byte-identisch ohne sie) · Python `tests/test_stille_regel.py` (10:
die Ableitung, das Weglassen, „ohne lokale Quelle Zeichen für Zeichen wie vorher", die
weggelassene Entität, Kontrakt-Validierung) + die **unveränderte Golden-Suite** ·
Java `SteuerartApiTest` (7, echte DB + Keycloak: die Reise einer OCPP-Säule über BEIDE
Maschinen) + `ChargingConfigPublisherTest`/`EntityRegistryChargePointTest` ·
Portal `ladeparkRahmen.test.ts` (14) + `steuerartDialog.test.ts` (+5) ·
**Rig `edge-app/test/e2e-ocpp.sh` L14a–d** (Docker-frei, ein ZWEITER Kern mit eigener
Registry: die Brücke deckelt, befreit und tritt ohne Halter zurück; L1–L13 und der
Totmann L4 unverändert grün).

