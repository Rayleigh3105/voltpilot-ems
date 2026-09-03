import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from './States';

/**
 * V10 · Die drei Zustände einer Verlauf-Karte — die FLÄCHE
 * (Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 V10, Paket P2b).
 * Die Höhen und die Skala prüft `src/verlaufZustaende.test.ts`.
 */

describe('P2b · Laden reserviert die Anatomie der Karte', () => {
  it('legt Label, Kernsatz, Diagramm und Legende an', () => {
    const { container } = render(<VerlaufKarteSkeleton />);
    for (const k of ['label', 'satz', 'chart', 'legende']) {
      expect(container.querySelector(`.vp-c-zst-${k}`), k).not.toBeNull();
    }
  });

  it('sagt Hilfsmitteln, dass geladen wird — und zeigt nichts Zählendes', () => {
    const { container } = render(<VerlaufKarteSkeleton />);
    const status = container.querySelector('[role="status"]') as HTMLElement;
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Wird geladen…')).toHaveClass('vp-sr-only');
    // Die Platzhalter sind Dekoration — sie dürfen nicht mitgelesen werden.
    for (const el of container.querySelectorAll('.vp-skeleton')) {
      expect(el).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('eine Karte ohne Legende reserviert auch keine', () => {
    const { container } = render(<VerlaufKarteSkeleton legende={false} />);
    expect(container.querySelector('.vp-c-zst-legende')).toBeNull();
    expect(container.querySelector('.vp-c-zst-chart')).not.toBeNull();
  });
});

describe('P2b · Leer nennt den Weg, ohne eine Kachel zu bauen', () => {
  it('Label, ein Satz — und kein 48-px-Symbol, keine h3', () => {
    const { container } = render(
      <VerlaufLeer label="Keine Messwerte in diesem Zeitraum" satz="Sobald Ihre Anlage misst …" />,
    );
    expect(screen.getByText('Keine Messwerte in diesem Zeitraum')).toHaveClass('vp-c-zst-leer-label');
    expect(screen.getByText('Sobald Ihre Anlage misst …')).toHaveClass('vp-c-zst-text');
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('.vp-icon-tile')).toBeNull();
  });

  it('der Weg erscheint nur, wenn er wirklich irgendwohin führt', () => {
    const { container } = render(<VerlaufLeer label="L" satz="S" weg="Anderen Zeitraum wählen" />);
    expect(container.querySelector('.vp-c-zst-weg')).toBeNull();
  });

  it('und ruft dann genau eine Handlung auf', () => {
    const onWeg = vi.fn();
    render(<VerlaufLeer label="L" satz="S" weg="Anderen Zeitraum wählen" onWeg={onWeg} />);
    screen.getByRole('button', { name: 'Anderen Zeitraum wählen' }).click();
    expect(onWeg).toHaveBeenCalledTimes(1);
  });
});

describe('P2b · Fehler meldet sich, ohne die Karte zu ersetzen', () => {
  it('ist ein `alert` und trägt seinen Satz in Textgrösse', () => {
    const { container } = render(<VerlaufFehler satz="Die Historie konnte nicht geladen werden." />);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(screen.getByText('Die Historie konnte nicht geladen werden.')).toHaveClass('vp-c-zst-text');
    // ⚠ KEINE eigene Kachel: die alte `.vp-alert`-Fläche brachte ihren eigenen
    //   Rahmen mit und stand damit AN STELLE der Karte.
    expect(container.querySelector('.vp-alert')).toBeNull();
  });

  it('bietet die eine Handlung an — als 44-px-Knopf', () => {
    const onRetry = vi.fn();
    const { container } = render(<VerlaufFehler satz="Fehler." onRetry={onRetry} />);
    const knopf = screen.getByRole('button', { name: /Erneut versuchen/ });
    expect(knopf).toHaveClass('vp-c-zst-knopf');
    knopf.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('ohne Handlung steht nur der Satz', () => {
    const { container } = render(<VerlaufFehler satz="Fehler." />);
    expect(container.querySelector('button')).toBeNull();
  });
});
