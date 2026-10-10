# Plan-Quittung und Herzschlag-Block (AP-15 IP-10, P3/Y3)

[Vertrag](../../contracts/v2/mqtt-plan-result.md) · [Vektoren](../../contracts/v2/plan-result-vectors.json).

- Box: `agent/plan_result.go` `beurteilePlan2` urteilt wie vorher (`plan2.Parse`, dann
  Geräte-Identität) und quittiert jede Annahme und jede Ablehnung retained auf
  `…/v2/plan-result`; `plan2.Grund*` ist das geschlossene Vokabular. Die leere retained
  Nachricht und der Plan von der Platte werden nicht quittiert.
- Herzschlag-Block `gemeinsame_steuerung` nur, solange die Box einen Plan 2.0 mit `plan_id`
  hält; Wächter-Stufe und Messpunkt-Alter kommen aus `export_guard`. Rolle, Anteile-Revision
  und `waechter.bezug` sind Vertrag, gesendet erst ab IP-17/IP-18.
- Cloud: `plan_zustellung` (V20260921130000, FK auf `device (id, tenant_id)` mit CASCADE —
  Abmelden und Mandanten-Abbau brauchen keinen eigenen Weg). „veröffentlicht“ schreibt der
  Optimierer nach dem Senden (`persistence_v2.record_publication`, seit IP-15 je Box und
  Dokument; die leere retained Rücknahme wird nicht vermerkt), das Urteil der
  `uems/PlanResultListener`; `PlanZustellungRepository.stand` ist „veröffentlicht gegen
  angenommen“ (R11) für IP-11/IP-24. Eine alte Box behält „angenommen“ leer, ohne Alarm.
- Seit IP-11: Frist 35 Tage (`uems/PlanZustellungAufbewahrung`, täglich; je Box bleiben die jüngste
  veröffentlichte und die jüngste angenommene Zeile), und der Block landet für die Box-Metriken im
  Prozess (`metrics/GemeinsameSteuerungHerzschlag`) — [Übergabe](../../rollout/gemeinsame-steuerung-metriken.md).
- `plan_quittung` ist eine GEMELDETE Fähigkeit (`edge-supports-vectors.json`), keine Zeile in
  `edge-capabilities.json`: die Tabelle speist den Kunden-Satz „Update nötig für …“ jeder Box.
- Neues Grund-Wort: Vertrag, Vektoren, Go, `PlanResultListener.GRUENDE`, CHECK der Tabelle
  und Schema zusammen ändern; `PlanResultListenerTest` prüft die Gleichheit.
