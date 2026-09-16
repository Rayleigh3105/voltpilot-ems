import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from './rollenFixtures';
import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

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

// jsdom has no ResizeObserver either. `useContainerWidth` (the canvas
// fit-to-width since audit E-2, and every widget that switches layout by real
// container width) constructs one on mount, so without this every component
// test that renders such a widget throws. The stub never fires: jsdom lays
// nothing out, so `clientWidth` stays 0 and `fitScale` returns 1 - i.e. the
// tests measure the UNSCALED layout, exactly as before.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  }
  // @ts-expect-error - deliberately widening the jsdom globals for tests
  globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom implementiert `scrollIntoView` NICHT. Die Steuerung holt ihren
// Hinweis-Streifen nach jedem `fail(...)` in den Blick (er steht oben, die
// auslösende Aktion weit darunter) - und zwar in einem `requestAnimationFrame`,
// also NACH dem Testende. Ohne diesen Stub wirft genau dieser Rückholer nach
// dem Unmount und lässt die ganze Datei rot werden, obwohl jeder Test grün ist.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
}

// jsdom implementiert `window.scrollTo` ebenfalls nicht, wirft dort aber nur
// eine „Not implemented"-Meldung ins stderr. Jede Fläche, die eine Navigation
// als Navigation behandelt (Seitenwechsel, Listen-/Detail-Wechsel), ruft es -
// ohne Stub steht die Meldung zwischen den Testergebnissen und macht echte
// Fehler schwerer zu finden.
if (typeof window !== 'undefined') {
  window.scrollTo = function scrollToStub(): void {};
}

// Jeder Test beginnt in einem FRISCHEN Tab. Seit dem Chart-Redesign merken
// sich mehrere Flächen ihre Detailtiefe in `sessionStorage` (`useChartDetail`,
// die Fahrplan-Schichten, das Verlauf-Aufklappen) - jsdom teilt den Speicher
// aber über alle Tests EINER Datei, also würde der Umschalt-Klick des einen
// Tests den Grundzustand des nächsten verändern. Genau so ist es beim Bau
// aufgefallen. Tests, die einen Zustand ABSICHTLICH vorbelegen, setzen ihn in
// ihrem eigenen `beforeEach`/Körper - der läuft nach diesem hier.
beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* kein Speicher in dieser Umgebung - dann gibt es auch nichts zu leeren. */
  }
});

// Bestands-Komponententests laufen als der übernommene Kundenadministrator.
// Rechte-Tests setzen danach ihre eigene /me-Momentaufnahme (einschließlich null).
beforeEach(() => setSelbstauskunft(rechteSeed().me));
