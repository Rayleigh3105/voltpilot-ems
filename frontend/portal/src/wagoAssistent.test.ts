import { describe, expect, it } from 'vitest';
import type { Device, EdgeVersion, UemsDatenquellePruefergebnis, UemsWagoKarteGelesen, WagoSollLesung } from './api';
import {
  WAGO_BOX_FAehIGKEIT,
  wagoAssistentSichtbar,
  wagoKartenAusPruefung,
  wagoKopfAnzeige,
  wagoSollAnzeige,
  wagoUrteilAusLesung,
} from './wagoAssistent';

describe('WAGO-Lesung — Regel aus IP-1', () => {
  const pruefung = (...karten: UemsWagoKarteGelesen[]) => ({
    wago: { erkannt: true, satz: '', controller_kennung: 8212, kartenzahl: karten.length, karten },
  }) as unknown as UemsDatenquellePruefergebnis;
  const karte = (steckplatz: number | null, kartentyp: number | null, variante: number | null = 0) =>
    wagoKartenAusPruefung(pruefung({ karte: 1, steckplatz, kartentyp, variante }))[0];
  const kopf = { signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 1, herzschlag: 1 };

  it('übernimmt Steckplatz, Typ und Variante aus den Kennwörtern statt aus einer Kundeneingabe', () => {
    expect(karte(3, 495, 25001)).toMatchObject({ steckplatz: 3, typ: '750-495', variante: 25001 });
  });

  it('setzt den gelesenen Steckplatz, nie die Position der Karte (Lücke: Karten auf 2 und 5)', () => {
    const karten = wagoKartenAusPruefung(pruefung(
      { karte: 1, steckplatz: 2, kartentyp: 494, variante: 0 },
      { karte: 2, steckplatz: 5, kartentyp: 495, variante: 25001 },
    ));
    expect(karten.map((k) => [k.id, k.steckplatz, k.typ])).toEqual([['karte-1', 2, '750-494'], ['karte-2', 5, '750-495']]);
    expect(wagoKartenAusPruefung(null)).toEqual([]);
  });

  it('liefert „belegt je Kunde“ nur für den ausgelesenen PFC100', () => {
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8100 }, [karte(2, 495)]).ergebnis)
      .toBe('belegt_je_kunde');
  });

  it('nennt ein fremdes Registerbild unbekannt statt eine Kombination anzunehmen', () => {
    expect(wagoUrteilAusLesung({ signatur_ok: false, erkannt: false, grund: 'signatur_fremd' }, []))
      .toMatchObject({ ergebnis: 'in_pruefung', titel: 'Unbekannt — Registerbild nicht erkannt' });
  });

  it('liefert „nicht unterstützt“ samt Ausweg für eine ausgelesene 750-493', () => {
    const urteil = wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [karte(2, 493)]);
    expect(urteil.ergebnis).toBe('nicht_unterstuetzt');
    expect(urteil.ausweg).toContain('Energiezähler');
  });

  it('nennt die ausgelesene PFC200-Kombination ehrlich „in Prüfung“', () => {
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [karte(2, 494)]))
      .toMatchObject({ ergebnis: 'in_pruefung', titel: 'In Prüfung — Einsatz noch nicht bestätigt' });
  });

  it('erfindet bei einer unvollständigen Kartenlesung weder Steckplatz noch Typ', () => {
    const ungelesen = karte(null, null, null);
    expect(ungelesen).toMatchObject({ steckplatz: null, typ: null, variante: null });
    expect(wagoUrteilAusLesung({ ...kopf, controller_kennung: 8212 }, [ungelesen]).titel).toContain('Unbekannt');
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

  it('nennt die Controller-Kennung und je gelesener Karte Steckplatz, Typ und Variante aus der Prüfung', () => {
    const anzeige = wagoKopfAnzeige({
      ...pruefung({ signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, kartenzahl: 2, controller_kennung: 8212 }),
      wago: {
        erkannt: true, satz: 'Registerbild v1 erkannt — Controller-Kennung 8212, 2 Energiekarten.', controller_kennung: 8212, kartenzahl: 2,
        karten: [
          { karte: 1, steckplatz: 1, kartentyp: 494, variante: 0 },
          { karte: 2, steckplatz: null, kartentyp: null, variante: null },
        ],
      },
    });
    expect(anzeige?.details).toContain('Controller-Kennung 8212');
    expect(anzeige?.karten).toEqual([
      'Karte 1: Steckplatz 1 · 750-494 · Variante 0',
      'Karte 2: Steckplatz nicht gelesen · Kartentyp nicht gelesen · Variante nicht gelesen',
    ]);
  });

  it('erfindet ohne erkannten Kopf keine Karte, auch wenn die Antwort Karten nennt', () => {
    const fremd = wagoKopfAnzeige({
      ...pruefung({ signatur_ok: true, erkannt: false, grund: 'hauptversion_fremd', hauptversion: 2 }),
      wago: { erkannt: false, satz: 'Unter der Basisadresse steht kein VoltPilot-Registerbild v1 — es wurde keine Karte gelesen.' },
    });
    expect(fremd?.karten).toEqual([]);
    expect(wagoKopfAnzeige(pruefung({ signatur_ok: true, erkannt: true, hauptversion: 1, kartenzahl: 4 }))?.karten).toEqual([]);
  });
});

describe('gelesenes Soll im Assistenten — nur Anzeige', () => {
  const lesung = (over: Partial<WagoSollLesung> = {}): WagoSollLesung => ({
    ergebnis: 'gespeichert',
    satz: 'Das Soll wurde aus der Steuerung gelesen und gespeichert.',
    soll: { controllerKennung: 7, karten: [
      { steckplatz: 2, typ: '750-494/000-001 (5 A)', variante: 0 },
      { steckplatz: 3, typ: '750-495', variante: 25001 },
    ] },
    abweichungen: [],
    ...over,
  });

  it('nennt Controller-Kennung und je Karte Typ und Variante', () => {
    const a = wagoSollAnzeige(lesung());
    expect(a.titel).toBe('Soll aus der Steuerung gespeichert');
    expect(a.zeilen).toEqual([
      'Controller-Kennung 7',
      'Steckplatz 2 · 750-494/000-001 (5 A) · Variante 0',
      'Steckplatz 3 · 750-495 · Variante 25001',
    ]);
    expect(a.abweichend).toBe(false);
  });

  it('nicht gelesen bleibt nicht gelesen, und eine Abweichung ist markiert', () => {
    const offen = wagoSollAnzeige(lesung({ ergebnis: 'nicht_gelesen', soll: { controllerKennung: null,
      karten: [{ steckplatz: 2, typ: null, variante: null }] } }));
    expect(offen.zeilen).toEqual(['Controller-Kennung nicht gelesen',
      'Steckplatz 2 · Kartentyp nicht gelesen · Variante nicht gelesen']);
    expect(wagoSollAnzeige(lesung({ ergebnis: 'abweichung' })).abweichend).toBe(true);
  });
});
