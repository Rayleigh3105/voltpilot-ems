# ⚠ Der D-19-Zwilling flows/validate.ts ist KATALOG-getrieben, nicht auf consumer-policy verdrahtet.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 091).

- **⚠ Der D-19-Zwilling `flows/validate.ts` ist KATALOG-getrieben, nicht auf `consumer-policy` verdrahtet.** Er war beim Bau der Stufe 4 als einziger der drei Zwillinge (flowc · api · Portal) stehengeblieben und wies damit jedes gültige `vp.modbus.switch`-Dokument ab — mit einer Meldung, die noch dazu die falsche Regel nannte. Er liest jetzt `type.generated_origin` und benennt über `type.generated_origin_label`, WELCHER generierte Flow den Baustein besitzt; ein generierter Typ ohne `generated_origin` fällt fail-closed durch. `validate.test.ts` prüft alle drei Richtungen (eigener origin gültig · ohne origin abgelehnt · fremder origin abgelehnt) — **wer das Tor anfasst, ändert alle drei Zwillinge zusammen.**
