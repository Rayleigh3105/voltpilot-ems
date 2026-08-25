import { describe, expect, it } from 'vitest';
import {
  aufmerksamkeit,
  aufmerksamkeitTitel,
  type AufmerksamkeitInput,
} from './steuerungAufmerksamkeit';

const NOW = new Date('2026-08-25T12:00:00Z');
const SPAETER = '2026-08-25T14:00:00Z';
const FRUEHER = '2026-08-25T11:00:00Z';

function input(over: Partial<AufmerksamkeitInput> = {}): AufmerksamkeitInput {
  return { now: NOW, ...over };
}

describe('Stufe 8 · das Abzeichen zählt AUFMERKSAMKEIT, nicht Anwendungen', () => {
  it('eine Anlage ohne alles trägt kein Abzeichen', () => {
    const a = aufmerksamkeit(input());
    expect(a.anzahl).toBe(0);
    expect(a.gruende).toEqual([]);
    expect(aufmerksamkeitTitel(a)).toBeNull();
  });

  it('ohne Eingabe (älteres Backend, Ladefehler) wird NICHTS behauptet', () => {
    expect(aufmerksamkeit(null).anzahl).toBe(0);
    expect(aufmerksamkeit(undefined).anzahl).toBe(0);
  });

  it('ein laufender Handeingriff zählt, ein abgelaufener nicht', () => {
    const a = aufmerksamkeit(
      input({
        eingriffe: [
          { endsAt: SPAETER, entityId: 'e1' },
          { endsAt: FRUEHER, entityId: 'e2' },
        ],
      }),
    );
    expect(a.eingriffe).toBe(1);
    expect(a.anzahl).toBe(1);
    expect(a.gruende).toEqual(['Ein Handeingriff läuft']);
  });

  it('ein unlesbarer Stempel ist kein Ende und zählt deshalb nicht', () => {
    const a = aufmerksamkeit(input({ eingriffe: [{ endsAt: 'gestern', entityId: 'e1' }] }));
    expect(a.anzahl).toBe(0);
  });

  it('die Anlagen-PAUSE ist EIN Eingriff, auch mit eigener Zeile', () => {
    const a = aufmerksamkeit(
      input({ automationPaused: true, eingriffe: [{ endsAt: SPAETER, entityId: null }] }),
    );
    expect(a.eingriffe).toBe(1);
    expect(a.gruende).toEqual(['Ein Handeingriff läuft']);
  });

  it('Pause UND ein Geräte-Eingriff sind zwei', () => {
    const a = aufmerksamkeit(
      input({
        automationPaused: true,
        eingriffe: [
          { endsAt: SPAETER, entityId: null },
          { endsAt: SPAETER, entityId: 'e1' },
        ],
      }),
    );
    expect(a.eingriffe).toBe(2);
    expect(a.gruende).toEqual(['2 Handeingriffe laufen']);
  });

  it('gezählt wird die REGEL, nicht die Komponente', () => {
    const a = aufmerksamkeit(
      input({
        ansprueche: {
          speicher: [{ flowId: 'f1', claimedAt: FRUEHER }],
          wallbox: [{ flowId: 'f1', claimedAt: FRUEHER }],
        },
      }),
    );
    expect(a.bremsen).toBe(1);
    expect(a.gruende).toEqual(['Eine Regel bremst die Automatik']);
  });

  it('zwei verschiedene Regeln sind zwei', () => {
    const a = aufmerksamkeit(
      input({
        ansprueche: {
          speicher: [{ flowId: 'f1', claimedAt: FRUEHER }],
          wallbox: [{ flowId: 'f2', claimedAt: FRUEHER }],
        },
      }),
    );
    expect(a.bremsen).toBe(2);
    expect(a.gruende).toEqual(['2 Regeln bremsen die Automatik']);
  });

  it('ein DELEGIERTER Anspruch bremst nichts (er übergibt an den Fahrplan)', () => {
    const a = aufmerksamkeit(
      input({ ansprueche: { speicher: [{ flowId: 'f1', claimedAt: null }] } }),
    );
    expect(a.bremsen).toBe(0);
    expect(a.anzahl).toBe(0);
  });

  it('ein älteres Backend ohne claimedAt behauptet nichts', () => {
    const a = aufmerksamkeit(input({ ansprueche: { speicher: [{ flowId: 'f1' }] } }));
    expect(a.bremsen).toBe(0);
  });

  it('Vorschläge tragen nur bei, wenn sie BEWERTET wurden', () => {
    expect(aufmerksamkeit(input({ vorschlaege: null })).anzahl).toBe(0);
    expect(aufmerksamkeit(input({ vorschlaege: 0 })).anzahl).toBe(0);
    const a = aufmerksamkeit(input({ vorschlaege: 2 }));
    expect(a.vorschlaege).toBe(2);
    expect(a.gruende).toEqual(['2 Vorschläge warten']);
    expect(aufmerksamkeit(input({ vorschlaege: 1 })).gruende).toEqual(['Ein Vorschlag wartet']);
  });

  it('eine unsinnige Vorschlags-Zahl wird nie zur Zahl', () => {
    expect(aufmerksamkeit(input({ vorschlaege: Number.NaN })).anzahl).toBe(0);
    expect(aufmerksamkeit(input({ vorschlaege: -3 })).anzahl).toBe(0);
  });

  it('der Titel NENNT, was gezählt wurde — ein nacktes „2" wäre ein Rätsel', () => {
    const a = aufmerksamkeit(
      input({
        automationPaused: true,
        ansprueche: { speicher: [{ flowId: 'f1', claimedAt: FRUEHER }] },
        vorschlaege: 1,
      }),
    );
    expect(a.anzahl).toBe(3);
    expect(aufmerksamkeitTitel(a)).toBe(
      'Ein Handeingriff läuft · Eine Regel bremst die Automatik · Ein Vorschlag wartet',
    );
  });
});
