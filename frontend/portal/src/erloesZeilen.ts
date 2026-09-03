/**
 * **Die neue Ergebnis-Karte, Ebene 0** — Hero, Kurzsatz, die vier Zeilen mit
 * dem Wasserfall IN der Zeile (Konzept `vp-erloese-seite-konzept-e2` §3.2 +
 * §3.8 + §3.12, Captain-Freigabe 02.09.2026 „bitte alle Empfehlung nehmen und
 * so bauen" → E4 = a, E10 = a).
 *
 * **Reine Ableitung, keine Fläche.** Sie bekommt die Antwort des
 * anlagen-scharfen Endpunkts und liefert genau das, was die Karte rendert —
 * damit dieselbe Zahl nie zwei Formulierungen bekommt und der Test die
 * Rechnung prüfen kann, ohne einen Browser zu starten.
 *
 * ⚠ **DAS VORZEICHEN KOMMT AUS DEM WERT, NIE AUS DER ROLLE** (Befund B1 des
 * Konzepts, §2.3). Die heutige Karte stempelt „+" auf jede Einspeise-Zeile,
 * weil Einspeisung eine Ertrags-ROLLE ist — an einem Negativpreis-Tag rendert
 * ein Erlös von −1,42 € damit als „+ 1,42 €". Hier entscheidet ausschließlich
 * das Vorzeichen des exakten Werts; die Kosten-Zeile dreht es EINMAL (der
 * Server liefert Kosten positiv), und eine negative Kosten-Zahl (eine
 * Gutschrift aus Negativpreis-Stunden) liest sich dadurch von selbst als „+".
 *
 * ⚠ **E4 = a: jede Zahl bleibt die korrekte Rundung IHRES EIGENEN Werts.**
 * Der Server rundet die exakte Summe (63,233 → 63,23), die drei Zeilen runden
 * je für sich (26,13 + 38,68 − 1,59 = 63,22). Beide Zahlen sind richtig; die
 * Lücke von einem Cent wird nicht wegretuschiert, sondern auf Ebene 1 mit der
 * EXAKTEN Addition erklärt (`rundungsluecke`, siehe `erloesEbenen.ts`). Der
 * Wasserfall zeichnet die EXAKTEN Werte — das Bild geht deshalb immer auf,
 * auch wenn die beschrifteten Cent-Beträge um einen Cent auseinanderliegen.
 */
import type { HistoryRange, SiteEarnings } from './api';
import { eurAmount, fmtNum } from './format';

/** Die vier Zeilen der Karte — der Ergebnis-Balken ist selbst eine davon. */
export type ErloesZeileId = 'einspeisung' | 'eigenverbrauch' | 'stromkosten' | 'ergebnis';

/** Der Ton EINER Zahl (nie eine Erfolgsfarbe — er folgt dem Vorzeichen). */
export type ZahlTon = 'plus' | 'minus' | 'null';

/**
 * Wohin ein Textlink der Sekundärzeile führt — ein SEMANTISCHES Ziel, nie eine
 * Adresse: die Ableitung kennt die Route der Seite nicht, und eine hier
 * erfundene URL wäre ein Knopf, der ins Leere führt. Die Fläche löst es auf
 * (`Kontoauszug.hrefFor`); ohne Auflösung bleibt der Link ruhiger Text — das
 * `SpeicherBlock.nachtragHref`-Muster.
 */
export type SekundaerZiel = 'tarif' | 'mastr';

/**
 * **Die Sekundärzeile einer Ledger-Zeile** (Konzept `vp-erloese-lesbar-konzept-u3`
 * §3.2 (4)): `345,4 kWh · Prämie 4,79 €` · `154,7 kWh` · `6,3 kWh`.
 *
 * ⚠ Sie ERSETZT den früheren Wert-Chip. Prinzip 5 (§2) lässt als Chip nur noch
 * ZUSTANDSWÖRTER zu (Zwischenstand · unter Null · vorläufig · Bewertet ·
 * Kein Abzug); Mengen, Preise und Wege sind Text, keine Kapsel — sonst
 * konkurrieren elf Kapseln mit der einen Zahl, die zählt (Befund B3).
 *
 * ⚠ Sie ist DATEN, kein JSX: nur so greift der Copy-Wächter (`copy.test.ts`)
 * auf die Wortlaute, und nur so sind die Sonderfälle ohne Browser prüfbar.
 */
