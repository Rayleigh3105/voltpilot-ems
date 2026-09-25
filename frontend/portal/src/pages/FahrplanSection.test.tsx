import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { FahrplanSection } from './DataPages';
import type { ControlStatus, SchedulePlan, ScheduleSlot, Site, TelemetryPoint } from '../api';

/**
 * Das SEITENGERÜST der Fahrplan-Seite im Aufbau des Prototyps „Tagesuhr und
 * Bildfahrplan" (E1–E11): Warnungen → das TAGESBILD mit Kopfsatz, Uhr (in
 * jsdom ohne Breite immer die Uhr), der Zeile zum Moment (das Gerät spricht),
 * den Antworten, dem Zustand mit „Eingreifen", der Waage, den Stationen und
 * „Worauf Ihr Plan achtet". Das bisherige Diagramm öffnet sich nur als Dialog
 * „Alle Werte" - es steht nicht als zweites Bild auf der Seite. Die
 * Zustands-Vollständigkeit liegt in den reinen Modul-Tests; hier wird geprüft,
 * dass die Blöcke wirklich in dieser Ordnung stehen, dass die Seite keine
 * zweite Geldzahl gegen „ohne Speicher" nennt (E6) und dass ein Plan OHNE die
 * persistierten Warum-Fakten sauber zur bisherigen Seite degradiert (kein
 * Tagesbild, kein Film, kein erfundener Grund).
 */

vi.mock('../ScheduleChart', () => ({
  ScheduleChart: () => <div data-testid="chart" />,
}));

const controlStatus = vi.fn();
const weather = vi.fn();
const curtailmentStatus = vi.fn();
const schedule = vi.fn();
const telemetry = vi.fn();
const siteEarnings = vi.fn();
const tenantCockpitLayout = vi.fn();
const saveTenantCockpitLayout = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      schedule: (...a: unknown[]) => schedule(...a),
      controlStatus: (...a: unknown[]) => controlStatus(...a),
      curtailmentStatus: (...a: unknown[]) => curtailmentStatus(...a),
      telemetry: (...a: unknown[]) => telemetry(...a),
      // Verbrauchssteuerung §14.11: the SHADOW empty document - the section
      // must render byte-identical without consumer slots.
      consumerSchedule: () =>
        Promise.resolve({ planId: null, generatedAt: null, slotMinutes: 15, entities: [] }),
      // Erklärbarkeit Stufe 2: die „Lage"-Zeile liest das Wetter FAIL-SOFT.
      weather: (...a: unknown[]) => weather(...a),
      // Tagesbild E6: „Was bringt es heute?" liest die Tages-Erlöse FAIL-SOFT.
      siteEarnings: (...a: unknown[]) => siteEarnings(...a),
      // Tagesbild E11: die „gesehen"-Marke der Einführung.
      tenantCockpitLayout: (...a: unknown[]) => tenantCockpitLayout(...a),
      saveTenantCockpitLayout: (...a: unknown[]) => saveTenantCockpitLayout(...a),
    },
  };
});

const SITE = { id: 's1', name: 'Sonnenhof', plantKind: 'eigenverbrauch' } as unknown as Site;

/** „jetzt" liegt im ersten Slot, wie bei einem echten MPC-Lauf. */
function slot(over: Partial<ScheduleSlot> & { start: string }): ScheduleSlot {
  return {
    batteryKw: -4.3,
    gridKw: 0,
    socPct: 78,
    priceEurMwh: 212,
    costEur: 0.1,
    baselineCostEur: 0.4,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: 'eigenverbrauch',
    slotFlags: null,
    storedValueCtKwh: 21.5,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: 32.5,
    importPriceSource: 'preisblatt',
    ...over,
  } as ScheduleSlot;
}

function plan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  // Auf dem 15-Minuten-Raster wie jeder echte Lauf: „jetzt" liegt im ersten
  // Slot, und kurz nach Mitternacht beginnt er HEUTE (ein Slot „vor fünf
  // Minuten" läge dann auf gestern, und das Tagesbild kennte kein Jetzt).
  const t0 = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
  return {
    planId: 'p1',
    deviceId: 'dev-1',
    generatedAt: new Date(t0).toISOString(),
    slotMinutes: 15,
    savingsEur: 3.42,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    fallback14a: null,
    slots: Array.from({ length: 8 }, (_, i) =>
      slot({ start: new Date(t0 + i * 15 * 60_000).toISOString() }),
    ),
    ...over,
  };
}

/**
 * Was `api.schedule(id, 'day')` liefert: der GANZE Tag - vier schon gelaufene
 * Viertelstunden „Sonne speichern" vor dem jüngsten Lauf.
 */
function dayPlan(): SchedulePlan {
  const base = plan();
  const t0 = new Date(base.slots[0].start).getTime();
  const morgens = Array.from({ length: 4 }, (_, i) =>
    slot({
      start: new Date(t0 - (4 - i) * 15 * 60_000).toISOString(),
      slotRole: 'pv_speichern',
      batteryKw: 6,
    }),
  );
  return {
    ...base,
    // Die lauf-bezogenen Felder beschreiben EINEN Lauf - der Splice trägt sie
    // nicht (die api liefert sie in dieser Lesart null).
    planId: null,
    peakTargetKw: null,
    fallback14a: null,
    slots: [...morgens, ...base.slots],
  };
}

