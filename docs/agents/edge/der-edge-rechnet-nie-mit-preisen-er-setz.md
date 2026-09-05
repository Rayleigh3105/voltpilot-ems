# Der Edge rechnet NIE mit Preisen — er setzt die Preis-Entscheidung der Wolke durch (`guards.PriceTrimmer`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 47).


Die preisbewusste Begrenzung innerhalb der Viertelstunde (2026-07-30, Captain-Beobachtung Pilsting) ist die dritte
ökonomische Schutzschicht neben `PeakShave` und den Compliance-Clamps — mit derselben Arbeitsteilung wie überall:
**die Wolke entscheidet, ob ein Slot teuer ist** (per-Slot-Flag `charge_from_surplus_only` im
mqtt-schedule-Contract; die Regel steht in `services/optimization/.../slot_trim.py`), **der Edge begrenzt nur**.
Volles Bild inkl. Ökonomie in der Root-AGENTS.md „Price-aware in-slot trim". Was hier gelten muss:

- **Reihenfolge:** `guards.PriceTrimmer.Apply` läuft in `applySetpoint` NACH `Clamp` und NACH dem
  Arbiter-Override, VOR `PeakShave` — beide sind restrict-only, also ist die Komposition ein Minimum.
  Der Trim braucht deshalb kein `Limits`: sein Ergebnis liegt strikt in `[0, kw]`.
- **Sicherheit per Algebra, nicht per Prüfung:** nach dem Trim ist die vorhergesagte Netzleistung
  `max(load − pv, 0) ≥ 0` — die Anlage wird nie in die Einspeisung gedrückt, also kann der §14a-EXPORT-Deckel
  (der `Clamp` sogar Ladeleistung ERHÖHEN darf) nicht verletzt werden, und der Import-Deckel galt für einen
  Wert, den der Trim nur weiter senkt. FK3 (Laden ≤ gemessene PV-PRODUKTION) bleibt die regulatorische
  Obergrenze und ist per Konstruktion lockerer als der Überschuss.
- **Ehrlichkeit:** unbekanntes pv/load ⇒ INAKTIV (nie blind regeln — die PeakShave-Konvention); Entladen und
  Ruhe sind unberührt; der Eigenverbrauchs-Rückfall IST der Überschuss, dort ist der Trim ein No-op.
- **Kein Zappeln, asymmetrisch:** Eingreifen sofort (eine durchziehende Wolke ist genau das, was nicht gekauft
  werden darf), Loslassen erst nach `TrimReleaseDwell` (90 s) ruhigem Unterschreiten; die angewandte Kappung
  folgt einem FALLENDEN Überschuss sofort, einem steigenden nur in `TrimStepKw`-Schritten.
- **Eine Begrenzung ist KEIN misslungener Schreibvorgang:** veröffentlicht wird der BEGRENZTE Wert, also passt
  der Register-Readback dazu und die entprellte Bestätigungslogik kann daraus nie „Sollwert nicht übernommen"
  machen. Sie wird als EIGENER Zustand gezeigt (`state.TrimInfo` → `control.js VPControl.deriveTrim` → die
  Begründungszeile `#ctrlReason` der Steuerungs-Karte, NORMAL-Modus) — eine unbenannte Begrenzung liest sich
  wie ein Defekt. Die per-Slot-Fahrplan-Begründung (Rollen, Wasserwert) bleibt bewusst in der WOLKE und wird
  vom Portal gerendert; auf `:8484` gibt es dafür keine zweite Erklär-Logik.
- Beweise: `guards/slottrim_test.go`, `agent/slot_trim_test.go`, `plan/plan_test.go` (nur ein explizites
  `true` trägt die Pflicht; die eingecheckten Contract-Fixtures werden per PFAD geparst),
  `web/jstest/ui.test.js`.

**Die ENTLADE-Seite derselben Lücke = `guards.LoadFollower` (`guards/loadfollow.go`, P1 der
Pilsting-Nachtanalyse `firstmate/data/vp-netzbezug-nacht-s3`; seit P1b BEIDSEITIG).** Der Sollwert
einer Viertelstunde stammt aus einer Viertelstunden-LASTPROGNOSE, also wird ihr Fehler am Netz
verrechnet — in BEIDE Richtungen, beide live gemessen am 30.07.: 21:22 Plan −4,332 kW gegen ein
7,117-kW-Haus → 2,79 kW zu ~32,5 ct GEKAUFT bei 77 % SoC (~4,9 € in EINER Nacht); 23:12 spiegelbildlich
Plan −6,7 kW gegen ein 5,1-kW-Haus → 1,4 kW zu ~21 ct VERSCHENKT, während dieselbe kWh später ~32,5 ct
wert war. Per-Slot-Flag **`cover_load_from_battery`**, Regel in `slot_trim.py`
(`import_price > lambda/eta + wear + margin`), eigener Kill-Switch `OPTIMIZER_LOAD_FOLLOW_ENABLED`.
**In einem Flag-Slot ist das Ziel `Entladung = max(load − pv, 0)`, also Netz ≈ 0** — anheben, wenn der
Plan zu wenig entlädt, begrenzen, wenn er zu viel entlädt. Was zusätzlich zum Trim gilt:

- **Die ANHEBE-Hälfte ist `PeakShave` mit Import-Ziel 0 plus Hysterese** — der Guard RUFT
  `PeakShave(kw, 0, …)` auf, statt die Schranken nachzubauen: Nennband, SoC-Boden und „senkt nur"
  kommen damit aus EINER bewiesenen Arithmetik.
- **Sicherheit per Algebra, EINE Invariante für beide Richtungen:** der Guard schiebt die
  vorhergesagte Netzleistung immer nur ZUM Nullpunkt HIN — nie darüber hinaus, nie weiter weg. Also
  nie Export (§14a-Exportgrenze/Einspeisedeckel unberührt) und nie mehr Import als das, was
  hereinkam (dafür galt der Import-Deckel schon). Wo er greift, hört die BATTERIE auf, am Netzpunkt
  mitzuwirken: exakt 0 bei Hausdefizit, sonst der verbleibende PV-Überschuss (den aufzunehmen wäre
  ein LADEN, also eine Preisentscheidung, die dieser Guard nie trifft).
- **Die BEGRENZEN-Hälfte braucht keine eigene Schranke:** sie verkleinert nur den Entlade-BETRAG
  (Nennband/SoC-Boden trivial erfüllt), rührt SoC-Decke und EEG-Solar-Clamp nicht an, hat einen
  HARTEN Boden bei 0 (nie ein Laden, nie ein Richtungswechsel — deckt PV die Last, geht der Sollwert
  auf 0) und kann den nachfolgenden Peak-Guard nicht aushebeln (sie landet bei Import 0 ≤ jeder
  Freigabe ≥ 0). Ein kommandiertes LADEN bleibt weiterhin unangetastet.
- **UNMARKIERTE Slots bleiben byte-identisch — in beiden Richtungen.** Die Unterscheidung
  „absichtlicher Handel vs. Prognose-Abweichung" trifft die WOLKE, nie der Edge: der Edge bekommt nur
  den Sollwert, nie die Prognose-Netzleistung des Plans. Deshalb markiert `slot_trim.py` seit P1b nur
  noch den echten „Netz ≈ 0"-Knick — **echte Entladung UND `|grid_kw| <= 0,05 kW`** —, also weder
  einen geplanten Kauf (Rolle `warten`) noch einen geplanten Verkauf (Rolle `verkaufen`, z. B. das
  ±30-kW-Fenster). Die Sicherheit hängt aber NICHT daran: ein Gerät an einer ÄLTEREN Wolke kann noch
  einen markierten Slot mit kleinem Export sehen — dort begrenzt der Guard, die Energie BLEIBT im
  Speicher (≥ Wasserwert) und wird vom nächsten 15-Minuten-Replan neu disponiert (begrenzte,
  selbstkorrigierende Verschiebung, anders als der unbepreiste Export, den die Korrektur verhindert).
- **Die Peak-RESERVE begrenzt nur das ANHEBEN** (`reserveSocPct` hebt den SoC-Boden): gewöhnliches
  Lastdecken ist genau das, was die Reserve überleben muss — dieselbe Regel wie im Rückfall-Pfad. Die
  Peak-VERTEIDIGUNG darf weiterhin darunter (sie läuft danach mit den unveränderten Limits). Das
  BEGRENZEN schont die Reserve ohnehin und wird von ihr nie gebremst.
- **Hysterese symmetrisch um das Netz-0-Ziel:** Eingreifen sofort in beide Richtungen
  (`|predicted| > FollowEngageMarginKw`), Loslassen erst, wenn der PLAN-EIGENE Wert das Defizit
  `FollowReleaseDwell` lang innerhalb der Marge trifft; ein Richtungswechsel behält den
  eingerasteten Zustand (eine Anlage, deren Last durch den Sollwert schwingt, zappelt nicht).
