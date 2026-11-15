import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aufbau, schreibeEintrag, type FormArt } from './aufbau';
import { lies } from './text';

const ORDNER = '../../docs/contracts/v2/steuerlogik/';
const BEISPIELE = readdirSync(ORDNER).filter((f) => f.endsWith('.logic.yaml'));

function gelesen(text: string) {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  return g;
}

describe('Aufbau der Vertragsbeispiele', () => {
  it.each(BEISPIELE)('%s: jeder Eintrag hat ein Formular, und Speichern ohne Änderung ändert keinen Buchstaben', (datei) => {
    const text = readFileSync(ORDNER + datei, 'utf8');
    const a = aufbau(gelesen(text));
    expect(a.name).not.toBe('');
    const ohneForm = a.abschnitte.flatMap((s) => s.eintraege.filter((e) => e.form === null).map((e) => e.pfad.join('.')));
    // Was der Aufbau nicht darstellt, ist benannt: Zeitpläne bleiben Text.
    for (const p of ohneForm) expect(p).toMatch(/^settings\./);
    for (const s of a.abschnitte) {
      for (const e of s.eintraege) {
        if (!e.form) continue;
        expect(schreibeEintrag(text, e.pfad, e.form, e.wert, structuredClone(e.wert))).toBe(text);
        expect(e.zeilen).not.toBeNull();
      }
    }
  });

  it('nennt, was oben im Dokument kein Abschnitt des Aufbaus ist', () => {
    const text = readFileSync(`${ORDNER}heizung.logic.yaml`, 'utf8');
    const a = aufbau(gelesen(text));
    expect(a.sonst.map((s) => s.schluessel)).toEqual(text.includes('\ndisplay:') ? ['display'] : []);
  });
});

describe('Ein Formular ändert genau seine Felder', () => {
  const WASSER = readFileSync(`${ORDNER}wasser.logic.yaml`, 'utf8');
  const a = aufbau(gelesen(WASSER));
  const eintrag = (pfad: string) => a.abschnitte.flatMap((s) => s.eintraege).find((e) => e.pfad.join('.') === pfad)!;

  function nachher(pfad: string, aendere: (w: Record<string, unknown>) => void): { text: string; js: Record<string, unknown> } {
    const e = eintrag(pfad);
    const neu = structuredClone(e.wert) as Record<string, unknown>;
    aendere(neu);
    const text = schreibeEintrag(WASSER, e.pfad, e.form as FormArt, e.wert, neu);
    return { text, js: gelesen(text).doc.toJS() as Record<string, unknown> };
  }

  it('ein Stellwert: Bereich und wer ihn stellt', () => {
    const { text, js } = nachher('settings.ziel', (w) => {
      w.range = ['40 °C', '70 °C'];
      w.editable_by = 'installer';
    });
    expect((js.settings as Record<string, unknown>).ziel).toEqual({
      name: 'Mit Sonnenstrom bis', default: '57 °C', range: ['40 °C', '70 °C'], step: '1 K', editable_by: 'installer',
    });
    expect(text.split('\n').filter((l, i) => l !== WASSER.split('\n')[i])).toHaveLength(1);
  });

  it('ein Schalter: eine Bedingung dazu, der Satz geändert, Neustart an', () => {
    const { js } = nachher('states.netzheizen', (w) => {
      (w.on_when as unknown[]).push({ 'Winter ist an': 'winter' });
      w.on_text = 'Heizt aus dem Netz';
      w.after_restart = 'on';
    });
    const z = (js.states as Record<string, Record<string, unknown>>).netzheizen;
    expect(z.on_when).toHaveLength(3);
    expect(z.on_text).toBe('Heizt aus dem Netz');
    expect(z.after_restart).toBe('on');
  });

  it('ein Zählerschritt: Wartezeit und Änderung', () => {
    const { js } = nachher('states.stufe', (w) => {
      const s = (w.steps as Record<string, unknown>[])[3];
      s.not_before = '8 min';
      s.by = '+2';
    });
    const s = ((js.states as Record<string, Record<string, unknown>>).stufe.steps as Record<string, unknown>[])[3];
    expect(s.not_before).toBe('8 min');
    expect(s.by).toBe(2);
  });

  it('eine Probe mit Ja/Nein-Werten bleibt in der on/off-Form', () => {
    const { text, js } = nachher('tests.0', (w) => {
      (w.expect as Record<string, unknown>).netzheizen = 'off';
    });
    expect(text).toContain('expect: {netzheizen: off,');
    expect(((js.tests as Record<string, unknown>[])[0].expect as Record<string, unknown>).netzheizen).toBe('off');
  });

  it('ein neuer Eintrag und ein entfernter Eintrag', () => {
    let text = schreibeEintrag(WASSER, ['formulas', 'warmwasser'], 'formel', undefined, 't >= 50 °C');
    expect((gelesen(text).doc.toJS() as Record<string, Record<string, unknown>>).formulas.warmwasser).toBe('t >= 50 °C');
    text = schreibeEintrag(text, ['tests', 5], 'probe', undefined, {
      name: 'Neue Probe', given: { t: '30 °C', clock: '07:00' }, after: '2 min', expect: { netzheizen: 'on' },
    });
    expect(text).toContain('  - name: Neue Probe\n    given: {t: 30 °C, clock: "07:00"}\n    after: 2 min\n    expect: {netzheizen: on}\n');
    const ohne = schreibeEintrag(WASSER, ['settings', 'netz_bis'], 'stellwert', eintrag('settings.netz_bis').wert, undefined);
    expect((gelesen(ohne).doc.toJS() as Record<string, Record<string, unknown>>).settings.netz_bis).toBeUndefined();
  });

  it('der Name einer Regel zwischen Stellwerten', () => {
    const e = eintrag('constraints.0');
    const text = schreibeEintrag(WASSER, e.pfad, 'zusammen', e.wert, { 'Netzziel 5 K über Mindest': 'netz_ziel >= mindest + 5 K' });
    expect((gelesen(text).doc.toJS() as Record<string, unknown[]>).constraints[0]).toEqual({ 'Netzziel 5 K über Mindest': 'netz_ziel >= mindest + 5 K' });
  });
});
