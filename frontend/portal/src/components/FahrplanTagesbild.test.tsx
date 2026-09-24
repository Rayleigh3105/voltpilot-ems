import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitLayoutDocument } from '../cockpitLayout';
import { tagModell, type TagSlot } from '../fahrplanTag';
import { EINFUEHRUNG_KEY } from '../fahrplanTagesbild';
import { UHR_C, uhrPunkt } from '../fahrplanUhr';
import { NBSP } from '../format';
import { haptikZuruecksetzen } from '../haptik';
import { FahrplanTagesbild, type EinfuehrungQuelle } from './FahrplanTagesbild';

/**
 * Das TAGESBILD als Bauteil: Bedienung der Uhr (Tasten, Zeiger, Mitte),
 * Haptik am Telefon, Antworten mit Ort, Einführung (E11), Abspielen und der
 * Wechsel auf den Bildfahrplan ab 900 px (E10). Die Aussagen selbst sind in
 * den reinen Modulen getestet; hier geht es um das Zusammenspiel.
 */

const TAG = new Date(2026, 8, 24);
const JETZT = new Date(2026, 8, 24, 14, 10);

function viertel(i: number, over: Partial<TagSlot> = {}): TagSlot {
  return {
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: 28,
    importPriceCtKwh: i === 57 ? 19.3 : 30,
    exportValueCtKwh: 8,
    pvKw: 0,
    loadKw: 0.5,
    ...over,
  };
}

/** 00:00 Warten · 05:45 Verbrauch decken · 10:00 Warten · 13:30 Günstig laden · 14:30 Sonne speichern · 17:30 Verbrauch decken. */
function tagSlots(): TagSlot[] {
  const laeufe: [string, number][] = [
    ['warten', 23],
    ['eigenverbrauch', 17],
    ['warten', 14],
    ['guenstig_laden', 4],
    ['pv_speichern', 12],
    ['eigenverbrauch', 26],
  ];
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) {
      const i = out.length;
      out.push(
        viertel(i, {
          slotRole: rolle,
          batteryKw: rolle === 'guenstig_laden' ? 2.2 : 0,
          importPriceCtKwh: rolle === 'guenstig_laden' ? 19.3 : 30,
        }),
      );
    }
  }
  return out;
}

const MODELL = tagModell({ slots: tagSlots(), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });

function quelle(doc: CockpitLayoutDocument | null = null): EinfuehrungQuelle & {
  merken: ReturnType<typeof vi.fn>;
} {
  return {
    laden: vi.fn(() => Promise.resolve(doc)),
    merken: vi.fn(() => Promise.resolve(undefined)),
  };
}

/**
 * Eine Marke, die nie antwortet: Tests, die nicht die Einführung prüfen,
 * bekommen so keinen Zustandswechsel nach ihrem Ende (kein `act`-Rauschen) -
 * und die Einführung startet ohne gelesene Marke ohnehin nicht.
 */
function stille(): EinfuehrungQuelle {
  return { laden: () => new Promise<CockpitLayoutDocument | null>(() => undefined), merken: vi.fn() };
}

function zeichnen(over: Partial<Parameters<typeof FahrplanTagesbild>[0]> = {}) {
  const warumPanel = vi.fn((i: number) => <div data-testid="warum">Warum für {i}</div>);
  const onStationen = vi.fn();
  const einfuehrung = over.einfuehrung ?? stille();
  const r = render(
    <FahrplanTagesbild
      tag={MODELL}
      plantKind="eigenverbrauch"
      speicher={null}
      siteId="s1"
      slotFuerWarum={(i) => MODELL.slots[i] ?? null}
      warumPanel={warumPanel}
      onStationen={onStationen}
      einfuehrung={einfuehrung}
      {...over}
    />,
  );
  return { ...r, warumPanel, onStationen, einfuehrung };
}

/** Ein Zeiger-Ereignis auf der Uhr bei einer Uhrzeit (jsdom misst 0 × 0: 1 Einheit = 1 px um den Ursprung). */
function amRing(minute: number, r = 150) {
  const p = uhrPunkt(r, minute);
  return { clientX: p.x - UHR_C, clientY: p.y - UHR_C };
}

function breite(px: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: px,
    height: 600,
    top: 0,
    left: 0,
    right: px,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function telefon(vibrate: ReturnType<typeof vi.fn>) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} })),
  );
  window.matchMedia = globalThis.matchMedia;
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });
}

