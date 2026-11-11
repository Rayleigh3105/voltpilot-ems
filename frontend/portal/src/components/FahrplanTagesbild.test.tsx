import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JetztHeldView } from '../fahrplanJetzt';
import { tagModell, type TagSlot } from '../fahrplanTag';
import { NBSP } from '../format';
import { haptikZuruecksetzen } from '../haptik';
import { speicherAussage } from '../speicherAussage';
import { FahrplanTagesbild } from './FahrplanTagesbild';

/**
 * Das TAGESBILD als Bauteil (Überblick 20.10.2026, Variante A): Status-Zeile,
 * die Uhr wie am Handgelenk, Kacheln, eingeklappte Abschnitte am Telefon; am
 * Rechner Jetzt-Karte, Tagesband und die Karten darunter. Die Aussagen selbst
 * sind in den reinen Modulen getestet; hier geht es um das Zusammenspiel.
 */

const TAG = new Date(2026, 8, 24);
const JETZT = new Date(2026, 8, 24, 14, 10);
const MORGEN = new Date(2026, 8, 25);

function viertel(start: Date, i: number, over: Partial<TagSlot> = {}): TagSlot {
  return {
    start: new Date(start.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: 28,
    importPriceCtKwh: 30,
    exportValueCtKwh: 8,
    pvKw: 0,
    loadKw: 0.5,
    ...over,
  };
}

function slots(start: Date, laeufe: [string, number][]): TagSlot[] {
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) {
      const i = out.length;
      out.push(
        viertel(start, i, {
          slotRole: rolle,
          batteryKw: rolle === 'guenstig_laden' ? 2.2 : rolle === 'eigenverbrauch' ? -1.2 : 0,
          socPct: 40 + i / 4,
          importPriceCtKwh: rolle === 'guenstig_laden' ? 19.3 : 30,
        }),
      );
    }
  }
  return out;
}

/** 00:00 Warten · 05:45 Verbrauch decken · 10:00 Warten · 13:30 Günstig laden · 14:30 Sonne speichern · 17:30 Verbrauch decken. */
const LAUF: [string, number][] = [
  ['warten', 23],
  ['eigenverbrauch', 17],
  ['warten', 14],
  ['guenstig_laden', 4],
  ['pv_speichern', 12],
  ['eigenverbrauch', 26],
];
const MODELL = tagModell({ slots: slots(TAG, LAUF), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
const FOLGETAG = tagModell({
  slots: slots(MORGEN, [['eigenverbrauch', 20], ['verkaufen', 8], ['warten', 68]]),
  slotMinutes: 15,
  now: JETZT,
  plantKind: 'eigenverbrauch',
  tag: MORGEN,
});

const BESTAETIGT = {
  state: 'planmaessig',
  tone: 'ok',
  lead: 'Ihre Batterie lädt gerade günstig aus dem Netz',
  value: `2,2${NBSP}kW`,
  valueNote: 'in den Speicher',
  valueMissing: null,
  adjust: null,
  status: 'Läuft wie vorgesehen',
  why: 'Günstigster Strom des restlichen Tages.',
  chips: [{ label: 'Speicher', value: `64${NBSP}%` }],
  curtailment: null,
  flowConflict: null,
  flowConflictSeverity: null,
  badgeNote: null,
} as unknown as JetztHeldView;

const NICHT_BESTAETIGT = {
  ...BESTAETIGT,
  state: 'wird_vorbereitet',
  tone: 'off',
  lead: 'Geplant ist gerade: Günstig aus dem Netz laden',
  value: null,
  status: 'Die Steuerung wird vorbereitet.',
  valueMissing: 'Noch keine aktuelle Rückmeldung Ihres Wechselrichters.',
} as unknown as JetztHeldView;

function zeichnen(over: Partial<Parameters<typeof FahrplanTagesbild>[0]> = {}) {
  const warumPanel = vi.fn((i: number) => <div data-testid="warum">Warum für {i}</div>);
  const phasenPanel = vi.fn((p: number) => <div data-testid="phase">Phase {p}</div>);
  const phasenPanelFolgetag = vi.fn((p: number) => <div data-testid="phase-morgen">Morgen-Phase {p}</div>);
  const r = render(
    <FahrplanTagesbild
      tag={MODELL}
      plantKind="eigenverbrauch"
      speicher={null}
      siteId="s1"
      slotFuerWarum={(i) => MODELL.slots[i] ?? null}
      warumPanel={warumPanel}
      phasenPanel={phasenPanel}
      phasenPanelFolgetag={phasenPanelFolgetag}
      held={BESTAETIGT}
      jetztLadestand={63.6}
      annahmen={[{ key: 'neu', icon: 'refresh-cw', titel: 'Neu geplant', text: 'Zuletzt um 14:00 Uhr.', link: null }]}
      onAlleWerte={() => undefined}
      {...over}
    />,
  );
  return { ...r, warumPanel, phasenPanel, phasenPanelFolgetag };
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { vibrate?: unknown }).vibrate;
});

