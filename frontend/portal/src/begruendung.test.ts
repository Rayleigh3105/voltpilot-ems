/**
 * DER WARUM-WÄCHTER (Konzept `data/vp-warum-erklaerbar-e2` §4.4 + §10 Stufe 0).
 *
 * Die EINE Echtheits-Regel, die er festnagelt:
 *
 * > Ein Satz, der eine URSACHE behauptet, muss an einem exportierten
 * > Entscheidungs-Fakt hängen, der genau diese Ursache trägt. Trägt kein Fakt
 * > sie, sagt die Fläche nur die Beobachtung.
 *
 * Der Anlass ist belegt: am 17.08.2026 stand über einem ruhenden Speicher
 * „Der Preisunterschied ist kleiner als Umwandlungsverluste und
 * Batterie-Verschleiß" — arithmetisch richtig, kausal falsch (die echte Ursache
 * war der Terminal-Wert-Gleichstand eines trüben Horizonts), und die
 * Untersuchung dieser plausiblen Unwahrheit kostete Stunden. Die Rolle `warten`
 * beschreibt das ERGEBNIS und hat strukturell MEHRERE Treiber; nur zwei davon
 * (voll, Reserve) sind heute als Fakt exportiert. Genau dort füllte die Vorlage
 * den Rest mit Plausibilität.
 *
 * WIE er prüft: nicht über einen Text-Scan der Quelle (der kann einen
 * Fallback-Zweig nicht von einem fakten-gebundenen unterscheiden), sondern
 * ÜBER DAS VERHALTEN — jede Ableitung wird mit einer FAKTEN-FREIEN Eingabe
 * aufgerufen (nur die Rolle, keine Bindungen, kein λ, keine Preise) und der
 * erzeugte Satz darf dann kein Kausal-Vokabular tragen. Dazu je kausalem Zweig
 * ein Negativ-Test: fehlen seine Gates, ist er unerreichbar.
 *
 * BEWUSST NICHT im Vokabular (und warum):
 * - „liegt über/unter dem Wert gespeicherter Energie" ohne Zahlen (Rolle
 *   `verkaufen`): die Rolle SELBST ist der exportierte Fakt, und der Solver
 *   vergibt sie genau dort, wo diese Ungleichung seine Optimalitätsbedingung
 *   ist. Die Aussage folgt also aus dem Fakt, statt ihn zu ersetzen.
 * - Die BEOBACHTUNGEN der „Lage"-Zeile (Preisbogen, erwartete kWh): sie
 *   berichten, was der Fahrplan gerechnet bzw. geplant HAT - sie behaupten
 *   keine Ursache. Kausal sind dort nur die zwei Speicher-Halbsätze, und die
 *   stehen unten in der Gate-Tabelle.
 * - „Einspeisen würde bei negativen Preisen Geld kosten" (Rolle `abregeln`):
 *   das IST eine Ein-Ursachen-Aussage über eine Mehr-Ursachen-Entscheidung
 *   (der Solver regelt auch an der Einspeisegrenze ab) — sie gehört zu W4 und
 *   damit ausdrücklich in Stufe 3 („Grenzen als Gründe"), nicht in Stufe 0.
 *   Wer sie dort verzweigt, nimmt sie hier ins Vokabular auf.
 */

import { describe, expect, it } from 'vitest';

import {
  BEGRUENDUNGEN,
  KNOWN_ROLES,
  ankerSatz,
  margeSatz,
  phaseWhy,
  slotContextRows,
  slotWhy,
  surplusWhy,
  technikRows,
  type PlanPhase,
  type SlotRole,
  type WhySlot,
} from './fahrplanWhy';
import { lageView, speicherHalbsatz, type LageSlot } from './fahrplanLage';
import { planInsightParts, planSentence, type PlanSlotLike } from './schedule';

/**
 * Kausal-Vokabular: Wörter, die eine URSACHE behaupten oder einen Vergleich
 * ziehen. In einem fakten-freien Satz ist jedes davon eine Erfindung.
 */
const KAUSAL: { re: RegExp; was: string }[] = [
  { re: /\bweil\b/i, was: 'weil' },
  { re: /\bdeshalb\b/i, was: 'deshalb' },
  { re: /\bdaher\b/i, was: 'daher' },
  { re: /\bdarum\b/i, was: 'darum' },
  { re: /lohn/i, was: 'lohnt/lohnen' },
  { re: /rentier/i, was: 'rentiert' },
  { re: /Preisunterschied/i, was: 'Preisunterschied' },
  { re: /kleiner als/i, was: 'kleiner als' },
  { re: /größer als/i, was: 'größer als' },
  { re: /zu (klein|gering|teuer|günstig|niedrig|hoch)\b/i, was: 'zu klein/teuer/…' },
  { re: /Nichtstun/i, was: 'Nichtstun' },
  { re: /wirtschaftlichste/i, was: 'wirtschaftlichste' },
];

