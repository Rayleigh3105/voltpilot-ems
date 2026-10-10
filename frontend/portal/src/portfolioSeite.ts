/**
 * Die ABLEITUNGEN der zwei Portfolio-Seiten „Energie" und „Erlöse" im Rahmen
 * der Anlagen-Seiten (Konzept „Verlauf-Rework", Portfolio-Paket): Kennzahlen
 * über alle Anlagen, der Anlagen-Vergleich als Balkenliste und sein
 * Tabellen-Zwilling samt CSV.
 *
 * Regeln, die hier gelten (dieselben wie eine Ebene tiefer):
 * - **Nichts wird neu gerechnet.** Summen kommen aus `portfolioHistorie`
 *   (Energie über `energieSummen`, Geld aus dem mandantenweiten Endpunkt);
 *   Beträge und Mengen formatieren `erloeseSeite`/`energieSeite`.
 * - **Fehlend ist keine Null.** Eine Anlage ohne Werte steht mit ihrem Grund
 *   in der Liste und fließt nicht als 0 in eine Summe.
 * - **Quoten nur je Anlage** — nie ein Mittel über verschieden große Anlagen.
 * - **Ein laufender Zeitraum wird ehrlich verglichen** — dieselbe Ableitung
 *   wie auf der Anlage (`energieKennzahlen`, `vergleichUnter`).
 *
 * Rein und framework-frei.
 */
import type { History, HistoryRange } from './api';
import { energieSummen, type EnergieSummeKey } from './energieBilanz';
import { energieQuoten } from './energieSeite';
import { betrag, geldTon, mengeText, vergleichUnter, type GeldErklaerung } from './erloeseSeite';
import { erloesBegriff } from './erloesEbenen';
import { LEER_TEXT_FALLBACK } from './erloesKomposition';
import type { ErloeseAggregat, PortfolioHistoryInput } from './portfolioHistorie';
import { MESSLATTE_DATIV, MESSLATTE_KURZ, type SpeicherAussage } from './speicherAussage';
import type { TabellenZeile } from './components/VerlaufRahmen';
import type { ErloesVergleich } from './vergleichLaufend';

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function anlagenWort(n: number): string {
  return n === 1 ? 'Anlage' : 'Anlagen';
}

// ---------------------------------------------------------------------------
// Energie
// ---------------------------------------------------------------------------

/**
 * Die Historien aller Anlagen als EINE Antwort: die Eimer hintereinander.
 * Summen über Eimer sind damit per Konstruktion Summen über Anlagen, und der
 * ehrliche Vergleich „bis zur gleichen Stunde" der Anlagen-Seite
 * (`energieKennzahlen`) gilt unverändert. `null`, solange keine Anlage
 * geantwortet hat.
 */
export function verbundHistory(inputs: readonly PortfolioHistoryInput[]): History | null {
  const da = inputs.map((i) => i.history).filter((h): h is History => h != null);
  if (da.length === 0) return null;
  return {
    ...da[0],
    buckets: da.flatMap((h) => h.buckets),
    events: [],
    protocol: [],
    plan: [],
  };
}

/** Eine Zeile der Anlagen-Liste (Balken) — für beide Seiten dieselbe Form. */
export interface AnlagenBalken {
  id: string;
  name: string;
  /** Der Hauptwert der Zeile („14,8 kWh" · „+ 3,82 €"); „—" ohne Wert. */
  wert: string;
  ton: 'minus' | 'leer' | null;
  /** Balkenlänge 0..100 relativ zur größten Anlage; null ohne Wert. */
  anteilPct: number | null;
  /** Die zweite Zeile („Verbrauch 13,0 kWh · 82 % selbst versorgt"). */
  unter: string | null;
  /** Der Grund, wenn die Anlage keine Werte hat. */
  hinweis: string | null;
}

function anteile(werte: readonly (number | null)[]): (number | null)[] {
  const max = Math.max(0, ...werte.map((w) => (w == null ? 0 : Math.abs(w))));
  return werte.map((w) => (w == null ? null : max > 0 ? (Math.abs(w) / max) * 100 : 0));
}

const HINWEIS_ENERGIE = {
  fehler: 'Konnte nicht geladen werden',
  leer: 'Keine Messwerte in diesem Zeitraum',
} as const;

function kwhVon(h: History | null, key: EnergieSummeKey): number | null {
  if (!h) return null;
  return energieSummen(h.buckets).find((s) => s.key === key)?.kwh ?? null;
}

/**
 * Die Anlagen-Liste der Energie-Seite: Erzeugung als Balken, darunter der
 * Verbrauch und — je Anlage, nie gemittelt — wie viel davon sie selbst
 * gedeckt hat. Sortiert nach Erzeugung; Anlagen ohne Werte am Ende.
 */
