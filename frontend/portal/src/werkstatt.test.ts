import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FernwartungFenster, FernwartungServer } from './adminFernwartung';
import { qrCode } from './qrCode';
import {
  abnahmeSperre,
  beschriftung,
  erzeugePasswort,
  fortschritt,
  hostSchluesselAus,
  lanBefehl,
  lanNetzForm,
  PASSWORT_ZEICHEN,
  probeFenster,
  PRUEFUNGEN,
  SCHRITT_IDS,
  schritte,
  tunnelBefehl,
  VERSAND_SATZ,
} from './werkstatt';

const server: FernwartungServer = {
  endpunkt: 'wartung.example.test',
  port: 51820,
  publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true,
  boxNetz: '10.10.16.0/20',
  technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1',
  technikerServerAdresse: '10.10.32.1',
};

function fenster(over: Partial<FernwartungFenster> = {}): FernwartungFenster {
  return {
    id: 'f1',
    edgeRef: 'edge-wrk7abg',
    technikerId: 't1',
    technikerName: 'Alex (Laptop)',
    grund: 'Werkstatt-Probe',
    beginn: '2026-10-26T10:00:00Z',
    ende: '2026-10-26T10:15:00Z',
    wirksamesEnde: '2026-10-26T10:08:00Z',
    zustand: 'geschlossen',
    geoeffnetAm: '2026-10-26T10:00:00Z',
    geoeffnetVon: 'admin',
    geschlossenAm: '2026-10-26T10:08:00Z',
    geschlossenVon: 'admin',
    ...over,
  };
}

describe('Prüfungen der Werkstatt-Regel', () => {
  it('sind dieselben wie im Vektor, den auch die API liest', () => {
    const v = JSON.parse(
      readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-pruefungen.json'), 'utf8'),
    ) as { pruefungen: { id: string; text: string }[] };
    expect(PRUEFUNGEN.map((p) => p.id)).toEqual(v.pruefungen.map((p) => p.id));
    expect(PRUEFUNGEN.map((p) => p.text)).toEqual(v.pruefungen.map((p) => p.text));
  });
});

describe('Root-Passwort (Entscheid 3a)', () => {
  it('hat 20 Zeichen ohne verwechselbare in fünf Gruppen', () => {
    let n = 0;
    const pw = erzeugePasswort((k) => Uint8Array.from({ length: k }, () => (n++ * 37) % 224));
    expect(pw).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){4}$/);
    expect(pw.replace(/-/g, '')).toHaveLength(20);
    for (const z of pw.replace(/-/g, '')) expect(PASSWORT_ZEICHEN).toContain(z);
    expect(PASSWORT_ZEICHEN).not.toMatch(/[0O1lI]/);
  });

  it('verwirft Bytes über dem größten Vielfachen der Zeichenzahl', () => {
    // 224 = 4 × 56: Ein Byte ab 224 käme sonst als eines der ersten 32 Zeichen doppelt so oft vor.
    let runde = 0;
    const pw = erzeugePasswort((k) => {
      runde++;
      return Uint8Array.from({ length: k }, (_, i) => (runde === 1 ? 224 + (i % 32) : i));
    });
    expect(runde).toBeGreaterThan(1);
    expect(pw.slice(0, 4)).toBe(PASSWORT_ZEICHEN.slice(0, 4));
  });

  it('ergibt mit echtem Zufall jedes Mal ein anderes', () => {
    const zufall = (k: number) => crypto.getRandomValues(new Uint8Array(k));
    expect(erzeugePasswort(zufall)).not.toBe(erzeugePasswort(zufall));
  });
});

describe('LAN-Netz (Entscheid 6a)', () => {
  it('nimmt Adresse mit Präfix und baut den Befehl', () => {
    expect(lanNetzForm(' 10.213.0.1/24 ')).toEqual({ adresse: '10.213.0.1', praefix: 24 });
    expect(lanNetzForm('10.213.0.1')).toBeNull();
    expect(lanNetzForm('10.213.0.300/24')).toBeNull();
    expect(lanNetzForm('10.213.0.1/8')).toBeNull();
    expect(lanBefehl('10.213.0.1/24')).toBe(
      `ssh mango "uci -q delete network.lan.ipaddr; uci -q delete network.lan.netmask; uci add_list network.lan.ipaddr='10.213.0.1/24'; uci commit network && reboot"`,
    );
    expect(lanBefehl('kaputt')).toBeNull();
  });
});

