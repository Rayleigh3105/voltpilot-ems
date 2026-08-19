import { describe, expect, it } from 'vitest';
import type {
  RegisterWriteEvent, RegisterWriteOutcome, RegisterWriteTarget,
} from './api';
import {
  adresseEcho,
  adresseFehler,
  beleg,
  bestaetigenLabel,
  bestaetigungsFolgen,
  EXPERTE_INTRO,
  kundenRegisterZugang,
  VERANTWORTUNG,
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
  freieAdresseFehler,
  laneWort,
  registerKenntnis,
  schreibzaehler,
  ziele,
  zielInput,
  zielKey,
} from './registerWrite';

function outcome(patch: Partial<RegisterWriteOutcome> = {}): RegisterWriteOutcome {
  return {
    requestId: 'abc', mode: 'lesen', ok: true, outcome: 'gelesen',
    beforeRaw: 3300, afterRaw: null, beforeScaled: 33, afterScaled: null,
    adopted: null, errorCode: null, message: null, targetLabel: null,
    address: 231, addressHex: '0x00e7',
    registerLabel: 'Einspeisegrenze am Netzanschluss', registerClass: 'netz_compliance',
    scaleNote: null, registerNote: null, scaleUnit: 'kW', noteRequired: true,
    confirm: null, writesToday: 0, lane: 'primary', at: '2026-08-19T14:02:00Z',
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
    expect(wertAnzeige(3300, 33, 'kW')).toBe('3300 (33,0 kW)');
    expect(wertAnzeige(7000, 70, 'kW')).toBe('7000 (70,0 kW)');
  });

  it('erfindet ohne bekannte Skala KEINE Einheit', () => {
    expect(wertAnzeige(1234, null)).toBe('1234');
  });

  it('zeigt gar nichts, wo nichts gelesen wurde', () => {
    expect(wertAnzeige(null, null)).toBeNull();
    // Eine 0 ist ein WERT („gar keine Einspeisung erlaubt"), keine Abwesenheit.
    expect(wertAnzeige(0, 0, 'kW')).toBe('0 (0,0 kW)');
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
    expect(bestaetigenLabel('0x00E7', '7000', 70, 'kW'))
      .toBe('Jetzt schreiben: 0x00e7 = 7000 (70,0 kW)');
    expect(bestaetigenLabel('231', '7000', 70, 'kW'))
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

// ── Stufe 2: das ZIEL, der Zähler, die Einheit ──────────────────────────────

describe('der Geräte-Picker nennt jedes Gerät - auch das ohne Schreibweg', () => {
  const t = (patch: Partial<RegisterWriteTarget> = {}): RegisterWriteTarget => ({
    lane: 'primary', deviceId: 'd-1', entityId: null, label: 'Deye SUN-30K',
    brand: 'deye', model: 'sun-30k', family: 'hybrid_3p', communication: 'solarman_v5',
    host: '192.168.0.28', port: 8899, unitId: 1, writable: true, reason: null, ...patch,
  });

  it('zeigt Lane, Endpunkt und - wo es nicht geht - den Grund', () => {
    const [primary, wallbox] = ziele([
      t(),
      t({ lane: 'entity', entityId: 'e-1', label: 'Wallbox Hof', family: null,
        communication: 'goe_http_api', host: '192.168.0.50', port: null, unitId: null,
        writable: false, reason: 'Dieses Gerät spricht kein Modbus.' }),
    ]);
    expect(primary.laneWort).toBe('Wechselrichter der Anlage');
    expect(primary.unterzeile).toBe('deye sun-30k · 192.168.0.28:8899 · Unit 1');
    expect(primary.waehlbar).toBe(true);
    expect(primary.grund).toBeNull();
    expect(primary.kenntRegister).toBe(true);

    expect(wallbox.laneWort).toBe('Komponente');
    expect(wallbox.waehlbar).toBe(false);
    expect(wallbox.grund).toContain('kein Modbus');
    // ⚠ Ohne Familie kennt die Plattform die Register dieses Geräts nicht - und
    // sie SAGT das, statt einen Namen zu erfinden.
    expect(wallbox.kenntRegister).toBe(false);
  });

  it('behauptet zu einer unbekannten Lane nichts', () => {
    expect(laneWort('mond')).toBe('Ziel');
  });

  it('leitet aus der Wahl genau die Ziel-Felder ab - nie einen erfundenen Host', () => {
    // Seit Stufe 3 reist die Geräte-Kennung des GEWÄHLTEN Ziels mit (siehe den
    // eigenen Fall unten) - der Rest ist unverändert.
    expect(zielInput(t())).toEqual({ deviceId: 'd-1', lane: 'primary' });
    expect(zielInput(t({ lane: 'entity', entityId: 'e-1' })))
      .toEqual({ deviceId: 'd-1', lane: 'entity', entityId: 'e-1' });
    expect(zielInput(t({ lane: 'lan', entityId: null, host: '192.168.0.44',
      port: 1502, unitId: 3 })))
      .toEqual({ deviceId: 'd-1', lane: 'lan', host: '192.168.0.44', port: 1502, unitId: 3 });
    expect(zielInput(null)).toEqual({});
  });

  it('gibt jedem Ziel einen stabilen Schlüssel', () => {
    expect(zielKey(t())).toBe('primary:d-1');
    expect(zielKey(t({ lane: 'entity', entityId: 'e-1' }))).toBe('entity:e-1');
    expect(zielKey(t({ lane: 'lan', host: '192.168.0.44', port: 1502, unitId: 3 })))
      .toBe('lan:192.168.0.44:1502#3');
  });

  it('sagt zu einem Gerät ohne bekannte Register, dass geschrieben trotzdem geht', () => {
    const [unbekannt] = ziele([t({ family: null })]);
    const satz = registerKenntnis(unbekannt);
    expect(satz).toContain('kennt die Register dieses Geräts nicht');
    expect(satz).toContain('geschrieben werden kann trotzdem');
    expect(registerKenntnis(ziele([t()])[0])).toBeNull();
  });

  it('prüft an der freien Adresse nur die FORM - nie das Netz', () => {
    expect(freieAdresseFehler('')).toContain('IP-Adresse');
    expect(freieAdresseFehler('192.168.0 44')).toContain('Leerzeichen');
    // ⚠ Ob eine Adresse belegbar PRIVAT ist, entscheidet die BOX - hier steht
    // keine zweite Wahrheit über ein Netz, das dieses Portal nie gesehen hat.
    expect(freieAdresseFehler('8.8.8.8')).toBeNull();
    expect(freieAdresseFehler('192.168.0.44')).toBeNull();
  });
});

describe('EEPROM-Ehrlichkeit und Einheiten', () => {
  it('sagt den Schreibzähler nur, wenn es etwas zu sagen gibt', () => {
    expect(schreibzaehler(0)).toBeNull();
    expect(schreibzaehler(null)).toBeNull();
    expect(schreibzaehler(undefined)).toBeNull();
    expect(schreibzaehler(1)).toContain('bereits einmal');
    expect(schreibzaehler(3)).toContain('bereits 3×');
  });

  it('⚠ hängt NIE eine erfundene Einheit an einen Rohwert', () => {
    expect(wertAnzeige(3300, 33, 'kW')).toBe('3300 (33,0 kW)');
    expect(wertAnzeige(3300, 33, 'A')).toBe('3300 (33,0 A)');
    // Ohne Einheit bleibt der Rohwert der Rohwert - auch wenn eine Zahl daneben
    // stünde: „kW" hinter einem Ampere-Register wäre die gefährlichste
    // Beschriftung dieses ganzen Pfades.
    expect(wertAnzeige(3300, 33, null)).toBe('3300');
    expect(wertAnzeige(3300, null, 'kW')).toBe('3300');
    expect(wertAnzeige(null, 33, 'kW')).toBeNull();
  });

  it('der Bestätigen-Knopf rechnet nur um, wo eine Einheit bekannt ist', () => {
    expect(bestaetigenLabel('0x00E7', '7000', 70, 'kW'))
      .toBe('Jetzt schreiben: 0x00e7 = 7000 (70,0 kW)');
    expect(bestaetigenLabel('0x00E7', '7000', 70, null))
      .toBe('Jetzt schreiben: 0x00e7 = 7000');
    expect(bestaetigenLabel('0x1234', '5', null)).toBe('Jetzt schreiben: 0x1234 = 5');
  });
});

describe('Stufe 3: die Kunden-Fläche', () => {
  const t = (patch: Partial<RegisterWriteTarget> = {}): RegisterWriteTarget => ({
    lane: 'primary', deviceId: 'd-1', entityId: null, label: 'Deye SUN-30K',
    brand: 'deye', model: 'sun-30k', family: 'hybrid_3p', communication: 'solarman_v5',
    host: '192.168.0.28', port: 8899, unitId: 1, writable: true, reason: null, ...patch,
  });
  const dev = (patch: Partial<{ id: string; siteId: string; name: string | null;
    externalRef: string }> = {}) => ({
    id: 'dev-1', siteId: 'site-1', name: null, externalRef: 'edge-abcdefj', ...patch,
  });

  it('bietet die Strecke nur an, wo ein Gerät sie ausführen könnte', () => {
    const ohne = kundenRegisterZugang([], 'site-1');
    expect(ohne.moeglich).toBe(false);
    expect(ohne.deviceId).toBeNull();
    // Ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten -
    // stattdessen steht dort sein Grund.
    expect(ohne.grund).toContain('Sobald ein Gerät');

    // Ein Gerät einer FREMDEN Anlage zählt nicht: der Auftrag ginge sonst an
    // eine Box, die diese Anlage gar nicht kennt.
    expect(kundenRegisterZugang([dev({ siteId: 'site-2' })], 'site-1').moeglich).toBe(false);
    expect(kundenRegisterZugang(undefined, 'site-1').moeglich).toBe(false);
  });

  it('wählt das Gerät der Anlage vor und benennt es lesbar', () => {
    const mit = kundenRegisterZugang([dev({ siteId: 'site-2' }), dev()], 'site-1');
    expect(mit).toMatchObject({ moeglich: true, grund: null, deviceId: 'dev-1' });
    expect(mit.geraetName).toBe('edge-abcdefj');
    expect(kundenRegisterZugang([dev({ name: 'Box Scheune' })], 'site-1').geraetName)
      .toBe('Box Scheune');
    // Ein leerer Name ist kein Name.
    expect(kundenRegisterZugang([dev({ name: '   ' })], 'site-1').geraetName)
      .toBe('edge-abcdefj');
  });

  it('⚠ die Rückfrage trägt den VERANTWORTUNGS-Satz, und zwar zuletzt', () => {
    const folgen = bestaetigungsFolgen();
    // Er steht in der Folgenliste, nicht nur als Kleingedrucktes im Formular:
    // die Rückfrage ist der Moment, in dem ein Mensch die Folgen abwägt.
    expect(folgen).toContain(VERANTWORTUNG);
    expect(folgen[folgen.length - 1]).toBe(VERANTWORTUNG);
    // Sie nennt auch, was GLEICH bleibt - eine reine Gefahrenliste liest sich
    // wie ein Formular zum Wegklicken.
    expect(folgen.some((f) => f.includes('protokolliert'))).toBe(true);
    expect(folgen.some((f) => f.includes('GENAU EINMAL'))).toBe(true);
  });

  it('der Kunde erfährt VOR dem Aufklappen, worum es geht', () => {
    expect(EXPERTE_INTRO).toContain('genau einmal');
    expect(EXPERTE_INTRO).toContain('protokolliert');
  });

  it('⚠ jedes Ziel schickt seine eigene Geräte-Kennung mit', () => {
    // Auf der Anlagen-Fläche kann eine Anlage mehrere Boxen haben: welche den
    // Auftrag ausführt, darf nicht davon abhängen, welche zuerst geladen wurde.
    expect(zielInput(t({ deviceId: 'dev-2' })))
      .toEqual({ deviceId: 'dev-2', lane: 'primary' });
    expect(zielInput(t({ lane: 'entity', entityId: 'ent-9', deviceId: 'dev-3' })))
      .toEqual({ deviceId: 'dev-3', lane: 'entity', entityId: 'ent-9' });
    expect(zielInput(t({ lane: 'lan', host: '192.168.0.44', port: 502, unitId: 3,
      deviceId: 'dev-4' })))
      .toEqual({ deviceId: 'dev-4', lane: 'lan', host: '192.168.0.44', port: 502, unitId: 3 });
    expect(zielInput(null)).toEqual({});
  });
});
