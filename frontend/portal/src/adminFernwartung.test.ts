import { describe, expect, it } from 'vitest';
import {
  abrufLage,
  aktionLabel,
  boxBefehl,
  boxOrt,
  dauerOptionen,
  dauerText,
  fensterTeile,
  fensterText,
  loeschbar,
  loeschenRueckfrage,
  oeffnenSperre,
  offenesFenster,
  protokollDetail,
  schluesselGueltig,
  serverLage,
  technikerKonfig,
  technikerOptionen,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungServer,
  type FernwartungTechniker,
  type FernwartungUebersicht,
} from './adminFernwartung';

const JETZT = new Date('2026-10-07T12:00:00Z'); // 14:00 in Berlin

const server: FernwartungServer = {
  endpunkt: 'wartung.voltpilot.de',
  port: 51820,
  publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true,
  boxNetz: '10.10.16.0/20',
  technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1',
  technikerServerAdresse: '10.10.32.1',
};

function fenster(p: Partial<FernwartungFenster> = {}): FernwartungFenster {
  return {
    id: 'f1',
    edgeRef: 'edge-zay5sdd',
    technikerId: 't1',
    technikerName: 'Max (Laptop)',
    grund: 'Update',
    beginn: '2026-10-07T11:30:00Z',
    ende: '2026-10-07T13:30:00Z',
    wirksamesEnde: '2026-10-07T13:30:00Z',
    zustand: 'offen',
    geoeffnetAm: '2026-10-07T11:30:00Z',
    geoeffnetVon: 'admin',
    geschlossenAm: null,
    geschlossenVon: null,
    ...p,
  };
}

function box(p: Partial<FernwartungBox> = {}): FernwartungBox {
  return {
    id: 'b1',
    edgeRef: 'edge-zay5sdd',
    publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=',
    publicKeyKurz: 'jUg9DePF…5HiEM=',
    adresse: '10.10.16.2',
    status: 'aktiv',
    notiz: null,
    angelegtAm: '2026-10-07T10:00:00Z',
    geaendertAm: '2026-10-07T10:00:00Z',
    siteId: null,
    siteName: null,
    tenantId: null,
    tenantName: null,
    laufendeFenster: [],
    ...p,
  };
}

function tech(p: Partial<FernwartungTechniker> = {}): FernwartungTechniker {
  return {
    id: 't1',
    name: 'Max (Laptop)',
    publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=',
    publicKeyKurz: 'FY4LLXFa…BI8/Y=',
    adresse: '10.10.32.2',
    status: 'aktiv',
    notiz: null,
    angelegtAm: '2026-10-07T10:00:00Z',
    geaendertAm: '2026-10-07T10:00:00Z',
    ...p,
  };
}

function uebersicht(p: Partial<FernwartungUebersicht> = {}): FernwartungUebersicht {
  return {
    server,
    maxFensterMinuten: 1440,
    abrufe: [],
    boxenAktiv: 1,
    boxenGesperrt: 0,
    technikerAktiv: 1,
    technikerGesperrt: 0,
    fensterOffen: 0,
    fensterGeplant: 0,
    stand: JETZT.toISOString(),
    ...p,
  };
}

describe('Lage des Tunnel-Dienstes: Abholen ist nicht Wirken', () => {
  it('sagt ehrlich, wenn nie abgeholt wurde', () => {
    const l = abrufLage(uebersicht(), JETZT);
    expect(l.ton).toBe('off');
    expect(l.text).toContain('noch nie abgeholt');
  });

  it('warnt, wenn der letzte Abruf zu alt ist', () => {
    const l = abrufLage(
      uebersicht({ abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: '2026-10-07T11:50:00Z', peers: 3, fenster: 1 }] }),
      JETZT,
    );
    expect(l.ton).toBe('warn');
    expect(l.text).toContain('vor 10 min');
  });

  it('nennt den frischen Abruf mit dem, was abgeholt wurde', () => {
    const l = abrufLage(
      uebersicht({ abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: '2026-10-07T11:59:40Z', peers: 3, fenster: 1 }] }),
      JETZT,
    );
    expect(l.ton).toBe('ok');
    expect(l.text).toBe('Soll-Stand zuletzt vor 20 s abgeholt (3 Zugänge, 1 offene Fenster).');
  });

  it('benennt den fehlenden Server-Schlüssel', () => {
    expect(serverLage({ ...server, publicKey: null, eingerichtet: false }).titel).toBe(
      'Wartungsserver noch nicht eingerichtet',
    );
    expect(serverLage(server).titel).toBe('wartung.voltpilot.de:51820');
  });
});

