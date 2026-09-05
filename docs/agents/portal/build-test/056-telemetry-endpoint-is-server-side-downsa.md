# Telemetry endpoint is server-side downsampled

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 056).

- **Telemetry endpoint is server-side downsampled:** windows > 3h come back as 1-minute `time_bucket` averages, point `ts` = bucket START, and when the row cap bites the OLDEST points drop, never the newest (`TelemetryRepository`). Consequences for the portal: the "newest point" can read up to ~1 min old even with 10 s live data (the freshness chip understates, never overstates), and the F6 regression test `PortalApiTest.telemetryWindowStaysCompleteAndCurrentWhenRawCountExceedsTheLimit` pins the complete-and-current window.