describe('Schritte', () => {
  it('sind dreizehn, durchnummeriert, und ohne Tunnel fehlen die Befehle, die eine Adresse brauchen', () => {
    const s = schritte({ ref: null, tunnelAdresse: null, server: null, lanNetz: null });
    expect(s.map((x) => x.nummer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(SCHRITT_IDS).toEqual(s.map((x) => x.id));
    for (const id of ['tunnel', 'probe', 'host', 'fenster_zu', 'lan', 'neustart'] as const) {
      const x = s.find((y) => y.id === id)!;
      expect(x.befehle, id).toEqual([]);
      expect(x.fehlt, id).toBeTruthy();
    }
    expect(s.find((x) => x.id === 'passwort')!.werkzeug).toBe('passwort');
  });

  it('setzen Adresse, Server und LAN-Netz in die Befehle ein', () => {
    const s = schritte({ ref: 'edge-wrk7abg', tunnelAdresse: '10.10.16.7', server, lanNetz: '10.213.0.1/24' });
    const tunnel = s.find((x) => x.id === 'tunnel')!;
    expect(tunnel.befehle).toEqual([
      `VP_SERVICE_ENDPOINT=wartung.example.test VP_SERVICE_PUBKEY='${server.publicKey}' VP_SERVICE_NET=10.10.32.0/24 edge-light/openwrt/service-tunnel.sh mango 10.10.16.7 51820`,
    ]);
    expect(s.find((x) => x.id === 'probe')!.befehle[0]).toBe(
      'ssh -i ~/.ssh/id_rsa_voltpilot -o IdentitiesOnly=yes -p 2222 root@10.10.16.7',
    );
    expect(s.find((x) => x.id === 'host')!.befehle[0]).toContain('ssh-keyscan -t rsa -p 2222 10.10.16.7');
    expect(s.find((x) => x.id === 'neustart')!.befehle).toContain('edge-light/openwrt/service-tunnel.sh root@10.213.0.1 status');
    expect(s.find((x) => x.id === 'neustart')!.sehen).toContain('edge-wrk7abg');
    expect(s.every((x) => x.fehlt == null)).toBe(true);
  });

  it('hat ohne Server-Schlüssel keine Befehlszeile für den Tunnel und sagt warum', () => {
    expect(tunnelBefehl('10.10.16.7', { ...server, publicKey: null })).toBeNull();
    const t = schritte({ ref: 'edge-wrk7abg', tunnelAdresse: '10.10.16.7', server: { ...server, publicKey: null }, lanNetz: null }).find(
      (x) => x.id === 'tunnel',
    )!;
    expect(t.befehle).toEqual([]);
    expect(t.fehlt).toContain('Server-Schlüssel');
  });

  it('zählen den Fortschritt nur über die Schritte des Ablaufs', () => {
    expect(fortschritt({ schritte: {} })).toEqual({ erledigt: 0, gesamt: 13 });
    expect(
      fortschritt({ schritte: { openwrt: { am: 'x', von: 'a' }, kabel: { am: 'x', von: 'a' }, fremd: { am: 'x', von: 'a' } } }),
    ).toEqual({ erledigt: 2, gesamt: 13 });
  });
});

describe('Werkstatt-Probe', () => {
  it('ist das jüngste nicht abgesagte Fenster dieser Box mit dem Grund der Probe', () => {
    const alt = fenster({ id: 'alt', beginn: '2026-10-26T09:00:00Z' });
    const neu = fenster({ id: 'neu', beginn: '2026-10-26T10:00:00Z', zustand: 'offen' });
    const abgesagt = fenster({ id: 'abgesagt', beginn: '2026-10-26T11:00:00Z', zustand: 'abgesagt' });
    const anderer = fenster({ id: 'anderer', beginn: '2026-10-26T12:00:00Z', grund: 'go-e prüfen' });
    const andereBox = fenster({ id: 'box2', beginn: '2026-10-26T13:00:00Z', edgeRef: 'edge-zay5sdd' });
    expect(probeFenster([alt, neu, abgesagt, anderer, andereBox], 'edge-wrk7abg')?.id).toBe('neu');
    expect(probeFenster([anderer], 'edge-wrk7abg')).toBeNull();
  });
});

describe('Abnahme', () => {
  const alle = new Set(PRUEFUNGEN.map((p) => p.id));
  const host = 'SHA256:' + 'Q'.repeat(42) + 'c';

  it('liest den Fingerabdruck auch aus der ganzen Zeile von ssh-keygen', () => {
    expect(hostSchluesselAus(host)).toBe(host);
    expect(hostSchluesselAus(`3072 ${host} [10.10.16.7]:2222 (RSA)`)).toBe(host);
    expect(hostSchluesselAus(`Fingerprint: ${host}`)).toBe(host);
    expect(hostSchluesselAus('SHA256:zukurz')).toBeNull();
    expect(hostSchluesselAus('MD5:aa:bb')).toBeNull();
  });

  it('nennt jeden Grund, der fehlt, und ist mit allem leer', () => {
    const box = { boxArt: 'edge-light' as const, lanNetz: null };
    const leer = abnahmeSperre(box, null, null, { hostSchluessel: '', fassung: '', pruefungen: new Set() });
    expect(leer).toHaveLength(6);
    expect(leer.join(' ')).toContain('Tunnel-Schlüssel');
    expect(leer.join(' ')).toContain('8 von 8');
    const offen = abnahmeSperre({ ...box, lanNetz: '10.213.0.1/24' }, '10.10.16.7', fenster({ zustand: 'offen' }), {
      hostSchluessel: host,
      fassung: 'edge-light-g9c3368e3a',
      pruefungen: alle,
    });
    expect(offen).toEqual(['Das Fenster der Probe ist noch offen: erst schließen und den Versuch wiederholen (Schritt 11).']);
    expect(
      abnahmeSperre({ ...box, lanNetz: '10.213.0.1/24' }, '10.10.16.7', fenster(), {
        hostSchluessel: host,
        fassung: 'edge-light-g9c3368e3a',
        pruefungen: alle,
      }),
    ).toEqual([]);
  });

  it('gibt es für die Docker-Box nicht', () => {
    expect(
      abnahmeSperre({ boxArt: 'edge-app', lanNetz: '10.213.0.1/24' }, '10.10.16.7', fenster(), {
        hostSchluessel: host,
        fassung: 'v1',
        pruefungen: alle,
      }),
    ).toEqual([expect.stringContaining('nur für das Edge Light')]);
  });
});

describe('Beschriftung und Versand', () => {
  it('druckt die Referenz groß und trägt den Direktlink', () => {
    expect(beschriftung('edge-wrk7abg')).toEqual({
      klartext: 'EDGE-WRK7ABG',
      link: 'https://portal.voltpilot.de/k/edge-wrk7abg',
    });
  });

  // Dasselbe liest das Gehäuse-Programm (edge-light/gehaeuse/glinet-gl-mt300n-v2, gehaeuse/kennung.py): Was auf
  // die Unterseite gedruckt wird, ist Modul für Modul, was diese Seite zeigt.
  const vektor = JSON.parse(
    readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-beschriftung.json'), 'utf8'),
  ) as {
    faelle: { referenz: string; klartext: string; link: string; fassung: number; korrektur: string; maske: number; module: string[] }[];
  };
  it.each(vektor.faelle.map((f) => [f.referenz, f] as const))(
    'trägt auf dem Gehäuse denselben Inhalt wie werkstatt-beschriftung.json: %s',
    (ref, f) => {
      const b = beschriftung(ref);
      expect(b).toEqual({ klartext: f.klartext, link: f.link });
      const q = qrCode(b.link);
      expect({ fassung: q.fassung, korrektur: q.korrektur, maske: q.maske }).toEqual({
        fassung: f.fassung,
        korrektur: f.korrektur,
        maske: f.maske,
      });
      expect(q.module.map((r) => r.map((m) => (m ? '1' : '0')).join(''))).toEqual(f.module);
    },
  );

  it('sagt am Ende, dass keine Box mit Stufe 1 an einen Kunden geht (Entscheid 5c)', () => {
    expect(VERSAND_SATZ).toMatch(/^Nicht versenden\./);
    expect(VERSAND_SATZ).toContain('Stufe 2');
  });
});
