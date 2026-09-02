import { describe, expect, it, vi } from 'vitest';

import vektoren from './test/fixtures/speicherAussage.vektoren.json';
import { NBSP } from './format';
import {
  speicherAussage,
  type SpeicherAussage,
  type SpeicherEingabe,
} from './speicherAussage';

/**
 * Die 15 Fixtures des Erlöse-Konzepts (`vp-erloese-seite-konzept-e2`,
 * `derived.json` → `neu.speicher`) sind die ERWARTUNG dieser Ableitung: der
 * Generator des Konzepts wird damit zum Test des Codes (§5, Beweis-Pflicht 1).
 *
 * ⚠ Verglichen wird eine PROJEKTION auf genau die elf Felder, die das Konzept
 * ableitet. Die Aussage trägt zusätzlich die ANZEIGE-Felder (E8-Ton, die
 * Revision-2-Chips, die Kurzform) — sie sind neu und haben im Konzept-JSON
 * keine Entsprechung; sie stehen in eigenen Fällen weiter unten.
 */
interface Vektor {
  id: string;
  titel: string;
  now: string;
  geplantEur: number | null;
  money: Record<string, unknown>;
  erwartet: Record<string, unknown>;
}

const FIXTURES = (vektoren as { fixtures: Vektor[] }).fixtures;

/**
 * Jeder Betrag trägt ein GESCHÜTZTES Leerzeichen vor dem € (`eurAmount`), damit
 * Zahl und Einheit nie umbrechen. In den Erwartungen steht es lesbar als
 * normales Leerzeichen und wird hier eingesetzt.
 */
const nb = (s: string) => s.replace(/ €/g, `${NBSP}€`);

/** Genau die Felder, die `derived.json` unter `neu.speicher` führt. */
function konzeptForm(a: SpeicherAussage) {
  return {
    gesamt: a.gesamt,
    stur: a.stur,
    steuerung: a.steuerung,
    splitReason: a.splitReason,
    zwischenstand: a.zwischenstand,
    satz: a.satz,
    steuerungSatz: a.steuerungSatz,
    bestand: a.bestand,
    bestandBadge: a.bestandBadge,
    geplant: a.geplant,
    anker: a.anker,
  };
}

function ausVektor(v: Vektor): SpeicherAussage {
  const a = speicherAussage(v.money as SpeicherEingabe, {
    now: new Date(v.now),
    geplantEur: v.geplantEur,
  });
  expect(a, `${v.id}: die Ableitung darf hier nicht null sein`).not.toBeNull();
  return a as SpeicherAussage;
}

describe('speicherAussage — die 15 Konzept-Fixtures als Vektoren', () => {
  it('deckt alle 15 Fixtures ab', () => {
    expect(FIXTURES).toHaveLength(15);
  });

  for (const v of FIXTURES) {
    it(`${v.id} — ${v.titel}`, () => {
      expect(konzeptForm(ausVektor(v))).toEqual(v.erwartet);
    });
  }
});

/* ---------------------------------------------------------------------------
 * Die Zustände (§3.5) — jeder mit seinem Ton (E8) und seinen Chips (Rev. 2)
 * ------------------------------------------------------------------------- */

const BASIS: SpeicherEingabe = {
  savedEur: 12.4,
  savedSpeicherEur: 9.3,
  savedSteuerungEur: 3.1,
  steuerungSplitReason: null,
  range: 'day',
  to: '2026-09-01T22:00:00Z',
  plantKind: 'eigenverbrauch',
};
const NOW = new Date('2026-09-02T12:19:00+02:00');

function ausw(patch: Partial<SpeicherEingabe>, laeuft?: boolean): SpeicherAussage {
  const a = speicherAussage({ ...BASIS, ...patch }, { now: NOW, laeuft });
  expect(a).not.toBeNull();
  return a as SpeicherAussage;
}

