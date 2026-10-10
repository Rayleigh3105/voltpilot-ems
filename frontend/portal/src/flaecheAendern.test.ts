import { describe, expect, it } from 'vitest';
import type { Ort, OrtFehler } from './api';
import {
  flaecheAnfrage,
  flaecheFeldAusServer,
  flaecheKopf,
  flaechePruefen,
  folgenNachher,
  folgenVorher,
  heuteSatz,
  verlauf,
} from './flaecheAendern';
import { FLAECHE_SATZ, rueckwirkung, mitternacht } from './uemsOrtsbaum';
import { ortNachSchreiben } from './test/ortsbaumFixtures';

/**
 * UEMS AP-02 IP-8 · T7 — die Halle 2 des Referenzunternehmens Ahrenberg
 * (`uems-referenzunternehmen.json` Fassung 1.1, `gebaeude[1].bezugsflaechen`):
 * 3 100 m² ab 01.10.2026, am 15.01.2027 eingetragen 3 400 m² ab 01.01.2027,
 * „rückwirkend (14 Tage)“.
 */
const NB = String.fromCharCode(160);
const ZONE = 'Europe/Berlin';
const HEUTE = '2027-01-15';

/** Die Antwort von `PUT /api/v1/orte/{G-2}/flaeche` nach dem Anbau. */
function nachAnbau(over: Partial<Ort> = {}): Ort {
  return ortNachSchreiben({
    flaechen: [
      { m2: 3400, gueltigAb: '2027-01-01', gueltigBis: null, zustand: 'gueltig' },
      { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2026-12-31', zustand: 'beendet' },
    ],
    rueckwirkung: { art: 'rueckwirkend', tage: 14, abzeichen: 'rückwirkend (14 Tage)' },
    ...over,
  });
}

describe('Fläche ändern · vor dem Speichern (T7)', () => {
  it('Kopf und heute gültige Fläche — eine fehlende ist keine 0', () => {
    expect(flaecheKopf('Halle 2', 'G-2')).toBe('Bezugsfläche Halle 2 (G-2)');
    expect(heuteSatz(3100)).toBe(`Heute gilt: 3${NB}100${NB}m²`);
    expect(heuteSatz(null)).toBe('Heute ist keine Fläche eingetragen.');
  });

  it('rückwirkend: Titel und Sätze in Kundensprache, Tage aus der Regel `rueckwirkung`', () => {
    const f = folgenVorher({ flaeche: '3400', gueltigAb: '2027-01-01' }, HEUTE, ZONE)!;
    expect(f.titel).toBe('Rückwirkend um 14 Tage');
    expect(f.saetze).toEqual([
      'Heute ist der 15.01.2027.',
      `Ab dem 01.01.2027 rechnen Kennzahlen in kWh/m² mit 3${NB}400${NB}m² — auch für Tage, die schon vorbei sind.`,
      'Was davor galt, bleibt.',
    ]);
    // Dieselbe Zahl, die der Server ins Abzeichen schreibt (Referenz: „rückwirkend (14 Tage)“).
    const regel = rueckwirkung({
      eingetragenUm: mitternacht(HEUTE, ZONE).iso,
      giltAb: '2027-01-01',
      giltBis: null,
      zeitzone: ZONE,
    });
    expect(regel.abzeichen).toBe('rückwirkend (14 Tage)');
  });

  it('ab heute und geplant sagen es ebenso', () => {
    expect(folgenVorher({ flaeche: '3 400', gueltigAb: HEUTE }, HEUTE, ZONE)).toEqual({
      titel: 'Ab heute',
      saetze: [`Ab heute rechnen Kennzahlen in kWh/m² mit 3${NB}400${NB}m².`, 'Was davor galt, bleibt.'],
    });
    expect(folgenVorher({ flaeche: '3400', gueltigAb: '2027-02-01' }, HEUTE, ZONE)).toEqual({
      titel: 'Geplant ab 01.02.2027',
      saetze: [
        'Bis zum 31.01.2027 bleibt die Fläche, wie sie ist.',
        `Ab dem 01.02.2027 rechnen Kennzahlen in kWh/m² mit 3${NB}400${NB}m².`,
      ],
    });
  });

  it('ohne Zahl oder Tag keine Folgen — und die Prüfung nennt die Sätze des Servers', () => {
    expect(folgenVorher({ flaeche: '', gueltigAb: HEUTE }, HEUTE, ZONE)).toBeNull();
    expect(folgenVorher({ flaeche: '3100,5', gueltigAb: HEUTE }, HEUTE, ZONE)).toBeNull();
    expect(flaechePruefen({ flaeche: '3100,5', gueltigAb: '' })).toEqual({
      flaeche: FLAECHE_SATZ,
      gueltigAb: 'Bitte wählen Sie den Tag, ab dem die Fläche gilt.',
    });
    expect(flaecheAnfrage({ flaeche: `3${NB}400`, gueltigAb: '2027-01-01' })).toEqual({
      m2: 3400,
      gueltigAb: '2027-01-01',
    });
  });

  it('eine Ablehnung landet an der Zahl oder am Tag', () => {
    const f = (code: OrtFehler['code'], feld?: string): OrtFehler => ({ code, message: 'x', feld });
    expect(flaecheFeldAusServer(f('gleiche_flaeche'))).toBe('flaeche');
    expect(flaecheFeldAusServer(f('flaeche_ungueltig', 'm2'))).toBe('flaeche');
    expect(flaecheFeldAusServer(f('gab_es_noch_nicht'))).toBe('gueltigAb');
    expect(flaecheFeldAusServer(f('archiviert'))).toBe('gueltigAb');
    expect(flaecheFeldAusServer(f('anfrage_ungueltig'))).toBeNull();
  });
});

describe('Fläche ändern · nach dem Speichern: Verlauf aus der Antwort (T7)', () => {
  it('zeigt jedes Intervall nach Beginn, die neue Fläche mit dem Abzeichen des Servers', () => {
    expect(verlauf(nachAnbau(), '2027-01-01')).toEqual([
      {
        schluessel: '2026-10-01',
        flaeche: `3${NB}100${NB}m²`,
        zeitraum: 'gültig 01.10.2026 bis 31.12.2026',
        neu: false,
        kennzeichen: null,
        zustand: 'beendet',
      },
      {
        schluessel: '2027-01-01',
        flaeche: `3${NB}400${NB}m²`,
        zeitraum: 'gültig ab 01.01.2027 (neu)',
        neu: true,
        kennzeichen: 'rückwirkend (14 Tage)',
        zustand: 'gueltig',
      },
    ]);
  });

  it('die Folgen nennen, was bleibt, und die Tage, die nachträglich anders gelten', () => {
    expect(folgenNachher(nachAnbau(), '2027-01-01', HEUTE, ZONE)).toEqual({
      titel: 'Rückwirkend um 14 Tage',
      saetze: [
        'Heute ist der 15.01.2027.',
        `Kennzahlen in kWh/m² rechnen ab dem 01.01.2027 mit 3${NB}400${NB}m²; bis zum 31.12.2026 bleibt es bei 3${NB}100${NB}m².`,
        'Für die 14 Tage vom 01.01.2027 bis 14.01.2027 gilt die neue Fläche nachträglich.',
      ],
    });
  });

  it('eine spätere Fläche beendet die neue — das Ende steht in den Folgen', () => {
    const ort = nachAnbau({
      flaechen: [
        { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2026-11-30', zustand: 'beendet' },
        { m2: 3250, gueltigAb: '2026-12-01', gueltigBis: '2026-12-31', zustand: 'beendet' },
        { m2: 3400, gueltigAb: '2027-01-01', gueltigBis: null, zustand: 'gueltig' },
      ],
      rueckwirkung: { art: 'rueckwirkend', tage: 45, abzeichen: 'rückwirkend (45 Tage)' },
    });
    const f = folgenNachher(ort, '2026-12-01', HEUTE, ZONE)!;
    expect(f.saetze).toEqual([
      'Heute ist der 15.01.2027.',
      `Kennzahlen in kWh/m² rechnen vom 01.12.2026 bis zum 31.12.2026 mit 3${NB}250${NB}m²; bis zum 30.11.2026 bleibt es bei 3${NB}100${NB}m².`,
      'Für die 31 Tage vom 01.12.2026 bis 31.12.2026 gilt die neue Fläche nachträglich.',
    ]);
    const zeilen = verlauf(ort, '2026-12-01');
    expect(zeilen.map((z) => z.kennzeichen)).toEqual([null, 'rückwirkend (45 Tage)', null]);
  });

  it('geplant: kein „nachträglich“, die geplante Zeile trägt „geplant“', () => {
    const ort = nachAnbau({
      flaechen: [
        { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2027-01-31', zustand: 'gueltig' },
        { m2: 3400, gueltigAb: '2027-02-01', gueltigBis: null, zustand: 'geplant' },
      ],
      rueckwirkung: { art: 'geplant', tage: 17, abzeichen: null },
    });
    expect(folgenNachher(ort, '2027-02-01', HEUTE, ZONE)).toEqual({
      titel: 'Geplant ab 01.02.2027',
      saetze: [`Kennzahlen in kWh/m² rechnen ab dem 01.02.2027 mit 3${NB}400${NB}m²; bis zum 31.01.2027 bleibt es bei 3${NB}100${NB}m².`],
    });
    expect(verlauf(ort, '2027-02-01').map((z) => z.kennzeichen)).toEqual([null, 'geplant']);
  });
});
