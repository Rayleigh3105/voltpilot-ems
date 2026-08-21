import { describe, expect, it } from 'vitest';
import type { Device } from './api';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import {
  ENDPUNKT_ZWEI_FORMEN,
  KEIN_LOESCHEN,
  abschluss,
  eingetrageneZeilen,
  endpunkt,
  kennungFehler,
  kennungVorschlag,
  meldung,
  schritte,
} from './ladesaeuleAnbinden';

const BOX: Device = {
  id: 'd1',
  siteId: 's1',
  externalRef: 'edge-abcdefj',
  kind: 'inverter',
  lanHost: '192.168.1.5:8484',
  lanSource: 'erreicht',
  lanSeenAt: '2026-08-21T10:00:00Z',
} as unknown as Device;

function laden(over: Partial<SiteCharging['budget'] & object> = {}): SiteCharging {
  return {
    budget: {
      deviceId: 'd1',
      enabled: true,
      controlEnabled: true,
      ocppPort: 8887,
      ocppUrlPath: '/ocpp',
      ...over,
    } as SiteCharging['budget'],
    chargers: [],
  };
}

function saeule(over: Partial<ChargePoint> = {}): ChargePoint {
  return {
    deviceId: 'd1',
    chargePointId: 'saeule-hof-nord',
    priority: false,
    connected: true,
    ready: true,
    ...over,
  } as ChargePoint;
}

describe('Kennung', () => {
  it('nennt bei einer Ablehnung den ERLAUBTEN Satz, nie nur „ungültig"', () => {
    expect(kennungFehler('')).toContain('Kennung eintragen');
    expect(kennungFehler('mit leerzeichen')).toContain('Unterstrich');
    expect(kennungFehler('säule')).toContain('Umlaute');
    expect(kennungFehler('a/b')).toContain('Schrägstriche');
    expect(kennungFehler('x'.repeat(65))).toContain('64 Zeichen');
  });

  it('lässt genau das Vokabular durch, das Kontrakt und Server führen', () => {
    expect(kennungFehler('saeule-hof_nord.2')).toBeNull();
    expect(kennungFehler('A1')).toBeNull();
  });

  it('erkennt eine schon vergebene Kennung, bevor der Server sie ablehnt', () => {
    expect(kennungFehler('saeule-1', ['saeule-1'])).toContain('schon eingetragen');
    expect(kennungFehler('saeule-2', ['saeule-1'])).toBeNull();
  });

  it('schlägt aus dem Namen vor - und schlägt NICHTS vor, wo nichts bleibt', () => {
    expect(kennungVorschlag('Hof Nord')).toBe('hof-nord');
    expect(kennungVorschlag('Säule 1 (Straße)')).toBe('saeule-1-strasse');
    // ⚠ Ein Name ohne ein einziges erlaubtes Zeichen ergibt KEINEN erfundenen
    // Vorschlag - ein leeres Feld ist ehrlicher als ein geratener Name.
    expect(kennungVorschlag('———')).toBe('');
    expect(kennungVorschlag('')).toBe('');
  });
});

describe('Endpunkt', () => {
  it('baut die Adresse aus dem, was das GERÄT meldet - beide Formen', () => {
    const e = endpunkt(BOX, laden(), 'saeule-hof-nord');
    expect(e.url).toBe('ws://192.168.1.5:8887/ocpp/saeule-hof-nord');
    expect(e.basis).toBe('ws://192.168.1.5:8887/ocpp');
    expect(e.grund).toBeNull();
  });

  it('schneidet den Anschluss der lokalen Oberfläche ab - OCPP hat seinen eigenen', () => {
    expect(endpunkt(BOX, laden(), 'x').url).toContain(':8887/');
    expect(endpunkt(BOX, laden(), 'x').url).not.toContain('8484');
  });

  it('lässt eine IPv6-Klammer heil', () => {
    const v6 = { ...BOX, lanHost: '[fd00::1]:8484' } as Device;
    expect(endpunkt(v6, laden(), 'x').url).toBe('ws://[fd00::1]:8887/ocpp/x');
  });

  it('erfindet nie eine Adresse - jede fehlende Angabe wird BENANNT', () => {
    const ohneAdresse = endpunkt({ ...BOX, lanHost: null } as Device, laden(), 'x');
    expect(ohneAdresse.url).toBeNull();
    expect(ohneAdresse.grund).toBe('keine-adresse');
    expect(ohneAdresse.satz).toContain('Geräteseite');

    // ⚠ Eine bloße SCHNITTSTELLEN-Adresse ist kein Beweis, dass dort etwas
    // antwortet - ein Kopierfeld verspräche genau das. Sie wird trotzdem
    // GENANNT, nur eben als Hinweis.
    const nurGemeldet = endpunkt({ ...BOX, lanSource: 'schnittstelle' } as Device, laden(), 'x');
    expect(nurGemeldet.url).toBeNull();
    expect(nurGemeldet.grund).toBe('nicht-bewiesen');
    expect(nurGemeldet.satz).toContain('192.168.1.5:8484');

    const lauschtNicht = endpunkt(BOX, laden({ ocppPort: null }), 'x');
    expect(lauschtNicht.url).toBeNull();
    expect(lauschtNicht.grund).toBe('lauscht-nicht');

    expect(endpunkt(undefined, laden(), 'x').url).toBeNull();
    expect(endpunkt(BOX, null, 'x').url).toBeNull();
  });

  it('verwirft einen Anschluss, den keine Säule anwählen kann', () => {
    for (const port of [0, -1, 70000, 1.5]) {
      expect(endpunkt(BOX, laden({ ocppPort: port }), 'x').url).toBeNull();
    }
  });

  it('räumt den Pfad auf, statt ein doppeltes „/" zu erzeugen', () => {
    expect(endpunkt(BOX, laden({ ocppUrlPath: 'ocpp/' }), 'x').url)
      .toBe('ws://192.168.1.5:8887/ocpp/x');
    expect(endpunkt(BOX, laden({ ocppUrlPath: '/' }), 'x').url).toBe('ws://192.168.1.5:8887/x');
    expect(endpunkt(BOX, laden({ ocppUrlPath: null }), 'x').url).toBe('ws://192.168.1.5:8887/x');
  });

  it('gibt ohne Kennung die BASIS aus, statt auf einen Schrägstrich zu enden', () => {
    const e = endpunkt(BOX, laden(), '  ');
    expect(e.url).toBe('ws://192.168.1.5:8887/ocpp');
    expect(e.url).toBe(e.basis);
  });

  it('nennt die ZWEITE Schreibweise - sonst scheitert die Hälfte der Kunden', () => {
    expect(ENDPUNKT_ZWEI_FORMEN).toContain('vollständige');
    expect(ENDPUNKT_ZWEI_FORMEN).toContain('hängen ihre Kennung selbst an');
  });
});