describe('Ton nach E8 — nie Grün auf einem Zwischenstand, nie Rot auf einem Minus', () => {
  it('abgeschlossen und positiv ist ok, ohne Chip', () => {
    const a = ausw({});
    expect(a.anzeigeTon).toBe('ok');
    expect(a.steuerungTon).toBe('ok');
    expect(a.gesamtChip).toBeNull();
    expect(a.zwischenstand).toBe(false);
  });

  it('laufend ist IMMER neutral — auch wenn die Zahl positiv ist', () => {
    const a = ausw({ to: '2026-09-02T22:00:00Z' });
    expect(a.anzeigeTon).toBe('neutral');
    expect(a.steuerungTon).toBe('neutral');
    expect(a.gesamtChip).toBe('Zwischenstand');
  });

  it('abgeschlossen und negativ ist warn mit dem Chip „unter Null" — nie Rot-Vokabular', () => {
    const a = ausw({ savedEur: -0.4, savedSpeicherEur: -0.1, savedSteuerungEur: -0.3 });
    expect(a.anzeigeTon).toBe('warn');
    expect(a.gesamtChip).toBe('unter Null');
    expect(a.satz).toBe(
      nb('Ihr Speicher hat an diesem Tag − 0,40 € gebracht — weniger als eine Anlage ohne Speicher.'),
    );
  });

  it('eine Zahl im Totband behauptet keine Richtung', () => {
    const a = ausw({ savedEur: 0.002, savedSpeicherEur: 0.001, savedSteuerungEur: 0.001 });
    expect(a.anzeigeTon).toBe('neutral');
    expect(a.gesamt.ton).toBe('null');
    expect(a.gesamt.wort).toBe(nb('0,00 €'));
  });
});

describe('Zeile 2 — die vier Lagen der Steuerungs-Zahl', () => {
  it('Steuerung positiv nennt den sturen Speicher als Maßstab', () => {
    expect(ausw({}).steuerungSatz).toBe(
      nb('davon + 3,10 € durch VoltPilots Steuerung — gegenüber einem stur arbeitenden Speicher (+ 9,30 €)'),
    );
  });

  it('Steuerung negativ sagt es ehrlich — sie hält Energie für später', () => {
    const a = ausw({ savedEur: 9.0, savedSpeicherEur: 9.3, savedSteuerungEur: -0.3 });
    expect(a.steuerungSatz).toBe(
      nb('Zwischenstand Steuerung: − 0,30 € gegenüber einem stur arbeitenden Speicher (+ 9,30 €) — er hält Energie für später'),
    );
    expect(a.steuerungTon).toBe('warn');
  });

  it('Steuerung ≈ 0 heißt „gleichauf", nie eine erfundene 0-Zurechnung', () => {
    const a = ausw({ savedEur: 9.3, savedSpeicherEur: 9.3, savedSteuerungEur: 0 });
    expect(a.steuerungSatz).toBe(
      nb('Steuerung und sturer Speicher liegen an diesem Tag gleichauf (+ 9,30 €)'),
    );
    expect(a.steuerungTon).toBe('neutral');
  });

  it('laufend + gleichauf nennt den laufenden Zeitraum', () => {
    const a = ausw(
      { savedEur: 9.3, savedSpeicherEur: 9.3, savedSteuerungEur: 0, range: 'month' },
      true,
    );
    expect(a.steuerungSatz).toBe(
      nb('Steuerung und sturer Speicher liegen in diesem Zeitraum bisher gleichauf (+ 9,30 €)'),
    );
  });

  it('ohne Batterie-Stammdaten nennt den WEG und verlinkt — Zeile 1 bleibt ehrlich stehen', () => {
    const a = ausw({
      savedSpeicherEur: null,
      savedSteuerungEur: null,
      steuerungSplitReason: 'no_battery_data',
    });
    expect(a.stur).toBeNull();
    expect(a.steuerung).toBeNull();
    expect(a.splitReason).toBe('no_battery_data');
    expect(a.steuerungWert).toBe('—');
    expect(a.steuerungChip).toBe('Speicher-Daten fehlen ›');
    expect(a.nachtragLink).toBe(true);
    expect(a.satz).toContain(nb('+ 12,40 €'));
  });
});

describe('ein älteres Backend — ein fehlendes FELD ist kein fehlendes STAMMDATUM', () => {
  it('ohne die drei Felder gibt es nur Zeile 1, keinen Grund und keinen Nachtrag-Link', () => {
    const a = speicherAussage(
      { savedEur: 12.4, range: 'day', to: '2026-09-01T22:00:00Z', plantKind: 'eigenverbrauch' },
      { now: NOW },
    );
    expect(a).not.toBeNull();
    expect(a?.stur).toBeNull();
    expect(a?.steuerung).toBeNull();
    expect(a?.splitReason).toBeNull();
    expect(a?.steuerungSatz).toBeNull();
    expect(a?.steuerungChip).toBeNull();
    expect(a?.nachtragLink).toBe(false);
    expect(a?.kurz).toBe(nb('Speicher + 12,40 €'));
  });

  it('ohne savedEur gibt es gar keine Aussage — nie eine erfundene 0', () => {
    expect(speicherAussage({ savedEur: null }, { now: NOW })).toBeNull();
    expect(speicherAussage(null, { now: NOW })).toBeNull();
  });
});

