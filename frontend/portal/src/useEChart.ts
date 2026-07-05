import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

/**
 * Shared ECharts lifecycle for every portal chart: init once on mount, dispose
 * on unmount, and re-render through a ResizeObserver on the container itself -
 * not just window resize - so a chart follows its container through sidebar
 * collapse, grid reflow and drawer layout. The render callback receives the
 * chart plus its current pixel width, so width-aware options (tick density,
 * axis names, legend room) re-evaluate at every size, and the canvas can never
 * end up wider than its container (the fluid-resize requirement).
 */
export function useEChart(
  render: (chart: echarts.ECharts, width: number) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const observer = new ResizeObserver(() => {
      if (!chart.current || !ref.current) return;
      if (ref.current.clientWidth === 0) return; // hidden - nothing to lay out
      chart.current.resize();
      renderRef.current(chart.current, chart.current.getWidth());
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (chart.current) render(chart.current, chart.current.getWidth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
