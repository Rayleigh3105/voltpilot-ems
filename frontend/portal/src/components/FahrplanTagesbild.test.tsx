import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitLayoutDocument } from '../cockpitLayout';
import { tagModell, type TagSlot } from '../fahrplanTag';
import { bildGeometrie } from '../fahrplanBildfahrplan';
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
  const phasenPanel = vi.fn((p: number) => <div data-testid="phase">Phase {p}</div>);
  const einfuehrung = over.einfuehrung ?? stille();
  const r = render(
    <FahrplanTagesbild
      tag={MODELL}
      plantKind="eigenverbrauch"
      speicher={null}
      siteId="s1"
      slotFuerWarum={(i) => MODELL.slots[i] ?? null}
      warumPanel={warumPanel}
      phasenPanel={phasenPanel}
      einfuehrung={einfuehrung}
      {...over}
    />,
  );
  return { ...r, warumPanel, phasenPanel, einfuehrung };
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
    expect(container.querySelector('.vp-uhr-m1')?.textContent).toBe('JETZT · 14:10');
    // Über der Uhr der Kopfsatz des Tages (Prototyp) ...
    expect(container.querySelector('.vp-tb-titel')?.textContent).toBe(
      'Heute: morgens Verbrauch decken, nachmittags Sonne speichern, abends Verbrauch decken.',
    );
    // ... unter der Uhr das Wort der Phase am Zeiger (E8) - bei „jetzt" ohne Zeitkopf.
    expect(container.querySelector('.vp-tb-moment-was')?.textContent).toBe('Günstig aus dem Netz laden');
    expect(container.querySelector('.vp-tb-moment-kopf')).toBeNull();
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
    expect(container.querySelector('.vp-tb-moment-kopf')?.textContent).toBe('14:15–14:30 Uhr · geplant');
    fireEvent.keyDown(uhr, { key: 'PageUp' });
    expect(uhr).toHaveAttribute('aria-valuenow', '61');
    fireEvent.keyDown(uhr, { key: 'Escape' });
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(container.querySelector('.vp-tb-moment-kopf')).toBeNull();
    expect(container.querySelector('.vp-tb-moment-was')?.textContent).toBe('Günstig aus dem Netz laden');
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

  it('bestätigt am Telefon jeden Tipp auf die Ringe mit einem Tick - auch in derselben Phase', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.pointerDown(uhr, { ...amRing(15 * 60), pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(uhr, { ...amRing(15 * 60), pointerId: 1, pointerType: 'touch' });
    vibrate.mockClear();
    haptikZuruecksetzen();
    // 16:00 liegt wie 15:00 in „Sonne speichern" - der Tipp versetzt den Zeiger trotzdem.
    fireEvent.pointerDown(uhr, { ...amRing(16 * 60), pointerId: 2, pointerType: 'touch' });
    expect(uhr).toHaveAttribute('aria-valuenow', '64');
    expect(vibrate).toHaveBeenLastCalledWith(8);
  });

  it('öffnet alle Gründe der gewählten Viertelstunde unter ihrer Waage', () => {
    const { warumPanel, container } = zeichnen();
    const knopf = screen.getByRole('button', { name: /Alle Gründe/ });
    const karte = screen.getByRole('region', { name: 'Die Waage' });
    expect(karte.contains(knopf)).toBe(true);
    expect(karte.querySelector('.vp-waage')).toBe(container.querySelector('.vp-waage'));
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
    const rollen = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const { container } = zeichnen();
    // Am Telefon steht der Zusatz nicht in der schmalen Kachel, erst im Banner.
    expect(container.querySelector('.vp-antw-zusatz')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reicht der Speicher heute Abend\?/ }));
    expect(container.querySelector('.vp-tb-antwort')?.textContent).toContain(`Um Mitternacht bleiben 50${NBSP}%`);
    fireEvent.click(screen.getByRole('button', { name: /Alle Stationen/ }));
    expect(rollen.mock.contexts).toContain(screen.getByRole('region', { name: 'Der Tag in Stationen' }));
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
    // Unter der Uhr spricht das Gerät: Aussage und Zahl der Ausführung.
    const moment = container.querySelector('.vp-tb-moment')!;
    expect(moment.textContent).toContain('Ihre Batterie lädt gerade');
    expect(moment.textContent).toContain('2,2 kW');
    // Der Zustand steht wörtlich da (F5), mit dem Weg zum Eingreifen.
    expect(container.querySelector('.vp-tb-todo')?.textContent).toContain('Läuft wie vorgesehen');
    expect(screen.getByRole('link', { name: /Eingreifen/ })).toHaveAttribute('href', '#/anlage/s1/steuerung');
    // Reihenfolge des Prototyps: Moment, Antworten, Zustand.
    const reihe = [...container.querySelectorAll('.vp-tb-moment, .vp-antw, .vp-tb-todo')].map((e) => e.classList[0]);
    expect(reihe).toEqual(['vp-tb-moment', 'vp-antw', 'vp-tb-todo']);
    // Beim Erkunden spricht die Zeile über den Plan der gewählten Viertelstunde.
    fireEvent.keyDown(screen.getByRole('slider', { name: /Tagesuhr/ }), { key: 'ArrowRight' });
    expect(container.querySelector('.vp-tb-todo')).toBeNull();
    expect(container.querySelector('.vp-tb-moment-kopf')?.textContent).toBe('14:15–14:30 Uhr · geplant');
    expect(container.querySelector('.vp-tb-moment-zahl')?.textContent).toBe(`laden mit 2,2${NBSP}kW · Ladestand danach 50${NBSP}%`);
  });
});

