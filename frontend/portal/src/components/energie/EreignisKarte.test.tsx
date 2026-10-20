import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { History, HistoryEvent, HistoryRange } from '../../api';
import { ereignisChronik, ereignisSpur, type EreignisZelle } from '../../historieEreignisse';
import { EreignisKarte } from './EreignisKarte';

/** Render-only: Wörter, Zahlen und Bündel entscheidet `historieEreignisse.ts`. */

const lokal = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).toISOString();

function verlauf(events: HistoryEvent[] | undefined, range: HistoryRange = 'month'): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: 1440,
    buckets: [],
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
    ...(events ? { events } : {}),
  };
}

const oktober: EreignisZelle[] = Array.from({ length: 31 }, (_, i) => ({
  start: new Date(2026, 9, 1 + i),
  ende: new Date(2026, 9, 2 + i),
  zukunft: i >= 20,
}));

const EREIGNISSE: HistoryEvent[] = [
  { type: 'netzladen', start: lokal(10, 2, 3), end: lokal(10, 2, 4), text: 'Speicher aus dem Netz geladen: 1 Std (ca. 2,2 kWh)', value: 2.2, unit: 'kWh' },
  { type: 'datenluecke', start: lokal(10, 7, 10, 15), end: lokal(10, 7, 11, 15), text: 'Datenlücke: 1 Std ohne Messwerte', value: null },
  { type: 'negativpreis', start: lokal(10, 10, 13), end: lokal(10, 10, 13, 15), text: 'Negative Börsenpreise: 15 Min, bis -0,0 ct/kWh', value: -0.04, unit: 'ct/kWh' },
];

function karte(o: { events?: HistoryEvent[]; range?: HistoryRange; filter?: HistoryEvent['type'] | null } = {}) {
  const range = o.range ?? 'month';
  const spur = { ...ereignisSpur(verlauf(o.events ?? EREIGNISSE, range))!, hinweis: range === 'month' ? 'Die Netzgrenze (§ 14a) …' : null };
  const props = {
    onFilter: vi.fn(),
    onFokus: vi.fn(),
    onOeffnen: vi.fn(),
  };
  render(
    <EreignisKarte
      spur={spur}
      gruppen={ereignisChronik(spur, range)}
      range={range}
      streifenZellen={oktober}
      filter={o.filter ?? null}
      fokus={null}
      {...props}
      onOeffnen={range === 'day' ? undefined : props.onOeffnen}
    />,
  );
  return props;
}

describe('EreignisKarte — Chronik', () => {
  it('sagt je Ereignis ein Wort und eine Zahl, ohne den Satz doppelt zu sagen', () => {
    karte();
    const zeile = screen.getByRole('button', { name: /Samstag, 10\.10\.: Negative Preise/ });
    expect(within(zeile).getByText('Negative Preise')).toBeInTheDocument();
    expect(zeile).toHaveTextContent(/bis −0,04\sct/);
    // Der Servertext steht nur noch als Titel (Hover/Vorleser), nicht als zweiter Satz.
    expect(screen.queryByText('Negative Börsenpreise: 15 Min, bis -0,0 ct/kWh')).not.toBeInTheDocument();
  });

  it('öffnet mit einer Zeile ihren Tag', () => {
    const { onOeffnen } = karte();
    fireEvent.click(screen.getByRole('button', { name: /Freitag, 02\.10\.: Netzladen/ }));
    expect(onOeffnen).toHaveBeenCalledWith({ range: 'day', at: '2026-10-02' });
  });

  it('zählt je Art und filtert über die Chips; § 14a steht als ruhiger Hinweis', () => {
    const { onFilter } = karte();
    const chips = screen.getByRole('group', { name: 'Nach Art filtern' });
    fireEvent.click(within(chips).getByRole('button', { name: /Netzladen/ }));
    expect(onFilter).toHaveBeenCalledWith('netzladen');
    expect(chips).toHaveTextContent(/§\s14a: nur Tag\/Woche/);
  });

  it('zeigt mit Filter nur die Zeilen dieser Art', () => {
    karte({ filter: 'datenluecke' });
    expect(screen.queryByRole('button', { name: /Netzladen, / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mittwoch, 07\.10\.: Datenlücke/ })).toBeInTheDocument();
  });

  it('kürzt lange Monate und zeigt auf Wunsch alle Tage', () => {
    const viele: HistoryEvent[] = Array.from({ length: 9 }, (_, i) => ({
      type: 'negativpreis',
      start: lokal(7, 1 + i * 3, 12),
      end: lokal(7, 1 + i * 3, 13),
      text: '…',
      value: -1,
      unit: 'ct/kWh',
    }));
    karte({ events: viele });
    expect(screen.getAllByRole('button', { name: /Negative Preise, / })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Alle 9 Tage zeigen' }));
    expect(screen.getAllByRole('button', { name: /Negative Preise, / })).toHaveLength(9);
  });

  it('sagt eine leere Spur mit zwei Wörtern statt eines Satzes', () => {
    karte({ events: [] });
    expect(screen.getByText('Nichts Auffälliges')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ansicht der Ereignisse' })).not.toBeInTheDocument();
  });
});

describe('EreignisKarte — am Tag', () => {
  it('klappt die Fakten des Abendverkaufs auf, statt einen Absatz zu zeigen', () => {
    karte({
      range: 'day',
      events: [
        {
          type: 'abendverkauf', start: lokal(9, 4, 19, 45), end: lokal(9, 4, 21), text: 'Abendverkauf …',
          value: 4.2, unit: 'kWh', planned: true,
          facts: [{ label: 'Speicher leer', value: '02:45' }, { label: 'Erlös', value: '0,58 €' }],
        },
      ],
    });
    const knopf = screen.getByRole('button', { name: /Abendverkauf\s*geplant/ });
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    expect(within(knopf).getByText('geplant')).toBeInTheDocument();
    fireEvent.click(knopf);
    expect(knopf).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Speicher leer')).toBeInTheDocument();
    expect(screen.getByText('02:45')).toBeInTheDocument();
  });

  it('heißt dort „Nach Zeit" und bietet keinen Sprung an', () => {
    karte({ range: 'day', events: [EREIGNISSE[2]] });
    expect(screen.getByRole('button', { name: 'Nach Zeit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /öffnen/ })).not.toBeInTheDocument();
  });
});

describe('EreignisKarte — Nach Art', () => {
  it('zeigt je Art eine Kachel mit Anzahl und Zahl; eine Kachel filtert die Chronik', () => {
    const { onFilter } = karte();
    fireEvent.click(screen.getByRole('button', { name: 'Nach Art' }));
    const kachel = screen.getByRole('button', { name: /Negative Preise: 1 Tag, bis −0,04 ct/ });
    fireEvent.click(kachel);
    expect(onFilter).toHaveBeenLastCalledWith('negativpreis');
    // Zurück in der Chronik.
    expect(screen.getByRole('button', { name: 'Nach Tag' })).toHaveAttribute('aria-pressed', 'true');
  });
});
