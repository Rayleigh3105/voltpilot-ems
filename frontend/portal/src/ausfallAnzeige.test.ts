import { describe, expect, it } from 'vitest';
import type { StandortAusfall } from './api';
import { anlageAusfallSatz, messstelleAusfallSatz, standortAusfallSatz } from './ausfallAnzeige';

const basis: StandortAusfall = {
  standort_id: 'st-1', boxen_gesamt: 2, boxen_ausgefallen: 1, messstellen_unvollstaendig: 6,
  boxen: [{ id: 'e-2', name: 'Box Halle 2', seit: '2026-11-03T14:00:00+01:00', anlagen: ['an-2'] }],
  messstellen: [{ id: 'ms-10', kennzeichen: 'MS-10', name: 'Netzbezug Halle 2', art: 'gemessen',
    seit: '2026-11-03T14:00:00+01:00', box_id: 'e-2', box: 'Box Halle 2', fehlt: [] }],
};

describe('Ausfall-Anzeige — keine Ursache ohne Fakt', () => {
  it('spricht die belegte Ahrenberg-Lage A2', () => {
    expect(messstelleAusfallSatz(basis.messstellen[0], () => '14:00')).toBe('Unvollständig seit 14:00 (Box Halle 2)');
    expect(standortAusfallSatz(basis)).toBe('1 von 2 Boxen meldet sich nicht · 6 Messstellen unvollständig');
    expect(anlageAusfallSatz(basis, 'an-2')).toBe('Box Halle 2 meldet sich nicht');
  });

  it('nennt ohne belegte Box niemals eine Ursache', () => {
    const ohneFakt = { ...basis.messstellen[0], box: null, box_id: null, seit: null };
    expect(messstelleAusfallSatz(ohneFakt, () => '14:00')).toBeNull();
    expect(standortAusfallSatz({ ...basis, boxen_ausgefallen: 0 })).toBeNull();
    expect(anlageAusfallSatz({ ...basis, boxen: [] }, 'an-2')).toBeNull();
  });

  it('berechnete Messstellen nennen ihre fehlenden Eingänge, aber keine Box-Ursache', () => {
    const berechnet = { ...basis.messstellen[0], art: 'berechnet' as const, box: 'Box Halle 2', fehlt: ['MS-10'] };
    expect(messstelleAusfallSatz(berechnet, () => '14:00')).toBeNull();
  });
});
