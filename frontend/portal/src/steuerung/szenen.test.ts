import { describe, expect, it } from 'vitest';
import type { Consumer } from '../consumers/types';
import type { VerbraucherEintrag } from '../verbraucherZone';
import { geraete, type GeraetBild, type Reihen } from './bild';
import { SZENEN, szeneDef, szenenfaehig, szenenGeraete, szenenStand } from './szenen';
import { N, raster } from './zeit';

const NOW = new Date(2026, 8, 29, 13, 10);
const r = raster(NOW);

function leereReihen(): Reihen {
  const n = () => Array.from({ length: N }, () => null as number | null);
  return { pv: n(), last: n(), netz: n(), bat: n(), soc: n(), preis: n(), temp: n(), abgeregelt: n(), gemessenBis: r.jetzt, morgenBekannt: false };
}

const eintrag = (entityId: string, name: string, quelle = 'ueberschuss'): VerbraucherEintrag => ({
  entityId, name, typ: 'generic-load', typLabel: 'Steuerbare Last', ladepunkt: false, regeln: 0,
  steuerart: { quelle, herkunft: 'policy', schwelleKw: 1 },
  optionen: { schreibbar: true, quellen: [{ id: quelle, gesperrt: false }], ziele: [], vorgaben: {} },
});

const consumer = (id: string, controlActivation: Consumer['controlActivation']) =>
  ({ id, ratedPowerKw: 1, enabled: controlActivation !== 'paused', controlActivation, version: 1 }) as unknown as Consumer;

function bildMit(ca: Record<string, Consumer['controlActivation']>, szene?: { name: string; ids: string[] }): GeraetBild[] {
  return geraete({
    raster: r,
    reihen: leereReihen(),
    verbraucher: {
      verbraucher: [
        eintrag('pool', 'Poolpumpe'),
        eintrag('klima', 'Klimagerät Büro'),
        eintrag('hs', 'Heizstab Warmwasser'),
        eintrag('wama', 'Waschmaschine', 'feste_zeiten'),
      ],
      ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
      rangliste: [],
    },
    consumers: Object.entries(ca).map(([id, a]) => consumer(id, a)),
    szene: szene ?? null,
  });
}

describe('Szenen', () => {
  it('bietet nur Geräte mit eigenem, aktivem Auftrag an', () => {
    const gs = bildMit({ pool: 'active', klima: 'paused', hs: 'not_activated' });
    expect(gs.filter(szenenfaehig).map((g) => g.id)).toEqual(['pool', 'klima']);
  });

  it('schlägt je Szene passende Geräte vor, die übrigen stehen zur Wahl', () => {
    const gs = bildMit({ pool: 'active', klima: 'active', hs: 'active', wama: 'active' });
    const urlaub = szenenGeraete(szeneDef('urlaub')!, gs);
    expect(urlaub.filter((z) => z.vorgeschlagen).map((z) => z.g.id)).toEqual(['pool', 'klima', 'wama']);
    expect(urlaub.filter((z) => !z.vorgeschlagen).map((z) => z.g.id)).toEqual(['hs']);
    expect(szenenGeraete(szeneDef('unterwegs')!, gs).filter((z) => z.vorgeschlagen).map((z) => z.g.id)).toEqual(['klima']);
    expect(szenenGeraete(szeneDef('sparen')!, gs).filter((z) => z.vorgeschlagen).map((z) => z.g.id)).toEqual(['wama']);
  });

  it('liest die laufende Szene und kennt nur ihr Vokabular', () => {
    expect(SZENEN.map((s) => s.id)).toEqual(['urlaub', 'unterwegs', 'sparen']);
    const s = szenenStand({ scene: { key: 'urlaub', since: '2026-09-29T08:00:00Z', pausedEntityIds: ['pool'] }, offen: [], message: null });
    expect(s?.def.name).toBe('Urlaub');
    expect(s?.ids).toEqual(['pool']);
    expect(szenenStand({ scene: null, offen: [], message: null })).toBeNull();
    expect(szenenStand(null)).toBeNull();
  });

  it('zeigt ein Gerät, das die Szene pausiert hat, als gesperrt - ohne erwartete Läufe', () => {
    const [pool, klima] = bildMit({ pool: 'paused', klima: 'paused' }, { name: 'Urlaub', ids: ['pool'] });
    expect(pool.pill).toEqual(['lock', 'gesperrt']);
    expect(pool.warum).toBe('Szene „Urlaub“: aus');
    expect(pool.herkunft.slice(r.jetzt + 1).every((h) => h == null)).toBe(true);
    // Von Hand pausiert (nicht durch die Szene): ehrlich „pausiert“.
    expect(klima.pill).toEqual(['lock', 'pausiert']);
  });
});
