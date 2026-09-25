import { describe, expect, it } from 'vitest';
import type { EntityHistory } from './api';
import { NBSP } from './format';
import {
  heuteAblesung,
  heuteKanal,
  heuteRichtung,
  heuteView,
  heuteWert,
  type HeuteKanal,
} from './geraetHeute';
import type { PlantComponent } from './komponenten';

/**
 * Der Baustein „Heute" (E2 a): der Tagesverlauf der Hauptgröße aus dem
 * bestehenden `entities/{id}/history?range=day`. Geprüft werden die drei
 * Ehrlichkeitsregeln - keine erfundene Tagessumme, Lücken bleiben Lücken, die
 * Richtung ist ein Wort - und die Zeitachse an den WAHREN Stellen.
 */
const VIERTEL = 15 * 60_000;

/** Die lokale Mitternacht - die Tests laufen in jeder Zeitzone. */
const TAG = new Date(2026, 8, 10, 0, 0, 0).getTime();
const MORGEN = new Date(2026, 8, 11, 0, 0, 0).getTime();

function komp(over: Partial<PlantComponent>): PlantComponent {
  return {
    id: 'k', entityId: 'e', aspect: 'main', role: 'storage', channels: [], ...over,
  } as unknown as PlantComponent;
}

function verlauf(werte: Record<number, number | null>, channel = 'power_kw', over: Partial<EntityHistory> = {}): EntityHistory {
  return {
    range: 'day',
    from: new Date(TAG).toISOString(),
    to: new Date(MORGEN).toISOString(),
    bucketMinutes: 15,
    channels: {
      [channel]: Object.entries(werte).map(([i, v]) => ({
        start: new Date(TAG + Number(i) * VIERTEL).toISOString(),
        avg: v, min: v, max: v, last: v, n: 15,
      })),
    },
    ...over,
  };
}

const NETZ: HeuteKanal = { entityId: 'e', channel: 'power_kw', titel: 'Netz', einheit: 'kW', richtung: 'netz', farbe: 'grid' };
const LAST: HeuteKanal = { entityId: 'e', channel: 'power_kw', titel: 'Leistung', einheit: 'kW', richtung: null, farbe: 'load' };
const SOC: HeuteKanal = { entityId: 'e', channel: 'soc_pct', titel: 'Ladestand', einheit: '%', richtung: null, farbe: 'batt' };
const uhr = (i: number) => new Date(TAG + i * VIERTEL).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

describe('heuteKanal - nur ein Kanal, den die Komponente WIRKLICH führt', () => {
  it('nimmt am Speicher den Ladestand, sonst die Batterieleistung', () => {
    const mitSoc = [komp({ role: 'storage', channels: [{ raw: 'soc_pct' }, { raw: 'battery_power_kw' }] as never })];
    expect(heuteKanal({ gattung: 'wechselrichter-speicher', ioModul: false }, mitSoc)?.channel).toBe('soc_pct');
    const ohneSoc = [komp({ role: 'storage', channels: [{ raw: 'battery_power_kw' }] as never })];
    expect(heuteKanal({ gattung: 'wechselrichter-speicher', ioModul: false }, ohneSoc))
      .toMatchObject({ channel: 'battery_power_kw', richtung: 'batterie' });
  });

  it('nennt den Zähler nur am maßgeblichen Anschluss „Netz"', () => {
    const z = [komp({ role: 'grid', channels: [{ raw: 'power_kw' }] as never })];
    expect(heuteKanal({ gattung: 'zaehler', ioModul: false }, z, true)?.titel).toBe('Netz');
    expect(heuteKanal({ gattung: 'zaehler', ioModul: false }, z, false)?.titel).toBe('Leistung');
  });

  it('gibt einem I/O-Modul und einem Gerät ohne passenden Kanal keine Karte', () => {
    expect(heuteKanal({ gattung: 'geraet', ioModul: true }, [])).toBeNull();
    const ohne = [komp({ role: 'consumer', channels: [{ raw: 'relay_on' }] as never })];
    expect(heuteKanal({ gattung: 'verbraucher', ioModul: false }, ohne)).toBeNull();
  });
});

