import { describe, expect, it } from 'vitest';
import type { Device, EdgeVersion, ProbeAntwort, UemsDatenquellePruefergebnis } from './api';
import {
  WAGO_BOX_FAehIGKEIT,
  wagoAssistentSichtbar,
  wagoKarteAusLesung,
  wagoKopfAnzeige,
  wagoUrteilAusLesung,
} from './wagoAssistent';

describe('WAGO-Lesung — Regel aus IP-1', () => {
  const antwort = (steckplatz: number, kartentyp: number): ProbeAntwort => ({
    requestId: 'probe-1', errorCode: null,
    results: [{ id: 'karte', ok: true, reading: { steckplatz, kartentyp, spannung_l1: 230.4 } }],
  });
  const kopf = { signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 1, herzschlag: 1 };

  it('übernimmt Steckplatz und Typ aus der Lesung statt aus einer Kundeneingabe', () => {
    expect(wagoKarteAusLesung(1, antwort(3, 495))).toMatchObject({ steckplatz: 3, typ: '750-495' });
  });

  it('liefert „belegt je Kunde“ nur für den ausgelesenen PFC100', () => {
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8100 }, [wagoKarteAusLesung(1, antwort(2, 495))]).ergebnis)
      .toBe('belegt_je_kunde');
  });

  it('nennt ein fremdes Registerbild unbekannt statt eine Kombination anzunehmen', () => {
    expect(wagoUrteilAusLesung({ signatur_ok: false, erkannt: false, grund: 'signatur_fremd' }, []))
      .toMatchObject({ ergebnis: 'in_pruefung', titel: 'Unbekannt — Registerbild nicht erkannt' });
  });

  it('liefert „nicht unterstützt“ samt Ausweg für eine ausgelesene 750-493', () => {
    const urteil = wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [wagoKarteAusLesung(1, antwort(2, 493))]);
    expect(urteil.ergebnis).toBe('nicht_unterstuetzt');
    expect(urteil.ausweg).toContain('Energiezähler');
  });

  it('nennt die ausgelesene PFC200-Kombination ehrlich „in Prüfung“', () => {
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [wagoKarteAusLesung(1, antwort(2, 494))]))
      .toMatchObject({ ergebnis: 'in_pruefung', titel: 'In Prüfung — Einsatz noch nicht bestätigt' });
  });

  it('erfindet bei einer unvollständigen Kartenlesung weder Steckplatz noch Typ', () => {
    const karte = wagoKarteAusLesung(1, { requestId: 'probe-2', errorCode: null, results: [{ id: 'karte', ok: true }] });
    expect(karte).toMatchObject({ steckplatz: null, typ: null });
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [karte]).titel).toContain('Unbekannt');
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
    ['wortfolge_abweichend', 'Die gelesene Wortfolge passt nicht zur Verbindungsangabe.'],
  ] as const)('übersetzt den Kopf-Grund %s', (grund, text) => {
    expect(wagoKopfAnzeige(pruefung({ signatur_ok: grund !== 'signatur_fremd', erkannt: false, grund }))?.details)
      .toEqual([text]);
  });

  it('zeigt einen stehenden Herzschlag nach der zweiten Prüfung', () => {
    const anzeige = wagoKopfAnzeige(pruefung({ signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 4, herzschlag: 1731 }), 1731);
    expect(anzeige?.details).toContain('Herzschlag steht bei 1.731');
  });
});