export interface Sekundaerzeile {
  /** Die Teile OHNE Trenner — die Fläche setzt „ · " dazwischen. */
  teile: string[];
  /** Der Weg, wo etwas fehlt: „Stromtarif hinterlegen ›". */
  link: { text: string; ziel: SekundaerZiel } | null;
  /** `warn` nur, wo etwas FEHLT und der Kunde einen Weg braucht. */
  ton: 'normal' | 'warn';
  /** Der Titel-Text; null, wo die Zeile für sich spricht. */
  titel: string | null;
}

/** Eine Zeile der Ebene 0: Name · Sekundärzeile · Balken · Betrag. */
export interface ErloesZeile {
  id: ErloesZeileId;
  /** 1–3 Wörter (§3.12). */
  name: string;
  /** Der ANGEZEIGTE Betrag, gerundet und mit dem Vorzeichen des Werts. */
  eur: number | null;
  /** „+ 26,13 €" · „− 1,59 €" · „—". */
  text: string;
  ton: ZahlTon;
  /** Menge, Preisherkunft, fehlender Weg — nie ein Chip (§2 Prinzip 5). */
  sekundaer: Sekundaerzeile | null;
  /** Die Farb-Kennung der Zeile (CSS-Variable, Paare mit geprüftem Abstand). */
  farbe: string;
  /**
   * Das Segment des Wasserfalls in EUR — `von` ist die Zwischensumme VOR der
   * Zeile, `bis` die danach. `null`, wo die Zeile keinen Wert hat: ein Balken
   * über einer fehlenden Zahl wäre eine erfundene Aussage.
   */
  segment: { von: number; bis: number } | null;
}

/** Die gemeinsame Skala aller Balken — 0 liegt per Konstruktion darin. */
export interface WasserfallSkala {
  lo: number;
  hi: number;
}

/** Alles, was Ebene 0 rendert. */
export interface ErgebnisZeilenView {
  /** Die eine Zahl; `null`, solange nichts berechenbar ist. */
  hero: { eur: number; text: string; ton: 'ertrag' | 'kosten' } | null;
  /** EIN Satz von höchstens acht Wörtern (§3.12). */
  satz: string;
  zeilen: ErloesZeile[];
  skala: WasserfallSkala;
  /** Die EXAKTEN Summanden — Ebene 1 rechnet damit, nie mit den gerundeten. */
  exakt: {
    einspeisung: number | null;
    eigenverbrauch: number | null;
    /** Wie vom Server: Kosten POSITIV. */
    stromkosten: number | null;
    netto: number | null;
  };
  /** Hero − Σ der gerundeten Zeilen; ≠ 0 ⇒ Ebene 1 zeigt die exakte Addition. */
  rundungsluecke: number;
}

/** Die Farb-Kennung je Zeile (§3.9: Netz-Teal · Haus-Violett · Kosten-Rot · Aktion). */
/**
 * Die VIER Balkenfarben der Variante C (§3.10 (2)): Primary · Secondary ·
 * Destructive · Foreground.
 *
 * ⚠ Sie sind eine KENNUNG, kein Urteil — der Balken sagt „welche Zeile", das
 *   Vorzeichen sagt „gut oder schlecht" (E8). Deshalb tragen die zwei
 *   Ertragszeilen zwei Blautöne DERSELBEN Familie statt Türkis und Violett:
 *   die alten `--vp-flow-*` sind die Kanalfarben des Energieflusses und
 *   behaupteten hier eine Bedeutung, die es auf dieser Fläche nicht gibt.
 */
export const ZEILEN_FARBE: Record<ErloesZeileId, string> = {
  einspeisung: 'var(--vp-c-primary, #2563eb)',
  eigenverbrauch: 'var(--vp-c-secondary, #3b82f6)',
  stromkosten: 'var(--vp-c-destructive, #dc2626)',
  ergebnis: 'var(--vp-c-fg, #1e293b)',
};

