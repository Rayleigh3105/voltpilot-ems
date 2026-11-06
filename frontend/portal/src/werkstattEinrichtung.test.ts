import { describe, expect, it } from 'vitest';
import type { FernwartungBox } from './adminFernwartung';
import type { WerkstattAbnahme, WerkstattBox } from './werkstatt';
import { bindung, einrichtung, freigabeDerBox, fruehereAbnahmen, gehaeuseStand } from './werkstattEinrichtung';
import type { WerkstattFreigabe } from './werkstattBank';

describe('gehaeuseStand (vp-mango-3mf-pro-box)', () => {
  it('ohne Register-Eintrag: wartet (nie erfunden)', () => {
    expect(gehaeuseStand(null)).toEqual({ art: 'wartet' });
  });

  it('ohne Abnahme und ohne Datei: wartet auf den Werkstatt-Lauf', () => {
    expect(gehaeuseStand(box({ abnahmen: [] }))).toEqual({ art: 'wartet' });
  });

  it('mit Abnahme, aber ohne Datei im Portal: die alte interne Ablage', () => {
    expect(gehaeuseStand(box({ abnahmen: [abnahme()] }))).toEqual({ art: 'alt' });
  });

  it('mit Datei: bereit zum Download, mit ihren Feldern - unabhängig von der Abnahme', () => {
    const datei = { name: 'gehaeuse-edge-x.3mf', sha256: '0'.repeat(64), bytes: 4_700_000, hochgeladenAm: '2026-11-05T08:00:00Z' };
    expect(gehaeuseStand(box({ gehaeuse: datei }))).toEqual({ art: 'bereit', ...datei });
  });
});

function abnahme(over: Partial<WerkstattAbnahme> = {}): WerkstattAbnahme {
  return {
    id: 'a1', edgeRef: 'edge-x', hostSchluessel: 'SHA256:h', fassung: 'edge-light-2026.11.1', tunnelAdresse: '10.10.16.5', lanNetz: '10.213.0.1/24',
    pruefungen: [], probe: {} as WerkstattAbnahme['probe'], notiz: null, erfasstAm: '2026-11-02T10:42:00Z', erfasstVon: 'dienst', ...over,
  };
}

function box(over: Partial<WerkstattBox> = {}): WerkstattBox {
  return {
    id: 'b', edgeRef: 'edge-x', boxArt: 'edge-light', lanNetz: null, schritte: {}, notiz: null, angelegtAm: '2026-11-02T09:00:00Z',
    angelegtVon: 'Dienst', geaendertAm: '2026-11-02T09:00:00Z', abnahmen: [], ...over,
  };
}

const freigabe = { id: 'f1', kennung: 'F-1', openwrt: { fassung: '25.12.5' } } as WerkstattFreigabe;

describe('einrichtung', () => {
  const wert = (z: ReturnType<typeof einrichtung>, id: string) => z.find((x) => x.id === id)?.wert;

  it('nimmt Fassung, Tunnel und Host aus der neuesten Abnahme, das LAN-Netz aus ihr vor dem Register', () => {
    const z = einrichtung(box({ lanNetz: '10.1.0.1/24', abnahmen: [abnahme({ lanNetz: '10.213.0.1/24' })] }), freigabe);
    expect(wert(z, 'edge-light')).toBe('edge-light-2026.11.1');
    expect(wert(z, 'lan')).toBe('10.213.0.1/24');
    expect(wert(z, 'tunnel')).toBe('10.10.16.5');
    expect(wert(z, 'openwrt')).toBe('25.12.5');
  });

  it('ohne Abnahme und Freigabe bleibt unbekannt null (nie 0 oder erfunden); das LAN-Netz kommt dann aus dem Register', () => {
    const z = einrichtung(box({ lanNetz: '10.1.0.1/24' }), null);
    expect(wert(z, 'edge-light')).toBeNull();
    expect(wert(z, 'host')).toBeNull();
    expect(wert(z, 'openwrt')).toBeNull();
    expect(wert(z, 'lan')).toBe('10.1.0.1/24');
  });

  it('benennt die Hardware je Box-Art', () => {
    expect(wert(einrichtung(box(), null), 'hardware')).toContain('GL-MT300N-V2');
    expect(wert(einrichtung(box({ boxArt: 'edge-app' }), null), 'hardware')).toContain('Docker');
  });
});

describe('freigabeDerBox', () => {
  const f2 = { id: 'f2', kennung: 'F-2', openwrt: { fassung: '25.12.6' } } as WerkstattFreigabe;
  it('die Freigabe der Abnahme geht dem Lauf vor; sonst der Lauf; sonst nichts', () => {
    expect(freigabeDerBox(abnahme({ freigabeId: 'f1' }), 'F-2', [freigabe, f2])).toBe(freigabe);
    expect(freigabeDerBox(abnahme({ freigabeId: 'weg' }), 'F-2', [freigabe, f2])).toBe(f2);
    expect(freigabeDerBox(null, undefined, [freigabe, f2])).toBeNull();
  });
});

describe('bindung', () => {
  it('ohne Tunnel-Schlüssel sagen beide Zeilen das ehrlich', () => {
    expect(bindung(null).map((z) => z.wert)).toEqual(['nicht hinterlegt', 'noch nicht gekoppelt']);
  });
  it('mit Schlüssel: Kurzform, Zugang und Ort ehrlich („noch nicht gekoppelt“)', () => {
    const fw = { publicKeyKurz: 'Ab…=', status: 'gesperrt', siteName: null, tenantName: null } as FernwartungBox;
    expect(bindung(fw).map((z) => z.wert)).toEqual(['Ab…=', 'gesperrt', 'noch nicht gekoppelt']);
  });
});

describe('fruehereAbnahmen', () => {
  it('lässt die neueste weg', () => {
    expect(fruehereAbnahmen(box({ abnahmen: [abnahme({ id: 'neu' }), abnahme({ id: 'alt' })] })).map((a) => a.id)).toEqual(['alt']);
  });
});
