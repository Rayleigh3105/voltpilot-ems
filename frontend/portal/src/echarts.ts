// Shared registration for the chart types the portal renders. Importing the
// full `echarts` package also ships unused charts and coordinate systems.
import { use } from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// ⚠ `GraphicComponent` zeichnet keine Flaeche — es steht hier, weil
// `REPLACE_MERGE` (`chartMotion.ts`) seinen Namen nennt und echarts JEDEN
// Namen aus `replaceMerge` gegen sein Bauteil-Register prueft
// (`model/Global.js` `normalizeSetOptionInput`), bevor es zeichnet. Ein nicht
// registrierter Name ist deshalb kein fehlendes Detail, sondern ein Absturz
// jeder Flaeche, die ueber die Bewegungs-Huelle zeichnet. Der Waechter dazu:
// `src/chartRegistrierung.test.ts`.
//
// `VisualMapComponent` fehlt mit Absicht (UX-Review V-01, 24.09.2026): kein
// Diagramm setzt mehr einen `visualMap` (die Ampel der Marktpreise ist seit
// `preisFenster.ts` eine Stufenlinie), und das Bauteil kostete das Chart-
// Buendel 11,4 kB gz - genug, um die 210-kB-Grenze aus
// `test/bundle-smoke.sh` zu reissen. Deshalb nennt `REPLACE_MERGE` den Namen
// auch nicht mehr. Wer ihn zurueckbringt, registriert beides zusammen; der
// Waechter in `chartRegistrierung.test.ts` faellt sonst.
use([
  BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent,
  LegendComponent, TitleComponent, DataZoomComponent, MarkAreaComponent,
  MarkLineComponent, MarkPointComponent, AriaComponent, GraphicComponent,
  LabelLayout, UniversalTransition,
  CanvasRenderer,
]);

export { init } from 'echarts/core';
export type { ECharts, EChartsCoreOption } from 'echarts/core';