describe('Meldung', () => {
  it('liest ausschließlich das GEMELDETE - ein Eintrag ist keine Meldung', () => {
    const wartet = meldung({ ...laden(), chargers: [] }, 'saeule-hof-nord');
    expect(wartet.gemeldet).toBe(false);
    expect(wartet.ton).toBe('warten');
  });

  it('nennt Modell und Stecker, die die Säule SELBST mitbringt', () => {
    const c = {
      ...laden(),
      chargers: [
        saeule({
          vendor: 'ABL',
          model: 'eMH1',
          connectors: [{ connectorId: 1 }, { connectorId: 2 }] as ChargePoint['connectors'],
        }),
      ],
    };
    const m = meldung(c, 'saeule-hof-nord');
    expect(m.gemeldet).toBe(true);
    expect(m.wort).toBe('Verbunden');
    expect(m.satz).toContain('ABL eMH1');
    expect(m.satz).toContain('2 Stecker');
  });

  it('unterscheidet „hat sich gemeldet" von „verbunden"', () => {
    const c = { ...laden(), chargers: [saeule({ connected: false })] };
    const m = meldung(c, 'saeule-hof-nord');
    expect(m.wort).toBe('Hat sich gemeldet');
    expect(m.satz).toContain('nicht verbunden');
    expect(m.ton).toBe('ok');
  });

  it('behauptet ohne Kennung gar nichts', () => {
    const c = { ...laden(), chargers: [saeule()] };
    expect(meldung(c, '').gemeldet).toBe(false);
  });
});

describe('Ablauf', () => {
  it('hakt nur ab, was BELEGT ist', () => {
    expect(schritte(false, false).every((s) => !s.erledigt)).toBe(true);
    const nurEingetragen = schritte(true, false);
    expect(nurEingetragen[0].erledigt).toBe(true);
    // ⚠ Ob jemand die Adresse getippt hat, weiß von hier aus niemand - der
    // Schritt gilt erst als erledigt, wenn die Säule sich gemeldet hat.
    expect(nurEingetragen[1].erledigt).toBe(false);
    expect(schritte(true, true).every((s) => s.erledigt)).toBe(true);
    // ⚠ Eine Säule, die sich meldet, HAT ihre Kennung - auch wenn sie nur am
    // Gerät eingetragen wurde und in der Portal-Liste fehlt. Ein offener
    // Schritt 1 neben einer verbundenen Säule wäre schlicht falsch.
    expect(schritte(false, true).every((s) => s.erledigt)).toBe(true);
  });

  it('behauptet im Abschluss KEINE Zustellung', () => {
    expect(abschluss(false)).toContain('Sobald Ihre Box das nächste Mal verbunden ist');
    expect(abschluss(true)).toContain('Fertig');
    expect(abschluss(true)).toContain('Anschlussgrenze');
  });

  it('erklärt die fehlende Lösch-Tür, statt sie zu verschweigen', () => {
    expect(KEIN_LOESCHEN).toContain('nicht wieder entfernt');
    expect(KEIN_LOESCHEN).toContain('Verbindungsaufbau');
  });
});

describe('Liste der Eingetragenen', () => {
  it('erfindet keinen Namen - ohne Label steht die Kennung da', () => {
    const zeilen = eingetrageneZeilen(
      [
        { chargePointId: 'saeule-hof-nord', label: 'Hof Nord' },
        { chargePointId: 'saeule-halle' },
      ],
      { ...laden(), chargers: [saeule()] },
    );
    expect(zeilen[0]).toMatchObject({ name: 'Hof Nord', zustand: 'Verbunden', ton: 'ok' });
    expect(zeilen[1]).toMatchObject({ name: 'saeule-halle', ton: 'warten' });
  });

  it('kommt ohne Allowlist zurecht', () => {
    expect(eingetrageneZeilen(null, null)).toEqual([]);
    expect(eingetrageneZeilen(undefined, laden())).toEqual([]);
  });
});
