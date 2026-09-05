# Steuerung Stufe 4 „Handeingriffe": der Speicher von Hand, und die Anlage kurz in Ruhe

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 161).


Vierte Stufe des Steuerungs-Umbaus (Konzept `data/vp-steuerung-konzept-b3` §3.2 + §3.5 + §3.7
B1–B6; **Captain-Entscheid S1 = A**). Es entsteht **kein zweiter Steuerweg**: der Speicher-Eingriff
reist über GENAU denselben `v2/desired`-Umschlag wie die Verbraucher-Sofortaktion (Quelle
`local-ui`, Klasse `flow` mit `override`, gebundene TTL) und wird auf dem Gerät durch DIESELBE
Guard-Kette geklemmt. Neu ist nur, WELCHE Komponente angesprochen wird — und dass eine Anlage als
GANZES ruhen kann.

**Ohne Handeingriff ist alles byte-identisch:** keine Zeile in `device_override` ⇒ kein Feld im
Push, kein anderer Wunsch, kein anderer Text.

- **⚠ SEIT K1 SCHLÄGT DER HANDEINGRIFF DIE REGEL — Vertragsentscheid D-6a** (Verbrauchsmanagement
  v1, 31.08.2026; Konzept `vp-verbrauchsmgmt-konzept-v1` §1.2 S9 / §2.2 K1). Bis dahin reisten
  Sofortaktion UND Speicher-Eingriff als `local-ui` + `override` = Klasse `flow`, **Rang 70** —
  genau der Rang einer kompilierten `must_run`-Regel —, und die Gleichklassen-Regel D-6 wies den
  Menschen ab, solange die Regel ihren Wunsch alle 15 s erneuerte („Jetzt stoppen" kam nicht
  durch). `desired.manualIntervention()` (local-ui UND override) hebt ihn auf **Rang 75**
  (`desired.ManualRank`) und nimmt das Paar von der Gleichklassen-Abweisung aus — **in BEIDE
  Richtungen, jede aus eigenem Grund**: der Handeingriff verdrängt die haltende Regel (das ist K1),
  und die Regel wird als Herausforderer GESPEICHERT und mit `arbitration:priority` statt
  `conflict` abgewiesen, sodass ihre 15-s-Erneuerung sie beim Ablauf des Eingriffs **NAHTLOS**
  zurückholt (§5 next-highest) statt eine Failsafe-Lücke zu lassen. **Zwei Handeingriffe erreichen
  die Regel nie:** `local-ui` hält EINEN Slot je Entität (`Source.Key`), der spätere ERSETZT also
  den früheren — genau die menschliche Erwartung. **Unberührt:** Regel gegen Regel (die D-6-Prüfung
  bleibt auf der KLASSE, zwei Regeln können sich weiterhin nicht per `override` verdrängen), alles
  über 75 (contract 80 · grid 90 · safety 100) weist ihn weiter mit `arbitration:priority` ab, die
  Guard-Kette klemmt ihn unverändert (`clamped` samt Guard-Stufe), die 4-h-Kappe gilt, und die
  Anlagen-Pause bleibt ein **TOR** (`suspended` keyt auf die KLASSE, nicht auf den Rang). Beweise:
  `internal/desired/manual_intervention_test.go` (die vier Fälle, dreifach mutationsgeprüft).
  **Wirkt erst mit dem nächsten Edge-Release.**
