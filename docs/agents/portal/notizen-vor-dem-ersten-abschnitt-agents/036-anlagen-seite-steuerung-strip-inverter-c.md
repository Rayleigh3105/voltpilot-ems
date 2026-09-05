# Anlagen-Seite "Steuerung" strip (inverter control confirmation, vp-inverter-control).

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1, Punkt 036).

- **Anlagen-Seite "Steuerung" strip (inverter control confirmation, `vp-inverter-control`).** A calm read-only line "Fahrplan-Sollwert X → Wechselrichter bestätigt Y" below "Jetzt gerade", rendered by `components/ControlStrip.tsx` from the pure, unit-tested `src/control.ts` `controlStrip(status, now) → {state: healthy|mismatch|stale|off|pending, tone, sentence, agoNote}` (dot tones in `.vp-control-*` CSS). Data: `api.controlStatus(siteId)` → `GET /api/v1/sites/{id}/control-status` (204 → null; polled on the LIVE cockpit cadence (`src/pollCadence.ts`), NOT the 5 s freshness tick). **Customer copy stays free of register/Modbus/kill-switch jargon** (that detail lives on the edge device's `:8484` "Steuerung & Bestätigung" card); `control.test.ts` pins this. The strip renders only once a device reports a readback (control is OFF by default, so most sites show nothing until an operator enables + bench-certifies control - see the root AGENTS.md "Inverter control" section).