function kausaleVokabeln(text: string): string[] {
  return KAUSAL.filter((k) => k.re.test(text)).map((k) => k.was);
}

/** Eine Viertelstunde OHNE jeden Entscheidungs-Fakt außer ihrer Rolle. */
function faktenfrei(role: SlotRole): WhySlot {
  return {
    start: '2026-08-17T20:45:00Z',
    batteryKw: null,
    priceEurMwh: null,
    costEur: null,
    baselineCostEur: null,
    slotRole: role,
    slotFlags: null,
    storedValueCtKwh: null,
    importPriceCtKwh: null,
    exportValueCtKwh: null,
    importPriceSource: null,
    // Erklärbarkeit Stufe 1: auch die neuen Treiber sind hier ABWESEND - der
    // Wächter prüft ja gerade, dass ohne sie nichts behauptet wird.
    whyNextBest: null,
    whyNextBestMarginCt: null,
  };
}

function phase(role: SlotRole): PlanPhase {
  return {
    role,
    startIdx: 0,
    endIdx: 0,
    slotCount: 1,
    from: '2026-08-17T20:45:00Z',
    to: '2026-08-17T21:00:00Z',
    eur: null,
    kind: 'idle',
    driver: null,
  };
}

const KINDS = ['eigenverbrauch', 'direktvermarktung'] as const;

describe('Warum-Wächter: ohne Fakt keine Ursache', () => {
  it('slotWhy behauptet für KEINE Rolle eine Ursache, wenn kein Fakt sie trägt', () => {
    for (const role of KNOWN_ROLES) {
      for (const kind of KINDS) {
        const satz = slotWhy(faktenfrei(role), kind);
        expect(satz, `${role}/${kind} liefert keinen Satz`).not.toBeNull();
        expect(
          kausaleVokabeln(satz as string),
          `slotWhy(${role}, ${kind}) behauptet ohne Fakt: "${satz}"`,
        ).toEqual([]);
      }
    }
  });

  it('phaseWhy behauptet für KEINE Rolle eine Ursache, wenn kein Fakt sie trägt', () => {
    for (const role of KNOWN_ROLES) {
      for (const kind of KINDS) {
        const satz = phaseWhy(phase(role), kind);
        expect(
          kausaleVokabeln(satz),
          `phaseWhy(${role}, ${kind}) behauptet ohne Fakt: "${satz}"`,
        ).toEqual([]);
      }
    }
  });

  it('surplusWhy erfindet ohne Fakt gar keinen Satz (Null-Degradation)', () => {
    // Der Slot exportiert (der Auslöser der Überschuss-Sätze), trägt aber
    // weder Bindung noch Werte: dann gibt es NICHTS zu sagen, und der Aufrufer
    // fällt auf den Basis-Grund zurück.
    const s: WhySlot = { ...faktenfrei('warten'), gridKw: -5 };
    for (const kind of KINDS) expect(surplusWhy(s, kind)).toBeNull();
  });

  it('die Tages-Sätze bleiben ohne aufgezeichneten Treiber beobachtend', () => {
    const idle: PlanSlotLike[] = [0, 1, 2, 3].map((i) => ({
      start: new Date(Date.UTC(2026, 7, 17, 12 + i)).toISOString(),
      batteryKw: 0,
      gridKw: 0,
      priceEurMwh: 200,
      slotRole: 'warten',
      slotFlags: null,
      storedValueCtKwh: null,
    }));
    const now = new Date(Date.UTC(2026, 7, 17, 13));
    const satz = planSentence(idle, 'eigenverbrauch', now);
    expect(kausaleVokabeln(satz ?? ''), `planSentence: "${satz}"`).toEqual([]);
    const parts = (planInsightParts(idle, now) ?? []).map((p) => p.text).join('');
    expect(kausaleVokabeln(parts), `planInsightParts: "${parts}"`).toEqual([]);
  });

  it('der 17.08.-Satz ist strukturell unerreichbar', () => {
    // Jede Eingabe-Kombination der Ruhe-Rolle, die es 2026-08-17 gab: mit und
    // ohne λ, mit und ohne Preise - nirgends darf der Preisunterschied-Satz
    // zurückkehren.
    const lagen: WhySlot[] = [
      faktenfrei('warten'),
      { ...faktenfrei('warten'), storedValueCtKwh: 23.5 },
      { ...faktenfrei('warten'), priceEurMwh: 219 },
      { ...faktenfrei('warten'), storedValueCtKwh: 23.5, priceEurMwh: 219 },
    ];
    for (const s of lagen) {
      for (const kind of KINDS) {
        expect(slotWhy(s, kind, undefined, lagen) ?? '').not.toMatch(/Preisunterschied/);
      }
    }
  });
});

