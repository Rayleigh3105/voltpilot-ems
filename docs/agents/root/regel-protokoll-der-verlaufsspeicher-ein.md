# Regel-Protokoll: der Verlaufsspeicher (Einheitsmodell Stufe 5b)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 20).


„Diese Regel hat heute 3× geschaltet" wird wahr. Der Andockpunkt existierte seit M4
(`frontend/portal/src/steuerungArea.ts` `AutomationActivity`) und wurde von NIEMANDEM befüllt, weil
es NIRGENDS einen Verlauf gab: `consumer_runtime_status`, `flow_device_ack` und `flow_node_status`
sind MOMENTAUFNAHMEN (je Herzschlag gelöscht und neu geschrieben). Diese Stufe ist der fehlende
Speicher — und sie kommt **ohne eine Zeile Edge-Code** aus.

- **Geschrieben wird aus WECHSELN im bestehenden Herzschlag-Strom**, nicht aus einem neuen Kanal:
  `rules/RuleEventWriter` reitet auf dem Verbraucher-Zuhörer (der Schalt-Verlauf) und dem
  Flow-Zuhörer (Ausrollen/Geräte-Problem) — das `ConsumerRequirementLedgerWriter`-Muster
  (telemetrie-getrieben, **nie werfend**, kein `@Scheduled`, kein neues Flag im gitops-Repo). Den
  Vorzustand liefert das `DELETE ... RETURNING` der beiden Replace-Pfade
  (`ConsumerRuntimeStatusRepository.replaceForDevice` / `FlowStatusRepository.replaceAcks` geben
  jetzt zurück, was sie ersetzt haben) — **keine zusätzliche Abfrage auf dem heißen Pfad**.
- **Tabellen `rule_event` + `rule_event_recording`** (Migration `V20260816000000`): append-only,
  **mandantengebunden mit RLS + FORCE** — das sind KUNDENDATEN, deshalb ausdrücklich NICHT global
  wie `rollout_event`, und deshalb wohnt die Leseroute unter `/sites/**` statt `/admin/**`.
  **⚠ Das `BIGSERIAL` braucht sein eigenes `GRANT USAGE ON SEQUENCE`** (V4s `ALTER DEFAULT
  PRIVILEGES` deckt Tabellen ab, Sequenzen sind eine andere Objektklasse — die dokumentierte
  `rollout_event`-Falle).
- **Die vier Ehrlichkeitsregeln liegen rein in `rules/RuleEvents`** (Docker-frei geprüft, das
  `Tagesprotokoll`/`FleetPflege`-Muster; jede zeitabhängige Funktion nimmt ihr `now`): die **ERSTE
  Beobachtung ist kein Ereignis** (sonst meldete jede neue Komponente ein „gestartet", das nie
  stattfand); **Verschwinden ist kein Stopp** (Schweigen ist eine Lücke); **nur der ZUSTAND ist ein
  Wechsel** (ein wechselnder GRUND allein erzeugt nichts); und es reisen **nur gemeldete Wörter**
  (unbekannte hat der Ingest längst verworfen).
- **Die Zuordnung Ereignis → Regel ist die V-5-Invariante, nie eine Heuristik** (Konzept D-i):
  aktive Verbraucher-Regel auf der Komponente (`rezept`) → sonst D-13-Anspruch eines aktiven Flows
  (`flow`) → sonst GAR KEINE. Gespeichert wird das als **SCHNAPPSCHUSS** (das
  `rollout_device.device_ref`-Muster, kein Fremdschlüssel): wer die Regel morgen tauscht, schreibt
  die Vergangenheit nicht um, und eine gelöschte Regel nimmt ihren Verlauf nicht mit. Aufgelöst
  wird LAZY und nur, wenn wirklich ein Wechsel anliegt — im Normalfall kostet das Protokoll keine
  einzige zusätzliche Abfrage.
- **Aufbewahrung 90 Tage, KEINE Verdichtung** (Begründung in der Migration): geschrieben wird nur
  ein Wechsel, und eine Komponente wechselt wenige Male am Tag — eine Verdichtung erzeugte eine
  zweite Wahrheit über dieselben Ereignisse. Gelöscht wird opportunistisch im Schreibpfad
  (höchstens stündlich je api-Instanz, gedeckelte DELETE) statt über einen neuen `@Scheduled`-Job
  (die dokumentierte Testcontainers-Falle). Gegen ein FLATTERNDES Gerät steht ein Tages-Deckel je
  Anlage, der sich **SELBST ins Protokoll schreibt** (`protokoll_gedeckelt`) statt still zu kappen.
- **Lesepfad `GET /api/v1/sites/{siteId}/rule-events`** (`SiteRuleEventController`, RLS-gefenced,
  fremde Anlage 404; in `openapi.yaml`, tag `rules`) — EINE Antwort für die drei Flächen. **Zwei
  Felder tragen die Ehrlichkeit und werden EINSEITIG im Backend entschieden** (das
  `RolloutStates`-Muster — das Portal konsumiert und kann sie damit nicht erfinden):
  `switchedToday` ist **NULLABLE** (der Speicher hat den heutigen Berliner Tag nicht ganz gesehen ⇒
  kein Zähler, die Fläche sagt „seit HH:MM aufgezeichnet"), und **`countsToday`** beantwortet
  denselben Fall für eine Regel OHNE jedes Ereignis — die taucht in `rules` gar nicht auf, und ohne
  das Flag müsste die Fläche den Tagesbeginn selbst nachrechnen (ein Zwilling der Server-Regel).
- **Bewusst NICHT in dieser Stufe: der Präzisions-Uplink (5b-2).** Die Box kennt ihre
  Arbitrierungs-Ereignisse präzise (`edge-app/core/internal/desired/arbiter.go`), meldet sie aber
  nur auf den lokalen Bus. Sie hochzumelden ist ADDITIV und verfeinert diese Tabelle später, ohne
  sie umzubauen — es ist eine eigene Stufe, weil sie eine Edge-Auslieferung braucht und der Kunde
  sonst bis dahin gar keinen Verlauf sähe (Konzept D-h).
- **Beweise:** `RuleEventsTest` (10, rein) · `ConsumerApiTest.ruleEventsRecordOnlyTheChangesAndAreTenantScoped`
  (echte DB: erste Beobachtung stumm, Grundwechsel stumm, Start/Stopp aufgezeichnet, Zuordnung als
  Schnappschuss, Zähler erst wenn belastbar, RLS 404). **⚠ Das Protokoll gehört der ANLAGE, und
  `ConsumerApiTest` teilt sich eine** — wer handgerechnete Erwartungen hat, räumt `rule_event` am
  ANFANG des Tests ab (die Haus-Disziplin der Preis-Slots), sonst prüft er die Nachbarn mit.
  Portal-Seite in `frontend/portal/AGENTS.md`.

