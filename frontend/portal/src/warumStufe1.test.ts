/**
 * ERKLÄRBARKEIT STUFE 1 „Der Echtheits-Kern" (Konzept
 * `data/vp-warum-erklaerbar-e2` §4/§5/§8, Captain-Entscheide F1/F2/F6).
 *
 * Stufe 0 hat die unechten Ursachen entfernt; diese Stufe liefert die FAKTEN,
 * also dürfen die echten Ursachen wieder gesagt werden - und nur die. Geprüft
 * wird deshalb in beide Richtungen:
 *
 * 1. **Mit den Fakten** entsteht der Satz, der am 17.08.2026 gefehlt hat (die
 *    ABNAHME aus §4.5), und er nennt die Zahlen, die ihn tragen.
 * 2. **Ohne sie** ist jeder kausale Zweig UNERREICHBAR und die Fläche bleibt
 *    zeichengleich Stufe 0 - das prüft zusätzlich der Warum-Wächter
 *    (`begruendung.test.ts`) über ALLE Rollen.
 *
 * Die zwei Abnahme-Fixtures sind die realen Tage aus §2/§4.5: der Trüb-Abend
 * (Anker Bezugspreis, Gleichstand) und ein sonniger Normaltag (Anker
 * Einspeisewert, hohe freie Auffüllung).
 */

import { describe, expect, it } from 'vitest';

import {
  BEGRUENDUNGEN,
  KNOWN_ANCHORS,
  KNOWN_NEXT_BEST,
  NEXT_BEST_TIE_CT,
  REFILL_HIGH_PCT,
  REFILL_LOW_PCT,
  ankerSatz,
  margeSatz,
  nextBestOf,
  refillFreePct,
  slotContextRows,
  slotWhy,
  technikRows,
  terminalAnchor,
  type PlanWhyFacts,
  type WhySlot,
} from './fahrplanWhy';

/** Eine ruhende Viertelstunde mit den Fakten, die der Aufrufer setzt. */
function ruht(over: Partial<WhySlot> = {}): WhySlot {
  return {
    start: '2026-08-17T18:45:00Z',
    batteryKw: 0,
    priceEurMwh: null,
    costEur: null,
    baselineCostEur: null,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: null,
    ...over,
  };
}

/** §4.5: der 17.08.-Abend, wie ihn der Solver seit Stufe 1 exportiert. */
const TRUEBER_ABEND: PlanWhyFacts = {
  whyTerminalAnchor: 'bezugspreis',
  whyRefillFreePct: 0,
};
const TRUEBER_SLOT = ruht({
  storedValueCtKwh: 23.5,
  importPriceCtKwh: 25.0,
  importPriceSource: 'fest',
  whyNextBest: 'decken',
  whyNextBestMarginCt: 0,
});

/** Der sonnige Normaltag: der Horizont füllt den Speicher selbst wieder. */
const SONNIGER_TAG: PlanWhyFacts = {
  whyTerminalAnchor: 'einspeisewert',
  whyRefillFreePct: 62,
};
const SONNIGER_SLOT = ruht({
  storedValueCtKwh: 8.1,
  whyNextBest: 'verkaufen',
  whyNextBestMarginCt: -3.1,
});

describe('Stufe 1: das Vokabular ist geschlossen und wird nie geraten', () => {
  it('ein unbekanntes Anker-Wort wird IGNORIERT, nicht gedeutet', () => {
    expect(terminalAnchor({ whyTerminalAnchor: 'zeitreise' })).toBeNull();
    expect(terminalAnchor({ whyTerminalAnchor: null })).toBeNull();
    expect(terminalAnchor(null)).toBeNull();
    expect(terminalAnchor(undefined)).toBeNull();
    for (const a of KNOWN_ANCHORS) {
      // `vorgabe` ist bewusst kein Anker, über den sich etwas sagen ließe.
      const got = terminalAnchor({ whyTerminalAnchor: a });
      expect(got).toBe(a === 'vorgabe' ? null : a);
    }
  });

  it('Name UND Marge sind EINE Aussage - eine halbe zählt nicht', () => {
    for (const k of KNOWN_NEXT_BEST) {
      expect(nextBestOf(ruht({ whyNextBest: k, whyNextBestMarginCt: -1 }))?.kind).toBe(k);
    }
    expect(nextBestOf(ruht({ whyNextBest: 'decken' }))).toBeNull();
    expect(nextBestOf(ruht({ whyNextBestMarginCt: -1 }))).toBeNull();
    expect(nextBestOf(ruht({ whyNextBest: 'schlafen', whyNextBestMarginCt: -1 }))).toBeNull();
  });

  it('eine fehlende Auffüll-Quote bleibt null, nie eine erfundene 0', () => {
    expect(refillFreePct({ whyRefillFreePct: null })).toBeNull();
    expect(refillFreePct({})).toBeNull();
    // Eine EXPORTIERTE 0 ist dagegen eine Aussage („nichts füllt nach").
    expect(refillFreePct({ whyRefillFreePct: 0 })).toBe(0);
  });

  it('der Gleichstand keyt auf die ANGEZEIGTE Genauigkeit', () => {
    const tie = nextBestOf(
      ruht({ whyNextBest: 'decken', whyNextBestMarginCt: -NEXT_BEST_TIE_CT }),
    );
    expect(tie?.tie).toBe(true);
    const klar = nextBestOf(ruht({ whyNextBest: 'decken', whyNextBestMarginCt: -0.2 }));
    expect(klar?.tie).toBe(false);
  });
});

