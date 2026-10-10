import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  abrufLage,
  aktionLabel,
  boxBefehl,
  boxOrt,
  boxVerbindung,
  dauerOptionen,
  dauerText,
  boxAnmeldung,
  FENSTER_WIRKUNG_SATZ,
  rueckmeldungLage,
  fensterTeile,
  fensterText,
  loeschbar,
  loeschenRueckfrage,
  nurNetzwegSatz,
  oeffnenSperre,
  offenesFenster,
  protokollDetail,
  schluesselGueltig,
  serverLage,
  SSH_ERZEUGEN,
  SSH_STAND_SATZ,
  sshBefehle,
  sshSchluesselPruefen,
  sshText,
  technikerKonfig,
  technikerOptionen,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungRueckmeldung,
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
    sshPublicKey: null,
    sshFingerabdruck: null,
    sshBits: null,
    ...p,
  };
}

const FINGERABDRUCK = 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc';

/** Ein Zugang mit hinterlegtem SSH-Schlüssel; der Schlüssel selbst spielt für die Ableitungen keine Rolle. */
function techMitSsh(p: Partial<FernwartungTechniker> = {}): FernwartungTechniker {
  return tech({ sshPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EA', sshFingerabdruck: FINGERABDRUCK, sshBits: 3072, ...p });
}

// ── SSH-Schlüssel zur Laufzeit: der private Teil verlässt diese Funktion nie ──

function feld(bytes: Buffer): Buffer {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(bytes.length);
  return Buffer.concat([laenge, bytes]);
}

/** Eine Zahl im SSH-Format: ein Nullbyte davor, wenn das oberste Bit gesetzt ist. */
function zahl(roh: Buffer): Buffer {
  let i = 0;
  while (i < roh.length - 1 && roh[i] === 0) i += 1;
  const knapp = roh.subarray(i);
  return knapp[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), knapp]) : knapp;
}

function sshZeile(typ: string, ...felder: Buffer[]): string {
  return `${typ} ${Buffer.concat(felder.map(feld)).toString('base64')}`;
}

function rsaAus(e: Buffer, n: Buffer): string {
  return sshZeile('ssh-rsa', Buffer.from('ssh-rsa'), zahl(e), zahl(n));
}

function rsa(bits: number): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return rsaAus(Buffer.from(jwk.e, 'base64url'), Buffer.from(jwk.n, 'base64url'));
}

function ed25519(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return sshZeile('ssh-ed25519', Buffer.from('ssh-ed25519'), Buffer.from(jwk.x, 'base64url'));
}

/** Eine ungerade Zahl mit genau so vielen Bit. */
function ungerade(bits: number): Buffer {
  const n = Buffer.alloc(Math.ceil(bits / 8));
  n[0] = 1 << ((bits - 1) % 8);
  n[n.length - 1] |= 1;
  return n;
}

const E = Buffer.from([1, 0, 1]);

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

// ── Rückmeldung des Tunnel-Dienstes ─────────────────────────────────────────

/** Eine Meldung, angenommen 20 s vor JETZT; der Dienst läuft seit 09:15 (Berlin 11:15). */
function gemeldet(p: Partial<FernwartungRueckmeldung> = {}): FernwartungRueckmeldung {
  return {
    dienst: 'voltpilot-tunnel-dienst',
    zuletztAm: '2026-10-07T11:59:40Z',
    gestartetUm: '2026-10-07T09:15:00Z',
    schluesselausgabe: true,
    boxen: 2,
    fenster: 1,
    ...p,
  };
}

/** Die Übersicht mit frischem Abruf und dieser Meldung. */
function mitMeldung(p: Partial<FernwartungRueckmeldung> = {}): FernwartungUebersicht {
  return uebersicht({
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: '2026-10-07T11:59:40Z', peers: 3, fenster: 1 }],
    rueckmeldungen: [gemeldet(p)],
  });
}

const FRISCH = '2026-10-07T11:59:40Z';
const ALT = '2026-10-07T11:40:00Z';

