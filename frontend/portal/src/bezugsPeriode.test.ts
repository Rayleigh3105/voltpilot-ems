import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DATUM_UNLESBAR,
  PERIODE_NICHT_ZU_ENDE,
  PERIODE_PASST_NICHT,
  SAETZE,
  ZEIT_MEHRDEUTIG,
  ZEIT_NICHT_VORHANDEN,
  iso,
  periode,
  satz,
  stundenDesTages,
  zeitpunkt,
} from './bezugsPeriode';

/**
 * Das PERIODEN-Modul (UEMS AP-09 IP-3) gegen die geteilte Vektor-Datei
 * `docs/contracts/v2/bezugsdaten-vectors.json` — Familien `periode`, `zeit`,
 * `stunden` — und gegen die drei Fallen: der Tag mit 23 oder 25 Stunden, der
 * mehrdeutige bzw. nicht existierende Zeitpunkt und der Unterschied zwischen
 * „passt nicht" und „noch nicht zu Ende". Der Java-Zwilling
 * `BezugsPeriodeTest` fährt dieselbe Datei.
 */

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const vectors = JSON.parse(readFileSync(resolve(V2, 'bezugsdaten-vectors.json'), 'utf8')) as Record<string, unknown>;

/** Die Zeitzone des Standorts der Referenzfälle (Ahrenberg). */
const AHRENBERG = 'Europe/Berlin';

const befundSaetze = vectors.befund_saetze as Record<string, string>;
const faelle = vectors.cases as Array<Record<string, unknown>>;

const pruefungen = (regel: string) => {
  const gefunden: Array<{ id: string; name: string; ein: Record<string, unknown>; soll: Record<string, unknown> }> = [];
  for (const fall of faelle) {
    for (const p of (fall.pruefungen ?? []) as Array<Record<string, unknown>>) {
      if (p.regel !== regel) continue;
      gefunden.push({
        id: String(fall.id),
        name: String(p.name),
        ein: p.eingang as Record<string, unknown>,
        soll: p.ergebnis as Record<string, unknown>,
      });
    }
  }
  return gefunden;
};

describe('bezugsPeriode — die Familien `periode`, `zeit` und `stunden` der Vektor-Datei', () => {
  for (const f of pruefungen('periode')) {
    it(`${f.id} · periode :: ${f.name}`, () => {
      const ist = periode(
        {
          text: (f.ein.text as string | null) ?? null,
          vonText: (f.ein.von_text as string | null) ?? null,
          bisText: (f.ein.bis_text as string | null) ?? null,
          deutung: f.ein.deutung as string,
          periodeArt: f.ein.periode_art as string,
          jetzt: f.ein.jetzt ? Date.parse(f.ein.jetzt as string) : null,
        },
        AHRENBERG,
      );
      expect(ist.schluessel).toBe((f.soll.schluessel as string | null) ?? null);
      expect(ist.von === null ? null : iso(ist.von, AHRENBERG)).toBe((f.soll.von as string | null) ?? null);
      expect(ist.bis === null ? null : iso(ist.bis, AHRENBERG)).toBe((f.soll.bis as string | null) ?? null);
      expect(ist.stunden).toBe((f.soll.stunden as number | null) ?? null);
      expect(ist.befund).toBe((f.soll.befund as string | null) ?? null);
    });
  }

  for (const f of pruefungen('zeit')) {
    it(`${f.id} · zeit :: ${f.name}`, () => {
      const ist = zeitpunkt(f.ein.text as string, f.ein.zeitzone as string, (f.ein.offset_in_datei as string) ?? null);
      expect(ist.zeitpunkt === null ? null : iso(ist.zeitpunkt, AHRENBERG)).toBe(
        (f.soll.zeitpunkt as string | null) ?? null,
      );
      expect(ist.befund).toBe((f.soll.befund as string | null) ?? null);
      expect(ist.varianten).toEqual(f.soll.varianten);
    });
  }

  for (const f of pruefungen('stunden')) {
    it(`${f.id} · stunden :: ${f.name}`, () => {
      expect(stundenDesTages(f.ein.tag as string, AHRENBERG)).toBe(f.soll.stunden);
    });
  }
});

