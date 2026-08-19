import { describe, expect, it } from 'vitest';
import type { RegisterWriteEvent, RegisterWriteOutcome } from './api';
import {
  adresseEcho,
  adresseFehler,
  beleg,
  bestaetigenLabel,
  journalSatz,
  journalTon,
  herkunftWort,
  klasseTon,
  klasseWarnung,
  klasseWort,
  parseRegisterZahl,
  vorschau,
  wertAnzeige,
  wertFehler,
  ZUSTAND_UNBEKANNT,
} from './registerWrite';

function outcome(patch: Partial<RegisterWriteOutcome> = {}): RegisterWriteOutcome {
  return {
    requestId: 'abc', mode: 'lesen', ok: true, outcome: 'gelesen',
    beforeRaw: 3300, afterRaw: null, beforeScaled: 33, afterScaled: null,
    adopted: null, errorCode: null, message: null, targetLabel: null,
    address: 231, addressHex: '0x00e7',
    registerLabel: 'Einspeisegrenze am Netzanschluss', registerClass: 'netz_compliance',
    scaleNote: null, noteRequired: true, confirm: null, at: '2026-08-19T14:02:00Z',
    ...patch,
  };
}

function event(patch: Partial<RegisterWriteEvent> = {}): RegisterWriteEvent {
  return {
    id: 1, requestId: 'abc', source: 'portal', deviceId: 'd', deviceRef: 'edge-1',
    lane: 'primaer', targetLabel: 'Deye', registerKind: 'holding', address: 231,
    addressHex: '0x00e7', addressInput: '0x00E7', valueInput: '7000', note: null,
    valueRaw: 7000, expectedBefore: 3300,
    registerLabel: 'Einspeisegrenze am Netzanschluss', registerClass: 'netz_compliance',
    scaleNote: null, origin: 'voltpilot', actorName: 'M. Vogt', actorRole: 'platform-admin',
    viaTenantSwitcher: true, requestedAt: '2026-08-19T14:02:00Z',
    beforeRaw: 3300, afterRaw: 7000, adopted: true, outcome: 'uebernommen',
    reason: null, answeredAt: '2026-08-19T14:02:31Z',
    ...patch,
  };
}

describe('die Eingabe wird nie geraten', () => {
  it('nimmt beide Schreibweisen derselben Adresse', () => {
    expect(parseRegisterZahl('0x00E7')).toBe(231);
    expect(parseRegisterZahl(' 231 ')).toBe(231);
    expect(parseRegisterZahl('0')).toBe(0);
    expect(parseRegisterZahl('65535')).toBe(65535);
    expect(adresseFehler('0x00E7')).toBeNull();
    expect(adresseFehler('231')).toBeNull();
  });

  it('rät ein nacktes Hex-Wort NICHT - „231" wäre sonst mehrdeutig', () => {
    expect(parseRegisterZahl('E7')).toBeNull();
    expect(parseRegisterZahl('70,0')).toBeNull();
    expect(parseRegisterZahl('65536')).toBeNull();
    expect(parseRegisterZahl('-1')).toBeNull();
    expect(adresseFehler('E7')).toMatch(/hexadezimal/);
    expect(adresseFehler('')).toMatch(/eintragen/);
    expect(wertFehler('siebentausend')).toMatch(/Registerzahl/);
  });

  it('zeigt beide Schreibweisen live', () => {
    expect(adresseEcho('231')).toBe('0x00e7 · dezimal 231');
    expect(adresseEcho('0x00E7')).toBe('0x00e7 · dezimal 231');
    expect(adresseEcho('E7')).toBeNull();
  });
});

describe('was nicht gemessen ist, wird nicht behauptet', () => {
  it('rendert Rohwert und Umrechnung nebeneinander', () => {
    expect(wertAnzeige(3300, 33)).toBe('3300 (33,0 kW)');
    expect(wertAnzeige(7000, 70)).toBe('7000 (70,0 kW)');
  });

  it('erfindet ohne bekannte Skala KEINE Einheit', () => {
    expect(wertAnzeige(1234, null)).toBe('1234');
  });

  it('zeigt gar nichts, wo nichts gelesen wurde', () => {
    expect(wertAnzeige(null, null)).toBeNull();
    // Eine 0 ist ein WERT („gar keine Einspeisung erlaubt"), keine Abwesenheit.
    expect(wertAnzeige(0, 0)).toBe('0 (0,0 kW)');
  });
});

describe('die Warnklassen sperren nichts, sie sagen was auf dem Spiel steht', () => {
  it('nennt die Netz-Anmeldung beim Namen', () => {
    expect(klasseWarnung('netz_compliance')).toMatch(/Netzbetreiber/);
    expect(klasseTon('netz_compliance')).toBe('warn');
    expect(klasseWort('netz_compliance')).toBe('Netz-Anmeldung');
  });

  it('warnt am deutlichsten bei einem unbekannten Register', () => {
    expect(klasseWarnung('unbekannt')).toMatch(/kennt dieses Register nicht/);
    expect(klasseTon('unbekannt')).toBe('danger');
  });

  it('behauptet zu einem unbekannten Wort nichts', () => {
    expect(klasseWarnung('irgendwas')).toBeNull();
    expect(klasseWort('irgendwas')).toBeNull();
    expect(klasseTon('irgendwas')).toBe('ruhig');
  });
});

