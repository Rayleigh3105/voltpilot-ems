/**
 * Die ABLEITUNGEN der Erlöse-Seite (Konzept „Verlauf-Rework", Paket P2,
 * Entscheid E3 = A): Kennzahlen, Abrechnung, Diagramm und Tabelle aus EINER
 * Antwort (`GET /sites/{id}/earnings`).
 *
 * Regeln, die hier gelten:
 * - **Nichts wird zweimal gerechnet.** Beträge und Mengen sind Felder der
 *   Antwort; der Ø-Preis einer Position ist Betrag ÷ Menge (`durchschnittCt`,
 *   dieselbe Rechnung wie in Ebene 1). So geht „Menge × Ø Preis = Betrag"
 *   immer auf.
 * - **Fehlend ist keine Null.** Ein fehlender Betrag ist „—", eine Zelle ohne
 *   Werte bleibt im Diagramm leer und heißt in der Tabelle „keine Messwerte".
 * - **Vorzeichen als Zeichen.** „+ 12,34 €" / „− 3,40 €"; Kosten stehen negativ,
 *   weil sie das Ergebnis mindern.
 * - **Wertung nur bei abgeschlossenen Zeiträumen** — die Regeln aus
 *   `vergleichLaufend.ts`; ein Pfeil ist eine Richtung, kein Urteil.
 * - **Kunden sehen nur den Mehrwert der Steuerung** (`savedSteuerungEur` über
 *   `speicherAussage`), nie die Admin-Zahlen `savedEur`/`baselineEur`. Er
 *   steht als eigene Kachel ({@link mehrwertBand}), nie als Posten oder
 *   „davon"-Zeile des Ergebnisses: das Ergebnis zählt vermiedenen Netzbezug
 *   zweimal (Eigenverbrauch + weniger Stromkosten), der Mehrwert einmal —
 *   er ist kein Anteil des Ergebnisses.
 *
 * Rein und framework-frei.
 */
import type { HistoryBucket, HistoryRange, PeakShaving, SiteEarnings } from './api';
import { eur, eurAmount, fmtNum, NBSP } from './format';
import { durchschnittCt, erloesBegriff } from './erloesEbenen';
import { rundeKaufmaennisch, sekundaerFuer, type SekundaerZiel } from './erloesZeilen';
import { billingPeriodLabel, LEER_TEXT, LEER_TEXT_FALLBACK } from './erloesKomposition';
import { peakCounterfactualTip } from './moduleSurface';
import type { ErloesVergleich } from './vergleichLaufend';
import { MESSLATTE_DATIV, MESSLATTE_KURZ, type SpeicherAussage } from './speicherAussage';
import {
  geldZellen,
  zeichenbar,
  zellenArtFuer,
  zellenBeschriftung,
  type GeldZelle,
  type ZellenZustand,
} from './verlaufRaster';

/** Unter einem halben Cent zeigt die Anzeige 0,00 € — dann ist es keine Aussage. */
export const CENT = 0.005;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** „+ 12,34 €" · „− 3,40 €" · „0,00 €" · „—" (kaufmännisch gerundet). */
export function betrag(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return '—';
  const r = rundeKaufmaennisch(n, 2);
  if (Math.abs(r) < CENT) return eurAmount(0);
  return `${r < 0 ? '−' : '+'}${NBSP}${eurAmount(Math.abs(r))}`;
}

/** Der Ton eines Betrags: `minus` ab −0,005 €, `leer` ohne Wert. */
export function geldTon(v: number | null | undefined): 'minus' | 'leer' | null {
  const n = num(v);
  if (n == null) return 'leer';
  return rundeKaufmaennisch(n, 2) <= -CENT ? 'minus' : null;
}

/** „28,4 ct/kWh" — eine Stelle genügt für einen Durchschnitt. */
function ctText(ct: number | null): string | null {
  return ct == null ? null : `${ct.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}ct/kWh`;
}