describe('Rückmeldung des Tunnel-Dienstes: was er meldet, mit dem Alter - und was unbekannt bleibt', () => {
  it('die Lage-Zeile unterscheidet keine, veraltete und frische Meldung', () => {
    // Neue API, alter Dienst: er holt ab, meldet aber nichts.
    const alterDienst = rueckmeldungLage(
      uebersicht({ abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: FRISCH, peers: 3, fenster: 1 }] }),
      JETZT,
    );
    expect(alterDienst.ton).toBe('off');
    expect(alterDienst.titel).toBe('Tunnel-Dienst meldet keinen Zustand');
    expect(alterDienst.text).toMatch(/holt den Soll-Stand ab, hat aber noch nie gemeldet/);
    expect(alterDienst.text).toMatch(/vermutlich ein Stand ohne Rückmeldung/);
    expect(alterDienst.text).toMatch(/ist deshalb nicht bekannt/);
    // Eine API vor der Rückmeldung liefert das Feld gar nicht: dasselbe wie leer.
    const ohneFeld = uebersicht();
    delete ohneFeld.rueckmeldungen;
    expect(rueckmeldungLage(ohneFeld, JETZT).titel).toBe('Tunnel-Dienst meldet keinen Zustand');
    expect(rueckmeldungLage(ohneFeld, JETZT).text).not.toMatch(/holt den Soll-Stand ab/);

    const veraltet = rueckmeldungLage(mitMeldung({ zuletztAm: ALT }), JETZT);
    expect(veraltet.ton).toBe('warn');
    expect(veraltet.titel).toBe('Meldung des Tunnel-Dienstes veraltet');
    expect(veraltet.text).toMatch(/Letzte Meldung vor 20 min/);
    expect(veraltet.text).toMatch(/ist nicht bekannt, bis der Dienst wieder meldet/);

    const frisch = rueckmeldungLage(mitMeldung(), JETZT);
    expect(frisch.ton).toBe('ok');
    expect(frisch.text).toBe(
      'Letzte Meldung vor 20 s (2 Boxen, 1 offene Fenster auf dem Wartungsserver). Der Dienst läuft seit 11:15.',
    );
    // Genau an der Grenze von drei Minuten gilt die Meldung noch.
    expect(rueckmeldungLage(mitMeldung({ zuletztAm: '2026-10-07T11:57:00Z' }), JETZT).ton).toBe('ok');
    expect(rueckmeldungLage(mitMeldung({ zuletztAm: '2026-10-07T11:56:59Z' }), JETZT).ton).toBe('warn');

    const ohneAusgabe = rueckmeldungLage(mitMeldung({ schluesselausgabe: false }), JETZT);
    expect(ohneAusgabe.ton).toBe('warn');
    expect(ohneAusgabe.text).toMatch(/Die Schlüsselausgabe ist dort aus: Keine Box bekommt einen Fenster-Schlüssel\.$/);
  });

  it('die Box: verbunden seit, mindestens seit dem Start, nicht verbunden', () => {
    const verbunden = boxVerbindung(
      box({ rueckmeldung: { gemeldetAm: FRISCH, verbundenSeit: '2026-10-07T09:42:07Z', zuletztGefragtUm: '2026-10-07T11:59:12Z' } }),
      mitMeldung(),
      JETZT,
    );
    expect([verbunden.fall, verbunden.ton, verbunden.titel]).toEqual(['verbunden', 'ok', 'Box verbunden']);
    expect(verbunden.text).toBe(
      'Verbunden seit 11:42. Sie hat zuletzt um 13:59 nach Schlüsseln gefragt. Stand: vor 20 s.',
    );

    // Gleich dem Start des Dienstes: wie lange davor, weiß niemand.
    const mindestens = boxVerbindung(
      box({ rueckmeldung: { gemeldetAm: FRISCH, verbundenSeit: '2026-10-07T09:15:00Z', zuletztGefragtUm: null } }),
      mitMeldung(),
      JETZT,
    );
    expect(mindestens.text).toBe(
      'Verbunden mindestens seit 11:15 (Start des Tunnel-Dienstes). Sie hat seit dem Start des Tunnel-Dienstes (11:15) nicht nach Schlüsseln gefragt. Stand: vor 20 s.',
    );

    const getrennt = boxVerbindung(
      box({ rueckmeldung: { gemeldetAm: FRISCH, verbundenSeit: null, zuletztGefragtUm: null } }),
      mitMeldung(),
      JETZT,
    );
    expect([getrennt.fall, getrennt.ton, getrennt.titel]).toEqual(['nicht_verbunden', 'warn', 'Box nicht verbunden']);
    expect(getrennt.text).toBe(
      'Die Box ist nicht mit dem Wartungsserver verbunden: kein WireGuard-Handshake in den letzten 3 Minuten. Stand: vor 20 s.',
    );
  });

  it('unbekannt ist kein „nicht verbunden": keine Meldung, alte Meldung, Box nicht genannt', () => {
    const nichtVerbunden = { gemeldetAm: ALT, verbundenSeit: null, zuletztGefragtUm: null };
    const faelle: Array<[string, ReturnType<typeof boxVerbindung>, RegExp]> = [
      ['nie gemeldet', boxVerbindung(box(), uebersicht(), JETZT), /noch nie seinen Zustand gemeldet/],
      ['API ohne das Feld', boxVerbindung(box({ rueckmeldung: undefined }), uebersicht({ rueckmeldungen: undefined }), JETZT), /noch nie seinen Zustand gemeldet/],
      ['Übersicht nicht geladen', boxVerbindung(box(), null, JETZT), /ließ sich nicht laden/],
      // Die letzte Angabe sagte „nicht verbunden" - sie ist aber 20 Minuten alt.
      ['veraltet', boxVerbindung(box({ rueckmeldung: nichtVerbunden }), mitMeldung({ zuletztAm: ALT }), JETZT), /ist 20 min alt\. Damals war die Box nicht verbunden\./],
      // Die Meldung ist frisch, die Angabe zur Box stammt aus einer früheren.
      ['Box nicht in der letzten Meldung', boxVerbindung(box({ rueckmeldung: nichtVerbunden }), mitMeldung(), JETZT), /nennt diese Box nicht/],
      ['Box nie genannt', boxVerbindung(box({ rueckmeldung: null }), mitMeldung(), JETZT), /nennt diese Box nicht/],
      ['gesperrt', boxVerbindung(box({ status: 'gesperrt' }), mitMeldung(), JETZT), /gesperrt; der Wartungsserver führt sie nicht/],
    ];
    for (const [name, v, satz] of faelle) {
      expect([name, v.fall, v.ton, v.titel]).toEqual([name, 'unbekannt', 'off', 'Verbindung unbekannt']);
      expect(v.text, name).toMatch(satz);
      expect(v.text, name).not.toMatch(/^Die Box ist nicht mit dem Wartungsserver verbunden/);
    }
    // Box und Übersicht kommen aus getrennten Abrufen: Traf dazwischen EINE neue Meldung ein
    // (30 s später), zählt die Angabe der Box noch; fehlt sie in zwei Meldungen, nicht mehr.
    const knappDavor = { gemeldetAm: '2026-10-07T11:59:10Z', verbundenSeit: '2026-10-07T09:42:07Z', zuletztGefragtUm: null };
    expect(boxVerbindung(box({ rueckmeldung: knappDavor }), mitMeldung(), JETZT).fall).toBe('verbunden');
    const zweiDavor = { ...knappDavor, gemeldetAm: '2026-10-07T11:58:40Z' };
    expect(boxVerbindung(box({ rueckmeldung: zweiDavor }), mitMeldung(), JETZT).fall).toBe('unbekannt');
    // Veraltet und verbunden: auch das behauptet die Zeile nicht für jetzt.
    const damals = boxVerbindung(
      box({ rueckmeldung: { gemeldetAm: ALT, verbundenSeit: '2026-10-07T09:42:07Z', zuletztGefragtUm: null } }),
      mitMeldung({ zuletztAm: ALT }),
      JETZT,
    );
    expect(damals.fall).toBe('unbekannt');
    expect(damals.text).toMatch(/Damals war die Box verbunden\./);
  });

  it('das Fenster: die vier Fälle aus Sicht des Technikers', () => {
    const verbunden = { gemeldetAm: FRISCH, verbundenSeit: '2026-10-07T09:42:07Z', zuletztGefragtUm: '2026-10-07T11:59:12Z' };
    const eins = (b: Partial<FernwartungBox>, f: Partial<FernwartungFenster>, t: FernwartungTechniker, u = mitMeldung()) =>
      boxAnmeldung(box({ ...b, laufendeFenster: [fenster(f)] }), [t], u, JETZT)!.fenster[0];

    // 1. Alles bereit.
    const bereit = eins({ rueckmeldung: verbunden }, { rueckmeldung: { gemeldetAm: FRISCH, schluesselAbgeholtUm: '2026-10-07T11:31:05Z' } }, techMitSsh());
    expect([bereit.fall, bereit.ton, bereit.titel]).toEqual(['bereit', 'ok', 'Alles bereit']);
    expect(bereit.satz).toBe(
      `„Max (Laptop)“: Die Box ist verbunden und hat den SSH-Schlüssel ${FINGERABDRUCK} um 13:31 abgeholt. Die Anmeldung ist möglich. Stand: vor 20 s.`,
    );

    // 2. Box verbunden, Schlüssel noch nicht abgeholt - mit dem Grund, den die Meldung hergibt.
    const offen = { rueckmeldung: { gemeldetAm: FRISCH, schluesselAbgeholtUm: null } };
    const wartet = eins({ rueckmeldung: verbunden }, offen, techMitSsh());
    expect([wartet.fall, wartet.ton, wartet.titel]).toEqual(['nicht_abgeholt', 'warn', 'Schlüssel noch nicht abgeholt']);
    expect(wartet.satz).toBe(
      `„Max (Laptop)“: Die Box ist verbunden, hat den SSH-Schlüssel ${FINGERABDRUCK} aber noch nicht abgeholt. Sie fragt nach Schlüsseln, zuletzt um 13:59; in der Regel folgt der Schlüssel nach wenigen Sekunden. Stand: vor 20 s.`,
    );
    const fragtNie = eins({ rueckmeldung: { ...verbunden, zuletztGefragtUm: null } }, offen, techMitSsh());
    expect(fragtNie.fall).toBe('nicht_abgeholt');
    expect(fragtNie.satz).toMatch(/Sie hat seit dem Start des Tunnel-Dienstes \(11:15\) nicht nach Schlüsseln gefragt\. Vermutlich ist ihr Tunnel noch nicht mit dem aktuellen Skript \(service-tunnel\.sh\) eingerichtet/);
    const ausgabeAus = eins({ rueckmeldung: verbunden }, offen, techMitSsh(), mitMeldung({ schluesselausgabe: false }));
    expect(ausgabeAus.fall).toBe('nicht_abgeholt');
    expect(ausgabeAus.satz).toMatch(/Am Wartungsserver ist die Schlüsselausgabe aus: Keine Box bekommt einen Fenster-Schlüssel\./);

    // 3. Box nicht verbunden: das Fenster ist offen, aber niemand kommt durch.
    const getrennt = eins(
      { rueckmeldung: { gemeldetAm: FRISCH, verbundenSeit: null, zuletztGefragtUm: null } },
      { rueckmeldung: { gemeldetAm: FRISCH, schluesselAbgeholtUm: null } },
      techMitSsh(),
    );
    expect([getrennt.fall, getrennt.ton, getrennt.titel]).toEqual(['nicht_verbunden', 'warn', 'Box nicht verbunden']);
    expect(getrennt.satz).toBe(
      '„Max (Laptop)“: Die Box ist nicht mit dem Wartungsserver verbunden. Das Fenster ist offen, aber niemand erreicht die Box, und sie kann den Schlüssel nicht abholen. Stand: vor 20 s.',
    );

    // 4. Kein SSH-Schlüssel am Zugang: das weiß das Portal selbst, auch ohne jede Meldung.
    for (const u of [mitMeldung(), uebersicht(), mitMeldung({ zuletztAm: ALT })]) {
      const ohne = eins({ rueckmeldung: verbunden }, offen, tech(), u);
      expect([ohne.fall, ohne.ton, ohne.titel]).toEqual(['kein_schluessel', 'warn', 'Kein SSH-Schlüssel am Zugang']);
      expect(ohne.satz).toMatch(/nur Netzweg\. Der Zugang hat keinen SSH-Schlüssel/);
    }
  });

  it('das Fenster: unbekannt ist kein „nicht abgeholt" und kein „nicht verbunden"', () => {
    const verbunden = { gemeldetAm: FRISCH, verbundenSeit: '2026-10-07T09:42:07Z', zuletztGefragtUm: '2026-10-07T11:59:12Z' };
    const altGetrennt = { gemeldetAm: ALT, verbundenSeit: null, zuletztGefragtUm: null };
    const altOffen = { gemeldetAm: ALT, schluesselAbgeholtUm: null };
    const eins = (b: Partial<FernwartungBox>, f: Partial<FernwartungFenster>, u: FernwartungUebersicht | null) =>
      boxAnmeldung(box({ ...b, laufendeFenster: [fenster(f)] }), [techMitSsh()], u, JETZT)!.fenster[0];

    const faelle: Array<[string, ReturnType<typeof eins>, RegExp]> = [
      // Neue API, alter Dienst.
      ['nie gemeldet', eins({}, {}, uebersicht()), /ist nicht bekannt: Der Tunnel-Dienst hat dem Portal noch nie seinen Zustand gemeldet\./],
      // VM nicht erreichbar: die letzten Angaben sagten „nicht verbunden" und „nicht abgeholt".
      ['veraltet', eins({ rueckmeldung: altGetrennt }, { rueckmeldung: altOffen }, mitMeldung({ zuletztAm: ALT })), /ist nicht bekannt: Die letzte Meldung des Tunnel-Dienstes ist 20 min alt\./],
      ['Box nicht genannt', eins({ rueckmeldung: altGetrennt }, { rueckmeldung: altOffen }, mitMeldung()), /ist nicht bekannt: Die letzte Meldung des Tunnel-Dienstes \(vor 20 s\) nennt diese Box nicht\./],
      // Die Box ist verbunden, aber das Fenster steht (noch) nicht in der Meldung.
      ['Fenster nicht genannt', eins({ rueckmeldung: verbunden }, { rueckmeldung: null }, mitMeldung()), /Die Box ist verbunden; ob sie ihn abgeholt hat, ist nicht bekannt: Die letzte Meldung des Tunnel-Dienstes nennt dieses Fenster nicht\./],
      ['Fenster nur in einer früheren Meldung', eins({ rueckmeldung: verbunden }, { rueckmeldung: altOffen }, mitMeldung()), /nennt dieses Fenster nicht\. Nach dem Öffnen dauert das bis zu einer Minute; bleibt es so, wirkt das Fenster auf dem Wartungsserver nicht\./],
      ['Übersicht nicht geladen', eins({ rueckmeldung: verbunden }, {}, null), /ließ sich nicht laden/],
    ];
    for (const [name, f, satz] of faelle) {
      expect([name, f.fall, f.ton, f.titel, f.schluessel]).toEqual([name, 'unbekannt', 'off', 'Stand unbekannt', 'vorhanden']);
      expect(f.satz, name).toMatch(satz);
      // Der Satz verspricht die Anmeldung nicht und behauptet kein Scheitern.
      expect(f.satz, name).toMatch(/sobald die Box ihn abgeholt hat oder wenn er schon auf ihr liegt/);
      expect(f.satz, name).not.toMatch(/noch nicht abgeholt|nicht mit dem Wartungsserver verbunden/);
    }
  });
});

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
    sshPublicKey: null,
    sshFingerabdruck: null,
    sshBits: null,
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