describe('Fenster', () => {
  it('beschreibt jeden Zustand in einem Satz (Europe/Berlin)', () => {
    expect(fensterText(fenster(), JETZT)).toBe('offen bis 15:30 · Max (Laptop)');
    expect(fensterText(fenster({ zustand: 'geplant', beginn: '2026-10-08T07:00:00Z' }), JETZT)).toBe(
      'geplant ab 08.10., 09:00 · Max (Laptop)',
    );
    expect(fensterText(fenster({ zustand: 'abgesagt' }), JETZT)).toBe('abgesagt');
  });

  it('zerlegt den Satz in Abzeichen und Text', () => {
    expect(fensterTeile(fenster(), JETZT)).toEqual({ zustand: 'offen', text: 'bis 15:30 · Max (Laptop)' });
    expect(
      fensterTeile(fenster({ zustand: 'geschlossen', geschlossenAm: '2026-10-07T11:45:00Z' }), JETZT),
    ).toEqual({ zustand: 'geschlossen', text: '13:45' });
    expect(fensterTeile(fenster({ zustand: 'abgesagt' }), JETZT)).toEqual({ zustand: 'abgesagt', text: '' });
  });

  it('sperrt zu lange Dauern sichtbar mit Grund statt sie wegzulassen (E10)', () => {
    const o = dauerOptionen(240);
    expect(o.map((x) => x.label)).toEqual(['30 Minuten', '1 Stunde', '4 Stunden', '24 Stunden']);
    expect(o[3].disabled).toBe(true);
    expect(o[3].disabledHint).toBe('länger als erlaubt (höchstens 4 Stunden)');
    expect(o.slice(0, 3).every((x) => !x.disabled)).toBe(true);
    expect(dauerText(90)).toBe('90 Minuten');
  });

  it('zeigt gesperrte und schon eingeplante Techniker, aber nicht wählbar', () => {
    const b = box({ laufendeFenster: [fenster({ technikerId: 't1' })] });
    const o = technikerOptionen(
      [tech(), tech({ id: 't2', name: 'Anna (Tablet)', status: 'gesperrt' }), tech({ id: 't3', name: 'Ben' })],
      b,
      JETZT,
    );
    expect(o.map((x) => [x.label, x.disabled, x.disabledHint])).toEqual([
      ['Anna (Tablet)', true, 'Zugang gesperrt'],
      ['Ben', false, null],
      ['Max (Laptop)', true, 'hat schon ein Fenster (offen bis 15:30 · Max (Laptop))'],
    ]);
  });

  it('nennt, warum kein Fenster geöffnet werden kann', () => {
    expect(oeffnenSperre(box({ status: 'gesperrt' }), [tech()])).toContain('gesperrt');
    expect(oeffnenSperre(box(), [tech({ status: 'gesperrt' })])).toContain('keinen aktiven Techniker-Zugang');
    expect(oeffnenSperre(box({ laufendeFenster: [fenster()] }), [tech()])).toContain('schon ein Fenster');
    expect(oeffnenSperre(box(), [tech()])).toBeNull();
  });

  it('findet das zuerst endende offene Fenster', () => {
    const b = box({
      laufendeFenster: [
        fenster({ id: 'spaet', ende: '2026-10-07T18:00:00Z' }),
        fenster({ id: 'geplant', zustand: 'geplant', ende: '2026-10-07T13:00:00Z' }),
        fenster({ id: 'frueh', ende: '2026-10-07T13:00:00Z' }),
      ],
    });
    expect(offenesFenster(b)?.id).toBe('frueh');
    expect(offenesFenster(box())).toBeNull();
  });
});

describe('Einrichten: der Schlüssel bleibt auf dem Gerät', () => {
  it('baut die Befehlszeile für service-tunnel.sh aus Adresse und Server', () => {
    expect(boxBefehl(box(), server)).toBe(
      "VP_SERVICE_ENDPOINT=wartung.voltpilot.de VP_SERVICE_PUBKEY='LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=' " +
        'VP_SERVICE_NET=10.10.32.0/24 edge-light/openwrt/service-tunnel.sh root@<box> 10.10.16.2 51820',
    );
    expect(boxBefehl(box(), { ...server, publicKey: null, eingerichtet: false })).toBeNull();
  });

  it('gibt dem Techniker eine Konfiguration ohne privaten Schlüssel', () => {
    const k = technikerKonfig(tech(), server);
    expect(k).toContain('Address = 10.10.32.2/32');
    expect(k).toContain('AllowedIPs = 10.10.16.0/20');
    expect(k).toContain('Endpoint = wartung.voltpilot.de:51820');
    expect(k).toContain('PrivateKey = <privater Schlüssel dieses Geräts>');
    expect(k).not.toContain(tech().publicKey);
  });

  it('prüft Schlüssel wie API und Tunnel-Dienst', () => {
    expect(schluesselGueltig('jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=')).toBe(true);
    expect(schluesselGueltig(' jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM= ')).toBe(true);
    expect(schluesselGueltig('jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEB=')).toBe(false);
    expect(schluesselGueltig('abc')).toBe(false);
  });

  it('sagt, wenn eine Box noch keinem Kunden gehört', () => {
    expect(boxOrt(box())).toBe('noch nicht gekoppelt');
    expect(boxOrt(box({ siteName: 'Dirolf', tenantName: 'Familie Dirolf' }))).toBe('Dirolf · Familie Dirolf');
  });
});

