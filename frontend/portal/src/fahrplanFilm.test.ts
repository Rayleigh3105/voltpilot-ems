import { describe, expect, it } from 'vitest';
import type { FilmRow, FilmView } from './fahrplanFilm';
import {
  filmKicker,
  filmKurzfassung,
  filmLabel,
  filmPastNote,
  filmRows,
  naechsterEinsatz,
  speicherKurzzeile,
  phaseDuty,
} from './fahrplanFilm';
import { phases, type WhySlot } from './fahrplanWhy';
import { DUTY_HINT, dutyTooltip } from './schedule';

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
      'Warten',
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

  it('sagt „Morgen und danach", wenn ein 48-h-Plan über zwei Tage reicht', () => {
    // 48-h-Horizont (28.08.2026): der Rest des Films läuft über MORGEN und
    // ÜBERMORGEN. Ein blosses „Morgen" behauptete dann einen Tag zu viel.
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', 0, 4),
      ...run('guenstig_laden', 6, 4, { batteryKw: 5 }),
      ...run('pv_speichern', 14, 4, { batteryKw: 6 }),
      ...run('verkaufen', 38, 4, { batteryKw: -8 }),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.tomorrowSummary).toBe('Morgen und danach · 3 weitere Phasen');
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
    expect(view.today[1].label).toBe('Einspeisung pausieren');
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

describe('Duty-Vorschau · die Pflicht steht im PLAN, nicht erst im Slot', () => {
  it('markiert eine durchgehende Pflicht-Phase mit ihrem Wort', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', -0.5, 8, { coverLoadFromBattery: true }),
      ...run('warten', 1.5, 4, { batteryKw: 0 }),
    ]);
    const row = filmRows(ph, slots, 'eigenverbrauch', NOW).today[0];
    expect(row.duty).toEqual({
      kind: 'verbrauch-folgen',
      text: 'folgt dem gemessenen Verbrauch',
      hint: expect.stringContaining('Vorhersage'),
      partial: false,
    });
    // Die Ruhe-Phase daneben trägt keine - Pflichten sind slot-genau.
    expect(filmRows(ph, slots, 'eigenverbrauch', NOW).today[1].duty).toBeNull();
  });

  it('sagt „zeitweise", wenn nur ein Teil der Viertelstunden sie trägt', () => {
    // Der Normalfall: der Optimierer setzt die Pflicht nur auf Slots ohne
    // geplanten Netzhandel - eine Phase trägt sie selten durchgehend.
    const slots = [
      ...run('eigenverbrauch', -0.5, 5, { coverLoadFromBattery: true }),
      ...run('eigenverbrauch', 0.75, 3, { coverLoadFromBattery: false }),
    ];
    const row = filmRows(phases(slots, 15), slots, 'eigenverbrauch', NOW).today[0];
    expect(row.duty?.partial).toBe(true);
    expect(row.duty?.text).toBe('folgt zeitweise dem gemessenen Verbrauch');
  });

  it('markiert die Ladeseite mit ihrem eigenen Wort', () => {
    const { slots, phases: ph } = build([
      ...run('pv_speichern', 0.5, 6, { batteryKw: 6, chargeFromSurplusOnly: true }),
    ]);
    const row = filmRows(ph, slots, 'eigenverbrauch', NOW).today[0];
    expect(row.duty?.kind).toBe('ueberschuss-laden');
    expect(row.duty?.text).toBe('lädt nur den Solar-Überschuss');
  });

  it('markiert NICHTS ohne ausdrückliche Pflicht - alte Zeilen wie ein Nein', () => {
    // Drei Zustände, EIN Ergebnis: nicht bewertet (älterer Lauf / Schalter
    // aus), ausdrücklich keine Pflicht, und gemischt-widersprüchlich.
    const alt = build([...run('eigenverbrauch', -0.5, 8)]);
    expect(filmRows(alt.phases, alt.slots, 'eigenverbrauch', NOW).today[0].duty).toBeNull();

    const nein = build([
      ...run('eigenverbrauch', -0.5, 8, {
        coverLoadFromBattery: false,
        chargeFromSurplusOnly: false,
      }),
    ]);
    expect(filmRows(nein.phases, nein.slots, 'eigenverbrauch', NOW).today[0].duty).toBeNull();

    const patt = [
      ...run('eigenverbrauch', -0.5, 2, { coverLoadFromBattery: true }),
      ...run('eigenverbrauch', 0, 2, { chargeFromSurplusOnly: true }),
    ];
    expect(
      filmRows(phases(patt, 15), patt, 'eigenverbrauch', NOW).today[0].duty,
    ).toBeNull();
  });

  it('nennt in phaseDuty denselben Satz, den die Zeile als Tipp trägt', () => {
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', -0.5, 4, { coverLoadFromBattery: true }),
    ]);
    const note = phaseDuty(ph[0], slots)!;
    expect(note.hint).toBe(DUTY_HINT['verbrauch-folgen']);
    // Und der Tooltip des Diagramms nutzt dieselbe Vokabel-Quelle.
    expect(dutyTooltip('verbrauch-folgen')).toContain('folgt dem gemessenen Verbrauch');
  });
});

