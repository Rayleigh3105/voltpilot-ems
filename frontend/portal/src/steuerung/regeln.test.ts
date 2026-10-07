import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, parseGuidedFlow } from '../flows/guidedBuilder';
import type { GeraetBild, Reihen } from './bild';
import { einordnen, nurMessenKey, vorschlag } from './neu';
import {
  ausGuided,
  bezugAus,
  greift,
  neuerEntwurf,
  probelauf,
  regelSatz,
  vars,
  vorlagenFuer,
  zuGuided,
  type RegelEntwurf,
} from './regeln';
import { band, ladeplan, naechsteUhrzeit } from './laden';
import { N } from './zeit';

function leereReihen(): Reihen {
  const n = () => Array.from({ length: N }, () => null as number | null);
  return { pv: n(), last: n(), netz: n(), bat: n(), soc: n(), preis: n(), temp: n(), abgeregelt: n(), gemessenBis: 52, morgenBekannt: false };
}

const geraet = (o: Partial<GeraetBild> = {}): GeraetBild => ({
  id: 'hs', name: 'Heizstab', kurz: 'Heizstab', symbol: 'flame', typ: 'heating-rod', typLabel: 'Heizstab', form: 'stufig',
  ladepunkt: null, gemessen: true, nennKw: 3, stufenKw: [1, 2, 3], steuerart: null, ohneAuftrag: false, sonnig: true,
  schreibbar: true, nichtSchreibbarGrund: null,
  eintrag: { entityId: 'hs', name: 'Heizstab', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false, regeln: 0, steuerart: { quelle: 'ueberschuss', herkunft: 'policy' } },
  consumer: null, status: null, kw: Array.from({ length: N }, () => 0), herkunft: Array.from({ length: N }, () => null),
  jetztKw: 0, an: false, pill: ['off', 'aus'], warum: '', warumLang: '', eingriff: null, regelJetzt: null, auftrag: '', regeln: 0,
  ...o,
});