export function energieAnlagen(inputs: readonly PortfolioHistoryInput[]): AnlagenBalken[] {
  const roh = inputs.map((i) => {
    const erzeugt = kwhVon(i.history, 'erzeugt');
    const verbraucht = kwhVon(i.history, 'verbraucht');
    const hat = i.history != null && energieSummen(i.history.buckets).some((s) => s.kwh != null);
    const aut = i.history && hat ? energieQuoten(i.history)[0] : null;
    const teile = [
      verbraucht == null ? null : `Verbrauch ${mengeText(verbraucht)}`,
      // AP-10 E16 Nr. 5: eine Quote außerhalb 0…100 % ist keine Selbstversorgung — sie steht mit dem Satz des
      // Bilanz-Vertrags („Messwerte passen nicht zusammen (−20 %)“), wie auf der Energie-Seite.
      aut?.pct == null ? null : aut.unplausibel ? aut.info : `${aut.wert} selbst versorgt`,
    ].filter((t): t is string => t != null);
    return {
      id: i.siteId,
      name: i.name,
      erzeugt: hat ? erzeugt : null,
      unter: hat && teile.length ? teile.join(' · ') : null,
      hinweis: i.fehler ? HINWEIS_ENERGIE.fehler : hat ? null : HINWEIS_ENERGIE.leer,
    };
  });
  const pct = anteile(roh.map((r) => r.erzeugt));
  return roh
    .map((r, i) => ({
      id: r.id,
      name: r.name,
      wert: mengeText(r.erzeugt) ?? '—',
      ton: r.erzeugt == null ? ('leer' as const) : null,
      anteilPct: pct[i],
      unter: r.unter,
      hinweis: r.hinweis,
      sort: r.erzeugt,
    }))
    .sort((a, b) => {
      if ((a.sort == null) !== (b.sort == null)) return a.sort == null ? 1 : -1;
      if (a.sort != null && b.sort != null && a.sort !== b.sort) return b.sort - a.sort;
      return a.name.localeCompare(b.name, 'de');
    })
    .map(({ sort: _s, ...z }) => z);
}

/** Die Spalten des Energie-Tabellen-Zwillings (erste = Anlage). */
export const ENERGIE_ANLAGEN_SPALTEN = [
  'Anlage',
  'Erzeugung',
  'Verbrauch',
  'Netzbezug',
  'Einspeisung',
  'Speicher geladen',
  'Speicher entladen',
] as const;

const ENERGIE_KEYS: readonly EnergieSummeKey[] = [
  'erzeugt',
  'verbraucht',
  'bezogen',
  'eingespeist',
  'geladen',
  'entladen',
];

/** Der Tabellen-Zwilling der Energie-Liste — Summe über die Anlagen mit Werten. */
export function energieAnlagenTabelle(inputs: readonly PortfolioHistoryInput[]): {
  zeilen: TabellenZeile[];
  summe: TabellenZeile | null;
} {
  const summen = ENERGIE_KEYS.map(() => ({ s: 0, n: 0 }));
  const zeilen: TabellenZeile[] = inputs.map((i) => {
    const werte = ENERGIE_KEYS.map((k) => kwhVon(i.history, k));
    if (i.fehler || werte.every((w) => w == null)) {
      return {
        id: i.siteId,
        kopf: i.name,
        zellen: null,
        leer: i.fehler ? 'konnte nicht geladen werden' : 'keine Messwerte',
      };
    }
    werte.forEach((w, k) => {
      if (w == null) return;
      summen[k].s += w;
      summen[k].n += 1;
    });
    return { id: i.siteId, kopf: i.name, zellen: werte.map((w) => ({ text: mengeText(w) ?? '—' })) };
  });
  const hatSumme = summen.some((x) => x.n > 0);
  return {
    zeilen,
    summe: hatSumme
      ? {
          id: 'summe',
          kopf: 'Summe',
          zellen: summen.map((x) => ({ text: x.n > 0 ? (mengeText(x.s) ?? '—') : '—' })),
        }
      : null,
  };
}

function csvZahl(v: number | null): string {
  return v == null ? '' : v.toFixed(3).replace('.', ',');
}

