# Customer-facing jargon helpers in src/format.ts

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 031).

- **Customer-facing jargon helpers in `src/format.ts`:** `ctPerKwh(eurMwh)` (÷10, the unit on a bill - customer surfaces speak ct/kWh, never MWh) and `zoneLabel(code)` (raw bidding-zone code -> "Deutschland"/"Österreich"/"Schweiz"; onboarding hides the code, the dashboard must not re-expose it). Gloss metric abbreviations (SoC, net power) inline with `InfoTip` in the `Stat`/`KpiCard` `label` (both accept a ReactNode). The Marktpreise analytics page deliberately KEEPS EUR/MWh as professional detail under a ct/kWh headline - do not strip it.
