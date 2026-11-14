import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, type SteuerlogikLogik, type SteuerlogikRueckmeldung } from './api';
import {
  ablehnungSaetze,
  abweichungSatz,
  dauer,
  laufendeFassung,
  quittungSatz,
  standText,
  tagDerAnlage,
  uhrzeit,
} from './steuerlogikMitlauf';

const block = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/examples/steuerlogik-rueckmeldung.valid.waermepumpe.json'), 'utf8'),
) as { laeufe: SteuerlogikRueckmeldung[] };

function logik(teil: Partial<SteuerlogikLogik>): SteuerlogikLogik {
  return {
    logikId: 'l1',
    name: 'Wärmepumpe',
    fassungen: [{ fassung: 2, zustand: 'mitlaufend', contentHash: 'sha256:x', bericht: null, angelegtAm: '', angelegtVon: null, stillgelegtAm: null }],
    quittung: null,
    laeufe: [],
    ...teil,
  };
}

describe('Steuerlogik-Mitlauf', () => {
  it('liest den Block, den die Box im Beispiel schreibt', () => {
    const wp = block.laeufe[0].geraete!.wp;
    expect(standText(wp.wunsch)).toBe('an');
    expect(standText(wp.ist)).toBe('an');
    expect(abweichungSatz(wp.abweichend_s, wp.verglichen_s)).toBe('61 s von 22 min verschieden');
  });

  it('unbekannt bleibt unbekannt, Stufe 0 ist aus', () => {
    expect(standText(undefined)).toBe('unbekannt');
    expect(standText({})).toBe('unbekannt');
    expect(standText({ stufe: 0 })).toBe('aus');
    expect(standText({ stufe: 2 })).toBe('Stufe 2');
    expect(standText({ sollwert: -2.5, betriebsart: 'cool' })).toBe('Sollwert −2,5, cool');
    expect(abweichungSatz(0, 0)).toBe('noch nicht verglichen (eine Seite unbekannt)');
    expect(abweichungSatz(0, 600)).toBe('gleich, seit 10 min verglichen');
  });

  it('Dauern und Uhrzeit der Anlage', () => {
    expect(dauer(45)).toBe('45 s');
    expect(dauer(1320)).toBe('22 min');
    expect(dauer(7500)).toBe('2 h 05 min');
    expect(uhrzeit('2026-11-14T10:21:01Z')).toBe('11:21:01');
    expect(tagDerAnlage(new Date('2026-11-14T23:30:00Z'))).toBe('2026-11-15');
  });

  it('Quittung der Box: angenommen, alte Fassung, Ablehnung, keine', () => {
    expect(quittungSatz(logik({}), 2)).toEqual({ text: 'Noch keine Quittung der Box', ton: 'leise' });
    const q = { fassung: 2, contentHash: 'sha256:x', zustand: 'active' as const, detail: null, gemeldetAm: '' };
    expect(quittungSatz(logik({ quittung: q }), 2).ton).toBe('ok');
    expect(quittungSatz(logik({ quittung: { ...q, fassung: 1 } }), 2).text).toBe('Box quittiert noch Fassung 1');
    expect(quittungSatz(logik({ quittung: { ...q, zustand: 'error', detail: 'Logik nicht lesbar' } }), 2).text).toBe(
      'Box lehnt ab: Logik nicht lesbar',
    );
    expect(laufendeFassung(logik({}))).toBe(2);
    expect(laufendeFassung(logik({ fassungen: [] }))).toBeNull();
  });

  it('Ablehnung mit Befunden und nicht bestandenen Proben', () => {
    const e = new ApiError(422, 'x', {
      grund: 'pruefung_sperrt',
      message: 'Die Prüfung sperrt die Logik',
      bericht: {
        befunde: ['states.a: Name unbekannt'],
        proben: [
          { name: 'gut', besteht: true, abweichungen: [] },
          { name: 'Kalter Morgen', besteht: false, abweichungen: [{ stelle: 'status', soll: 'Heizt', ist: 'Wartet' }] },
        ],
      },
    });
    expect(ablehnungSaetze(e)).toEqual([
      'Die Prüfung sperrt die Logik',
      'states.a: Name unbekannt',
      'Probe „Kalter Morgen“: status ist Wartet, erwartet Heizt',
    ]);
    expect(ablehnungSaetze(new Error('netz'))).toEqual(['Die Logik konnte nicht übergeben werden. Bitte erneut versuchen.']);
  });
});
