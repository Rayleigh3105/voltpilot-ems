# Steuerung Stufe 3 „Vorrang technisch": die Regel gewinnt, weil kein Fahrplan mehr konkurriert

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 160).


Dritte Stufe des Steuerungs-Umbaus (Konzept `data/vp-steuerung-konzept-b3` §3.7 A3/A4/A5b/A6 + §5
Stufe 3). **Der Arbiter, die Prioritätsklassen und die Verträge D-4/D-5/D-6 sind UNANGETASTET** —
das ist der ganze Trick der empfohlenen Bauweise: eine Kundenregel (Klasse `flow`, Rang 40) verlor
den Speicher bis hierher jede Sekunde an den Fahrplan (Klasse `market`, Rang 60), weil
`runPlanExecutors` dessen aktiven Slot bei JEDEM Takt neu einspeiste. Jetzt speist er für eine
BEANSPRUCHTE Komponente gar nichts mehr ein — die Regel gewinnt, weil es keinen Konkurrenten gibt.
Die verworfene Alternative (eine neue Klasse `owner-rule`, Rang 65) wäre eine Vertragsänderung mit
Folgen für jede Edge-Version im Feld gewesen.

**Ohne Beanspruchung ist alles byte-identisch** — kein Feld auf dem Draht, kein anderer Plan, kein
anderer Text. Das ist beidseitig festgenagelt (Go `R1`, Python `test_an_unclaimed_run_is_byte_identical…`).

- **`flow_claim` ist die PROJEKTION der einen Ableitung, nie eine zweite** (Migration
  `V20260842000000`, mandantengebunden mit RLS + FORCE wie `flow_definition`). `flows/FlowClaims`
  bleibt die EINE Stelle, an der ein Anspruch entsteht; die Tabelle materialisiert ihn in der
  Aktivierungs-Transaktion (`FlowActivationService.activate` → `writeClaims`), damit ZWEI Abnehmer
  ausserhalb des Java-Prozesses ihn lesen können: der Registry-Push und der Optimierer. Geräumt beim
  Stilllegen und beim Löschen; `flow_name` ist ein SCHNAPPSCHUSS (das
  `rollout_device.device_ref`-Muster), und es gibt bewusst KEINEN Fremdschlüssel auf
  `flow_definition` (dessen PK ist `(flow_id, flow_version)`, die Beanspruchung überlebt eine neue
  Fassung).
- **⚠ EIN DELEGIERTER Anspruch setzt NIEMALS `owner_claimed` — sonst wäre das Feature invertiert.**
  Ein `vp.strategy.*`-Knoten (ein Betriebsmodell) beansprucht seine Entität, um die Ausführung AN DEN
  PLAN zu übergeben; ihn zu stempeln hiesse, die Box überspringt den Plan für genau die Komponente,
  die das Betriebsmodell geplant haben will. Deshalb filtert `FlowClaimRepository.claimedEntities`
  auf `!delegated` und der Optimierer-Loader auf `AND NOT fc.delegated` — **beide zusammen ändern**,
  und beide sind einzeln gepinnt.
- **A3 Edge-Skip:** `owner_claimed` reist additiv im Registry-Push (Kontrakt
  `docs/contracts/v2/edge-entity.schema.json`, `entities.Entity.OwnerClaimed`, ABWESEND = false).
  `agent/arbitration.go` `runPlanExecutors` überspringt eine beanspruchte Komponente in BEIDEN
  Plan-Ären (v1-Batterie und v2-Entitäten). **Die Übergabe ist eine SAUBERE Freigabe, kein
  Failsafe-Blinzeln:** eine übersprungene Komponente landet nicht mehr in `held`, der Withdraw-Pass
  ruft `Withdraw(..., stale=false)`, der Arbiter wählt sofort den nächsten Halter — die Regel.
- **A4 Optimierer:** `inputs.load_battery_claims` liest die Tabelle EINMAL je Zyklus (das
  `load_model_choices`-Muster) und ist **fail-soft** — ohne Tabelle (ein Optimierer vor der
  api-Migration) oder ohne DB wird jede Batterie geplant wie vorher, nie eine Anlage ungeplant
  gelassen. Ein beanspruchter Speicher wird als GEHALTEN geplant:
  `OptimizationInput.battery_held` setzt die Lade-/Entlade-BOUNDS auf 0 —
  **bewusst eine Schranke, keine Nebenbedingung**, damit weder `explain.KNOWN_CONSTRAINTS` noch die
  Golden-Suite etwas davon merken. Der Plan behauptet dann ehrlich keine Ersparnis auf einem
  Speicher, den er nicht bewegen darf (`cost == baseline_cost`), plant aber alles Übrige weiter
  (Abregelung, Einspeisegrenze, Lastspitzen-Ziel).
  **⚠ `BatteryParams.__post_init__` verbietet `max_charge_kw <= 0`** — die Haltung gehört deshalb an
  den LAUF (`OptimizationInput`), nicht an die Stammdaten der Batterie.
