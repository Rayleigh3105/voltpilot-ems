# Chart heights are responsive via CSS classes, not fixed inline px

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 028).

- **Chart heights are responsive via CSS classes, not fixed inline px:** `.vp-chart` (`clamp(260px,40vw,340px)`), `.vp-chart.tall`, `.vp-chart.compact`, **`.vp-chart.panels`** (die Zwei-Panel-Stufe, `clamp(340px,54vw,460px)` — zwei Flächen brauchen mehr Höhe, sonst verliert die untere genau das, was der Umbau lesbar machen soll; am Telefon stapeln sie sich weiter INNERHALB einer Instanz, sie teilen ja die Zeitachse), **`.vp-chart.panels3`** (die Drei-Panel-Stufe des Tagesbilds, `clamp(420px,66vw,560px)`) — alle in `src/index.css`. A chart div just needs `className="vp-chart"` - no `style={{height}}`.
