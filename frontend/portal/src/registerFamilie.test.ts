import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEOBACHTEN_HINWEIS,
  KATALOG_FAMILIEN,
  beobachtenMoeglich,
  expandFamilien,
  geraetFamilien,
} from './registerFamilie';

// vitest läuft mit cwd = frontend/portal; die Wurzel liegt zwei Ebenen höher.
const wurzel = resolve(process.cwd(), '../..');
const katalogVersion = readFileSync(
  resolve(wurzel, 'catalog/measurement-points/VERSION'), 'utf8').trim();
const katalog = JSON.parse(readFileSync(
  resolve(wurzel, `catalog/measurement-points/dist/measurement-point-catalog-${katalogVersion}.json`),
  'utf8')) as { points: { family: string }[]; families: { family: string; an_der_box: boolean }[] };
const alleFamilien = Array.from(new Set(katalog.points.map((p) => p.family))).sort();
// `an_der_box: false` (Katalog-README „Familien noch nicht an der Box“): der Server bietet diese Familien
// nicht an, die Kopie führt sie darum nicht. Die WAGO-Karten gingen mit 2026.09.23.3 an die Box (AP-05 IP-6b).
const nochNichtAnDerBox = katalog.families.filter((f) => !f.an_der_box).map((f) => f.family).sort();
const echteFamilien = alleFamilien.filter((f) => !nochNichtAnDerBox.includes(f));

// Die Java-Hälfte des Zwillings - Zeichen für Zeichen der Vergleich, der beide
// Seiten zusammenhält.
const javaQuelle = readFileSync(resolve(wurzel,
  'services/api/src/main/java/com/voltpilot/api/measurement/MeasurementCatalogFamilies.java'),
  'utf8');

describe('KATALOG_FAMILIEN ist eine geprüfte Kopie, keine zweite Wahrheit', () => {
  it('führt GENAU die Familien des kanonischen Katalogs, die an eine Box gehen', () => {
    expect([...KATALOG_FAMILIEN].sort()).toEqual(echteFamilien);
    expect(katalog.families.map((f) => f.family).sort()).toEqual(alleFamilien);
  });

  it('lässt die Familien weg, die noch an keine Box gehen - sonst stünde dort ein leerer Kasten', () => {
    expect(nochNichtAnDerBox).toEqual([]);
    expect(KATALOG_FAMILIEN.filter((f) => nochNichtAnDerBox.includes(f))).toEqual([]);
  });

  it('führt die WAGO-Karten, seit sie an der Box sind (Laufzeitstand 2026.09.23.3)', () => {
    expect(geraetFamilien({ soll: 'wago.pm495' })).toEqual(['wago.pm495']);
    expect(geraetFamilien({ soll: 'wago.pm494' })).toEqual(['wago.pm494']);
  });

  it('deckt jede Wildcard-Regel mit den echten Katalog-Namen ab', () => {
    // Ohne diese zwei Zeilen wäre `sunspec`/`shelly_http` eine Prefix-Regel
    // ohne Belegung - der Server expandiert dort gegen den echten Katalog.
    expect(expandFamilien(['sunspec'])).toEqual(
      echteFamilien.filter((f) => f.startsWith('sunspec.model_')));
    expect(expandFamilien(['shelly_http'])).toEqual(
      echteFamilien.filter((f) => f.startsWith('shelly.')));
  });
});

