import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MiniBarSpark, MiniLineSpark, MiniShareBar } from './MiniChart';
import type { MiniPoint } from '../miniChart';

/**
 * Die Render-Schicht wird auf die Dinge geprüft, die man ohne DOM nicht sagen
 * kann: dass ein Verlusttag wirklich unter der Nulllinie hängt, dass ein
 * Sichtbarkeits-Strich eine eigene Form BEHÄLT, dass Lücken nichts zeichnen —
 * und dass der Ableseweg ohne Maus funktioniert (der `title`-Tooltip war am
 * Telefon nicht erreichbar).
 */

const tage: MiniPoint[] = [
  { key: 'mo', value: 3.6, label: 'Montag' },
  { key: 'di', value: -0.4, label: 'Dienstag' },
  { key: 'mi', value: null, label: 'Mittwoch' },
  { key: 'do', value: 2.0, label: 'Donnerstag' },
];

function bars(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.vp-mini-bar')];
}

describe('MiniBarSpark · die Nulllinie ist echt', () => {
  it('zeichnet die Nulllinie, sobald es einen negativen Wert gibt', () => {
    const { container } = render(<MiniBarSpark points={tage} ariaLabel="Tageswerte" />);
    expect(container.querySelector('.vp-mini-zero')).not.toBeNull();
  });

  it('zeichnet KEINE Nulllinie auf einer reinen Plus-Reihe - dort ist sie der Boden', () => {
    const { container } = render(
      <MiniBarSpark
        points={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]}
        ariaLabel="nur Gewinne"
      />,
    );
    expect(container.querySelector('.vp-mini-zero')).toBeNull();
  });

  it('hängt den Verlusttag unter die Nulllinie und dimmt ihn NICHT weg', () => {
    const { container } = render(<MiniBarSpark points={tage} ariaLabel="Tageswerte" />);
    const neg = container.querySelector<HTMLElement>('.vp-mini-bar.is-neg');
    expect(neg).not.toBeNull();
    const zero = Number(
      /top:\s*([\d.]+)px/.exec(
        container.querySelector<HTMLElement>('.vp-mini-zero')!.getAttribute('style') ?? '',
      )?.[1],
    );
    const negTop = Number(/top:\s*([\d.]+)px/.exec(neg!.getAttribute('style') ?? '')?.[1]);
    expect(negTop).toBeGreaterThanOrEqual(zero - 0.001);
  });
});

describe('MiniBarSpark · keine Mindesthöhe, keine erfundenen Nullen', () => {
  it('behält für einen zu kleinen Wert die STRICH-Form', () => {
    const { container } = render(
      <MiniBarSpark
        points={[
          { key: 'a', value: 100 },
          { key: 'b', value: 0.01 },
        ]}
        ariaLabel="Werte"
      />,
    );
    expect(bars(container).map((b) => b.dataset.form)).toEqual(['bar', 'tick']);
  });

  it('zeichnet für eine Lücke GAR NICHTS - die Säule bleibt leer', () => {
    const { container } = render(<MiniBarSpark points={tage} ariaLabel="Tageswerte" />);
    // Vier Punkte, aber nur drei gezeichnete Balken: der Mittwoch fehlt.
    expect(container.querySelectorAll('.vp-mini-col')).toHaveLength(4);
    expect(bars(container)).toHaveLength(3);
  });

  it('rendert gar nichts, wenn die Reihe keinen einzigen Wert trägt', () => {
    const { container } = render(
      <MiniBarSpark points={[{ key: 'a', value: null }]} ariaLabel="leer" />,
    );
    expect(container.querySelector('.vp-mini')).toBeNull();
  });
});

describe('MiniBarSpark · Betonung, Vergangenheit, Marken', () => {
  it('betont genau einen Punkt', () => {
    const { container } = render(
      <MiniBarSpark points={tage} emphasisKey="do" ariaLabel="Tageswerte" />,
    );
    expect(container.querySelectorAll('.vp-mini-bar.is-on')).toHaveLength(1);
  });

  it('dimmt alles vor dem Jetzt-Punkt', () => {
    const { container } = render(
      <MiniBarSpark points={tage} nowKey="do" ariaLabel="Tageswerte" />,
    );
    expect(container.querySelectorAll('.vp-mini-bar.is-past')).toHaveLength(2);
  });

  it('benennt die bemerkenswerten Punkte IM Bild (K6)', () => {
    render(
      <MiniBarSpark
        points={tage}
        ariaLabel="Tageswerte"
        marks={[
          { key: 'do', label: 'heute' },
          { key: 'di', label: 'Verlusttag −0,40 €', place: 'below', tone: 'warn' },
        ]}
      />,
    );
    expect(screen.getByText('heute')).toBeTruthy();
    expect(screen.getByText('Verlusttag −0,40 €')).toBeTruthy();
  });

  it('lässt höchstens drei Marken zu - mehr ist Rauschen', () => {
    const { container } = render(
      <MiniBarSpark
        points={tage}
        ariaLabel="Tageswerte"
        marks={[
          { key: 'mo', label: 'eins' },
          { key: 'di', label: 'zwei' },
          { key: 'mi', label: 'drei' },
          { key: 'do', label: 'vier' },
        ]}
      />,
    );
    expect(container.querySelectorAll('.vp-mini-mark')).toHaveLength(3);
  });

  it('ignoriert eine Marke, deren Punkt es gar nicht gibt', () => {
    const { container } = render(
      <MiniBarSpark points={tage} ariaLabel="Tageswerte" marks={[{ key: 'gibtsnicht', label: 'x' }]} />,
    );
    expect(container.querySelectorAll('.vp-mini-mark')).toHaveLength(0);
  });
});

