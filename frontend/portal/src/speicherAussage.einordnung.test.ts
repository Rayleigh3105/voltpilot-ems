import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GRUENDE_HOECHSTENS,
  STEUERUNG_GRUENDE,
  paarEur,
  speicherAussage,
  type SpeicherEingabe,
  type SpeicherKontext,
} from './speicherAussage';
import VEKTOREN from './speicherAussage.vektoren.json';

/**
 * **Die Einordnung eines Steuerungs-Tages** (Konzept
 * `vp-erloese-minus-winter-k1` §7, Captain 24.09.2026: E1–E7 = A;
 * Tageszahl nach Definition A aus z2).
 *
 * Der SERVER entscheidet, ob ein Grund greift (`SteuerungGrund.java`, Vertrag
 * `docs/contracts/steuerung-tag-vectors.json`, Block `grund`); das Portal
 * setzt nur Worte. Deshalb liest dieser Test den Vertrag selbst: das
 * Vokabular muss seine Rangfolge sein, und jeder Portal-Fall mit `vertrag`
 * übernimmt die Kennungen genau dieses Vertragsfalls.
 */
const VERTRAG = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/steuerung-tag-vectors.json'), 'utf8'),
) as {
  grund: {
    rangfolge: string[];
    hoechstens: number;
    faelle: { name: string; gruende: string[] }[];
  };
};

interface Fall {
  name: string;
  vertrag: string | null;
  now: string;
  kontext?: Partial<SpeicherKontext>;
  money: SpeicherEingabe;
  erwartet: {
    wert: string;
    chip: string | null;
    grundZeile: string | null;
    grundErster: string | null;
    grundKurz: string | null;
    anker: { label: string; wert: string } | null;
    bestand: string | null;
    bestandBadge: string | null;
    satzMit?: string;
    satzOhne?: string;
  };
}
const FAELLE = (VEKTOREN as unknown as { faelle: Fall[] }).faelle;

/** Die Oberfläche setzt NBSP zwischen Zahl und Einheit; verglichen wird der Wortlaut. */
const sp = (s: string | null | undefined) => (s == null ? null : s.replace(/ /g, ' '));

function aussage(f: Fall) {
  return speicherAussage(f.money, { now: new Date(f.now), ...f.kontext });
}

describe('Einordnung · Vokabular gegen den Vertrag', () => {
  it('die geschlossene Liste IST die Rangfolge des Vertrags, höchstens zwei', () => {
    expect([...STEUERUNG_GRUENDE]).toEqual(VERTRAG.grund.rangfolge);
    expect(GRUENDE_HOECHSTENS).toBe(VERTRAG.grund.hoechstens);
  });

  it('jeder Portal-Fall mit Vertragsbezug trägt genau dessen Kennungen', () => {
    const mitVertrag = FAELLE.filter((f) => f.vertrag);
    expect(mitVertrag.length).toBeGreaterThanOrEqual(8);
    for (const f of mitVertrag) {
      const v = VERTRAG.grund.faelle.find((x) => x.name === f.vertrag);
      expect(v, `Vertragsfall „${f.vertrag}" fehlt`).toBeTruthy();
      expect(f.money.steuerungGruende, f.name).toEqual(v!.gruende);
    }
  });

  it('jede Kennung des Vertrags bekommt Worte — kein Fall zeigt einen Code', () => {
    for (const v of VERTRAG.grund.faelle) {
      const a = speicherAussage(
        {
          range: 'day',
          to: '2026-09-24T22:00:00Z',
          savedEur: 0,
          savedSpeicherEur: 5,
          savedSteuerungEur: -5,
          steuerungVortagEur: 12,
          steuerungPlannedEur: -3,
          speicherVorsprungKwh: 6,
          steuerungGruende: v.gruende,
        },
        { now: new Date('2026-09-24T12:00:00+02:00') },
      )!;
      expect(a.gruende).toEqual(v.gruende);
      if (v.gruende.length === 0) {
        expect(a.grundZeile).toBeNull();
        continue;
      }
      expect(a.grundZeile).not.toMatch(/_/);
      expect(a.grundKurz).not.toMatch(/_/);
    }
  });
});

