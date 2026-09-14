import { describe, expect, it } from 'vitest';
import {
  GESAMTWERT,
  MAX_TERME,
  abgeleiteteGroesse,
  alsAnfrage,
  entwurfFehler,
  frischeVon,
  hakenAnwendbar,
  istPvErzeugung,
  groessenGemischt,
  leererEntwurf,
  nameVorschlag,
  passt,
  punkt,
  rechenzeile,
  richtungsEntscheidungSatz,
  richtungsloseOhneEntscheidung,
  schritt1Fertig,
  sperrgrund,
  summierbar,
  tagesverlauf,
  termAus,
  unvollstaendigSatz,
  vorschau,
  wertText,
  type KanalPunkt,
  type Quellwert,
} from './gesamtwert';

/** Ein Quell-Wert für die Tests — der Ankerfall SUN-30K spricht Wirkleistung · Erzeugung · kW. */
function q(over: Partial<Quellwert> = {}): Quellwert {
  return {
    entityId: 'e1',
    channel: 'pv1_power_kw',
    name: 'PV 1',
    geraet: 'Deye SUN-30K',
    groesse: 'Wirkleistung',
    richtung: 'Erzeugung',
    einheit: 'kW',
    wertart: 'Momentanwert',
    wert: 5.2,
    stand: '2026-09-12T10:00:00Z',
    ...over,
  };
}

describe('gesamtwert · Kundenwort', () => {
  it('das eine Kundenwort ist „Gesamtwert"', () => {
    expect(GESAMTWERT).toBe('Gesamtwert');
  });
});

describe('gesamtwert · Frische → Status-Punkt', () => {
  const jetzt = Date.parse('2026-09-12T10:02:00Z');
  it('ein frischer Wert ist grün', () => {
    expect(frischeVon('2026-09-12T10:00:00Z', 5.2, jetzt)).toBe('frisch');
    expect(punkt('frisch')).toBe('ok');
  });
  it('ein alter Wert ist gelb', () => {
    expect(frischeVon('2026-09-12T09:50:00Z', 5.2, jetzt)).toBe('alt');
    expect(punkt('alt')).toBe('warn');
  });
  it('kein Wert ist grau — nie eine erfundene 0', () => {
    expect(frischeVon(null, null, jetzt)).toBe('keine');
    expect(frischeVon('2026-09-12T10:00:00Z', null, jetzt)).toBe('keine');
    expect(punkt('keine')).toBe('off');
  });
});

describe('gesamtwert · Größen-Verträglichkeit (keine Äpfel + Birnen)', () => {
  it('ein Wert ohne Vertrags-Größe ist nicht summierbar', () => {
    expect(summierbar(q({ groesse: null }))).toBe(false);
    expect(summierbar(q())).toBe(true);
  });
  it('ohne Auswahl passt jeder summierbare Wert', () => {
    expect(passt(q(), [])).toBe(true);
  });
  it('mit Auswahl passt nur, wer Größe UND Wertart teilt', () => {
    const gewaehlt = [q()];
    expect(passt(q({ channel: 'pv2_power_kw', einheit: 'W' }), gewaehlt)).toBe(true); // kW vs W ok
    expect(passt(q({ groesse: 'Wirkenergie', einheit: 'kWh', wertart: 'Zählerstand' }), gewaehlt)).toBe(
      false,
    );
  });
  it('eine Sperre nennt ihren Grund, sie verschwindet nicht', () => {
    const gewaehlt = [q()];
    expect(sperrgrund(q(), gewaehlt)).toBeNull();
    expect(sperrgrund(q({ groesse: 'Ladestand', einheit: '%', wertart: 'Momentanwert' }), gewaehlt)).toMatch(
      /Andere Messgröße/,
    );
    expect(sperrgrund(q({ groesse: null }), [])).toMatch(/Messgröße/);
  });
});

