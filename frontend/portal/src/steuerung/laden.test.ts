import { describe, expect, it } from 'vitest';
import type { Netzanschluss } from '../api';
import type { GeraetBild } from './bild';
import { grenzePruefung, heutigerAnschluss, ladeWahl, ladebudgetKw, lokalesDatum, smartSchritte } from './laden';

function anschluss(bindungen: { anlage: string; ab: string; bis: string | null }[], vereinbart: string | number | null = '200'): Netzanschluss {
  return {
    id: 'na-2', kennzeichen: 'NA-2', name: 'Halle 2', standort: { id: 'st-1', kurzzeichen: 'ST-1' },
    malo: null, netzbetreiber: null, anschluss_kva: null, vereinbart_kw: vereinbart, messung: 'RLM',
    gueltig_ab: null, gueltig_bis: null, hinweise: [], angelegt_am: '2026-01-01T00:00:00Z',
    anlagen: bindungen.map((b, i) => ({ id: `b-${i}`, anlage: { id: b.anlage, name: null }, gueltig_ab: b.ab, gueltig_bis: b.bis })),
  };
}

describe('AP-01 IP-13 · heutiger Netzanschluss', () => {
  it('nimmt nur die heute laufende Bindung der Anlage, letzter Tag eingeschlossen', () => {
    const heute = '2026-10-20';
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-10-20', bis: null }])], 'a', heute))
      .toEqual({ zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: 200 });
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: '2026-10-20' }])], 'a', heute).zustand).toBe('gebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: '2026-10-19' }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-10-21', bis: null }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'b', ab: '2026-01-01', bis: null }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: null }], null)], 'a', heute))
      .toEqual({ zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: null });
  });

  it('liest das Datum in der Zeit des Browsers', () => {
    expect(lokalesDatum(new Date(2026, 9, 4, 23, 59))).toBe('2026-10-04');
  });
});

describe('AP-01 IP-13 · Grenzprüfung', () => {
  const gebunden = { zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: 200 } as const;

  it('folgt der Reihenfolge des Servers: Anschluss, vereinbarte Leistung, Grundlage, Ladebudget', () => {
    expect(grenzePruefung(180, { zustand: 'fehler' }, null, 96.5, 30)).toMatch(/nicht geprüft werden/);
    expect(grenzePruefung(220, gebunden, null, null, null)).toMatch(/^220\s?kW liegen über 200\s?kW vereinbarter Leistung — bitte prüfen\.$/);
    expect(grenzePruefung(180, gebunden, null, null, 30)).toBe('Für die Prüfung fehlen die Grundlast der letzten 7 Tage oder die Hausreserve.');
    expect(grenzePruefung(120, gebunden, null, 96.5, 30)).toMatch(/kein Ladebudget/);
    expect(grenzePruefung(180, gebunden, null, 96.5, 30)).toBeNull();
  });

  it('prüft ohne Bindung gegen den Übergangswert und schweigt, solange er fehlt', () => {
    expect(grenzePruefung(180, { zustand: 'ungebunden' }, null, 96.5, 30)).toBeNull();
    expect(grenzePruefung(180, { zustand: 'ungebunden' }, 150, 96.5, 30)).toMatch(/über 150\s?kW/);
    expect(grenzePruefung(180, { zustand: 'laden' }, null, 96.5, 30)).toBeNull();
    expect(grenzePruefung(null, gebunden, null, 96.5, 30)).toBeNull();
  });

  it('rechnet das Ladebudget nur mit Grundlast und Hausreserve', () => {
    expect(ladebudgetKw(180, 96.5, 30)).toBe(53.5);
    expect(ladebudgetKw(180, null, 30)).toBeNull();
  });
});


type Stand = Pick<GeraetBild, 'eingriff' | 'steuerart'>;
const stand = (eingriff: unknown, quelle: string | null): Stand =>
  ({ eingriff, steuerart: quelle == null ? null : { quelle, herkunft: 'standard' } }) as unknown as Stand;

describe('Smart an einem Ladepunkt', () => {
  it('macht aus dem Anlagen-Standard „sofort“ die Steuerart Sonne zuerst - sonst bliebe die Karte auf Schnell', () => {
    const g = stand(null, 'sofort');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: 'min' });
  });

  it('beendet „Jetzt voll laden“ und lässt eine gewählte Sonnen-Steuerart stehen', () => {
    const g = stand({ art: 'an', bisMs: null }, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: true, steuerart: null });
  });

  it('erledigt Eingriff UND Steuerart in einem Klick', () => {
    expect(smartSchritte(stand({ art: 'aus', bisMs: null }, 'sofort'))).toEqual({ eingriffBeenden: true, steuerart: 'min' });
  });

  it('tut nichts, wenn der Ladepunkt schon smart lädt', () => {
    const g = stand(null, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('smart');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: null });
    expect(smartSchritte(stand(null, null))).toEqual({ eingriffBeenden: false, steuerart: null });
  });
});
