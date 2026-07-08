import { useEffect, useRef, useState } from 'react';

/**
 * Observe a container's width with a ResizeObserver. Used to switch a widget
 * between a compact and a full rendering by actual available width (not the
 * viewport), so it stays correct inside a reflowing dashboard column - the same
 * container-not-window rationale as useEChart. Returns [ref, width]; width is 0
 * until the first measurement.
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
