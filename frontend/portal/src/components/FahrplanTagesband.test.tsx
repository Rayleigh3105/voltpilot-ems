import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from '../fahrplanTag';
import { FahrplanTagesband } from './FahrplanTagesband';

/**
 * N3 (vp-fahrplan-eigenverbrauch-konzept report.md §9): eine Sonnenspitze
 * nahe der Jetzt-Linie durfte bislang unabhängig davon, ob sie gemessen oder
 * nur geplant ist, auf die gemessene (linke) Seite geklappt werden - eine
 * geplante Spitze läse sich dann als Messung. Nur eine GEMESSENE Spitze darf
 * an die Jetzt-Linie heranrücken.
 */

const TAG = new Date(2026, 8, 24);

function viertel(i: number, pvKw: number): TagSlot {
  return {
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    pvKw,
    loadKw: 0.5,
  };
}

function zeichnen(spitzeIndex: number, now: Date) {
  const slots: TagSlot[] = Array.from({ length: 96 }, (_, i) => viertel(i, i === spitzeIndex ? 6.1 : 1));
  const tag = tagModell({ slots, slotMinutes: 15, now, plantKind: 'eigenverbrauch' });
  return render(
    <FahrplanTagesband
      tag={tag}
      ist={slots.map(() => null)}
      breite={1200}
      auswahl={-1}
      istJetzt
      gewaehlt={false}
      markierung={null}
      onWahl={() => undefined}
      onJetzt={() => undefined}
      onPhase={() => undefined}
    />,
  );
}

describe('FahrplanTagesband · Sonnenspitze nahe der Jetzt-Linie', () => {
  it('klappt eine GEPLANTE Spitze nicht auf die gemessene Seite (N3)', () => {
    // Ohne measuredPvKw ist jede Spitze ungemessen (`gemessen: false`); die
    // Jetzt-Linie liegt praktisch auf ihr (Abstand < 40 px) - der alte Fehler
    // hätte sie trotzdem nach links an die Jetzt-Linie geklappt.
    const spitzeIndex = 40;
    const now = new Date(TAG.getTime() + (spitzeIndex * 15 + 7) * 60_000);
    const { container } = zeichnen(spitzeIndex, now);
    const marke = [...container.querySelectorAll('.vp-tband-marke')].find((e) => e.textContent?.includes('kW'));
    expect(marke).not.toBeUndefined();
    expect(marke!.getAttribute('text-anchor')).toBe('middle');
  });
});
