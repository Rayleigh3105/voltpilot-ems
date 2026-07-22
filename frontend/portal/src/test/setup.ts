import '@testing-library/jest-dom/vitest';

// jsdom implements no PointerEvent, so @testing-library falls back to a plain
// Event and SILENTLY DROPS clientX/clientY - a pointer drag would then be
// tested with NaN deltas and prove nothing. Portal v3 M5 made the flow canvas
// drag-driven (pointer events, so ONE code path serves mouse AND touch), so we
// give jsdom the minimal browser-faithful class.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;

    readonly pointerType: string;

    readonly isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  // @ts-expect-error - deliberately widening the jsdom window for tests
  window.PointerEvent = PointerEventPolyfill;
  // @ts-expect-error - same, for code that reads the global
  globalThis.PointerEvent = PointerEventPolyfill;
}