describe('Stufe 1: die Gate-Tabelle ist vollständig und ehrlich', () => {
  it('jeder Eintrag nennt seine Gates und seine Aussage', () => {
    expect(BEGRUENDUNGEN.length).toBeGreaterThan(0);
    for (const b of BEGRUENDUNGEN) {
      // Kleinbuchstaben + Ziffern (Stufe 3 trägt `grenze_14a`).
      expect(b.id).toMatch(/^[a-z0-9_]+$/);
      expect(b.gates.length).toBeGreaterThan(0);
      expect(b.aussage.length).toBeGreaterThan(10);
    }
    // Ids sind eindeutig - sonst könnten zwei Zweige denselben Beleg
    // beanspruchen und einer wäre ungeprüft.
    expect(new Set(BEGRUENDUNGEN.map((b) => b.id)).size).toBe(BEGRUENDUNGEN.length);
  });
});

describe('Abnahme §4.5: der 17.08.-Abend erklärt sich jetzt WAHR', () => {
  it('nennt den Anker, die fehlende Auffüllung UND den Gleichstand', () => {
    const satz = slotWhy(TRUEBER_SLOT, 'eigenverbrauch', undefined, [], TRUEBER_ABEND) as string;
    // Der Kern: der Speicher hebt auf, weil die Ladung später Netzbezug ersetzt.
    expect(satz).toContain('hebt seine Ladung');
    expect(satz).toContain('ersetzt später Netzbezug');
    expect(satz).toContain('23,5 ct/kWh');
    // ... der Horizont füllt ihn kaum nach (die exportierte Quote, im Satz).
    expect(satz).toContain('kaum nach');
    expect(satz).toContain('0 %');
    // ... und die Entscheidung war ein GLEICHSTAND, kein Kalkül.
    expect(satz).toContain('praktisch gleichwertig');
    expect(satz).toContain('±0,0 ct/kWh');
    // F6: die Tie-Break-POLITIK wird als Politik benannt, nicht als Ökonomie.
    expect(satz).toContain('VoltPilot wählt dann die schonendere Option');
  });

  it('der Preisunterschied-Satz bleibt strukturell unerreichbar', () => {
    const satz = slotWhy(TRUEBER_SLOT, 'eigenverbrauch', undefined, [], TRUEBER_ABEND) as string;
    expect(satz).not.toMatch(/Preisunterschied/);
    expect(satz).not.toMatch(/Nichtstun/);
    expect(satz).not.toMatch(/wirtschaftlichste/);
  });

  it('OHNE die Lauf-Fakten ist der Satz zeichengleich Stufe 0', () => {
    const stufe0 = slotWhy(ruht({ storedValueCtKwh: 23.5 }), 'eigenverbrauch') as string;
    expect(stufe0).toBe(
      'Der Speicher wartet – für diese Viertelstunde ist weder Laden noch Entladen eingeplant.',
    );
    // Auch mit λ, aber ohne Anker: kein Anker-Satz.
    expect(slotWhy(TRUEBER_SLOT, 'eigenverbrauch')).not.toContain('hebt seine Ladung');
  });

  it('OHNE λ gibt es keinen Anker-Satz, auch mit Anker', () => {
    expect(ankerSatz(ruht(), TRUEBER_ABEND)).toBeNull();
    const nurMarge = slotWhy(
      ruht({ whyNextBest: 'decken', whyNextBestMarginCt: 0 }),
      'eigenverbrauch',
      undefined,
      [],
      TRUEBER_ABEND,
    ) as string;
    expect(nurMarge).toContain('Der Speicher wartet.');
    expect(nurMarge).toContain('praktisch gleichwertig');
    expect(nurMarge).not.toContain('ersetzt später Netzbezug');
  });

  it('Lesehöhe (b): die vier tragenden Zahlen stehen unter dem Satz', () => {
    const rows = slotContextRows(TRUEBER_SLOT, [], TRUEBER_ABEND, 'eigenverbrauch');
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Netzstrom kostet Sie jetzt']).toContain('25,0 ct/kWh');
    // λ stand hier schon immer - NEU ist sein WARUM.
    expect(byLabel['Wert gespeicherter Energie']).toContain('23,5 ct/kWh');
    expect(byLabel['Wert gespeicherter Energie']).toContain('später Netzbezug ersetzt');
    expect(byLabel['Füllt sich von selbst nach']).toContain('0 %');
    expect(byLabel['Nächstbeste Option']).toContain('praktisch gleichwertig');
  });

  it('Lesehöhe (c): der Technik-Blick zeigt die Terme, aber nur belegte', () => {
    const rows = technikRows(
      { ...TRUEBER_SLOT, gridValueCtKwh: 25.0 },
      { ...TRUEBER_ABEND, fallback14a: false },
      'eigenverbrauch',
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['λ Wert gespeicherter Energie']).toContain('23,5 ct/kWh');
    expect(byLabel['λ Wert gespeicherter Energie']).toContain('vermiedener Netzbezug');
    expect(byLabel['π Energiewert am Netzpunkt']).toContain('25,0 ct/kWh');
    expect(byLabel['Freie PV-Auffüllung im Zeitraum']).toContain('0 %');
    expect(byLabel['Marge der verworfenen Option']).toContain('Gleichstand');
    expect(byLabel['Bindungen']).toBe('keine');
    expect(byLabel['Netzgrenze §14a eingeplant']).toBe('ja');
    // μ fehlt ohne Leistungspreis-Anteil - kein „0,00 €/kW", das eine
    // Lastspitzenkappung behaupten würde, die es nicht gibt.
    expect(byLabel['μ Leistungspreis-Anteil']).toBeUndefined();
    // Die Rolle steht als Überschrift der Karte, nicht ein zweites Mal hier.
    expect(rows.some((r) => r.label === 'Rolle im Plan')).toBe(false);
  });

  it('ohne einen einzigen Term entsteht KEIN Technik-Blick', () => {
    expect(technikRows(ruht(), null)).toEqual([{ label: 'Bindungen', value: 'keine' }]);
  });
});