/** 1–3 Wörter je Zeile — die langen Namen leben auf Ebene 1 (§3.12). */
export const ZEILEN_NAME: Record<ErloesZeileId, string> = {
  einspeisung: 'Einspeise-Erlös',
  eigenverbrauch: 'Eigenverbrauch',
  stromkosten: 'Netzbezug',
  ergebnis: 'Ergebnis',
};

/** Unter diesem Betrag rundet die Cent-Anzeige auf 0,00 € — dann ist der Ton neutral. */
const TOTBAND_EUR = 0.005;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Kaufmännisch runden — halb WEG von der Null, wie `toLocaleString` anzeigt.
 * `Math.round(-1.585 * 100) / 100` ergibt −1,58 und widerspräche damit dem
 * Text, den die Karte danebenschreibt.
 */
export function rundeKaufmaennisch(v: number, stellen: number): number {
  const f = 10 ** stellen;
  return (Math.sign(v) * Math.round(Math.abs(v) * f + 1e-9)) / f;
}

/** „+ 26,13 €" / „− 1,59 €" — das Vorzeichen ist ein eigenes Zeichen. */
export function vorzeichenEuro(v: number): string {
  return `${v < 0 ? '−' : '+'} ${eurAmount(Math.abs(v))}`;
}

function tonVon(v: number): ZahlTon {
  if (v >= TOTBAND_EUR) return 'plus';
  if (v <= -TOTBAND_EUR) return 'minus';
  return 'null';
}

/* ---------------------------------------------------------------------------
 * DIE SEKUNDÄRZEILEN (Konzept `vp-erloese-lesbar-konzept-u3` §3.2 (4))
 *
 * Sie tragen, was bis zur Runde 2 in Chips stand: Menge, Preisherkunft und —
 * wo etwas fehlt — den WEG dorthin. Wortlaute wörtlich aus §3.2 (4) und §3.4;
 * die Sonderfälle sind benannt, damit `erloesZeilen.test.ts` sie einzeln
 * festnageln kann.
 * ------------------------------------------------------------------------ */

/** `345,4 kWh · Prämie 4,79 €` — Menge und Zuschlag, nie ein Nebensatz. */
function einspeiseSekundaer(money: SiteEarnings): Sekundaerzeile {
  const kwh = num(money.eingespeistKwh);
  const menge = kwh == null ? [] : [fmtNum(kwh, 'kWh')];
  if (money.plantKind === 'direktvermarktung') {
    const praemie = num(money.marktpraemieEur);
    if (praemie != null && praemie >= TOTBAND_EUR) {
      return {
        teile: [...menge, `Prämie ${eurAmount(praemie)}`],
        link: null,
        ton: 'normal',
        titel:
          'Der Zuschlag je eingespeister Kilowattstunde, wenn der Monatsmarktwert unter Ihrem anzulegenden Wert liegt.',
      };
    }
    // ⚠ „Prämie ruht" ist eine ehrliche TATSACHE, kein Mangel — deshalb der
    //   normale Ton und kein Weg: es gibt nichts zu hinterlegen.
    return {
      teile: [...menge, 'Prämie ruht'],
      link: null,
      ton: 'normal',
      titel: 'In Viertelstunden mit negativem Börsenpreis fällt keine Marktprämie an.',
    };
  }
  if (money.exportVerguetungPriced) {
    return {
      teile: [...menge, 'feste Vergütung'],
      link: null,
      ton: 'normal',
      titel: 'Bewertet mit Ihrer gesetzlichen Einspeisevergütung.',
    };
  }
  return {
    teile: ['Börsenpreis', 'Vergütung nicht hinterlegt'],
    link: { text: 'Anlage verknüpfen ›', ziel: 'mastr' },
    ton: 'warn',
    titel: 'Ohne Verknüpfung im Marktstammdatenregister rechnen wir mit dem Börsenpreis.',
  };
}