describe('Warum-Wächter: der EINE kausale Ruhe-Zweig hängt an seinen Gates (W6)', () => {
  const lam = { ...faktenfrei('warten'), storedValueCtKwh: 23.5 };
  /** Das Fenster, dessen bester Börsenpreis 21,9 ct/kWh ist. */
  const fenster: WhySlot[] = [
    { ...faktenfrei('verkaufen'), priceEurMwh: 180 },
    { ...faktenfrei('verkaufen'), priceEurMwh: 219 },
  ];

  it('feuert mit BEIDEN Fakten und nennt beide Zahlen', () => {
    const satz = slotWhy(lam, 'direktvermarktung', undefined, fenster) as string;
    expect(satz).toContain('21,9 ct/kWh');
    expect(satz).toContain('23,5 ct/kWh');
    expect(satz).toContain('Verlustgeschäft');
    // Eigenverbrauch spricht nicht vom Verkauf.
    const ev = slotWhy(lam, 'eigenverbrauch', undefined, fenster) as string;
    expect(ev).toContain('Einspeisen');
    expect(ev).not.toContain('Verkaufen');
  });

  it('ist OHNE den Wert gespeicherter Energie unerreichbar', () => {
    const satz = slotWhy(faktenfrei('warten'), 'direktvermarktung', undefined, fenster) as string;
    expect(satz).not.toContain('Börsenpreis');
    expect(kausaleVokabeln(satz)).toEqual([]);
  });

  it('ist OHNE Preise im Fenster unerreichbar', () => {
    const satz = slotWhy(lam, 'direktvermarktung', undefined, []) as string;
    expect(satz).not.toContain('Börsenpreis');
    expect(kausaleVokabeln(satz)).toEqual([]);
  });

  it('behauptet bei GLEICHSTAND nichts (auf der angezeigten Genauigkeit)', () => {
    // 23,5 ct λ gegen 23,5 ct bester Preis: eine Ursache wäre erfunden.
    const gleich: WhySlot[] = [{ ...faktenfrei('verkaufen'), priceEurMwh: 235 }];
    const satz = slotWhy(lam, 'direktvermarktung', undefined, gleich) as string;
    expect(satz).not.toContain('Börsenpreis');
  });
});

/**
 * ERKLÄRBARKEIT STUFE 1: die neuen Zweige FÜTTERN den Wächter, sie umgehen ihn
 * nicht. Jeder von ihnen darf sprechen - aber nur, wenn die Fakten aus
 * {@link BEGRUENDUNGEN} wirklich vorliegen; fehlt eines, ist er unerreichbar
 * und die Fläche fällt auf die beobachtende Stufe-0-Fassung zurück.
 */