const CONTROL: ControlStatus = {
  deviceId: 'dev-1',
  commandedKw: -6.1,
  confirmedKw: -6.1,
  allMatch: true,
  controlEnabled: true,
  certified: true,
  mismatchRoles: null,
  slotStart: null,
  checkedAt: new Date().toISOString(),
};

const POINTS: TelemetryPoint[] = [
  {
    ts: new Date().toISOString(),
    powerKw: 0,
    socPct: 78,
    pvPowerKw: 1,
    loadKw: 7.1,
    gridLimitKw: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  schedule.mockResolvedValue(plan());
  controlStatus.mockResolvedValue(CONTROL);
  // Ohne Abregel-Beleg (204) - die Fläche bleibt beim Plan-Wortlaut.
  curtailmentStatus.mockResolvedValue(null);
  telemetry.mockResolvedValue(POINTS);
  // Ohne Vorhersage (der Normalfall der übrigen Fälle) fehlt nur das
  // Himmels-Wort - die Seite bleibt sonst zeichengleich.
  weather.mockResolvedValue({ runAt: null, points: [] });
  // Ohne Tages-Erlöse (älteres Backend) entfällt nur „Was bringt es heute?".
  siteEarnings.mockRejectedValue(new Error('404'));
  tenantCockpitLayout.mockResolvedValue({ vorgabe: null, eigen: null });
  saveTenantCockpitLayout.mockResolvedValue(undefined);
});

describe('FahrplanSection · das Seitengerüst', () => {
  it('beantwortet „was macht meine Batterie gerade" direkt unter der Uhr, die Antworten folgen', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb .vp-tb-moment')).toBeTruthy());
    // Aufbau des Prototyps: Kopfsatz, Uhr, Moment, Antworten, Zustand - die
    // Jetzt-Aussage steht nicht mehr als eigene Karte über oder unter dem Bild.
    expect(container.querySelector('.vp-kompakt')).toBeNull();
    const reihe = [...container.querySelectorAll('.vp-tb-kopf, .vp-uhr, .vp-tb-moment, .vp-antw, .vp-tb-todo')].map(
      (b) => b.classList[0],
    );
    expect(reihe).toEqual(['vp-tb-kopf', 'vp-uhr', 'vp-tb-moment', 'vp-antw', 'vp-tb-todo']);
    // Die zwei Wahrheiten im Standard-Scroll: Ausführung (Rücklesen) statt
    // Plan-Watt, und der Plan bleibt sichtbar daneben.
    await waitFor(() => expect(container.querySelector('.vp-tb-moment')?.textContent).toMatch(/6,1/));
    expect(screen.getByText(/Fahrplan sah/)).toBeInTheDocument();
    // Die Zahlen des Warum stehen auf der Waage. Der Bezug ist den ganzen Tag
    // 32,5 ct - flach, also erklärt er nichts und hat keine Preiszelle.
    expect(screen.getByRole('region', { name: 'Die Waage' }).textContent).toContain('32,5');
    expect(container.querySelector('.vp-tb-werte')?.textContent).not.toContain('32,5');
    // Keine KPI-Reihe, KEINE Geldzahl gegen „ohne Speicher" (E6) und kein
    // Aufklapper „Mehr erklären" neben dem Tagesbild.
    expect(container.querySelector('.vp-kpis')).toBeNull();
    expect(screen.queryByRole('button', { name: /Mehr erklären/ })).toBeNull();
    expect(screen.queryByText(/Heute geplant:/)).toBeNull();
    expect(container.textContent).not.toContain('ohne Speicher');
  });

  it('zeigt das bisherige Diagramm nur als Dialog „Alle Werte" - mit den kWh-Summen', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-uhr')).toBeTruthy());
    // Kein zweites Bild desselben Tages auf der Seite; das Diagramm entsteht
    // erst beim Öffnen (ECharts misst sonst 0 × 0).
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByText(/geplantes Laden/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Alle Werte im Diagramm/ }));
    const dialog = screen.getByRole('dialog', { name: 'Alle Werte im Diagramm' });
    expect(within(dialog).getByTestId('chart')).toBeInTheDocument();
    expect(within(dialog).getByText(/geplantes Laden/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('degradiert ohne persistierte Warum-Fakten: kein Film, kein erfundener Grund', async () => {
    schedule.mockResolvedValue(
      plan({
        slots: plan().slots.map((s) => ({ ...s, slotRole: null, storedValueCtKwh: null })),
      }),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-kompakt')).toBeTruthy());
    expect(screen.queryByText(/32,5 ct\/kWh/)).toBeNull();
    // ...das Diagramm und die Euro-Lesart (in „Mehr erklären") bleiben.
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Mehr erklären/ }));
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
    // In „Mehr erklären" steht kein Film.
    expect(container.querySelector('.vp-film')).toBeNull();
  });

  it('bleibt ohne Rücklesen ehrlich: „—" mit Grund statt einer erfundenen Zahl', async () => {
    controlStatus.mockResolvedValue(null);
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb-moment-zahl')?.textContent).toMatch(/^—/));
    expect(container.querySelector('.vp-tb-moment-zahl')?.textContent).toMatch(/Rückmeldung/);
    expect(screen.queryByText(/6,1/)).toBeNull();
  });

  it('überlebt einen Ausfall der beiden Live-Abrufe (fail-soft)', async () => {
    controlStatus.mockRejectedValue(new Error('down'));
    curtailmentStatus.mockRejectedValue(new Error('down'));
    telemetry.mockRejectedValue(new Error('down'));
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb .vp-tb-moment')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Alle Werte im Diagramm/ }));
    expect(screen.getByText(/geplantes Laden/)).toBeInTheDocument();
  });
});

