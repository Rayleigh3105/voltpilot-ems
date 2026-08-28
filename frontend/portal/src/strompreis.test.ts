import { describe, expect, it } from 'vitest';
import type { PricePoint } from './api';
import type { WhySlot } from './fahrplanWhy';
import type { ActiveMode } from './surface';
import {
  bezugspreisKontext,
  bezugspreisJetzt,
  FLACH_SPANNE_CT,
  gateStrompreis,
  KOPPLUNG_PREFIX,
  LEER_TEXT,
  MORGEN_NOTE,
  PRAEMIE_RUHT,
  TARIF_FEHLT_NOTE,
  planKopplung,
  praemieRuhtNote,
  preisUrteil,
  kurveBeschreibung,
  streifenFenster,
  strompreisView,
} from './strompreis';

/**
 * Der Börsenpreis-Streifen (vp-cockpit-unten-ux-n3, PR 1) — die pure
 * Ableitung erschöpfend: das D2-Urteil samt Grenzen und Deadband, die
 * Berliner Tages-Fensterung mit Jetzt/Vergangenheit/Morgen, die ehrlichen
 * Degradationen (leer, kein laufender Slot, Lücken), die Plan-Kopplung über
 * die EINE Fahrplan-Vokabel und das D1-Gating.
 *
 * Zeit-Fixtures nutzen LOKALE Konstruktoren in einem Fenster (06–21 Uhr), das
 * für jede plausible CI-Zeitzone (UTC…CEST) im selben Berliner Kalendertag
 * liegt; Uhrzeit-Ausgaben werden per Regex geprüft (der fahrplanFilm-Test-
 * Präzedenzfall), weil `hm()` bewusst die Lokalzeit des Geräts spricht.
 */

// Ein fester Tag, Stunden lokal — 12:00 als „jetzt"-Anker der meisten Fälle.
const DAY = (h: number, m = 0) => new Date(2026, 7, 5, h, m, 0, 0);

function slot(start: Date, ct: number | null, minutes = 15): PricePoint {
  return {
    ts: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    priceEurMwh: ct == null ? null : ct * 10,
  };
}

/** Ein simpler Vormittag→Abend-Tag: 06:00–20:45 in 15-min-Slots. */
function dayPoints(ctAt: (hour: number) => number | null): PricePoint[] {
  const out: PricePoint[] = [];
  for (let h = 6; h < 21; h++) {
    for (let q = 0; q < 4; q++) {
      out.push(slot(DAY(h, q * 15), ctAt(h + q / 4)));
    }
  }
  return out;
}

describe('preisUrteil (D2: Drittel + Deadband + Negativ)', () => {
  it('teilt die Tagesspanne in Drittel', () => {
    expect(preisUrteil(0, 0, 12)).toBe('guenstig');
    expect(preisUrteil(4, 0, 12)).toBe('guenstig'); // exakt 1/3 zählt noch als günstig
    expect(preisUrteil(4.1, 0, 12)).toBe('mittel');
    expect(preisUrteil(7.9, 0, 12)).toBe('mittel');
    expect(preisUrteil(8, 0, 12)).toBe('teuer'); // exakt 2/3 zählt schon als teuer
    expect(preisUrteil(12, 0, 12)).toBe('teuer');
  });

  it(`schweigt unter ${FLACH_SPANNE_CT} ct Spanne (kein Teuer/Günstig-Theater)`, () => {
    expect(preisUrteil(8, 6, 10.9)).toBe('flach');
    expect(preisUrteil(6, 6, 11)).toBe('guenstig'); // Spanne exakt 5 urteilt wieder
  });

  it('Negativpreis schlägt alles — auch eine flache Spanne', () => {
    expect(preisUrteil(-1, -2, 1)).toBe('negativ');
    expect(preisUrteil(-0.1, -3, 14)).toBe('negativ');
  });
});