function csvText(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

/** CSV der Energie-Tabelle: eine Zeile je Anlage, Lücken bleiben leer. */
export function energieAnlagenCsv(inputs: readonly PortfolioHistoryInput[]): string {
  const kopf = ENERGIE_ANLAGEN_SPALTEN.map((s, i) => (i === 0 ? s : `${s} kWh`)).join(';');
  const zeilen = inputs.map((i) =>
    [csvText(i.name), ...ENERGIE_KEYS.map((k) => csvZahl(kwhVon(i.history, k)))].join(';'),
  );
  return [kopf, ...zeilen].join('\r\n');
}

// ---------------------------------------------------------------------------
// Erlöse
// ---------------------------------------------------------------------------

export type PortfolioGeldId = 'ergebnis' | 'eigenverbrauch' | 'einspeisung' | 'netzbezug';

export interface PortfolioGeldKennzahl {
  id: PortfolioGeldId;
  label: string;
  wert: string;
  ton: 'minus' | 'leer' | null;
  unter: string | null;
  pfeil: '↑' | '↓' | null;
  info: GeldErklaerung;
}

/**
 * Die Kennzahlen der Portfolio-Erlöse: Ergebnis zuerst (mit dem ehrlichen
 * Vergleich der Anlagen-Seite), dann die drei Posten, aus denen es entsteht.
 */
export function portfolioGeldKennzahlen(input: {
  aggregat: ErloeseAggregat;
  vergleich: ErloesVergleich | null;
  vergleichVoll: string | null;
}): PortfolioGeldKennzahl[] {
  const { aggregat: a } = input;
  const v = a.nettoEur == null ? null : vergleichUnter(input.vergleich, input.vergleichVoll);
  const mit = a.zeilen.filter((z) => z.zustand === 'daten').length;
  const kosten = num(a.stromkostenEur);
  return [
    {
      id: 'ergebnis',
      label: 'Ergebnis',
      wert: betrag(a.nettoEur),
      ton: geldTon(a.nettoEur),
      unter: a.nettoEur == null ? LEER_TEXT_FALLBACK : (v?.text ?? null),
      pfeil: v?.pfeil ?? null,
      info: {
        titel: 'Ergebnis',
        text: [
          erloesBegriff('ergebnis').erklaerung,
          `Summe über ${mit} ${anlagenWort(mit)} mit bewerteten Werten.`,
          input.vergleich?.satz ?? null,
        ]
          .filter(Boolean)
          .join(' '),
      },
    },
    {
      id: 'eigenverbrauch',
      label: 'Eigenverbrauch',
      wert: betrag(a.eigenverbrauchEur),
      ton: geldTon(a.eigenverbrauchEur),
      unter: mengeText(a.selbstverbrauchKwh),
      pfeil: null,
      info: { titel: 'Eigenverbrauch', text: erloesBegriff('eigenverbrauch').erklaerung },
    },
    {
      id: 'einspeisung',
      label: 'Einspeisung',
      wert: betrag(a.einspeiseEur),
      ton: geldTon(a.einspeiseEur),
      unter: mengeText(a.eingespeistKwh),
      pfeil: null,
      info: {
        titel: 'Einspeisung',
        text: 'Je Anlage bewertet mit ihrer Vergütung bzw. dem Börsenpreis, wo keine hinterlegt ist.',
      },
    },
    {
      id: 'netzbezug',
      label: 'Netzbezug',
      wert: betrag(kosten == null ? null : -kosten),
      ton: kosten == null ? 'leer' : geldTon(-kosten),
      unter: null,
      pfeil: null,
      info: { titel: 'Netzbezug', text: erloesBegriff('netzbezug').erklaerung },
    },
  ];
}

/** Die Kachel „VoltPilot-Steuerung" des Portfolios. */
export interface PortfolioSteuerung {
  label: string;
  titel: string;
  wert: string;
  ton: 'ok' | 'neutral' | 'warn' | 'leer';
  unter: string;
  info: string[];
}

/**
 * Die Kachel „VoltPilot-Steuerung" über alle Anlagen — dieselbe Lesart wie
 * auf der Anlage („+ 1,45 € · mehr als ohne smarte Steuerung"). Tragen nicht
 * alle Anlagen zur Summe bei (fehlende Speicherdaten), sagt die Unterzeile
 * über wie viele sie spricht — nie still eine Teilsumme als Ganzes.
 */
export function portfolioSteuerung(
  speicher: SpeicherAussage | null,
  aggregat: ErloeseAggregat,
): PortfolioSteuerung | null {
  const s = speicher?.steuerung;
  if (!speicher || !s) return null;
  const mit = aggregat.zeilen.filter((z) => z.zustand === 'daten').length;
  const richtung =
    s.ton === 'plus'
      ? `mehr als ${MESSLATTE_KURZ}`
      : s.ton === 'minus'
        ? `weniger als ${MESSLATTE_KURZ}`
        : `wie ${MESSLATTE_KURZ}`;
  const teil =
    aggregat.steuerungAnlagen < mit
      ? ` · ${aggregat.steuerungAnlagen} von ${mit} ${anlagenWort(mit)}`
      : '';
  return {
    label: 'VoltPilot-Steuerung',
    titel: 'Mehrwert durch VoltPilot',
    wert: s.wort,
    ton: speicher.anzeigeTon,
    unter: `${speicher.zwischenstand ? 'bisher ' : ''}${richtung}${teil}`,
    info: [
      `Verglichen wird je Anlage mit ${MESSLATTE_DATIV}: Er lädt jeden Überschuss sofort und entlädt sofort — ohne Blick auf Preise. Nicht im Ergebnis enthalten.`,
      aggregat.steuerungAnlagen < mit
        ? `Die Summe umfasst die ${aggregat.steuerungAnlagen} ${anlagenWort(aggregat.steuerungAnlagen)} mit gepflegten Speicherdaten; für die übrigen ist kein Vergleich möglich.`
        : '',
      'Den Betrag je Anlage zeigt die Tabelle.',
    ].filter(Boolean),
  };
}

/**
 * Die Anlagen-Liste der Erlöse-Seite: das Ergebnis je Anlage als Balken,
 * darunter der Mehrwert durch VoltPilot. Die Reihenfolge kommt aus dem
 * Aggregat (größtes Ergebnis zuerst, Anlagen ohne Ergebnis am Ende).
 */
export function erloeseAnlagen(aggregat: ErloeseAggregat): AnlagenBalken[] {
  const pct = anteile(aggregat.zeilen.map((z) => z.nettoEur));
  return aggregat.zeilen.map((z, i) => ({
    id: z.siteId,
    name: z.name,
    wert: betrag(z.nettoEur),
    ton: geldTon(z.nettoEur),
    anteilPct: pct[i],
    unter:
      z.zustand === 'daten' && z.steuerungEur != null
        ? `VoltPilot-Steuerung ${betrag(z.steuerungEur)}`
        : null,
    hinweis: z.hinweis ? z.hinweis.replace(/\.$/, '') : null,
  }));
}

/** Die Spalten des Erlöse-Tabellen-Zwillings (erste = Anlage). */
export const ERLOESE_ANLAGEN_SPALTEN = [
  'Anlage',
  'Ergebnis',
  'Eigenverbrauch',
  'Einspeisung',
  'Netzbezug',
  'VoltPilot-Steuerung',
] as const;

function geldZelle(v: number | null) {
  return { text: betrag(v), ton: geldTon(v) === 'minus' ? ('minus' as const) : null };
}

/** Der Tabellen-Zwilling der Erlöse-Liste — die Summe ist die der Kennzahlen. */
export function erloeseAnlagenTabelle(aggregat: ErloeseAggregat): {
  zeilen: TabellenZeile[];
  summe: TabellenZeile | null;
} {
  const zeilen: TabellenZeile[] = aggregat.zeilen.map((z) =>
    z.zustand !== 'daten'
      ? { id: z.siteId, kopf: z.name, zellen: null, leer: (z.hinweis ?? 'keine Werte').replace(/\.$/, '') }
      : {
          id: z.siteId,
          kopf: z.name,
          zellen: [
            geldZelle(z.nettoEur),
            geldZelle(z.eigenverbrauchEur),
            geldZelle(z.einspeiseEur),
            geldZelle(z.stromkostenEur == null ? null : -z.stromkostenEur),
            geldZelle(z.steuerungEur),
          ],
        },
  );
  const k = num(aggregat.stromkostenEur);
  return {
    zeilen,
    summe:
      aggregat.nettoEur == null
        ? null
        : {
            id: 'summe',
            kopf: 'Summe',
            zellen: [
              geldZelle(aggregat.nettoEur),
              geldZelle(aggregat.eigenverbrauchEur),
              geldZelle(aggregat.einspeiseEur),
              geldZelle(k == null ? null : -k),
              geldZelle(aggregat.steuerungEur),
            ],
          },
  };
}

/** CSV der Erlöse-Tabelle: Beträge in €, Anlagen ohne Ergebnis mit leeren Feldern. */
export function erloeseAnlagenCsv(aggregat: ErloeseAggregat): string {
  const eur = (v: number | null) => (v == null ? '' : v.toFixed(2).replace('.', ','));
  const kopf = ERLOESE_ANLAGEN_SPALTEN.map((s, i) => (i === 0 ? s : `${s} €`)).join(';');
  const zeilen = aggregat.zeilen.map((z) =>
    z.zustand !== 'daten'
      ? [csvText(z.name), '', '', '', '', ''].join(';')
      : [
          csvText(z.name),
          eur(z.nettoEur),
          eur(z.eigenverbrauchEur),
          eur(z.einspeiseEur),
          eur(z.stromkostenEur == null ? null : -z.stromkostenEur),
          eur(z.steuerungEur),
        ].join(';'),
  );
  return [kopf, ...zeilen].join('\r\n');
}

/** „erloese_alle-anlagen_monat_2026-08-15.csv" — nur ASCII. */
export function portfolioCsvName(art: 'energie' | 'erloese', range: HistoryRange, at: string): string {
  const wort = { day: 'tag', week: 'woche', month: 'monat', year: 'jahr' }[range];
  return `${art}_alle-anlagen_${wort}_${at}.csv`;
}