describe('expandFamilien - der Zwilling von MeasurementCatalogFamilies.expand', () => {
  it('bildet jede Sonderregel ab, die der Java-Zwilling kennt', () => {
    // Die Vektoren stehen bewusst NEBEN dem Quelltext-Wächter darunter: sie
    // sagen, WAS herauskommt, er sagt, dass drüben nichts Neues dazukam.
    expect(expandFamilien(['sunspec_live'])).toEqual(expandFamilien(['sunspec']));
    expect(expandFamilien(['goe_http_api'])).toEqual(['goe.api_v2']);
    expect(expandFamilien(['shelly_http'])).toEqual(['shelly.gen1', 'shelly.gen2plus']);
    expect(expandFamilien(['ocpp'])).toEqual(['ocpp.1_6']);
    expect(expandFamilien(['ocpp.1_6'])).toEqual(['ocpp.1_6']);
    expect(expandFamilien(['hybrid_3p'])).toEqual(['hybrid_3p']);
  });

  it('verwirft, was der Katalog nicht kennt - sonst griffe die Ausblende-Regel nie', () => {
    expect(expandFamilien(['modbus-generic'])).toEqual([]);
    expect(expandFamilien(['generic_modbus'])).toEqual([]);
    expect(expandFamilien([null, undefined, ''])).toEqual([]);
  });

  it('dedupliziert und ordnet nach dem Katalog, nie nach der Eingabe', () => {
    expect(expandFamilien(['hybrid_3p', 'hybrid_3p'])).toEqual(['hybrid_3p']);
    expect(expandFamilien(['string', 'hybrid_1p'])).toEqual(['hybrid_1p', 'string']);
    expect(expandFamilien(['hybrid_1p', 'string'])).toEqual(['hybrid_1p', 'string']);
  });

  it('der Java-Zwilling kennt keine Sonderregel, die hier fehlt', () => {
    // Ein neuer `else if (family.equals("…"))`-Zweig drüben muss hier
    // nachgezogen werden; dieser Wächter macht das Vergessen rot.
    const zweige = Array.from(javaQuelle.matchAll(/family\.(?:equals|startsWith)\("([^"]+)"\)/g))
      .map((m) => m[1]).sort();
    expect(zweige).toEqual(['goe_http_api', 'ocpp', 'shelly_http', 'sunspec', 'sunspec_live']);
  });
});

describe('geraetFamilien - das SOLL führt, das IST folgt', () => {
  it('nimmt die gepflegte Familie der Komponente', () => {
    expect(geraetFamilien({ soll: 'hybrid_3p', ist: 'sunspec_live' })).toEqual(['hybrid_3p']);
  });

  it('fällt auf die gemeldete Familie zurück', () => {
    expect(geraetFamilien({ soll: null, ist: 'goe_http_api' })).toEqual(['goe.api_v2']);
  });

  it('gibt einem Ladepunkt seine OCPP-Familie - das ist Konstruktion, nicht Annahme', () => {
    expect(geraetFamilien({ ladepunkt: true })).toEqual(['ocpp.1_6']);
  });

  it('behauptet ohne jede Angabe NICHTS', () => {
    expect(geraetFamilien({})).toEqual([]);
    expect(geraetFamilien({ soll: null, ist: null })).toEqual([]);
    // Ein Selbstbau-Gerät hat keine Katalog-Registerliste - die Sektion
    // entfällt dort, statt leer dazustehen.
    expect(geraetFamilien({ soll: 'modbus-generic' })).toEqual([]);
  });

  it('sieht auf einem zweiten Wechselrichter NUR dessen eigene Familie', () => {
    const fronius = geraetFamilien({ soll: 'sunspec_live' });
    expect(fronius).not.toContain('hybrid_3p');
    expect(fronius.every((f) => f.startsWith('sunspec.model_'))).toBe(true);
  });
});

describe('beobachtenMoeglich - die ehrliche Grenze der Stufe 0', () => {
  it('gilt für den primären Wechselrichter', () => {
    expect(beobachtenMoeglich({ geraetId: 'inverter', familien: ['hybrid_3p'] })).toBe(true);
  });

  it('gilt für OCPP, weil der Core die MeterValues selbst liest', () => {
    expect(beobachtenMoeglich({ geraetId: 'cp-1', familien: ['ocpp.1_6'] })).toBe(true);
  });

  it('gilt NICHT für ein Gerät hinter der Box - dort steht der Satz', () => {
    expect(beobachtenMoeglich({ geraetId: 'src-42', familien: ['goe.api_v2'] })).toBe(false);
    expect(beobachtenMoeglich({ geraetId: 'src-7', familien: ['sunspec.model_103'] })).toBe(false);
    expect(BEOBACHTEN_HINWEIS).toContain('primären Wechselrichter');
  });
});
