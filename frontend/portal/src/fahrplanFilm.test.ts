import { describe, expect, it } from 'vitest';
import { filmKurzfassung, filmLabel, filmRows, naechsterEinsatz } from './fahrplanFilm';
import { phases, type WhySlot } from './fahrplanWhy';

/**
 * Der Film des Tages: die Phasen als ERZÄHLTE LISTE mit Jetzt-Anker. Was hier
 * am meisten wert ist:
 *
 *  - jede Zeile trägt ihr WORT (der Farbstreifen war bei 375 px unbeschriftet,
 *    und Grün↔Türkis kann Identität nie allein tragen),
 *  - „heute" führt, „morgen" ist eingeklappt (Entscheid D2),
 *  - die abgehakte Vergangenheit ist im Datenmodell VORGESEHEN, damit der
 *    spätere Ganztages-Film ohne Umbau hineinpasst,
 *  - ein Zusatz erscheint nur, wenn der Lauf die Zahl wirklich trägt.
 */

// 19:20 Uhr Ortszeit an einem festen Tag - die Phasen werden relativ dazu
// gebaut, damit „läuft"/„heute"/„morgen" unabhängig von der Zeitzone stimmen.
const NOW = new Date(2026, 7, 1, 19, 20, 0);

function at(hoursFromNow: number): string {
  return new Date(NOW.getTime() + hoursFromNow * 3600_000).toISOString();
}

function slot(over: Partial<WhySlot> & { start: string }): WhySlot {
  return {
    batteryKw: -4,
    socPct: 60,
    priceEurMwh: 200,
    costEur: 0.1,
    baselineCostEur: 0.4,
    slotRole: 'eigenverbrauch',
    slotFlags: null,
    storedValueCtKwh: 20,
    ...over,
  };
}

/** N slots of one role, 15 min apart, starting `fromH` hours from NOW. */
function run(role: string, fromH: number, count: number, over: Partial<WhySlot> = {}): WhySlot[] {
  return Array.from({ length: count }, (_, i) =>
    slot({ start: at(fromH + i * 0.25), slotRole: role, ...over }),
  );
}

function build(slots: WhySlot[]) {
  return { slots, phases: phases(slots, 15) };
}

describe('filmRows · Jetzt führt, heute voll, morgen eingeklappt', () => {
  it('setzt die laufende Phase an den Anfang und markiert sie', () => {
    // Eine laufende Entladephase (beginnt vor 30 min), dann Ruhe, dann laden.
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', -0.5, 8),
      ...run('warten', 1.5, 8),
      ...run('guenstig_laden', 3.5, 4, { batteryKw: 5, importPriceCtKwh: 3.4 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today[0].now).toBe(true);
    expect(view.today[0].label).toBe('Verbrauch decken');
    expect(view.today[0].sub).toMatch(/^läuft · noch bis \d{2}:\d{2} Uhr$/);
    expect(view.today.map((r) => r.label)).toEqual([
      'Verbrauch decken',
      'Ruhe',
      'Günstig aus dem Netz laden',
    ]);
    // Nichts ist abgeschlossen, solange der Plan bei „jetzt" beginnt.
    expect(view.past).toEqual([]);
  });

  it('klappt den Folgetag ein und zählt ihn ehrlich', () => {
    // 19:20 + 6 h = 01:20 des Folgetags.
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('warten', 1, 4),
      ...run('guenstig_laden', 6, 4, { batteryKw: 5 }),
      ...run('pv_speichern', 14, 4, { batteryKw: 6 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today).toHaveLength(2);
    expect(view.tomorrow.map((r) => r.label)).toEqual([
      'Günstig aus dem Netz laden',
      'Sonne speichern',
    ]);
    expect(view.tomorrowSummary).toBe('Morgen · 2 weitere Phasen');
  });

  it('sagt „1 weitere Phase" im Singular', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('pv_speichern', 14, 4, { batteryKw: 6 }),
    ]);
    expect(filmRows(ph, slots, 'eigenverbrauch', NOW).tomorrowSummary).toBe(
      'Morgen · 1 weitere Phase',
    );
  });

  it('hakt eine abgeschlossene Phase ab - das Datenmodell des Ganztages-Films', () => {
    const { slots, phases: ph } = build([
      ...run('pv_speichern', -4, 4, { batteryKw: 6 }),
      ...run('eigenverbrauch', 0, 4),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.past.map((r) => r.label)).toEqual(['Sonne speichern']);
    expect(view.past[0].done).toBe(true);
    expect(view.today[0].done).toBe(false);
  });

  it('bleibt ehrlich, wenn für heute nichts mehr ansteht', () => {
    const { slots, phases: ph } = build(run('pv_speichern', 14, 4, { batteryKw: 6 }));
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today).toEqual([]);
    expect(view.empty).toContain('keine weiteren Phasen');
    expect(view.tomorrow).toHaveLength(1);
  });
});