describe('Einordnung · die Worte je Fall (speicherAussage.vektoren.json)', () => {
  for (const f of FAELLE) {
    it(f.name, () => {
      const a = aussage(f)!;
      expect(a).toBeTruthy();
      const e = f.erwartet;
      expect(sp(a.wert)).toBe(e.wert);
      expect(a.chip).toBe(e.chip);
      expect(sp(a.grundZeile)).toBe(e.grundZeile);
      expect(sp(a.grundErster)).toBe(e.grundErster);
      expect(a.grundKurz).toBe(e.grundKurz);
      expect(a.anker ? { label: a.anker.label, wert: sp(a.anker.wert) } : null).toEqual(e.anker);
      expect(sp(a.bestand)).toBe(e.bestand);
      expect(a.bestandBadge).toBe(e.bestandBadge);
      if (e.satzMit) expect(a.satz).toContain(e.satzMit);
      if (e.satzOhne) expect(a.satz).not.toContain(e.satzOhne);
    });
  }
});

describe('Einordnung · Regeln, die kein einzelner Fall zeigt', () => {
  const basis: SpeicherEingabe = FAELLE[0].money;
  const jetzt = { now: new Date(FAELLE[0].now) };

  it('ein Plus-Tag bekommt nie einen Grund, auch wenn der Server einen schickte', () => {
    const a = speicherAussage({ ...basis, savedSteuerungEur: 2, savedEur: 11.02 }, jetzt)!;
    expect(a.grundZeile).toBeNull();
    expect(a.grundKurz).toBeNull();
  });

  it('der Grund wird nicht gecacht — derselbe Tag, neue Antwort, neuer Grund (z2 §1)', () => {
    const vorher = speicherAussage(FAELLE[1].money, { now: new Date(FAELLE[1].now) })!;
    const nachher = speicherAussage(FAELLE[0].money, { now: new Date(FAELLE[0].now) })!;
    expect(vorher.grundZeile).toContain('so geplant');
    expect(nachher.grundZeile).toContain('hält 5,0');
  });

  it('`[]` sagt nur das Zustandswort, `null` die heutige Formulierung (nie geraten)', () => {
    const leer = speicherAussage({ ...basis, steuerungGruende: [] }, jetzt)!;
    expect(leer.chip).toBe('Zwischenstand');
    expect(leer.grundZeile).toBeNull();
    expect(leer.satz).not.toMatch(/hält Energie/);
    const alt = speicherAussage({ ...basis, steuerungGruende: null }, jetzt)!;
    expect(alt.satz).toMatch(/hält Energie für später/);
  });

  it('der Satz (Tooltip) trägt dieselbe Grund-Zeile wie die Fläche', () => {
    const a = aussage(FAELLE[0])!;
    expect(a.satz).toContain(a.grundZeile!);
  });

  it('höchstens zwei Gründe, auch wenn der Server mehr schickte', () => {
    const a = speicherAussage(
      { ...basis, steuerungGruende: ['gestern_verkauft', 'so_geplant', 'wenig_sonne'] },
      jetzt,
    )!;
    expect(a.gruende).toEqual(['gestern_verkauft', 'so_geplant']);
    expect(a.grundZeile).not.toContain('wenig Sonne');
  });

  it('„beide Tage" addiert die gezeigten Cent-Beträge', () => {
    expect(paarEur(-9.804, 12.7755)).toBe(2.98);
    expect(paarEur(-9.778003, 12.7755)).toBe(3);
    // -9,785 → -9,79 und 12,775 → 12,78: gezeigt wird + 2,99 €, nicht + 2,99|3,00 je nach Gleitkomma.
    expect(paarEur(-9.785, 12.775)).toBe(2.99);
  });

  it('eine Flotten-Zeile ohne Fensteranfang ankert am heutigen Monat', () => {
    const a = speicherAussage(
      { ...basis, from: undefined, range: 'day' },
      { now: new Date('2026-09-24T19:58:00+02:00'), laeuft: true },
    )!;
    expect(a.anker?.label).toBe('September bisher');
  });
});
