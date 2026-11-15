import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LogikAusHomeAssistant } from '../../api';
import { fehlendeDateien, hinweisMeldungen, liesDateien, lueckeArt, lueckeFrage, notiz, offen, optionen, ortText, stand } from './homeassistant';

/** Die Antwort des Logik-Dienstes für die Test-Anlage, gepinnt vom Dienst selbst (`logikdienst/homeassistant_test.go`). */
const ANTWORT = JSON.parse(readFileSync('../../docs/contracts/v2/examples/steuerlogik-home-assistant.valid.solarheizung.json', 'utf8')) as LogikAusHomeAssistant;
const L = (k: string) => ANTWORT.luecken.find((l) => l.kennung === k)!;

const datei = (name: string, text = 'a: 1') => ({ name, size: new TextEncoder().encode(text).length, text: async () => text });

describe('Aus Home Assistant: Dateien lesen', () => {
  it('liest YAML-Dateien als Text', async () => {
    const g = await liesDateien([datei('configuration.yaml', 'input_boolean: {}'), datei('automations.YML', '[]')]);
    expect(g.fehler).toBeNull();
    expect(g.dateien).toEqual([{ name: 'configuration.yaml', text: 'input_boolean: {}' }, { name: 'automations.YML', text: '[]' }]);
  });

  it('nimmt nur YAML, höchstens acht Dateien und zusammen 1 MB', async () => {
    expect((await liesDateien([])).fehler).toBe('Bitte mindestens eine Datei wählen.');
    expect((await liesDateien([datei('ui-lovelace.json')])).fehler).toBe('„ui-lovelace.json“ ist keine YAML-Datei.');
    expect((await liesDateien(Array.from({ length: 9 }, (_, i) => datei(`d${i}.yaml`)))).fehler).toBe('Höchstens 8 Dateien auf einmal.');
    expect((await liesDateien([{ name: 'gross.yaml', size: 1024 * 1024 + 1, text: async () => '' }])).fehler)
      .toBe('Die Dateien sind zusammen größer als 1 MB.');
  });
});

describe('Aus Home Assistant: die Antwort des Dienstes', () => {
  it('ist vollständig zugeordnet und übernehmbar', () => {
    expect(ANTWORT.vollstaendig).toBe(true);
    expect(offen(ANTWORT)).toEqual([]);
    expect(stand(ANTWORT)).toEqual({ satz: 'Übersetzt und geprüft. Sie können die Logik übernehmen.', art: 'ok' });
    expect(notiz(ANTWORT)).toBe('Aus Home Assistant übersetzt (configuration.yaml, automations.yaml, scripts.yaml)');
    expect(fehlendeDateien(ANTWORT)).toEqual([]);
  });

  it('beschreibt Geräte und Messwerte und fragt bei Leistungen nach dem Vorzeichen', () => {
    expect(lueckeArt(L('durchlauferhitzer'))).toBe('Gerät mit 3 Ausgängen, geschaltet in Stufen');
    expect(lueckeArt(L('speicher_2_oben'))).toBe('Messwert: Temperatur');
    expect(lueckeFrage(L('wr_akkuleistung'))).toBe('Was zählt Home Assistant hier positiv?');
    expect(lueckeFrage(L('speicher_2_oben'))).toBeNull();
    expect(optionen(L('wr_akkuleistung')).map((o) => o.value)).toEqual(['site.grid', '-site.grid', 'battery.power', '-battery.power', 'site.pv']);
    expect(L('wr_akkuleistung').wert).toBe('-battery.power');
  });

  it('nennt offene Lücken und Stellen, die nicht übersetzbar sind', () => {
    const ohneNetz: LogikAusHomeAssistant = { ...ANTWORT, vollstaendig: false,
      luecken: ANTWORT.luecken.map((l) => (l.kennung === 'wr_netzleistung' ? { ...l, wert: '' } : l)) };
    expect(stand(ohneNetz)).toEqual({ satz: 'Noch eine Lücke zuordnen.', art: 'warten' });
    const kaputt: LogikAusHomeAssistant = { ...ANTWORT, text: '', vollstaendig: false,
      nicht_uebersetzt: [{ ort: { datei: 'automations.yaml', zeile: 7 }, was: 'delay', grund: 'Abläufe mit Warten gibt es in der Logik nicht' }] };
    expect(stand(kaputt)).toEqual({ satz: 'Eine Stelle lässt sich nicht übersetzen.', art: 'fehler' });
    expect(ortText(kaputt.nicht_uebersetzt[0].ort)).toBe('automations.yaml, Zeile 7');
    expect(fehlendeDateien({ ...ANTWORT, dateien: ['automations.yaml'] })).toEqual(['configuration.yaml', 'scripts.yaml']);
  });

  it('zeigt die Hinweise an ihrer Zeile im übersetzten Text', () => {
    const m = hinweisMeldungen(ANTWORT);
    const zeilen = ANTWORT.text.split('\n');
    const schritt = m.find((x) => x.text.includes('„Heizstufe rauf“ nur jede Minute'));
    expect(schritt?.art).toBe('hinweis');
    expect(zeilen[(schritt?.zeile ?? 0) - 1]).toContain('name: stufe_rauf');
  });
});