/**
 * Die Abregel-Wahrheit erreicht die Fläche (PR 3): der WARN-Konflikt bleibt
 * sichtbar (Status-Slot), der GRÜNE Ausführungs-Beleg der Stufe 3 wohnt ruhig
 * im „Warum & Messwerte"-Aufklapper des Helden.
 */
describe('FahrplanSection · die Abregel-Wahrheit erreicht die Fläche (PR 3)', () => {
  /** Der laufende Slot regelt ab, die Anlage speist messbar 16,6 kW ein. */
  function abregelnPlan(): SchedulePlan {
    const base = plan();
    return {
      ...base,
      slots: base.slots.map((s, i) =>
        i === 0 ? { ...s, slotRole: 'abregeln', batteryKw: 0, curtailKw: 12, priceEurMwh: -21 } : s,
      ),
    };
  }
  const EXPORTING: TelemetryPoint[] = [
    { ts: new Date().toISOString(), powerKw: -16.6, socPct: 78, pvPowerKw: 23.9, loadKw: 4.3, gridLimitKw: null },
  ];

  beforeEach(() => {
    schedule.mockResolvedValue(abregelnPlan());
    controlStatus.mockResolvedValue({ ...CONTROL, commandedKw: 0, confirmedKw: 0 });
    telemetry.mockResolvedValue(EXPORTING);
  });

  it('nennt ohne Block die zwei Möglichkeiten (Stufe 1 - älteres Backend/Edge)', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt-conflict')).toBeTruthy());
    expect(container.querySelector('.vp-jetzt-conflict')!.textContent).toContain(
      'noch nicht freigegeben oder nicht bestätigt',
    );
    // K10: die Warnung steht GENAU EINMAL und ÜBER dem Tagesbild, nie in
    // einem Aufklapper.
    expect(container.querySelectorAll('.vp-jetzt-conflict')).toHaveLength(1);
    const reihe = [...container.querySelectorAll('.vp-jetzt-conflict, .vp-uhr')].map((e) =>
      e.classList.contains('vp-uhr') ? 'uhr' : 'warnung',
    );
    expect(reihe).toEqual(['warnung', 'uhr']);
  });

  it('nennt mit Block die ECHTE Ursache (Stufe 2 - die Pilsting-Lage)', async () => {
    curtailmentStatus.mockResolvedValue({
      deviceId: 'dev-1',
      units: 2,
      certifiedUnits: 0,
      controlEnabled: true,
      active: false,
      appliedCapKw: null,
      allMatch: null,
      possibleOverride: false,
      checkedAt: new Date().toISOString(),
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() =>
      expect(container.querySelector('.vp-jetzt-conflict')?.textContent).toContain(
        '0 von 2 Wechselrichtern freigegeben',
      ),
    );
  });

  it('bestätigt mit Block die Ausführung im Aufklapper (Stufe 3) - und warnt dann nicht mehr', async () => {
    curtailmentStatus.mockResolvedValue({
      deviceId: 'dev-1',
      units: 2,
      certifiedUnits: 2,
      controlEnabled: true,
      active: true,
      appliedCapKw: 12.5,
      allMatch: true,
      possibleOverride: false,
      checkedAt: new Date().toISOString(),
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    // Die Leitzeile (Status) darf jetzt Gegenwart sagen - sie steht im
    // Standard-Scroll.
    await waitFor(() => expect(container.textContent).toContain('pausiert gerade die Einspeisung'));
    expect(container.querySelector('.vp-jetzt-conflict')).toBeNull();
    // Der grüne Ausführungs-Beleg wohnt ruhig im Aufklapper „Messwerte".
    // (Bewusst auf die BEGRENZUNG geprüft: „vom Wechselrichter bestätigt" sagt
    // auch die Rücklese-Zeile des Batterie-Sollwerts - die Zahl unterscheidet.)
    expect(container.textContent).not.toContain('Die Einspeisung ist auf 12,5');
    fireEvent.click(screen.getByRole('button', { name: /Messwerte/ }));
    expect(container.textContent).toContain('Die Einspeisung ist auf 12,5');
  });
});

/**
 * Der Tages-Splice: die STATIONEN erzählen den GANZEN Tag - die gelaufenen
 * Phasen abgehakt und ehrlich als PLAN, nie als Ist. Sie stehen offen im
 * Tagesbild; fällt die neue Lesart aus, beginnt der Tag beim jüngsten Lauf.
 */
describe('FahrplanSection · die Stationen zeigen den ganzen Tag', () => {
  beforeEach(() => {
    schedule.mockImplementation((_id: unknown, mode?: unknown) =>
      Promise.resolve(mode === 'day' ? dayPlan() : plan()),
    );
  });

  it('holt den ganzen Tag und hakt die gelaufenen Phasen ab', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelectorAll('.vp-st-halt.is-vorbei')).toHaveLength(1));
    // Die laufende Station trägt „Jetzt", der Vormittag steht abgehakt davor.
    expect(container.querySelector('.vp-st-halt.is-jetzt .vp-st-jetzt')?.textContent).toBe('Jetzt');
    expect(container.querySelector('.vp-st-halt.is-vorbei')?.textContent).toContain('Sonne speichern');
    // Die zweite Lesart wurde wirklich angefragt - und die alte daneben auch.
    expect(schedule).toHaveBeenCalledWith('s1', 'day');
    expect(schedule).toHaveBeenCalledWith('s1');
  });

  it('sagt, dass die abgehakten Phasen der PLAN sind - und verweist auf die Messwerte', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-st-halt.is-vorbei')).toBeTruthy());
    const karte = screen.getByRole('region', { name: 'Der Tag in Stationen' });
    expect(karte.textContent).toContain('Vergangenes ist der Plan, der damals galt');
    // Ein Abzeichen für die ganze Karte: hier stehen nur geplante Zahlen.
    expect(within(karte).getByText('Geplant')).toBeInTheDocument();
    expect(within(karte).getByRole('link', { name: 'Messwerte' })).toHaveAttribute(
      'href',
      '#/anlage/s1/messwerte',
    );
  });

  it('öffnet das Erklär-Panel einer VERGANGENEN Phase an ihrer Station', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelectorAll('.vp-st-halt.is-vorbei')).toHaveLength(1));
    const done = container.querySelector('.vp-st-halt.is-vorbei .vp-st-zeile') as HTMLElement;
    fireEvent.click(done);
    // Das Panel gehört zur GANZTAGES-Liste (sonst zeigte der Index in die
    // Slots des jüngsten Laufs und erklärte die falsche Phase).
    const panel = container.querySelector('.vp-st-halt.is-vorbei .vp-fw-panel');
    expect(panel).toBeTruthy();
    // Das Panel spricht das volle Vokabular (die Liste die Kurzform) - und es
    // beschreibt die VIER Vormittags-Viertelstunden, die nur in der
    // Ganztages-Liste stehen.
    expect(panel?.textContent).toContain('PV-Überschuss speichern');
    expect(panel?.textContent).toContain('4 Viertelstunden');
  });

  it('fällt ohne die neue Lesart exakt auf den Rest des Tages zurück', async () => {
    // Eine ältere api kennt `mode` nicht und antwortet mit 400.
    schedule.mockImplementation((_id: unknown, mode?: unknown) =>
      mode === 'day' ? Promise.reject(new Error('400')) : Promise.resolve(plan()),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-st')).toBeTruthy());
    expect(container.querySelectorAll('.vp-st-halt.is-vorbei')).toHaveLength(0);
    // Der Tag beginnt beim jüngsten Lauf, die laufende Station führt.
    expect(container.querySelector('.vp-st-halt')?.classList.contains('is-jetzt')).toBe(true);
    expect(container.querySelector('.vp-st-halt.is-jetzt .vp-st-jetzt')?.textContent).toBe('Jetzt');
    expect(container.querySelector('.vp-tb')).toBeTruthy();
  });

  it('nutzt den Splice nur, wenn er die Warum-Ebene vollständig trägt', async () => {
    // Ein Vormittags-Slot ohne Rolle (älterer Lauf) macht die Ganztages-Liste
    // unerklärbar - dann lieber die geprüfte Rest-des-Tages-Fassung als eine
    // halbe Erzählung.
    schedule.mockImplementation((_id: unknown, mode?: unknown) => {
      if (mode !== 'day') return Promise.resolve(plan());
      const d = dayPlan();
      return Promise.resolve({
        ...d,
        slots: d.slots.map((s, i) => (i === 0 ? { ...s, slotRole: null } : s)),
      });
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-st')).toBeTruthy());
    expect(container.querySelectorAll('.vp-st-halt.is-vorbei')).toHaveLength(0);
    expect(container.querySelector('.vp-st-halt')?.classList.contains('is-jetzt')).toBe(true);
  });
});

/**
 * ERKLÄRBARKEIT STUFE 2 „Die Lage": Tages-Bogen und Morgen-Ausblick stehen im
 * Tagesbild unter „Worauf Ihr Plan achtet" (Zeilen „Der Tag" und „Morgen"),
 * permanent sichtbar. Die Regel-Vollständigkeit liegt in `fahrplanLage.test.ts`;
 * hier wird geprüft, dass sie am richtigen Ort steht, ihre Fakten wirklich aus
 * dem geladenen Plan zieht und ohne sie ersatzlos verschwindet.
 */
describe('FahrplanSection · die Lage in „Worauf Ihr Plan achtet"', () => {
  const annahmen = () => screen.getByRole('region', { name: 'Worauf Ihr Plan achtet' });
  const HEUTE = new Date();

  /** Ein GANZER heutiger Tag mit Mittagstal - Zeitzonen-unabhängig gebaut. */
  function talPlan(): SchedulePlan {
    const base = plan();
    const slots = [];
    for (let h = 0; h < 24; h++) {
      for (let q = 0; q < 4; q++) {
        const start = new Date(
          HEUTE.getFullYear(),
          HEUTE.getMonth(),
          HEUTE.getDate(),
          h,
          q * 15,
        );
        const mittags = h >= 11 && h < 16;
        const rand = (h >= 6 && h < 11) || (h >= 16 && h < 22);
        slots.push(
          slot({
            start: start.toISOString(),
            priceEurMwh: mittags ? 140 : rand ? 206 : 180,
            batteryKw: mittags ? 8 : rand ? -6 : 0,
          }),
        );
      }
    }
    return { ...base, slots };
  }

  /** Ein Lauf, der bis morgen Abend reicht - mit den Prognosen von morgen. */
  function mitMorgen(): SchedulePlan {
    const base = talPlan();
    const morgen = [];
    for (let h = 0; h < 21; h++) {
      for (let q = 0; q < 4; q++) {
        const start = new Date(
          HEUTE.getFullYear(),
          HEUTE.getMonth(),
          HEUTE.getDate() + 1,
          h,
          q * 15,
        );
        const tag = h >= 8 && h < 17;
        morgen.push(
          slot({ start: start.toISOString(), pvKw: tag ? 0.6 : 0, loadKw: 1, batteryKw: 0 }),
        );
      }
    }
    return { ...base, slots: [...base.slots, ...morgen] };
  }

  it('steht im Tagesbild unter den Stationen und erzählt den Tages-Bogen', async () => {
    schedule.mockResolvedValue(talPlan());
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(annahmen().textContent).toContain('mittags am günstigsten'));
    expect(annahmen().textContent).toContain('Der Tag:');
    // Am Telefon (jsdom misst keine Breite): Uhr → Antworten → Stationen → Annahmen.
    const reihe = [...container.querySelectorAll('.vp-uhr, .vp-antw, .vp-st, .vp-annahmen')].map((b) => b.classList[0]);
    expect(reihe).toEqual(['vp-uhr', 'vp-antw', 'vp-st', 'vp-annahmen']);
    // Keine zweite Lage-Zeile über dem Bild.
    expect(container.querySelector('.vp-lage')).toBeNull();
  });

  it('nennt den Morgen-Ausblick mit dem Wetter-Wort - und wie oft neu geplant wird', async () => {
    schedule.mockResolvedValue(mitMorgen());
    weather.mockResolvedValue({
      runAt: null,
      points: Array.from({ length: 12 }, (_, i) => ({
        ts: new Date(
          HEUTE.getFullYear(),
          HEUTE.getMonth(),
          HEUTE.getDate() + 1,
          7 + i,
        ).toISOString(),
        temperatureC: null,
        cloudCoverPct: 96,
        ghiWM2: null,
        dniWM2: null,
        dhiWM2: null,
      })),
    });
    render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(annahmen().textContent).toContain('Solar-Überschuss'));
    const morgen = [...annahmen().querySelectorAll('li')].find((li) => li.textContent?.startsWith('Morgen:'));
    expect(morgen?.textContent).toContain('kaum Sonne');
    // Dass der Plan alle 15 Minuten neu rechnet, steht in derselben Karte.
    expect(annahmen().textContent).toContain('alle 15 Minuten neu');
  });

  it('verschwindet ersatzlos, wenn der Lauf nichts Belegtes trägt', async () => {
    // Kein Preisbogen, keine Prognosen, und der Horizont reicht bis morgen -
    // also gibt es weder einen Bogen noch einen Ausblick noch den Horizont-Satz.
    const nackt = mitMorgen();
    schedule.mockResolvedValue({
      ...nackt,
      slots: nackt.slots.map((s) => ({ ...s, priceEurMwh: null, pvKw: null, loadKw: null })),
    });
    render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(annahmen()).toBeTruthy());
    expect(annahmen().textContent).not.toContain('Der Tag:');
    expect(annahmen().textContent).not.toContain('Morgen:');
  });

  it('überlebt einen Ausfall des Wetter-Abrufs (fail-soft)', async () => {
    schedule.mockResolvedValue(talPlan());
    weather.mockRejectedValue(new Error('down'));
    render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(annahmen().textContent).toContain('mittags am günstigsten'));
    expect(annahmen().textContent).not.toContain('Wettervorhersage');
  });
});

