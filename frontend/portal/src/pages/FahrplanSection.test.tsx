import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FahrplanSection } from './DataPages';
import type { ControlStatus, SchedulePlan, ScheduleSlot, Site, TelemetryPoint } from '../api';

/**
 * Das SEITENGERÜST der Fahrplan-Seite: vier Blöcke in der Reihenfolge der
 * Kundenfragen (Jetzt-Held → Film → Euro-Zeile → Diagramm-Aufklappebene).
 * Die Zustands-Vollständigkeit liegt in den reinen Modul-Tests; hier wird
 * geprüft, dass die Blöcke wirklich in dieser Ordnung stehen und dass ein Plan
 * OHNE die persistierten Warum-Fakten sauber degradiert (kein Film, kein
 * erfundener Grund).
 */

vi.mock('../ScheduleChart', () => ({
  ScheduleChart: () => <div data-testid="chart" />,
}));

const controlStatus = vi.fn();
const weather = vi.fn();
const curtailmentStatus = vi.fn();
const schedule = vi.fn();
const telemetry = vi.fn();

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
  const t0 = Date.now() - 5 * 60_000;
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
});

describe('FahrplanSection · die vier Blöcke', () => {
  it('beantwortet „was macht meine Batterie gerade" ganz oben - mit den drei Wahrheiten', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    // Der Held steht VOR allem anderen.
    const blocks = [...container.querySelectorAll('.vp-jetzt, .vp-film, .vp-fp-euro')];
    expect(blocks[0]?.classList.contains('vp-jetzt')).toBe(true);
    // Ausführung (Rücklesen) statt Plan-Watt, und der Plan bleibt sichtbar.
    await waitFor(() => expect(screen.getByText(/6,1/)).toBeInTheDocument());
    expect(screen.getByText(/Fahrplan sah/)).toBeInTheDocument();
    // Der Warum-Satz des laufenden Slots, mit dem echten Bezugspreis.
    expect(screen.getByText(/32,5 ct\/kWh/)).toBeInTheDocument();
    // Der Film mit seiner ersten, laufenden Phase.
    expect(container.querySelector('.vp-film-now')?.textContent).toBe('Jetzt');
    expect(screen.getAllByText('Verbrauch decken').length).toBeGreaterThan(0);
    // Die Euro-Zeile ersetzt die alte KPI-Reihe.
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
    expect(container.querySelector('.vp-kpis')).toBeNull();
  });

  it('hält das Diagramm als Aufklapp-Ebene bereit und zeigt die kWh-Summen erst darin', async () => {
    render(<FahrplanSection site={SITE} />);
    const toggle = await screen.findByRole('button', { name: /Diagramm im Detail/ });
    // jsdom kennt kein matchMedia -> Startwert „offen" (Desktop).
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.getByText(/geplantes Laden/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByText(/geplantes Laden/)).toBeNull();
  });

  it('degradiert ohne persistierte Warum-Fakten: kein Film, kein erfundener Grund', async () => {
    schedule.mockResolvedValue(
      plan({
        slots: plan().slots.map((s) => ({ ...s, slotRole: null, storedValueCtKwh: null })),
      }),
    );
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    expect(container.querySelector('.vp-film')).toBeNull();
    expect(screen.queryByText(/32,5 ct\/kWh/)).toBeNull();
    // ...die Euro-Zeile und das Diagramm bleiben.
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('bleibt ohne Rücklesen ehrlich: „—" mit Grund statt einer erfundenen Zahl', async () => {
    controlStatus.mockResolvedValue(null);
    render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
    expect(screen.getByText(/Rückmeldung/)).toBeInTheDocument();
    expect(screen.queryByText(/6,1/)).toBeNull();
  });

  it('überlebt einen Ausfall der beiden Live-Abrufe (fail-soft)', async () => {
    controlStatus.mockRejectedValue(new Error('down'));
    curtailmentStatus.mockRejectedValue(new Error('down'));
    telemetry.mockRejectedValue(new Error('down'));
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
  });
});

/**
 * Der Tages-Splice: der Film erzählt den GANZEN Tag - die gelaufenen Phasen
 * abgehakt und ehrlich als PLAN, nie als Ist. Fällt die neue Lesart aus, steht
 * exakt die Rest-des-Tages-Fassung da.
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

  it('bestätigt mit Block die Ausführung (Stufe 3) - und warnt dann nicht mehr', async () => {
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
    // Bewusst auf die BEGRENZUNG geprüft: „vom Wechselrichter bestätigt" sagt
    // auch die Rücklese-Zeile des Batterie-Sollwerts - die Zahl unterscheidet.
    await waitFor(() => expect(container.textContent).toContain('Die Einspeisung ist auf 12,5'));
    expect(container.querySelector('.vp-jetzt-conflict')).toBeNull();
    // Und die Leitzeile darf jetzt Gegenwart sagen.
    expect(container.textContent).toContain('pausiert gerade die Einspeisung');
  });
});

describe('FahrplanSection · der Film zeigt den ganzen Tag', () => {
  beforeEach(() => {
    schedule.mockImplementation((_id: unknown, mode?: unknown) =>
      Promise.resolve(mode === 'day' ? dayPlan() : plan()),
    );
  });

  it('holt den ganzen Tag und hakt die gelaufenen Phasen ab', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelectorAll('.vp-film-li.is-done')).toHaveLength(1));
    // Der Film führt weiterhin mit „jetzt", der Vormittag steht abgehakt davor.
    expect(container.querySelector('.vp-film-now')?.textContent).toBe('Jetzt');
    expect(screen.getByText('Sonne speichern')).toBeInTheDocument();
    // Die zweite Lesart wurde wirklich angefragt - und die alte daneben auch.
    expect(schedule).toHaveBeenCalledWith('s1', 'day');
    expect(schedule).toHaveBeenCalledWith('s1');
  });

  it('sagt, dass die abgehakten Phasen der PLAN sind - und verweist auf die Messwerte', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-film-pastnote')).toBeTruthy());
    expect(container.querySelector('.vp-film-pastnote')?.textContent).toContain(
      'so war es geplant',
    );
    // Ein Abzeichen für die ganze Karte: hier stehen nur geplante Zahlen.
    expect(screen.getByText('Der ganze Tag')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Messwerte' })).toHaveAttribute(
      'href',
      '#/anlage/s1/messwerte',
    );
  });

  it('öffnet das Erklär-Panel einer VERGANGENEN Phase an ihrer Zeile', async () => {
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelectorAll('.vp-film-li.is-done')).toHaveLength(1));
    const done = container.querySelector('.vp-film-li.is-done .vp-film-row') as HTMLElement;
    fireEvent.click(done);
    // Das Panel gehört zur GANZTAGES-Liste (sonst zeigte der Index in die
    // Slots des jüngsten Laufs und erklärte die falsche Phase).
    const panel = container.querySelector('.vp-film-li.is-done .vp-fw-panel');
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
    await waitFor(() => expect(container.querySelector('.vp-film')).toBeTruthy());
    expect(container.querySelectorAll('.vp-film-li.is-done')).toHaveLength(0);
    expect(container.querySelector('.vp-film-pastnote')).toBeNull();
    expect(screen.getByText('Heute noch')).toBeInTheDocument();
    // Der Rest der Seite ist davon unberührt.
    expect(container.querySelector('.vp-film-now')?.textContent).toBe('Jetzt');
    expect(screen.getByText(/Heute geplant:/)).toBeInTheDocument();
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
    await waitFor(() => expect(container.querySelector('.vp-film')).toBeTruthy());
    expect(container.querySelectorAll('.vp-film-li.is-done')).toHaveLength(0);
    expect(screen.getByText('Heute noch')).toBeInTheDocument();
  });
});

/**
 * ERKLÄRBARKEIT STUFE 2 „Die Lage": die Zeile zwischen Held und Film erzählt den
 * Tages-Bogen und den Morgen-Ausblick - und NUR, wenn die Eingaben des Laufs sie
 * tragen. Die Regel-Vollständigkeit liegt in `fahrplanLage.test.ts`; hier wird
 * geprüft, dass sie am richtigen Ort steht, ihre Fakten wirklich aus dem
 * geladenen Plan zieht und ohne sie ersatzlos verschwindet.
 */
describe('FahrplanSection · die „Lage"-Zeile', () => {
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

  it('steht ZWISCHEN dem Helden und dem Film und erzählt den Tages-Bogen', async () => {
    schedule.mockResolvedValue(talPlan());
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-lage')).toBeTruthy());
    expect(container.querySelector('.vp-lage')!.textContent).toContain('mittags am günstigsten');
    // Die Reihenfolge der Blöcke: Held → Lage → Film.
    const blocks = [...container.querySelectorAll('.vp-jetzt, .vp-lage, .vp-film')];
    expect(
      blocks.map((b) =>
        ['vp-jetzt', 'vp-lage', 'vp-film'].find((c) => b.classList.contains(c)),
      ),
    ).toEqual(['vp-jetzt', 'vp-lage', 'vp-film']);
  });

  it('nennt den Morgen-Ausblick aus den PLAN-Eingaben und das Wetter-Wort', async () => {
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
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() =>
      expect(container.querySelector('.vp-lage')?.textContent).toContain('Solar-Überschuss'),
    );
    const text = container.querySelector('.vp-lage')!.textContent!;
    expect(text).toContain('kaum Sonne');
    expect(text).toContain('alle 15 Minuten');
  });

  it('verschwindet ersatzlos, wenn der Lauf nichts Belegtes trägt', async () => {
    // Kein Preisbogen, keine Prognosen, und der Horizont reicht bis morgen -
    // also gibt es weder einen Bogen noch einen Ausblick noch den Horizont-Satz.
    const nackt = mitMorgen();
    schedule.mockResolvedValue({
      ...nackt,
      slots: nackt.slots.map((s) => ({ ...s, priceEurMwh: null, pvKw: null, loadKw: null })),
    });
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-jetzt')).toBeTruthy());
    expect(container.querySelector('.vp-lage')).toBeNull();
  });

  it('überlebt einen Ausfall des Wetter-Abrufs (fail-soft)', async () => {
    schedule.mockResolvedValue(talPlan());
    weather.mockRejectedValue(new Error('down'));
    const { container } = render(<FahrplanSection site={SITE} />);
    await waitFor(() => expect(container.querySelector('.vp-lage')).toBeTruthy());
    const text = container.querySelector('.vp-lage')!.textContent!;
    expect(text).toContain('mittags am günstigsten');
    expect(text).not.toContain('Wettervorhersage');
  });
});