describe('Der GANZE Tag: abgehakte Vergangenheit, ehrlich als PLAN', () => {
  /**
   * Die Ganztages-Slotliste des Tages-Splice: Vormittag (schon gelaufen),
   * laufende Phase, Rest des Tages, Morgen. Genau das, was
   * `api.schedule(id, 'day')` liefert.
   */
  const ganzerTag = () =>
    build([
      ...run('guenstig_laden', -17, 8, { batteryKw: 5, importPriceCtKwh: 3.4 }),
      ...run('pv_speichern', -13, 12, { batteryKw: 6 }),
      ...run('eigenverbrauch', -0.5, 8, { coverLoadFromBattery: true }),
      ...run('warten', 1.5, 8),
      ...run('guenstig_laden', 8.5, 4, { batteryKw: 5 }),
    ]);

  it('hakt die gelaufenen Phasen ab und lässt „jetzt" trotzdem führen', () => {
    const { slots, phases: ph } = ganzerTag();
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    // Der Vormittag steht als eigene, abgeschlossene Gruppe.
    expect(view.past.map((r) => r.label)).toEqual([
      'Günstig aus dem Netz laden',
      'Sonne speichern',
    ]);
    expect(view.past.every((r) => r.done)).toBe(true);
    expect(view.past.some((r) => r.now)).toBe(false);
    // ...und „heute" beginnt weiterhin mit der laufenden Phase.
    expect(view.today[0].now).toBe(true);
    expect(view.today[0].done).toBe(false);
    expect(view.today[0].sub).toMatch(/^läuft · noch bis/);
    // Morgen bleibt eingeklappt.
    expect(view.tomorrow).toHaveLength(1);
    expect(view.empty).toBeNull();
  });

  it('behält Farbsprache und Pflicht-Markierung auch in der Vergangenheit', () => {
    // Eine schon gelaufene Phase, die die Pflicht „Verbrauch folgen" trug.
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', -4, 8, { coverLoadFromBattery: true }),
      ...run('warten', 1.5, 4),
    ]);
    const done = filmRows(ph, slots, 'eigenverbrauch', NOW).past[0];
    expect(done.done).toBe(true);
    // Die Rolle (= die Farbe, die `roleColor` daraus macht) bleibt erhalten -
    // nichts wird für die Vergangenheit entfärbt oder umbenannt.
    expect(done.role).toBe('eigenverbrauch');
    expect(done.label).toBe('Verbrauch decken');
    expect(done.duty?.kind).toBe('verbrauch-folgen');
  });

  it('nennt den ganzen Tag beim Namen und weist ihn als GEPLANT aus', () => {
    const { slots, phases: ph } = ganzerTag();
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(filmKicker(view)).toBe('Der ganze Tag');
    // Abgehakt heißt „so war es geplant" - nie „so ist es gelaufen".
    expect(filmPastNote(view)).toBe(
      'Bereits gelaufen — so war es geplant, nicht wie es gelaufen ist.',
    );
    expect(filmPastNote(view)).not.toMatch(/gemessen|tatsächlich|wirklich/);
  });

  it('bleibt ohne Vergangenheit exakt die Rest-des-Tages-Fassung (fail-soft)', () => {
    // Genau das, was eine ältere api liefert: nur der jüngste Lauf.
    const { slots, phases: ph } = build([
      ...run('eigenverbrauch', -0.5, 8),
      ...run('warten', 1.5, 8),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.past).toEqual([]);
    expect(filmKicker(view)).toBe('Heute noch');
    expect(filmPastNote(view)).toBeNull();
  });

  it('zeigt einen Tag ohne frühe Läufe ehrlich erst ab dem ersten Lauf', () => {
    // Der Optimierer lief erst mittags - der Vormittag hat schlicht keine
    // Slots. Der Film beginnt dort, wo geplant wurde, statt etwas zu erfinden.
    const { slots, phases: ph } = build([
      ...run('pv_speichern', -3, 8, { batteryKw: 6 }),
      ...run('eigenverbrauch', -0.5, 8),
    ]);
    const view = filmRows(ph, slots, 'eigenverbrauch', NOW);
    expect(view.past).toHaveLength(1);
    expect(view.past[0].label).toBe('Sonne speichern');
    expect(new Date(view.past[0].from).getHours()).toBe(16); // 19:20 - 3 h
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
    expect(text).toMatch(/^Jetzt Verbrauch decken bis \d{2}:\d{2} Uhr · danach Warten/);
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
    expect(filmLabel('warten', 'eigenverbrauch')).toBe('Warten');
    expect(filmLabel('pv_speichern', 'eigenverbrauch')).toBe('Sonne speichern');
    expect(filmLabel('eigenverbrauch', 'eigenverbrauch')).toBe('Verbrauch decken');
    expect(filmLabel('abregeln', 'eigenverbrauch')).toBe('Einspeisung pausieren');
  });

  it('bleibt sonst das geteilte Rollen-Vokabular, inklusive der Reserve-Art', () => {
    expect(filmLabel('verkaufen', 'direktvermarktung')).toBe('Zum Spitzenpreis verkaufen');
    expect(filmLabel('reserve_halten', 'eigenverbrauch', ['reserve_backup'])).toBe(
      'Reserve halten (Notstrom)',
    );
  });
});