describe('P7 · eine Anlage ohne Ladestand', () => {
  /**
   * Der Lauf, den der Optimierer für einen Deye im Spannungsmodus schreibt:
   * `socSource: 'unbekannt'`, lauter 0-kW-Balken, keine SoC-Bahn, keine
   * Baseline - also auch keine Ersparnis. Genau so kommt er aus der api.
   */
  function ohneLadestand(): SchedulePlan {
    const base = plan();
    return {
      ...base,
      socSource: 'unbekannt',
      savingsEur: null,
      slots: base.slots.map((s) => ({
        ...s,
        batteryKw: 0,
        socPct: null,
        baselineCostEur: null,
        slotRole: 'warten',
      })),
    };
  }

  it('nennt den Grund, statt die leeren Balken unerklärt zu lassen', async () => {
    schedule.mockResolvedValue(ohneLadestand());
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    expect(container.textContent).toContain('meldet derzeit keinen Ladestand');
    expect(container.textContent).toContain('weist für ihn auch keine Ersparnis aus');
  });

  it('weist KEINE Speicher-Ersparnis aus - und sagt nicht "kein Fahrplan"', async () => {
    schedule.mockResolvedValue(ohneLadestand());
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    // Keine Euro-Zahl: weder eine erfundene 0,00 € noch irgendeine andere.
    expect(container.querySelector('.vp-fp-euro')).toBeNull();
    // Und NICHT der Leer-Satz: es GIBT einen Fahrplan, er plant nur den
    // Speicher nicht - „kein Fahrplan" wäre hier die zweite Unwahrheit.
    expect(container.textContent).not.toContain('Für heute liegt noch kein Fahrplan vor');
  });

  it('lässt eine Anlage MIT Ladestand unverändert', async () => {
    schedule.mockResolvedValue(plan());
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-uhr')).toBeTruthy());
    expect(container.textContent).not.toContain('meldet derzeit keinen Ladestand');
    // Die Mitte der Uhr trägt den geplanten Ladestand am Zeiger.
    expect(container.querySelector('.vp-uhr-m2')?.textContent).toBe('78\u00a0%');
  });

  it('liest einen Lauf VOR der Spalte wie gemessen, nie wie "kein Ladestand"', async () => {
    // socSource fehlt (älterer Lauf / ältere api) - die Seite darf ihm nicht
    // rückwirkend unterstellen, er habe ohne Ladestand geplant.
    schedule.mockResolvedValue({ ...plan(), socSource: undefined });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    expect(container.textContent).not.toContain('meldet derzeit keinen Ladestand');
  });
});