/**
 * Mengen mit einer Nachkommastelle, ab 1.000 kWh ohne — so bleibt
 * „Menge × Ø Preis = Betrag" nachrechenbar, ohne dass große Zahlen zappeln.
 */
export function mengeText(kwh: number | null | undefined): string | null {
  const n = num(kwh);
  if (n == null) return null;
  return fmtNum(n, 'kWh', Math.abs(n) >= 1000 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Kennzahlen
// ---------------------------------------------------------------------------

export type GeldId = 'ergebnis' | 'eigenverbrauch' | 'einspeisung' | 'netzbezug';

export interface GeldErklaerung {
  titel: string;
  text: string;
}

export interface GeldKennzahl {
  id: GeldId;
  label: string;
  /** Der Betrag mit Vorzeichen; „—" ohne Wert. */
  wert: string;
  ton: 'minus' | 'leer' | null;
  /** Die Unterzeile: Menge, Vergleich oder der Grund, warum kein Wert da ist. */
  unter: string | null;
  /** Richtungspfeil vor der Unterzeile — nur beim Vergleich des Ergebnisses. */
  pfeil: '↑' | '↓' | null;
  info: GeldErklaerung | null;
}

export interface ErloesKennzahlenInput {
  money: SiteEarnings | null;
  vergleich: ErloesVergleich | null;
  /** Der volle Name der Vergleichsperiode („ganzer August") für laufende Zeiträume. */
  vergleichVoll: string | null;
}

/** Die Unterzeile des Ergebnisses aus dem Vergleich — nie ein Prozent über einen laufenden Zeitraum. */
export function vergleichUnter(
  v: ErloesVergleich | null,
  vergleichVoll: string | null,
): { text: string; pfeil: '↑' | '↓' | null } | null {
  if (!v) return null;
  const pfeil = (r: string | undefined) => (r === 'mehr' ? '↑' : r === 'weniger' ? '↓' : null);
  if (v.modus === 'ganze_periode') {
    if (!v.chip) return null;
    return { text: v.chip.text, pfeil: pfeil(v.chip.richtung) };
  }
  if (v.modus === 'gleicher_zeitpunkt') {
    const bis = v.bisStunde == null ? '' : ` bis ${v.bisStunde} Uhr`;
    if (!v.chip) return { text: `etwa wie gestern${bis}`, pfeil: null };
    return { text: `${v.chip.text} als gestern${bis}`, pfeil: pfeil(v.chip.richtung) };
  }
  // Laufende Woche/Monat/Jahr: nur der Betrag der ganzen Vergleichsperiode.
  if (v.vorherEur == null || !vergleichVoll) return null;
  return { text: `${vergleichVoll}: ${betrag(v.vorherEur)}`, pfeil: null };
}

function einspeiseInfo(money: SiteEarnings): GeldErklaerung {
  if (money.plantKind === 'direktvermarktung') {
    return {
      titel: 'Einspeisung',
      text: 'Was Ihr eingespeister Strom an der Börse erzielt hat, plus Marktprämie.',
    };
  }
  if (money.exportVerguetungPriced) {
    return { titel: 'Einspeisung', text: erloesBegriff('feste').erklaerung };
  }
  return {
    titel: 'Einspeisung',
    text: 'Bewertet mit dem Börsenpreis, weil die Vergütung Ihrer Anlage noch nicht hinterlegt ist.',
  };
}

/** Die Kennzahlen der Seite: Ergebnis zuerst, dann die drei Posten. */
export function erloesKennzahlen(input: ErloesKennzahlenInput): GeldKennzahl[] {
  const { money } = input;
  const netto = num(money?.nettoErgebnisEur);
  const leerGrund = money?.reason ? (LEER_TEXT[money.reason] ?? LEER_TEXT_FALLBACK) : LEER_TEXT_FALLBACK;
  const v = netto == null ? null : vergleichUnter(input.vergleich, input.vergleichVoll);
  const out: GeldKennzahl[] = [
    {
      id: 'ergebnis',
      label: 'Ergebnis',
      wert: betrag(netto),
      ton: geldTon(netto),
      unter: netto == null ? leerGrund : (v?.text ?? null),
      pfeil: v?.pfeil ?? null,
      // Wie verglichen wurde, steht auf Abruf im ⓘ — nie als Absatz im Weg.
      info: {
        titel: 'Ergebnis',
        text: [erloesBegriff('ergebnis').erklaerung, netto == null ? null : input.vergleich?.satz]
          .filter(Boolean)
          .join(' '),
      },
    },
  ];
  if (!money) return out;

  const eigen = num(money.eigenverbrauchsWertEur);
  out.push({
    id: 'eigenverbrauch',
    label: 'Eigenverbrauch',
    wert: betrag(eigen),
    ton: geldTon(eigen),
    unter: eigen == null ? 'kein Stromtarif hinterlegt' : mengeText(money.selbstverbrauchKwh),
    pfeil: null,
    info: { titel: 'Eigenverbrauch', text: erloesBegriff('eigenverbrauch').erklaerung },
  });

  const einsp = num(money.einspeiseErloesEur);
  out.push({
    id: 'einspeisung',
    label: 'Einspeisung',
    wert: betrag(einsp),
    ton: geldTon(einsp),
    unter: mengeText(money.eingespeistKwh),
    pfeil: null,
    info: einspeiseInfo(money),
  });

  const kosten = num(money.stromkostenEur);
  out.push({
    id: 'netzbezug',
    label: 'Netzbezug',
    wert: betrag(kosten == null ? null : -kosten),
    ton: kosten == null ? 'leer' : geldTon(-kosten),
    unter: mengeText(money.bezogenKwh),
    pfeil: null,
    info: { titel: 'Netzbezug', text: erloesBegriff('netzbezug').erklaerung },
  });

  return out;
}

// ---------------------------------------------------------------------------
// Abrechnung
// ---------------------------------------------------------------------------

export type PostenId = 'eigenverbrauch' | 'einspeisung' | 'netzbezug';

export interface AbrechnungsPosten {
  id: PostenId;
  name: string;
  /** „1.234 kWh · Ø 28,4 ct/kWh · feste Vergütung" — Menge, Preis, Grundlage. */
  unter: string | null;
  betrag: string;
  ton: 'minus' | 'leer' | null;
  /** Was fehlt, und der Weg dorthin („Stromtarif hinterlegen ›"). */
  hinweis: { text: string; link: { text: string; ziel: SekundaerZiel } | null } | null;
  /** Woher Menge und Preis kommen — der Text des ⓘ. */
  info: string | null;
}

export interface Abrechnung {
  posten: AbrechnungsPosten[];
  ergebnis: { betrag: string; ton: 'minus' | 'leer' | null };
  /** Posten einer EIGENEN Abrechnungsperiode, unter dem Strich. */
  ausserhalb: { name: string; periode: string; betrag: string; info: string } | null;
  /** Die gerundeten Posten gehen nicht auf den Cent auf — dann steht das dabei. */
  rundung: string | null;
  /** Tarif und Vergütung in einer Zeile. */
  grundlage: string;
}

function tarifGrundlage(money: SiteEarnings): string {
  const param = num(money.tarifParamCtKwh);
  const pc = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })}${NBSP}ct/kWh`;
  const bezug =
    money.tarifArt === 'fest' && param != null
      ? `Stromtarif fest ${pc(param)}`
      : money.tarifArt === 'dynamisch'
        ? `Stromtarif dynamisch (Börse + ${pc(param ?? 0)})`
        : money.tarifPriced
          ? 'Bezug zum Standard-Satz'
          : 'Bezug zum Börsenpreis';
  const einsp =
    money.plantKind === 'direktvermarktung'
      ? 'Direktvermarktung'
      : money.exportVerguetungPriced
        ? 'Einspeisung fest vergütet'
        : 'Einspeisung zum Börsenpreis';
  return `${bezug} · ${einsp}`;
}

function posten(
  money: SiteEarnings,
  id: PostenId,
  name: string,
  eurWert: number | null,
  kwh: number | null,
  anzeige: number | null,
): AbrechnungsPosten {
  const sek = sekundaerFuer(money, id === 'netzbezug' ? 'stromkosten' : id);
  const menge = mengeText(kwh);
  const preis = ctText(durchschnittCt(eurWert, kwh));
  const extra = (sek?.teile ?? []).filter(
    (t) => t !== fmtNum(kwh, 'kWh') && t !== 'selbst genutzt' && !/kWh$/.test(t),
  );
  const warn = sek?.ton === 'warn';
  const teile = [menge, preis ? `Ø ${preis}` : null, ...(warn ? [] : extra)].filter(
    (t): t is string => !!t,
  );
  return {
    id,
    name,
    unter: teile.length ? teile.join(' · ') : null,
    betrag: betrag(anzeige),
    ton: anzeige == null ? 'leer' : geldTon(anzeige),
    hinweis: warn && sek ? { text: sek.teile.join(' · '), link: sek.link } : null,
    info: sek?.titel ?? null,
  };
}

/** Die Abrechnung des Zeitraums: Menge × Ø Preis = Betrag, darunter der Strich. */
export function abrechnung(money: SiteEarnings): Abrechnung {
  const eigen = num(money.eigenverbrauchsWertEur);
  const einsp = num(money.einspeiseErloesEur);
  const kosten = num(money.stromkostenEur);
  const netto = num(money.nettoErgebnisEur);

  const liste = [
    posten(money, 'eigenverbrauch', 'Eigenverbrauch', eigen, num(money.selbstverbrauchKwh), eigen),
    posten(money, 'einspeisung', 'Einspeisung', einsp, num(money.eingespeistKwh), einsp),
    posten(money, 'netzbezug', 'Netzbezug', kosten, num(money.bezogenKwh), kosten == null ? null : -kosten),
  ];

  // Die Posten sind einzeln gerundet; gehen sie nicht auf den Cent auf,
  // steht das dabei — sonst läse sich die Differenz wie ein Rechenfehler.
  let rundung: string | null = null;
  if (netto != null) {
    const summe =
      rundeKaufmaennisch(eigen ?? 0, 2) + rundeKaufmaennisch(einsp ?? 0, 2) - rundeKaufmaennisch(kosten ?? 0, 2);
    const luecke = rundeKaufmaennisch(netto, 2) - rundeKaufmaennisch(summe, 2);
    if (Math.abs(luecke) >= CENT) rundung = 'Posten einzeln gerundet — das Ergebnis ist exakt gerechnet.';
  }

  const peak = money.peakShaving ?? null;
  return {
    posten: liste,
    ergebnis: { betrag: betrag(netto), ton: geldTon(netto) },
    ausserhalb: peak
      ? {
          name: 'Vermiedene Leistungskosten',
          periode: billingPeriodLabel(money),
          betrag: betrag(peak.avoidedEur),
          info: peakCounterfactualTip(peak),
        }
      : null,
    rundung,
    grundlage: tarifGrundlage(money),
  };
}

// ---------------------------------------------------------------------------
// Mehrwert durch VoltPilot (das Band unter den Kennzahlen)
// ---------------------------------------------------------------------------

export interface MehrwertBand {
  /** Die Kachel-Beschriftung: „VoltPilot-Steuerung". */
  label: string;
  /** Titel der Erklärung (ⓘ): „Mehrwert durch VoltPilot". */
  titel: string;
  /** „+ 1,45 €" — „—", wo es keinen Vergleich gibt (nie eine 0). */
  wert: string;
  /** Anzeige-Ton aus `speicherAussage`: Grün nur abgeschlossen und positiv. */
  ton: 'ok' | 'neutral' | 'warn' | 'leer';
  /**
   * Die Unterzeile, die mit dem Betrag einen Satz bildet: „+ 1,45 € ·
   * mehr als ohne smarte Steuerung". Laufend mit „bisher".
   */
  unter: string;
  /** Die Sätze des ⓘ: Aussage, Vergleichsmaßstab, ggf. Tageshinweis und Bestand. */
  info: string[];
  /** true = „Speicherdaten nachtragen ›" anbieten. */
  nachtrag: boolean;
}

/**
 * Die Kachel „VoltPilot-Steuerung" in der Kennzahlenzeile: die EINE
 * Kundenzahl der Steuerung (`savedSteuerungEur` über `speicherAussage`).
 * Betrag und Unterzeile lesen sich als ein Satz („+ 1,45 € — mehr als ohne
 * smarte Steuerung"); alles Weitere steht im ⓘ. Gerechnet wird hier nichts;
 * `null` = die Fläche schweigt (älteres Backend).
 */
export function mehrwertBand(speicher: SpeicherAussage | null, range: HistoryRange): MehrwertBand | null {
  if (!speicher?.hatAussage) return null;
  const s = speicher.steuerung;
  const titel = 'Mehrwert durch VoltPilot';
  const label = 'VoltPilot-Steuerung';
  const bestand = speicher.bestand ? [speicher.bestand] : [];
  if (!s) {
    return {
      label,
      titel,
      wert: '—',
      ton: 'leer',
      unter: 'Speicherdaten fehlen',
      info: [speicher.ohneVergleich ?? ''].filter(Boolean),
      nachtrag: speicher.nachtragLink,
    };
  }
  const richtung =
    s.ton === 'plus'
      ? `mehr als ${MESSLATTE_KURZ}`
      : s.ton === 'minus'
        ? `weniger als ${MESSLATTE_KURZ}`
        : `wie ${MESSLATTE_KURZ}`;
  return {
    label,
    titel,
    wert: s.wort,
    ton: speicher.anzeigeTon,
    unter: speicher.zwischenstand ? `bisher ${richtung}` : richtung,
    info: [
      // Der Satz zur Zahl nur, wo er mehr sagt als Betrag + Unterzeile
      // (unter Null: warum ein Zwischenstand sinken kann).
      s.ton === 'plus' ? '' : (speicher.satz ?? ''),
      `Verglichen wird mit ${MESSLATTE_DATIV}: Er lädt jeden Überschuss sofort und entlädt sofort — ohne Blick auf Preise. Nicht im Ergebnis enthalten.`,
      range === 'day'
        ? 'Einzelne Tage schwanken: Was am Tagesende noch im Speicher liegt, zählt erst an dem Tag, an dem es genutzt wird.'
        : '',
      ...bestand,
    ].filter(Boolean),
    nachtrag: false,
  };
}

// ---------------------------------------------------------------------------
// Lastspitze (Kontext)
// ---------------------------------------------------------------------------

export interface LastspitzeKontext {
  periode: string;
  betrag: string;
  /** Die Spitze derselben Anlage ohne Speichereinsatz. */
  ohne: string | null;
  /** Die gemessene, gehaltene Spitze. */
  gehalten: string | null;
  /** Gehalten ÷ ohne, für den Balken (0..100). */
  anteilPct: number | null;
  /** „3,5 kW × 80,00 €/kW" — die Rechnung hinter dem Betrag. */
  rechnung: string | null;
  info: string;
}

export function lastspitzeKontext(money: SiteEarnings | null): LastspitzeKontext | null {
  const peak: PeakShaving | null | undefined = money?.peakShaving;
  if (!money || !peak) return null;
  const ohne = num(peak.baselinePeakKw);
  const gehalten = num(peak.peakKw);
  const vermieden = num(peak.avoidedKw);
  return {
    periode: billingPeriodLabel(money),
    betrag: betrag(peak.avoidedEur),
    ohne: ohne == null ? null : fmtNum(ohne, 'kW'),
    gehalten: gehalten == null ? null : fmtNum(gehalten, 'kW'),
    anteilPct:
      ohne != null && gehalten != null && ohne > 0 ? Math.max(0, Math.min(100, (gehalten / ohne) * 100)) : null,
    rechnung:
      vermieden == null
        ? null
        : `${fmtNum(vermieden, 'kW')} × ${eur(peak.leistungspreisEurKw)}${NBSP}€/kW`,
    info: peakCounterfactualTip(peak),
  };
}

// ---------------------------------------------------------------------------
// Diagramm
// ---------------------------------------------------------------------------

/** Ein zusammenhängender Bereich ohne Werte — im Diagramm ein beschriftetes Band. */
export interface LeerBand {
  von: number;
  bis: number;
  art: 'luecke' | 'zukunft' | 'vorher';
}

export interface GeldDiagramm {
  range: HistoryRange;
  zellen: GeldZelle[];
  achse: string[];
  titel: string[];
  /** Beträge je Zelle (Kosten negativ); `null` = nichts zu zeichnen. */
  eigen: (number | null)[];
  einsp: (number | null)[];
  kosten: (number | null)[];
  netto: (number | null)[];
  /** Summe seit Beginn des Zeitraums; endet mit „jetzt". */
  kumuliert: (number | null)[];
  /** Die Vergleichsperiode, nach Position ausgerichtet; `null` ohne Vergleich. */
  vergleichNetto: (number | null)[] | null;
  vergleichKumuliert: (number | null)[] | null;
  baender: LeerBand[];
  /** Größter Betrag einer Säule — bestimmt die Nachkommastellen der Achse. */
  maxAbs: number;
  /** Was ein Klick auf eine Säule öffnet. */
  drill: 'tag' | 'monat' | null;
  /** Keine einzige Zelle mit Werten. */
  leer: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function zelleWert(z: GeldZelle, v: number | null, vorzeichen = 1): number | null {
  if (!zeichenbar(z) || v == null) return null;
  return r2(vorzeichen * v);
}

function kumuliere(zellen: readonly GeldZelle[]): (number | null)[] {
  let lauf = 0;
  let begonnen = false;
  return zellen.map((z) => {
    if (z.zustand === 'zukunft' || z.zustand === 'vorher') return null;
    if (zeichenbar(z) && z.nettoEur != null) {
      lauf += z.nettoEur;
      begonnen = true;
    }
    return begonnen ? r2(lauf) : null;
  });
}

function baender(zellen: readonly { zustand: ZellenZustand }[]): LeerBand[] {
  const out: LeerBand[] = [];
  let i = 0;
  while (i < zellen.length) {
    const art = zellen[i].zustand;
    if (art === 'luecke' || art === 'zukunft' || art === 'vorher') {
      let j = i;
      while (j + 1 < zellen.length && zellen[j + 1].zustand === art) j++;
      out.push({ von: i, bis: j, art });
      i = j + 1;
    } else i++;
  }
  return out;
}

/** Erster abgedeckter Tag als lokale Mitternacht — die Grenze für „vorher". */
function ersterTag(money: SiteEarnings | null): string | null {
  const d = money?.firstCoveredDate;
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const [y, m, t] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, t).toISOString();
}

export function geldDiagramm(input: {
  money: SiteEarnings | null;
  anchor: Date;
  range: HistoryRange;
  now: Date;
  vorher?: SiteEarnings | null;
  vorherAnker?: Date | null;
}): GeldDiagramm {
  const { money, anchor, range, now } = input;
  const zellen = geldZellen(money?.series ?? [], anchor, range, now, ersterTag(money));
  const art = zellenArtFuer(range, 'stunde');
  const texte = zellen.map((z) => zellenBeschriftung(z.start, art, range));
  const eigen = zellen.map((z) => zelleWert(z, z.eigenverbrauchEur));
  const einsp = zellen.map((z) => zelleWert(z, z.einspeiseEur));
  const kosten = zellen.map((z) => zelleWert(z, z.stromkostenEur, -1));
  const netto = zellen.map((z) => zelleWert(z, z.nettoEur));

  let vergleichNetto: (number | null)[] | null = null;
  let vergleichKumuliert: (number | null)[] | null = null;
  if (input.vorher && input.vorherAnker && input.vorher.series.length > 0) {
    const vz = geldZellen(input.vorher.series, input.vorherAnker, range, now, null);
    vergleichNetto = zellen.map((_, i) => (vz[i] ? zelleWert(vz[i], vz[i].nettoEur) : null));
    const vk = kumuliere(vz);
    vergleichKumuliert = zellen.map((_, i) => vk[i] ?? null);
  }

  let maxAbs = 0;
  zellen.forEach((_, i) => {
    const plus = (eigen[i] ?? 0) + (einsp[i] ?? 0);
    maxAbs = Math.max(maxAbs, Math.abs(plus), Math.abs(kosten[i] ?? 0), Math.abs(netto[i] ?? 0));
  });

  return {
    range,
    zellen,
    achse: texte.map((t) => t.achse),
    titel: texte.map((t) => t.titel),
    eigen,
    einsp,
    kosten,
    netto,
    kumuliert: kumuliere(zellen),
    vergleichNetto,
    vergleichKumuliert,
    baender: baender(zellen),
    maxAbs,
    drill: range === 'week' || range === 'month' ? 'tag' : range === 'year' ? 'monat' : null,
    // Leer heißt: kein einziger Betrag — eine laufende Zelle ohne Werte zählt nicht.
    leer: ![eigen, einsp, kosten, netto].some((r) => r.some((v) => v != null)),
  };
}

/**
 * Der Börsenpreis je Stunde eines Tages (ct/kWh), aus den Viertelstunden der
 * Historie gemittelt — nur Stunden, deren Preise vorliegen; sonst `null`.
 */
export function stundenPreise(buckets: readonly HistoryBucket[] | null | undefined, zellen: readonly GeldZelle[]): (number | null)[] {
  const summe = new Map<string, { s: number; n: number }>();
  for (const b of buckets ?? []) {
    if (b.priceEurMwh == null || !Number.isFinite(b.priceEurMwh)) continue;
    const t = new Date(b.start);
    if (Number.isNaN(t.getTime())) continue;
    const k = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
    const acc = summe.get(k) ?? { s: 0, n: 0 };
    acc.s += b.priceEurMwh / 10;
    acc.n += 1;
    summe.set(k, acc);
  }
  return zellen.map((z) => {
    const t = z.start;
    const acc = summe.get(`${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`);
    return acc && acc.n > 0 ? Math.round((acc.s / acc.n) * 100) / 100 : null;
  });
}

// ---------------------------------------------------------------------------
// Tabelle und CSV
// ---------------------------------------------------------------------------

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** Die erste Spalte der Tabelle: kurz, ohne die Jahreszahl, die die Zeit-Leiste schon nennt. */
export function tabellenKopf(start: Date, range: HistoryRange): string {
  if (range === 'day') return `${start.getHours()}–${start.getHours() + 1} Uhr`;
  if (range === 'year') return start.toLocaleDateString('de-DE', { month: 'long' });
  return `${WT[start.getDay()]}., ${p2(start.getDate())}.${p2(start.getMonth() + 1)}.`;
}

export const GELD_SPALTEN = ['Zeitraum', 'Eigenverbrauch', 'Einspeisung', 'Netzbezug', 'Ergebnis'] as const;

export interface GeldTabellenZeile {
  id: string;
  kopf: string;
  zellen: { text: string; ton: 'minus' | null }[] | null;
  leer?: string;
}

function zellenTexte(werte: (number | null)[]): { text: string; ton: 'minus' | null }[] {
  return werte.map((v) => ({ text: betrag(v), ton: geldTon(v) === 'minus' ? 'minus' : null }));
}

/** Die Tabellenansicht: jede vergangene Zelle, Lücken als „keine Messwerte", Summe aus der Antwort. */
export function geldTabelle(
  d: GeldDiagramm,
  money: SiteEarnings | null,
): { zeilen: GeldTabellenZeile[]; summe: GeldTabellenZeile | null } {
  const zeilen: GeldTabellenZeile[] = [];
  d.zellen.forEach((z, i) => {
    if (z.zustand === 'zukunft' || z.zustand === 'vorher') return;
    const kopf = `${tabellenKopf(z.start, d.range)}${z.zustand === 'laeuft' ? ' · läuft' : ''}`;
    if (!zeichenbar(z)) {
      zeilen.push({ id: z.schluessel, kopf, zellen: null, leer: 'keine Messwerte' });
      return;
    }
    if ([d.eigen[i], d.einsp[i], d.kosten[i], d.netto[i]].every((v) => v == null)) {
      zeilen.push({ id: z.schluessel, kopf, zellen: null, leer: 'noch keine Werte' });
      return;
    }
    zeilen.push({ id: z.schluessel, kopf, zellen: zellenTexte([d.eigen[i], d.einsp[i], d.kosten[i], d.netto[i]]) });
  });
  const kosten = num(money?.stromkostenEur);
  const summe = money
    ? {
        id: 'summe',
        kopf: 'Summe',
        zellen: zellenTexte([
          num(money.eigenverbrauchsWertEur),
          num(money.einspeiseErloesEur),
          kosten == null ? null : -kosten,
          num(money.nettoErgebnisEur),
        ]),
      }
    : null;
  return { zeilen, summe };
}

/** Eine Zahl für die CSV: Dezimalkomma, ASCII-Minus, leer ohne Wert. */
function csvZahl(v: number | null): string {
  if (v == null) return '';
  return rundeKaufmaennisch(v, 2).toFixed(2).replace('.', ',');
}

function csvText(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

function isoLokal(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Die Tabelle als CSV (Semikolon, Dezimalkomma — so öffnet sie eine deutsche Tabellenkalkulation). */
export function geldCsv(d: GeldDiagramm, money: SiteEarnings | null): string {
  const kopf = ['Beginn', 'Zeitraum', 'Eigenverbrauch EUR', 'Einspeisung EUR', 'Netzbezug EUR', 'Ergebnis EUR'];
  const zeilen = [kopf.join(';')];
  d.zellen.forEach((z, i) => {
    if (z.zustand === 'zukunft' || z.zustand === 'vorher') return;
    const w = zeichenbar(z) ? [d.eigen[i], d.einsp[i], d.kosten[i], d.netto[i]] : [null, null, null, null];
    zeilen.push(
      [isoLokal(z.start), csvText(tabellenKopf(z.start, d.range)), ...w.map(csvZahl)].join(';'),
    );
  });
  if (money) {
    const kosten = num(money.stromkostenEur);
    zeilen.push(
      [
        '',
        csvText('Summe'),
        csvZahl(num(money.eigenverbrauchsWertEur)),
        csvZahl(num(money.einspeiseErloesEur)),
        csvZahl(kosten == null ? null : -kosten),
        csvZahl(num(money.nettoErgebnisEur)),
      ].join(';'),
    );
  }
  return `${zeilen.join('\r\n')}\r\n`;
}

/** „erloese_sonnenhof_monat_2026-08-15.csv" — nur ASCII, damit jedes System sie speichert. */
export function csvDateiname(teil: string, name: string, range: HistoryRange, at: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'anlage';
  const wort = { day: 'tag', week: 'woche', month: 'monat', year: 'jahr' }[range];
  return `${teil}_${slug}_${wort}_${at}.csv`;
}

/** Ob die Antwort überhaupt einen Betrag trägt. */
export function hatErgebnis(money: SiteEarnings | null): boolean {
  return num(money?.nettoErgebnisEur) != null;
}

/**
 * Ob das Erlöse-Diagramm das Preisfeld trägt (Säulen am Tag mit Preisen) —
 * eine Stelle für Diagramm UND seinen Platzhalter (Höhenklasse `hoch`).
 */
export function mitPreisFeld(
  d: { range: HistoryRange },
  modus: 'saeulen' | 'kumuliert',
  preise: readonly (number | null)[] | null | undefined,
): boolean {
  return modus === 'saeulen' && d.range === 'day' && !!preise && preise.some((p) => p != null);
}