describe('filmRows · Zusätze nur aus dem, was der Lauf trägt', () => {
  it('nennt bei Ruhe den geplanten Ladestand an ihrem Ende', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('warten', 1, 4, { socPct: 34, batteryKw: 0 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today[1].sub).toBe('Speicher hält ~34 %');
  });

  it('nennt beim Netzladen den BEZUGSPREIS, nie den nackten Börsenpreis', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('guenstig_laden', 1, 4, { batteryKw: 5, importPriceCtKwh: 3.4 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today[1].sub).toBe('Ø Bezugspreis 3,4 ct/kWh');
  });

  it('lässt den Zusatz weg, wenn der Lauf den Bezugspreis nicht trägt', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('guenstig_laden', 1, 4, { batteryKw: 5, importPriceCtKwh: null }),
    ]);
    expect(filmRows(ph, slots, 'eigenverbrauch', NOW).today[1].sub).toBeNull();
  });

  it('nennt beim Abregeln den Negativpreis als Grund', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('abregeln', 1, 4, { batteryKw: 0, priceEurMwh: -40 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.today[1].label).toBe('Einspeisung pausiert');
    expect(view.today[1].sub).toContain('Negativpreis');
  });

  it('nennt einen Ladeeinkauf beim Namen, statt ihn als Verlust zu zeigen', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('guenstig_laden', 1, 4, { batteryKw: 5, costEur: 0.4, baselineCostEur: 0.1 }),
    ]);
    const row = filmRows(ph, slots, 'eigenverbrauch', NOW).today[1];
    expect(row.einkauf).toBe(true);
    expect(row.eur).toMatch(/^−/);
  });

  it('lässt den Betrag weg, wenn keine Kostendaten vorliegen', () => {
    const { slots, phases: ph } = build(
      run('eigenverbrauch', 0, 4, { costEur: null, baselineCostEur: null }),
    );
    expect(filmRows(ph, slots, 'eigenverbrauch', NOW).today[0].eur).toBeNull();
  });
});

describe('naechsterEinsatz + filmKurzfassung', () => {
  const scenario = () =>
    build([
      ...run('eigenverbrauch', -0.5, 8),
      ...run('warten', 1.5, 8),
      ...run('guenstig_laden', 3.5, 4, { batteryKw: 5 }),
    ]);

  it('überspringt Ruhe-Phasen beim Blick nach vorn', () => {
    const { slots, phases: ph } = scenario();
    const next = naechsterEinsatz(filmRows(ph, slots, 'eigenverbrauch', NOW));
    expect(next?.label).toBe('Günstig aus dem Netz laden');
  });

  it('fasst den Film in EINER Zeile zusammen - ohne →-Kette', () => {
    const { slots, phases: ph } = scenario();
    const text = filmKurzfassung(filmRows(ph, slots, 'eigenverbrauch', NOW))!;
    expect(text).toMatch(/^Jetzt Verbrauch decken bis \d{2}:\d{2} Uhr · danach Ruhe/);
    expect(text).not.toContain('→');
    expect(text.endsWith('.')).toBe(true);
  });

  it('liefert ohne Zeilen nichts (nie ein erfundener Satz)', () => {
    const empty = filmRows([], [], 'eigenverbrauch', NOW);
    expect(filmKurzfassung(empty)).toBeNull();
    expect(naechsterEinsatz(empty)).toBeNull();
  });
});

describe('filmLabel · das listen-taugliche Vokabular', () => {
  it('kürzt genau die vier Rollen, die als volle Sätze zu lang wären', () => {
    expect(filmLabel('warten', 'eigenverbrauch')).toBe('Ruhe');
    expect(filmLabel('pv_speichern', 'eigenverbrauch')).toBe('Sonne speichern');
    expect(filmLabel('eigenverbrauch', 'eigenverbrauch')).toBe('Verbrauch decken');
    expect(filmLabel('abregeln', 'eigenverbrauch')).toBe('Einspeisung pausiert');
  });

  it('bleibt sonst das geteilte Rollen-Vokabular, inklusive der Reserve-Art', () => {
    expect(filmLabel('verkaufen', 'direktvermarktung')).toBe('Zum Spitzenpreis verkaufen');
    expect(filmLabel('reserve_halten', 'eigenverbrauch', ['reserve_backup'])).toBe(
      'Reserve halten (Notstrom)',
    );
  });
});
