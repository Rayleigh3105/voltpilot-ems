import { describe, expect, it } from 'vitest';
import type { CommandEntry, CommandHistory } from './api';
import {
  aufzeichnungSeit,
  BEFEHLE_LABEL,
  deckelSatz,
  film,
  fussnote,
  kopfSatz,
  leerSatz,
  NUR_LESEN,
  pfadWort,
  periodenSatz,
  rohBlick,
  spanne,
  stromLabel,
  zyklenWort,
} from './befehle';

const T0 = '2026-08-16T08:00:00Z';
const T1 = '2026-08-16T09:30:00Z';

function periode(over: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 1,
    stream: 'batterie',
    kind: 'periode',
    eventKind: null,
    startedAt: T0,
    endedAt: T1,
    mode: 'plan',
    path: 'remote',
    whyKind: 'fahrplan',
    whyRef: '-6.50',
    commandedKwFirst: -6.5,
    commandedKwLast: -6.5,
    commandedKwMin: -6.5,
    commandedKwMax: -6.5,
    verdict: 'bestaetigt',
    cycles: null,
    cyclesConfirmed: null,
    cyclesNoAnswer: null,
    cyclesMismatch: null,
    controlEnabled: true,
    released: true,
    foreignInfluence: false,
    entityId: 'e1',
    source: 'cloud_abgeleitet',
    detail: null,
    ...over,
  };
}

function history(over: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-08-12T00:00:00Z',
    accuracySeconds: 15,
    from: T0,
    to: T1,
    entityId: 'e1',
    entityLabel: 'Speicher',
    writes: true,
    truncated: false,
    entries: [],
    control: null,
    curtailment: null,
    ...over,
  };
}

describe('film - der Tages-Film', () => {
  it('macht aus einer Halteperiode einen Satz mit Urteil und Ton', () => {
    const [z] = film(history({ entries: [periode()] }), Date.parse(T1));
    expect(z.art).toBe('periode');
    expect(z.satz).toContain('Entladen');
    expect(z.satz).toContain('Fahrplan');
    expect(z.urteil).toBe('vom Gerät bestätigt');
    expect(z.ton).toBe('ok');
    expect(z.laufend).toBe(false);
  });

  it('nennt eine LAUFENDE Periode als solche', () => {
    const [z] = film(
      history({ entries: [periode({ endedAt: null })] }),
      Date.parse(T1),
    );
    expect(z.laufend).toBe(true);
    expect(z.zeit.startsWith('ab ')).toBe(true);
  });

  it('überspringt ein Ereignis, dessen Wort dieser Stand nicht kennt', () => {
    // Die Ingest-Regel eine Ebene höher: nie ein geratenes Wort.
    const zeilen = film(
      history({
        entries: [
          periode({ id: 2, kind: 'ereignis', eventKind: 'etwas_neues', endedAt: T0 }),
          periode(),
        ],
      }),
      Date.parse(T1),
    );
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].art).toBe('periode');
  });

  it('benennt die Lücke, statt sie zu verschweigen', () => {
    const [z] = film(
      history({
        entries: [periode({ kind: 'ereignis', eventKind: 'luecke', endedAt: T1 })],
      }),
      Date.parse(T1),
    );
    expect(z.satz).toContain('liegt uns nichts vor');
    expect(z.ton).toBe('info');
  });

  it('trägt das Strom-Etikett, damit drei Schreibwege unterscheidbar bleiben', () => {
    const [z] = film(
      history({ entries: [periode({ stream: 'abregelung', mode: 'frei' })] }),
      Date.parse(T1),
    );
    expect(z.strom).toBe('Einspeise-Begrenzung');
    // Ein unbekannter Strom bekommt KEIN geratenes Etikett.
    expect(stromLabel('irgendwas')).toBeNull();
  });
});

describe('die Ehrlichkeitsregeln', () => {
  it('färbt „keine Antwort" NIE wie „abweichend" (die PR-280-Lehre)', () => {
    const keine = film(
      history({ entries: [periode({ verdict: 'keine_antwort' })] }),
      Date.parse(T1),
    )[0];
    const ab = film(
      history({ entries: [periode({ verdict: 'abweichend' })] }),
      Date.parse(T1),
    )[0];
    expect(keine.urteil).toBe('keine Antwort vom Gerät');
    expect(keine.ton).toBe('info');
    expect(ab.ton).toBe('warn');
    expect(keine.ton).not.toBe(ab.ton);
  });

  it('behauptet zu einem unbekannten Urteil GAR NICHTS', () => {
    const [z] = film(
      history({ entries: [periode({ verdict: 'neuartig' })] }),
      Date.parse(T1),
    );
    expect(z.urteil).toBeNull();
    expect(z.ton).toBe('ruhig');
  });

  it('zählt in V1 keine Schreibzyklen und SAGT das', () => {
    expect(zyklenWort(periode())).toContain('—');
    expect(zyklenWort(periode({ cycles: 12 }))).toBe('12');
    expect(rohBlick(periode()).find((r) => r.label === 'Schreibzyklen')?.wert)
      .toContain('noch nicht');
  });

  it('behauptet vor dem Aufzeichnungs-Beginn nichts - auch nichts Entlastendes', () => {
    expect(aufzeichnungSeit(null)).toContain('noch nicht');
    expect(aufzeichnungSeit('2026-08-12T00:00:00Z')).toContain('12.08.2026');
    // Ohne Beginn ist ein leerer Verlauf KEINE Entlastung.
    expect(leerSatz(history({ recordingSince: null }), true))
      .toContain('Aufzeichnung hat noch nicht begonnen');
  });

  it('nennt eine nur gelesene Komponente beim Namen (F4)', () => {
    expect(leerSatz(history({ writes: false }), true)).toBe(NUR_LESEN);
    // Ohne gewählte Komponente wäre der Satz eine Aussage über die ganze
    // Anlage - dort steht die neutrale Auskunft.
    expect(leerSatz(history({ writes: false }), false)).toContain('kein Befehl');
  });

  it('erfindet kein Gerät und keinen Schreibweg', () => {
    expect(kopfSatz({ komponente: 'Speicher', geraet: null, pfad: null })).toBe('Speicher.');
    expect(kopfSatz({ komponente: null, geraet: null, pfad: 'remote' }))
      .toBe('Diese Anlage · Fernsteuer-Register.');
    expect(pfadWort('unbekannt')).toBeNull();
  });

  it('sagt, wenn gekappt wurde - nie ein stilles Kappen', () => {
    expect(deckelSatz(history())).toBeNull();
    expect(deckelSatz(history({ truncated: true }))).toContain('nicht mehr aufgeführt');
  });
});