const bezug = bezugAus([
  { id: 'grid', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
  { id: 'bat', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['set_power'] },
  { id: 'hs', entityType: 'heating-rod', label: 'Heizstab', measure: ['power_kw'], actuate: ['on_off', 'setpoint_kw'] },
]);

describe('Satzbaukasten', () => {
  it('bietet nur Bausteine an, die die Box ausführen kann', () => {
    const v = vars(bezug);
    expect(v.preis.gesperrt).toBeNull();
    expect(v.sonne.gesperrt).toBeNull();
    expect(v.soc.gesperrt).toBeNull();
    expect(v.temp.gesperrt).toBe('kommt noch');
    expect(vars({ netzId: null, speicherId: null }).sonne.gesperrt).toBe('kein Netzanschluss-Zähler');
  });

  it('wird eine gewöhnliche Regel der Box und kommt unverändert zurück', () => {
    const e: RegelEntwurf = {
      name: 'Mittag',
      wenn: [{ v: 'sonne', op: 'ueber', w: 2 }, { v: 'preis', op: 'unter', w: 10 }, { v: 'zeit', op: 'zwischen', w: [88, 24] }],
      oder: false,
      dann: { g: 'hs', a: 'voll' },
    };
    const regel = zuGuided(e, bezug, geraet())!;
    expect(regel.action).toMatchObject({ kind: 'setpoint', value: 3 });
    const doc = buildGuidedFlow(regel, 'Mittag', 's1');
    const zurueck = ausGuided(parseGuidedFlow(doc)!, bezug, 'Mittag')!;
    expect(zurueck.wenn).toEqual(e.wenn);
    expect(zurueck.dann).toEqual(e.dann);
  });

  it('sagt die Regel als Satz', () => {
    const e = neuerEntwurf([geraet()], { vorlage: 'negativ' });
    const s = regelSatz(e, geraet());
    expect(s.wenn).toBe('Wenn der Börsenpreis unter 0,0 ct/kWh liegt');
    expect(s.dann).toBe('Heizstab einschalten');
  });

  it('greift nur, wo die Bedingung belegt ist - unbekannt ist keine Null', () => {
    const rh = leereReihen();
    rh.preis[60] = -1;
    rh.preis[61] = 12;
    const e = neuerEntwurf([geraet()], { vorlage: 'negativ' });
    const bits = greift(e, rh, 60, 63);
    expect(bits).toEqual([true, false, false]);
    const p = probelauf(e, rh, geraet(), 52);
    expect(p.treffer).toBe(1);
    expect(p.kwh).toBeCloseTo(0.75);
    expect(p.unbekannt).toBe(true);
  });

  it('bietet Vorlagen nur mit Gerät und ausführbaren Bausteinen an', () => {
    expect(vorlagenFuer(bezug, []).length).toBe(0);
    expect(vorlagenFuer({ netzId: null, speicherId: null }, [geraet()]).map((v) => v.id)).toEqual(['negativ', 'guenstig', 'nacht']);
  });
});

describe('Neu in der Anlage', () => {
  it('teilt in neu, nur messen und noch nicht steuerbar', () => {
    const neu = geraet({ id: 'a', ohneAuftrag: true });
    const stumm = geraet({ id: 'b', ohneAuftrag: true });
    const gesperrt = geraet({ id: 'c', ohneAuftrag: true, schreibbar: false });
    const e = einordnen([neu, stumm, gesperrt, geraet({ id: 'd' })], { states: [{ key: nurMessenKey('b'), state: 'nur_messen', mutedUntil: null, updatedAt: '' }] }, Date.now());
    expect(e.neu.map((g) => g.id)).toEqual(['a']);
    expect(e.nurMessen.map((g) => g.id)).toEqual(['b']);
    expect(e.nichtSteuerbar.map((g) => g.id)).toEqual(['c']);
  });

  it('schlägt nur vor, was die Server-Vorgaben vollständig belegen', () => {
    const g = geraet({
      eintrag: {
        entityId: 'x', name: 'X', typ: 'generic-load', typLabel: 'Last', ladepunkt: false, regeln: 0,
        steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' },
        optionen: { schreibbar: true, quellen: [{ id: 'ueberschuss', gesperrt: false }, { id: 'guenstig', gesperrt: false }], ziele: [], vorgaben: { preisgrenzeCtKwh: 9 } },
      },
    });
    // Ohne Schwellen-Vorgabe geht Sonnenstrom nicht - der Vorschlag nimmt günstig.
    expect(vorschlag(g)?.wunsch).toEqual({ quelle: 'guenstig', preisgrenzeCtKwh: 9 });
  });

  it('schlägt die Karte „Sonne + Speicher“ nie als Quelle vor', () => {
    const g = geraet({
      eintrag: {
        entityId: 'x', name: 'X', typ: 'generic-load', typLabel: 'Last', ladepunkt: false, regeln: 0,
        steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' },
        optionen: { schreibbar: true, quellen: [{ id: 'ueberschuss', gesperrt: false }, { id: 'ueberschuss_speicher', gesperrt: false }], ziele: [], vorgaben: {} },
      },
    });
    // Sonnenstrom ohne Schwellen-Vorgabe geht nicht; die Karte ist keine Quelle.
    expect(vorschlag(g)).toBeNull();
  });
});

describe('Laden', () => {
  it('teilt den Netzanschluss auf und plant ein Ziel Sonne zuerst', () => {
    const rh = leereReihen();
    for (let t = 52; t < 70; t++) { rh.preis[t] = 20; rh.netz[t] = t < 56 ? -4 : 0.5; rh.last[t] = 1; }
    const b = band({ netzanschlussKw: 22, effektivGrenzeKw: 22, sicherheitsabstandPct: 10, hausLastKw: 1 }, [], rh, 52)!;
    expect(b.freiKw).toBeCloseTo(18.8);
    const p = ladeplan(rh, 52, 70, 6, 4, false);
    expect(p.schafft).toBe(true);
    expect(p.pvKwh).toBeCloseTo(4);
    expect(naechsteUhrzeit(52, '07:00')).toBe(124);
    expect(naechsteUhrzeit(52, '16:00')).toBe(64);
  });
});