describe('Telefon · der erste Blick', () => {
  it('sagt oben, wer was tut, darunter höchstens drei Stichworte - dann Uhr, Kacheln und eingeklappt der Rest', () => {
    const { container } = zeichnen();
    const status = container.querySelector('.vp-tb-status')!;
    expect(status.textContent).toContain('Speicher lädt günstig aus dem Netz');
    expect(container.querySelector('.vp-tb-status-unter')?.textContent).toBe(
      `64${NBSP}% · 2,2${NBSP}kW · ab 14:30 Sonne speichern`,
    );
    const reihe = [...container.querySelectorAll('.vp-tb-status, .vp-uhr, .vp-antw, .vp-tb-zu')].map((e) => e.classList[0]);
    expect(reihe).toEqual(['vp-tb-status', 'vp-uhr', 'vp-antw', 'vp-tb-zu']);
    // Ein ruhiges Gerät braucht keine Zeile.
    expect(container.querySelector('.vp-tb-zustand')).toBeNull();
    // Ihr Tag und Gut zu wissen sind zu, bis man sie öffnet.
    expect(container.querySelector('.vp-st')).toBeNull();
    expect(container.querySelector('.vp-annahmen')).toBeNull();
  });

  it('nennt den Gerätezustand nur, wenn das Gerät nicht dem Plan folgt - kurz, der Satz auf Tipp', () => {
    const { container } = zeichnen({ held: NICHT_BESTAETIGT, jetztLadestand: null });
    expect(container.querySelector('.vp-tb-status')?.textContent).toContain('Speicher lädt günstig aus dem Netz');
    const zeile = screen.getByRole('button', { name: /Wechselrichter bestätigt noch nicht/ });
    expect(zeile).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(zeile);
    expect(container.querySelector('.vp-tb-zustand-detail')?.textContent).toContain('Noch keine aktuelle Rückmeldung');
    expect(screen.getByRole('link', { name: /Eingreifen/ })).toHaveAttribute('href', '#/anlage/s1/steuerung');
  });

  it('zeigt eine bewusste Nachführung mit dem Plan-Wert - nie als Fehler', () => {
    zeichnen({ held: { ...BESTAETIGT, state: 'angepasst', adjust: 'Der Fahrplan sah 2,2 kW vor.' } as JetztHeldView });
    const zeile = screen.getByRole('button', { name: /Gerät führt nach · Plan 2,2/ });
    expect(zeile).toHaveClass('is-ok');
  });
});

describe('Telefon · die Uhr', () => {
  it('geht wie eine echte Uhr: der Ring zeigt, was ab jetzt kommt - auch nach Mitternacht', () => {
    const { container } = zeichnen({ folgetag: FOLGETAG });
    const uhr = screen.getByRole('group', { name: 'Die Uhr: was ab jetzt kommt' });
    const boegen = within(uhr).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(boegen[0]).toBe('14:10 bis 14:30: Günstig aus dem Netz laden. Warum?');
    expect(boegen.at(-1)).toMatch(/^17:30 bis 01:10: Verbrauch decken/);
    expect(container.querySelector('.vp-tb-uhr-unter')?.textContent).toBe('Ab jetzt bis 01:00');
    expect(container.querySelector('.vp-uhr-zeiger')).toBeTruthy();
  });

  it('öffnet das Warum einer Phase per Tipp auf ihren Bogen - am Telefon mit einem Tick', () => {
    const vibrate = vi.fn(() => true);
    telefon(vibrate);
    const { phasenPanel } = zeichnen();
    fireEvent.click(screen.getByRole('button', { name: /^14:30 bis 17:30: Sonne speichern/ }));
    expect(vibrate).toHaveBeenLastCalledWith(8);
    const blatt = screen.getByRole('dialog', { name: /Sonne speichern · 14:30–17:30/ });
    expect(within(blatt).getByTestId('phase')).toBeInTheDocument();
    expect(phasenPanel).toHaveBeenCalledWith(4, expect.any(Function));
  });

  it('nimmt für Bögen nach Mitternacht das Warum des Folgetags', () => {
    // 22 Uhr: der Ring läuft über Mitternacht in den Folgetag.
    const spaet = tagModell({
      slots: slots(TAG, [['warten', 88], ['eigenverbrauch', 8]]),
      slotMinutes: 15,
      now: new Date(2026, 8, 24, 22, 0),
      plantKind: 'eigenverbrauch',
    });
    const { phasenPanel, phasenPanelFolgetag } = zeichnen({ tag: spaet, folgetag: FOLGETAG });
    expect(screen.getByRole('button', { name: /^22:00 bis 05:00: Verbrauch decken/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^05:00 bis 07:00: Einspeisen/ }));
    expect(phasenPanelFolgetag).toHaveBeenCalledWith(1, expect.any(Function));
    expect(phasenPanel).not.toHaveBeenCalled();
    expect(screen.getByTestId('phase-morgen')).toBeInTheDocument();
  });
});