describe('heuteView - eine Säule je Viertelstunde, Lücken bleiben Lücken', () => {
  it('zeigt den GANZEN Tag und lässt die Zukunft leer - auch wenn ein Wert käme', () => {
    const now = TAG + 40 * VIERTEL + 60_000;
    const v = heuteView(verlauf({ 0: 1, 40: 2, 50: 9 }), NETZ, now);
    expect(v.punkte).toHaveLength(96);
    expect(v.punkte[40].value).toBe(2);
    // Ein Bucket nach „jetzt" kann nichts gemessen haben.
    expect(v.punkte[50].value).toBeNull();
    expect(v.jetztKey).toBe(v.punkte[40].key);
  });

  it('macht aus einer fehlenden Viertelstunde nie eine 0', () => {
    const v = heuteView(verlauf({ 0: 1, 2: 3 }), NETZ, MORGEN);
    expect(v.punkte[1].value).toBeNull();
  });

  it('streckt ein kürzeres Fenster nicht auf die volle Breite', () => {
    const halb = verlauf({ 0: 1 }, 'power_kw', { to: new Date(TAG + 48 * VIERTEL).toISOString() });
    expect(heuteView(halb, NETZ, TAG + 47 * VIERTEL).punkte).toHaveLength(96);
  });

  it('ist ohne einen einzigen Wert leer - und behauptet keinen Satz', () => {
    const v = heuteView(verlauf({ 3: null }), NETZ, MORGEN);
    expect(v.leer).toBe(true);
    expect(v.satz).toBeNull();
    expect(v.jetztKey).toBeNull();
  });
});

describe('der Satz - aus zwei belegten Extremen, nie eine Tagessumme', () => {
  it('nennt am Netz höchsten Bezug und höchste Einspeisung mit Uhrzeit', () => {
    const v = heuteView(verlauf({ 4: 2, 40: -4.7, 41: -1 }), NETZ, MORGEN);
    expect(v.satz).toBe(`Höchster Bezug 2,0${NBSP}kW um ${uhr(4)} · höchste Einspeisung 4,7${NBSP}kW um ${uhr(40)}.`);
    expect(v.satz).not.toMatch(/kWh/);
  });

  it('nennt am Ladestand die Spanne', () => {
    const v = heuteView(verlauf({ 0: 28, 48: 52 }, 'soc_pct'), SOC, MORGEN);
    expect(v.satz).toBe(`Zwischen 28${NBSP}% (${uhr(0)}) und 52${NBSP}% (${uhr(48)}).`);
  });

  it('nennt an einer Reihe ohne Richtung den Höchstwert', () => {
    const v = heuteView(verlauf({ 10: 0.4, 11: 2.9 }), LAST, MORGEN);
    expect(v.satz).toBe(`Höchstwert 2,9${NBSP}kW um ${uhr(11)}.`);
  });
});

describe('Werte und Richtung', () => {
  it('nimmt den Betrag nur, wo das Wort daneben die Richtung sagt', () => {
    expect(heuteWert(-0.3, NETZ)).toBe(`0,3${NBSP}kW`);
    expect(heuteRichtung(-0.3, NETZ)).toBe('Einspeisung');
    expect(heuteRichtung(0.3, NETZ)).toBe('Bezug');
    // ⚠ Ohne Richtung wäre „0,3 kW" für −0,3 kW eine erfundene Aussage.
    expect(heuteWert(-0.3, LAST)).toBe(`-0,3${NBSP}kW`);
    expect(heuteRichtung(-0.3, LAST)).toBeNull();
  });

  it('liest eine angetippte Viertelstunde ab - eine Lücke heißt „keine Messung"', () => {
    expect(heuteAblesung({ key: 'k', value: null, label: '12:15' }, NETZ)).toBe('12:15 · keine Messung');
    expect(heuteAblesung({ key: 'k', value: 3.4, label: '12:15' }, NETZ)).toBe(`12:15 · 3,4${NBSP}kW Bezug`);
  });
});

describe('die Zeitachse - an den WAHREN Stellen der Stunden', () => {
  it('setzt 0, 6, 12, 18 und 24 Uhr an einem gewöhnlichen Tag auf Viertel der Breite', () => {
    const v = heuteView(verlauf({ 0: 1 }), NETZ, MORGEN);
    expect(v.achse).toEqual([
      { label: '0 Uhr', anteil: 0 },
      { label: '6', anteil: 0.25 },
      { label: '12', anteil: 0.5 },
      { label: '18', anteil: 0.75 },
      { label: '24', anteil: 1 },
    ]);
  });

  it('richtet sich nach der Uhr, nicht nach gleichen Fünfteln - auch am Tag der Zeitumstellung', () => {
    const von = new Date(2026, 2, 29, 0, 0, 0).getTime();
    const bis = new Date(2026, 2, 30, 0, 0, 0).getTime();
    const v = heuteView({
      range: 'day', from: new Date(von).toISOString(), to: new Date(bis).toISOString(), bucketMinutes: 15,
      channels: { power_kw: [{ start: new Date(von).toISOString(), avg: 1, min: 1, max: 1, last: 1, n: 15 }] },
    }, NETZ, bis);
    const mittag = v.punkte.findIndex((p, i) => {
      const d = new Date(von + i * VIERTEL);
      return d.getHours() === 12 && d.getMinutes() === 0;
    });
    expect(v.achse.find((t) => t.label === '12')?.anteil).toBe(mittag / v.punkte.length);
  });
});