describe('SSH-Schlüssel des Technikers (Fenster-Schlüssel, Schritt 1)', () => {
  it('nennt die Befehle zum Erzeugen für Windows und Linux, immer RSA und nie den Standardnamen', () => {
    expect(SSH_ERZEUGEN.map((s) => s.system)).toEqual(['Windows (PowerShell)', 'Linux und macOS']);
    for (const s of SSH_ERZEUGEN) {
      expect(s.erzeugen).toMatch(/^ssh-keygen -t rsa -b 3072 -f \S+id_rsa_voltpilot$/);
      expect(s.anzeigen).toMatch(/id_rsa_voltpilot\.pub$/);
      expect(s.fingerabdruck).toMatch(/^ssh-keygen -lf \S+id_rsa_voltpilot\.pub$/);
    }
    expect(SSH_ERZEUGEN[0].erzeugen).toBe('ssh-keygen -t rsa -b 3072 -f $env:USERPROFILE\\.ssh\\id_rsa_voltpilot');
    expect(SSH_ERZEUGEN[0].anzeigen).toBe('Get-Content $env:USERPROFILE\\.ssh\\id_rsa_voltpilot.pub');
    expect(SSH_ERZEUGEN[1].erzeugen).toBe('ssh-keygen -t rsa -b 3072 -f ~/.ssh/id_rsa_voltpilot');
    expect(SSH_ERZEUGEN[1].anzeigen).toBe('cat ~/.ssh/id_rsa_voltpilot.pub');
  });

  it('baut die fertigen Befehle für SSH und für die Web-App über SSH', () => {
    expect(sshBefehle('10.10.16.2')).toEqual({
      ssh: 'ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2',
      webApp: 'ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 -L 8484:127.0.0.1:8484 root@10.10.16.2',
      webAdresse: 'http://127.0.0.1:8484',
    });
  });

  it('zu den offenen Fenstern einer Box gibt es die Befehle und je Fenster die Auskunft zum SSH-Schlüssel', () => {
    const kim = tech({ id: 't2', name: 'Kim (Tablet)', adresse: '10.10.32.3' });
    const a = boxAnmeldung(
      box({
        laufendeFenster: [
          fenster({ id: 'spaet', ende: '2026-10-07T15:00:00Z' }),
          fenster({ id: 'frueh', technikerId: 't2', technikerName: 'Kim (Tablet)', ende: '2026-10-07T13:00:00Z' }),
          fenster({ id: 'morgen', zustand: 'geplant', beginn: '2026-10-08T08:00:00Z' }),
        ],
      }),
      [techMitSsh(), kim],
      uebersicht(),
      JETZT,
    );
    // Die Befehle hängen nur an der Box: einmal, nicht je Fenster.
    expect(a?.befehle.ssh).toBe('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2');
    expect(a?.befehle.webApp).toContain('-L 8484:127.0.0.1:8484');
    // Nur die offenen Fenster, das zuerst endende zuerst.
    // Ohne Meldung des Tunnel-Dienstes: der Schlüssel am Zugang ist bekannt, alles andere nicht.
    expect(a?.fenster.map((f) => [f.fensterId, f.schluessel, f.fall, f.ton])).toEqual([
      ['frueh', 'fehlt', 'kein_schluessel', 'warn'],
      ['spaet', 'vorhanden', 'unbekannt', 'off'],
    ]);
    expect(a?.fenster[0].satz).toBe(
      '„Kim (Tablet)“: nur Netzweg. Der Zugang hat keinen SSH-Schlüssel; anmelden kann sich nur, wessen Schlüssel schon auf der Box liegt.',
    );
    // Das Portal verspricht die Anmeldung nicht: die Box muss den Schlüssel erst haben.
    expect(a?.fenster[1].fingerabdruck).toBe(FINGERABDRUCK);
    expect(a?.fenster[1].satz).toBe(
      `„Max (Laptop)“: Anmeldung mit dem SSH-Schlüssel ${FINGERABDRUCK}, sobald die Box ihn abgeholt hat oder wenn er schon auf ihr liegt. Ob die Box verbunden ist und ihn abgeholt hat, ist nicht bekannt: Der Tunnel-Dienst hat dem Portal noch nie seinen Zustand gemeldet.`,
    );
  });

  it('unbekannt ist nicht „fehlt": ohne den Zugang in der Liste behauptet die Zeile nichts', () => {
    const a = boxAnmeldung(box({ laufendeFenster: [fenster()] }), []);
    expect(a?.fenster[0].schluessel).toBe('unbekannt');
    expect(a?.fenster[0].ton).toBe('off');
    expect(a?.fenster[0].satz).toMatch(/nicht bekannt/);
    expect(a?.fenster[0].satz).not.toMatch(/nur Netzweg/);
  });

  it('ohne offenes Fenster gibt es nichts anzumelden', () => {
    expect(boxAnmeldung(box(), [techMitSsh()])).toBeNull();
    for (const zustand of ['geplant', 'geschlossen', 'abgesagt', 'abgelaufen'] as const) {
      expect(boxAnmeldung(box({ laufendeFenster: [fenster({ zustand })] }), [techMitSsh()])).toBeNull();
    }
  });

  it('sagt beim Öffnen klar, dass ein Fenster ohne SSH-Schlüssel nur den Netzweg öffnet', () => {
    expect(nurNetzwegSatz('Max (Laptop)')).toBe(
      'Dieses Fenster öffnet nur den Netzweg. Der Zugang „Max (Laptop)“ hat keinen SSH-Schlüssel; an der Box anmelden kann sich damit nur, wessen Schlüssel dort schon liegt.',
    );
    // Die Auswahl nennt es schon vor dem Wählen.
    const optionen = technikerOptionen([techMitSsh(), tech({ id: 't2', name: 'Tablet', adresse: '10.10.32.3' })], box(), JETZT);
    expect(optionen.map((o) => o.sub)).toEqual(['10.10.32.2 · mit SSH-Schlüssel', '10.10.32.3 · ohne SSH-Schlüssel']);
  });

  it('der Satz zum Stand verspricht nicht, dass jede Box den Schlüssel holt', () => {
    // Stimmt, sobald eine Box das neue Skript hat ...
    expect(SSH_STAND_SATZ).toMatch(/Im offenen Fenster holt eine Box ihn dort ab und behält ihn nur bis zum Ende des Fensters/);
    // ... und behauptet es weder für alle Boxen noch für den Wartungsserver.
    expect(SSH_STAND_SATZ).toMatch(/Das tun nur Boxen, deren Wartungstunnel mit dem aktuellen Skript \(service-tunnel\.sh\) eingerichtet ist/);
    expect(SSH_STAND_SATZ).toMatch(/nur, wenn die Schlüsselausgabe am Wartungsserver eingeschaltet ist/);
    expect(SSH_STAND_SATZ).toMatch(/An jeder anderen Box gelingt die Anmeldung nur mit einem Schlüssel, der schon auf der Box liegt/);
    // Ob eine bestimmte Box ihn abgeholt hat, sagt seit der Rückmeldung die Zeile ihres Fensters.
    expect(SSH_STAND_SATZ).toMatch(/Ob eine Box den Schlüssel abgeholt hat, steht an ihrem offenen Fenster, sobald der Tunnel-Dienst es meldet/);
    expect(SSH_STAND_SATZ).not.toMatch(/sieht das Portal nicht/);
    expect(SSH_STAND_SATZ).not.toMatch(/noch nicht/);
    expect(FENSTER_WIRKUNG_SATZ).toMatch(/sobald der Tunnel-Dienst es meldet/);
  });

  it('zeigt Fingerabdruck und Länge - oder nichts', () => {
    expect(sshText(techMitSsh())).toBe(`${FINGERABDRUCK} (RSA 3072)`);
    expect(sshText(tech())).toBeNull();
  });

  describe('Prüfung im Browser, dieselben Regeln wie die API', () => {
    const rsa2048 = rsa(2048);

    it('nimmt RSA ab 2048 Bit, mit Kommentar und Leerraum', () => {
      expect(sshSchluesselPruefen(rsa2048)).toEqual({ ok: true, bits: 2048 });
      expect(sshSchluesselPruefen(`  ${rsa2048}   max@laptop\n`)).toEqual({ ok: true, bits: 2048 });
      expect(sshSchluesselPruefen(rsa2048.replace(' ', '\t'))).toEqual({ ok: true, bits: 2048 });
      expect(sshSchluesselPruefen(rsa(3072))).toEqual({ ok: true, bits: 3072 });
      expect(sshSchluesselPruefen(rsaAus(E, ungerade(4096)))).toEqual({ ok: true, bits: 4096 });
    });

    it('lehnt Ed25519 und andere Typen mit dem passenden Befehl ab', () => {
      for (const [eingabe, name] of [
        [`${ed25519()} max@laptop`, 'Ed25519'],
        ['ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= x', 'ECDSA'],
        ['sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t x', 'FIDO'],
        ['ssh-dss AAAAB3NzaC1kc3M= x', 'DSA'],
      ]) {
        const p = sshSchluesselPruefen(eingabe);
        expect(p.ok).toBe(false);
        if (p.ok) continue;
        expect(p.fehler).toContain(name);
        expect(p.fehler).toContain('nur RSA');
        expect(p.fehler).toContain('ssh-keygen -t rsa -b 3072');
      }
    });

    it('lehnt zu kurze und zu lange Schlüssel mit ihrer Länge ab', () => {
      const fehler = (eingabe: string) => {
        const p = sshSchluesselPruefen(eingabe);
        return p.ok ? '' : p.fehler;
      };
      expect(fehler(rsa(1024))).toMatch(/nur 1024 Bit, verlangt sind mindestens 2048.*ssh-keygen -t rsa -b 3072/);
      expect(fehler(rsaAus(E, ungerade(2047)))).toMatch(/nur 2047 Bit/);
      expect(fehler(rsaAus(E, ungerade(4097)))).toMatch(/4097 Bit, die Boxen sind nur bis 4096 Bit geprüft/);
    });

    it('lehnt Müll, Mehrzeiliges und Optionen ab', () => {
      const base64 = rsa2048.split(' ')[1];
      const fehler = (eingabe: string) => {
        const p = sshSchluesselPruefen(eingabe);
        return p.ok ? '' : p.fehler;
      };
      expect(fehler('')).toBe('Der SSH-Schlüssel fehlt.');
      expect(fehler('   ')).toBe('Der SSH-Schlüssel fehlt.');
      for (const muell of ['hallo welt', base64, 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', `SSH-RSA ${base64}`]) {
        expect(fehler(muell)).toMatch(/kein öffentlicher SSH-Schlüssel/);
      }
      for (const kaputt of [
        'ssh-rsa',
        'ssh-rsa !!!',
        'ssh-rsa AAAA',
        `ssh-rsa ${base64.slice(0, -40)}`,
        `ssh-rsa ${ed25519().split(' ')[1]}`,
        sshZeile('ssh-rsa', Buffer.from('ssh-rsa'), E),
        sshZeile('ssh-rsa', Buffer.from('ssh-rsa'), E, zahl(ungerade(2048)), Buffer.from([1])),
        sshZeile('ssh-rsa', Buffer.from('ssh-rsa'), E, ungerade(2048)), // oberstes Bit gesetzt: negativ
      ]) {
        expect(fehler(kaputt)).toMatch(/beschädigt oder unvollständig/);
      }
      for (const mehr of [`${rsa2048}\n${rsa2048}`, `${rsa2048.slice(0, 80)}\n${rsa2048.slice(80)}`, `${rsa2048}\r\nmax`]) {
        expect(fehler(mehr)).toMatch(/genau eine Zeile/);
      }
      for (const davor of ['command="/bin/sh"', 'restrict', 'from="10.10.32.2"']) {
        expect(fehler(`${davor} ${rsa2048}`)).toMatch(/keine Optionen/);
      }
      expect(fehler('x'.repeat(2001))).toMatch(/zu lang/);
    });

    it('erkennt einen privaten Schlüssel, bevor er den Browser verlässt, und wiederholt keine Eingabe', () => {
      const geheim = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn';
      const p = sshSchluesselPruefen(`-----BEGIN OPENSSH PRIVATE KEY-----\n${geheim}\n-----END OPENSSH PRIVATE KEY-----`);
      expect(p.ok).toBe(false);
      if (p.ok) return;
      expect(p.fehler).toMatch(/privater Schlüssel/);
      expect(p.fehler).toMatch(/\.pub/);
      expect(p.fehler).not.toContain(geheim);
      const kurz = rsa(1024);
      const q = sshSchluesselPruefen(kurz);
      expect(q.ok ? '' : q.fehler).not.toContain(kurz.split(' ')[1].slice(0, 24));
    });
  });

  it('das Protokoll nennt Fingerabdrücke, nie den Schlüssel', () => {
    expect(aktionLabel('techniker_ssh_schluessel_gesetzt')).toBe('SSH-Schlüssel gesetzt');
    expect(aktionLabel('techniker_ssh_schluessel_entfernt')).toBe('SSH-Schlüssel entfernt');
    const base = { id: 'p', zeit: JETZT.toISOString(), akteur: 'admin', edgeRef: null, technikerId: 't1', technikerName: 'Max', fensterId: null };
    expect(
      protokollDetail(
        { ...base, aktion: 'techniker_ssh_schluessel_gesetzt', details: { name: 'Max', fingerabdruck: 'SHA256:neu', bits: '3072' } },
        JETZT,
      ),
    ).toBe('SHA256:neu · RSA 3072');
    expect(
      protokollDetail(
        {
          ...base,
          aktion: 'techniker_ssh_schluessel_gesetzt',
          details: { name: 'Max', fingerabdruck: 'SHA256:neu', bits: '4096', vorher: 'SHA256:alt' },
        },
        JETZT,
      ),
    ).toBe('SHA256:neu · RSA 4096 · ersetzt SHA256:alt');
    expect(
      protokollDetail(
        { ...base, aktion: 'techniker_ssh_schluessel_entfernt', details: { name: 'Max', fingerabdruck: 'SHA256:alt' } },
        JETZT,
      ),
    ).toBe('SHA256:alt · der Zugang öffnet nur noch den Netzweg');
    expect(
      protokollDetail(
        {
          ...base,
          aktion: 'techniker_angelegt',
          details: { name: 'Max', adresse: '10.10.32.2', publicKey: 'FY4LLXFa…BI8/Y=', sshFingerabdruck: 'SHA256:neu' },
        },
        JETZT,
      ),
    ).toBe('10.10.32.2 · FY4LLXFa…BI8/Y= · SSH SHA256:neu');
    expect(
      protokollDetail(
        { ...base, aktion: 'techniker_angelegt', details: { name: 'Max', adresse: '10.10.32.2', publicKey: 'FY4LLXFa…BI8/Y=' } },
        JETZT,
      ),
    ).toBe('10.10.32.2 · FY4LLXFa…BI8/Y=');
  });
});
