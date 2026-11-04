import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FernwartungBox } from './adminFernwartung';
import type { WerkstattAbnahme, WerkstattBox } from './werkstatt';
import { bindung, einrichtung, freigabeDerBox, fruehereAbnahmen, GEHAEUSE_DATEIEN } from './werkstattEinrichtung';
import type { WerkstattFreigabe } from './werkstattBank';

const DRUCK = resolve(__dirname, '../../../edge-light/gehaeuse/glinet-gl-mt300n-v2/druck');

describe('Gehäuse-Druckdateien im Portal', () => {
  const summen = new Map(
    readFileSync(resolve(DRUCK, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((z) => z.split(/\s+/) as [string, string])
      .map(([sha, name]) => [name, sha]),
  );

  it.each(GEHAEUSE_DATEIEN.map((d) => [d.name]))('%s ist byte-gleich der eingecheckten Druckdatei des Gehäuses', (name) => {
    const kopie = readFileSync(resolve(__dirname, 'assets/gehaeuse', name));
    expect(createHash('sha256').update(kopie).digest('hex')).toBe(summen.get(name));
    expect(kopie.equals(readFileSync(resolve(DRUCK, name)))).toBe(true);
  });

  it('jede Datei ist ein ZIP-Archiv (3MF) und hat eine Adresse im Bündel', () => {
    for (const d of GEHAEUSE_DATEIEN) {
      expect(readFileSync(resolve(__dirname, 'assets/gehaeuse', d.name)).subarray(0, 2).toString('latin1')).toBe('PK');
      expect(d.url).toMatch(/\.3mf/);
    }
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