describe('Warum-Wächter: die Stufe-1-Zweige hängen an ihren Gates', () => {
  const KAUSALE_ZWEIGE = [
    'anker_bezugspreis',
    'gleichstand',
    'marge_klar',
    // Erklärbarkeit Stufe 2
    'lage_aufheben',
    'lage_auffuellung',
  ];

  it('die geprüften Zweige stehen in der Gate-Tabelle', () => {
    // Wer einen kausalen Zweig ergänzt, ohne ihn einzutragen, hat keinen
    // Negativ-Test - und genau das soll hier auffallen.
    for (const id of KAUSALE_ZWEIGE) {
      expect(BEGRUENDUNGEN.map((b) => b.id)).toContain(id);
    }
  });

  it('der Anker-Satz ist ohne Anker ODER ohne λ unerreichbar', () => {
    const mitLam = { ...faktenfrei('warten'), storedValueCtKwh: 23.5 };
    // Beide Gates: der Satz entsteht.
    expect(ankerSatz(mitLam, { whyTerminalAnchor: 'bezugspreis' })).not.toBeNull();
    // Je EINES fehlt: nichts.
    expect(ankerSatz(mitLam, { whyTerminalAnchor: null })).toBeNull();
    expect(ankerSatz(mitLam, null)).toBeNull();
    expect(ankerSatz(faktenfrei('warten'), { whyTerminalAnchor: 'bezugspreis' })).toBeNull();
  });

  it('der Margen-Satz ist ohne Name ODER ohne Marge unerreichbar', () => {
    const beides = {
      ...faktenfrei('warten'),
      whyNextBest: 'decken',
      whyNextBestMarginCt: 0,
    };
    expect(margeSatz(beides, 'eigenverbrauch')).not.toBeNull();
    expect(margeSatz({ ...beides, whyNextBestMarginCt: null }, 'eigenverbrauch')).toBeNull();
    expect(margeSatz({ ...beides, whyNextBest: null }, 'eigenverbrauch')).toBeNull();
  });

  it('die Auffüll-Aussage entsteht nur zu einer exportierten Quote', () => {
    const mitLam = { ...faktenfrei('warten'), storedValueCtKwh: 23.5 };
    const ohne = ankerSatz(mitLam, { whyTerminalAnchor: 'bezugspreis' }) as string;
    expect(ohne).not.toContain('kaum nach');
    expect(ohne).not.toContain('ohnehin wieder');
    const mit = ankerSatz(mitLam, {
      whyTerminalAnchor: 'bezugspreis',
      whyRefillFreePct: 0,
    }) as string;
    expect(mit).toContain('kaum nach');
  });

  it('Lesehöhen (b) und (c) erfinden ohne Fakten keine Zeile', () => {
    const nackt = faktenfrei('warten');
    // (b): ohne jeden Wert bleibt die Kontextliste leer.
    expect(slotContextRows(nackt, [], null)).toEqual([]);
    // (c): nur die ehrliche Aussage „keine Bindung erfasst" - kein λ, kein
    // Anker, keine Marge, keine erfundene 0.
    expect(technikRows(nackt, null)).toEqual([{ label: 'Bindungen', value: 'keine' }]);
  });
});

/**
 * ERKLÄRBARKEIT STUFE 2: die „Lage"-Zeile berichtet BEOBACHTUNGEN (Preisbogen,
 * erwartete kWh) und behauptet über den Speicher nur, was die Stufe-1-Lauf-
 * Fakten tragen. Ohne sie bleibt sie beobachtend - und ohne jede Aussage
 * entsteht sie gar nicht.
 */
describe('Warum-Wächter: die Lage-Zeile erfindet keine Ursache', () => {
  const NOW = new Date(2026, 7, 17, 20, 45);

  /** Ein voller Tag mit Preisbogen, aber OHNE jeden Lauf-Fakt. */
  function faktenfreierTag(): LageSlot[] {
    const out: LageSlot[] = [];
    for (let h = 0; h < 24; h++) {
      for (let q = 0; q < 4; q++) {
        const mittags = h >= 11 && h < 16;
        out.push({
          start: new Date(2026, 7, 17, h, q * 15).toISOString(),
          batteryKw: mittags ? 8 : -6,
          priceEurMwh: mittags ? 140 : 205,
        });
      }
    }
    return out;
  }

  it('sagt ohne Lauf-Fakten nur, was Preise und Plan zeigen', () => {
    const view = lageView({ slots: faktenfreierTag(), now: NOW });
    expect(view).not.toBeNull();
    const text = `${view?.bogen ?? ''} ${view?.ausblick ?? ''} ${view?.bedingung ?? ''}`;
    expect(kausaleVokabeln(text), `Lage-Zeile behauptet ohne Fakt: "${text}"`).toEqual([]);
    // Und über den Speicher wird gar nichts behauptet.
    expect(view?.ausblick ?? '').not.toContain('hebt seine Ladung');
    expect(view?.ausblick ?? '').not.toContain('ohnehin wieder');
  });

  it('der Aufhebe-Satz ist ohne Anker ODER ohne Auffüll-Quote unerreichbar', () => {
    expect(
      speicherHalbsatz({ whyTerminalAnchor: 'bezugspreis', whyRefillFreePct: 0 }),
    ).not.toBeNull();
    expect(speicherHalbsatz({ whyRefillFreePct: 0 })).toBeNull();
    expect(speicherHalbsatz({ whyTerminalAnchor: 'bezugspreis' })).toBeNull();
    expect(speicherHalbsatz(null)).toBeNull();
  });

  it('der Auffüll-Satz ist ohne exportierte Quote unerreichbar', () => {
    expect(speicherHalbsatz({ whyTerminalAnchor: 'einspeisewert' })).toBeNull();
    expect(
      speicherHalbsatz({ whyTerminalAnchor: 'einspeisewert', whyRefillFreePct: 62 }),
    ).toContain('ohnehin wieder auf');
  });

  it('ohne eine einzige belegte Aussage entsteht die Zeile gar nicht', () => {
    expect(lageView({ slots: [], now: NOW })).toBeNull();
  });
});