beforeEach(() => {
  haptikZuruecksetzen();
  // Ohne Bewegung springt der Zeiger (`--vp-motion-scale: 0`) - die Tests
  // prüfen Ziele, nicht Zwischenbilder.
  document.documentElement.style.setProperty('--vp-motion-chart-update', '0ms');
  document.documentElement.style.setProperty('--vp-motion-scale', '0');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { vibrate?: unknown }).vibrate;
  document.documentElement.style.removeProperty('--vp-motion-chart-update');
  document.documentElement.style.removeProperty('--vp-motion-scale');
});

describe('Tagesuhr · lesen', () => {
  it('stellt den Zeiger auf jetzt und sagt es in Worten', () => {
    const { container } = zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(uhr).toHaveAttribute(
      'aria-valuetext',
      `Jetzt, Günstig aus dem Netz laden, Ladestand 50${NBSP}% geplant`,
    );
    expect(container.querySelector('.vp-tb-moment-zeit span')?.textContent).toBe('Jetzt · 14:10');
    expect(container.querySelector('.vp-uhr-m1')?.textContent).toBe('JETZT · 14:10');
    // Direkt unter der Uhr: das Wort der Phase am Zeiger (E8).
    expect(container.querySelector('.vp-tb-zeiger-was')?.textContent).toBe('Günstig aus dem Netz laden');
    // Die Werte am Zeiger sind die Legende.
    expect(container.querySelector('.vp-tb-werte')?.textContent).toContain(`19,3${NBSP}ct`);
  });

  it('zeigt die Antworten direkt darunter und die Waage der Viertelstunde (E1, E5)', () => {
    zeichnen();
    expect(screen.getByText('Wie geht es weiter?')).toBeInTheDocument();
    expect(screen.getByText('Reicht der Speicher heute Abend?')).toBeInTheDocument();
    expect(screen.getByText('Ab 14:30 Sonne speichern, ab 17:30 Verbrauch decken.')).toBeInTheDocument();
    // Die Waage des Netzladens: günstiger als gespeichert wert.
    expect(screen.getByText('Warum lädt er aus dem Netz?')).toBeInTheDocument();
  });

  it('erklärt einen Ring mit einem Satz, wenn man seinen Wert antippt', () => {
    const { container } = zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /Strompreis/ }));
    expect(container.querySelector('.vp-tb-notiz')?.textContent).toContain('Der blaue Ring ist Ihr Strompreis');
    // Die anderen Ebenen treten zurück.
    expect(container.querySelectorAll('.vp-uhr-ebene.is-leise').length).toBeGreaterThan(0);
  });
});

