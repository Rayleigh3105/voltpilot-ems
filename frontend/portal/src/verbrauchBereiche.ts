/**
 * **Verbrauch nach Bereichen** - die Verlauf-Karte im Reiter Energie (Unterverteilungen, Konzept
 * `vp-unterzaehler-anzeige`, Entscheid UV-2 A vom 07.11.2026): je gemessenem Teil des Hauses die
 * kWh des Zeitraums, dazu der Rest, und Säulen je Stunde, Tag oder Monat.
 *
 * Dieselbe Rechenregel wie „Verbrauch im Detail“ im Cockpit ({@link ./verbrauchKomposition}), nur
 * in kWh statt kW:
 *
 *     haus_kwh = Verbrauch laut /history (alles hinter dem Anschluss)
 *     teile    = kWh je gemessenem Verbraucher (GET …/entities/{id}/energy, Zählerregel)
 *     rest     = haus_kwh − Σ teile
 *
 * Gerechnet wird je Eimer der Standort-Historie (Tag 15 min, Woche 1 h, Monat/Jahr Berliner Tag) -
 * die Energie-Route liefert dasselbe Raster. Die Ehrlichkeitsregeln:
 *
 *  1. **Fehlend ist keine Null.** Fehlt einem Teil in einem Eimer, in dem das Haus misst, der Wert,
 *     ist der Rest dieses Eimers - und damit jeder Summe, die ihn enthält - nicht bestimmbar. Der
 *     Grund steht da, nie eine Zahl, die die Lücke enthält.
 *  2. **Ein fallender Zähler gibt keine Summe** (Zählerregel des Servers, `counterFalls`).
 *  3. **Ein negativer Rest wird gesagt, nie geklemmt**, sobald er über der Rundung zweier Zähler
 *     liegt (0,2 kW über die gemessene Dauer - die Schwelle der Cockpit-Liste).
 *  4. **Das Wort für den Rest folgt dem Anwendungsprofil** ({@link restWort}).
 *
 * Rein + rahmenfrei (getestet in `verbrauchBereiche.test.ts`).
 */
import type { EntityEnergy, History, HistoryRange } from './api';
import { csvZahl, isoLokal, tabellenKopf } from './energieSeite';
import { restWort } from './verbrauchKomposition';

/** Ab dieser Leistung (kW) über die gemessene Dauer widersprechen sich die Zähler. */
const KONFLIKT_KW = 0.2;

/** Ein gemessener Teil des Hauses und seine Energie-Reihe. */
export interface BereichEingabe {
  entityId: string;
  label: string;
  /** Ein Unterzähler (Typ `sub-meter`) - die Unterzeile sagt es. */
  unterzaehler: boolean;
  /** `null` = die Reihe konnte nicht geladen werden. */
  energie: EntityEnergy | null;
  /**
   * Zählerbaum-Konzept (R1): die Eltern-Komponente im elektrischen Baum, oder
   * `null` = hängt direkt am Haus. Nur Teile ohne Eltern gehen in den
   * Haus-minus-Teile-Rest ein - ein verschachtelter Teil steckt schon im Wert
   * seiner Eltern-Komponente und würde sonst doppelt abgezogen.
   */
  haengtAn: string | null;
}

export interface BereichZeile {
  key: string;
  label: string;
  /** „Unterzähler“, „berechnet: Haus minus Unterzähler“ oder der Grund ohne Zahl. */
  sub: string;
  kwh: number | null;
  /** Anteil am Haus, 0..1; `null` = kein Balken. */
  anteil: number | null;
  art: 'teil' | 'rest';
}

export interface BereichSaeule {
  start: Date;
  /** „8–9 Uhr“, „Mo., 02.11.“, „November“ - wie die Energie-Tabelle. */
  kopf: string;
  haus: number | null;
  /** Je Teil in der Reihenfolge von {@link VerbrauchBereiche.zeilen}; `null` = nicht belegbar. */
  teile: (number | null)[];
  /** Der Rest der Säule (ungeklemmt); `null` = nicht bestimmbar. */
  rest: number | null;
}

export interface VerbrauchBereiche {
  hausKwh: number | null;
  /** Die Teile (größte zuerst), dann der Rest. */
  zeilen: BereichZeile[];
  saeulen: BereichSaeule[];
}

const ms = (iso: string) => new Date(iso).getTime();

