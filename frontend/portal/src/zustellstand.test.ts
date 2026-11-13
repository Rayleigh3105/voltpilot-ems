import { describe, expect, it } from 'vitest';
import type { Zustellstand, ZustellstandWeg } from './benachrichtigungenApi';
import { ausfallText, entwarnungSatz, grundWort, zustellSatz } from './zustellstand';

const JETZT = new Date('2026-11-13T12:00:00Z'); // 13:00 in Berlin

function weg(teil: Partial<ZustellstandWeg> & Pick<ZustellstandWeg, 'weg' | 'zustand'>): ZustellstandWeg {
  return { anlass: 'ausgeloest', grund: null, am: null, versuche: 0, ...teil };
}

function stand(wege: ZustellstandWeg[], still: Zustellstand['still'] = null, stillDurch: string | null = null): Zustellstand {
  return { meldungId: 'm1', still, stillDurch, wege };
}

describe('Zustellstand an der Meldung (Kunden-Alarmierung P4)', () => {
  it('nennt jeden Weg, der ankam, mit Uhrzeit - E-Mail vor Push', () => {
    const s = stand([
      weg({ weg: 'webpush', zustand: 'gesendet', am: '2026-11-13T11:34:00Z' }),
      weg({ weg: 'email', zustand: 'gesendet', am: '2026-11-13T11:34:00Z' }),
      weg({ weg: 'webhook', zustand: 'unterdrueckt', grund: 'kein_weg' }),
      weg({ weg: 'telegram', zustand: 'unterdrueckt', grund: 'kein_weg' }),
    ]);
    expect(zustellSatz(s, JETZT, false)).toEqual({ ton: 'gemeldet', text: 'Gemeldet: E-Mail 12:34 · Push 12:34' });
  });

  it('nennt an einem anderen Tag das Datum', () => {
    const s = stand([weg({ weg: 'email', zustand: 'gesendet', am: '2026-11-12T07:05:00Z' })]);
    expect(zustellSatz(s, JETZT, true)?.text).toBe('Gemeldet: E-Mail 12.11. 08:05');
  });

  it('sagt ehrlich, warum nichts hinausging - Team-Kanal ohne Weg ist kein eigener Grund', () => {
    const s = stand([
      weg({ weg: 'email', zustand: 'unterdrueckt', grund: 'kein_weg' }),
      weg({ weg: 'webpush', zustand: 'unterdrueckt', grund: 'kein_weg' }),
      weg({ weg: 'webhook', zustand: 'unterdrueckt', grund: 'kein_weg' }),
    ]);
    expect(zustellSatz(s, JETZT, false)).toEqual({ ton: 'nicht', text: 'Nicht gesendet: kein Weg eingeschaltet' });
  });

  it('„stumm“ heißt Ruhezeit, wenn die Meldung vorbei war, sonst stumm', () => {
    expect(grundWort('stumm', true)).toBe('Ruhezeit');
    expect(grundWort('stumm', false)).toBe('stumm');
    const s = stand([weg({ weg: 'email', zustand: 'unterdrueckt', grund: 'stumm' })]);
    expect(zustellSatz(s, JETZT, true)?.text).toBe('Nicht gesendet: Ruhezeit');
  });

  it('zeigt Ruhezeit und Beruhigung mit der Uhrzeit, zu der es kommt', () => {
    const ruhe = stand([weg({ weg: 'email', zustand: 'wartet', am: '2026-11-14T06:00:00Z' })]);
    expect(zustellSatz(ruhe, JETZT, false)).toEqual({ ton: 'wartet', text: 'E-Mail um 14.11. 07:00 (Ruhezeit)' });
    const beruhigt = stand([weg({ weg: 'webpush', zustand: 'wartet', grund: 'beruhigt', am: '2026-11-13T17:34:00Z' })]);
    expect(zustellSatz(beruhigt, JETZT, false)?.text).toBe('Push um 18:34, falls noch aktuell (beruhigt)');
    const entfallen = stand([weg({ weg: 'email', zustand: 'unterdrueckt', grund: 'beruhigt' })]);
    expect(zustellSatz(entfallen, JETZT, true)?.text).toBe('Nicht gesendet: beruhigt');
  });

  it('ein gescheiterter Versuch ist kein Erfolg', () => {
    const erneut = stand([weg({ weg: 'email', zustand: 'wartet', versuche: 1, am: '2026-11-13T12:05:00Z' })]);
    expect(zustellSatz(erneut, JETZT, false)?.text).toBe('E-Mail wird erneut versucht');
    const fehler = stand([
      weg({ weg: 'email', zustand: 'fehlgeschlagen' }),
      weg({ weg: 'webpush', zustand: 'gesendet', am: '2026-11-13T11:00:00Z' }),
    ]);
    expect(zustellSatz(fehler, JETZT, false)).toEqual({ ton: 'gemeldet', text: 'Gemeldet: Push 12:00 · E-Mail nicht zugestellt' });
    expect(zustellSatz(stand([weg({ weg: 'email', zustand: 'fehlgeschlagen' })]), JETZT, false)).toEqual({
      ton: 'fehler',
      text: 'E-Mail nicht zugestellt',
    });
  });

  it('Probelauf, Folge-Meldung und „heute schon“ sagen, warum für niemanden etwas hinausging', () => {
    expect(zustellSatz(stand([], 'probelauf'), JETZT, false)?.text).toBe('Nicht gesendet: Probelauf');
    expect(zustellSatz(stand([], 'abhaengig', 'AL-2026-000002'), JETZT, false)?.text).toBe(
      'Nicht einzeln gesendet: gehört zu AL-2026-000002',
    );
    expect(zustellSatz(stand([], 'heute_schon'), JETZT, false)?.text).toBe('Nicht gesendet: heute schon gemeldet');
  });

  it('ohne eigene Zeile: nicht an Sie; ohne Stand: nichts', () => {
    expect(zustellSatz(stand([]), JETZT, false)?.text).toBe('Nicht an Sie gesendet');
    expect(zustellSatz(undefined, JETZT, false)).toBeNull();
  });

  it('nennt die Entwarnung nur, wenn sie hinausging', () => {
    const s = stand([
      weg({ weg: 'email', zustand: 'gesendet', am: '2026-11-13T10:00:00Z' }),
      weg({ weg: 'email', anlass: 'wieder_normal', zustand: 'gesendet', am: '2026-11-13T11:00:00Z' }),
      weg({ weg: 'webpush', anlass: 'wieder_normal', zustand: 'unterdrueckt', grund: 'kein_weg' }),
    ]);
    expect(entwarnungSatz(s, JETZT)).toBe('Entwarnung: E-Mail 12:00');
    expect(entwarnungSatz(stand([weg({ weg: 'email', zustand: 'gesendet' })]), JETZT)).toBeNull();
  });
});

describe('ein Weg fällt aus', () => {
  it('nennt Adresse, Gerät oder Kanal und was zu tun ist', () => {
    expect(ausfallText({ weg: 'email', id: null, name: 'eva@example.test', seit: '2026-11-13T09:15:00Z' }, JETZT)).toEqual({
      titel: 'E-Mails kommen nicht an',
      satz: 'Die Meldung von 10:15 konnte an eva@example.test nicht zugestellt werden. Prüfen Sie die Adresse unter „Einstellen“.',
    });
    expect(ausfallText({ weg: 'webpush', id: 'p', name: 'Evas iPhone', seit: '2026-11-12T09:15:00Z' }, JETZT).titel).toBe(
      'Push auf „Evas iPhone“ ist abgemeldet',
    );
  });
});
