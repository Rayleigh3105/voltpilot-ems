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
  VisualMapComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// ⚠ `GraphicComponent` und `VisualMapComponent` zeichnen keine Flaeche — sie
// stehen hier, weil `REPLACE_MERGE` (`chartMotion.ts`) ihre Namen nennt und
// echarts JEDEN Namen aus `replaceMerge` gegen sein Bauteil-Register prueft
// (`model/Global.js` `normalizeSetOptionInput`), bevor es zeichnet. Ein nicht
// registrierter Name ist deshalb kein fehlendes Detail, sondern ein Absturz
// jeder Flaeche, die ueber die Bewegungs-Huelle zeichnet. Der Waechter dazu:
// `src/chartRegistrierung.test.ts`.
use([
  BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent,
  LegendComponent, TitleComponent, DataZoomComponent, MarkAreaComponent,
  MarkLineComponent, MarkPointComponent, AriaComponent, GraphicComponent,
  VisualMapComponent, LabelLayout, UniversalTransition,
  CanvasRenderer,
]);

export { init } from 'echarts/core';
export type { ECharts, EChartsCoreOption } from 'echarts/core';