describe('gesamtwert · Ableitung von Größe und Vorschau', () => {
  it('leitet die Hauptgröße aus den Termen ab (Wirkleistung · Erzeugung · kW)', () => {
    const terme = [termAus(q()), termAus(q({ channel: 'pv2_power_kw', name: 'PV 2', wert: 4.1 }))];
    const g = abgeleiteteGroesse(terme);
    expect(g).toEqual({ groesse: 'Wirkleistung', richtung: 'Erzeugung', einheit: 'kW', wertart: 'Momentanwert' });
  });

  it('rechnet die Live-Summe (Ankerfall PV1+PV2+PV3+Mikro = 15,5 kW)', () => {
    const terme = [
      termAus(q({ channel: 'pv1', name: 'PV 1', wert: 5.2 })),
      termAus(q({ channel: 'pv2', name: 'PV 2', wert: 4.1 })),
      termAus(q({ channel: 'pv3', name: 'PV 3', wert: 3.1 })),
      termAus(q({ channel: 'micro', name: 'Mikrowechselrichter', wert: 3.1 })),
    ];
    const v = vorschau(terme);
    expect(v.wert).toBeCloseTo(15.5, 6);
    expect(v.einheit).toBe('kW');
    expect(v.unvollstaendig).toBe(false);
    expect(rechenzeile(terme)).toContain('= 15,5');
  });

  it('normiert W und kW auf die Anzeige-Einheit', () => {
    const terme = [
      termAus(q({ channel: 'a', name: 'A', einheit: 'kW', wert: 1 })),
      termAus(q({ channel: 'b', name: 'B', einheit: 'W', wert: 500 })),
    ];
    // Anzeige-Einheit ist die der ersten Größe: kW → 1 kW + 0,5 kW.
    expect(vorschau(terme).wert).toBeCloseTo(1.5, 6);
  });

  it('EHRLICHKEIT: ein fehlender Term macht die Summe null (nie eine Teilsumme)', () => {
    const terme = [
      termAus(q({ channel: 'a', name: 'PV 1', wert: 5.2 })),
      termAus(q({ channel: 'b', name: 'PV 2', wert: null, stand: null })),
    ];
    const v = vorschau(terme);
    expect(v.wert).toBeNull();
    expect(v.unvollstaendig).toBe(true);
    expect(v.fehlende).toEqual(['PV 2']);
    expect(rechenzeile(terme)).toContain('unvollständig');
    expect(rechenzeile(terme)).toContain('—');
    expect(unvollstaendigSatz(v.fehlende)).toContain('PV 2');
  });

  it('ein Minus-Term ergibt ein Netto (richtungslos)', () => {
    const terme = [
      termAus(q({ groesse: 'Wirkleistung', richtung: 'Bezug', wert: 3 })),
      { ...termAus(q({ groesse: 'Wirkleistung', richtung: 'Erzeugung', wert: 5 })), vorzeichen: '-' as const },
    ];
    // gemischte Richtung/Vorzeichen → das ist eine echte Größe (richtungslos), kein Fehler.
    expect(groessenGemischt(terme)).toBe(false);
    expect(abgeleiteteGroesse(terme)?.richtung).toBe('richtungslos');
  });

  it('gemischte Größen sind ein Fehler', () => {
    const terme = [
      termAus(q()),
      termAus(q({ groesse: 'Ladestand', richtung: 'Ladestand', einheit: '%', wertart: 'Momentanwert' })),
    ];
    expect(groessenGemischt(terme)).toBe(true);
    expect(abgeleiteteGroesse(terme)).toBeNull();
  });
});

describe('gesamtwert · reine PV-Erzeugung (für den Namensvorschlag)', () => {
  it('nur bei Wirkleistung · Erzeugung', () => {
    expect(istPvErzeugung([termAus(q())])).toBe(true);
    expect(istPvErzeugung([termAus(q({ groesse: 'Wirkleistung', richtung: 'Bezug' }))])).toBe(false);
    expect(istPvErzeugung([])).toBe(false);
  });
});