describe('Telefon · Warum, Kacheln, Abschnitte', () => {
  it('öffnet hinter der Status-Zeile EIN Blatt: Satz, Waage, Messwerte, alle Gründe', () => {
    const { container, warumPanel } = zeichnen();
    fireEvent.click(container.querySelector('button.vp-tb-status') as HTMLElement);
    const blatt = screen.getByRole('dialog', { name: 'Warum: Speicher lädt günstig aus dem Netz?' });
    expect(blatt.textContent).toContain('Günstigster Strom des restlichen Tages.');
    expect(within(blatt).getByRole('region', { name: 'Die Waage dieser Viertelstunde' })).toBeInTheDocument();
    expect(within(blatt).getByRole('button', { name: /Messwerte/ })).toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: /Alle Gründe/ }));
    expect(warumPanel).toHaveBeenCalledWith(MODELL.jetztIndex, expect.any(Function));
  });

  it('N1: wiederholt beim Warten nicht den Satz der Waage als eigenen Kopfsatz', () => {
    // Ohne Gerätezustand (held=null) ist band.warum GENAU der Waage-Satz -
    // der Kopfsatz entfällt dann, die Waage bleibt die einzige Stelle.
    const jetztWarten = new Date(TAG.getTime() + 2 * 15 * 60_000);
    const wartenSlots = slots(TAG, LAUF).map((s, i) =>
      i === 2 ? { ...s, whyNextBest: 'solar_speichern', whyNextBestMarginCt: 3.1 } : s,
    );
    const modellWarten = tagModell({ slots: wartenSlots, slotMinutes: 15, now: jetztWarten, plantKind: 'eigenverbrauch' });
    const { container } = zeichnen({
      tag: modellWarten,
      held: null,
      slotFuerWarum: (i: number) => modellWarten.slots[i] ?? null,
    });
    fireEvent.click(container.querySelector('button.vp-tb-status') as HTMLElement);
    const blatt = screen.getByRole('dialog');
    expect(container.querySelector('.vp-tb-warumblatt-satz')).toBeNull();
    const urteil = within(blatt).getByText(/wäre.*schlechter/);
    expect(urteil.className).toContain('vp-waage-urteil');
  });

  it('zeigt Heute Abend und die Geldzahl als Kacheln - der ganze Satz klappt darunter auf', () => {
    const speicher = speicherAussage(
      { range: 'day', from: TAG.toISOString(), to: MORGEN.toISOString(), savedEur: -0.2, savedSpeicherEur: -0.17, savedSteuerungEur: -0.03, steuerungSplitReason: null },
      { now: JETZT, steuerungGeplantEur: 6.39 },
    );
    const { container } = zeichnen({ speicher });
    const kacheln = screen.getByRole('list', { name: 'Antworten zum Fahrplan' });
    expect([...kacheln.querySelectorAll('.vp-antw-label')].map((e) => e.textContent)).toEqual(['Heute Abend', 'Heute geplant']);
    fireEvent.click(within(kacheln).getByRole('button', { name: /Was bringt es heute\?/ }));
    expect(container.querySelector('.vp-antw-detail')?.textContent).toContain('gegenüber demselben Speicher ohne smarte Steuerung');
    expect(screen.getByRole('link', { name: /Zu den Erlösen/ })).toHaveAttribute('href', '#/anlage/s1/erloese');
  });

  it('klappt Ihr Tag und Gut zu wissen auf - eine Station öffnet ihr Warum im Blatt', () => {
    const { container, phasenPanel } = zeichnen();
    fireEvent.click(screen.getByRole('button', { name: 'Ihr Tag' }));
    expect(container.querySelectorAll('.vp-st-halt')).toHaveLength(MODELL.phasen.length);
    fireEvent.click(container.querySelectorAll('.vp-st-zeile')[1] as HTMLElement);
    expect(phasenPanel).toHaveBeenCalledWith(1, expect.any(Function));
    expect(within(screen.getByRole('dialog', { name: /^Verbrauch decken · 05:45–10:00/ })).getByTestId('phase')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Gut zu wissen' }));
    expect(container.querySelector('.vp-annahmen')?.textContent).toContain('Neu geplant');
    expect(screen.getByRole('button', { name: /Alle Werte im Diagramm/ })).toBeInTheDocument();
  });
});

