import { describe, expect, it, vi } from 'vitest';

import vektoren from './test/fixtures/speicherAussage.vektoren.json';
import { NBSP } from './format';
import {
  MESSLATTE,
  MESSLATTE_DATIV,
  OHNE_VERGLEICH_SATZ,
  speicherAussage,
  type SpeicherEingabe,
} from './speicherAussage';

/**
 * ⚠ **DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG** (Captain
 * 04.09.2026, wörtlich zum Screenshot der Live-Anlage Pilsting/Herzogau: „Das
 * ist doch Quatsch, du musst Anlage immer mit Speicher berechnen, einer halt
 * ohne smart Steuerung.").
 *
 * Die 15 Fixtures des Erlöse-Konzepts (`vp-erloese-seite-konzept-e2`) reisen
 * weiter als EINGABEN — es sind echte, aus Live-Zahlen abgeleitete Fälle. Ihre
 * `erwartet`-Blöcke sind entfallen: sie beschrieben die zweizeilige Form („Ihr
 * Speicher hat … gebracht" über „davon Steuerung"), die der Captain gestrichen
 * hat.
 */
interface Vektor {
  id: string;
  titel: string;
  now: string;
  steuerungGeplantEur: number | null;
  money: Record<string, unknown>;
}

const FIXTURES = (vektoren as { fixtures: Vektor[] }).fixtures;

/** Jeder Betrag trägt ein GESCHÜTZTES Leerzeichen vor dem €. */
const nb = (s: string) => s.replace(/ €/g, `${NBSP}€`);

function ausVektor(v: Vektor) {
  const a = speicherAussage(v.money as SpeicherEingabe, {
    now: new Date(v.now),
    steuerungGeplantEur: v.steuerungGeplantEur,
  });
  if (!a) throw new Error(`speicherAussage() lieferte null für ${v.id}`);
  return a;
}

const NOW = new Date('2026-09-02T12:19:00+02:00');
const ABGESCHLOSSEN = '2026-09-01T22:00:00Z';
const LAEUFT = '2026-09-02T22:00:00Z';

/** Eine konsistente Eingabe: `savedSpeicherEur + savedSteuerungEur == savedEur`. */
function eingabe(patch: Partial<SpeicherEingabe> = {}): SpeicherEingabe {
  return {
    savedEur: 92.02,
    savedSpeicherEur: 48.37,
    savedSteuerungEur: 43.65,
    steuerungSplitReason: null,
    range: 'month',
    to: ABGESCHLOSSEN,
    ...patch,
  } as SpeicherEingabe;
}

function ausw(patch: Partial<SpeicherEingabe> = {}, now = NOW) {
  const a = speicherAussage(eingabe(patch), { now });
  if (!a) throw new Error('speicherAussage() lieferte null');
  return a;
}

describe('speicherAussage — DIE Zahl ist der Steuerungs-Mehrwert', () => {
  it('zeigt `savedSteuerungEur`, nie die Gesamtzahl', () => {
    const a = ausw();
    expect(a.steuerung).toEqual({ eur: 43.65, ton: 'plus', wort: nb('+ 43,65 €') });
    expect(a.wert).toBe(nb('+ 43,65 €'));
    // Die Gesamtzahl des Screenshots taucht NIRGENDS auf.
    const alles = [a.wert, a.satz, a.kurz, a.kurzTitel, a.label, a.chip, a.geplant]
      .filter(Boolean)
      .join(' | ');
    expect(alles).not.toContain('92,02');
    expect(alles).not.toContain('48,37');
  });

  it('nennt die Messlatte im Satz — und nie „ohne Speicher"', () => {
    const a = ausw();
    expect(a.satz).toBe(`Die Steuerung hat in diesem Zeitraum ${nb('+ 43,65 €')} gebracht — gegenüber ${MESSLATTE_DATIV}`);
    expect(a.satz).not.toMatch(/ohne Speicher/);
  });

  it('sagt beim Minus auf einem LAUFENDEN Zeitraum „Zwischenstand" und WARUM', () => {
    const a = ausw({ savedEur: -2.67, savedSpeicherEur: -4.12, savedSteuerungEur: 1.45, to: LAEUFT });
    expect(a.zwischenstand).toBe(true);
    expect(a.chip).toBe('Zwischenstand');
    expect(a.anzeigeTon).toBe('neutral');

    const b = ausw({ savedEur: -6.79, savedSpeicherEur: -4.12, savedSteuerungEur: -2.67, to: LAEUFT });
    expect(b.satz).toContain('Zwischenstand Steuerung');
    expect(b.satz).toContain('hält Energie für später');
    expect(b.anzeigeTon).toBe('neutral');
  });

  it('ist auf einem ABGESCHLOSSENEN Minus „unter Null" und bernstein', () => {
    const a = ausw({ savedEur: 45.7, savedSpeicherEur: 48.37, savedSteuerungEur: -2.67 });
    expect(a.chip).toBe('unter Null');
    expect(a.anzeigeTon).toBe('warn');
    expect(a.satz).toContain(`weniger als ${MESSLATTE_DATIV}`);
  });

  it('sagt beim Gleichstand „gleichauf" und bleibt neutral', () => {
    const a = ausw({ savedEur: 48.37, savedSpeicherEur: 48.37, savedSteuerungEur: 0 });
    expect(a.steuerung?.ton).toBe('null');
    expect(a.anzeigeTon).toBe('neutral');
    expect(a.satz).toBe(`Die Steuerung und ${MESSLATTE} liegen in diesem Zeitraum gleichauf.`);
  });

  it('trägt das Label des Zeitraums', () => {
    expect(ausw({ range: 'day', to: LAEUFT }).label).toBe('Steuerung heute');
    expect(ausw({ range: 'month', to: LAEUFT }).label).toBe('Steuerung bisher');
    expect(ausw({ range: 'day' }).label).toBe('Steuerung an diesem Tag');
    expect(ausw({ range: 'month' }).label).toBe('Steuerung im Zeitraum');
  });
});