- **⚠ Wer `gather_inputs` in einem Test fälscht, braucht jetzt AUCH `battery_claims=None`** in der
  Fake-Signatur (die dokumentierte `model_choices`-Falle, zum zweiten Mal).
- **A5b: ein Betriebsmodell WEICHT, statt die Regel mit V-5 abzulehnen.** `ForeignClaim` trägt
  additiv `delegated`; im Validator wird eine solche Kollision eine WARNUNG (der Satz der
  Folgen-Karte) statt eines Fehlers, und `FlowService.yieldDelegatedFlows` legt die betroffenen
  Betriebsmodell-Flows VOR der Aktivierung still und NENNT sie in der Antwort (`yieldedFlows`).
  **Zwei Betriebsmodelle kollidieren weiter** (sie sind seit Stufe 5 ohnehin exklusiv) und **eine
  Regel blockiert eine andere weiter** — V-5 wird nur dort gelockert, wo es eine menschliche
  Entscheidung zum Auflösen gibt. `site_profile_state` wird NICHT angefasst: das Betriebsmodell
  bleibt „an" und übernimmt wieder, sobald die Regel ausgeht — genau das sagt die Folgen-Karte.
- **⚠ Die generierten VERBRAUCHER-Flows schreiben bewusst KEINE Claims.** Ihr Vorrang läuft seit
  D-19 über `must_run` → override (Rang 70 > market 60) und funktioniert; ihn auf `owner_claimed`
  umzustellen hiesse, ein ausgeliefertes Feature ohne Not umzubauen. Stufe 3 adressiert den
  belegten Bruch — den SPEICHER am Editor-/Baukasten-Weg.
- **A6 Texte:** `regeln/satz.ts` `VORRANG_FOLGEN`/`VORRANG_ZEILE` sagen auf BEIDEN Zweigen „Ihre
  Regel geht vor"; der Speicher-Zweig nennt zusätzlich die Folge, die es nur dort gibt („Läuft
  gerade ein Betriebsmodell auf diesem Speicher, pausiert es dafür"). **Eine ZAHL verspricht keiner
  der Sätze** — „was das kostet" ist Stufe 7, bis dahin wäre sie erfunden.
- **Beweise:** Go `agent/owner_claim_test.go` (der Simulator-Beweis „Regel gewinnt" in-process gegen
  echten Broker + echte Arbitrierung: R1 ohne Claim gewinnt der Plan · R2 mit Claim übernimmt die
  Regel OHNE Failsafe-Blinzeln · R3 jede unbeanspruchte Komponente behält ihren Plan-Befehl, und ein
  frisch veröffentlichter Plan holt sich den Speicher NICHT zurück · R4 Rücknahme gibt ihn zurück ·
  der D-5-Override wird nie benutzt) · Python `tests/test_flow_claim.py` (9: Loader-SQL inkl.
  `NOT fc.delegated`, fail-soft, gehaltene Batterie flach + ohne Ersparnis, **nicht-vakuum** über
  denselben Horizont ohne Claim, byte-identisch per Vorgabe) · Java rein `FlowGraphValidatorTest`
  (+3: Betriebsmodell weicht, zwei Betriebsmodelle kollidieren, Regel-gegen-Regel unverändert) ·
  Testcontainers `FlowPeakShavingApiTest.aCustomerRuleClaimsTheBatteryAndTheBetriebsmodellYieldsInsteadOfRefusing`
  (echte DB + Keycloak: der Push trägt das Feld erst mit Claim, ein delegierter Anspruch nie, das
  Betriebsmodell ist wirklich `retired`, Rücknahme räumt) · Portal `regeln/folgen.test.ts`,
  `regeln/zustand.test.ts`, `migration.test.ts`.
- **⚠ `FlowPeakShavingApiTest` teilt EINE Anlage über alle seine Tests** und JUnits Methoden-Ordnung
  ist unspezifiziert: der Stufe-3-Test gibt Governance-Schalter, Leistungspreis und jeden angelegten
  Flow in einem `finally` zurück. Ohne das fällt ein Geschwister-Test aus einem Grund, der nichts mit
  ihm zu tun hat (die dokumentierte `FlowApiTest`-Falle).
- **Ops:** die Cloud-Hälfte wirkt mit dem Deploy (Migration + api + Optimizer). Die EDGE-Hälfte (der
  Plan-Skip) reist mit dem nächsten Edge-Release — bis dahin ist `owner_claimed` ein Feld, das eine
  laufende Box überliest, und der Optimierer hält die beanspruchte Batterie bereits (der Plan
  befiehlt dann Sollwert 0 statt einer Dispatch-Kurve). Keine neue Pflicht-Variable.

