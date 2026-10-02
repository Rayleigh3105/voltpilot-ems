import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ablehnungSatz,
  ablehnungSchritt,
  einverstaendnisNoetig,
  FOERDERWEGE,
  foerderwegReihe,
  formelsatzVorschlag,
  giltAb,
  naechsterMonatserster,
  netzladenHinweis,
  netzladenZeile,
  schritteFuer,
  wahlPaar,
  zaehlerZustand,
} from './mispelFoerderweg';

/** Die Wahrheit des Vertrags (`mispel-foerderweg.md` 1.2): Werte, Begriffe, Netzladen, Formelsätze. */
const vektoren = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/mispel-foerderweg-vectors.json'), 'utf8'),
) as {
  werte: { wert: string; begriff: string; netzladen_moeglich: boolean }[];
  formelsaetze: string[];
  vereinfacht_statt: Record<string, string | string[]>;
  faelle: { erwartet: string | null }[];
};
const vertrag = readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/mispel-foerderweg.md'), 'utf8');

describe('MiSpeL-Förderweg im Portal — Zwilling des Vertrags', () => {
  it('die fünf Werte mit Begriff und Netzladen wörtlich wie die Vektoren', () => {
    expect(FOERDERWEGE.map((f) => f.wert).sort()).toEqual(vektoren.werte.map((w) => w.wert).sort());
    for (const w of vektoren.werte) {
      const f = FOERDERWEGE.find((x) => x.wert === w.wert)!;
      expect(f.begriff, w.wert).toBe(w.begriff);
      expect(f.netzladenMoeglich, w.wert).toBe(w.netzladen_moeglich);
    }
  });

  it('dieselben Formelsätze und dieselbe Wahl vereinfacht ↔ umfangreich', () => {
    const v = formelsatzVorschlag('tauglich', 'tauglich', null, '2026-11-01');
    expect(v.optionen.map((o) => o.wert)).toEqual(vektoren.formelsaetze);
    for (const [vereinfacht, umfangreich] of Object.entries(vektoren.vereinfacht_statt)) {
      for (const u of [umfangreich].flat()) expect(wahlPaar(vereinfacht, u), `${vereinfacht} statt ${u}`).toBe(true);
    }
    expect(wahlPaar('A1', 'A5')).toBe(false);
  });

  it('jede Ablehnung des Vertrags hat einen Schritt; jede Fall-Ablehnung einen eigenen Satz', () => {
    const codes = [...vertrag.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(codes).toContain('netzladen_bei_vormerkung');
    for (const code of codes) expect(['foerderweg', 'zaehler', 'formelsatz', 'partner', 'pruefen']).toContain(ablehnungSchritt({ code }));
    for (const code of new Set(vektoren.faelle.map((f) => f.erwartet).filter((c): c is string => c != null))) {
      if (code === 'anfrage_ungueltig' || code === 'netzladen_bei_vormerkung') continue; // die Fläche schickt beides nie
      expect(ablehnungSatz({ code, message: 'SERVER' }), code).not.toBe('SERVER');
    }
  });

  it('jede Ablehnung erscheint in dem Schritt, in dem sie entsteht (BK-17)', () => {
    expect(ablehnungSchritt({ code: 'pauschaloption_noch_nicht_anwendbar' })).toBe('foerderweg');
    expect(ablehnungSchritt({ code: 'foerderweg_unveraendert' })).toBe('foerderweg');
    expect(ablehnungSchritt({ code: 'formelsatz_gebunden' })).toBe('formelsatz');
    expect(ablehnungSchritt({ code: 'aw_regel_passt_nicht' })).toBe('formelsatz');
    expect(ablehnungSchritt({ code: 'einverstaendnis_fehlt' })).toBe('partner');
    expect(ablehnungSchritt({ code: 'anfrage_ungueltig', feld: 'direktvermarkter' })).toBe('partner');
    expect(ablehnungSchritt({ code: 'wechsel_nur_zum_monatsersten' })).toBe('pruefen');
    expect(ablehnungSchritt({ code: 'foerderweg_rueckwirkend' })).toBe('pruefen');
    expect(ablehnungSatz({ code: 'formelsatz_gebunden', formelsatz: 'A10', gebunden_bis: '2026-12-31' })).toBe(
      'Die Wahl A10 bindet bis 31.12.2026; ändern lässt sie sich zum 01.01. (A1 S. 24, Abschn. 3.2.3).',
    );
    expect(ablehnungSatz({ code: 'unbekannt', message: 'Satz des Servers.' })).toBe('Satz des Servers.');
  });
});

describe('Monatserster und Vormerken (Vertrag § 5)', () => {
  it('ein anderer Förderweg gilt ab dem nächsten Monatsersten, am Ersten ab heute', () => {
    expect(naechsterMonatserster('2026-10-20')).toBe('2026-11-01');
    expect(naechsterMonatserster('2026-12-31')).toBe('2027-01-01');
    expect(giltAb('2026-10-20', 'marktpraemie_ausschliesslichkeit', 'marktpraemie_abgrenzung', null)).toBe('2026-11-01');
    expect(giltAb('2026-11-01', 'marktpraemie_ausschliesslichkeit', 'marktpraemie_abgrenzung', null)).toBe('2026-11-01');
  });

  it('derselbe Weg mit anderen Angaben gilt ab heute; eine Vormerkung wird an ihrem Tag berichtigt', () => {
    expect(giltAb('2026-10-20', 'marktpraemie_abgrenzung', 'marktpraemie_abgrenzung', null)).toBe('2026-10-20');
    expect(giltAb('2026-10-20', 'einspeiseverguetung', 'ungefoerdert', '2026-11-01')).toBe('2026-11-01');
  });

  it('das Einverständnis braucht es nur in den MiSpeL-Optionen bis 30.09.2027 (Tenor Ziff. 9a)', () => {
    expect(einverstaendnisNoetig('marktpraemie_abgrenzung', '2027-09-01')).toBe(true);
    expect(einverstaendnisNoetig('marktpraemie_abgrenzung', '2027-10-01')).toBe(false);
    expect(einverstaendnisNoetig('ungefoerdert', '2026-11-01')).toBe(false);
  });
});

describe('Schritte und Netzladen (BK-17 A)', () => {
  it('Kurzweg bei Einspeisevergütung, Ausschließlichkeitsoption und ungefördert', () => {
    expect(schritteFuer('einspeiseverguetung')).toEqual(['foerderweg', 'pruefen']);
    expect(schritteFuer('marktpraemie_ausschliesslichkeit')).toEqual(['foerderweg', 'pruefen']);
    expect(schritteFuer('ungefoerdert')).toEqual(['foerderweg', 'pruefen']);
    expect(schritteFuer('marktpraemie_abgrenzung')).toEqual(['foerderweg', 'zaehler', 'formelsatz', 'partner', 'pruefen']);
  });

  it('der heutige Weg steht vorn, die Pauschaloption zuletzt und gesperrt mit Grund', () => {
    const reihe = foerderwegReihe('marktpraemie_ausschliesslichkeit');
    expect(reihe[0].wert).toBe('marktpraemie_ausschliesslichkeit');
    expect(reihe.at(-1)?.wert).toBe('marktpraemie_pauschal');
    expect(reihe.at(-1)?.gesperrt).toMatch(/Tenor Ziff. 9b/);
  });

  it('Netzladen offen nur, wo der Förderweg es zulässt; unbekannt ist kein „erlaubt“', () => {
    expect(netzladenZeile('marktpraemie_abgrenzung')).toEqual({ offen: true, satz: 'Ihre Einstellung — mit der Abgrenzungsoption erlaubt' });
    expect(netzladenZeile('marktpraemie_ausschliesslichkeit')).toEqual({ offen: false, satz: 'In der Ausschließlichkeitsoption nicht möglich' });
    expect(netzladenZeile('einspeiseverguetung').offen).toBe(false);
    expect(netzladenZeile(null).offen).toBe(false);
  });

  it('W2: kein Förderweg behauptet mehr „EEG-geförderte Anlagen dürfen nicht aus dem Netz laden“', () => {
    for (const f of FOERDERWEGE) expect(netzladenHinweis(f.wert)).not.toMatch(/EEG-geförderte Anlagen dürfen/);
    expect(netzladenHinweis('marktpraemie_abgrenzung')).toMatch(/darf der Speicher Sonnen- und Netzstrom mischen/);
    expect(netzladenHinweis(null)).toMatch(/hängt vom Förderweg/);
  });
});

describe('Formelsatz-Vorschlag — Gebot der Bestnutzung (A1 S. 24, Abschn. 3.2.3)', () => {
  it('mit Z1 und Z2 schlägt er A1 vor und sperrt die vereinfachten A10/A11', () => {
    const v = formelsatzVorschlag('tauglich', 'tauglich', null, '2026-11-01');
    expect(v.vorschlag).toBe('A1');
    expect(v.optionen.find((o) => o.wert === 'A10')?.gesperrt).toMatch(/Gebot der Bestnutzung/);
    expect(v.optionen.find((o) => o.wert === 'A11')?.gesperrt).toMatch(/Gebot der Bestnutzung/);
    expect(v.optionen.find((o) => o.wert === 'A5')?.gesperrt).toBeNull();
  });

  it('mit Z3 schlägt er A4 vor und sperrt das vereinfachte A3; ohne Z3 ist A4 gesperrt (A1 S. 24, S. 31)', () => {
    const mit = formelsatzVorschlag('tauglich', 'tauglich', null, '2026-11-01', 'tauglich');
    expect(mit.vorschlag).toBe('A4');
    expect(mit.optionen.find((o) => o.wert === 'A3')?.gesperrt).toMatch(/Gebot der Bestnutzung/);
    const ohne = formelsatzVorschlag('tauglich', 'tauglich', null, '2026-11-01');
    expect(ohne.optionen.find((o) => o.wert === 'A4')?.gesperrt).toMatch(/Z3/);
    expect(ohne.optionen.find((o) => o.wert === 'A2')?.gesperrt).toBeNull();
    expect(formelsatzVorschlag('tauglich', 'tauglich', 'A2', '2026-11-01').vorschlag).toBe('A2');
  });

  it('ohne Z2 trägt kein Formelsatz die Abgrenzung mit geförderter EE-Anlage', () => {
    const v = formelsatzVorschlag('tauglich', 'fehlt', null, '2026-11-01');
    expect(v.vorschlag).toBeNull();
    expect(v.satz).toMatch(/Ohne Z2/);
    expect(v.optionen.every((o) => o.gesperrt != null)).toBe(true);
  });

  it('eine getroffene Wahl A5 ↔ A5-Variante bindet bis 31.12., außer zum 01.01.', () => {
    expect(formelsatzVorschlag('tauglich', 'tauglich', 'A5', '2026-11-01').optionen.find((o) => o.wert === 'A5-Variante')?.gesperrt).toMatch(
      /bindet bis 31.12.2026/,
    );
    expect(formelsatzVorschlag('tauglich', 'tauglich', 'A5', '2027-01-01').optionen.find((o) => o.wert === 'A5-Variante')?.gesperrt).toBeNull();
  });

  it('der Zustand eines Zählers aus den Urteilen seiner beiden Richtungen', () => {
    expect(zaehlerZustand(['tauglich', 'tauglich'])).toBe('tauglich');
    expect(zaehlerZustand(['tauglich', 'nicht_pruefbar'])).toBe('nicht_pruefbar');
    expect(zaehlerZustand(['nicht_tauglich', 'tauglich'])).toBe('nicht_tauglich');
    expect(zaehlerZustand(['tauglich', null])).toBe('fehlt');
    expect(zaehlerZustand(['keine_rolle', 'tauglich'])).toBe('fehlt');
  });
});
