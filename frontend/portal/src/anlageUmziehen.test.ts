import { describe, expect, it } from 'vitest';
import type { AnlageUmzug } from './api';
import {
  BLEIBT_SATZ,
  folgenKarte,
  geplantZeile,
  pruefeUmzug,
  tagPlus,
  umzugAnfrage,
  umzugFeldAusServer,
  umzugStart,
  verlaufZeilen,
  zielOptionen,
} from './anlageUmziehen';
import { ahrenbergHeute, FIXTURE_IDS, werkAhrenberg } from './test/standorteFixtures';

/**
 * UEMS AP-02 IP-11 — die reine Hälfte von „Anlage zuordnen“ (T6b). Die Zahlen und Namen sind A11:
 * Halle 2 (AN-2) zieht am 20.02.2027 mit „gültig ab“ 01.03.2027 von Werk Ahrenberg (ST-1) nach
 * Werk Ahrenberg Nord (ST-3); Box E-2, Ladepark-Rahmen und Netzanschluss NA-2 bleiben.
 */

const ST1 = { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' };
const ST3 = { id: '5a1d0000-0000-4000-8000-000000000003', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord' };

function a11(over: Partial<AnlageUmzug> = {}): AnlageUmzug {
  return {
    anlageId: FIXTURE_IDS.an2,
    anlageName: 'Werk Ahrenberg – Halle 2',
    bisher: ST1,
    neu: ST3,
    gueltigAb: '2027-03-01',
    gueltigBis: null,
    danach: null,
    rueckwirkung: { art: 'geplant', tage: 9, abzeichen: null },
    zuordnungen: [
      { standort: ST1, gueltigAb: '2026-10-01', gueltigBis: '2027-02-28', zustand: 'gueltig' },
      { standort: ST3, gueltigAb: '2027-03-01', gueltigBis: null, zustand: 'geplant' },
    ],
    bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'ladepark_rahmen', 'fahrplaene', 'messstellen'],
    boxen: 1,
    netzanschluss: { id: 'na-2', kennzeichen: 'NA-2' },
    steuern: null,
    befehle: 0,
    begruendung: null,
    protokoll: [],
    ...over,
  };
}

describe('Folgen-Karte (T6b, A11)', () => {
  it('nennt die vier Dinge, die bleiben: Box, Datenwege, Freigaben, Betriebsmodell — und dass nichts gesendet wird', () => {
    const k = folgenKarte(a11());
    for (const ding of [/VoltPilot-Box/, /Datenwege/, /Freigaben/, /Betriebsmodell/]) {
      expect(k.bleibt.filter((s) => ding.test(s)), String(ding)).toHaveLength(1);
    }
    expect(k.bleibt).toEqual([
      'Die VoltPilot-Box bleibt mit der Anlage verbunden — nichts wird neu eingerichtet.',
      'Die Datenwege bleiben gleich: Messwerte kommen weiter auf demselben Weg an.',
      'Die Freigaben zum Steuern bleiben, wie sie sind.',
      'Das Betriebsmodell und Ihre Regeln bleiben, wie sie sind.',
      'Der Ladepark-Rahmen bleibt, wie er ist.',
      'Fahrpläne bleiben, wie sie sind.',
      'Messstellen bleiben an ihrem Ort.',
      'Die Anlage bleibt an ihrem Netzanschluss NA-2.',
    ]);
    expect(k.befehl).toBe('Es wird kein Befehl an die Anlage gesendet.');
  });

  it('sagt, was sich ändert: ab wann, bis wann der alte Standort gilt, was die Karten zählen — geplant', () => {
    expect(folgenKarte(a11()).aendert).toEqual([
      'Ab 01.03.2027 gehört die Anlage zu Werk Ahrenberg Nord (ST-3).',
      'Bis 28.02.2027 gehört sie weiter zu Werk Ahrenberg (ST-1).',
      'Die Standort-Karten zählen die Anlage ab 01.03.2027 bei Werk Ahrenberg Nord.',
      'Geplant: bis dahin ändert sich nichts.',
    ]);
  });

  it('rückwirkend steht als Abzeichen des Servers da; die erste Zuordnung hat kein „bis“', () => {
    const k = folgenKarte(
      a11({ bisher: null, gueltigAb: '2027-02-01', rueckwirkung: { art: 'rueckwirkend', tage: 19, abzeichen: 'rückwirkend (19 Tage)' } }),
    );
    expect(k.aendert).toEqual([
      'Ab 01.02.2027 gehört die Anlage zu Werk Ahrenberg Nord (ST-3).',
      'Die Standort-Karten zählen die Anlage ab 01.02.2027 bei Werk Ahrenberg Nord.',
      'Rückwirkend (19 Tage): Auswertungen ab dem 01.02.2027 zählen nachträglich anders.',
    ]);
  });

  it('eine schon geplante spätere Zuordnung bleibt und wird genannt', () => {
    const lindach = { id: FIXTURE_IDS.st2, kurzzeichen: 'ST-2', name: 'Werk Lindach' };
    const k = folgenKarte(a11({ neu: lindach, gueltigBis: '2027-05-31', danach: ST3 }));
    expect(k.aendert).toContain(
      'Die neue Zuordnung endet am 31.05.2027: ab 01.06.2027 gilt die schon geplante zu Werk Ahrenberg Nord (ST-3).',
    );
  });

  it('nennt nur, was es gibt: ohne Box kein Box-Satz, ohne Rahmen kein Rahmen-Satz; zwei Boxen im Plural', () => {
    const ohne = folgenKarte(a11({ bleibt: ['topics', 'freigaben', 'betriebsmodell', 'fahrplaene', 'messstellen'], boxen: 0, netzanschluss: null }));
    expect(ohne.bleibt.join(' ')).not.toMatch(/VoltPilot-Box|Ladepark|Netzanschluss/);
    expect(folgenKarte(a11({ boxen: 2 })).bleibt[0]).toBe(
      'Die 2 VoltPilot-Boxen bleiben mit der Anlage verbunden — nichts wird neu eingerichtet.',
    );
  });

  it('die Teilnahme an „Steuern & Optimieren“ bleibt — und sagt, wo sie geführt wird', () => {
    expect(folgenKarte(a11({ steuern: { funktion: 'steuern', zustand: 'aktiv', standort: ST1 } })).bleibt.at(-1)).toBe(
      'Die Teilnahme an „Steuern & Optimieren“ bleibt, wie sie ist — geführt wird sie weiter bei Werk Ahrenberg (ST-1).',
    );
    expect(folgenKarte(a11({ steuern: { funktion: 'steuern', zustand: 'aktiv', standort: ST3 } })).bleibt.at(-1)).toBe(
      'Die Teilnahme an „Steuern & Optimieren“ bleibt, wie sie ist.',
    );
  });

  it('kennt jeden Code des Servers in dessen Reihenfolge (AnlageUmzugService.BLEIBT)', () => {
    expect(Object.keys(BLEIBT_SATZ)).toEqual([
      'box',
      'topics',
      'freigaben',
      'betriebsmodell',
      'ladepark_rahmen',
      'fahrplaene',
      'messstellen',
    ]);
  });
});

describe('Form, Anfrage, Ablehnung', () => {
  it('öffnet ohne Wahl mit heute; fehlende Wahl und zu lange Begründung sind Fehler', () => {
    const f = umzugStart('2027-02-20');
    expect(f).toEqual({ standortId: null, gueltigAb: '2027-02-20', begruendung: '' });
    expect(pruefeUmzug(f)).toEqual({ standortId: 'Bitte wählen Sie den Standort, zu dem die Anlage gehören soll.' });
    expect(umzugAnfrage(f)).toBeNull();
    expect(pruefeUmzug({ ...f, standortId: ST3.id, begruendung: 'x'.repeat(501) }).begruendung).toBe(
      'Die Begründung darf höchstens 500 Zeichen lang sein.',
    );
  });

  it('sendet die Begründung getrimmt — und eine leere gar nicht', () => {
    expect(umzugAnfrage({ standortId: ST3.id, gueltigAb: '2027-03-01', begruendung: '   ' })).toEqual({
      standortId: ST3.id,
      gueltigAb: '2027-03-01',
    });
    expect(umzugAnfrage({ standortId: ST3.id, gueltigAb: '2027-03-01', begruendung: ' Halle 2 gehört zu Nord. ' })).toEqual({
      standortId: ST3.id,
      gueltigAb: '2027-03-01',
      begruendung: 'Halle 2 gehört zu Nord.',
    });
  });

  it('der Satz des Servers gehört an das Feld, das er nennt', () => {
    const satz = 'Für den 01.03.2027 gibt es schon eine Zuordnung (Werk Ahrenberg Nord). Ändern Sie diese, statt eine zweite anzulegen.';
    expect(umzugFeldAusServer({ code: 'gleicher_tag', message: satz, feld: 'gueltigAb' } as never)).toBe('gueltigAb');
    expect(umzugFeldAusServer({ code: 'ziel_ist_bisheriger_eltern', message: 'x', feld: 'standortId' } as never)).toBe('standortId');
    expect(umzugFeldAusServer({ code: 'nicht_gefunden', message: 'x' })).toBeNull();
  });

  it('die Zielliste: bestehende, nicht archivierte Standorte; der heutige sagt es', () => {
    const antwort = ahrenbergHeute();
    const archiviert = werkAhrenberg({ id: 'st-arch', kurzzeichen: 'ST-9', name: 'Altes Lager', zustand: 'archiviert', anlagen: [] });
    const optionen = zielOptionen({ ...antwort, standorte: [...antwort.standorte, archiviert] }, FIXTURE_IDS.an2);
    expect(optionen.map((o) => o.label)).toEqual(['Werk Ahrenberg (ST-1)', 'Werk Lindach (ST-2)']);
    expect(optionen[0].sub).toMatch(/^Heute zugeordnet/);
    expect(optionen[1].sub ?? '').not.toMatch(/Heute zugeordnet/);
  });
});

describe('Nach dem Speichern und in „Meine Anlage“', () => {
  it('der Verlauf zeigt die Zuordnungen, wie der Server sie gelesen hat — ohne aufgehobene', () => {
    const u = a11({
      zuordnungen: [
        ...a11().zuordnungen,
        { standort: ST3, gueltigAb: '2026-12-01', gueltigBis: '2026-12-31', zustand: 'aufgehoben' },
      ],
    });
    expect(verlaufZeilen(u)).toEqual([
      { standort: 'Werk Ahrenberg (ST-1)', zeitraum: '01.10.2026 – 28.02.2027', zustand: 'gilt' },
      { standort: 'Werk Ahrenberg Nord (ST-3)', zeitraum: 'ab 01.03.2027', zustand: 'geplant' },
    ]);
  });

  it('eine geplante Zuordnung steht in der Zeile „Standort“ mit „bis“ und „ab“', () => {
    const heute = { standort: werkAhrenberg(), zuordnung: { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2', gueltigAb: '2026-10-01', gueltigBis: '2027-02-28' } };
    const nord = { standort: werkAhrenberg({ id: ST3.id, kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord' }), zuordnung: { ...heute.zuordnung, gueltigAb: '2027-03-01', gueltigBis: null } };
    expect(geplantZeile(heute, nord)).toBe('bis 28.02.2027 · ab 01.03.2027: Werk Ahrenberg Nord (ST-3)');
    expect(geplantZeile(heute, null)).toBe('bis 28.02.2027 · ab 01.03.2027 keinem Standort zugeordnet');
    expect(geplantZeile({ ...heute, zuordnung: { ...heute.zuordnung, gueltigBis: null } }, null)).toBeNull();
  });

  it('Tage zählen über Monats- und Schaltjahresgrenzen', () => {
    expect(tagPlus('2027-02-28', 1)).toBe('2027-03-01');
    expect(tagPlus('2028-02-28', 1)).toBe('2028-02-29');
    expect(tagPlus('2027-03-01', -1)).toBe('2027-02-28');
    expect(tagPlus('2026-12-31', 1)).toBe('2027-01-01');
  });
});
