# Der Copy-Wächter nimmt die REINEN Admin-Schichten aus

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 079).

- **Der Copy-Wächter nimmt die REINEN Admin-Schichten aus** (`adminEdgeUpdates`/`adminFleet`/`adminPulse`/`onboardingFunnel`): sie liegen in `src/`, beliefern aber ausschließlich `pages/admin/*` und sprechen legitim Betreiber-Vokabular („Broker", „Rollout"). **Ein zweiter Test prüft, dass keine Kundenfläche sie importiert** — sonst wäre die Ausnahme still ein Loch.