/** `154,7 kWh` — oder der Weg zum fehlenden Tarif. */
function eigenSekundaer(money: SiteEarnings): Sekundaerzeile {
  if (num(money.eigenverbrauchsWertEur) == null) {
    return {
      teile: ['kein Stromtarif hinterlegt'],
      link: { text: 'Stromtarif hinterlegen ›', ziel: 'tarif' },
      ton: 'warn',
      titel: 'Ohne hinterlegten Stromtarif lässt sich der Wert des Eigenverbrauchs nicht beziffern.',
    };
  }
  const kwh = num(money.selbstverbrauchKwh);
  return {
    teile: [kwh == null ? 'selbst genutzt' : fmtNum(kwh, 'kWh')],
    link: null,
    ton: 'normal',
    titel: 'Strom, den Ihre Anlage selbst verbraucht hat, statt ihn zu kaufen.',
  };
}

/** `6,3 kWh` (· `Standard-Satz`, wo kein Tarif hinterlegt ist). */
function kostenSekundaer(money: SiteEarnings): Sekundaerzeile {
  const kwh = num(money.bezogenKwh);
  const menge = kwh == null ? [] : [fmtNum(kwh, 'kWh')];
  if (money.tarifArt === 'fest' || money.tarifArt === 'dynamisch') {
    return {
      teile: menge.length > 0 ? menge : ['Ihr Stromtarif'],
      link: null,
      ton: 'normal',
      titel: 'Aus dem Netz bezogener Strom, bewertet mit Ihrem Stromtarif.',
    };
  }
  if (money.tarifPriced) {
    return {
      teile: [...menge, 'Standard-Satz'],
      link: null,
      ton: 'normal',
      titel:
        'Ohne hinterlegten Tarif rechnen wir mit dem Börsenpreis plus üblichen Netzentgelten, Abgaben und Umsatzsteuer.',
    };
  }
  return {
    teile: [...menge, 'Börsenpreis'],
    link: null,
    ton: 'normal',
    titel: 'Bewertet mit dem Börsenpreis der jeweiligen Viertelstunde.',
  };
}

export function sekundaerFuer(money: SiteEarnings, id: ErloesZeileId): Sekundaerzeile | null {
  if (id === 'einspeisung') return einspeiseSekundaer(money);
  if (id === 'eigenverbrauch') return eigenSekundaer(money);
  if (id === 'stromkosten') return kostenSekundaer(money);
  return null;
}

export interface ErgebnisZeilenInput {
  /** Die Antwort des Endpunkts; `null` = noch nicht geladen. */
  money: SiteEarnings | null;
  /** Der Name des Zeitraums („Mi., 02.09.2026") — die Zeit-Leiste regiert. */
  periodLabel: string;
  /** Läuft der Zeitraum noch? Nur dann steht „bisher" (Befund B4). */
  laeuft: boolean;
  range: HistoryRange;
}

/**
 * Der Kurzsatz unter der Zahl — höchstens acht Wörter, kein Nebensatz.
 *
 * Er wiederholt die Zahl NICHT (der alte Satz „So viel hat Ihre Anlage unterm
 * Strich eingebracht" sagte nichts, was die Zahl darüber nicht schon sagte);
 * er sagt nur, WELCHER Zeitraum gemeint ist und ob er noch läuft.
 */
export function heroSatz(
  hero: number | null,
  label: string,
  laeuft: boolean,
  range: HistoryRange,
): string {
  if (hero == null) return `Für ${label} lässt sich noch kein Ergebnis berechnen.`;
  if (hero < 0) {
    return laeuft ? 'Bisher mehr Stromkosten als Ertrag.' : `${label}: mehr Stromkosten als Ertrag.`;
  }
  if (range === 'day') return laeuft ? 'Heute bisher unterm Strich.' : `${label} unterm Strich.`;
  return laeuft ? `${label} bisher unterm Strich.` : `${label} unterm Strich.`;
}

/**
 * Ebene 0 der Ergebnis-Karte.
 *
 * Die Zwischensumme wandert von Zeile zu Zeile (Einspeisung → +
 * Eigenverbrauch → − Netzbezug), der letzte Balken ist die Hero-Zahl. Eine
 * Zeile ohne Wert lässt die Zwischensumme unverändert und bekommt KEIN
 * Segment — der Wasserfall behauptet dann nichts, wo nichts gemessen wurde.
 */
