import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  abrufLage,
  aktionLabel,
  boxBefehl,
  boxOrt,
  dauerOptionen,
  dauerText,
  fensterAnmeldung,
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

  it('ein offenes Fenster zeigt die Befehle und sagt, ob der Zugang einen SSH-Schlüssel trägt', () => {
    const mit = fensterAnmeldung(fenster(), '10.10.16.2', [techMitSsh()]);
    expect(mit?.schluessel).toBe('vorhanden');
    expect(mit?.fingerabdruck).toBe(FINGERABDRUCK);
    expect(mit?.ton).toBe('ok');
    expect(mit?.befehle.ssh).toContain('root@10.10.16.2');
    // Das Portal verspricht die Anmeldung nicht: die Box muss den Schlüssel erst haben.
    expect(mit?.satz).toContain(FINGERABDRUCK);
    expect(mit?.satz).toMatch(/sobald die Box ihn abgeholt hat oder wenn er schon auf ihr liegt/);

    const ohne = fensterAnmeldung(fenster(), '10.10.16.2', [tech()]);
    expect(ohne?.schluessel).toBe('fehlt');
    expect(ohne?.ton).toBe('warn');
    expect(ohne?.satz).toBe(
      'Nur Netzweg: „Max (Laptop)“ hat keinen SSH-Schlüssel. Anmelden kann sich nur, wessen Schlüssel schon auf der Box liegt.',
    );
    // Der Netzweg ist offen: die Befehle stehen trotzdem da.
    expect(ohne?.befehle.webApp).toContain('-L 8484:127.0.0.1:8484');
  });

  it('unbekannt ist nicht „fehlt": ohne den Zugang in der Liste behauptet die Zeile nichts', () => {
    const a = fensterAnmeldung(fenster(), '10.10.16.2', []);
    expect(a?.schluessel).toBe('unbekannt');
    expect(a?.ton).toBe('off');
    expect(a?.satz).toMatch(/nicht bekannt/);
    expect(a?.satz).not.toMatch(/Nur Netzweg/);
  });

  it('geplante und beendete Fenster haben nichts anzumelden', () => {
    for (const zustand of ['geplant', 'geschlossen', 'abgesagt', 'abgelaufen'] as const) {
      expect(fensterAnmeldung(fenster({ zustand }), '10.10.16.2', [techMitSsh()])).toBeNull();
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

  it('der Satz zum Stand verspricht nicht, dass eine Box den Schlüssel schon holt', () => {
    expect(SSH_STAND_SATZ).toMatch(/Abholen können ihn die Boxen noch nicht/);
    expect(SSH_STAND_SATZ).toMatch(/nur mit einem Schlüssel, der schon auf der Box liegt/);
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