describe('die Vorschau ist der erste Schritt - ohne sie gibt es keinen zweiten', () => {
  it('trägt Ist-Wert, Klasse und den Wächter', () => {
    const v = vorschau(outcome());
    expect(v.gelesen).toBe(true);
    expect(v.istText).toBe('3300 (33,0 kW)');
    expect(v.expectedBefore).toBe(3300);
    expect(v.notizPflicht).toBe(true);
    expect(v.warnung).toMatch(/Netzbetreiber/);
  });

  it('sagt eine Ablehnung schon HIER, nicht erst nach dem Klick', () => {
    const v = vorschau(outcome({
      ok: false, beforeRaw: null, beforeScaled: null,
      errorCode: 'refused_control_owned',
      message: 'Dieses Register gehört gerade der laufenden Steuerung.',
    }));
    expect(v.gelesen).toBe(false);
    expect(v.satz).toMatch(/laufenden Steuerung/);
    // Eine Ablehnung ist eine Auskunft, kein Defekt.
    expect(v.ton).toBe('info');
  });

  it('nennt einen echten Fehlschlag als solchen', () => {
    const v = vorschau(outcome({
      ok: false, beforeRaw: null, beforeScaled: null,
      errorCode: 'unreachable', message: 'Das Gerät ist nicht erreichbar.',
    }));
    expect(v.ton).toBe('warn');
  });
});

describe('der Bestätigen-Knopf trägt den vollen Satz', () => {
  it('nennt Register, Rohwert und die Umrechnung', () => {
    expect(bestaetigenLabel('0x00E7', '7000', 70))
      .toBe('Jetzt schreiben: 0x00e7 = 7000 (70,0 kW)');
    expect(bestaetigenLabel('231', '7000', 70))
      .toBe('Jetzt schreiben: 0x00e7 = 7000 (70,0 kW)');
  });

  it('lässt die Einheit weg, wo keine Skala bekannt ist', () => {
    expect(bestaetigenLabel('1234', '5', null)).toBe('Jetzt schreiben: 0x04d2 = 5');
  });
});

describe('der Beleg unterscheidet die fünf Ausgänge', () => {
  it('behauptet „übernommen" nur nach echter Rücklesung', () => {
    const b = beleg(outcome({
      mode: 'schreiben', outcome: 'uebernommen', afterRaw: 7000, afterScaled: 70,
      adopted: true,
    }));
    expect(b.satz).toBe('Übernommen ✓ 7000 (70,0 kW)');
    expect(b.detail).toBe('vorher 3300 (33,0 kW)');
    expect(b.ton).toBe('ok');
    expect(b.neuLesen).toBe(false);
  });

  it('trennt „angenommen, nicht übernommen" von „abgelehnt"', () => {
    const b = beleg(outcome({
      mode: 'schreiben', outcome: 'nicht_uebernommen', afterRaw: 3300, afterScaled: 33,
      adopted: false,
    }));
    expect(b.satz).toMatch(/angenommen, aber nicht übernommen/);
    expect(b.neuLesen).toBe(true);
  });

  it('nennt Schweigen „unbekannt" und verlangt eine neue Lesung', () => {
    const b = beleg(outcome({ mode: 'schreiben', outcome: 'unbekannt', ok: false,
      errorCode: 'timeout', beforeRaw: null, beforeScaled: null }));
    expect(b.satz).toBe(ZUSTAND_UNBEKANNT);
    expect(b.neuLesen).toBe(true);
    // Ausdrücklich NICHT „nicht geschrieben".
    expect(b.satz).not.toMatch(/nicht geschrieben/);
  });

  it('verlangt nach einer Ablehnung KEINE neue Lesung - es wurde nichts geschrieben', () => {
    const b = beleg(outcome({
      mode: 'schreiben', outcome: 'abgelehnt', ok: false,
      errorCode: 'refused_expected_before',
      message: 'Der Ist-Wert hat sich seit der Vorschau geändert.',
    }));
    expect(b.neuLesen).toBe(false);
    expect(b.satz).toMatch(/geändert/);
  });
});

describe('die Journal-Zeile nennt Vorgang UND Urheber', () => {
  it('schreibt den vollen Satz der Befehle-Seite', () => {
    expect(journalSatz(event())).toBe(
      'Register 0x00e7 „Einspeisegrenze am Netzanschluss" von 3300 auf 7000 '
      + 'geschrieben - vom Gerät bestätigt · durch VoltPilot (M. Vogt).');
    expect(journalTon(event())).toBe('ok');
  });

  it('nennt einen Vor-Ort-Vorgang als solchen', () => {
    const satz = journalSatz(event({ origin: 'geraet', actorName: null, source: 'geraet' }));
    expect(satz).toMatch(/vor Ort am Gerät/);
    expect(satz).not.toMatch(/\(/); // kein erfundener Name
  });

  it('behauptet ohne Ergebnis-Zeile kein Ergebnis', () => {
    const offen = event({ outcome: null, adopted: null, afterRaw: null, answeredAt: null });
    expect(journalSatz(offen)).not.toMatch(/bestätigt|übernommen|fehlgeschlagen/);
    expect(journalTon(offen)).toBe('ruhig');
  });

  it('behauptet zu einer unbekannten Herkunft nichts', () => {
    expect(herkunftWort('installateur')).toBeNull();
    expect(journalSatz(event({ origin: 'installateur' }))).not.toMatch(/·/);
  });

  it('sagt „ohne Rückmeldung" statt „nicht geschrieben"', () => {
    const e = event({ outcome: 'unbekannt', adopted: null, afterRaw: null });
    expect(journalSatz(e)).toMatch(/ohne Rückmeldung, Zustand unbekannt/);
    expect(journalTon(e)).toBe('info');
  });
});
