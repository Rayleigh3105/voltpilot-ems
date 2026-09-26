import { describe, expect, it } from 'vitest';
import type { Intervention } from './api';
import type { ManualOverride } from './consumers/fulfillment';
import {
  ladepunktSteuerung,
  speicherSteuerung,
  verbraucherSteuerung,
  werEntscheidet,
} from './geraetSteuerung';
import type { JetztZeile } from './steuerungJetzt';

/**
 * Der Baustein „Steuerung": EIN Schalter, der den ECHTEN Zustand zeigt.
 * Geprüft wird, dass genau das gilt, was `steuerungJetzt` sagt - kein Segment
 * bietet an, was die Zeile nicht hergibt, und ein laufender Eingriff ist das
 * aktive Segment, kein Knopf (K1).
 */
function zeile(over: Partial<JetztZeile> = {}): JetztZeile {
  return {
    key: 'z-1',
    art: 'speicher',
    entityId: 'e-1',
    name: 'Speicher',
    zustand: 'lädt 2,2 kW',
    grund: null,
    quelle: 'fahrplan',
    quelleText: 'Fahrplan',
    bis: null,
    ton: 'ok',
    aktionen: [],
    keinEingriff: null,
    ...over,
  };
}

const EINGRIFF_LADEN: Intervention = {
  kind: 'speicher_laden',
  entityId: 'e-1',
  targetValueKw: 5,
  endsAt: '2026-09-10T12:00:00Z',
  createdBy: null,
  createdAt: '2026-09-10T10:00:00Z',
};

const segmente = (v: ReturnType<typeof speicherSteuerung>) =>
  v.segmente.map((s) => `${s.key}${s.aktiv ? '*' : ''}${s.aktion ? '' : '-'}`);

describe('speicherSteuerung - Automatik · Laden · Halten', () => {
  it('zeigt im Fahrplan „Automatik" als aktiv und bietet nur die angebotenen Eingriffe an', () => {
    const v = speicherSteuerung(zeile({ aktionen: ['speicher_laden', 'speicher_halten'] }), null);
    expect(v.segmente.map((s) => s.label)).toEqual(['Automatik', 'Laden', 'Halten']);
    expect(segmente(v)).toEqual(['automatik*-', 'laden', 'halten']);
    expect(v.segmente[1].aktion).toEqual({ art: 'speicher', wert: 'speicher_laden' });
    expect(v.keinEingriff).toBeNull();
  });

  it('macht einen laufenden Handeingriff zum aktiven Segment - der Weg zurück ist „Automatik"', () => {
    const v = speicherSteuerung(
      zeile({ quelle: 'handeingriff', aktionen: ['resume', 'speicher_halten'] }),
      EINGRIFF_LADEN,
    );
    expect(segmente(v)).toEqual(['automatik', 'laden*-', 'halten']);
    expect(v.segmente[0].aktion).toEqual({ art: 'speicher', wert: 'resume' });
  });

  it('sperrt ein Segment, das die Zeile nicht anbietet - nie eine geratene Handlung', () => {
    const v = speicherSteuerung(zeile({ aktionen: ['speicher_laden'] }), null);
    expect(v.segmente.find((s) => s.key === 'halten')?.aktion).toBeNull();
  });

  it('zeigt ohne jede Handlung den GRUND statt eines toten Schalters', () => {
    const v = speicherSteuerung(zeile({ aktionen: [], keinEingriff: 'Der Not-Aus ist an.' }), null);
    expect(v.segmente).toEqual([]);
    expect(v.keinEingriff).toBe('Der Not-Aus ist an.');
  });
});

describe('verbraucherSteuerung - Automatik · Ein · Aus (K1)', () => {
  const heizstab = (over: Partial<JetztZeile> = {}) =>
    zeile({ art: 'geraet', name: 'Heizstab', zustand: 'läuft', ...over });

  it('bietet einem laufenden Heizstab kein „Jetzt starten" an - „Ein" ist dann aktiv, kein Knopf', () => {
    const override: ManualOverride = { entityId: 'e-1', kind: 'start', targetCommand: 'on', endsAt: '2026-09-10T12:00:00Z' };
    const v = verbraucherSteuerung(heizstab({ quelle: 'handeingriff', aktionen: ['resume', 'stop'] }), override);
    expect(segmente(v)).toEqual(['automatik', 'ein*-', 'aus']);
  });

  it('zeigt einen Stopp-Eingriff als „Aus"', () => {
    const override: ManualOverride = { entityId: 'e-1', kind: 'stop', targetCommand: 'off', endsAt: '2026-09-10T12:00:00Z' };
    const v = verbraucherSteuerung(heizstab({ quelle: 'handeingriff', aktionen: ['resume', 'start'] }), override);
    expect(segmente(v)).toEqual(['automatik', 'ein', 'aus*-']);
  });

  it('bleibt ohne Eingriff in „Automatik" - auch wenn eine Regel schaltet', () => {
    const v = verbraucherSteuerung(heizstab({ quelle: 'regel', aktionen: ['start', 'stop'] }), null);
    expect(segmente(v)).toEqual(['automatik*-', 'ein', 'aus']);
    expect(v.segmente[1].aktion).toEqual({ art: 'verbraucher', wert: 'start' });
  });
});

describe('ladepunktSteuerung - Automatik · Sofort laden · Pausieren', () => {
  const lp = (over: Partial<JetztZeile> = {}) =>
    zeile({
      art: 'ladepunkt',
      ladepunkt: { chargePointId: 'CP-1', connectorId: 1, name: 'Carport', eingriff: null },
      ...over,
    });

  it('liest den aktiven Zustand aus der Zeile selbst', () => {
    expect(segmente(ladepunktSteuerung(lp({ aktionen: ['voll_laden', 'laden_pausieren'] }))))
      .toEqual(['automatik*-', 'sofort', 'pausieren']);
    expect(segmente(ladepunktSteuerung(lp({
      quelle: 'handeingriff',
      aktionen: ['resume'],
      ladepunkt: { chargePointId: 'CP-1', connectorId: 1, name: 'Carport', eingriff: 'pausiert' },
    })))).toEqual(['automatik', 'sofort-', 'pausieren*-']);
  });
});

describe('werEntscheidet - aus der Zeile zusammengesetzt, nie neu formuliert', () => {
  it('nennt Quelle und Countdown', () => {
    expect(werEntscheidet(zeile({ quelleText: 'Handeingriff bis 14:30 Uhr', bis: 'noch 1 Std. 12 Min.' })))
      .toBe('Handeingriff bis 14:30 Uhr · noch 1 Std. 12 Min.');
    expect(werEntscheidet(zeile({ quelleText: 'Fahrplan' }))).toBe('Fahrplan');
  });

  it('behauptet ohne belegte Quelle keinen Urheber', () => {
    expect(werEntscheidet(zeile({ quelleText: null }))).toBeNull();
    expect(werEntscheidet(zeile({ quelleText: '  ' }))).toBeNull();
  });
});