describe('strompreisView (Fensterung + Ehrlichkeit)', () => {
  it('ohne heutige Preise: der ehrliche Leerzustand, nichts erfunden', () => {
    const v = strompreisView([], DAY(12));
    expect(v.state).toBe('leer');
    expect(v.jetztWert).toBeNull();
    expect(v.urteil).toBeNull();
    expect(v.anker).toBeNull();
    expect(v.bars).toEqual([]);
    expect(v.morgenNote).toBeNull();
    expect(LEER_TEXT).toContain('keine Börsenpreise');
  });

  it('Jetzt-Wert, Urteil und Anker aus der heutigen Serie', () => {
    // 06–10 Uhr 4 ct · 10–17 Uhr 1 ct (Tief) · 17–21 Uhr 13 ct (Hoch); jetzt 18:00.
    const pts = dayPoints((h) => (h < 10 ? 4 : h < 17 ? 1 : 13));
    const v = strompreisView(pts, DAY(18, 5));
    expect(v.state).toBe('bereit');
    expect(v.jetztWert).toBe('13,0 ct/kWh');
    expect(v.urteil).toBe('teuer');
    expect(v.urteilLabel).toBe('gerade teuer');
    expect(v.anker?.tief).toMatch(/^Tagestief 1,0 ct \(\d{2}:\d{2}\)$/);
    expect(v.anker?.hoch).toMatch(/^Tageshoch 13,0 ct \(\d{2}:\d{2}\)$/);
  });

  it('markiert genau den laufenden Slot und dimmt die Vergangenheit', () => {
    const pts = dayPoints(() => 8);
    const v = strompreisView(pts, DAY(12, 7));
    const jetzt = v.bars.filter((b) => b.jetzt);
    expect(jetzt).toHaveLength(1);
    // 12:07 läuft der 12:00-Slot; alles bis 12:00 (Ende <= jetzt) ist vergangen.
    const idx = v.bars.findIndex((b) => b.jetzt);
    expect(v.bars.slice(0, idx).every((b) => b.vergangen)).toBe(true);
    expect(v.bars.slice(idx).every((b) => !b.vergangen)).toBe(true);
  });

  it('flacher Tag: Urteil „heute kaum Schwankung", KEINE Anker', () => {
    const pts = dayPoints((h) => 8 + (h > 12 ? 2 : 0)); // Spanne 2 ct
    const v = strompreisView(pts, DAY(12));
    expect(v.urteil).toBe('flach');
    expect(v.urteilLabel).toBe('heute kaum Schwankung');
    expect(v.anker).toBeNull();
  });

  it('Negativpreis: eigener Zustand, hatNegativ für die Nulllinie', () => {
    const pts = dayPoints((h) => (h >= 11 && h < 14 ? -2 : 9));
    const v = strompreisView(pts, DAY(12, 10));
    expect(v.urteil).toBe('negativ');
    expect(v.urteilLabel).toBe('Negativpreis');
    expect(v.jetztWert).toBe('-2,0 ct/kWh');
    expect(v.hatNegativ).toBe(true);
  });

  it('gestern wird verworfen, morgen hängt blass hinter dem Trenner', () => {
    const yesterday = slot(new Date(2026, 7, 4, 12, 0), 5);
    const today = dayPoints(() => 8);
    const tomorrow = [slot(new Date(2026, 7, 6, 10, 0), 6), slot(new Date(2026, 7, 6, 10, 15), 7)];
    const v = strompreisView([yesterday, ...today, ...tomorrow], DAY(12));
    expect(v.bars).toHaveLength(today.length + tomorrow.length);
    expect(v.morgenAb).toBe(today.length);
    expect(v.bars[v.morgenAb].tag).toBe('morgen');
    expect(v.morgenNote).toBeNull();
  });

  it('morgen fehlt: die ruhige Notiz nur VOR ~14 Uhr Berlin', () => {
    const pts = dayPoints(() => 8);
    expect(strompreisView(pts, DAY(9)).morgenNote).toBe(MORGEN_NOTE);
    // 20:00 lokal liegt für UTC…CEST-Maschinen nach 14 Uhr Berlin — nichts
    // mehr versprechen, den wahren Grund kennt der Client nicht.
    expect(strompreisView(pts, DAY(20)).morgenNote).toBeNull();
  });

  it('kein laufender Slot (Plan-Lücke um jetzt): Wert und Urteil entfallen, die Kurve bleibt', () => {
    // Nur Vormittags-Slots; „jetzt" ist am Abend.
    const pts: PricePoint[] = [];
    for (let h = 6; h < 12; h++) for (let q = 0; q < 4; q++) pts.push(slot(DAY(h, q * 15), h < 9 ? 2 : 9));
    const v = strompreisView(pts, DAY(19));
    expect(v.state).toBe('bereit');
    expect(v.jetztWert).toBeNull();
    expect(v.urteil).toBeNull();
    expect(v.anker).not.toBeNull();
    expect(v.bars.length).toBe(pts.length);
  });

  it('ein Slot ohne Preis bleibt eine Lücke — nie eine 0', () => {
    const pts = [slot(DAY(10), 8), slot(DAY(10, 15), null), slot(DAY(10, 30), 9)];
    const v = strompreisView(pts, DAY(10, 5));
    expect(v.bars[1].ct).toBeNull();
    // Die Lücke drückt weder Tief noch Hoch.
    expect(v.anker).toBeNull(); // Spanne 1 ct → flach; entscheidend: kein Absturz
    expect(v.bars).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Plan-Kopplung
// ---------------------------------------------------------------------------

function wslot(start: Date, role: string | null, flags: string[] | null = null): WhySlot {
  return {
    start: start.toISOString(),
    batteryKw: role === 'verkaufen' ? -4 : role === 'pv_speichern' ? 4 : 0,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: role,
    slotFlags: flags,
  };
}

/** n Slots à 15 min ab `start`, Rollen der Reihe nach aus `roles`. */
function planOf(start: Date, roles: (string | null)[], flags?: (string[] | null)[]): WhySlot[] {
  return roles.map((r, i) =>
    wslot(new Date(start.getTime() + i * 15 * 60_000), r, flags?.[i] ?? null),
  );
}

describe('planKopplung (die Fahrplan-Zeile des Streifens)', () => {
  const now = DAY(12, 20); // im zweiten Slot eines 12:00-Plans

  it('laufende Aktions-Phase: „Jetzt {Label} — noch bis HH:MM"', () => {
    const slots = planOf(DAY(12), ['verkaufen', 'verkaufen', 'verkaufen', 'warten']);
    const k = planKopplung(slots, now, 15, 'direktvermarktung', false);
    expect(k?.pre).toBe('Jetzt ');
    expect(k?.action).toBe('Zum Spitzenpreis verkaufen');
    expect(k?.post).toMatch(/^ — noch bis \d{2}:\d{2}$/);
  });

  it('spricht die Anlagen-Art: eigenverbrauch sagt „Einspeisen"', () => {
    const slots = planOf(DAY(12), ['verkaufen', 'verkaufen', 'verkaufen']);
    const k = planKopplung(slots, now, 15, 'eigenverbrauch', false);
    expect(k?.action).toBe('Einspeisen');
  });

  it('Abregeln im Negativpreis: „— nicht draufzahlen" statt der Uhrzeit', () => {
    const slots = planOf(DAY(12), ['abregeln', 'abregeln', 'abregeln']);
    expect(planKopplung(slots, now, 15, 'direktvermarktung', true)).toEqual({
      pre: 'Jetzt ',
      action: 'Einspeisung pausieren',
      post: ' — nicht draufzahlen',
    });
    // Ohne Negativpreis bleibt die ehrliche Uhrzeit.
    expect(planKopplung(slots, now, 15, 'direktvermarktung', false)?.post).toMatch(
      /^ — noch bis \d{2}:\d{2}$/,
    );
  });

  it('Ruhe mit späterer Aktion: „Ruhe — ab HH:MM {Label}" (worauf er wartet)', () => {
    const slots = planOf(DAY(12), ['warten', 'warten', 'warten', 'verkaufen', 'verkaufen', 'verkaufen']);
    const k = planKopplung(slots, now, 15, 'direktvermarktung', false);
    expect(k?.pre).toMatch(/^Ruhe — ab \d{2}:\d{2} $/);
    expect(k?.action).toBe('Zum Spitzenpreis verkaufen');
    expect(k?.post).toBeNull();
  });

  it('vereinigt bei DV Verbrauchsdeckung und anschließenden Überschussverkauf', () => {
    const slots = planOf(DAY(12), [
      'warten',
      'warten',
      'warten',
      'eigenverbrauch',
      'eigenverbrauch',
      'verkaufen',
      'verkaufen',
    ]);
    const k = planKopplung(slots, now, 15, 'direktvermarktung', false);
    expect(k?.action).toBe('Speicher nutzen: Verbrauch decken und Überschuss verkaufen');
  });

  it('Ruhe ohne spätere Aktion: „Jetzt Ruhe — noch bis HH:MM"', () => {
    const slots = planOf(DAY(12), ['warten', 'warten', 'warten']);
    const k = planKopplung(slots, now, 15, 'direktvermarktung', false);
    expect(k?.pre).toBe('Jetzt ');
    expect(k?.action).toBe('Ruhe');
    expect(k?.post).toMatch(/^ — noch bis \d{2}:\d{2}$/);
  });

  it('Reserve halten ist keine Ruhe: die Reserve wird beim Namen genannt', () => {
    const flags = [['reserve_backup'], ['reserve_backup'], ['reserve_backup']] as string[][];
    const slots = planOf(DAY(12), ['reserve_halten', 'reserve_halten', 'reserve_halten'], flags);
    const k = planKopplung(slots, now, 15, 'direktvermarktung', false);
    expect(k?.action).toBe('Reserve halten (Notstrom)');
  });

  it('ohne Warum-Ebene (eine unbekannte Rolle) gibt es KEINE Kopplung', () => {
    const slots = planOf(DAY(12), ['verkaufen', null, 'verkaufen']);
    expect(planKopplung(slots, now, 15, 'direktvermarktung', false)).toBeNull();
  });

  it('ein toter Plan wird nie als „Jetzt" zitiert', () => {
    const slots = planOf(DAY(6), ['verkaufen', 'verkaufen']); // Horizont längst vorbei
    expect(planKopplung(slots, now, 15, 'direktvermarktung', false)).toBeNull();
    expect(planKopplung([], now, 15, 'direktvermarktung', false)).toBeNull();
  });

  it('der Vorspann ist die eine Konstante', () => {
    expect(KOPPLUNG_PREFIX).toBe('Ihr Fahrplan: ');
  });
});

// ---------------------------------------------------------------------------
// Zweitzeile + Notizen + Gating
// ---------------------------------------------------------------------------

describe('bezugspreisJetzt (D3: die eine Preis-Wahrheit, nie nachgerechnet)', () => {
  it('dynamischer Tarif + Slot-Wert → „32,5 ct/kWh"', () => {
    expect(bezugspreisJetzt('dynamisch', { importPriceCtKwh: 32.5 })).toBe('32,5 ct/kWh');
  });
  it('zeigt auch Festpreis und Spot-Fallback — eine bezogene kWh hat immer einen Preis', () => {
    expect(bezugspreisJetzt('fest', { importPriceCtKwh: 32.5, importPriceSource: 'fest' })).toBe('32,5 ct/kWh');
    expect(bezugspreisJetzt('ohne', { importPriceCtKwh: 10.6, importPriceSource: 'spot' })).toBe('10,6 ct/kWh');
  });
  it('älterer Lauf ohne Wert → wortlos keine Zeile', () => {
    expect(bezugspreisJetzt('dynamisch', { importPriceCtKwh: null })).toBeNull();
    expect(bezugspreisJetzt('dynamisch', null)).toBeNull();
  });

  it('trennt Bezugspreis, Aufschlüsselung und fehlenden Tarif sichtbar', () => {
    expect(
      bezugspreisKontext('dynamisch', {
        start: DAY(12).toISOString(),
        priceEurMwh: 106,
        importPriceCtKwh: 29.4,
        importPriceSource: 'preisblatt',
      }),
    ).toEqual({
      wert: '29,4 ct/kWh',
      detail: '(Börsenpreis 10,6 + Netzentgelte/Abgaben 18,8)',
      warning: null,
    });
    expect(
      bezugspreisKontext('ohne', {
        start: DAY(12).toISOString(),
        priceEurMwh: 106,
        importPriceCtKwh: 10.6,
        importPriceSource: 'spot',
      }),
    ).toEqual({ wert: '10,6 ct/kWh', detail: null, warning: TARIF_FEHLT_NOTE });
  });
});

describe('praemieRuhtNote (§ 51 nur wo es eine Prämie gibt)', () => {
  it('Negativpreis + Direktvermarktung → die eine Zeile', () => {
    expect(praemieRuhtNote('negativ', true)).toBe(PRAEMIE_RUHT);
  });
  it('ohne DV keine Prämie, ohne Negativpreis kein Ruhen', () => {
    expect(praemieRuhtNote('negativ', false)).toBeNull();
    expect(praemieRuhtNote('teuer', true)).toBeNull();
    expect(praemieRuhtNote(null, true)).toBeNull();
  });
});

describe('gateStrompreis (D1: die Marktpreise-Regel, keine neue Signalmenge)', () => {
  const markt = { kind: 'marktvermarktung' } as ActiveMode;
  const peak = { kind: 'lastspitzenkappung' } as ActiveMode;
  it('Markt-Modus ODER dynamischer Tarif zeigen den Streifen', () => {
    expect(gateStrompreis([markt], 'fest')).toBe(true);
    expect(gateStrompreis([], 'dynamisch')).toBe(true);
    expect(gateStrompreis([markt], 'dynamisch')).toBe(true);
  });
  it('eine Festpreis-Anlage ohne Markt-Modus sieht ihn nicht', () => {
    expect(gateStrompreis([], 'fest')).toBe(false);
    expect(gateStrompreis([peak], 'ohne')).toBe(false);
    expect(gateStrompreis([], null)).toBe(false);
  });
});

describe('streifenFenster (Stufe 4: dieselbe Preis-Grammatik wie die Marktseite)', () => {
  /** Mittags gratis, abends teuer - genug Struktur für zwei Fenster. */
  const strukturiert = () =>
    dayPoints((h) => (h >= 12 && h < 14.5 ? -1 : h >= 18 && h < 20.5 ? 21 : 12));

  it('benennt zusammenhängende Fenster MIT Wort und Zeitraum', () => {
    const view = strompreisView(strukturiert(), DAY(12, 30));
    const f = streifenFenster(view);
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.wort.length).toBeGreaterThan(3);
      expect(x.zeit).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
      expect(x.bis).toBeGreaterThan(x.von);
    }
    expect(f.map((x) => x.art)).toContain('negativ');
    expect(f.map((x) => x.art)).toContain('teuer');
  });

  it('nennt nirgends das Fallenwort „Viertel"', () => {
    const f = streifenFenster(strompreisView(strukturiert(), DAY(12, 30)));
    expect(f.map((x) => x.wort).join(' ')).not.toMatch(/Viertel/);
  });

  it('behauptet auf einem flachen Tag gar kein Fenster', () => {
    const view = strompreisView(dayPoints(() => 12), DAY(12, 30));
    expect(streifenFenster(view)).toEqual([]);
  });

  it('greift nie über die Tagesgrenze hinaus', () => {
    const heute = strukturiert();
    const morgen = heute.map((p) => ({
      ...p,
      ts: new Date(new Date(p.ts).getTime() + 86400_000).toISOString(),
      end: new Date(new Date(p.end).getTime() + 86400_000).toISOString(),
      priceEurMwh: -500,
    }));
    const view = strompreisView([...heute, ...morgen], DAY(12, 30));
    expect(view.morgenAb).toBeGreaterThan(0);
    for (const f of streifenFenster(view)) {
      expect(f.bis).toBeLessThan(view.morgenAb);
    }
  });
});

describe('kurveBeschreibung (die Kurve war für Vorlesesoftware nicht vorhanden)', () => {
  it('nennt Zeitraum, Anker und jedes benannte Fenster', () => {
    const view = strompreisView(
      dayPoints((h) => (h >= 12 && h < 14.5 ? -1 : h >= 18 && h < 20.5 ? 21 : 12)),
      DAY(12, 30),
    );
    const text = kurveBeschreibung(view);
    expect(text).toMatch(/^Börsenpreis-Verlauf für heute/);
    expect(text).toMatch(/Tagestief/);
    expect(text).toMatch(/Tageshoch/);
    expect(text).toMatch(/Strom kostet nichts/);
  });

  it('behauptet ohne Anker und ohne Fenster nur den Zeitraum', () => {
    const view = strompreisView(dayPoints(() => 12), DAY(12, 30));
    expect(kurveBeschreibung(view)).toBe('Börsenpreis-Verlauf für heute.');
  });
});
