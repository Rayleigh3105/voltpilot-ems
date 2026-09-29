import { describe, expect, it } from 'vitest';
import { erzeugungListe, kuerzen, ohneAufteilung, verbrauchListe, type ListenZeile } from './flussListen';
import type { VerbrauchKomposition } from './verbrauchKomposition';

const txt = (x: string) => x.replace(/[  ]/g, ' ');
const teil = (key: string, label: string, kw: number | null, aktiv = true) =>
  ({ key, label, kw, word: kw == null ? 'ohne Leistungsmessung' : 'läuft', note: null, health: 'ok', aktiv, todayKwh: null, href: null, entityId: key, title: null });
function komp(hausKw: number | null, n: number): VerbrauchKomposition {
  return {
    hausKw,
    gruppen: [{ id: 'sonstiges', label: 'Sonstiges', kw: null, headline: '', collapsed: false, collapsedText: null,
      teile: Array.from({ length: n }, (_, i) => teil(`e:${i}`, `Gerät ${i}`, n - i)) }],
    rest: { kw: 0.4, note: null, konflikt: false, todayKwh: null },
    verbraucherCount: n, subLine: null, ladenKw: null, ladepunktCount: 0, asOf: null,
  } as unknown as VerbrauchKomposition;
}

describe('Verbrauch im Detail', () => {
  it('die größten zuerst, am Telefon höchstens vier Zeilen, sonst drei und „n weitere“', () => {
    const l = verbrauchListe(komp(60, 9), { heute: false, max: 4 })!;
    expect(l.zeilen.map((z) => z.name)).toEqual(['Gerät 0', 'Gerät 1', 'Gerät 2', '7 weitere Verbraucher']);
    expect(l.gesamt).toBe(10);
  });

  it('der Rest steht als „berechnet“, nie als Gerät', () => {
    const l = verbrauchListe(komp(5, 1), { heute: false, max: 6 })!;
    const rest = l.zeilen.find((z) => z.key === 'rest')!;
    expect(rest.sub).toBe('berechnet');
    expect(rest.art).toBe('rest');
  });

  it('ohne Haus-Mitglied trägt die Summe den Verbrauch des Flusses, nie „—“ neben einer Zahl', () => {
    const l = verbrauchListe(komp(null, 1), { heute: false, max: 6, hausKw: 4 })!;
    expect(txt(l.summe)).toBe('4,0 kW');
  });

  it('ohne Messwert steht das Wort, nie eine 0', () => {
    const k = komp(3, 0);
    (k.gruppen[0].teile as unknown[]).push(teil('e:x', 'Wärmepumpe', null));
    const z = verbrauchListe(k, { heute: false, max: 6 })!.zeilen.find((r) => r.key === 'e:x')!;
    expect(z.wert).toBe('—');
    expect(z.sub).toBe('ohne Leistungsmessung');
  });
});

describe('Erzeugung im Detail', () => {
  it('erst ab zwei Flächen; gemessene Null neben Erzeugern heißt „liefert gerade keine Erzeugung“', () => {
    const part = (key: string, kw: number) => ({ key, label: key, kw, health: 'ok', note: null, title: key, entityId: key, deviceId: null, alias: null });
    expect(erzeugungListe({ totalKw: 3, parts: [part('a', 3)], unmeasured: [], deviceCount: 1, origin: 'entity', asOf: null } as never, { max: 4 })).toBeNull();
    const l = erzeugungListe({ totalKw: 3, parts: [part('a', 3), part('b', 0)], unmeasured: [], deviceCount: 2, origin: 'entity', asOf: null } as never, { max: 4 })!;
    expect(l.zeilen[1].sub).toBe('liefert gerade keine Erzeugung');
  });
});

describe('Kürzen und Plan', () => {
  it('„n weitere“ summiert nur Gemessenes', () => {
    const z = (k: string, zahl: number | null): ListenZeile => ({ key: k, name: k, sub: null, wert: '', zahl, anteil: null, art: 'normal', icon: 'plug', title: null });
    const out = kuerzen([z('a', 3), z('b', 2), z('c', null), z('d', 1)], 3, 'Verbraucher', false);
    expect(out[2].name).toBe('2 weitere Verbraucher');
    expect(txt(out[2].wert)).toBe('1,0 kW');
  });

  it('für den Plan gibt es keine Aufteilung je Gerät', () => {
    const l = ohneAufteilung('Verbrauch im Detail', '2,0 kW', true);
    expect(l.zeilen[0].name).toBe('Verbrauchsprognose');
    expect(l.zeilen[0].sub).toBe('ohne Aufteilung je Gerät');
  });
});

import { rollenListe } from './flussListen';

describe('Rollen-Aufschlüsselung im Blatt (dieselbe Listenform)', () => {
  const wert = (over: Record<string, unknown> = {}) => ({
    role: 'pv',
    wert: 7.5,
    einheit: 'kW',
    stand: '2026-09-16T10:15:00+02:00',
    zuordnung_vorhanden: true,
    unvollstaendig: true,
    geraete: [
      { entity_id: 'a', name: 'WR Dach', art: 'gerät', wert: 5, liefernd: true, grund: null },
      { entity_id: 'b', name: 'WR Carport', art: 'gerät', wert: 2.5, liefernd: true, grund: null },
      { entity_id: 'c', name: 'WR Halle', art: 'gerät', wert: null, liefernd: false, grund: 'veraltet' },
    ],
    ...over,
  }) as never;

  it('größte zuerst, ein stummes Gerät ohne Zahl, die Summe vom Server', () => {
    const l = rollenListe(wert())!;
    expect(l.titel).toBe('Erzeugung im Detail');
    expect(l.zeilen.map((z) => z.name)).toEqual(['WR Dach', 'WR Carport', 'WR Halle']);
    expect(l.zeilen[2]).toMatchObject({ wert: '—', sub: 'liefert gerade nicht', zahl: null });
    expect(l.summe.replace(/ /g, ' ')).toBe('7,5 kW');
    expect(l.fuss).toContain('Stand 10:15 Uhr');
    expect(l.fuss).toContain('Summe aus 2 von 3 Geräten');
  });

  it('ohne Zuordnung keine Liste', () => {
    expect(rollenListe(wert({ zuordnung_vorhanden: false }))).toBeNull();
    expect(rollenListe(null)).toBeNull();
  });
});
