import { describe, expect, it } from 'vitest';
import type { CommandEntry, CommandHistory } from './api';
import {
  ANLAGENWEITE_BEFEHLE,
  GERAETE_BEFEHLE,
  aufzeichnungSeit,
  BEFEHLE_LABEL,
  deckelSatz,
  film,
  fussnote,
  geraetKopfSatz,
  kopfSatz,
  leerSatz,
  NUR_LESEN,
  pfadWort,
  periodenSatz,
  rohBlick,
  rohWert,
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

  it('nennt eine nur gelesene Komponente beim Namen (F4) - und sagt es EINMAL', () => {
    // Der Kopf trägt den Satz; die Leer-Zeile schliesst an, statt ihn zu
    // wiederholen (im Browser aufgefallen: er stand zweimal untereinander).
    expect(NUR_LESEN).toContain('nur gelesen');
    expect(leerSatz(history({ writes: false }), true)).toBe('Deshalb ist dieser Verlauf leer.');
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
  it('nennt auch im Roh-Blick die Richtung als WORT, nie ein nacktes Minus', () => {
    expect(rohWert(-6.5, 'batterie')).toBe('6,5\u00a0kW Entladen');
    expect(rohWert(4.2, 'batterie')).toBe('4,2\u00a0kW Laden');
    expect(rohWert(0, 'batterie')).toContain('Pause');
    // Eine Einspeise-Kappe hat keine Richtung - sie ist eine Obergrenze.
    expect(rohWert(17.6, 'abregelung')).toBe('17,6\u00a0kW');
  });

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

/**
 * Fuehrt `body` unter einer anderen Browser-Zeitzone aus. Node uebernimmt eine
 * Aenderung von `process.env.TZ` sofort; die Wachhund-Zusicherung im Test
 * stellt sicher, dass der Fall wirklich geprueft wird und nicht still
 * durchrutscht, falls der Laufzeit-Wechsel je aufhoert zu wirken.
 */
function withTz<T>(tz: string, body: () => T): T {
  const vorher = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    process.env.TZ = vorher;
  }
}

describe('Zeit + Fussnote', () => {
  it('formatiert Spanne, Punkt und laufende Periode verschieden', () => {
    expect(spanne(T0, T1, false)).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
    expect(spanne(T0, T0, false)).toMatch(/^\d{2}:\d{2}$/);
    expect(spanne(T0, null, true)).toMatch(/^ab \d{2}:\d{2}$/);
  });

  it('rendert IMMER Europe/Berlin, egal in welcher Zone der Browser laeuft', () => {
    // 21:45 UTC ist 23:45 Berliner Sommerzeit - genau der Grenz-Slot des
    // gemeldeten Falls. Vor dem Fix las ein Browser in UTC dort „21:45".
    const grenze = '2026-08-18T21:45:00Z';
    withTz('UTC', () => {
      // Wachhund: ohne wirksamen Zonen-Wechsel prueft der Fall nichts.
      expect(new Date(grenze).getHours()).toBe(21);
      expect(spanne(grenze, null, false)).toBe('23:45');
    });
    withTz('America/New_York', () => {
      expect(spanne(grenze, null, false)).toBe('23:45');
    });
  });

  it('datiert einen Beginn VOR dem Fenster, damit er nicht als heute liest', () => {
    // Der gemeldete Fall: eine Zeile, die gestern 23:45 begann, stand im
    // „Heute"-Tab als „23:45" - also scheinbar in der Zukunft.
    const heute = '2026-08-19';
    expect(spanne('2026-08-18T21:45:00Z', '2026-08-18T22:00:07Z', false, heute))
      .toBe('18.08. 23:45–00:00');
    expect(spanne('2026-08-18T20:00:00Z', null, true, heute)).toBe('ab 18.08. 22:00');
    // Ein Punkt-Ereignis bleibt EIN Zeitpunkt, auch datiert.
    expect(spanne('2026-08-18T21:45:00Z', '2026-08-18T21:45:00Z', false, heute))
      .toBe('18.08. 23:45');
  });

  it('datiert NICHT, was am Tag des Fensters begann - und nie ohne Bezug', () => {
    const heute = '2026-08-19';
    expect(spanne('2026-08-19T06:00:00Z', '2026-08-19T07:00:00Z', false, heute))
      .toBe('08:00–09:00');
    // Ohne Fenster-Tag wird nie ein Datum erfunden.
    expect(spanne('2026-08-18T21:45:00Z', '2026-08-18T22:00:07Z', false, null))
      .toBe('23:45–00:00');
  });

  it('gibt dem Film den Fenster-Tag mit, statt jede Zeile gleich zu behandeln', () => {
    const zeilen = film(
      history({
        // Das Fenster ist der Berliner 19.08. (ab 22:00 UTC des Vortags).
        from: '2026-08-18T22:00:00Z',
        to: '2026-08-19T15:26:00Z',
        entries: [
          periode({
            id: 1,
            startedAt: '2026-08-18T20:00:00Z',
            endedAt: '2026-08-19T04:00:00Z',
          }),
          periode({
            id: 2,
            startedAt: '2026-08-19T06:00:00Z',
            endedAt: '2026-08-19T06:15:00Z',
          }),
        ],
      }),
      Date.parse('2026-08-19T15:26:00Z'),
    );
    // Die vor dem Fenster begonnene Zeile traegt ihr Datum, die von heute nicht.
    expect(zeilen[0].zeit).toBe('18.08. 22:00–06:00');
    expect(zeilen[1].zeit).toBe('08:00–08:15');
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

describe('der VIERTE Strom `register`', () => {
  function registerZeile(over: Partial<CommandEntry> = {}): CommandEntry {
    return {
      ...periode(),
      id: -7,
      stream: 'register',
      kind: 'ereignis',
      eventKind: 'register_geschrieben',
      startedAt: T0,
      endedAt: T1,
      source: 'portal',
      register: {
        id: 7, requestId: 'abc', source: 'portal', deviceId: 'd', deviceRef: 'edge-1',
        lane: 'primaer', targetLabel: 'Deye SUN-30K · 192.168.0.28', registerKind: 'holding',
        address: 231, addressHex: '0x00e7', addressInput: '0x00E7', valueInput: '7000',
        note: 'Freigabe des Netzbetreibers', valueRaw: 7000, expectedBefore: 3300,
        registerLabel: 'Einspeisegrenze am Netzanschluss',
        registerClass: 'netz_compliance', scaleNote: 'Rohwert × 0,01 = 70,0 kW',
        origin: 'voltpilot', actorName: 'M. Vogt', actorRole: 'platform-admin',
        viaTenantSwitcher: true, requestedAt: T0, beforeRaw: 3300, afterRaw: 7000,
        adopted: true, outcome: 'uebernommen', reason: null, answeredAt: T1,
      },
      ...over,
    };
  }

  it('rendert den Vorgang samt Herkunft - denselben Satz wie der Drawer', () => {
    const [z] = film(history({ entries: [registerZeile()] }), Date.parse(T1));
    expect(z.strom).toBe('Register');
    expect(z.art).toBe('ereignis');
    expect(z.satz).toMatch(/von 3300 auf 7000 geschrieben/);
    expect(z.satz).toMatch(/durch VoltPilot \(M. Vogt\)/);
    expect(z.ton).toBe('ok');
    expect(z.herkunft).toBe('über das Portal ausgelöst');
  });

  it('zeigt die getippten Begriffe VERBATIM im Roh-Blick', () => {
    const [z] = film(history({ entries: [registerZeile()] }), Date.parse(T1));
    expect(z.roh).toContainEqual({ label: 'Eingetippte Adresse', wert: '0x00E7' });
    expect(z.roh).toContainEqual({ label: 'Grund', wert: 'Freigabe des Netzbetreibers' });
  });

  it('lässt eine Zeile OHNE den Block wortlos aus', () => {
    // Ein älteres Backend kennt das Feld nicht - dann behauptet die Fläche
    // nichts, statt eine leere Zeile zu zeigen.
    const ohne = registerZeile({ register: null });
    expect(film(history({ entries: [ohne] }), Date.parse(T1))).toHaveLength(0);
  });

  it('nennt einen Vor-Ort-Vorgang als solchen', () => {
    const zeile = registerZeile({
      source: 'geraet',
      register: { ...registerZeile().register!, origin: 'geraet', actorName: null },
    });
    const [z] = film(history({ entries: [zeile] }), Date.parse(T1));
    expect(z.satz).toMatch(/vor Ort am Gerät/);
    expect(z.herkunft).toBe('vom Gerät gemeldet');
  });
});

describe('die GERÄTE-Sicht (Anlagen-Zentrale Stufe 1)', () => {
  it('unterscheidet die Box vom Gerät dahinter - das ist eine Aussage', () => {
    // Die Box ist das TOR: sie ÜBERBRINGT die anlagenweiten Befehle - was ein
    // Gerät AUSFÜHRT, steht seit der Ziel-Attribution auf dessen Seite.
    expect(geraetKopfSatz({ geraet: 'VoltPilot-Box Pilsting', box: true, pfad: 'remote' }))
      .toBe('VoltPilot-Box Pilsting · die anlagenweiten Befehle, die Ihre Box überbringt.');
    // Ein Gerät dahinter trägt nur SEINE - und sagt das.
    expect(geraetKopfSatz({ geraet: 'Deye SUN-30K', box: false, pfad: null }))
      .toBe('Deye SUN-30K · nur die Befehle an dieses Gerät.');
    // Der Schreibweg gewinnt, wo er bekannt ist; ein unbekannter bleibt weg.
    expect(geraetKopfSatz({ geraet: 'Deye SUN-30K', box: false, pfad: 'tou' }))
      .toContain('Zeitprogramm des Wechselrichters');
    expect(geraetKopfSatz({ geraet: 'Deye SUN-30K', box: false, pfad: 'quatsch' }))
      .toBe('Deye SUN-30K · nur die Befehle an dieses Gerät.');
  });

  it('nennt ohne Namen das Gerät neutral statt zu raten', () => {
    expect(geraetKopfSatz({ geraet: null, box: false, pfad: null }))
      .toBe('Dieses Gerät · nur die Befehle an dieses Gerät.');
  });

  it('erklärt die Grenze in BEIDE Richtungen, statt sie nur zu ziehen', () => {
    // Eine anlagenweite Abregelung gehört der Box - der Satz sagt, WO sie steht.
    expect(ANLAGENWEITE_BEFEHLE).toContain('Abregelung');
    expect(ANLAGENWEITE_BEFEHLE).toContain('Box');
    // Und auf der Box die Gegenrichtung: ausgeführt wird am GERÄT, dort steht
    // der Befehl seit der Ziel-Attribution auch.
    expect(GERAETE_BEFEHLE).toContain('Gerät');
    expect(GERAETE_BEFEHLE).not.toContain('Box');
  });
});

describe('Ladepunkt-Strom: „Jetzt voll laden" im Verlauf (P3a)', () => {
  // ⚠ Den Beleg schreibt `ChargingBoostService.record` seit je - gerendert hat
  // ihn niemand, weil ein unbekanntes Ereignis-Wort gar keine Zeile erzeugt.
  const ereignis = (eventKind: string) => film(
    history({ entries: [periode({ stream: 'ladepunkt', kind: 'ereignis', eventKind })] }),
    Date.parse(T1),
  );

  it('macht aus der Freigabe eine lesbare Zeile', () => {
    const t = JSON.stringify(ereignis('voll_laden_erteilt'));
    expect(t).toContain('Jetzt voll laden');
    expect(t).toContain('auch aus dem Netz');
  });

  it('macht aus der Rücknahme eine lesbare Zeile', () => {
    expect(JSON.stringify(ereignis('voll_laden_zurueckgenommen')))
      .toContain('wieder Ihre Priorität');
  });
});