export function ergebnisZeilen(input: ErgebnisZeilenInput): ErgebnisZeilenView {
  const money = input.money;
  return zeilenKern({
    einspeisung: money?.einspeiseErloesEur ?? null,
    eigenverbrauch: money?.eigenverbrauchsWertEur ?? null,
    stromkosten: money?.stromkostenEur ?? null,
    netto: money?.nettoErgebnisEur ?? null,
    periodLabel: input.periodLabel,
    laeuft: input.laeuft,
    range: input.range,
    sekundaer: money ? (id) => sekundaerFuer(money, id) : null,
  });
}

/**
 * **Dieselben vier Zeilen für die FLOTTE** (Portfolio › Erlöse, Paket P6 ·
 * Entscheid E2 = „beide": die Leseprinzipien gelten auch eine Ebene höher).
 *
 * Die Zahlen sind die Summen des Portfolio-Aggregats — dieselben vier Größen,
 * derselbe Wasserfall, dieselben Worte. Sie hier durch `ergebnisZeilen` zu
 * schicken ginge nicht: das nimmt eine `SiteEarnings`, und ein zusammengebautes
 * Fantasie-Objekt wäre eine zweite Wahrheit über eine Antwort, die es nicht
 * gibt.
 *
 * **⚠ Die Sekundärzeile bleibt hier LEER, und das ist eine Aussage** (kein
 * Versäumnis): sie nennt auf der Anlagen-Seite den Tarif bzw. die
 * MaStR-Referenz — beides gibt es je Anlage, nicht je Flotte. Das Portfolio ist
 * bewusst tarifneutral (siehe `SteuerungFormel` `tarifneutral`), also
 * behauptet es keinen.
 */
export function flottenZeilen(input: {
  einspeiseEur: number | null | undefined;
  eigenverbrauchEur: number | null | undefined;
  stromkostenEur: number | null | undefined;
  nettoEur: number | null | undefined;
  periodLabel: string;
  laeuft: boolean;
  range: HistoryRange;
}): ErgebnisZeilenView {
  return zeilenKern({
    einspeisung: input.einspeiseEur ?? null,
    eigenverbrauch: input.eigenverbrauchEur ?? null,
    stromkosten: input.stromkostenEur ?? null,
    netto: input.nettoEur ?? null,
    periodLabel: input.periodLabel,
    laeuft: input.laeuft,
    range: input.range,
    sekundaer: null,
  });
}