- **⚠ S1 = A ist eine KONSTRUKTIONS-Aussage: es gibt kein neues Kommando.** „Ladestand halten" ist
  `setpoint_kw = 0`, „Speicher jetzt laden" ein positiver `setpoint_kw` — beides seit E1a im
  Vokabular. **Und die EEG-Regel bleibt strukturell, nicht als Zusage:** ob dabei aus dem NETZ
  geladen werden darf, entscheidet `guards.Clamp` auf der Box gegen die Registry-Angabe
  `charge_from_grid_allowed` (D-8, abwesend/false = nur Solar), und die bindet dort für JEDEN
  Halter. Die Cloud hat dafür kein Feld und keinen Weg, sie zu umgehen. Variante B des Entscheids
  („nicht unter X % entladen") hätte einen SoC-Boden in D-14 gebraucht und ist ausdrücklich NICHT
  gebaut.
- **⚠ Ein NEGATIVER Sollwert wird ABGELEHNT, nie geklemmt** (`Handeingriff.sollwert`): es gibt
  keinen „jetzt entladen"-Eingriff, und aus einer Zahl mit falschem Vorzeichen eine andere Handlung
  zu machen wäre geraten. Die Ablehnung nennt den Weg („Ladestand halten stoppt den Speicher").
- **`device_override`** (Migration `V20260845000000`, mandantengebunden mit RLS + FORCE):
  `speicher_halten` · `speicher_laden` · `pause`. **Höchstens EIN lebender Eingriff je Komponente
  und EINE Pause je Anlage** — zwei partielle Unique-Indizes, kein Anwendungscode. Eine abgelaufene
  Zeile liest als ABWESEND (§16); ⚠ das BIGSERIAL braucht sein eigenes
  `GRANT USAGE ON SEQUENCE` (die dokumentierte `rollout_event`-Falle). `consumer_override` bleibt
  UNANGETASTET — es ist der Verbraucher-Eingriff mit eigenem Vokabular und eigenem Lesepfad.
- **⚠ EIN CHECK WIRD GEWEITET, INDEM MAN DEN AKTUELLEN STAND ABSCHREIBT — nie den der
  Tabellen-Migration (eigener Defekt dieser Stufe, behoben).** Das Audit-Vokabular von
  `consumer_audit_event` wird seit je durch DROP + ADD ersetzt (eine angewandte Migration ist
  unveränderlich); wer dabei die Ur-Liste kopiert, ENTFERNT lautlos die Wörter jeder Stufe
  dazwischen. Hier fielen die drei `switch_*` der Geräte-Freigabe (`V20260821000000`) heraus, und
  der Schaden fiel erst dort auf, wo so ein Wort geschrieben wird — als nackter HTTP 500 in
  `SelfBuildComponentApiTest`, eine ganze Stufe von der Ursache entfernt. Wächter gegen die KLASSE
  ist das reine `ConsumerAuditEventTypesTest`: jedes Wort, das der EINE Schreibpfad
  `ConsumerAuditRepository.append(site, entity, "wort")` einfügt, muss die ZULETZT gesetzte
  CHECK-Definition annehmen (mutationsgeprüft). **Gilt für jede künftige Weitung dieses CHECKs.**
- **⚠ „Automatik pausieren" reist im REGISTRY-PUSH, nicht als Wunsch je Komponente** — eine
  argumentierte Abweichung von der Skizze in §3.7 B5. Der Speicher soll in der Pause den
  EIGENVERBRAUCH fahren („so, als gäbe es VoltPilot nicht"), und PV − Last kann nur die Box rechnen;
  die Cloud hätte eine Zahl erfinden müssen. Über die Sperre fällt stattdessen jede Komponente auf
  ihren REGISTRY-FAILSAFE, und der IST für den Speicher `self-consumption` und für ein Gerät
  `release`/`off`. Zusätzlich ist es damit dieselbe Mechanik wie die Stufe-3-Beanspruchung — eine
  Sache, nicht zwei.
- **⚠ `automation_paused_until` ist ein ABSOLUTER Zeitpunkt, nie eine Dauer.** Der Push ist
  RETAINED: eine Box, die beim Ablauf offline war, muss die Sperre nach ihrer EIGENEN Uhr aufheben
  können, statt auf eine Nachricht zu warten, die vielleicht nie kommt (`Registry.Paused(now)`).
- **Edge: die Pause hat DREI Hälften, und alle sind nötig.** `runPlanExecutors` speist nichts mehr
  ein (der Fahrplan ruht), `desired.Deps.Suspended` lässt den Arbiter jede Wunsch-Klasse
  **in `market` und darunter** ignorieren (Fahrplan und Regeln ruhen). **⚠ Es ist ein TOR, kein Rang-Wechsel:**
  D-4s Klassen und ihre Ordnung sind unangetastet, und alles ÜBER market (contract, grid, safety)
  bindet weiter — eine Pause darf nie einen Compliance-Befehl aussetzen. Der direkte v1-
  `applySetpoint`-Pfad führt währenddessen den lokalen `self-consumption`-Failsafe aus und sperrt
  alle marktgetragenen Slotkorrekturen/Peak-Economics; sonst könnte ein noch frischer Optimizer-
  Slot die korrekt pausierte Entity-Arbitration am physischen Ausgang umgehen. Ein manueller
  Batteriehalter sperrt dieselben Markt-Nachkorrekturen. Export-/Netz-/Schutzgrenzen bleiben in
  beiden Fällen aktiv. `Suspended` nil = niemals pausiert = byte-identisch zum Vor-Stufe-4-Verhalten.
- **⚠ Das Edge-Tor des Handeingriffs ist ENTITÄTS-ABHÄNGIG** (B3, `agent/override.go`): ein
  VERBRAUCHER-Wunsch hängt weiter am Verbraucher-Hauptschalter (`VP_CONSUMER_CONTROL_ENABLED`,
  Vorgabe AUS), ein SPEICHER-Wunsch an dem Schalter, der den Wechselrichter wirklich regiert —
  `VP_CONTROL_ENABLED` plus die Modell-Zertifizierung, dieselben zwei Tore, die auch die
  Fahrplan-Sollwerte passieren. Ihn am CONSUMER-Flag aufzuhängen hätte den Speicher-Eingriff auf
  jeder Anlage tot gemacht. Eine UNBEKANNTE Entität behält das strenge Tor: was wir nicht
  klassifizieren können, weiten wir nicht.
- **B6: über 4 h wird ERNEUERT, nie der Vertrag gedehnt.** `DeviceOverrideRenewalRunner` (10-min-Takt)
  sendet den laufenden Wunsch neu aus, solange sein `ends_at` in der Zukunft liegt, und räumt
  abgelaufene Zeilen weg; der gesendete TTL bleibt unter `desired.OverrideTTLCap` (D-5 = 4 h). **Er
  erfindet nie eine Verlängerung** — ist die Frist vorbei, verfällt der Wunsch auf dem Gerät von
  SELBST, dafür muss der Takt nicht einmal laufen. ⚠ Wie jeder `@Scheduled` ist er im Testlauf
  abgeschaltet (surefire-Systemeigenschaft `voltpilot.interventions.renewal-enabled=false`) und in
  Produktion an (`matchIfMissing`) — die dokumentierte Falle mit zwischengespeicherten
  Spring-Kontexten und gestoppten Testcontainern.
- **Routen** (`SiteInterventionController`, mandantenbezogen wie jede `/sites/**`-Route, kein
  `@PreAuthorize`, fremde Anlage **404**): `GET /interventions` (der EINE Lesepfad der Jetzt-Zone —
  Zeilen-Countdown UND Banner), `POST/DELETE /battery-override`, `POST/DELETE /automation-pause`.
- **Die reine Hälfte ist `interventions/Handeingriff`** (Docker-frei geprüft, das
  `Tagesprotokoll`/`FleetPflege`-Muster; jede zeitabhängige Funktion nimmt ihr `now`): Vokabular,
  Dauer-Pflicht (15 min … 24 h), „bis morgen früh" in der Zone der Anlage, die TTL-Kappe und die
  Erneuerungs-Frist.
- **Unclaim räumt ab:** ein Eingriff an einem Gerät, das niemandem mehr gehört, ist keine Aussage
  mehr. ⚠ Anders als der retained Slot der Ladepunkt-Konfiguration ist das eine DB-Zeile auf dem
  `@Primary`-Pfad — also derselben Verbindung wie das Unclaim, kein Selbst-Blockade-Risiko (die bei
  der Steuerungs-Freigabe dokumentierte Falle).
- **Beweise:** rein `HandeingriffTest` (10) · Go `agent/automation_pause_test.go` (H1 die Pause
  fällt jede Komponente auf ihren Failsafe und ein frischer Plan bricht sie nicht · H2 die Box hebt
  sie nach ihrer EIGENEN Uhr wieder auf · H3 das Batterie-Tor bei ausgeschaltetem Verbraucher-Flag,
  und ohne `VP_CONTROL_ENABLED` bleibt der ganze Downlink tot) · Testcontainers
  `ConsumerApiTest.handeingriffeAmSpeicherUndAnDerAnlageSindDauerpflichtigUndZurueckzunehmen` +
  `…SindMandantenGefenced` · `ProvisioningClaimTest` (die Pause an den RETAINED BYTES, und ihr
  Verschwinden bei der Rücknahme) · Portal `handeingriff.test.ts` (19) + `steuerungJetzt.test.ts`.
- **Ops:** keine neue Pflicht-Variable. Der Erneuerungs-Takt hängt an
  `VOLTPILOT_INTERVENTIONS_RENEWAL_ENABLED` (Vorgabe AN — ein per Vorgabe ausgeschaltetes Flag
  müsste im gitops-Repo nachgezogen werden, die dokumentierte OTA-Listener-Falle). Die EDGE-Hälfte
  (Pause-Sperre + entitäts-abhängiges Tor) reist mit dem nächsten Edge-Release; bis dahin überliest
  eine laufende Box das Feld, und ein Speicher-Eingriff erreicht sie nur, wenn ihr
  Verbraucher-Flag an ist.