- **Bewusste Abweichung vom Trim: KEIN Schritt-Folger auf dem angewandten Wert.** Beide Richtungen
  sind hier Lastnachführung (Ziel = pv − load); ein gehaltener tieferer Entladewert bei
  SCHRUMPFENDEM Defizit IST genau das 23:12-Symptom. Die Schreib-Entprellung gehört in den
  Layer-1-Executor (`dwell_s`/`min_change`), nicht hierher.
- Anzeige: `state.FollowInfo` (mit `direction` = `deepen`|`reduce`) → `control.js
  VPControl.deriveFollow` → dieselbe `#ctrlReason`-Zeile, die die RICHTUNG benennt („… – Entladung
  angehoben" / „Folgt dem gemessenen Hausverbrauch … – Entladung begrenzt", jeweils mit der eigenen
  ehrlichen Ursache; Trim gewinnt, beide schließen sich per Konstruktion aus). Ein älteres Gerät ohne
  `direction` bekommt die neutrale Formulierung — nie eine Richtung behaupten, die nicht gemeldet
  wurde. Der VERÖFFENTLICHTE Wert ist der nachgeführte, also passt der Readback und die entprellte
  Bestätigung meldet auch bei einer BEGRENZUNG nie „nicht übernommen".
- Beweise: `guards/loadfollow_test.go` (u. a. „schiebt nur zum Nullpunkt hin", Begrenzen auf das
  gemessene Haus, Boden 0 statt Laden, unmarkierter Slot beidseitig unberührt, Reserve, Rated-Band,
  SoC-Boden, blind=inaktiv, Hysterese beidseitig, Richtungswechsel ohne Loslassen, Komposition mit
  dem Peak-Guard), `agent/load_follow_test.go` (inkl. der 23:12-Konstellation und der EINGECHECKTEN
  Contract-Bytes), `plan/plan_test.go`, `web/jstest/ui.test.js`,
  `services/optimization/tests/test_load_follow.py` (Regel + echter Solver: die Nacht-Slots werden
  markiert, die billigen Kauf-Stunden UND ein bewusster 28-kW-Export nicht — der Export-Fall ist
  bewusst NICHT vakuum: er belegt, dass genau diese `verkaufen`-Slots ökonomisch markiert WORDEN
  WÄREN, Setpoints byte-identisch).

**Und die Korrektur reist jetzt in die CLOUD (`cloud.ExecutionSummary`, Fahrplan-Konzept
`vp-fahrplan-kunde-konzept` §5, PR 3, 2026-08-02).** `FollowInfo`/`TrimInfo` lebten NUR auf der Box,
der Heartbeat trug sie nicht — das Portal sah also `commanded_kw` (den KORRIGIERTEN Wert) neben
einem Fahrplan-Balken mit einer anderen Zahl und konnte nur sagen, dass „irgendetwas angepasst"
wurde. `agent.executionSummary(snap)` faltet sie als additiven `execution`-Block IN die
`control`-Struktur des Heartbeats (Präzedenz: die `sources`/`flows`-Blöcke; `schema_version` bleibt
"1.0", MQTT-Kontrakte unberührt):

- `mode` = `plan` | `follow` | `trim` | `absorb` | `fallback`, dazu `direction` (`deepen`/`reduce`,
  NUR bei `follow`), `planned_kw` (der Sollwert VOR der Korrektur) und der GEMESSENE Wert, dem
  gefolgt wird (`deficit_kw` bei follow, `surplus_kw` bei trim UND absorb). Die Reihenfolge der
  Prüfung ist die UMGEKEHRTE Kette: `absorb` zuerst, weil es zuletzt läuft — wo es gegriffen hat,
  ist sein Wert der veröffentlichte. Ein Modus, den die Wolke nicht kennt, wird dort verworfen
  (der strikte Filter im `ControlStatusListener`), ein älteres Portal fällt also sauber auf seine
  generische Formulierung zurück.
- **Ein Modus, der nicht sauber auf das Vokabular passt, macht GAR KEINE Aussage:** nur
  `ModeSchedule` → `plan` und `ModeSelfConsume` → `fallback`; ein v2-Wunsch auf der Batterie
  (`ModeDesired`), eine Kalibrierung oder ein Gerät ohne Messwerte lassen den Block weg statt sich
  falsch zu etikettieren. Genau deshalb ist das top-level `control_source` NICHT das präzise Signal
  — es fasst all das zu `default` zusammen.
- Ein nicht gemessener Wert bleibt ABWESEND (nie eine erfundene 0); ohne Readback gibt es weiterhin
  gar keinen `control`-Block, der Vertrag für ein Gerät, das nichts bestätigt, ist byte-gleich.
