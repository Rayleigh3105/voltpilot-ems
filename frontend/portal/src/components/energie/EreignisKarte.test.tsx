import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { History, HistoryEvent, HistoryRange } from '../../api';
import { ereignisChronik, ereignisSpur, stundenZellen, type EreignisZelle } from '../../historieEreignisse';
import { vorgabeDetailBeispiel, vorgabenVerlaufBeispiel } from '../../test/erzeugerFixtures';
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

describe('EreignisKarte — Vorgaben einer Erzeugeranlage (EZ-9)', () => {
  const NOW = new Date(2026, 9, 21, 15, 44);
  const sp = (t: string | null | undefined) => (t ?? '').replace(/[\u00a0\u202f]/g, ' ');

  function vorgabenKarte(o: { fall?: 'buettner' | 'gore'; range?: HistoryRange; leer?: boolean; csv?: () => Promise<void> } = {}) {
    const range = o.range ?? 'day';
    const beispiel = vorgabenVerlaufBeispiel(o.fall ?? 'buettner', range, NOW);
    const history = { ...verlauf(o.leer ? [] : beispiel.events, range), vorgaben: o.leer ? { ...beispiel.vorgaben, zaehlung: [] } : beispiel.vorgaben };
    const spur = ereignisSpur(history)!;
    const ladeVorgabe = vi.fn((id: string) => Promise.resolve(vorgabeDetailBeispiel(id, NOW)));
    const onVorgabenCsv = vi.fn(o.csv ?? (() => Promise.resolve()));
    render(
      <EreignisKarte
        spur={spur}
        gruppen={ereignisChronik(spur, range)}
        range={range}
        streifenZellen={range === 'day' ? stundenZellen(new Date(2026, 9, 21, 12), NOW) : oktober}
        filter={null}
        onFilter={vi.fn()}
        fokus={null}
        onFokus={vi.fn()}
        onOeffnen={range === 'day' ? undefined : vi.fn()}
        ladeVorgabe={ladeVorgabe}
        onVorgabenCsv={onVorgabenCsv}
      />,
    );
    return { ladeVorgabe, onVorgabenCsv };
  }

  it('die Chronik-Zeile sagt Urheber und Vorgabe, ob die Anlage folgte, und die geschätzte Energie', () => {
    vorgabenKarte();
    const zeile = screen.getByRole('button', { name: /^Netzbetreiber · 60\s%, 1\sStd 11\sMin · folgt ✓/ });
    expect(sp(zeile.textContent)).toContain('Netzbetreiber · 60 %1 Std 11 Min · folgt ✓≈ 25,0 kWh');
    expect(screen.getByRole('button', { name: /^Direktvermarkter · Abruf 80,0\skW/ })).toHaveTextContent(/nicht bindend/);
    // Die Lücke ist keine Vorgabe: kein Detail, aber ihre weiteren Wechsel stehen da.
    expect(screen.getByText('1 weiterer Wechsel während einer Datenlücke').closest('button')).toBeNull();
    // Filter-Chips zählen Vorgaben, nicht Lücken.
    expect(within(screen.getByRole('group', { name: 'Nach Art filtern' })).getByRole('button', { name: /Netzbetreiber/ })).toHaveTextContent(/Netzbetreiber2$/);
  });

  it('ein Tipp öffnet das Detail mit Rohsignalen und Zählerständen', async () => {
    const { ladeVorgabe } = vorgabenKarte();
    const zeile = screen.getByRole('button', { name: /^Netzbetreiber · 60\s%/ });
    expect(zeile).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(zeile);
    expect(zeile).toHaveAttribute('aria-expanded', 'true');
    expect(ladeVorgabe).toHaveBeenCalledWith('vg-bue-2');
    expect(await screen.findByText('Rohsignale am Beginn')).toBeInTheDocument();
    expect(screen.getByText('Zählerstand').nextSibling).toHaveTextContent('41 → 42');
    expect(screen.getByText('n_bits').nextSibling).toHaveTextContent('Vorgabe gültig, Verbindung steht, Wirkleistung begrenzt (7)');
    expect(screen.getByText(/37 Proben der Rohsignale/)).toBeInTheDocument();
    expect(ladeVorgabe).toHaveBeenCalledTimes(1);
  });

  it('kann das Detail nicht geladen werden, sagt es das und lädt auf Wunsch erneut', async () => {
    vorgabenKarte();
    const ladeVorgabe = vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValue(vorgabeDetailBeispiel('vg-bue-1', NOW));
    // Eine eigene Karte mit dem scheiternden Abruf.
    document.body.innerHTML = '';
    const spur = ereignisSpur({ ...verlauf(vorgabenVerlaufBeispiel('buettner', 'day', NOW).events, 'day'), vorgaben: vorgabenVerlaufBeispiel('buettner', 'day', NOW).vorgaben })!;
    render(
      <EreignisKarte spur={spur} gruppen={ereignisChronik(spur, 'day')} range="day" streifenZellen={[]} filter={null}
        onFilter={vi.fn()} fokus={null} onFokus={vi.fn()} ladeVorgabe={ladeVorgabe} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Netzbetreiber · 30\s%/ }));
    expect(await screen.findByText('Das Detail dieser Vorgabe konnte nicht geladen werden.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
    expect(await screen.findByText('Rohsignale am Beginn')).toBeInTheDocument();
  });

  it('Gore: die Euro-Schätzung steht nur, weil EZ-7 sie liefert', () => {
    vorgabenKarte({ fall: 'gore' });
    expect(sp(screen.getByRole('button', { name: /^Netzbetreiber · 60\s%/ }).textContent)).toContain('≈ 18,4 kWh≈ 1,47 €');
  });

  it('„Nach Art“: Anzahl, Dauer und Energie je Urheber, je Einheit aufklappbar', () => {
    vorgabenKarte();
    fireEvent.click(screen.getByRole('button', { name: 'Nach Art' }));
    const nb = screen.getByRole('button', { name: /^Netzbetreiber: 2×/ });
    expect(sp(nb.textContent)).toContain('2 Std 26 Min · ≈ 76,0 kWh nicht erzeugt');
    expect(sp(nb.textContent)).toContain('1 weiterer Wechsel während einer Datenlücke');
    const knopf = screen.getByRole('button', { name: 'Je Einheit (2)' });
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Vorgaben je Einheit' })).not.toBeInTheDocument();
    fireEvent.click(knopf);
    const liste = screen.getByRole('list', { name: 'Vorgaben je Einheit' });
    expect(sp(liste.textContent)).toBe('Motor 1Direktvermarkter 1× · 2 Std 38 MinMotor 2Direktvermarkter 1× · 1 Std 53 Minnicht bereit 1× · 45 Min');
  });

  it('„Vorgaben als CSV“ lädt den Zeitraum der Ansicht und sagt, wenn es nicht ging', async () => {
    let fertig: () => void = () => {};
    const { onVorgabenCsv } = vorgabenKarte({ csv: () => new Promise<void>((r) => { fertig = r; }) });
    const knopf = screen.getByRole('button', { name: 'Vorgaben als CSV' });
    fireEvent.click(knopf);
    expect(onVorgabenCsv).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Vorgaben werden geladen …' })).toBeDisabled();
    await act(async () => fertig());
    expect(screen.getByRole('button', { name: 'Vorgaben als CSV' })).toBeEnabled();

    document.body.innerHTML = '';
    vorgabenKarte({ csv: () => Promise.reject(new Error('403')) });
    fireEvent.click(screen.getByRole('button', { name: 'Vorgaben als CSV' }));
    await waitFor(() => expect(screen.getByText('Die Vorgaben konnten nicht geladen werden.')).toBeInTheDocument());
  });

  it('ohne Vorgaben im Zeitraum „noch keine Vorgaben“ statt einer leeren Karte — der CSV-Knopf bleibt', () => {
    vorgabenKarte({ leer: true });
    expect(screen.getByText('Noch keine Vorgaben in diesem Zeitraum')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vorgaben als CSV' })).toBeInTheDocument();
  });

  it('ohne Anlagensteuerung gibt es keinen CSV-Knopf und kein „Vorgaben“-Wort', () => {
    karte();
    expect(screen.queryByRole('button', { name: 'Vorgaben als CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Vorgaben/)).not.toBeInTheDocument();
  });
});