describe('gesamtwert · AP-08-Haken „gilt als Erzeugung" (Gen-Port)', () => {
  // Der Gen-Port: Wirkleistung, aber im Katalog OHNE Richtung (direction: null).
  const genPort = q({ channel: 'generator_power_kw', name: 'Gen-Port', richtung: null, wert: 3.1 });

  it('der Haken ist nur am richtungslosen, summierbaren Kanal anwendbar', () => {
    expect(hakenAnwendbar(genPort)).toBe(true);
    expect(hakenAnwendbar(q())).toBe(false); // PV 1 hat schon die Richtung Erzeugung
    expect(hakenAnwendbar(q({ groesse: null, richtung: null }))).toBe(false); // kein Zahlenwert
  });

  it('der Gen-Port ist summierbar und passt zur PV-Summe', () => {
    expect(summierbar(genPort)).toBe(true);
    expect(passt(genPort, [q()])).toBe(true);
  });

  it('OHNE Haken degradiert der Gen-Port die Summe zu richtungslos → nicht PV', () => {
    const terme = [termAus(q()), termAus(genPort)];
    expect(abgeleiteteGroesse(terme)?.richtung).toBe('richtungslos');
    expect(istPvErzeugung(terme)).toBe(false);
  });

  it('MIT Haken bleibt die Summe Erzeugung → PV', () => {
    const terme = [termAus(q()), { ...termAus(genPort), giltAlsErzeugung: true }];
    expect(abgeleiteteGroesse(terme)?.richtung).toBe('Erzeugung');
    expect(istPvErzeugung(terme)).toBe(true);
  });

  it('alsAnfrage sendet gilt_als_erzeugung nur für den geflaggten richtungslosen Term', () => {
    const anfrage = alsAnfrage({
      id: null,
      name: 'Gesamt-PV',
      terme: [termAus(q()), { ...termAus(genPort), giltAlsErzeugung: true }],
    });
    expect(anfrage.terme[0].gilt_als_erzeugung).toBeUndefined();
    expect(anfrage.terme[1].gilt_als_erzeugung).toBe(true);
  });
});

describe('gesamtwert · Hart-Riegel: richtungsloser Term ohne Entscheidung sperrt das Speichern (B1)', () => {
  // Der Gen-Port über den natürlichen „+ Beobachten"-Pfad: richtungslos, OHNE Haken.
  const genPortOhne = q({ channel: 'generator_power_kw', name: 'Gen-Port', richtung: null, wert: 3.1 });

  it('REGRESSION (Reviewer-Repro): ein richtungsloser Term ohne Haken degradiert NICHT zu gemischt', () => {
    // Genau die Falle aus dem Review: die Summe bleibt größenverträglich (richtungslos ist eine
    // gültige Größe), also fängt `schritt1Fertig` allein den Bruch NICHT ab - erst der Riegel tut es.
    const terme = [termAus(q()), termAus(genPortOhne)];
    expect(schritt1Fertig(terme)).toBe(true);
    // Der Server würde diesen richtungslosen Term ohne Haken mit 400 ablehnen …
    const anfrage = alsAnfrage({ id: null, name: 'PV gesamt', terme });
    expect(anfrage.terme[1].gilt_als_erzeugung).toBeUndefined();
    // … deshalb sperrt der Riegel client-seitig und nennt den offenen Term.
    expect(richtungsloseOhneEntscheidung(terme)).toHaveLength(1);
    expect(richtungsloseOhneEntscheidung(terme)[0].quelle.name).toBe('Gen-Port');
  });

  it('mit gesetzter Entscheidung ist kein Term mehr offen', () => {
    const terme = [termAus(q()), { ...termAus(genPortOhne), giltAlsErzeugung: true }];
    expect(richtungsloseOhneEntscheidung(terme)).toHaveLength(0);
  });

  it('gerichtete Terme (PV-Stränge, Netto aus +Bezug −Erzeugung) sind nie „offen"', () => {
    expect(richtungsloseOhneEntscheidung([termAus(q()), termAus(q({ channel: 'pv2' }))])).toHaveLength(0);
    const netto = [
      termAus(q({ groesse: 'Wirkleistung', richtung: 'Bezug', wert: 3 })),
      { ...termAus(q({ groesse: 'Wirkleistung', richtung: 'Erzeugung', wert: 5 })), vorzeichen: '-' as const },
    ];
    expect(richtungsloseOhneEntscheidung(netto)).toHaveLength(0);
  });

  it('der erklärte Grund nennt den offenen Term (nicht der generische Serverfehler)', () => {
    expect(richtungsEntscheidungSatz(['Gen-Port'])).toContain('Gen-Port');
    expect(richtungsEntscheidungSatz(['Gen-Port'])).toMatch(/als Erzeugung/);
    expect(richtungsEntscheidungSatz(['A', 'B'])).toContain('A, B');
    expect(richtungsEntscheidungSatz([])).toBe('');
  });
});