describe('Ein Tag ohne Jetzt (Tagesschalter)', () => {
  const gestern = tagModell({
    slots: slots(new Date(2026, 8, 23), LAUF),
    slotMinutes: 15,
    now: JETZT,
    plantKind: 'eigenverbrauch',
    tag: new Date(2026, 8, 23),
  });

  it('erzählt den Tag in einem Satz und zeigt die Uhr ohne Zeiger, Vor- oder Nachmittag', () => {
    const { container } = zeichnen({ tag: gestern, art: 'gestern', held: null });
    expect(container.querySelector('.vp-tb-tagsatz')?.textContent).toMatch(/^Gestern: /);
    expect(container.querySelector('.vp-tb-status')).toBeNull();
    expect(container.querySelector('.vp-uhr-zeiger')).toBeNull();
    expect(screen.getByRole('group', { name: 'Die Uhr: Vormittag · 0 bis 12 Uhr' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nachmittag' }));
    expect(screen.getByRole('group', { name: 'Die Uhr: Nachmittag · 12 bis 24 Uhr' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^13:30 bis 14:30: Günstig aus dem Netz laden/ })).toBeInTheDocument();
  });
});

describe('Rechner ab 900 px: Tagesband statt Uhr', () => {
  it('zeigt Jetzt-Karte mit drei Spalten und das Tagesband - keine Uhr', () => {
    breite(1100);
    const { container } = zeichnen();
    expect(container.querySelector('.vp-tband')).toBeTruthy();
    expect(container.querySelector('.vp-uhr')).toBeNull();
    const spalten = screen.getByRole('list', { name: 'Antworten zum Fahrplan' });
    expect([...spalten.querySelectorAll('.vp-antw-label')].map((e) => e.textContent)).toEqual(['Als Nächstes', 'Heute Abend']);
    // Am Rechner sind Ihr Tag und Gut zu wissen offen.
    expect(container.querySelector('.vp-st')).toBeTruthy();
    expect(container.querySelector('.vp-annahmen')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Eingreifen/ })).toBeInTheDocument();
  });

  it('wählt im Band eine Viertelstunde und kehrt mit Escape zu jetzt zurück', () => {
    breite(1100);
    const { container } = zeichnen();
    const band = screen.getByRole('slider', { name: /Tagesband/ });
    fireEvent.keyDown(band, { key: 'ArrowRight' });
    expect(band).toHaveAttribute('aria-valuenow', String(MODELL.jetztIndex + 1));
    expect(container.querySelector('.vp-tb-status-kopf')?.textContent).toBe('14:15–14:30 Uhr · geplant');
    expect(screen.getByRole('button', { name: /Zurück zu jetzt/ })).toBeInTheDocument();
    fireEvent.keyDown(band, { key: 'Escape' });
    expect(band).toHaveAttribute('aria-valuenow', String(MODELL.jetztIndex));
    expect(screen.queryByRole('button', { name: /Zurück zu jetzt/ })).toBeNull();
  });

  it('öffnet mit Eingabe das Warum der Phase am Band', () => {
    breite(1100);
    const { phasenPanel } = zeichnen();
    fireEvent.keyDown(screen.getByRole('slider', { name: /Tagesband/ }), { key: 'Enter' });
    expect(phasenPanel).toHaveBeenCalledWith(3, expect.any(Function));
    expect(screen.getByRole('dialog', { name: /Günstig aus dem Netz laden · 13:30–14:30/ })).toBeInTheDocument();
  });
});

describe('640–899 px: die Uhr neben dem Text', () => {
  it('stellt die Uhr links, Status, Kacheln und Abschnitte rechts', () => {
    breite(760);
    const { container } = zeichnen();
    expect(container.querySelector('.vp-tb.is-zweispaltig .vp-tb-bildspalte .vp-uhr')).toBeTruthy();
    expect(container.querySelector('.vp-tb-textspalte .vp-tb-status')).toBeTruthy();
    expect(container.querySelector('.vp-tb-textspalte .vp-tb-zu')).toBeTruthy();
  });
});
