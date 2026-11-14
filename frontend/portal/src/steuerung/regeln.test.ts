import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, GUIDED_WISH_TTL_S, parseGuidedFlow } from '../flows/guidedBuilder';
import type { FlowSummary } from '../flows/flowsApi';
import type { GeraetBild, Reihen } from './bild';
import { einordnen, nurMessenKey, vorschlag } from './neu';
import {
  ausGuided,
  bezugAus,
  greift,
  neuerEntwurf,
  notifyUmwandlung,
  probelauf,
  regelKarten,
  regelSatz,
  regelSatzAusFlow,
  vars,
  vorlagenFuer,
  zuGuided,
  type RegelEntwurf,
} from './regeln';
import { band, naechsteUhrzeit } from './laden';
import { N } from './zeit';

function leereReihen(): Reihen {
  const n = () => Array.from({ length: N }, () => null as number | null);
  return { pv: n(), last: n(), netz: n(), bat: n(), soc: n(), preis: n(), bezug: n(), einspeise: n(), temp: n(), abgeregelt: n(), gemessenBis: 52, morgenBekannt: false };
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
    // N2 (report.md §11, needs-decision n2-preis-feed, Entscheid: Weg B): die Box
    // bekommt nie einen Preis - gesperrt wie jeder andere nicht ausführbare Baustein.
    expect(v.preis.gesperrt).toBe('kommt noch');
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

  it('N1 (report.md §11): „Nachts laufen lassen" kompiliert mit einem Wunsch, der das ganze Fenster hält', () => {
    const e = neuerEntwurf([geraet()], { vorlage: 'nacht' });
    const regel = zuGuided(e, bezug, geraet())!;
    expect(regel.action.ttlS).toBe(GUIDED_WISH_TTL_S);
    const doc = buildGuidedFlow(regel, e.name, 's1');
    const control = doc.nodes.find((n) => n.type === 'vp.entity.control')!;
    // flowc re-fires den Trigger genau einmal je 900s-Slot (Slot-Grenze) +
    // bis zu 30s Auslöser-Jitter: ein kürzerer ttl_s hielt den Wunsch nur
    // 5 von 15 Minuten (Lab-Nachstellung, regel-takt.js).
    expect(control.parameters.ttl_s as number).toBeGreaterThanOrEqual(930);
  });

  it('sagt die Regel als Satz', () => {
    const e = neuerEntwurf([geraet()], { vorlage: 'negativ' });
    const s = regelSatz(e, geraet());
    expect(s.wenn).toBe('Wenn der Börsenpreis unter 0,0 ct/kWh liegt');
    expect(s.dann).toBe('Heizstab einschalten');
  });

  it('greift nur, wo die Bedingung belegt ist - unbekannt ist keine Null', () => {
    const rh = leereReihen();
    rh.soc[60] = 95;
    rh.soc[61] = 50;
    const e = neuerEntwurf([geraet()], { vorlage: 'voll' });
    const bits = greift(e, rh, 60, 63);
    expect(bits).toEqual([true, false, false]);
    const p = probelauf(e, rh, geraet(), 52);
    expect(p.treffer).toBe(1);
    expect(p.kwh).toBeCloseTo(0.75);
  });

  it('N2 (report.md §11): eine Preis-Bedingung greift im Probelauf nie - die Box hat nie einen Preis', () => {
    // Anders als `sonne`/`soc`/`zeit`: eine Preis-Bedingung kompiliert zu
    // `vp.price.current`, das Thema `edge/price/current` liest - reserviert,
    // der Core speist es nicht. Ein bekannter Marktpreis im Portal (selbst für
    // heute UND morgen) darf den Probelauf nicht zu Schaltzeiten verführen, die
    // die Box nie ausführt.
    const rh = leereReihen();
    rh.preis[60] = -1; // negativer Preis, Bedingung der 'negativ'-Vorlage - und bekannt
    rh.morgenBekannt = true;
    const e = neuerEntwurf([geraet()], { vorlage: 'negativ' });
    const bits = greift(e, rh, 60, 63);
    expect(bits).toEqual([false, false, false]);
    const p = probelauf(e, rh, geraet(), 52);
    expect(p.treffer).toBe(0);
    expect(p.kwh).toBe(0);
    expect(p.niedrigsterPreis).toBe(-1); // der Hinweistext „nie zu" bleibt informativ
  });

  it('N2: eine bereits angelegte Preis-Regel verschwindet nicht, sie wird ehrlich gekennzeichnet', () => {
    // Weg B (needs-decision n2-preis-feed, Entscheid 14.11.2026): der Baustein wird
    // gesperrt, eine SCHON gebaute Regel mit Preis-Bedingung bleibt aber stehen - sie
    // wird weder gelöscht noch stillschweigend ausgeblendet, nur ehrlich markiert.
    const regel = zuGuided(neuerEntwurf([geraet()], { vorlage: 'negativ' }), bezug, geraet())!;
    const doc = buildGuidedFlow(regel, 'Negativpreise mitnehmen', 's1');
    const flow: FlowSummary = {
      flowId: 'f-preis', name: 'Negativpreise mitnehmen', runtime: 'edge', latestVersion: 1,
      latestLifecycle: 'active', activeVersion: 1, updatedAt: '2026-01-01T00:00:00Z',
      simulation: null, latestDocument: doc, versions: [1],
    };
    const karten = regelKarten([flow], bezug, { hs: 'Heizstab' });
    expect(karten).toHaveLength(1);
    expect(karten[0].an).toBe(true);
    expect(karten[0].preisNichtAusgefuehrt).toBe(true);

    // Eine Regel ohne Preis-Bedingung bleibt unberührt.
    const nachtRegel = zuGuided(neuerEntwurf([geraet()], { vorlage: 'nacht' }), bezug, geraet())!;
    const nachtDoc = buildGuidedFlow(nachtRegel, 'Nachts laufen lassen', 's1');
    const nachtFlow: FlowSummary = { ...flow, flowId: 'f-nacht', name: 'Nachts laufen lassen', latestDocument: nachtDoc };
    expect(regelKarten([nachtFlow], bezug, { hs: 'Heizstab' })[0].preisNichtAusgefuehrt).toBe(false);
  });

  it('bietet Vorlagen nur mit Gerät und ausführbaren Bausteinen an', () => {
    expect(vorlagenFuer(bezug, []).length).toBe(0);
    // N2 (Entscheid: Weg B): 'negativ' und 'guenstig' brauchen den gesperrten
    // Preis-Baustein und verschwinden deshalb aus der Galerie - 'nacht' bleibt.
    expect(vorlagenFuer({ netzId: null, speicherId: null }, [geraet()]).map((v) => v.id)).toEqual(['nacht']);
  });

  it('verspricht bei einer Benachrichtigungs-Regel nie eine ankommende Nachricht (Entscheid 10A)', () => {
    const regel = {
      conditions: [{ kind: 'entity' as const, entityId: 'bat', channel: 'soc_pct', direction: 'below' as const, threshold: 20 }],
      combinator: 'and' as const,
      action: { kind: 'notify' as const, message: 'Ladestand niedrig' },
    };
    expect(regelSatzAusFlow(regel, {})).toBe('Wenn der Speicher unter 20 % hat: Benachrichtigung (kommt noch nicht an).');
  });

  it('bietet „In Überwachung umwandeln" nur bei einer einzelnen Messwert-Bedingung an', () => {
    const einzelMesswert = {
      conditions: [{ kind: 'entity' as const, entityId: 'bat', channel: 'soc_pct', direction: 'below' as const, threshold: 20 }],
      combinator: 'and' as const,
      action: { kind: 'notify' as const, message: 'x' },
    };
    expect(notifyUmwandlung(einzelMesswert)).toEqual({ entityId: 'bat', channel: 'soc_pct' });

    const keineBenachrichtigung = { ...einzelMesswert, action: { kind: 'onoff' as const, entityId: 'hs', ttlS: 300 } };
    expect(notifyUmwandlung(keineBenachrichtigung)).toBeNull();

    const preisBedingung = {
      conditions: [{ kind: 'price' as const, direction: 'below' as const, threshold: 10 }],
      combinator: 'and' as const,
      action: { kind: 'notify' as const, message: 'x' },
    };
    expect(notifyUmwandlung(preisBedingung)).toBeNull();

    const zweiBedingungen = { ...einzelMesswert, conditions: [...einzelMesswert.conditions, ...einzelMesswert.conditions] };
    expect(notifyUmwandlung(zweiBedingungen)).toBeNull();
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
  it('teilt den Netzanschluss auf und findet die nächste Uhrzeit', () => {
    const rh = leereReihen();
    for (let t = 52; t < 70; t++) { rh.preis[t] = 20; rh.netz[t] = t < 56 ? -4 : 0.5; rh.last[t] = 1; }
    const b = band({ netzanschlussKw: 22, effektivGrenzeKw: 22, sicherheitsabstandPct: 10, hausLastKw: 1 }, [], rh, 52)!;
    expect(b.freiKw).toBeCloseTo(18.8);
    expect(naechsteUhrzeit(52, '07:00')).toBe(124);
    expect(naechsteUhrzeit(52, '16:00')).toBe(64);
  });
});