describe('speicherAussage — ohne Vergleich gibt es KEINE Zahl', () => {
  it('nennt bei fehlenden Stammdaten den GRUND und bietet den Nachtrag an', () => {
    const a = ausw({ savedSpeicherEur: null, savedSteuerungEur: null, steuerungSplitReason: 'no_battery_data' });
    expect(a.steuerung).toBeNull();
    expect(a.wert).toBe('—');
    expect(a.ohneVergleich).toBe(OHNE_VERGLEICH_SATZ);
    expect(a.hinweis).toBe('Speicher-Daten fehlen ›');
    expect(a.nachtragLink).toBe(true);
    expect(a.hatAussage).toBe(true);
    // Die Gesamtzahl ist ausdrücklich KEIN Ersatz.
    expect([a.wert, a.satz, a.kurz, a.ohneVergleich].join(' | ')).not.toContain('92,02');
  });

  it('schweigt bei einem ÄLTEREN Backend ganz — ein fehlendes FELD ist kein fehlendes STAMMDATUM', () => {
    const a = speicherAussage(
      { savedEur: 92.02, range: 'month', to: ABGESCHLOSSEN } as SpeicherEingabe,
      { now: NOW },
    );
    expect(a).toBeNull();
  });

  it('behauptet nichts, wenn die Prüfsumme nicht aufgeht', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = speicherAussage(
      eingabe({ savedSpeicherEur: 10, savedSteuerungEur: 5 }),
      { now: NOW },
    );
    expect(a).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('liefert gar nichts ohne berechenbare Kasse', () => {
    expect(speicherAussage({ savedEur: null } as SpeicherEingabe, { now: NOW })).toBeNull();
    expect(speicherAussage(null, { now: NOW })).toBeNull();
  });
});

describe('speicherAussage — die Plan-Zeile', () => {
  it('bleibt ohne `steuerungPlannedEur` WEG', () => {
    expect(ausw().geplant).toBeNull();
    const a = speicherAussage(eingabe(), { now: NOW, steuerungGeplantEur: null });
    expect(a?.geplant).toBeNull();
  });

  it('nennt mit dem Feld den geplanten Mehrwert DER STEUERUNG', () => {
    const a = speicherAussage(eingabe(), { now: NOW, steuerungGeplantEur: 12.8 });
    expect(a?.geplant).toBe(`Vorab geplant hatte der Fahrplan ${nb('+ 12,80 €')} durch die Steuerung`);
  });
});

describe('speicherAussage — die Kurzform von Cockpit und Steuerungs-Bereich', () => {
  it('ist EINE Zeile mit derselben Zahl wie die Langform', () => {
    expect(ausw().kurz).toBe(nb('Steuerung + 43,65 €'));
    expect(ausw({ to: LAEUFT }).kurz).toBe(nb('Zwischenstand Steuerung + 43,65 €'));
    expect(ausw().kurzTitel).toBe(ausw().satz);
  });

  it('sagt ohne Vergleich „—" und trägt den Grund als Tooltip', () => {
    const a = ausw({ savedSpeicherEur: null, savedSteuerungEur: null, steuerungSplitReason: 'no_battery_data' });
    expect(a.kurz).toBe('Steuerung —');
    expect(a.kurzTitel).toBe(OHNE_VERGLEICH_SATZ);
  });
});

describe('speicherAussage — die 15 Konzept-Fixtures', () => {
  it.each(FIXTURES.map((v) => [v.id, v] as const))('%s spiegelt genau den Server-Wert', (_id, v) => {
    const a = ausVektor(v);
    const erwartet = v.money.savedSteuerungEur as number | null | undefined;
    if (typeof erwartet === 'number') {
      expect(a.steuerung?.eur).toBe(erwartet);
    } else {
      expect(a.steuerung).toBeNull();
    }
  });

  it('nennt in KEINEM Fixture die Anlage ohne Speicher', () => {
    for (const v of FIXTURES) {
      const a = ausVektor(v);
      const text = [a.satz, a.kurz, a.kurzTitel, a.label, a.chip, a.geplant, a.ohneVergleich]
        .filter(Boolean)
        .join(' | ');
      expect(text, v.id).not.toMatch(/ohne Speicher\b/);
      expect(text, v.id).not.toMatch(/ungeregelt/i);
      expect(text, v.id).not.toMatch(/Speicher gesamt/);
    }
  });

  it('zeigt in KEINEM Fixture die Gesamtzahl als Betrag', () => {
    for (const v of FIXTURES) {
      const gesamt = v.money.savedEur as number | null;
      const steuerung = v.money.savedSteuerungEur as number | null | undefined;
      if (gesamt == null || typeof steuerung !== 'number') continue;
      if (Math.abs(gesamt - steuerung) < 0.005) continue;
      const a = ausVektor(v);
      const betrag = Math.abs(gesamt).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect([a.wert, a.satz, a.kurz].filter(Boolean).join(' | '), v.id).not.toContain(betrag);
    }
  });
});