describe('Tagesuhr · bedienen', () => {
  it('wandert mit den Pfeiltasten und kehrt mit Escape zu jetzt zurück', () => {
    const { container } = zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.keyDown(uhr, { key: 'ArrowRight' });
    expect(uhr).toHaveAttribute('aria-valuenow', '57');
    expect(container.querySelector('.vp-tb-moment-zeit')?.textContent).toContain('14:15–14:30 Uhr');
    fireEvent.keyDown(uhr, { key: 'PageUp' });
    expect(uhr).toHaveAttribute('aria-valuenow', '61');
    fireEvent.keyDown(uhr, { key: 'Escape' });
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(container.querySelector('.vp-tb-moment-zeit span')?.textContent).toBe('Jetzt · 14:10');
  });

  it('stellt den Zeiger per Tipp auf die Uhrzeit und rastet an einer Phasengrenze ein', () => {
    zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.pointerDown(uhr, { ...amRing(20 * 60 + 5), pointerId: 1, pointerType: 'mouse' });
    expect(uhr).toHaveAttribute('aria-valuenow', '80');
    fireEvent.pointerUp(uhr, { ...amRing(20 * 60 + 5), pointerId: 1, pointerType: 'mouse' });
    // 17:27 liegt kurz vor dem Beginn „Verbrauch decken" um 17:30 - der Zeiger rastet dort ein.
    fireEvent.pointerDown(uhr, { ...amRing(17 * 60 + 27), pointerId: 2, pointerType: 'mouse' });
    expect(uhr).toHaveAttribute('aria-valuenow', '70');
  });

  it('holt mit einem Tipp in die Mitte die Gegenwart zurück - am Telefon mit Doppel-Impuls', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.keyDown(uhr, { key: 'End' });
    expect(uhr).toHaveAttribute('aria-valuenow', '95');
    fireEvent.pointerDown(uhr, { clientX: 5, clientY: -3, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(uhr, { clientX: 5, clientY: -3, pointerId: 1, pointerType: 'touch' });
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(vibrate).toHaveBeenLastCalledWith([6, 45, 10]);
  });

  it('tickt beim Ziehen am Telefon an jeder Phasengrenze - mit der Maus nie', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.pointerDown(uhr, { ...amRing(15 * 60), pointerId: 1, pointerType: 'touch' });
    // Innerhalb „Sonne speichern": kein Impuls.
    vibrate.mockClear();
    haptikZuruecksetzen();
    fireEvent.pointerMove(uhr, { ...amRing(16 * 60), pointerId: 1, pointerType: 'touch' });
    expect(vibrate).not.toHaveBeenCalled();
    // Über die Grenze nach „Verbrauch decken": ein kurzer Tick.
    fireEvent.pointerMove(uhr, { ...amRing(18 * 60), pointerId: 1, pointerType: 'touch' });
    expect(vibrate).toHaveBeenLastCalledWith(8);
    fireEvent.pointerUp(uhr, { ...amRing(18 * 60), pointerId: 1, pointerType: 'touch' });

    vibrate.mockClear();
    haptikZuruecksetzen();
    fireEvent.pointerDown(uhr, { ...amRing(12 * 60), pointerId: 2, pointerType: 'mouse' });
    fireEvent.pointerMove(uhr, { ...amRing(15 * 60), pointerId: 2, pointerType: 'mouse' });
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('öffnet alle Gründe der gewählten Viertelstunde unter ihrer Waage', () => {
    const { warumPanel, container } = zeichnen();
    const knopf = screen.getByRole('button', { name: /Alle Gründe/ });
    expect(knopf.closest('.vp-waage')).toBe(container.querySelector('.vp-waage'));
    fireEvent.click(knopf);
    expect(screen.getByTestId('warum')).toHaveTextContent('Warum für 56');
    expect(warumPanel).toHaveBeenLastCalledWith(56, expect.any(Function));
  });
});

describe('Antworten zeigen ihren Ort', () => {
  it('dreht den Zeiger zur Stelle der Antwort, zeigt sie als Banner und gibt einen Impuls', async () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    const { container } = zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /Reicht der Speicher heute Abend\?/ }));
    expect(vibrate).toHaveBeenLastCalledWith(14);
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    await waitFor(() => expect(uhr).toHaveAttribute('aria-valuenow', '95'));
    expect(container.querySelector('.vp-tb-antwort')?.textContent).toContain('Ja, bis Mitternacht.');
    // Der Abend ist am Tätigkeitsring markiert.
    expect(container.querySelector('.vp-uhr-markierung')).toBeTruthy();
    fireEvent.click(container.querySelector('.vp-tb-antwort .vp-tb-zurueck') as HTMLElement);
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(container.querySelector('.vp-tb-antwort')).toBeNull();
  });

  it('nennt nach dem Tipp den Zusatz und führt „Alle Stationen" auf dieselbe Seite', () => {
    const { onStationen, container } = zeichnen();
    // Am Telefon steht der Zusatz nicht in der schmalen Kachel, erst im Banner.
    expect(container.querySelector('.vp-antw-zusatz')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reicht der Speicher heute Abend\?/ }));
    expect(container.querySelector('.vp-tb-antwort')?.textContent).toContain(`Um Mitternacht bleiben 50${NBSP}%`);
    fireEvent.click(screen.getByRole('button', { name: /Alle Stationen/ }));
    expect(onStationen).toHaveBeenCalled();
  });

  it('steht der Zeiger auf jetzt, sagt der Block darunter, was das Gerät tut', () => {
    const held = {
      tone: 'ok',
      status: 'Läuft wie vorgesehen — nichts zu tun',
      lead: 'Ihre Batterie lädt gerade',
      value: '2,2 kW',
      valueNote: null,
      valueMissing: null,
      adjust: null,
      conflict: null,
      flowConflict: null,
      flowConflictSeverity: null,
      why: null,
      next: null,
      chips: [],
      confirm: null,
      curtailment: null,
      badgeArt: 'gemessen',
      badgeNote: null,
    } as unknown as Parameters<typeof FahrplanTagesbild>[0]['held'];
    const { container } = zeichnen({ held });
    const jetzt = container.querySelector('.vp-tb-jetzt')!;
    expect(jetzt.textContent).toContain('Läuft wie vorgesehen');
    expect(jetzt.textContent).toContain('2,2 kW');
    // Er steht NACH den Antworten (E9: die Antworten zuerst).
    const reihe = [...container.querySelectorAll('.vp-antw, .vp-tb-jetzt')].map((e) => e.className);
    expect(reihe[0]).toContain('vp-antw');
    // Beim Erkunden spricht er über den Plan der gewählten Viertelstunde.
    fireEvent.keyDown(screen.getByRole('slider', { name: /Tagesuhr/ }), { key: 'ArrowRight' });
    expect(container.querySelector('.vp-tb-jetzt')).toBeNull();
    expect(container.querySelector('.vp-tb-moment-plan')?.textContent).toContain('Geplant');
  });
});