describe('periodenSatz - was befohlen wurde', () => {
  it('sagt Laden/Entladen/Pause ohne ein Vorzeichen', () => {
    expect(periodenSatz(periode())).toContain('Entladen mit 6,5');
    expect(periodenSatz(periode({ commandedKwLast: 4.2, commandedKwMin: 4.2, commandedKwMax: 4.2 })))
      .toContain('Laden mit 4,2');
    expect(periodenSatz(periode({ commandedKwLast: 0, commandedKwMin: 0, commandedKwMax: 0 })))
      .toContain('angehalten');
    expect(periodenSatz(periode())).not.toContain('-6');
  });

  it('nennt die Spanne einer Nachführung statt eines einzelnen Werts', () => {
    const satz = periodenSatz(periode({
      mode: 'follow',
      commandedKwMin: -7.1,
      commandedKwMax: -4.3,
      commandedKwLast: -7.1,
    }));
    expect(satz).toContain('4,3');
    expect(satz).toContain('7,1');
    expect(satz).toContain('nachgeführt');
  });

  it('nennt den Not-Aus und den Fremdeinfluss, statt sie zu verschweigen', () => {
    expect(periodenSatz(periode({ controlEnabled: false }))).toContain('Not-Aus aktiv');
    const fremd = film(
      history({ entries: [periode({ foreignInfluence: true })] }),
      Date.parse(T1),
    )[0];
    expect(fremd.satz).toContain('anderes System');
    // Fremdeinfluss ist die SCHÄRFERE Aussage als ein bestätigtes Register
    // (die Klemm-Plateau-Lektion) - der Ton folgt ihm, nicht dem Urteil.
    expect(fremd.ton).toBe('warn');
  });

  it('spricht bei der Abregelung von Einspeisung, nicht von der Batterie', () => {
    expect(periodenSatz(periode({ stream: 'abregelung', mode: 'abregeln' })))
      .toContain('Einspeisung begrenzt');
    expect(periodenSatz(periode({ stream: 'abregelung', mode: 'frei', verdict: null })))
      .toContain('Keine Einspeise-Begrenzung');
  });
});

describe('rohBlick - die Technischen Details (F1: für ALLE)', () => {
  it('zeigt Schreibweg, kW und die abweichenden Rollen in Klartext', () => {
    const rows = rohBlick(periode({
      verdict: 'abweichend',
      detail: {
        mismatchRoles: 'battery_power,remote_mode',
        certSource: null,
        units: null,
        certifiedUnits: null,
        state: null,
        reasonCode: null,
      },
    }));
    expect(rows.find((r) => r.label === 'Schreibweg')?.wert).toBe('Fernsteuer-Register');
    expect(rows.find((r) => r.label === 'Weicht ab')?.wert).toBe('Sollwert, Fernsteuerung');
  });

  it('nennt die freigegebenen Wechselrichter der Abregelung', () => {
    const rows = rohBlick(periode({
      stream: 'abregelung',
      path: null,
      detail: {
        mismatchRoles: null,
        certSource: null,
        units: 2,
        certifiedUnits: 0,
        state: null,
        reasonCode: null,
      },
    }));
    expect(rows.find((r) => r.label === 'Wechselrichter')?.wert).toBe('0 von 2 freigegeben');
  });
});

describe('Zeit + Fussnote', () => {
  it('formatiert Spanne, Punkt und laufende Periode verschieden', () => {
    expect(spanne(T0, T1, false)).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
    expect(spanne(T0, T0, false)).toMatch(/^\d{2}:\d{2}$/);
    expect(spanne(T0, null, true)).toMatch(/^ab \d{2}:\d{2}$/);
  });

  it('sagt Aufbewahrung, Prüfraster und was V1 NICHT weiss', () => {
    const f = fussnote(15);
    expect(f.join(' ')).toContain('90 Tage');
    expect(f.join(' ')).toContain('15-Sekunden-Raster');
    expect(f.join(' ')).toContain('zählen wir noch nicht mit');
  });

  it('hält die Beschriftung der zwei Einstiege an EINER Stelle', () => {
    expect(BEFEHLE_LABEL).toBe('Befehle an dieses Gerät');
  });
});