- Beweise: `agent/execution_summary_test.go` (beide Richtungen mit den Live-Konstellationen 21:22 /
  23:12, Trim, plan-vs-fallback, unmapped-Modus ohne Aussage, `omitempty`-Drahtform).
  Cloud-Seite: api-Migration `V20260802000000` + `ControlStatusListener` + `ControlStatusDto`
  (siehe Root-`AGENTS.md` „Inverter control"), Portal: `control.ts executionNote`.

**Die LADESEITE, die ANHEBT = `guards.SurplusCharger` (`guards/surpluscharge.go`, Report
`firstmate/data/vp-pilsting-abregeln` §5b, 02.08.2026).** Trim senkt nur eine Ladung, der Follower
wirkt nur auf eine Entladung — einen NICHT PROGNOSTIZIERTEN PV-Überschuss konnte deshalb nichts in
den Speicher bringen. Genau das war das Geld des Vormittags in Pilsting: PV 23,9 · Haus 4,3 ·
**16,6 kW EINSPEISUNG bei negativem Preis**, stundenlang, bei **7 % SoC** — weil der Solver nur den
PROGNOSTIZIERTEN Überschuss lädt (`charge ≤ pv_forecast − curtail`) und es keinen Nowcast gibt, der
den laufenden Slot korrigiert. Per-Slot-Flag **`charge_surplus_to_battery`**, Regel in
`slot_trim.py` (`η·λ − wear > export_value + margin`), eigener Kill-Switch
`OPTIMIZER_SURPLUS_CHARGE_ENABLED`. Was hier gilt:

- **Es ist der EINZIGE Guard der Kette, der einen Sollwert ANHEBT** — und genau deshalb läuft sein
  Ziel noch einmal durch das autoritative `guards.Clamp` (Nennband, SoC-Decke, EEG-Solar-Clamp,
  §14a-Hülle), statt eigene Schranken nachzubauen (dieselbe Technik wie die ANHEBE-Hälfte des
  Followers, die `PeakShave` ruft). Er kann damit strukturell nicht an einem Guard vorbeischreiben
  und keinen aufweichen; er schlägt nur Werte vor, die die Kette schon akzeptiert hat.
- **Sicherheit per Algebra:** begrenzt auf den GEMESSENEN Überschuss ist die vorhergesagte
  Netzleistung `load + min(kw, Überschuss) − pv ≤ 0` — es entsteht also NIE ein zusätzlicher Import
  (§14a-Import und das Peak-Viertelstundenziel bleiben unberührt), und ein Export wird immer nur
  Richtung 0 verkleinert (§14a-Export und Einspeisedeckel erst recht erfüllt).
- **Nur ein NICHT-NEGATIVES Kommando wird angehoben** — nie ein Richtungswechsel aus einer Entladung
  heraus. Das ist zugleich, was ihn per Konstruktion vom Follower trennt.
- Unbekanntes pv/load ⇒ INAKTIV; der Eigenverbrauchs-Rückfall lädt ohnehin pv − load, dort ist er
  ein No-op. Hysterese gespiegelt zum Trim (sofort eingreifen, `AbsorbReleaseDwell` zum Loslassen;
  ein SCHRUMPFENDER Überschuss wird sofort, ein wachsender in `AbsorbStepKw`-Schritten gefolgt).
- Anzeige: `state.AbsorbInfo` → `control.js VPControl.deriveAbsorb` → dieselbe `#ctrlReason`-Zeile
  („Lädt den gemessenen Solarüberschuss … – Ladung angehoben"). Ein ANGEHOBENER Sollwert ist eine
  bewusste Nachführung: veröffentlicht wird der angehobene Wert, der Readback passt dazu.
- Beweise: `guards/surpluscharge_test.go` (Überschuss laden, nie ein Import, kein Richtungswechsel,
  SoC-Decke/Nennband/EEG-Clamp/§14a binden auf dem ANGEHOBENEN Wert, blind=inaktiv, Hysterese,
  Komposition mit dem Peak-Guard), `agent/surplus_charge_test.go` (die Live-Konstellation und die
  EINGECHECKTEN Contract-Bytes), `plan/plan_test.go`, `web/jstest/ui.test.js`,
  `services/optimization/tests/test_surplus_charge.py`. Die argumentierte Abweichung von der
  Report-Formel (ein geplanter IMPORT wird NICHT ausgeschlossen) steht in der Root-`AGENTS.md`
  „In-slot surplus absorption" und in der Docstring der Regel.

