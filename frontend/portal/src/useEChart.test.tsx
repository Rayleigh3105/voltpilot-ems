import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useEChart } from './useEChart';

/**
 * Bewegungs-Programm P1 · der EINE Chart-Hebel.
 *
 * jsdom sieht weder Maske noch Frames — geprueft wird deshalb die REGEL:
 * welche Optionen in welcher Phase bei ECharts ankommen und wann die
 * Aufdeck-Klasse gesetzt und wieder geraeumt wird. Der optische Beweis
 * (pausierte Frames, rAF unter Drosselung) laeuft im echten Chrome.
 */

// --- ECharts-Attrappe -------------------------------------------------------
const gesetzt: Record<string, unknown>[] = [];
const dispose = vi.fn();
let instanz: { setOption: (o: unknown) => void } | null = null;

vi.mock('echarts', () => ({
  init: () => {
    const inst = {
      setOption(o: Record<string, unknown>) {
        gesetzt.push(o);
      },
      resize: () => {},
      getWidth: () => 600,
      dispose,
    };
    instanz = inst as unknown as { setOption: (o: unknown) => void };
    return inst;
  },
}));

// --- Beobachter-Attrappen ---------------------------------------------------
type IoRueckruf = (e: { isIntersecting: boolean }[]) => void;
let ioRueckrufe: IoRueckruf[] = [];
let roRueckrufe: (() => void)[] = [];
let breite = 600;

class IoStub {
  constructor(private cb: IoRueckruf) {
    ioRueckrufe.push(cb);
  }

  observe(): void {}

  disconnect(): void {
    ioRueckrufe = ioRueckrufe.filter((c) => c !== this.cb);
  }
}

class RoStub {
  constructor(private cb: () => void) {
    roRueckrufe.push(cb);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {
    roRueckrufe = roRueckrufe.filter((c) => c !== this.cb);
  }
}

/** Der Beobachter meldet NUR Aenderungen — genau wie im Browser. */
function sichtbar(v = true) {
  act(() => {
    ioRueckrufe.forEach((cb) => cb([{ isIntersecting: v }]));
  });
}

/** Ein Groessenwechsel (Seitenleiste, Aufklapper, Fenster). */
function groesseGeaendert() {
  act(() => {
    roRueckrufe.forEach((cb) => cb());
  });
}

function Diagramm({ opt }: { opt?: Record<string, unknown> }) {
  const ref = useEChart((c) => c.setOption(opt ?? { series: [] }), [opt]);
  return <div ref={ref} data-testid="d" className="vp-chart" />;
}

let motionScale = '1';

beforeEach(() => {
  gesetzt.length = 0;
  ioRueckrufe = [];
  roRueckrufe = [];
  breite = 600;
  motionScale = '1';
  instanz = null;
  vi.stubGlobal('IntersectionObserver', IoStub);
  vi.stubGlobal('ResizeObserver', RoStub);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => breite,
  });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (n: string) =>
      ({
        '--vp-motion-chart': motionScale === '0' ? '0s' : '0.4s',
        '--vp-motion-chart-update': motionScale === '0' ? '0s' : '0.3s',
        '--vp-motion-fast': motionScale === '0' ? '0s' : '0.12s',
        '--vp-motion-scale': motionScale,
      })[n] ?? '',
  } as unknown as CSSStyleDeclaration);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useEChart · Phase: Einstieg steht, danach wird gemorpht', () => {
  it('die ERSTE Zeichnung laeuft mit `animation: false`', () => {
    render(<Diagramm />);
    expect(gesetzt).toHaveLength(1);
    expect(gesetzt[0].animation).toBe(false);
  });

  it('nach dem Aufdecken morpht jeder weitere Zustand', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    expect(getByTestId('d').classList.contains('is-entering')).toBe(true);
    act(() => instanz!.setOption({ series: [{ type: 'bar' }] }));
    expect(gesetzt[1].animation).toBe(true);
    expect(gesetzt[1].animationDurationUpdate).toBe(300);
    expect(gesetzt[1].animationEasingUpdate).toBe('cubicInOut');
  });

  it('SOLANGE nicht aufgedeckt wurde, bleibt jede Zeichnung still', () => {
    // Der Fall des zugeklappten Aufklappers: erst Breite 0, dann volle Breite.
    // Wuerde die Phase schon beim zweiten `setOption` umschlagen, waere genau
    // dieser Sprung ein Morph aus einem entarteten Zustand.
    render(<Diagramm />);
    act(() => instanz!.setOption({ series: [] }));
    act(() => instanz!.setOption({ series: [] }));
    expect(gesetzt.every((o) => o.animation === false)).toBe(true);
  });

  it('die Optionen des Konsumenten gewinnen — auch durch die Huelle', () => {
    render(<Diagramm opt={{ animation: false, series: [{ type: 'line' }] }} />);
    sichtbar();
    act(() => instanz!.setOption({ animation: false, series: [{ type: 'line' }] }));
    expect(gesetzt[1].animation).toBe(false);
    expect(gesetzt[1].series).toEqual([{ type: 'line' }]);
  });
});