describe('gesamtwert · Name-Vorschlag', () => {
  it('eine reine Erzeugungs-Leistung heisst „Gesamt-PV"', () => {
    expect(nameVorschlag([termAus(q())])).toBe('Gesamt-PV');
  });
  it('sonst ein sprechender Name aus den Termen', () => {
    const terme = [
      termAus(q({ groesse: 'Wirkleistung', richtung: 'Bezug', name: 'Halle A' })),
      termAus(q({ groesse: 'Wirkleistung', richtung: 'Bezug', name: 'Halle B' })),
    ];
    expect(nameVorschlag(terme)).toContain('Halle A');
  });
});

describe('gesamtwert · Validierung', () => {
  it('ohne Term nicht speicherbar', () => {
    expect(entwurfFehler(leererEntwurf())).toMatch(/mindestens einen Wert/);
  });
  it('gemischte Größen nicht speicherbar', () => {
    const e = {
      ...leererEntwurf(),
      name: 'X',
      terme: [
        termAus(q()),
        termAus(q({ groesse: 'Ladestand', richtung: 'Ladestand', einheit: '%', wertart: 'Momentanwert' })),
      ],
    };
    expect(entwurfFehler(e)).toMatch(/unterschiedliche Messgrößen/);
  });
  it('Faktor 0 nicht speicherbar', () => {
    const e = { ...leererEntwurf(), name: 'X', terme: [{ ...termAus(q()), faktor: 0 }] };
    expect(entwurfFehler(e)).toMatch(/Faktor/);
  });
  it('ohne Namen nicht speicherbar', () => {
    const e = { ...leererEntwurf(), terme: [termAus(q())] };
    expect(entwurfFehler(e)).toMatch(/Namen/);
  });
  it('ein gültiger Entwurf hat keinen Fehler', () => {
    const e = { ...leererEntwurf(), name: 'Gesamt-PV', terme: [termAus(q())] };
    expect(entwurfFehler(e)).toBeNull();
  });
  it('schritt1Fertig braucht mindestens einen Term und passende Größen', () => {
    expect(schritt1Fertig([])).toBe(false);
    expect(schritt1Fertig([termAus(q())])).toBe(true);
  });
  it('höchstens MAX_TERME', () => {
    const viele = Array.from({ length: MAX_TERME + 1 }, (_, i) => termAus(q({ channel: `c${i}` })));
    expect(entwurfFehler({ ...leererEntwurf(), name: 'X', terme: viele })).toMatch(/höchstens/);
  });
});

describe('gesamtwert · Anlege-Anfrage', () => {
  it('trägt die Terme snake_case, die Hauptgröße leitet der Server ab', () => {
    const e = {
      ...leererEntwurf(),
      name: '  Gesamt-PV  ',
      terme: [
        termAus(q({ channel: 'pv1', wert: 5.2 })),
        { ...termAus(q({ channel: 'pv2', wert: 4.1 })), vorzeichen: '-' as const, faktor: 0.5 },
      ],
    };
    expect(alsAnfrage(e)).toEqual({
      name: 'Gesamt-PV',
      terme: [
        { eingang_art: 'messkanal', entity_id: 'e1', point_key: 'pv1', vorzeichen: '+', faktor: 1 },
        { eingang_art: 'messkanal', entity_id: 'e1', point_key: 'pv2', vorzeichen: '-', faktor: 0.5 },
      ],
    });
  });
});

describe('gesamtwert · Tages-Verlauf (client-seitig, ehrlich)', () => {
  it('summiert ein Zeitraster nur, wenn ALLE Terme darin einen Wert haben', () => {
    const terme = [termAus(q({ channel: 'a', name: 'A' })), termAus(q({ channel: 'b', name: 'B' }))];
    const reihen = new Map<string, KanalPunkt[]>([
      ['e1::a', [
        { start: '10:00', wert: 5 },
        { start: '10:15', wert: 6 },
      ]],
      ['e1::b', [
        { start: '10:00', wert: 4 },
        { start: '10:15', wert: null }, // Lücke
      ]],
    ]);
    const v = tagesverlauf(terme, reihen);
    expect(v).toEqual([
      { start: '10:00', wert: 9 },
      { start: '10:15', wert: null },
    ]);
  });
});

describe('gesamtwert · wertText', () => {
  it('null bleibt ein Strich', () => {
    expect(wertText(null, 'kW')).toBe('—');
  });
  it('rundet grobe Zahlen ohne, feine mit Nachkomma', () => {
    expect(wertText(155, 'kW')).toMatch(/155/);
    expect(wertText(1.55, 'kW')).toMatch(/1,55/);
  });
});
