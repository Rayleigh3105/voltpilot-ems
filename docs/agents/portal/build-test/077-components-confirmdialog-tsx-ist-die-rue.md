# components/ConfirmDialog.tsx ist die Rückfrage im Haus-Muster

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 077).

- **`components/ConfirmDialog.tsx` ist die Rückfrage im Haus-Muster** — die nicht-destruktive Schwester von `DangerZone`, mit derselben Aufzählung. Sie ersetzt `window.confirm` für die Registry-Löschung und jede weitere Rückfrage: ein `confirm()` zeigt einen Fließtext, den niemand liest, ist am Telefon ein System-Popup ohne Zusammenhang und blockiert den Renderer. **Eine Umstellung nennt in der Liste, was GLEICH bleibt** (sonst liest sie sich wie ein Lockern der Regeln); eine reine RÜCKNAHME fragt gar nicht.
