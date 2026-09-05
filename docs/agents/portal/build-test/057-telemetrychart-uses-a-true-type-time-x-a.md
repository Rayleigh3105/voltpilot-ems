# TelemetryChart uses a TRUE type: 'time' x-axis

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 057).

- **TelemetryChart uses a TRUE `type: 'time'` x-axis** (data as `[ms, value]` pairs) - a category axis gives every sample equal width and massively distorts time under mixed sampling rates (15-min seed next to 10-s live ingest was the real symptom). New telemetry-like charts must do the same. **Jetzt-marker-at-the-edge gotcha:** on a LIVE chart "Jetzt" is always the right edge, where an inside-positioned markLine label renders ROTATED along the line - pin it with `rotate: 0, align: 'right'` (the Fahrplan/Historie charts never hit this because they skip the marker on the last bucket).
