import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { ebenenBereiche, EBENEN_SEITEN } from './ebenenNav';
import * as E from './energiemanagementPortal';
import { dokumentRoute, energiemanagementRoute, hashForRoute, pageRoute, parseRoute } from './nav';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { rechteSeed } from './test/rollenFixtures';
import { werkAhrenberg, werkLindach } from './test/standorteFixtures';

const SHA = 'b045'.padEnd(60, '0') + '42bd';
const verweis = (teil: Partial<E.VerweisEntwurf> = {}): E.VerweisEntwurf => ({ ...E.LEERER_VERWEIS, ...teil });

describe('UEMS AP-19 IP-9 · Energiemanagement im Portal', () => {
  it('der Bereich steht mit `energiemanagement.ansehen` neben den anderen Unternehmens-Seiten (§6.3)', () => {
    const lm = { standorte: [werkAhrenberg(), werkLindach()], funktionen: ahrenbergFunktionen(), kennzahlen: [] };
    expect(ebenenBereiche({ art: 'unternehmen' }, lm).map((b) => b.key)).not.toContain('energiemanagement');
    const mit = ebenenBereiche({ art: 'unternehmen' }, { ...lm, energiemanagement: true }).map((b) => b.key);
    expect(mit[mit.length - 1]).toBe('energiemanagement');
    expect(EBENEN_SEITEN({ art: 'unternehmen' }).energiemanagement).toEqual(pageRoute('portfolio-energiemanagement'));
    expect(E.darfAnsehen(rechteSeed('IK').me)).toBe(true);
    expect(E.REITER.map((r) => r.label)).toEqual(['Verzeichnis', 'Dokumente']);
  });

  it('Routen: Verzeichnis ohne Zusatz, Dokumente, Zuschnitt-Hilfe und ein Dokument hin und zurück', () => {
    expect(hashForRoute(energiemanagementRoute())).toBe('#/portfolio/energiemanagement');
    for (const r of [energiemanagementRoute('dokumente'), energiemanagementRoute('zuschnitt'), dokumentRoute('d-1')]) {
      expect(parseRoute(hashForRoute(r))).toEqual(r);
    }
    expect(hashForRoute(dokumentRoute('d-1'))).toBe('#/portfolio/energiemanagement/dokumente/d-1');
  });

  it('Anlegen: der Beleg ist ein Verweis — ohne Ablage keiner seiner Teile, nie eine Datei (G3)', () => {
    const basis = { art: 'energiepolitik', titel: 'Energiepolitik', bezug: 'unternehmen' as const, standortId: '' };
    expect(E.anlegenKoerper({ ...basis, original: verweis() })).toEqual({
      koerper: { art: 'energiepolitik', titel: 'Energiepolitik', bezug: { art: 'unternehmen' } },
    });
    expect(E.anlegenKoerper({ ...basis, original: verweis({ sha256: SHA }) })).toEqual({ fehler: { original: 'Bitte nennen Sie, wo das Original bei Ihnen liegt.' } });
    const r = E.anlegenKoerper({ ...basis, original: verweis({ ablage: ' QM-Laufwerk ', sha256: SHA, fassungsangabe: 'Rev. 1' }) });
    expect(r).toEqual({
      koerper: { art: 'energiepolitik', titel: 'Energiepolitik', bezug: { art: 'unternehmen' }, beleg: { bezeichnung: null, ablage: 'QM-Laufwerk', kennung: null, adresse: null, sha256: SHA } },
    });
    expect(E.anlegenKoerper({ ...basis, bezug: 'standort', original: verweis() })).toEqual({ fehler: { bezug: 'Bitte wählen Sie den Standort.' } });
  });

  it('Fassung: Wortlaut ODER Verweis mit den sieben Teilen; Begründung ab Fassung 2; der Anwendungsbereich nennt Standorte und Träger', () => {
    const e: E.FassungEntwurf = { form: 'wortlaut', wortlaut: 'Text', verweis: verweis({ ablage: 'bleibt draußen' }), standortIds: [], traeger: [], begruendung: '' };
    expect(E.fassungKoerper(e, 'energiepolitik', 1)).toEqual({ koerper: { form: 'wortlaut', wortlaut: 'Text' } });
    expect(E.fassungKoerper(e, 'energiepolitik', 2)).toEqual({ fehler: { begruendung: 'Bitte begründen Sie in 10 bis 500 Zeichen.' } });
    const v = E.fassungKoerper({ ...e, form: 'verweis', verweis: verweis({ ablage: 'Instandhaltungssystem', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4', sha256: SHA }) }, 'betrieb', 1);
    expect('koerper' in v && Object.keys(v.koerper.verweis!).sort()).toEqual(['ablage', 'adresse', 'bezeichnung', 'datum', 'fassungsangabe', 'kennung', 'sha256']);
    expect('koerper' in v && v.koerper).not.toHaveProperty('wortlaut');
    expect(E.fassungKoerper({ ...e, form: 'verweis', verweis: verweis() }, 'betrieb', 1)).toEqual({ fehler: { verweis: 'Bitte nennen Sie, wo das Original bei Ihnen liegt.' } });
    expect(E.fassungKoerper(e, 'anwendungsbereich', 1)).toEqual({
      fehler: { standorte: 'Bitte wählen Sie mindestens einen Standort.', traeger: 'Bitte wählen Sie mindestens einen Energieträger.' },
    });
    expect(E.fassungKoerper({ ...e, standortIds: ['st-1'], traeger: ['Strom', 'Gas'] }, 'anwendungsbereich', 1)).toEqual({
      koerper: { form: 'wortlaut', wortlaut: 'Text', anwendungsbereich: { standort_ids: ['st-1'], traeger: ['Strom', 'Gas'], ausschluesse: [] } },
    });
  });

  it('Freigabe: „entschieden von“ und Begründung Pflicht; die zweite Person schickt höchstens eine Begründung (DK3)', () => {
    expect(E.freigabeKoerper({ entschiedenVon: '', entschiedenAm: '2026-12-15', begruendung: 'kurz' }, false)).toEqual({
      fehler: { entschiedenVon: 'Bitte wählen Sie, wer entschieden hat.', begruendung: 'Bitte begründen Sie in 10 bis 500 Zeichen.' },
    });
    expect(E.freigabeKoerper({ entschiedenVon: 'rf', entschiedenAm: '2026-12-15', begruendung: 'Erste Fassung zum Start.' }, false)).toEqual({
      koerper: { entschieden_von: 'rf', entschieden_am: '2026-12-15', begruendung: 'Erste Fassung zum Start.' },
    });
    expect(E.freigabeKoerper({ entschiedenVon: 'rf', entschiedenAm: '2026-12-15', begruendung: '' }, true)).toEqual({ koerper: {} });
  });

  it('Person anlegen mit der Leitung: zwei Körper, die Aufgabe `unternehmensleitung` ohne „entschieden von“ (PA1, PA3)', () => {
    const e: E.PersonEntwurf = { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: '', leitung: true, leitungAb: '2026-10-01', begruendung: 'Geschäftsführer seit Oktober.' };
    expect(E.personKoerper(e)).toEqual({
      person: { name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', organisation: null },
      leitung: { aufgabe: 'unternehmensleitung', gilt_ab: '2026-10-01', begruendung: 'Geschäftsführer seit Oktober.' },
    });
    expect(E.personKoerper({ ...e, leitung: false, begruendung: '' })).toMatchObject({ leitung: null });
  });

  it('Ort-Satz (§5.8) und Ablehnungen in Kundenworten', () => {
    expect(E.ortSatz({ beleg: { ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik' } }, { form: 'wortlaut', verweis: null })).toBe(
      'Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Politik.',
    );
    expect(
      E.ortSatz({ beleg: null }, { form: 'verweis', verweis: { ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4', datum: '2028-11-03' } }),
    ).toBe('Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4 vom 03.11.2028).');
    expect(E.ortSatz({ beleg: null }, { form: 'wortlaut', verweis: null })).toBeNull();
    expect(E.ablehnungSatz(new ApiError(422, 'x', { code: 'leitung_fehlt', message: 'x' }))).toBe(
      'Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.',
    );
    expect(E.ablehnungSatz(new ApiError(422, 'x', { code: 'unbekannt', message: 'Satz der Route.' }))).toBe('Satz der Route.');
    expect(E.kurz(`sha256:${SHA}`)).toBe('b045…42bd');
    expect(E.bezugWort({ art: 'unternehmen', standort: null })).toBe('Unternehmen');
    expect(E.bezugWort({ art: 'energieeinsatz', standort: { id: 's', kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' }, energieeinsatz: { id: 'e', kennzeichen: 'EE-1', name: 'Spritzguss' } })).toBe('EE-1 Spritzguss');
  });
});
