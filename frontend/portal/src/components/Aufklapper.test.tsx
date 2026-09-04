import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Aufklapper } from './Aufklapper';

/**
 * V8 · DER Aufklapper des Verlaufs (Konzept §3.2 V8, Paket P2b).
 *
 * Geprüft wird die FORM, nicht ein Reiter: 48 px Trefferfläche über die volle
 * Breite, `<details>`/`<summary>` (also Tastatur und Ansage vom Browser), der
 * Chevron dreht über `--vp-motion-base`, der Inhalt blendet ein (P6/E6 a),
 * und die HÖHE bewegt sich nie.
 */

function Kontrolliert({ start = false }: { start?: boolean }) {
  const [open, setOpen] = useState(start);
  return (
    <Aufklapper titel="Was diese Zahlen sind" sub="bewertet" open={open} onToggle={() => setOpen((o) => !o)}>
      <p>Der volle Wortlaut</p>
    </Aufklapper>
  );
}

const sum = (c: HTMLElement) => c.querySelector('summary.vp-c-aufk-sum') as HTMLElement;
const det = (c: HTMLElement) => c.querySelector('details.vp-c-aufk') as HTMLDetailsElement;

describe('P2b · EINE Aufklapper-Form', () => {
  it('ist ein natives details/summary — die Tastatur kommt vom Browser', () => {
    const { container } = render(<Kontrolliert />);
    const d = det(container);
    const s = sum(container);
    expect(d.tagName).toBe('DETAILS');
    expect(s.tagName).toBe('SUMMARY');
    // Enter und Leertaste aktivieren ein `summary` nativ; der Beweis dafür ist,
    // dass es EIN `summary` in EINEM `details` ist — nicht ein `div[role]`, an
    // dem wir die Tastatur selbst nachbauen müssten.
    expect(s.parentElement).toBe(d);
  });

  it('öffnet und schließt — und meldet jeden Wechsel genau einmal', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <Aufklapper titel="Titel" open={false} onToggle={onToggle}>
        <p>Inhalt</p>
      </Aufklapper>,
    );
    fireEvent.click(sum(container));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('der Zustand steht am summary — zu, dann auf', () => {
    const { container } = render(<Kontrolliert />);
    expect(sum(container)).toHaveAttribute('aria-expanded', 'false');
    expect(det(container).open).toBe(false);
    fireEvent.click(sum(container));
    expect(sum(container)).toHaveAttribute('aria-expanded', 'true');
    expect(det(container).open).toBe(true);
    fireEvent.click(sum(container));
    expect(sum(container)).toHaveAttribute('aria-expanded', 'false');
  });

  it('der Wortlaut bleibt im DOM — auch zugeklappt findet ihn die Browser-Suche', () => {
    const { container } = render(<Kontrolliert />);
    expect(det(container).open).toBe(false);
    expect(screen.getByText('Der volle Wortlaut')).toBeInTheDocument();
  });

  it('ohne `open` führt der Browser den Zustand selbst', () => {
    const { container } = render(
      <Aufklapper titel="Frei">
        <p>Inhalt</p>
      </Aufklapper>,
    );
    expect(sum(container)).not.toHaveAttribute('aria-expanded');
    fireEvent.click(sum(container));
    expect(det(container).open).toBe(true);
  });

  it('eine leere Unterzeile wird nicht zur leeren Spalte', () => {
    const { container } = render(
      <Aufklapper titel="Titel" sub="">
        <p>x</p>
      </Aufklapper>,
    );
    expect(container.querySelector('.vp-c-aufk-sub')).toBeNull();
  });
});

describe('P2b · das Blatt hält die Zusagen der Form', () => {
  const css = readCss();

  it('die Trefferfläche ist 48 px über die volle Breite', () => {
    const r = regel(css, '.vp-c-aufk-sum');
    expect(r).toMatch(/min-height:\s*48px/);
    expect(r).toMatch(/width:\s*100%/);
    expect(r).toMatch(/cursor:\s*pointer/);
  });

  it('die Zeile ist 16/600 und der Inhalt Textgröße', () => {
    expect(regel(css, '.vp-c-aufk-titel')).toMatch(/font-size:\s*var\(--vp-c-fs-16\)/);
    expect(regel(css, '.vp-c-aufk-titel')).toMatch(/font-weight:\s*var\(--vp-c-fw-600\)/);
    expect(regel(css, '.vp-c-aufk-body')).toMatch(/font-size:\s*var\(--vp-c-fs-16\)/);
  });

  it('die Höhe springt, der Inhalt blendet, der Chevron dreht — alles aus der Familie (E6 a)', () => {
    expect(regel(css, '.vp-c-aufk-chev::before')).toMatch(
      /transition:\s*transform\s+var\(--vp-motion-base\)/,
    );
    // P6: der Inhalt eines OFFENEN Aufklappers blendet ein — Opazität und ein
    // halber `--vp-motion-distance`, nie eine Höhe.
    expect(regel(css, '.vp-c-aufk[open] > .vp-c-aufk-body')).toMatch(
      /animation:\s*vp-c-aufk-inhalt\s+var\(--vp-motion-base\)/,
    );
    // Keine Höhen-Animation und kein zweiter reduced-motion-Block — die Dauer
    // führt `index.css` (P0). ⚠ Kommentare zuerst RAUS: sie nennen beides.
    const ohneKommentar = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ohneKommentar).not.toMatch(/transition:[^;]*(?:max-)?height/);
    expect(ohneKommentar).not.toMatch(/(?:transition|animation):[^;]*\bheight\b/);
    expect(ohneKommentar).not.toMatch(/prefers-reduced-motion/);
  });
});

function readCss(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(process.cwd(), 'src/components/Aufklapper.css'), 'utf8');
}

/** Der Rumpf EINER Regel — Kommentare vorher raus, sie nennen Selektoren. */
function regel(css: string, sel: string): string {
  const ohne = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of ohne.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      m[1]
        .split(',')
        .map((t) => t.trim())
        .includes(sel)
    ) {
      return m[2];
    }
  }
  throw new Error(`Regel ${sel} fehlt in Aufklapper.css`);
}
