import { describe, expect, it } from 'vitest';
import type { Device } from './api';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import {
  ENDPUNKT_ZWEI_FORMEN,
  ENTFERNEN_HINWEIS,
  abschluss,
  eingetrageneZeilen,
  endpunkt,
  entfernenFolgen,
  entfernenFrage,
  kennungFehler,
  kennungVorschlag,
  meldung,
  schritte,
  cockpitHinweis,
  ANSCHLUSS_FRAGE,
  ANSCHLUSS_HILFE,
  ANSCHLUSS_OPTIONEN,
  ANSCHLUSS_VORGABE,
  anschlussSicht,
  anschlussSoll,
  anschlussWahl,
  anschlussZumSenden,
  NENNLEISTUNG_AUSWAHL_KW,
  NENNLEISTUNG_VORGABE_KW,
  nennleistungFehler,
  nennleistungFeld,
  nennleistungSoll,
  nennleistungText,
  nennleistungWert,
  nennleistungZumSenden,
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

/** Der Herzschlag-Eintrag einer eingetragenen, nie verbundenen Kennung (Audit W-04). */
const nieVerbundenHalle = saeule({
  chargePointId: 'saeule-halle', connected: false, ready: false, lastSeen: null,
  note: 'Diese Ladesäule hat sich noch nicht gemeldet.', connectors: [],
});

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

  it('behält auch ein nacktes IPv6-Literal vollständig und klammert es für die URL', () => {
    const v6 = { ...BOX, lanHost: 'fd00::42', lanSource: 'schnittstelle' } as Device;
    expect(endpunkt(v6, laden(), 'x').url).toBe('ws://[fd00::42]:8887/ocpp/x');
  });

  it('erfindet nie eine Adresse - jede fehlende Angabe wird BENANNT', () => {
    const ohneAdresse = endpunkt({ ...BOX, lanHost: null } as Device, laden(), 'x');
    expect(ohneAdresse.url).toBeNull();
    expect(ohneAdresse.grund).toBe('keine-adresse');
    expect(ohneAdresse.satz).toContain('Geräteseite');

    // Der vom Host erkannte SCHNITTSTELLEN-Endpunkt ist seit der VPN-Härtung
    // gerade die maßgebliche Kundennetz-Adresse.
    const nurGemeldet = endpunkt({ ...BOX, lanSource: 'schnittstelle' } as Device, laden(), 'x');
    expect(nurGemeldet.url).toBe('ws://192.168.1.5:8887/ocpp/x');
    expect(nurGemeldet.grund).toBeNull();

    const publicHost = endpunkt({ ...BOX, lanHost: '8.8.8.8:8484' } as Device, laden(), 'x');
    expect(publicHost.url).toBeNull();
    expect(publicHost.grund).toBe('keine-adresse');

    const lauschtNicht = endpunkt(BOX, laden({ ocppPort: null }), 'x');
    expect(lauschtNicht.url).toBeNull();
    expect(lauschtNicht.grund).toBe('lauscht-nicht');

    // ⚠ „Noch nichts gemeldet" ist NICHT „lauscht nicht": vor der ersten
    // eingetragenen Kennung meldet die Box gar keine Ladepunkt-Lage, und
    // „es kann sich keine Säule verbinden" wäre dort schlicht falsch.
    const nochNichts = endpunkt(BOX, { budget: null, chargers: [] } as unknown as SiteCharging, 'x');
    expect(nochNichts.url).toBeNull();
    expect(nochNichts.grund).toBe('noch-nicht-gemeldet');
    expect(nochNichts.satz).toContain('Sobald die Kennung eingetragen ist');

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
    expect(m.wort).toBe('Bereit zum Steuern');
    expect(m.satz).toContain('ABL eMH1');
    expect(m.satz).toContain('2 Stecker');
  });

  // Audit W-04: die Box führt jede EINGETRAGENE Kennung in ihrer Liste - auch
  // eine, unter der nie eine Wallbox angerufen hat. Genau dieser Herzschlag-
  // Eintrag (`core/agent/ocpp.go`, ohne `lastSeen`) war vorher grün.
  const nieVerbunden = saeule({
    connected: false,
    ready: false,
    lastSeen: null,
    note: 'Diese Ladesäule hat sich noch nicht gemeldet.',
    connectors: [],
  });

  it('⚠ eingetragen, nie verbunden: „Wartet auf die Wallbox" - nicht „Hat sich gemeldet" (W-04)', () => {
    const m = meldung({ ...laden(), chargers: [nieVerbunden] }, 'saeule-hof-nord');
    expect(m.gemeldet).toBe(false);
    expect(m.wort).toBe('Wartet auf die Wallbox');
    expect(m.ton).toBe('warten');
    // Der Techniker erfährt, was er prüfen muss.
    expect(m.satz).toContain('Prüfen Sie Adresse und Kennung');
    expect(schritte(true, m.gemeldet).find((x) => x.id === 'melden')?.erledigt).toBe(false);
  });

  it('verbunden, Sicherheitsprofil noch offen: „Verbunden" mit Zeitpunkt (W-04)', () => {
    const m = meldung(
      { ...laden(), chargers: [saeule({ ready: false, lastSeen: '2026-10-26T09:10:00Z' })] },
      'saeule-hof-nord',
      Date.parse('2026-10-26T09:11:00Z'),
    );
    expect(m.gemeldet).toBe(true);
    expect(m.wort).toBe('Verbunden');
    expect(m.ton).toBe('warten');
    expect(m.satz).toMatch(/zuletzt gemeldet \d{2}:\d{2} Uhr/);
    expect(m.satz).toContain('Sicherheitsprofil wird gerade hinterlegt');
  });

  it('⚠ verbunden, aber nicht steuerbar: abgelehntes Profil oder Box ohne Freigabe (W-04/W-05/W-01)', () => {
    const abgelehnt = meldung(
      { ...laden(), chargers: [saeule({ ready: false, note: 'Ladesäule nicht eingerichtet: das Sicherheitsprofil wurde abgelehnt (NotSupported)' })] },
      'saeule-hof-nord',
    );
    expect(abgelehnt).toMatchObject({ gemeldet: true, wort: 'Verbunden – nicht steuerbar', ton: 'warn' });
    expect(abgelehnt.satz).toContain('Diese Wallbox nimmt keine Ladegrenzen an');
    expect(abgelehnt.satz).toContain('NotSupported');

    const werk = meldung({ ...laden({ controlEnabled: false }), chargers: [saeule()] }, 'saeule-hof-nord');
    expect(werk).toMatchObject({ wort: 'Verbunden – nicht steuerbar', ton: 'warn' });
    expect(werk.satz).toContain('VoltPilot regelt diese Wallbox noch nicht');
  });

  it('schon einmal da gewesen, jetzt getrennt: „Getrennt" mit letztem Kontakt', () => {
    const m = meldung(
      { ...laden(), chargers: [saeule({ connected: false, lastSeen: '2026-10-25T09:10:00Z' })] },
      'saeule-hof-nord',
      Date.parse('2026-10-26T09:10:00Z'),
    );
    expect(m).toMatchObject({ gemeldet: true, wort: 'Getrennt', ton: 'warten' });
    expect(m.satz).toMatch(/^Wallbox nicht erreichbar seit 25\.10\. \d{2}:\d{2} Uhr\.$/);
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

});

describe('Eine Kennung wieder entfernen', () => {
  it('fragt nach der SÄULE, nicht nach der Kennung', () => {
    expect(entfernenFrage('Hof Nord')).toContain('Hof Nord');
    expect(entfernenFrage('Hof Nord')).toContain('nicht mehr annehmen');
  });

  it('sagt die WAHRHEIT über den laufenden Ladevorgang - er endet NICHT', () => {
    const folgen = entfernenFolgen('Hof Nord');
    const alles = folgen.join(' ');
    // ⚠ Die Box trennt die Verbindung, aber das Sicherheitsprofil liegt IN der
    // Säule (OCPP-eigener Totmann) - sie lädt damit weiter. Ein „der
    // Ladevorgang endet" wäre eine Falschaussage über eine Kundenanlage.
    expect(alles).toContain('endet dadurch NICHT');
    expect(alles).toContain('Sicherheitsprofil');
    expect(alles).toMatch(/Verbindung .*getrennt/);
  });

  it('nennt ausdrücklich, was GLEICH bleibt, und dass der Weg zurück offen ist', () => {
    const alles = entfernenFolgen('Hof Nord').join(' ');
    expect(alles).toContain('Anschlussgrenze');
    expect(alles).toContain('unverändert');
    expect(alles).toContain('jederzeit wieder eintragen');
  });

  it('behauptet keine sofortige Wirkung am Gerät', () => {
    // Das Dokument reist retained - wann die Box es abholt, entscheidet sie.
    expect(ENTFERNEN_HINWEIS).toContain('das nächste Mal verbunden');
    expect(ENTFERNEN_HINWEIS).toContain('Bis dahin');
  });
});

describe('Liste der Eingetragenen', () => {
  it('erfindet keinen Namen - ohne Label steht die Kennung da', () => {
    const zeilen = eingetrageneZeilen(
      [
        { chargePointId: 'saeule-hof-nord', label: 'Hof Nord' },
        { chargePointId: 'saeule-halle' },
      ],
      { ...laden(), chargers: [saeule(), { ...nieVerbundenHalle }] },
    );
    expect(zeilen[0]).toMatchObject({ name: 'Hof Nord', zustand: 'Bereit zum Steuern', ton: 'ok' });
    // ⚠ Die Box führt die Halle, aber sie hat nie angerufen (W-04).
    expect(zeilen[1]).toMatchObject({ name: 'saeule-halle', zustand: 'Wartet auf die Wallbox', ton: 'warten' });
  });

  it('kommt ohne Allowlist zurecht', () => {
    expect(eingetrageneZeilen(null, null)).toEqual([]);
    expect(eingetrageneZeilen(undefined, laden())).toEqual([]);
  });
});

describe('cockpitHinweis · wohin der Kunde nach dem Anbinden schaut (Konzept §8, Schritt 6)', () => {
  it('nennt Kachel und Energiefluss - erst, wenn die Säule sich gemeldet hat', () => {
    const satz = cockpitHinweis(true)!;
    expect(satz).toContain('Laden');
    expect(satz).toContain('Cockpit');
    expect(satz).toContain('Anpassen');
  });

  it('⚠ verspricht NICHTS, solange die Säule stumm ist', () => {
    // Eine eingetragene, aber stumme Kennung ist noch kein Ladepunkt - das
    // Cockpit bietet den Baustein dann gar nicht an.
    expect(cockpitHinweis(false)).toBeNull();
  });

  it('spricht Kundensprache: kein „Anwendung", kein Baustein, kein Kanalname', () => {
    const satz = cockpitHinweis(true)!;
    expect(satz).not.toMatch(/Anwendung|Baustein|OCPP|power_kw|Entität/);
  });
});

// ---------------------------------------------------------------------------
// Cockpit Phase 1 / C1: WO die Säule hängt (Captain-Entscheid E5)
// ---------------------------------------------------------------------------

describe('Anschluss · haus|eigen', () => {
  it('bietet GENAU ZWEI Orte an, und genau EINER ist die Vorgabe', () => {
    expect(ANSCHLUSS_OPTIONEN.map((o) => o.value)).toEqual(['haus', 'eigen']);
    expect(ANSCHLUSS_OPTIONEN.filter((o) => o.vorgabe)).toHaveLength(1);
  });

  it('⚠ die Vorgabe ist die SICHERE Richtung: hinter dem Hausanschluss', () => {
    // „haus" heißt „ihre Leistung wird in der Bilanz der Box zurückaddiert".
    // Wäre die Wahrheit „eigen", fiele das Budget nur zu KLEIN aus - der
    // Hausanschluss bleibt geschützt. Umgekehrt wäre er es nicht.
    expect(ANSCHLUSS_VORGABE).toBe('haus');
  });

  it('fragt nach einer TATSACHE der Anlage, nicht nach einer Vorliebe', () => {
    expect(ANSCHLUSS_FRAGE).toMatch(/Wo hängt/);
    expect(ANSCHLUSS_FRAGE).not.toMatch(/empfohlen|möchten|bevorzug/i);
  });

  it('sagt die FOLGE in Kundensprache - nie die Formel der Box', () => {
    expect(ANSCHLUSS_HILFE).toContain('Netzbezug');
    expect(ANSCHLUSS_HILFE).not.toMatch(/budget\s*=|planbar|OCPP|power_kw/);
    for (const o of ANSCHLUSS_OPTIONEN) {
      expect(o.satz).not.toMatch(/OCPP|Entität|power_kw|Baustein|Anwendung/);
    }
  });

  it('liest das SOLL aus der Allowlist - eine unbekannte Kennung sagt nichts', () => {
    const liste = [
      { chargePointId: 'saeule-strasse', connection: 'eigen' as const },
      { chargePointId: 'saeule-hof-nord' },
    ];
    expect(anschlussSoll(liste, 'saeule-strasse')).toBe('eigen');
    // ⚠ Eine eingetragene Zeile OHNE Angabe ist „nichts gesagt", nicht „haus".
    expect(anschlussSoll(liste, 'saeule-hof-nord')).toBeNull();
    expect(anschlussSoll(liste, 'gibt-es-nicht')).toBeNull();
    expect(anschlussSoll(null, 'saeule-strasse')).toBeNull();
    expect(anschlussSoll(liste, '  ')).toBeNull();
  });

  it('zeigt ohne Wahl die Vorgabe - denn danach wird gerechnet', () => {
    expect(anschlussWahl(null)).toBe('haus');
    expect(anschlussWahl(undefined)).toBe('haus');
    expect(anschlussWahl('eigen')).toBe('eigen');
  });

  it('⚠ sendet eine UNVERÄNDERTE Wahl gar nicht - das Dokument bleibt byte-gleich', () => {
    expect(anschlussZumSenden('haus', 'haus')).toBeUndefined();
    expect(anschlussZumSenden('eigen', 'eigen')).toBeUndefined();
  });

  it('sendet die Wahl beim ERSTEN Eintragen mit - auch wenn sie die Vorgabe ist', () => {
    // Der Kunde hat sie gesehen und stehen lassen; genau das ist eine Aussage,
    // und erst sie macht das SOLL in der Allowlist ausdrücklich.
    expect(anschlussZumSenden('haus', null)).toBe('haus');
    expect(anschlussZumSenden('eigen', null)).toBe('eigen');
    expect(anschlussZumSenden('eigen', 'haus')).toBe('eigen');
  });

  it('stellt das SOLL dar und schweigt, solange die Box nichts anderes meldet', () => {
    expect(anschlussSicht('eigen', 'eigen')).toEqual({
      wort: 'Eigener Netzanschluss',
      hinweis: null,
    });
    // ⚠ Eine Box, die gar nichts meldet, ist ein ÄLTERER Stand - daraus eine
    // Abweichung zu machen wäre eine Behauptung über eine stumme Anlage.
    expect(anschlussSicht('eigen', null).hinweis).toBeNull();
    expect(anschlussSicht(null, undefined)).toEqual({
      wort: 'Hinter dem Hausanschluss',
      hinweis: null,
    });
  });

  it('nennt die Abweichung, wenn die Box wirklich etwas ANDERES meldet', () => {
    expect(anschlussSicht('eigen', 'haus').hinweis).toMatch(/noch hinter dem Hausanschluss/);
    expect(anschlussSicht('haus', 'eigen').hinweis).toMatch(/noch auf einem eigenen Anschluss/);
  });
});

describe('Liste der Eingetragenen · Anschluss', () => {
  it('trägt das SOLL je Zeile und den Nachsatz nur bei echter Abweichung', () => {
    const zeilen = eingetrageneZeilen(
      [
        { chargePointId: 'saeule-strasse', label: 'Straße', connection: 'eigen' },
        { chargePointId: 'saeule-hof-nord', label: 'Hof Nord' },
      ],
      {
        ...laden(),
        chargers: [
          // Die Box führt sie NOCH hinter dem Haus - das Dokument ist unterwegs.
          saeule({ chargePointId: 'saeule-strasse', connection: 'haus' }),
          saeule({ chargePointId: 'saeule-hof-nord', connection: 'haus' }),
        ],
      },
    );
    expect(zeilen[0].anschluss.wort).toBe('Eigener Netzanschluss');
    expect(zeilen[0].anschluss.hinweis).toMatch(/noch hinter dem Hausanschluss/);
    // Ohne Wahl steht die Vorgabe da, und die Box meldet dasselbe ⇒ kein Nachsatz.
    expect(zeilen[1].anschluss).toEqual({ wort: 'Hinter dem Hausanschluss', hinweis: null });
  });

  it('⚠ Bestand byte-gleich: eine Box ohne das Feld erzeugt keinen Nachsatz', () => {
    const zeilen = eingetrageneZeilen(
      [{ chargePointId: 'saeule-hof-nord', label: 'Hof Nord' }],
      { ...laden(), chargers: [saeule()] },
    );
    expect(zeilen[0]).toMatchObject({ name: 'Hof Nord', zustand: 'Bereit zum Steuern', ton: 'ok' });
    expect(zeilen[0].anschluss).toEqual({ wort: 'Hinter dem Hausanschluss', hinweis: null });
  });
});

describe('Nennleistung (Audit W-02, Zusatz aus dem Paket Cloud)', () => {
  it('schlägt 11 kW vor und bietet die üblichen Stufen an', () => {
    expect(NENNLEISTUNG_VORGABE_KW).toBe(11);
    expect(NENNLEISTUNG_AUSWAHL_KW.map(nennleistungText)).toEqual(['3,7', '7,4', '11', '22']);
  });

  it('liest die deutsche Eingabe und sagt, was fehlt', () => {
    expect(nennleistungWert('7,4')).toBe(7.4);
    expect(nennleistungWert(' 22 ')).toBe(22);
    expect(nennleistungFehler('11')).toBeNull();
    expect(nennleistungWert('')).toBeNull();
    expect(nennleistungFehler('')).toContain('Nennleistung');
    expect(nennleistungWert('elf')).toBeNull();
    expect(nennleistungFehler('elf')).toContain('Zahl');
    // ⚠ Fehlend ist nie 0 - und 0 ist keine Nennleistung.
    expect(nennleistungWert('0')).toBeNull();
    expect(nennleistungFehler('0')).toContain('größer als 0');
    expect(nennleistungWert('1001')).toBeNull();
  });

  it('liest die gespeicherte Nennleistung einer eingetragenen Kennung', () => {
    const liste = [{ chargePointId: 'saeule-hof-nord', ratedKw: 22 }, { chargePointId: 'saeule-halle', ratedKw: null }];
    expect(nennleistungSoll(liste, 'saeule-hof-nord')).toBe(22);
    expect(nennleistungSoll(liste, 'saeule-halle')).toBeNull();
    expect(nennleistungSoll(null, 'saeule-hof-nord')).toBeNull();
  });

  it('schickt sie beim ersten Eintragen immer, danach nur eine Änderung', () => {
    expect(nennleistungZumSenden(11, null, false)).toBe(11);
    expect(nennleistungZumSenden(11, 11, true)).toBeUndefined();
    expect(nennleistungZumSenden(22, 11, true)).toBe(22);
    // Eine ältere Kennung ohne Nennleistung bekommt sie, sobald jemand sie eintippt.
    expect(nennleistungZumSenden(11, null, true)).toBe(11);
    expect(nennleistungZumSenden(null, null, false)).toBeUndefined();
  });

  it('⚠ täuscht an einer älteren Kennung ohne Nennleistung keine 11 kW vor', () => {
    // Neue Kennung: die Vorgabe steht da und reist mit.
    expect(nennleistungFeld(null, null, false)).toEqual({ text: '11', wert: 11, mangel: null, senden: 11 });
    // Eingetragen mit Wert: der gespeicherte Wert, nichts zu senden.
    expect(nennleistungFeld(null, 22, true)).toEqual({ text: '22', wert: 22, mangel: null, senden: undefined });
    // Eingetragen ohne Wert: leer, kein Fehler, nichts zu senden - unbekannt ist nicht falsch.
    expect(nennleistungFeld(null, null, true)).toEqual({ text: '', wert: null, mangel: null, senden: undefined });
    // Erst eine Eingabe wird geprüft.
    expect(nennleistungFeld('', null, true).mangel).toContain('Nennleistung');
    expect(nennleistungFeld('7,4', null, true).senden).toBe(7.4);
  });
});