describe('bezugsPeriode — die drei Fallen', () => {
  it('die Kundensätze wohnen im Modul und sind die des Vertrags', () => {
    for (const [befund, text] of Object.entries(SAETZE)) {
      expect(text).toBe(befundSaetze[befund]);
    }
    expect(Object.keys(SAETZE).sort()).toEqual(
      [PERIODE_PASST_NICHT, PERIODE_NICHT_ZU_ENDE, ZEIT_MEHRDEUTIG, ZEIT_NICHT_VORHANDEN, DATUM_UNLESBAR].sort(),
    );
  });

  it('FALLE 1 — ein Tag hat 23, 24 oder 25 Stunden, nie immer 24', () => {
    expect(stundenDesTages('2026-10-25', AHRENBERG)).toBe(25);
    expect(stundenDesTages('2027-03-28', AHRENBERG)).toBe(23);
    expect(stundenDesTages('2026-12-02', AHRENBERG)).toBe(24);
    // Und die Periode erbt das: der Oktober 2026 hat 745 Stunden, der März 2027 hat 743.
    const jetzt = Date.parse('2026-11-03T09:12:00+01:00');
    expect(periode({ text: '2026-10', deutung: 'periode', periodeArt: 'monat', jetzt }, AHRENBERG).stunden).toBe(745);
    expect(
      periode(
        { text: '2027-03', deutung: 'periode', periodeArt: 'monat', jetzt: Date.parse('2027-04-02T09:00:00+02:00') },
        AHRENBERG,
      ).stunden,
    ).toBe(743);
  });

  it('FALLE 2 — mehrdeutig und nicht vorhanden sind Befunde mit Kundensatz', () => {
    const doppelt = zeitpunkt('25.10.2026 02:30', AHRENBERG, null);
    expect(doppelt.zeitpunkt).toBeNull();
    expect(doppelt.befund).toBe(ZEIT_MEHRDEUTIG);
    expect(doppelt.varianten).toEqual(['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00']);
    expect(satz(ZEIT_MEHRDEUTIG)).toBe(
      'Diesen Zeitpunkt gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.',
    );

    const fehlt = zeitpunkt('28.03.2027 02:30', AHRENBERG, null);
    expect(fehlt.zeitpunkt).toBeNull();
    expect(fehlt.befund).toBe(ZEIT_NICHT_VORHANDEN);
    expect(fehlt.varianten).toEqual([]);
    expect(satz(ZEIT_NICHT_VORHANDEN)).toBe('Diesen Zeitpunkt gibt es an diesem Tag nicht (Zeitumstellung).');

    const mitOffset = zeitpunkt('25.10.2026 02:30', AHRENBERG, '+02:00');
    expect(mitOffset.befund).toBeNull();
    expect(iso(mitOffset.zeitpunkt as number, AHRENBERG)).toBe('2026-10-25T02:30:00+02:00');
  });

  it('FALLE 3 — „passt nicht" ist nicht „noch nicht zu Ende"', () => {
    const jetzt = Date.parse('2026-11-03T09:12:00+01:00');
    const woche = periode(
      { vonText: '28.09.2026', bisText: '04.10.2026', deutung: 'von_bis', periodeArt: 'monat', jetzt },
      AHRENBERG,
    );
    expect(woche.befund).toBe(PERIODE_PASST_NICHT);
    expect(woche.schluessel).toBeNull();
    expect(woche.von).toBeNull();
    expect(satz(PERIODE_PASST_NICHT)).toBe('Der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße.');

    const inWochenreihe = periode(
      { vonText: '28.09.2026', bisText: '04.10.2026', deutung: 'von_bis', periodeArt: 'woche', jetzt },
      AHRENBERG,
    );
    expect(inWochenreihe.schluessel).toBe('2026-W40');
    expect(inWochenreihe.befund).toBeNull();

    const laufend = periode({ text: '2026-11', deutung: 'periode', periodeArt: 'monat', jetzt }, AHRENBERG);
    expect(laufend.befund).toBe(PERIODE_NICHT_ZU_ENDE);
    expect(satz(PERIODE_NICHT_ZU_ENDE)).toBe('Diese Periode ist noch nicht zu Ende.');
    expect(satz(PERIODE_PASST_NICHT)).not.toBe(satz(PERIODE_NICHT_ZU_ENDE));

    // Derselbe Text nach dem Ende der Periode: kein Befund mehr.
    const spaeter = periode(
      { text: '2026-11', deutung: 'periode', periodeArt: 'monat', jetzt: Date.parse('2026-12-01T00:00:00+01:00') },
      AHRENBERG,
    );
    expect(spaeter.befund).toBeNull();
    expect(spaeter.schluessel).toBe('2026-11');
  });

  it('E7/Z5 — die zonenlose Ortszeit liest die Zone des Standorts', () => {
    const amStandort = zeitpunkt('02.11.2026 07:40', AHRENBERG, null);
    const nachVorlage = zeitpunkt('02.11.2026 07:40', 'UTC', null);
    expect(iso(amStandort.zeitpunkt as number, AHRENBERG)).toBe('2026-11-02T07:40:00+01:00');
    expect(amStandort.zeitpunkt).not.toBe(nachVorlage.zeitpunkt);

    const oktober = periode(
      {
        text: '31.10.2026',
        deutung: 'periodenende',
        periodeArt: 'monat',
        jetzt: Date.parse('2026-11-03T09:12:00+01:00'),
      },
      AHRENBERG,
    );
    expect(iso(oktober.von as number, AHRENBERG)).toBe('2026-10-01T00:00:00+02:00');
    expect(iso(oktober.bis as number, AHRENBERG)).toBe('2026-11-01T00:00:00+01:00');
  });

  it('es bleibt keine zweite Fassung: bezugsdaten.ts reicht das Modul weiter', () => {
    const quelle = readFileSync(resolve(process.cwd(), 'src/bezugsdaten.ts'), 'utf8');
    expect(quelle).not.toContain('getValidOffsets');
    expect(quelle).not.toContain('MONATSNAMEN');
    expect(quelle).not.toContain('longOffset');
    expect(quelle).toContain("} from './bezugsPeriode';");
  });
});
