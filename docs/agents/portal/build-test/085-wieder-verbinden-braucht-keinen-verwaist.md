# ⚠ „Wieder verbinden" braucht KEINEN verwaisten Pin, es braucht KEINE LEBENDE Bindung

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 085).

- **⚠ „Wieder verbinden" braucht KEINEN verwaisten Pin, es braucht KEINE LEBENDE Bindung** (`komponenten.reconnectCandidates`, dieselbe Runde). Die Liste filterte auf `orphanedPin === true` und ließ damit jede Komponente OHNE Pin heraus (`orphanedPin` ist dort `null`, nicht `true`) — die von der Plattform komponierte Zeile, die ihr erstes Gerät noch sucht, eine über den Anlege-Assistenten angelegte Komponente und die Zeile, deren Pin beim Tauschen freigegeben wurde. Genau in diesen drei Fällen bot der Zuordnen-Dialog nur „Als neue Komponente anlegen" an: die namenlose Parallel-Komponente.