describe('der Identitäts-Wächter — nie zwei Zahlen, die nicht aufgehen', () => {
  it('lässt Zeile 2 weg und protokolliert, wenn die Summe nicht aufgeht', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = ausw({ savedEur: 12.4, savedSpeicherEur: 9.3, savedSteuerungEur: 1.0 });
    expect(a.stur).toBeNull();
    expect(a.steuerung).toBeNull();
    expect(a.steuerungSatz).toBeNull();
    // Kein erfundener Grund: die Stammdaten fehlen ja NICHT.
    expect(a.splitReason).toBeNull();
    expect(a.nachtragLink).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('duldet einen halben Cent Gleitkomma-Reise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = ausw({ savedEur: 12.4, savedSpeicherEur: 9.3, savedSteuerungEur: 3.102 });
    expect(a.steuerung?.eur).toBe(3.102);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('die Kurzform — Cockpit und Steuerungs-Bereich sagen dasselbe', () => {
  it('trägt beide Ebenen in EINER Zeile', () => {
    expect(ausw({}).kurz).toBe(nb('Speicher + 12,40 € · davon Steuerung + 3,10 €'));
  });

  it('nennt den Zwischenstand, solange der Zeitraum läuft', () => {
    const a = ausw({ to: '2026-09-02T22:00:00Z' });
    expect(a.kurz).toBe(nb('Zwischenstand Speicher + 12,40 € · davon Steuerung + 3,10 €'));
  });

  it('der Tooltip trägt den vollen Wortlaut beider Zeilen', () => {
    const a = ausw({});
    expect(a.kurzTitel).toBe(`${a.satz} · ${a.steuerungSatz}`);
  });

  it('der Bildschirm-Fall des Konzepts liest sich wie der Captain-Satz', () => {
    const v = FIXTURES.find((f) => f.id === 'dv-tag-laufend') as Vektor;
    expect(ausVektor(v).kurz).toBe(
      nb('Zwischenstand Speicher − 2,67 € · davon Steuerung + 1,45 €'),
    );
  });
});

describe('das Label der Zeile 1 bleibt bei 1–3 Wörtern (Textbudget §3.12)', () => {
  it.each([
    [{ range: 'day' as const }, false, 'Speicher an diesem Tag'],
    [{ range: 'day' as const }, true, 'Speicher heute'],
    [{ range: 'month' as const }, false, 'Speicher im Zeitraum'],
    [{ range: 'month' as const }, true, 'Speicher bisher'],
  ])('%o laeuft=%s → %s', (patch, laeuft, erwartet) => {
    expect(ausw(patch, laeuft).gesamtLabel).toBe(erwartet);
  });
});

describe('eine Flotten-Zeile ohne Fensterende behauptet keinen Zwischenstand', () => {
  it('fällt auf „abgeschlossen" zurück statt einen laufenden Zeitraum zu erfinden', () => {
    const a = speicherAussage(
      { savedEur: 12.4, savedSpeicherEur: 9.3, savedSteuerungEur: 3.1 },
      { now: NOW },
    );
    expect(a?.zwischenstand).toBe(false);
    expect(a?.gesamtLabel).toBe('Speicher im Zeitraum');
  });
});

describe('hatAussage — nie eine Speicher-Zeile über nichts', () => {
  it('ist false, wenn die Gesamtzahl im Totband liegt und es keine Aufteilung gibt', () => {
    const a = speicherAussage(
      { savedEur: 0.002, range: 'day', to: '2026-09-01T22:00:00Z' },
      { now: NOW },
    );
    expect(a?.hatAussage).toBe(false);
  });

  it('ist true, sobald es eine Aufteilung gibt — auch bei einer Gesamtzahl im Totband', () => {
    expect(
      ausw({ savedEur: 0.002, savedSpeicherEur: -3.1, savedSteuerungEur: 3.102 }).hatAussage,
    ).toBe(true);
  });

  it('ist true für jede Zahl außerhalb des Totbands', () => {
    expect(ausw({}).hatAussage).toBe(true);
  });
});