describe('MiniBarSpark · der Ableseweg ersetzt den `title`-Tooltip', () => {
  const readout = (p: MiniPoint) =>
    p.value == null ? `${p.label}: keine Daten` : `${p.label}: ${p.value} €`;

  it('zeigt ohne Bedienung die Bildunterschrift', () => {
    render(
      <MiniBarSpark
        points={tage}
        ariaLabel="Tageswerte"
        readout={readout}
        caption="Die letzten 4 Tage"
      />,
    );
    expect(screen.getByText('Die letzten 4 Tage')).toBeTruthy();
  });

  it('ist mit der TASTATUR bedienbar - ohne Maus, ohne Hover', () => {
    const { container } = render(
      <MiniBarSpark points={tage} ariaLabel="Tageswerte" readout={readout} caption="—" />,
    );
    const box = container.querySelector<HTMLElement>('.vp-mini')!;
    expect(box.tabIndex).toBe(0);
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(screen.getByText('Dienstag: -0.4 €')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'End' });
    expect(screen.getByText('Donnerstag: 2 €')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('reagiert auf ANTIPPEN, nicht nur auf Hover (die Telefon-Lücke)', () => {
    const { container } = render(
      <MiniBarSpark points={tage} ariaLabel="Tageswerte" readout={readout} caption="—" />,
    );
    fireEvent.pointerDown(container.querySelectorAll('.vp-mini-col')[0]);
    expect(screen.getByText('Montag: 3.6 €')).toBeTruthy();
  });

  it('sagt bei einer Lücke „keine Daten", statt eine Null zu behaupten', () => {
    const { container } = render(
      <MiniBarSpark points={tage} ariaLabel="Tageswerte" readout={readout} caption="—" />,
    );
    fireEvent.pointerDown(container.querySelectorAll('.vp-mini-col')[2]);
    expect(screen.getByText('Mittwoch: keine Daten')).toBeTruthy();
  });

  it('bleibt ohne `readout` ein reines Bild - kein Tab-Stopp', () => {
    const { container } = render(<MiniBarSpark points={tage} ariaLabel="Tageswerte" />);
    expect(container.querySelector<HTMLElement>('.vp-mini')!.tabIndex).toBe(-1);
  });
});

describe('MiniLineSpark', () => {
  it('bricht die Linie an einer Lücke, statt darüber hinwegzuzeichnen', () => {
    const { container } = render(
      <MiniLineSpark
        points={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
          { key: 'c', value: null },
          { key: 'd', value: 4 },
          { key: 'e', value: 5 },
        ]}
        ariaLabel="Trend"
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('zeichnet die Nulllinie nur bei negativen Werten', () => {
    const { container } = render(<MiniLineSpark points={tage} ariaLabel="Trend" />);
    expect(container.querySelector('.vp-mini-line-zero')).not.toBeNull();
    const { container: nurPlus } = render(
      <MiniLineSpark
        points={[
          { key: 'a', value: 1 },
          { key: 'b', value: 3 },
        ]}
        ariaLabel="Trend"
      />,
    );
    expect(nurPlus.querySelector('.vp-mini-line-zero')).toBeNull();
  });

  it('rendert nichts, wenn kein Segment übrig bleibt', () => {
    const { container } = render(
      <MiniLineSpark points={[{ key: 'a', value: 1 }]} ariaLabel="Trend" />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('MiniShareBar · EINE Geometrie, drei Höhen', () => {
  it('rendert den Fortschritts-Fall als EINEN Anteil', () => {
    const { container } = render(<MiniShareBar fraction={0.42} ariaLabel="Fortschritt" />);
    const fill = container.querySelector<HTMLElement>('.vp-share-fill')!;
    expect(fill.style.width).toBe('42%');
  });

  it('klemmt einen unmöglichen Anteil, statt über den Rand zu laufen', () => {
    const { container } = render(<MiniShareBar fraction={1.8} />);
    expect(container.querySelector<HTMLElement>('.vp-share-fill')!.style.width).toBe('100%');
  });

  it('rendert den Anteils-Fall als Segmente in ihrem Gewicht', () => {
    const { container } = render(
      <MiniShareBar
        segments={[
          { key: 'a', weight: 3 },
          { key: 'b', weight: 1 },
        ]}
      />,
    );
    const segs = [...container.querySelectorAll<HTMLElement>('.vp-share-seg')];
    expect(segs.map((s) => s.style.flexGrow)).toEqual(['3', '1']);
  });

  it('trägt die drei Höhen als Grössen-Klasse', () => {
    for (const size of ['micro', 'md', 'lg'] as const) {
      const { container } = render(<MiniShareBar fraction={0.5} size={size} />);
      expect(container.querySelector(`.vp-share.is-${size}`)).not.toBeNull();
    }
  });
});