/** Der geteilte Kern beider Eingänge — die Zahlen, nie die Herkunft. */
function zeilenKern(input: {
  einspeisung: number | null;
  eigenverbrauch: number | null;
  stromkosten: number | null;
  netto: number | null;
  periodLabel: string;
  laeuft: boolean;
  range: HistoryRange;
  sekundaer: ((id: ErloesZeileId) => Sekundaerzeile | null) | null;
}): ErgebnisZeilenView {
  const einspeisung = num(input.einspeisung);
  const eigen = num(input.eigenverbrauch);
  const kosten = num(input.stromkosten);
  const netto = num(input.netto);

  // Die drei Beiträge in der Reihenfolge des Wasserfalls; der Netzbezug geht
  // mit GEDREHTEM Vorzeichen ein, weil der Server Kosten positiv liefert.
  const beitrag: Array<[ErloesZeileId, number | null]> = [
    ['einspeisung', einspeisung],
    ['eigenverbrauch', eigen],
    ['stromkosten', kosten == null ? null : -kosten],
  ];

  let lauf = 0;
  const segmente = new Map<ErloesZeileId, { von: number; bis: number } | null>();
  for (const [id, v] of beitrag) {
    if (v == null) {
      segmente.set(id, null);
      continue;
    }
    segmente.set(id, { von: lauf, bis: lauf + v });
    lauf += v;
  }
  segmente.set('ergebnis', netto == null ? null : { von: 0, bis: netto });

  const punkte = [0];
  for (const s of segmente.values()) if (s) punkte.push(s.von, s.bis);
  if (netto != null) punkte.push(netto);
  const lo = Math.min(...punkte);
  let hi = Math.max(...punkte);
  if (hi - lo < 1e-9) hi = lo + 1;

  const zeilen: ErloesZeile[] = [];
  for (const [id, v] of beitrag) {
    const gerundet = v == null ? null : rundeKaufmaennisch(v, 2);
    zeilen.push({
      id,
      name: ZEILEN_NAME[id],
      eur: gerundet,
      text: gerundet == null ? '—' : vorzeichenEuro(gerundet),
      ton: gerundet == null ? 'null' : tonVon(gerundet),
      sekundaer: input.sekundaer ? input.sekundaer(id) : null,
      farbe: ZEILEN_FARBE[id],
      segment: segmente.get(id) ?? null,
    });
  }
  const heroGerundet = netto == null ? null : rundeKaufmaennisch(netto, 2);
  zeilen.push({
    id: 'ergebnis',
    name: ZEILEN_NAME.ergebnis,
    eur: heroGerundet,
    text: heroGerundet == null ? '—' : vorzeichenEuro(heroGerundet),
    ton: heroGerundet == null ? 'null' : tonVon(heroGerundet),
    sekundaer: null,
    farbe: ZEILEN_FARBE.ergebnis,
    segment: segmente.get('ergebnis') ?? null,
  });

  const summeGerundet = rundeKaufmaennisch(
    zeilen.filter((z) => z.id !== 'ergebnis').reduce((a, z) => a + (z.eur ?? 0), 0),
    2,
  );

  return {
    hero:
      heroGerundet == null
        ? null
        : {
            eur: heroGerundet,
            text: vorzeichenEuro(heroGerundet),
            ton: heroGerundet < 0 ? 'kosten' : 'ertrag',
          },
    satz: heroSatz(heroGerundet, input.periodLabel, input.laeuft, input.range),
    zeilen,
    skala: { lo, hi },
    exakt: { einspeisung, eigenverbrauch: eigen, stromkosten: kosten, netto },
    rundungsluecke: heroGerundet == null ? 0 : rundeKaufmaennisch(heroGerundet - summeGerundet, 2),
  };
}

/* ---------------------------------------------------------------------------
 * Die GEOMETRIE des Wasserfalls — rein, damit sie ohne Browser prüfbar ist.
 *
 * Sie rechnet in einem festen Koordinatenraum (`BALKEN_BREITE` × `BALKEN_HOEHE`);
 * die Fläche skaliert das SVG per `preserveAspectRatio="none"` auf ihre echte
 * Breite. Dadurch braucht der Balken KEINE Messung im Browser — genau die
 * Fallen (Resize-Beobachter, Canvas-Text, „Headless misst Schriften breiter"),
 * wegen derer E10 gegen ECharts entschieden hat.
 * ------------------------------------------------------------------------- */

/** Der Koordinatenraum des Balkens (nicht seine Pixel — die kommen aus dem CSS). */
export const BALKEN_BREITE = 1000;
export const BALKEN_HOEHE = 8;

/** Damit ein winziger Beitrag nicht unsichtbar wird, bekommt er eine Mindestbreite. */
const BALKEN_MIN = 2;

export interface BalkenGeometrie {
  id: ErloesZeileId;
  /** Die Nulllinie im Koordinatenraum — in jedem Balken an derselben Stelle. */
  nullX: number;
  /** Der Balken selbst; `null`, wo die Zeile keinen Wert hat. */
  balken: { x: number; breite: number } | null;
}

/** Die Balken aller vier Zeilen auf EINER Skala. */
export function balkenGeometrie(view: ErgebnisZeilenView): BalkenGeometrie[] {
  const { lo, hi } = view.skala;
  const spanne = hi - lo;
  const x = (v: number) => ((v - lo) / spanne) * BALKEN_BREITE;
  const runde = (v: number) => Math.round(v * 100) / 100;
  const nullX = runde(x(0));
  return view.zeilen.map((z) => {
    if (!z.segment) return { id: z.id, nullX, balken: null };
    const a = x(z.segment.von);
    const b = x(z.segment.bis);
    const links = Math.min(a, b);
    return {
      id: z.id,
      nullX,
      balken: { x: runde(links), breite: runde(Math.max(BALKEN_MIN, Math.abs(b - a))) },
    };
  });
}