describe('Einführung (E11)', () => {
  it('startet beim ersten Besuch einmal von selbst und merkt sich das Ende', async () => {
    breite(375);
    const q = quelle({ order: [], hidden: [], shown: [], lead: null, seen: ['steuerung-intro'] });
    zeichnen({ einfuehrung: q });
    expect(await screen.findByText(/Die Uhr erklärt · 1 von 5/)).toBeInTheDocument();
    for (let k = 0; k < 4; k++) fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByText(/5 von 5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(screen.queryByText(/Die Uhr erklärt/)).toBeNull();
    // Additiv gemerkt: die Marke der Steuerung bleibt.
    await waitFor(() => expect(q.merken).toHaveBeenCalled());
    expect(q.merken.mock.calls[0][0].seen).toEqual(['steuerung-intro', EINFUEHRUNG_KEY]);
  });

  it('startet nicht, wenn sie schon gesehen wurde - „?" öffnet sie trotzdem', async () => {
    breite(375);
    const q = quelle({ order: [], hidden: [], shown: [], lead: null, seen: [EINFUEHRUNG_KEY] });
    zeichnen({ einfuehrung: q });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Die Uhr erklärt ·/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Die Uhr erklären' }));
    expect(screen.getByText(/Die Uhr erklärt · 1 von 5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Beenden' }));
    expect(screen.queryByText(/Die Uhr erklärt ·/)).toBeNull();
    expect(q.merken).not.toHaveBeenCalled();
  });

  it('behauptet ohne lesbare Marke nichts - und startet nicht', async () => {
    breite(375);
    const q: EinfuehrungQuelle = { laden: () => Promise.reject(new Error('down')), merken: vi.fn() };
    zeichnen({ einfuehrung: q });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Die Uhr erklärt ·/)).toBeNull();
  });
});

describe('Den Tag abspielen', () => {
  it('läuft ohne Bewegung Phase für Phase durch den Tag und endet bei jetzt', () => {
    vi.useFakeTimers();
    try {
      zeichnen();
      const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
      fireEvent.click(screen.getByRole('button', { name: 'Den Tag abspielen' }));
      expect(uhr).toHaveAttribute('aria-valuenow', '0');
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(uhr).toHaveAttribute('aria-valuenow', '23');
      expect(screen.getByRole('button', { name: 'Anhalten' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(900 * 10);
      });
      expect(uhr).toHaveAttribute('aria-valuenow', '56');
      expect(screen.getByRole('button', { name: 'Den Tag abspielen' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Bildfahrplan ab 900 px (E10)', () => {
  it('zeigt am Rechner den Bildfahrplan statt der Uhr - ohne Einführung', async () => {
    breite(1100);
    const { container } = zeichnen();
    expect(container.querySelector('.vp-bf')).toBeTruthy();
    expect(container.querySelector('.vp-uhr')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Die Uhr erklärt ·/)).toBeNull();
    const bild = screen.getByRole('slider', { name: /Bildfahrplan/ });
    fireEvent.keyDown(bild, { key: 'ArrowLeft' });
    expect(bild).toHaveAttribute('aria-valuenow', '55');
  });

  it('markiert die Stelle einer Antwort im Bild, statt einen Zeiger zu drehen', () => {
    breite(1100);
    const { container } = zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /Wie geht es weiter\?/ }));
    expect(container.querySelector('.vp-bf-markierung')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Wie geht es weiter\?/ }));
    expect(container.querySelector('.vp-bf-markierung')).toBeNull();
  });
});
