# ⚠ Ein markArea-Label wird auf die BREITE seines Rechtecks geklemmt.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 027).

- **⚠ Ein `markArea`-Label wird auf die BREITE seines Rechtecks geklemmt.** Das Abregel-Band („Sonne wird gedrosselt · Preis unter 0", K5: Farbe nie allein) ist oft nur drei Viertelstunden breit — als Flächen-Label quetschte ECharts den Satz Buchstabe auf Buchstabe (im Browser aufgefallen, nicht im Test). Ein Wort über einer schmalen Marke gehört deshalb an einen **`markPoint` mit `symbolSize: 0`** (dieselbe Technik trägt das Spannen-Namensschild). Das Band lebt seit Stufe 2 im LEISTUNGS-Panel (dort ist die Sonne) und die **Ursache wird nur belegt genannt** (`curtailBandLabel`): der Optimierer regelt auch an einer statischen Einspeisegrenze (FK1) ab, „Preis unter 0" wäre dort falsch.
