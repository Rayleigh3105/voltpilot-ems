import { describe, expect, it } from 'vitest';
import type { FernwartungBox } from './adminFernwartung';
import type { WerkstattAbnahme, WerkstattBox } from './werkstatt';
import { bindung, einrichtung, fernlaufEinrichtungZeile, freigabeDerBox, fruehereAbnahmen, gehaeuseStand } from './werkstattEinrichtung';
import type { WerkstattFreigabe } from './werkstattBank';
import type { Fernlauf } from './werkstattFernlauf';

describe('gehaeuseStand (vp-mango-3mf-pro-box)', () => {
  it('ohne Register-Eintrag: wartet (nie erfunden)', () => {
    expect(gehaeuseStand(null)).toEqual({ art: 'wartet' });
  });

  it('ohne Abnahme und ohne Datei: wartet auf den Werkstatt-Lauf', () => {
    expect(gehaeuseStand(box({ abnahmen: [] }))).toEqual({ art: 'wartet' });
  });

  it('mit Abnahme, aber ohne Datei im Portal und ohne Auftrag in der Ansicht: baut (der Dienst reiht sie im Takt selbst ein)', () => {
    expect(gehaeuseStand(box({ abnahmen: [abnahme()] }))).toEqual({ art: 'baut', seit: null });
  });

  it('mit einem offenen Auftrag der Ansicht (wartet/baut): baut, mit seinem Bestelldatum', () => {
    const auftrag = { referenz: 'edge-x', zustand: 'baut' as const, bestellt: '2026-11-09T09:00:00Z' };
    expect(gehaeuseStand(box({ abnahmen: [abnahme()] }), [auftrag])).toEqual({ art: 'baut', seit: auftrag.bestellt });
  });

  it('mit einem Auftrag im Zustand fehler: fehler mit seinem Grund, kein endloser Nachbau', () => {
    const auftrag = { referenz: 'edge-x', zustand: 'fehler' as const, grund: 'Ruhezone 2,1 Module', bestellt: '2026-11-09T09:00:00Z' };
    expect(gehaeuseStand(box({ abnahmen: [abnahme()] }), [auftrag])).toEqual({ art: 'fehler', grund: 'Ruhezone 2,1 Module' });
  });

  it('ein Auftrag einer anderen Referenz betrifft diese Box nicht', () => {
    const auftrag = { referenz: 'edge-y', zustand: 'fehler' as const, bestellt: '2026-11-09T09:00:00Z' };
    expect(gehaeuseStand(box({ abnahmen: [abnahme()] }), [auftrag])).toEqual({ art: 'baut', seit: null });
  });

  it('mit Datei: bereit zum Download, mit ihren Feldern - unabhängig von der Abnahme und einem Auftrag', () => {
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

const freigabe = {
  id: 'f1', kennung: 'F-1', quelle: 'regel', edgeReleaseSeq: 214, erteiltVon: 'Regel: neueste Fassung',
  openwrt: { fassung: '25.12.5', sha256: '056235c21f55288544ca459bc0a61023d084ce788ca5508d49c235dc66a7686c' },
  edgeLight: { fassung: 'edge-light-2026.11.1', programmSha256: '1a2b3c4d'.repeat(8), skripteSha256: '5e6f7a8b'.repeat(8) },
} as WerkstattFreigabe;

describe('einrichtung', () => {
  const wert = (z: ReturnType<typeof einrichtung>, id: string) => z.find((x) => x.id === id)?.wert;

  it('nimmt Fassung, Tunnel und Host aus der neuesten Abnahme, das LAN-Netz aus ihr vor dem Register', () => {
    const z = einrichtung(box({ lanNetz: '10.1.0.1/24', abnahmen: [abnahme({ lanNetz: '10.213.0.1/24' })] }), freigabe);
    expect(wert(z, 'edge-light')).toBe('edge-light-2026.11.1');
    expect(wert(z, 'lan')).toBe('10.213.0.1/24');
    expect(wert(z, 'tunnel')).toBe('10.10.16.5');
    expect(wert(z, 'openwrt')).toBe('25.12.5');
    // Der Beleg: mit welchen Prüfsummen und unter welcher Freigabe (Regel mit Release, oder von Hand mit Namen).
    expect(wert(z, 'pruefsummen')).toBe('Programm 1a2b3c4d1a2b… · Skripte 5e6f7a8b5e6f… · OpenWrt 056235c21f55…');
    expect(wert(z, 'freigabe')).toBe('F-1 · Regel, Release 214');
    expect(wert(einrichtung(box({}), { ...freigabe, quelle: 'formular', erteiltVon: 'Alex' }), 'freigabe')).toBe('F-1 · von Hand (Alex)');
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

describe('fernlaufEinrichtungZeile (Fernlauf S3, §4.6: „Nach der Werkstatt")', () => {
  const lauf: Fernlauf = {
    id: 'f1', art: 'aufspielen', zustand: 'fertig', fassungVorher: 'edge-light-2026.11.5',
    fassungZiel: 'edge-light-2026.11.15', akteurName: 'Moritz', erteiltAm: '2026-11-18T16:00:00Z',
    begonnenAm: '2026-11-18T16:00:30Z', schritt: 'fenster_zu', schrittSeit: '2026-11-18T16:05:00Z',
    schritte: [], fensterEnde: '2026-11-18T16:30:00Z',
    ergebnis: {
      ergebnis: 'fertig', grund: null, schritt: 'fenster_zu', fassungNachher: 'edge-light-2026.11.15',
      belege: {}, quelle: 'dienst', erfasstAm: '2026-11-18T16:09:00Z',
    },
  };
  const jetzt = new Date('2026-11-19T08:00:00Z');

  it('ohne Fernlauf keine Zeile', () => {
    expect(fernlaufEinrichtungZeile(null, jetzt)).toBeNull();
  });

  it('nennt Fassung, Zustand und Akteur wie die Karte „Durch den Tunnel aufspielen" der Akte', () => {
    expect(fernlaufEinrichtungZeile(lauf, jetzt)).toEqual({
      id: 'fernlauf', titel: 'Nach der Werkstatt',
      wert: 'Über den Tunnel auf 2026.11.15 · fertig · Moritz · 18.11., 17:09',
    });
  });

  it('einrichtung() reiht sie zwischen der aufgespielten Fassung und „Beim ersten Verbinden" ein', () => {
    const z = einrichtung(box(), null, null, lauf, jetzt);
    expect(z.find((x) => x.id === 'fernlauf')?.wert).toContain('fertig');
    expect(z.map((x) => x.id)).toContain('fernlauf');
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