// ---------------------------------------------------------------------------
// speicherKurzzeile — die Erzählzeile der Cockpit-Karte (PR 4, Konzept §4b)
// ---------------------------------------------------------------------------

describe('speicherKurzzeile (Warten nennt den Blick nach vorn)', () => {
  const row = (over: Partial<FilmRow>): FilmRow => ({
    phaseIndex: 0,
    role: 'verkaufen',
    kind: 'discharge',
    now: false,
    done: false,
    label: 'Zum Spitzenpreis verkaufen',
    time: '18:00–20:00 Uhr',
    from: new Date(2026, 7, 5, 18, 0).toISOString(),
    to: new Date(2026, 7, 5, 20, 0).toISOString(),
    sub: null,
    eur: null,
    einkauf: false,
    duty: null,
    ...over,
  });
  const view = (today: FilmRow[], tomorrow: FilmRow[] = []): FilmView => ({
    past: [],
    today,
    tomorrow,
    tomorrowSummary: null,
    empty: today.length === 0 ? 'leer' : null,
  });

  it('ein laufendes Warten wird zum Blick nach vorn — nie ein Leerlauf-Rätsel', () => {
    const v = view([
      row({ role: 'warten', kind: 'idle', now: true, label: 'Warten' }),
      row({}),
    ]);
    expect(speicherKurzzeile(v)).toMatch(
      /^Warten — als Nächstes: Zum Spitzenpreis verkaufen ab \d{2}:\d{2} Uhr\.$/,
    );
  });

  it('eine laufende Aktions-Phase bleibt WÖRTLICH die Kurzfassung', () => {
    const v = view([
      row({ role: 'pv_speichern', kind: 'charge', now: true, label: 'Sonne speichern' }),
      row({ label: 'Verbrauch decken', role: 'eigenverbrauch' }),
    ]);
    expect(speicherKurzzeile(v)).toBe(filmKurzfassung(v));
    expect(speicherKurzzeile(v)).toMatch(/^Jetzt Sonne speichern bis \d{2}:\d{2} Uhr · danach Verbrauch decken\.$/);
  });

  it('Warten ohne späteren Einsatz bleibt die ehrliche Kurzfassung', () => {
    const v = view([row({ role: 'warten', kind: 'idle', now: true, label: 'Warten' })]);
    expect(speicherKurzzeile(v)).toBe(filmKurzfassung(v));
  });

  it('ein NICHT laufendes Warten (Plan beginnt später) bleibt die Kurzfassung', () => {
    const v = view([
      row({ role: 'warten', kind: 'idle', now: false, label: 'Warten' }),
      row({}),
    ]);
    expect(speicherKurzzeile(v)).toBe(filmKurzfassung(v));
  });

  it('ohne Zeilen null — der Aufrufer fällt auf planSentence zurück', () => {
    expect(speicherKurzzeile(view([]))).toBeNull();
  });
});