describe('Abnahme: der sonnige Normaltag erzählt die andere Wahrheit', () => {
  it('nennt den Einspeise-Anker und die freie Auffüllung', () => {
    const satz = slotWhy(SONNIGER_SLOT, 'direktvermarktung', undefined, [], SONNIGER_TAG) as string;
    expect(satz).toContain('bemisst sich an der Einspeisung');
    expect(satz).toContain('8,1 ct/kWh');
    expect(satz).toContain('ohnehin wieder auf');
    expect(satz).toContain('62 %');
    // Eine KLARE Entscheidung wird beziffert, nicht als Gleichstand verkleidet.
    expect(satz).toContain('Jetzt zu verkaufen wäre 3,1 ct/kWh schlechter');
    expect(satz).not.toMatch(/wäre jetzt/);
    expect(satz).not.toContain('gleichwertig');
  });

  it('zwischen den Schwellen wird über die Auffüllung NICHTS behauptet', () => {
    const mitte = (REFILL_LOW_PCT + REFILL_HIGH_PCT) / 2;
    const satz = ankerSatz(SONNIGER_SLOT, {
      whyTerminalAnchor: 'einspeisewert',
      whyRefillFreePct: mitte,
    }) as string;
    expect(satz).toContain('bemisst sich an der Einspeisung');
    expect(satz).not.toContain('kaum nach');
    expect(satz).not.toContain('ohnehin wieder');
    // ... und die Zahl selbst steht trotzdem in Lesehöhe (b).
    const rows = slotContextRows(SONNIGER_SLOT, [], { whyRefillFreePct: mitte });
    expect(rows.some((r) => r.label === 'Füllt sich von selbst nach')).toBe(true);
  });

  it('die Verkaufs-Formulierung folgt der Veräußerungsform', () => {
    const dv = margeSatz(SONNIGER_SLOT, 'direktvermarktung') as string;
    const ev = margeSatz(SONNIGER_SLOT, 'eigenverbrauch') as string;
    expect(dv).toContain('Jetzt zu verkaufen');
    expect(ev).toContain('Jetzt einzuspeisen');
  });
});

describe('Stufe 1: W5 beziffert den Abstand aus den GEZEIGTEN Zahlen', () => {
  const laden = ruht({
    slotRole: 'guenstig_laden',
    batteryKw: 5,
    storedValueCtKwh: 28.3,
    importPriceCtKwh: 15.8,
    importPriceSource: 'fest',
  });

  it('nennt die Differenz der zwei Zahlen im selben Satz', () => {
    const satz = slotWhy(laden, 'eigenverbrauch') as string;
    expect(satz).toContain('15,8 ct/kWh');
    expect(satz).toContain('12,5 ct/kWh weniger');
    expect(satz).toContain('28,3 ct/kWh');
  });

  it('unter der Anzeige-Genauigkeit entfällt der Abstand ersatzlos', () => {
    // 28,30 gegen 28,25: auf 0,1 ct gerundet dieselbe Zahl - „0,0 ct/kWh
    // weniger" wäre keine Auskunft, also wird gar keine gegeben.
    const satz = slotWhy(
      { ...laden, importPriceCtKwh: 28.25 },
      'eigenverbrauch',
    ) as string;
    expect(satz).toContain('weniger als der Wert gespeicherter Energie');
    expect(satz).not.toMatch(/0,0 ct\/kWh weniger/);
  });
});