/** Der Beginn der Säule (lokale Zeit wie die Energie-Tabelle): Stunde, Tag oder Monat. */
function saeulenBeginn(t: number, range: HistoryRange): number {
  const d = new Date(t);
  if (range === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
  if (range === 'year') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Die Karte, oder `null`, wenn es nichts aufzuteilen gibt (kein Teil, keine Historie).
 */
export function verbrauchBereiche(input: {
  history: History | null | undefined;
  teile: readonly BereichEingabe[];
  range: HistoryRange;
  profil?: string | null;
}): VerbrauchBereiche | null {
  const { history, teile, range } = input;
  if (!history || teile.length === 0) return null;

  const haus = new Map<number, number>();
  for (const b of history.buckets) {
    if (b.loadKwh != null && Number.isFinite(b.loadKwh)) haus.set(ms(b.start), b.loadKwh);
  }
  const reihen = teile.map((t) => {
    const m = new Map<number, number | null>();
    for (const b of t.energie?.buckets ?? []) m.set(ms(b.start), b.kwh);
    return m;
  });

  // ⚠ Zählerbaum-Konzept R1: nur DIREKTE Kinder des Hauses gehen in den
  // Haus-minus-Teile-Rest ein. Eine Maschine hinter einer Unterverteilung
  // (`haengtAn` gesetzt) steckt schon im Wert IHRER Unterverteilung - ein
  // zweiter Abzug am Haus wäre Doppelzählung. Sie bleibt trotzdem eine eigene
  // Zeile/Spalte unten (`reihen`, ungefiltert), nur eben außerhalb des Rests.
  const wurzelIdx = teile.map((t, i) => (t.haengtAn == null ? i : -1)).filter((i) => i >= 0);
  const wurzelTeile = wurzelIdx.map((i) => teile[i]);
  const wurzelReihen = wurzelIdx.map((i) => reihen[i]);

  // --- Je Eimer: der Rest, sofern jeder Wurzel-Teil einen Wert hat ----------
  const restJeEimer = new Map<number, number | null>();
  for (const [t, h] of haus) {
    let summe = 0;
    let bestimmbar = true;
    for (const r of wurzelReihen) {
      const v = r.get(t);
      if (v == null) {
        bestimmbar = false;
        break;
      }
      summe += v;
    }
    restJeEimer.set(t, bestimmbar ? h - summe : null);
  }

  // --- Die Säulen -------------------------------------------------------------
  const spalten = new Map<number, { haus: number | null; teile: (number | null | undefined)[]; rest: number | null | undefined }>();
  const spalte = (t: number) => {
    const k = saeulenBeginn(t, range);
    let s = spalten.get(k);
    if (!s) {
      s = { haus: null, teile: teile.map(() => undefined), rest: undefined };
      spalten.set(k, s);
    }
    return s;
  };
  for (const [t, h] of haus) {
    const s = spalte(t);
    s.haus = (s.haus ?? 0) + h;
    const r = restJeEimer.get(t) ?? null;
    s.rest = s.rest === null || r == null ? null : (s.rest ?? 0) + r;
  }
  reihen.forEach((r, i) => {
    for (const [t, v] of r) {
      const s = spalte(t);
      const bisher = s.teile[i];
      s.teile[i] = bisher === null || v == null ? null : (bisher ?? 0) + v;
    }
  });

  // --- Die Zeilen -------------------------------------------------------------
  const hausKwh = haus.size === 0 ? null : Array.from(haus.values()).reduce((a, b) => a + b, 0);
  const anteil = (v: number | null) =>
    v != null && hausKwh != null && hausKwh > 0 ? Math.max(0, Math.min(1, v / hausKwh)) : null;
  const zeilen: BereichZeile[] = teile.map((t) => {
    const kwh = t.energie?.counterFalls ? null : (t.energie?.totalKwh ?? null);
    return {
      key: t.entityId,
      label: t.label,
      sub: t.energie == null
        ? 'Werte konnten nicht geladen werden'
        : t.energie.counterFalls
          ? 'der Zählerstand springt zurück (Tausch?) - keine Summe'
          : kwh == null
            ? 'keine Werte in diesem Zeitraum'
            : t.unterzaehler
              ? 'Unterzähler'
              : 'eigene Messung',
      kwh,
      anteil: anteil(kwh),
      art: 'teil' as const,
    };
  });
  const order = zeilen.map((_, i) => i).sort((a, b) => (zeilen[b].kwh ?? -1) - (zeilen[a].kwh ?? -1));
  const sortiert = order.map((i) => zeilen[i]);

  zeilen.length = 0;
  zeilen.push(...sortiert);
  zeilen.push(restZeile(restJeEimer, wurzelTeile, input.profil, history.bucketMinutes, anteil));

  const saeulen: BereichSaeule[] = Array.from(spalten.entries())
    .filter(([, s]) => s.haus != null)
    .sort(([a], [b]) => a - b)
    .map(([k, s]) => {
      const start = new Date(k);
      return {
        start,
        kopf: tabellenKopf(start, range),
        haus: s.haus,
        teile: order.map((i) => (s.teile[i] === undefined ? null : (s.teile[i] as number | null))),
        rest: s.rest === undefined ? null : s.rest,
      };
    });
  return { hausKwh, zeilen, saeulen };
}

function restZeile(
  restJeEimer: Map<number, number | null>,
  teile: readonly BereichEingabe[],
  profil: string | null | undefined,
  bucketMinutes: number,
  anteil: (v: number | null) => number | null,
): BereichZeile {
  const label = restWort(profil);
  const teilWort = teile.every((t) => t.unterzaehler) ? 'Unterzähler' : 'gemessene Geräte';
  const ohne = (grund: string): BereichZeile => ({ key: 'rest', label, sub: grund, kwh: null, anteil: null, art: 'rest' });
  if (restJeEimer.size === 0) return ohne('nicht bestimmbar - der Hausverbrauch fehlt in diesem Zeitraum');
  const gefallen = teile.find((t) => t.energie?.counterFalls);
  if (gefallen) return ohne(`nicht bestimmbar (${gefallen.label}: Zählerstand springt zurück)`);
  let summe = 0;
  for (const [t, r] of restJeEimer) {
    if (r == null) {
      const luecke = teile.find((tt) => !tt.energie?.buckets.some((b) => ms(b.start) === t && b.kwh != null));
      return ohne(`nicht bestimmbar (${luecke?.label ?? 'ein Teil'} ohne Werte für einen Teil des Zeitraums)`);
    }
    summe += r;
  }
  const toleranz = KONFLIKT_KW * (restJeEimer.size * bucketMinutes) / 60;
  if (summe < -toleranz) {
    return ohne(`Messwerte passen nicht zusammen (${kwhText(summe)})`);
  }
  const kwh = Math.max(summe, 0);
  return { key: 'rest', label, sub: `berechnet: Haus minus ${teilWort}`, kwh, anteil: anteil(kwh), art: 'rest' };
}

function kwhText(v: number): string {
  const n = Math.round(v * 10) / 10;
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`.replace(/^-/, '−');
}

/**
 * Die Karte als CSV - dieselbe Form wie die Energie-Tabelle (Semikolon, Dezimalkomma, kWh mit drei
 * Stellen, ungerundet bis dahin): je Säule Beginn, Zeitraum, Haus, je Bereich, Rest.
 */
export function bereicheCsv(b: VerbrauchBereiche, range: HistoryRange): string {
  const teilZeilen = b.zeilen.filter((z) => z.art === 'teil');
  const rest = b.zeilen.find((z) => z.art === 'rest');
  const kopf = ['Beginn', 'Zeitraum', 'Haus kWh', ...teilZeilen.map((z) => `${csvText(z.label)} kWh`),
    `${csvText(rest?.label ?? 'Rest')} kWh`];
  const out = [kopf.join(';')];
  for (const s of b.saeulen) {
    out.push([isoLokal(s.start), `"${tabellenKopf(s.start, range)}"`, csvZahl(s.haus), ...s.teile.map(csvZahl),
      csvZahl(s.rest)].join(';'));
  }
  out.push(['', '"Summe"', csvZahl(b.hausKwh), ...teilZeilen.map((z) => csvZahl(z.kwh)), csvZahl(rest?.kwh ?? null)]
    .join(';'));
  return `${out.join('\r\n')}\r\n`;
}

/** Ein Name als CSV-Kopf: ohne Semikolon und Anführungszeichen (die Tabelle hat keinen Escape). */
function csvText(s: string): string {
  return s.replace(/[;"\r\n]/g, ' ').trim();
}