describe('useEChart · aufgedeckt wird GENAU EINMAL', () => {
  it('der Behaelter traegt die Marke, an der die Maske haengt', () => {
    const { getByTestId } = render(<Diagramm />);
    expect(getByTestId('d').classList.contains('vp-chart-motion')).toBe(true);
  });

  it('ein schon sichtbares Diagramm deckt sich beim ersten Zeichnen auf', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    expect(getByTestId('d').classList.contains('is-entering')).toBe(true);
  });

  it('das ZEICHNEN deckt auf, wenn der Beobachter sich nicht mehr meldet', () => {
    // ⚠ Der Beobachter meldet nur AENDERUNGEN. Ein Diagramm, das im
    // zugeklappten Aufklapper montiert, liegt schon „im Blick", hat aber keine
    // Breite; geht der Aufklapper auf, kommt die Breite ueber den
    // Groessen-Beobachter — ein zweites Sichtbarkeits-Ereignis gibt es dann
    // nicht. Deshalb prueft auch jedes `setOption`, ob jetzt aufgedeckt werden
    // darf; ohne das bliebe so ein Diagramm fuer immer ohne Einstieg.
    breite = 0;
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    expect(el.classList.contains('is-entering')).toBe(false);
    breite = 600;
    groesseGeaendert(); // fuehrt zu resize + render, KEIN neues IO-Ereignis
    expect(el.classList.contains('is-entering')).toBe(true);
  });

  it('zweimal sichtbar werden deckt nicht zweimal auf', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    el.classList.remove('is-entering'); // Maske ist durchgelaufen
    sichtbar(false);
    sichtbar(true);
    expect(el.classList.contains('is-entering')).toBe(false);
  });

  it('ein Groessenwechsel loest KEINEN zweiten Einstieg aus', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    el.classList.remove('is-entering');
    groesseGeaendert();
    expect(el.classList.contains('is-entering')).toBe(false);
  });

  it('unsichtbar heisst: keine Maske, kein Morph', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar(false);
    expect(getByTestId('d').classList.contains('is-entering')).toBe(false);
    act(() => instanz!.setOption({ series: [] }));
    expect(gesetzt[1].animation).toBe(false);
  });

  it('BREITE 0 wartet — der zugeklappte Aufklapper deckt erst beim Oeffnen auf', () => {
    breite = 0;
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    expect(el.classList.contains('is-entering')).toBe(false);
    // Aufklapper geht auf: Breite kommt, der Beobachter meldet erneut.
    breite = 600;
    sichtbar();
    expect(el.classList.contains('is-entering')).toBe(true);
  });
});

describe('useEChart · der EINE Schalter und das Aufraeumen', () => {
  it('Schalter 0: keine Klasse, das Bild steht sofort', () => {
    motionScale = '0';
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    expect(getByTestId('d').classList.contains('is-entering')).toBe(false);
  });

  it('Schalter 0: die Phase schlaegt trotzdem um — nur ohne Bewegung', () => {
    motionScale = '0';
    render(<Diagramm />);
    sichtbar();
    act(() => instanz!.setOption({ series: [] }));
    // `animation` bleibt false, weil der Schalter jede Dauer nullt.
    expect(gesetzt[1].animation).toBe(false);
    expect(gesetzt[1].animationDurationUpdate).toBe(0);
  });

  it('`animationend` raeumt die Klasse ab', () => {
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    act(() => {
      el.dispatchEvent(new Event('animationend'));
    });
    expect(el.classList.contains('is-entering')).toBe(false);
  });

  it('OHNE `animationend` raeumt die Frist ab (Tabwechsel mitten in der Maske)', () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    expect(el.classList.contains('is-entering')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400 + 120 + 1);
    });
    expect(el.classList.contains('is-entering')).toBe(false);
  });

  it('das Abraeumen entsorgt die Instanz und die Klasse', () => {
    const { getByTestId, unmount } = render(<Diagramm />);
    sichtbar();
    const el = getByTestId('d');
    unmount();
    expect(dispose).toHaveBeenCalled();
    expect(el.classList.contains('is-entering')).toBe(false);
  });

  it('ohne IntersectionObserver laeuft alles wie vor P1 — nur ohne Maske', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { getByTestId } = render(<Diagramm />);
    expect(getByTestId('d').classList.contains('is-entering')).toBe(false);
    expect(gesetzt[0].animation).toBe(false);
  });
});
