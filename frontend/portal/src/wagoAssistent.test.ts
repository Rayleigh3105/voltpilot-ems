import { describe, expect, it } from 'vitest';
import type { Device, EdgeVersion, UemsDatenquellePruefergebnis } from './api';
import {
  LEERE_WAGO_ANTWORTEN,
  WAGO_BOX_FAehIGKEIT,
  bogenLesen,
  bogenSpeichern,
  wagoAssistentSichtbar,
  wagoBogenAuswerten,
  wagoKopfAnzeige,
} from './wagoAssistent';

const antworten = (werte: Partial<typeof LEERE_WAGO_ANTWORTEN>) => ({ ...LEERE_WAGO_ANTWORTEN, ...werte });

describe('WAGO-Erhebungsbogen — Regel aus IP-1', () => {
  it('liefert „belegt“ nur mit einem im Pilot belegten Hardwareblatt', () => {
    expect(wagoBogenAuswerten(antworten({ A1: '750-8212', B2: '750-495', A4: 'VoltPilot-Registerbild v1' }), true).ergebnis)
      .toBe('belegt');
  });

  it('liefert „belegt je Kunde“ für eine eigene Registerliste', () => {
    expect(wagoBogenAuswerten(antworten({ A1: '750-8212', B2: '750-494', A4: 'Eigene Registerliste liegt bei' })).ergebnis)
      .toBe('belegt_je_kunde');
  });

  it('liefert „nicht unterstützt“ samt Ausweg für eine 750-493', () => {
    const urteil = wagoBogenAuswerten(antworten({ A1: '750-8212', B2: '750-493' }));
    expect(urteil.ergebnis).toBe('nicht_unterstuetzt');
    expect(urteil.ausweg).toContain('Installateur');
  });

  it('nennt die noch unbelegte Vorlage „in Prüfung — Pilot ausstehend“', () => {
    expect(wagoBogenAuswerten(antworten({ A1: '750-8212', B2: '750-494', A4: 'VoltPilot-Registerbild v1' }))).toMatchObject({
      ergebnis: 'in_pruefung', titel: 'In Prüfung — Pilot ausstehend',
    });
  });
});

describe('WAGO-Einstieg — ruhender Box-Leser', () => {
  const box = { id: 'box-1', siteId: 'anlage-1', kind: 'edge' } as Device;
  const version = (capabilities?: string[] | null) => ({ deviceId: 'box-1', siteId: 'anlage-1', capabilities }) as EdgeVersion;

  it('ist für bestehende Boxen ohne das künftige Wort unsichtbar', () => {
    expect(wagoAssistentSichtbar([box], [version(['events', 'data_sources'])], 'anlage-1')).toBe(false);
    expect(wagoAssistentSichtbar([box], [version(null)], 'anlage-1')).toBe(false);
  });

  it('wird nur mit wago_registerbild an genau dieser Anlage sichtbar', () => {
    expect(wagoAssistentSichtbar([box], [version([WAGO_BOX_FAehIGKEIT])], 'anlage-1')).toBe(true);
    expect(wagoAssistentSichtbar([box], [version([WAGO_BOX_FAehIGKEIT])], 'anlage-2')).toBe(false);
  });
});

describe('WAGO-Kopf-Anzeige', () => {
  const pruefung = (wago_kopf: object): UemsDatenquellePruefergebnis => ({
    box: { id: 'box-1', name: 'Box Halle 2', heimat_anlage: 'anlage-1' },
    adresse: '192.168.20.10:502', ergebnis: 'ok', gewertet: true, text: 'Erreicht',
    zeitpunkt: '2026-10-20T08:15:00Z', dauer_ms: 80,
    antwort: { results: [{ id: 'wago-kopf', ok: true, wago_kopf }] },
  });

  it('zeigt eine fremde Hauptversion ohne erfundene Kartenzahl', () => {
    expect(wagoKopfAnzeige(pruefung({ signatur_ok: true, erkannt: false, grund: 'hauptversion_fremd', hauptversion: 2 })))
      .toMatchObject({ art: 'fehler', titel: 'Registerbild unbekannt', details: ['Registerbild-Version 2 ist fremd.'] });
  });

  it.each([
    ['signatur_fremd', 'Unter der Basisadresse steht kein VoltPilot-Registerbild.'],
    ['laenge_ungueltig', 'Der Kopf meldet eine unzulässige Länge.'],
    ['wortfolge_abweichend', 'Die Wortfolge passt nicht zur Angabe im Bogen.'],
  ] as const)('übersetzt den Kopf-Grund %s', (grund, text) => {
    expect(wagoKopfAnzeige(pruefung({ signatur_ok: grund !== 'signatur_fremd', erkannt: false, grund }))?.details)
      .toEqual([text]);
  });

  it('zeigt einen stehenden Herzschlag nach der zweiten Prüfung', () => {
    const anzeige = wagoKopfAnzeige(pruefung({ signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 4, herzschlag: 1731 }), 1731);
    expect(anzeige?.details).toContain('Herzschlag steht bei 1.731');
  });
});

describe('WAGO-Bogen — Browser-Speicher', () => {
  it('speichert die 22 Antworten und liest beschädigte Ablagen als leer', () => {
    const daten = new Map<string, string>();
    const speicher = { getItem: (k: string) => daten.get(k) ?? null, setItem: (k: string, v: string) => { daten.set(k, v); } };
    const bogen = antworten({ A1: '750-8212', E4: 'nein' });
    expect(bogenSpeichern(speicher, 'anlage-1', bogen)).toBe(true);
    expect(bogenLesen(speicher, 'anlage-1')).toEqual(bogen);
    daten.set('vp.uems.wago-assistent.anlage-1.v1', '{kaputt');
    expect(bogenLesen(speicher, 'anlage-1')).toEqual(LEERE_WAGO_ANTWORTEN);
  });
});