describe('Protokoll', () => {
  it('übersetzt jede Aktion und ihre Einzelheiten', () => {
    expect(aktionLabel('fenster_geoeffnet')).toBe('Fenster geöffnet');
    expect(aktionLabel('unbekannt')).toBe('unbekannt');
    const base = { id: 'p', zeit: JETZT.toISOString(), akteur: 'admin', edgeRef: 'edge-zay5sdd', technikerId: 't1', technikerName: 'Max', fensterId: 'f1' };
    expect(
      protokollDetail(
        { ...base, aktion: 'fenster_geoeffnet', details: { dauerMinuten: '60', beginn: '2026-10-07T12:00:00Z', grund: 'Update' } },
        JETZT,
      ),
    ).toBe('1 Stunde · ab 14:00 · Grund: Update');
    expect(protokollDetail({ ...base, aktion: 'fenster_geschlossen', details: { anlass: 'box_gesperrt' } }, JETZT)).toBe(
      'weil die Box gesperrt wurde',
    );
    expect(
      protokollDetail({ ...base, aktion: 'box_schluessel_getauscht', details: { alt: 'aaa…', neu: 'bbb…' } }, JETZT),
    ).toBe('aaa… → bbb…');
  });

  it('nennt beim gelöschten Zugang, was vergeben bleibt', () => {
    expect(aktionLabel('techniker_geloescht')).toBe('Techniker-Zugang gelöscht');
    const base = { id: 'p', zeit: JETZT.toISOString(), akteur: 'admin', edgeRef: null, technikerId: 't1', technikerName: 'Max', fensterId: null };
    expect(
      protokollDetail(
        { ...base, aktion: 'techniker_geloescht', details: { name: 'Max', adresse: '10.10.32.2', publicKey: 'FY4LLXFa…BI8/Y=' } },
        JETZT,
      ),
    ).toBe('10.10.32.2 · FY4LLXFa…BI8/Y= · bleiben vergeben');
    expect(protokollDetail({ ...base, aktion: 'techniker_geloescht', details: {} }, JETZT)).toBe('');
  });
});

describe('Techniker-Zugang löschen', () => {
  const zugang = (status: 'aktiv' | 'gesperrt'): FernwartungTechniker => ({
    id: 't1',
    name: 'Max (Laptop)',
    publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=',
    publicKeyKurz: 'FY4LLXFa…BI8/Y=',
    adresse: '10.10.32.2',
    status,
    notiz: null,
    angelegtAm: '2026-10-07T10:00:00Z',
    geaendertAm: '2026-10-07T10:00:00Z',
  });

  it('nur ein gesperrter Zugang ist löschbar', () => {
    expect(loeschbar(zugang('gesperrt'))).toBe(true);
    expect(loeschbar(zugang('aktiv'))).toBe(false);
  });

  it('die Rückfrage sagt in EINEM Satz, was passiert und dass es endgültig ist', () => {
    const frage = loeschenRueckfrage(zugang('gesperrt'));
    expect(frage.titel).toBe('Zugang löschen?');
    expect(frage.satz).toContain('„Max (Laptop)“');
    // Ein Satz: genau ein Satzende, und es steht am Schluss.
    expect(frage.satz.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(frage.satz).toMatch(/endgültig/);
    expect(frage.satz).toMatch(/nicht wiederherstellen/);
    // Zwei Zugänge können gleich heißen: Adresse und Schlüssel sagen, welcher.
    expect(frage.satz).toContain('10.10.32.2');
    expect(frage.satz).toContain('FY4LLXFa…BI8/Y=');
    expect(frage.folgen.join(' ')).toMatch(/bleiben vergeben/);
    expect(frage.folgen.join(' ')).toMatch(/Protokolleinträge bleiben lesbar/);
  });
});
