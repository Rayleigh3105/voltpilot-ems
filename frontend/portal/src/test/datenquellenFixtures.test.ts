import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOX_AB,
  BOX_NAMEN,
  BOX_TAUSCH,
  BOX_TAUSCH_ENDE,
  GERAET_QUELLE,
  ahrenbergDatenquellen,
  ahrenbergUemsGeraete,
} from './datenquellenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Der Gleichheitstest der Bühnen-Fixtures gegen die EINE Beispielquelle
 * `docs/contracts/v2/uems-referenzunternehmen.json` (UEMS AP-13 IP-12).
 *
 * Die Bühne darf `docs/contracts` nicht laden, die Werte stehen deshalb als Literale in
 * `datenquellenFixtures.ts`. Damit sie nicht auseinanderlaufen, vergleicht dieser Test JEDE
 * gespiegelte Angabe — Namen, Zeitpunkte, Adressen, Kadenzen und die Zuordnung Gerät → Datenquelle.
 */
const WURZEL = resolve(process.cwd(), '../../docs/contracts/v2');
const daten = JSON.parse(readFileSync(resolve(WURZEL, 'uems-referenzunternehmen.json'), 'utf8')) as Record<string, any>;

const gleich = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/**
 * Die EINE Ausnahme vom Spiegel: die Objekte der mitsteuernden Boxen einer gemeinsamen Steuerung
 * (Referenzunternehmen 1.5, AP-15 E8) — die Boxen mit der Rolle `steuert_mit`, die Datenquellen, für die sie
 * zuständig sind, und deren Geräte. Die Bühne zeigt die Welt ohne gemeinsame Steuerung; fällt mit AP-15 IP-23
 * weg, das die Bühne um die gemeinsame Steuerung erweitert.
 */
const ohneGemeinsameSteuerung = (() => {
  const boxen = new Set<string>(
    (daten.gemeinsame_steuerungen ?? []).flatMap((v: any) =>
      v.mitglieder.filter((m: any) => m.rolle === 'steuert_mit').map((m: any) => m.box),
    ),
  );
  const quellen = new Set<string>(
    daten.zuordnungen.filter((z: any) => z.art === 'datenquelle_box' && boxen.has(z.nach)).map((z: any) => z.von),
  );
  return {
    boxen: daten.boxen.filter((b: any) => !boxen.has(b.kennzeichen)),
    datenquellen: daten.datenquellen.filter((q: any) => !quellen.has(q.kennzeichen)),
    geraete: daten.geraete.filter((g: any) => !quellen.has(g.datenquelle)),
  };
})();

describe('Datenquellen-Fixtures ⟷ Referenzunternehmen', () => {
  it('die vier Boxen tragen Namen und Inbetriebnahme der Referenz', () => {
    expect(ohneGemeinsameSteuerung.boxen).toHaveLength(4);
    for (const b of ohneGemeinsameSteuerung.boxen) {
      const kz = b.kennzeichen as keyof typeof BOX_NAMEN;
      expect(BOX_NAMEN[kz]).toBe(b.name);
      expect(gleich(BOX_AB[kz], b.in_betrieb_ab)).toBe(true);
    }
  });

  it('der Box-Tausch steht an der ausgebauten Box und an der Nachfolgerin', () => {
    const alt = daten.boxen.find((b: any) => b.kennzeichen === 'E-2');
    const neu = daten.boxen.find((b: any) => b.vorgaenger === 'E-2');
    expect(gleich(BOX_TAUSCH, alt.ausgebaut_am)).toBe(true);
    expect(gleich(BOX_TAUSCH, neu.in_betrieb_ab)).toBe(true);
    // Das Ende der Lücke ist die erste Lesung der neuen Box (Zeitachse).
    const lesung = daten.zeitachse.find((e: any) => String(e.ereignis).includes('Erste Lesung von E-2′'));
    expect(gleich(BOX_TAUSCH_ENDE, lesung.zeitpunkt)).toBe(true);
  });

  it('jedes Gerät zeigt auf die Datenquelle der Referenz', () => {
    expect(Object.keys(GERAET_QUELLE)).toHaveLength(ohneGemeinsameSteuerung.geraete.length);
    for (const g of ohneGemeinsameSteuerung.geraete) expect(GERAET_QUELLE[g.kennzeichen]).toBe(g.datenquelle);
  });

  it('die sieben Datenquellen tragen Protokoll, Adresse, Geräte-IDs und Kadenz der Referenz', () => {
    const alle = [FIXTURE_IDS.an1, FIXTURE_IDS.an2, FIXTURE_IDS.an3].flatMap(
      (a) => ahrenbergDatenquellen(a, BOX_TAUSCH).datenquellen,
    );
    expect(alle).toHaveLength(ohneGemeinsameSteuerung.datenquellen.length);
    for (const q of ohneGemeinsameSteuerung.datenquellen) {
      const f = alle.find((x) => x.kennzeichen === q.kennzeichen)!;
      expect(f.protokoll).toBe(q.protokoll);
      expect(f.adresse).toBe(q.adresse);
      expect(f.geraete_ids).toEqual(q.geraete_ids);
      expect(f.kadenz_s).toBe(q.kadenz_s);
      expect(f.steuerquelle).toBe(q.steuerquelle);
      expect(f.netz).toBe(q.netz);
    }
  });

  it('nach dem Tausch ist E-2′ für BEIDE Quellen von Halle 2 zuständig, E-2 für keine', () => {
    const nachher = new Date(Date.parse(BOX_TAUSCH) + 60_000).toISOString();
    const an2 = ahrenbergDatenquellen(FIXTURE_IDS.an2, nachher).datenquellen;
    expect(an2.map((q) => q.kennzeichen).sort()).toEqual(['DQ-4', 'DQ-5']);
    for (const q of an2) expect(q.zustaendige_box!.name).toBe(BOX_NAMEN['E-2′']);
  });

  it('die Geräte-Kennungen sind die des Registers', async () => {
    const { ahrenbergRegister } = await import('./messstellenRegisterFixtures');
    const register = ahrenbergRegister({});
    const geraete = new Set(
      [FIXTURE_IDS.an1, FIXTURE_IDS.an2, FIXTURE_IDS.an3].flatMap((a) => ahrenbergUemsGeraete(a).geraete.map((g) => g.id)),
    );
    const ausDemRegister = register.register.flatMap((z) => (z.quelle.fuehrend ? [z.quelle.fuehrend.geraet.id] : []));
    expect(ausDemRegister.length).toBeGreaterThan(0);
    for (const g of ausDemRegister) expect(geraete.has(g)).toBe(true);
  });
});