/**
 * Konzept „Tagesuhr und Bildfahrplan" (Rückmeldung 25.09.2026: „zwei doppelte
 * Diagramme"): neben dem Tagesbild steht kein zweites Bild desselben Tages,
 * kein Film „Der ganze Tag", kein „Mehr erklären" und keine Vorteil-Karte
 * gegen „ohne Speicher" (E6). Die Geldzahl der Seite ist die Antwort „Was
 * bringt es heute?".
 */
describe('FahrplanSection · keine Karte wiederholt eine andere (E6, E9)', () => {
  it('zeigt neben dem Tagesbild weder Diagramm noch Film noch Aufklapper', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    expect(screen.queryByText('Ihr Vorteil')).toBeNull();
    expect(container.querySelector('section.vp-fp-vorteil')).toBeNull();
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(container.querySelector('.vp-film')).toBeNull();
    expect(screen.queryByText('Der ganze Tag')).toBeNull();
    expect(screen.queryByRole('button', { name: /Mehr erklären/ })).toBeNull();
    // Alles, was das Tagesbild zeigt, steht IN ihm - keine Karte daneben.
    expect(container.querySelectorAll('.vp-tb')).toHaveLength(1);
  });
});

/**
 * Das TAGESBILD auf der Seite (Konzept „Tagesuhr und Bildfahrplan"): es liest
 * dieselben Listen wie der Film, die Geld-Antwort kommt aus der Erlöse-Welt
 * (E6), und das Warum einer Viertelstunde öffnet dasselbe Erklär-Panel wie
 * bisher - aus dem JÜNGSTEN Lauf, wenn er die Viertelstunde trägt.
 */
