// Shared registration for the chart types the portal renders. Importing the
// full `echarts` package also ships unused charts and coordinate systems.
import { use } from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
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

use([
  BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent,
  LegendComponent, TitleComponent, DataZoomComponent, MarkAreaComponent,
  MarkLineComponent, MarkPointComponent, AriaComponent, LabelLayout, UniversalTransition,
  CanvasRenderer,
]);

export { init } from 'echarts/core';
export type { ECharts, EChartsCoreOption } from 'echarts/core';
