import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, parseGuidedFlow } from './flows/guidedBuilder';
import {
  GERAET_ANLEGEN_HINWEIS,
  REGEL_BRUECKE_LABEL,
  SELBSTBAU_COMMUNICATION,
  bietetRegelBruecke,
  geraetAnlegenHash,
  istSelbstbau,
  komponenteAusHash,
  regelBrueckeHash,
  vorbefuellteRegel,
  vorbefuellterName,
  type BrueckenKomponente,
} from './selbstbauBruecke';

const waermepumpe: BrueckenKomponente = {
  entityId: 'e1',
  label: 'Wärmepumpe Keller',
  communication: SELBSTBAU_COMMUNICATION,
  channels: [
    { channel: 'wassertemperatur', label: 'Wassertemperatur', unit: '°C' },
    { channel: 'aufnahmeleistung', label: 'Aufnahmeleistung', unit: 'kW' },
  ],
};

describe('Gerät → Regel', () => {
  it('erkennt eine Selbstbau-Komponente an ihrer Anbindung', () => {
    expect(istSelbstbau(waermepumpe)).toBe(true);
    expect(istSelbstbau({ ...waermepumpe, communication: 'solarman_v5' })).toBe(false);
    expect(istSelbstbau({ entityId: 'e2', label: 'X' })).toBe(false);
  });

  it('bietet die Brücke nur an, wenn es etwas zu bedingen GIBT', () => {
    expect(bietetRegelBruecke(waermepumpe)).toBe(true);
    expect(bietetRegelBruecke({ ...waermepumpe, channels: [] })).toBe(false);
    expect(bietetRegelBruecke({ entityId: 'e3', label: 'Ohne' })).toBe(false);
  });

  it('befüllt den Baukasten mit dem ERSTEN Messwert vor', () => {
    const regel = vorbefuellteRegel(waermepumpe)!;
    expect(regel.conditions).toHaveLength(1);
    expect(regel.conditions[0]).toMatchObject({
      kind: 'entity',
      entityId: 'e1',
      channel: 'wassertemperatur',
    });
  });

  it('lässt die AKTION offen - was passieren soll, weiß nur der Kunde', () => {
    const regel = vorbefuellteRegel(waermepumpe)!;
    expect(regel.action).toEqual({ kind: 'notify', message: '' });
  });

  it('gibt ohne Messwert nichts zurück, statt eine leere Bedingung zu bauen', () => {
    expect(vorbefuellteRegel({ entityId: 'e4', label: 'Leer', channels: [] })).toBeNull();
  });

  /**
   * ⚠ Der Beweis, dass die Vorbefüllung wirklich in den Baukasten passt: sie
   * geht durch den ECHTEN Emitter und den ECHTEN Rück-Parser. Eine Form, die
   * nur „plausibel aussieht", öffnet dem Kunden einen Editor, der sie nicht
   * lesen kann.
   */
  it('ist eine Regel, die der Baukasten wirklich bauen UND zurücklesen kann', () => {
    const regel = vorbefuellteRegel(waermepumpe)!;
    const doc = buildGuidedFlow(regel, vorbefuellterName(waermepumpe), 'site-1');
    const zurueck = parseGuidedFlow(doc);
    expect(zurueck).not.toBeNull();
    expect(zurueck!.conditions[0]).toMatchObject({
      kind: 'entity',
      entityId: 'e1',
      channel: 'wassertemperatur',
    });
  });

  it('schlägt einen Namen vor, der die Komponente nennt', () => {
    expect(vorbefuellterName(waermepumpe)).toBe('Wärmepumpe Keller: neue Regel');
    expect(vorbefuellterName({ entityId: 'e5', label: '  ' })).toBe('Neue Regel');
  });
});

describe('die Adressen', () => {
  it('führt in die Steuerung derselben Anlage', () => {
    expect(regelBrueckeHash('s1', 'e1')).toBe('#/anlage/s1/steuerung?komponente=e1');
    expect(geraetAnlegenHash('s1')).toBe('#/anlage/s1/modell?neu=selbstbau');
  });

  it('kodiert eine Kennung, die Sonderzeichen trägt', () => {
    expect(regelBrueckeHash('s1', 'a b')).toContain('komponente=a%20b');
  });

  it('liest den Parameter zurück - und behauptet ohne ihn nichts', () => {
    expect(komponenteAusHash('#/anlage/s1/steuerung?komponente=e1')).toBe('e1');
    expect(komponenteAusHash('#/anlage/s1/steuerung?vorlage=x&komponente=e9')).toBe('e9');
    expect(komponenteAusHash('#/anlage/s1/steuerung')).toBeNull();
    expect(komponenteAusHash('#/anlage/s1/steuerung?komponente=')).toBeNull();
  });
});

describe('Regel → Gerät', () => {
  it('nennt in der Sackgasse den Ausweg, nicht nur das Problem', () => {
    expect(GERAET_ANLEGEN_HINWEIS).toContain('eigenes Modbus-Gerät');
    expect(GERAET_ANLEGEN_HINWEIS).toContain('zur Auswahl');
    expect(REGEL_BRUECKE_LABEL).toContain('Regel');
  });
});