describe('FahrplanSection · das Tagesbild', () => {
  it('beantwortet „Was bringt es heute?" mit der Steuerungs-Aussage des Tages (E6)', async () => {
    const heute = new Date();
    const morgen = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + 1);
    siteEarnings.mockResolvedValue({
      range: 'day',
      from: new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()).toISOString(),
      to: morgen.toISOString(),
      savedEur: 1.25,
      savedSpeicherEur: 0.85,
      savedSteuerungEur: 0.4,
      steuerungSplitReason: null,
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(screen.getByText('Was bringt es heute?')).toBeInTheDocument());
    const karte = screen.getByText('Was bringt es heute?').closest('li')!;
    expect(karte.textContent).toContain('0,40');
    expect(karte.textContent).toContain('Gemessen');
    // Der volle Satz steht nach dem Tipp im Banner - mit dem Weg zu den Erlösen.
    fireEvent.click(screen.getByRole('button', { name: /Was bringt es heute\?/ }));
    const banner = container.querySelector('.vp-tb-antwort')!;
    expect(banner.textContent).toContain('demselben Speicher ohne smarte Steuerung');
    expect(screen.getByRole('link', { name: /Zu den Erlösen/ })).toHaveAttribute('href', '#/anlage/s1/erloese');
    expect(siteEarnings).toHaveBeenCalledWith('s1', 'day', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(container.textContent).not.toContain('ohne Speicher gegenüber');
  });

  it('lässt nur diese Antwort weg, wenn die Erlöse fehlen - auch bei einer api ohne die Methode', async () => {
    siteEarnings.mockImplementation(() => {
      throw new TypeError('api.siteEarnings is not a function');
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    expect(screen.getByText('Wie geht es weiter?')).toBeInTheDocument();
    expect(screen.queryByText('Was bringt es heute?')).toBeNull();
  });

  it('öffnet das Warum der laufenden Viertelstunde aus dem jüngsten Lauf', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-tb')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Alle Gründe/ }));
    const panel = screen.getByRole('dialog', { name: 'Erklärung der Viertelstunde' });
    // Der Lauf-Satz der laufenden Viertelstunde: 32,5 ct Bezug gegen 21,5 ct
    // gespeicherten Wert - dieselbe Aussage wie das bisherige Slot-Panel.
    expect(panel.textContent).toContain('32,5');
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog', { name: 'Erklärung der Viertelstunde' })).toBeNull();
  });

  it('nennt in den Stationen keine Phasen-Beträge gegen „ohne Speicher" (E6)', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-st')).toBeTruthy());
    expect(container.querySelector('.vp-st')?.textContent).not.toMatch(/€/);
    fireEvent.click(container.querySelector('.vp-st-zeile') as HTMLElement);
    const panel = container.querySelector('.vp-st .vp-fw-panel');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).not.toContain('Beitrag dieser Phase');
  });

  it('zeigt die Stationen des Tages offen im Tagesbild, unter den Antworten', async () => {
    schedule.mockImplementation((_id: unknown, mode?: unknown) =>
      Promise.resolve(mode === 'day' ? dayPlan() : plan()),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelectorAll('.vp-st-halt.is-vorbei')).toHaveLength(1));
    const reihe = [...container.querySelectorAll('.vp-antw, .vp-st')].map((e) => e.classList[0]);
    expect(reihe).toEqual(['vp-antw', 'vp-st']);
    expect(container.querySelector('.vp-tb')?.contains(container.querySelector('.vp-st'))).toBe(true);
  });
});