describe('Haptik an jeder Bedienstelle am Telefon', () => {
  it('lässt „Zurück zu jetzt" sich anfühlen wie den Tipp in die Mitte', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    const uhr = screen.getByRole('slider', { name: /Tagesuhr/ });
    fireEvent.keyDown(uhr, { key: 'End' });
    vibrate.mockClear();
    haptikZuruecksetzen();
    fireEvent.click(screen.getByRole('button', { name: /Zurück zu jetzt/ }));
    expect(uhr).toHaveAttribute('aria-valuenow', '56');
    expect(vibrate).toHaveBeenLastCalledWith([6, 45, 10]);
  });

  it('tickt, wenn man einen Wert am Zeiger antippt', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /^Strompreis/ }));
    expect(vibrate).toHaveBeenLastCalledWith(8);
  });

  it('lässt den abgespielten Tag an jeder Phasengrenze ticken und endet mit „jetzt"', () => {
    // Der Mindestabstand der Haptik misst mit `performance.now()`: die
    // Attrappe der Zeit muss sie mitführen (Vitest 2 täuscht sie sonst nicht).
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date', 'performance'],
    });
    try {
      const vibrate = vi.fn((_muster: VibratePattern) => true);
      telefon(vibrate);
      zeichnen();
      fireEvent.click(screen.getByRole('button', { name: 'Den Tag abspielen' }));
      act(() => {
        vi.advanceTimersByTime(900 * 10);
      });
      // Sechs Phasen, sechs Ticks (ohne Bewegung Phase für Phase) - dann jetzt.
      expect(vibrate.mock.calls.filter(([m]) => m === 8)).toHaveLength(6);
      expect(vibrate).toHaveBeenLastCalledWith([6, 45, 10]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tickt am Tablet beim Antippen einer Viertelstunde im Bildfahrplan - mit der Maus nie', () => {
    breite(1100);
    // Die Zeichenfläche misst in jsdom 0 × 0; sie bekommt dieselbe Breite.
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1100,
      height: 330,
      top: 0,
      left: 0,
      right: 1100,
      bottom: 330,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    const bild = screen.getByRole('slider', { name: /Bildfahrplan/ });
    const x = bildGeometrie(1100).x(18 * 60 + 5);
    fireEvent.pointerDown(bild, { clientX: x, clientY: 200, pointerType: 'touch' });
    fireEvent.click(bild, { clientX: x, clientY: 200 });
    expect(bild).toHaveAttribute('aria-valuenow', '72');
    expect(vibrate).toHaveBeenLastCalledWith(8);

    vibrate.mockClear();
    haptikZuruecksetzen();
    const y = bildGeometrie(1100).x(20 * 60 + 5);
    fireEvent.pointerDown(bild, { clientX: y, clientY: 200, pointerType: 'mouse' });
    fireEvent.click(bild, { clientX: y, clientY: 200 });
    expect(bild).toHaveAttribute('aria-valuenow', '80');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('gibt auch im Bildfahrplan einen Impuls, wenn man eine Antwort antippt', () => {
    breite(1100);
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /Wie geht es weiter\?/ }));
    expect(vibrate).toHaveBeenLastCalledWith(14);
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

describe('Aufbau des Prototyps', () => {
  it('zeigt den Tag in Stationen - dieselben Phasen, das Warum per Tipp', () => {
    const { phasenPanel } = zeichnen();
    const karte = screen.getByRole('region', { name: 'Der Tag in Stationen' });
    const halte = karte.querySelectorAll('.vp-st-halt');
    expect(halte).toHaveLength(MODELL.phasen.length);
    const jetzt = karte.querySelector('.vp-st-halt.is-jetzt')!;
    expect(jetzt.textContent).toContain('Jetzt');
    expect(jetzt.textContent).toContain('Günstig aus dem Netz laden');
    expect(karte.querySelectorAll('.vp-st-halt.is-vorbei').length).toBeGreaterThan(0);
    fireEvent.click(jetzt.querySelector('.vp-st-zeile') as HTMLElement);
    expect(phasenPanel).toHaveBeenLastCalledWith(3, expect.any(Function));
    expect(screen.getByTestId('phase')).toHaveTextContent('Phase 3');
  });

  it('sagt, worauf der Plan achtet - und führt zu allen Werten', () => {
    const onAlleWerte = vi.fn();
    zeichnen({
      annahmen: [{ key: 'tarif', icon: 'euro', titel: 'Dynamischer Tarif', text: 'Ihr Strompreis folgt der Börse.', link: null }],
      berechnung: 'Der Optimierer rechnet alle 15 Minuten.',
      onAlleWerte,
      planVon: '14:00',
    });
    const karte = screen.getByRole('region', { name: 'Worauf Ihr Plan achtet' });
    expect(karte.textContent).toContain('Dynamischer Tarif: Ihr Strompreis folgt der Börse.');
    // Die Erklärung der Berechnung wohnt im Info-Knopf am Titel.
    expect(karte.textContent).not.toContain('Der Optimierer rechnet');
    fireEvent.click(within(karte).getByRole('button', { name: 'Erklärung anzeigen' }));
    expect(screen.getByText('Der Optimierer rechnet alle 15 Minuten.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Alle Werte im Diagramm/ }));
    expect(onAlleWerte).toHaveBeenCalled();
    // Am Telefon läuft der Stand am Ende des Kopfsatzes mit (E9: keine eigene Zeile).
    expect(document.querySelector('.vp-tb-titel .vp-tb-stand-mit')?.textContent).toBe('Plan von 14:00 Uhr');
    expect(document.querySelector('p.vp-tb-stand')).toBeNull();
  });

  it('hat ohne treibenden Preis (fester Tarif) keine Preiszelle und vier Einführungsschritte', async () => {
    // Fester Bezug ohne Vermarktung: den ganzen Tag 25 ct - der Preis erklärt nichts.
    const flach = tagSlots().map((s) => ({ ...s, importPriceCtKwh: 25 }));
    const fest = tagModell({ slots: flach, slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch', tarifArt: 'fest' });
    zeichnen({ tag: fest, slotFuerWarum: (i) => fest.slots[i] ?? null });
    const werte = screen.getByRole('group', { name: 'Werte am Zeiger' });
    expect([...werte.querySelectorAll('.vp-tb-werte-k')].map((k) => k.textContent)).toEqual(['Sonne', 'Speicher', 'Ladestand']);
    fireEvent.click(screen.getByRole('button', { name: 'Die Uhr erklären' }));
    expect(screen.getByText(/Die Uhr erklärt · 1 von 4/)).toBeInTheDocument();
  });

  it('trägt am Rechner das Jetzt-Band: was geschieht, warum, Zustand und Eingreifen', () => {
    breite(1100);
    const held = {
      tone: 'ok',
      status: 'Läuft wie vorgesehen — nichts zu tun',
      lead: 'Ihre Batterie lädt gerade',
      value: `2,2${NBSP}kW`,
      valueNote: 'in den Speicher',
      valueMissing: null,
      adjust: null,
      flowConflict: null,
      flowConflictSeverity: null,
      why: 'Günstigster Strom des restlichen Tages.',
      chips: [],
      confirm: 'vom Wechselrichter bestätigt · geprüft vor 8 Sek.',
      curtailment: null,
      badgeArt: 'gemessen',
      badgeNote: null,
    } as unknown as Parameters<typeof FahrplanTagesbild>[0]['held'];
    const rollen = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const { container } = zeichnen({ held });
    const band = container.querySelector('.vp-tb-band')!;
    expect(band.textContent).toContain('Jetzt · 14:10');
    expect(band.textContent).toContain('Ihre Batterie lädt gerade');
    expect(band.textContent).toContain(`2,2${NBSP}kW in den Speicher · vom Wechselrichter bestätigt`);
    expect(band.textContent).toContain('Läuft wie vorgesehen');
    expect(band.querySelector('a')).toHaveAttribute('href', '#/anlage/s1/steuerung');
    fireEvent.click(screen.getByRole('button', { name: /Warum\? Günstigster Strom/ }));
    expect(rollen.mock.contexts).toContain(screen.getByRole('region', { name: 'Die Waage' }));
    // Eine andere Viertelstunde: das Band spricht über ihren Plan, rechts der Weg zurück.
    fireEvent.keyDown(screen.getByRole('slider', { name: /Bildfahrplan/ }), { key: 'ArrowRight' });
    expect(band.textContent).toContain('14:15–14:30 Uhr · geplant');
    expect(band.querySelector('.vp-tb-zurueck')).toBeTruthy();
    // Kein zweites Diagramm und kein Aufklapper neben dem Bild.
    expect(container.textContent).not.toContain('Mehr erklären');
  });
});
