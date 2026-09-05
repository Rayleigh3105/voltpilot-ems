# Customer-facing price axis is ct/kWh, not EUR/MWh.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 052).

- **Customer-facing price axis is ct/kWh, not EUR/MWh.** Fahrplan + Historie day + the Übersicht price mini-chart divide `priceEurMwh` by 10 and label the axis "ct/kWh" (the unit on the bill). Only the Marktpreise analytics page keeps EUR/MWh as professional detail under a ct/kWh headline (see the format.ts bullet).