/**
 * Der TAGESSCHALTER (Konzept „Tagesuhr und Bildfahrplan", E2 = A; Wunsch vom
 * 25.09.2026 „gestern anschauen und morgen wie beim Prototyp"): gestern ist
 * der Tages-Splice des Vortags (`mode=day&date=`), morgen der jüngste Lauf ab
 * Mitternacht. Nur heute spricht das Gerät; gestern nennt, was der ganze Tag
 * gebracht hat, morgen keine Geldzahl.
 */
describe('FahrplanSection · der Tagesschalter (E2 = A)', () => {
  const lokal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const heute0 = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const vortag0 = () => {
    const h = heute0();
    return new Date(h.getFullYear(), h.getMonth(), h.getDate() - 1);
  };
  const folgetag0 = () => {
    const h = heute0();
    return new Date(h.getFullYear(), h.getMonth(), h.getDate() + 1);
  };
  /** Ein ganzer Tag ab `tag0`: Warten, mittags Sonne speichern, abends Verbrauch decken. */
  function ganzerTag(tag0: Date): ScheduleSlot[] {
    const rollen: [string, number][] = [
      ['warten', 40],
      ['pv_speichern', 20],
      ['warten', 12],
      ['eigenverbrauch', 20],
      ['warten', 4],
    ];
    const out: ScheduleSlot[] = [];
    for (const [rolle, n] of rollen) {
      for (let k = 0; k < n; k++) {
        out.push(
          slot({
            start: new Date(tag0.getTime() + out.length * 15 * 60_000).toISOString(),
            slotRole: rolle,
            batteryKw: rolle === 'pv_speichern' ? 3 : rolle === 'eigenverbrauch' ? -2 : 0,
          }),
        );
      }
    }
    return out;
  }
  /** Der jüngste Lauf, strikt auf heute beschnitten - morgen ist noch nicht geplant. */
  const nurHeute = () => {
    const p = plan();
    return { ...p, slots: p.slots.filter((s) => lokal(new Date(s.start)) === lokal(heute0())) };
  };
  const GELD_GESTERN = {
    range: 'day',
    from: vortag0().toISOString(),
    to: heute0().toISOString(),
    savedEur: 2.1,
    savedSpeicherEur: 1.4,
    savedSteuerungEur: 0.7,
    steuerungSplitReason: null,
  };

  it('steht über dem Tagesbild - der Seitenkopf ist unsichtbar wie bei Preise und Wetter', async () => {
    schedule.mockImplementation(() => Promise.resolve(nurHeute()));
    render(<FahrplanSection site={SITE} />);
    const schalter = await screen.findByRole('tablist', { name: 'Tag' });
    const reiter = within(schalter).getAllByRole('tab');
    expect(reiter.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Gestern/),
      expect.stringMatching(/^Heute/),
      expect.stringMatching(/^Morgen(ab ca\. 13 Uhr|noch kein Plan)$/),
    ]);
    expect(reiter[1]).toHaveAttribute('aria-selected', 'true');
    // Die Überschrift bleibt für Screenreader und Dokumentstruktur.
    const h1 = screen.getByRole('heading', { level: 1, name: 'Fahrplan' });
    expect(h1).toHaveClass('vp-sr-only');
  });

  it('zeigt gestern den Plan, wie er galt - und was der ganze Tag gebracht hat', async () => {
    const gesternIso = lokal(vortag0());
    schedule.mockImplementation((_id: unknown, mode?: unknown, date?: unknown) =>
      Promise.resolve(
        date === gesternIso
          ? { ...plan(), planId: null, slots: ganzerTag(vortag0()) }
          : mode === 'day'
            ? dayPlan()
            : plan(),
      ),
    );
    siteEarnings.mockImplementation((_id: unknown, _r: unknown, at: unknown) =>
      at === gesternIso ? Promise.resolve(GELD_GESTERN) : Promise.reject(new Error('404')),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Gestern/ }));
    await waitFor(() => expect(container.querySelector('.vp-tb-titel')?.textContent).toMatch(/^Gestern:/));
    expect(schedule).toHaveBeenCalledWith('s1', 'day', gesternIso);
    expect(siteEarnings).toHaveBeenCalledWith('s1', 'day', gesternIso);
    const antworten = screen.getByRole('list', { name: 'Antworten zum Fahrplan' });
    await waitFor(() => expect(within(antworten).getByText('Was hat es gebracht?')).toBeInTheDocument());
    expect(within(antworten).getByText('Wie ging es weiter?')).toBeInTheDocument();
    // „Hat er gereicht?" weiß nur die Messung - die Frage bleibt aus.
    expect(within(antworten).queryByText(/Reicht der Speicher/)).toBeNull();
    // Die Uhr nennt den Tag; das Gerät spricht nur über jetzt.
    expect(container.querySelector('.vp-uhr-m1')?.textContent).toMatch(/^gestern · /i);
    expect(screen.queryByRole('link', { name: /Eingreifen/ })).toBeNull();
    // Die Annahmen beschreiben den Plan von JETZT - nicht den von gestern.
    expect(screen.queryByRole('region', { name: 'Worauf Ihr Plan achtet' })).toBeNull();
    // Zurück auf heute: alles wie vorher.
    fireEvent.click(screen.getByRole('tab', { name: /^Heute/ }));
    await waitFor(() => expect(container.querySelector('.vp-tb-titel')?.textContent).toMatch(/^Heute:/));
  });

  it('bietet nach einem gescheiterten Abruf von gestern „Erneut versuchen"', async () => {
    const gesternIso = lokal(vortag0());
    let versuche = 0;
    schedule.mockImplementation((_id: unknown, mode?: unknown, date?: unknown) => {
      if (date === gesternIso) {
        versuche += 1;
        return versuche === 1
          ? Promise.reject(new Error('502'))
          : Promise.resolve({ ...plan(), planId: null, slots: ganzerTag(vortag0()) });
      }
      return Promise.resolve(mode === 'day' ? dayPlan() : plan());
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Gestern/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(container.querySelector('.vp-tb-titel')?.textContent).toMatch(/^Gestern:/));
    expect(versuche).toBe(2);
  });

  it('sagt morgen ohne Plan den Grund - mit Plan zeigt es ihn, ohne Geldzahl und ohne Gerät', async () => {
    schedule.mockImplementation(() => Promise.resolve(nurHeute()));
    const { container, unmount } = render(<FahrplanSection site={SITE} />);
    fireEvent.click(await screen.findByRole('tab', { name: /^Morgen/ }));
    expect(await screen.findByText('Für morgen gibt es noch keinen Plan')).toBeInTheDocument();
    expect(container.querySelector('.vp-tb')).toBeNull();
    unmount();

    // Der jüngste Lauf trägt den Folgetag, sobald dessen Preise da sind.
    schedule.mockImplementation((_id: unknown, mode?: unknown) =>
      Promise.resolve(
        mode === 'day' ? dayPlan() : { ...nurHeute(), slots: [...nurHeute().slots, ...ganzerTag(folgetag0())] },
      ),
    );
    siteEarnings.mockResolvedValue({ ...GELD_GESTERN, from: heute0().toISOString(), to: folgetag0().toISOString() });
    const zwei = render(<FahrplanSection site={SITE} />);
    const morgen = await screen.findByRole('tab', { name: /^Morgen/ });
    expect(morgen.textContent).not.toMatch(/13 Uhr|noch kein Plan/);
    fireEvent.click(morgen);
    await waitFor(() => expect(zwei.container.querySelector('.vp-tb-titel')?.textContent).toMatch(/^Morgen:/));
    const antworten = screen.getByRole('list', { name: 'Antworten zum Fahrplan' });
    expect(within(antworten).getByText('Reicht der Speicher morgen Abend?')).toBeInTheDocument();
    expect(within(antworten).queryByText(/Was bringt es/)).toBeNull();
    expect(zwei.container.querySelector('.vp-uhr-m1')?.textContent).toMatch(/^morgen · /i);
    expect(screen.getByRole('region', { name: 'Der Tag in Stationen' }).textContent).toContain(
      'rechnet den Plan für morgen bis dahin alle 15 Minuten neu',
    );
  });
});
