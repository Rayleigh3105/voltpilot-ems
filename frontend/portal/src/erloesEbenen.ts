/**
 * **Ebene 1 und Ebene 2 der Ergebnis-Karte** (Konzept
 * `vp-erloese-seite-konzept-e2` §3.3/§3.4/§3.11, Revision 2).
 *
 * Ebene 0 sagt WIE VIEL (`erloesZeilen.ts`), Ebene 1 sagt WIE ES SICH
 * ZUSAMMENSETZT und Ebene 2 sagt MIT WELCHEN PREISEN. Alles hier ist REINE
 * Ableitung — Formel-Zeilen als DATEN (das `steuerungFormel`-Muster), damit
 * dieselbe Rechnung nie zweimal formuliert wird und ein Test sie nachrechnen
 * kann, ohne einen Browser zu starten.
 *
 * ⚠ **REGEL 1 (§3.3): ein Ø-Preis wird nur genannt, wenn er der QUOTIENT
 * ZWEIER SERVER-SUMMEN ist.** „6,18 ct" ist `(Einspeise-Erlös − Marktprämie) ÷
 * eingespeiste kWh`, nicht ein Preis, den irgendjemand geschätzt hat. Fehlt
 * einer der beiden Summanden oder ist die Menge null, steht KEIN Preis in der
 * Zeile — lieber eine kürzere Rechnung als eine erfundene Zahl.
 *
 * ⚠ **REGEL 2 (§3.3): „geht auf" ist eine GEPRÜFTE Eigenschaft, nicht eine
 * Behauptung.** Jede Rechenzeile trägt optional ihre `probe` (was die Formel
 * ergibt / was der Server sagt); `erloesEbenen.test.ts` fährt sie über alle 15
 * Fixtures und verlangt eine Abweichung ≤ 1 Cent. Der Kunde sieht davon
 * nichts — er soll die Zeile nachrechnen können, nicht ihr glauben müssen.
 */
import type { SiteEarnings } from './api';
import { eurAmount, fmtNum, NBSP } from './format';
import { rundeKaufmaennisch, type ErgebnisZeilenView, type ErloesZeileId } from './erloesZeilen';

/** Eine Rechenzeile: „345,4 kWh × 6,18 ct = 21,34 €" plus ein Halbsatz Herkunft. */
export interface RechenZeile {
  /** Die Formel MIT den eingesetzten Zahlen (Festbreitenschrift). */
  formel: string;
  /** Woher die eingesetzten Zahlen kommen — ein Halbsatz, kein Absatz. */
  herkunft: string;
  /**
   * Der Beleg, dass die Formel aufgeht: was sie ergibt gegen das, was der
   * Server sagt. Nur gesetzt, wo die Zeile wirklich RECHNET (eine Zeile, die
   * nur eine Summe wiederholt, hat nichts zu prüfen).
   */
  probe?: { ist: number; soll: number };
}

/** Ebene 1 EINER Zeile. */
export interface Ebene1 {
  kopf: string;
  zeilen: RechenZeile[];
}

/** Der Auslöser von Ebene 1 — an jeder Zeile wortgleich. */
export const EBENE1_KOPF = 'Wie setzt sich das zusammen?';

/** Der Auslöser von Ebene 2. */
export const EBENE2_KOPF = 'Preise & Vergütung';

/**
 * Der Auslöser der Speicher-Schritte — WORTGLEICH zu `FORMEL_AUSLOESER` der
 * Prosa-Fassung (`erloesKomposition.ts`). Dieselbe Frage darf an zwei Flächen
 * nicht zwei Namen haben; nur die ANTWORT ist hier eine Schritt-Folge.
 */
export const FORMEL_AUSLOESER_SCHRITTE = 'Wie wird das berechnet?';

/** Unter dieser Menge lässt sich kein Durchschnittspreis bilden. */
const KWH_TOTBAND = 0.05;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function de(v: number, digits: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Eine Zahl am ANFANG einer Formel — negativ mit dem typografischen Minus und
 * einem Leerzeichen, wie überall im Portal („− 2,67").
 */
function zahl(v: number, digits = 2): string {
  return v < 0 ? `− ${de(-v, digits)}` : de(v, digits);
}

/**
 * Ein FOLGE-Term einer Formel: sein Vorzeichen IST der Operator. Dadurch
 * liest sich auch ein negativer Summand richtig („… − 1,42 …") statt als
 * doppeltes Zeichen, und eine Gutschrift beim Netzbezug wird zum „+".
 */
function folgeTerm(v: number | null, digits = 2): string {
  if (v == null) return '+ —';
  return v < 0 ? `− ${de(-v, digits)}` : `+ ${de(v, digits)}`;
}

/** „6,18 ct" — der Preis in der Formel, ohne die Einheit zu wiederholen. */
function ct(v: number, digits = 2): string {
  return `${de(v, digits)}${NBSP}ct`;
}

/**
 * Der Ø-Preis EINER Zeile: Geld ÷ Menge, beides vom Server. `null`, wo einer
 * der beiden fehlt oder die Menge zu klein ist — dann nennt die Zeile keinen
 * Preis (Regel 1).
 */
export function durchschnittCt(eur: number | null, kwh: number | null): number | null {
  if (eur == null || kwh == null) return null;
  if (Math.abs(kwh) < KWH_TOTBAND) return null;
  return (eur / kwh) * 100;
}

/* ---------------------------------------------------------------------------
 * Ebene 1 · Einspeise-Erlös
 * ------------------------------------------------------------------------ */

function einspeisung(money: SiteEarnings): RechenZeile[] {
  const e = num(money.einspeiseErloesEur);
  const kwh = num(money.eingespeistKwh);
  if (e == null) return [];
  const praemie = num(money.marktpraemieEur) ?? 0;
  const aw = num(money.anzulegenderWertCtKwh);
  const mv = num(money.marketValueSolarCtKwh);

  if (money.plantKind === 'direktvermarktung') {
    const spot = e - praemie;
    const spotCt = durchschnittCt(spot, kwh);
    const out: RechenZeile[] = [];
    out.push(
      spotCt == null
        ? {
            formel: `Börse ${eurAmount(rundeKaufmaennisch(spot, 2))}`,
            herkunft: 'Erlös an der Strombörse — ohne eingespeiste Menge kein Durchschnittspreis',
          }
        : {
            formel: `${fmtNum(kwh, 'kWh')} × ${ct(spotCt)} = ${eurAmount(rundeKaufmaennisch(spot, 2))}`,
            herkunft: 'Börsenpreis Ihrer Einspeise-Zeiten (Ø)',
            probe: { ist: ((kwh as number) * spotCt) / 100, soll: spot },
          },
    );
    if (praemie > 0 && aw != null && mv != null && aw - mv > 0) {
      const satz = aw - mv;
      const elig = (praemie / satz) * 100;
      out.push({
        formel: `+ ${fmtNum(elig, 'kWh')} × ${ct(satz)} = ${eurAmount(rundeKaufmaennisch(praemie, 2))}`,
        herkunft:
          `Marktprämie: ${de(aw, 2)} − ${de(mv, 2)}${NBSP}ct` +
          `${money.marketValueProvisional ? ' (vorläufig)' : ''}, nur bei Börsenpreis ≥ 0`,
        probe: { ist: (elig * satz) / 100, soll: praemie },
      });
    } else if (aw != null && mv != null) {
      out.push({
        formel: `+ ${eurAmount(0)} Marktprämie`,
        herkunft: 'Der Monatsmarktwert liegt über Ihrem anzulegenden Wert',
      });
    }
    out.push({ formel: `= ${eurAmount(rundeKaufmaennisch(e, 2))}`, herkunft: 'Einspeise-Erlös' });
    return out;
  }

  const preis = durchschnittCt(e, kwh);
  const herkunft = money.exportVerguetungPriced
    ? 'Ihre feste Einspeisevergütung (EEG)'
    : 'Börsenpreis Ihrer Einspeise-Zeiten (Ø) — Vergütung nicht hinterlegt: Anlage verknüpfen ›';
  if (preis == null) {
    return [{ formel: `= ${eurAmount(rundeKaufmaennisch(e, 2))}`, herkunft }];
  }
  return [
    {
      formel: `${fmtNum(kwh, 'kWh')} × ${ct(preis)} = ${eurAmount(rundeKaufmaennisch(e, 2))}`,
      herkunft,
      probe: { ist: ((kwh as number) * preis) / 100, soll: e },
    },
  ];
}

/* ---------------------------------------------------------------------------
 * Ebene 1 · Wert des Eigenverbrauchs
 * ------------------------------------------------------------------------ */

function eigenverbrauch(money: SiteEarnings): RechenZeile[] {
  const ev = num(money.eigenverbrauchsWertEur);
  const kwh = num(money.selbstverbrauchKwh);
  if (ev == null) {
    return [
      {
        formel: kwh == null ? '— × — = —' : `${fmtNum(kwh, 'kWh')} × — = —`,
        herkunft: 'selbst genutzt statt gekauft · kein Stromtarif hinterlegt: Stromtarif hinterlegen ›',
      },
    ];
  }
  const preis = durchschnittCt(ev, kwh);
  const herkunft =
    money.tarifArt === 'fest'
      ? 'selbst genutzt statt gekauft · Ihr fester Stromtarif'
      : 'selbst genutzt statt gekauft · Börsenpreis + Aufschlag (Ø)';
  if (preis == null) {
    return [{ formel: `= ${eurAmount(rundeKaufmaennisch(ev, 2))}`, herkunft }];
  }
  return [
    {
      formel: `${fmtNum(kwh, 'kWh')} × ${ct(preis)} = ${eurAmount(rundeKaufmaennisch(ev, 2))}`,
      herkunft,
      probe: { ist: ((kwh as number) * preis) / 100, soll: ev },
    },
  ];
}

/* ---------------------------------------------------------------------------
 * Ebene 1 · Stromkosten (Netzbezug)
 * ------------------------------------------------------------------------ */

/** Wie der Bezugspreis zustande kam — die B6-Unterscheidung in EINEM Halbsatz. */
export function bezugsHerkunft(money: SiteEarnings): string {
  if (money.tarifArt === 'fest') return 'aus dem Netz bezogen · Ihr fester Stromtarif';
  if (money.tarifArt === 'dynamisch') return 'aus dem Netz bezogen · Börsenpreis + Aufschlag (Ø)';
  if (money.tarifPriced) {
    return 'aus dem Netz bezogen · Börsenpreis + übliche Netzentgelte, Abgaben, Umsatzsteuer (Ø)';
  }
  return 'aus dem Netz bezogen · Börsenpreis (Ø)';
}

function stromkosten(money: SiteEarnings): RechenZeile[] {
  const s = num(money.stromkostenEur);
  const kwh = num(money.bezogenKwh);
  if (s == null) return [];
  const preis = durchschnittCt(s, kwh);
  const herkunft = bezugsHerkunft(money);
  if (preis == null) {
    return [{ formel: `= ${eurAmount(rundeKaufmaennisch(s, 2))}`, herkunft }];
  }
  return [
    {
      formel: `${fmtNum(kwh, 'kWh')} × ${ct(preis)} = ${eurAmount(rundeKaufmaennisch(s, 2))}`,
      herkunft,
      probe: { ist: ((kwh as number) * preis) / 100, soll: s },
    },
  ];
}

/* ---------------------------------------------------------------------------
 * Ebene 1 · Ergebnis — und die Rundung (E4 = a)
 * ------------------------------------------------------------------------ */

function ergebnis(view: ErgebnisZeilenView): RechenZeile[] {
  const hero = view.hero;
  if (!hero) return [];
  const [a, b, c] = view.zeilen;
  const summe = rundeKaufmaennisch((a.eur ?? 0) + (b.eur ?? 0) + (c.eur ?? 0), 2);
  const out: RechenZeile[] = [
    {
      formel: `${zahl(a.eur ?? 0)} ${folgeTerm(b.eur)} ${folgeTerm(c.eur)} = ${eurAmount(summe)}`,
      herkunft: 'die drei Zeilen, je für sich gerundet',
    },
  ];
  // ⚠ Die Zeile steht NUR, wenn die gerundeten Zeilen wirklich nicht aufgehen.
  // Sonst erklärte sie einen Widerspruch, den der Kunde gar nicht sieht.
  if (Math.abs(view.rundungsluecke) >= 0.005) {
    const ex = view.exakt;
    out.push({
      formel:
        `exakt: ${zahl(ex.einspeisung ?? 0, 3)} ${folgeTerm(ex.eigenverbrauch, 3)} ` +
        `${folgeTerm(ex.stromkosten == null ? null : -ex.stromkosten, 3)} ` +
        `= ${zahl(ex.netto ?? 0, 3)} → ${eurAmount(hero.eur)}`,
      herkunft: 'gerundete Zeilen können um einen Cent vom exakten Ergebnis abweichen',
      probe: {
        ist: (ex.einspeisung ?? 0) + (ex.eigenverbrauch ?? 0) - (ex.stromkosten ?? 0),
        soll: ex.netto ?? 0,
      },
    });
  }
  return out;
}

/** Ebene 1 einer Zeile — `null`, wo es nichts zu rechnen gibt. */
export function ebene1(money: SiteEarnings | null, view: ErgebnisZeilenView, id: ErloesZeileId): Ebene1 | null {
  if (!money) return null;
  const zeilen =
    id === 'einspeisung'
      ? einspeisung(money)
      : id === 'eigenverbrauch'
        ? eigenverbrauch(money)
        : id === 'stromkosten'
          ? stromkosten(money)
          : ergebnis(view);
  return zeilen.length === 0 ? null : { kopf: EBENE1_KOPF, zeilen };
}

/* ---------------------------------------------------------------------------
 * Ebene 2 · „Preise & Vergütung" — eine Tabelle, höchstens acht Zeilen
 * ------------------------------------------------------------------------ */

export interface PreisTabellenZeile {
  label: string;
  wert: string;
}

export interface GlossarEintrag {
  begriff: string;
  erklaerung: string;
}

export interface Ebene2 {
  kopf: string;
  zeilen: PreisTabellenZeile[];
  glossar: GlossarEintrag[];
}

/**
 * Das Glossar (§3.11) in der Kurzform, die unter Ebene 2 wohnt. Gezeigt wird
 * NUR, was auf DIESER Anlage vorkommt — ein Begriff, den die Karte darüber
 * nirgends benutzt, erklärt nichts, er verlängert nur.
 */
const GLOSSAR: Record<string, GlossarEintrag> = {
  boerse: {
    begriff: 'Börsenpreis',
    erklaerung:
      'Der Preis für eine Kilowattstunde an der Strombörse für genau diese Viertelstunde. Er kann negativ sein.',
  },
  praemie: {
    begriff: 'Marktprämie',
    erklaerung:
      'Anzulegender Wert minus Monatsmarktwert, je eingespeister Kilowattstunde. Sie hängt am Durchschnitt aller Solaranlagen, nicht an Ihrem eigenen Verkaufspreis; bei negativem Börsenpreis ruht sie.',
  },
  monatsmarktwert: {
    begriff: 'Monatsmarktwert Solar',
    erklaerung:
      'Der Durchschnittspreis, den alle Solaranlagen in Deutschland in diesem Monat an der Börse erzielt haben. Bis der amtliche Wert vorliegt, rechnen wir mit einem vorläufigen.',
  },
  anzulegender: {
    begriff: 'Anzulegender Wert',
    erklaerung:
      'Der feste Referenzsatz aus Ihrem EEG-Zuschlag beziehungsweise Ihrem Direktvermarktungsvertrag; die Marktprämie füllt bis zu ihm auf.',
  },
  feste: {
    begriff: 'Feste Einspeisevergütung',
    erklaerung:
      'Der gesetzliche Satz je eingespeister Kilowattstunde für Anlagen ohne Direktvermarktung, 20 Jahre ab Inbetriebnahme.',
  },
  eigenverbrauch: {
    begriff: 'Wert des Eigenverbrauchs',
    erklaerung:
      'Der Strom, den Ihre Anlage selbst verbraucht hat — bewertet mit dem, was er Sie sonst gekostet hätte.',
  },
  netzbezug: {
    begriff: 'Netzbezug',
    erklaerung:
      'Der Strom, den Sie aus dem Netz gekauft haben, bewertet mit Ihrem Stromtarif (fest, oder Börsenpreis plus Netzentgelte, Abgaben und Umsatzsteuer).',
  },
  ergebnis: {
    begriff: 'Ergebnis unterm Strich',
    erklaerung:
      'Einspeise-Erlös plus Wert des Eigenverbrauchs minus Netzbezug. Bewertet, nicht abgerechnet: Ihre Rechnung kommt weiterhin von Ihrem Versorger.',
  },
  stur: {
    begriff: 'Sturer Speicher',
    erklaerung:
      'Ein Speicher, der jeden Solarüberschuss lädt und jeden Bedarf deckt, aber keine Preise kennt und nie für später hält. Er ist der Vergleichsmaßstab für die Steuerung.',
  },
  planwert: {
    begriff: 'Speicherenergie · Planwert',
    erklaerung:
      'Was gerade im Speicher liegt, bewertet mit dem Wert, den der Fahrplan einer gespeicherten Kilowattstunde beimisst. Nur zur Einordnung — es wird nirgends abgezogen.',
  },
  zwischenstand: {
    begriff: 'Zwischenstand',
    erklaerung:
      'Eine Zahl eines Zeitraums, der noch läuft. Was gerade in den Speicher geht, zählt erst, wenn es später den Netzbezug ersetzt.',
  },
};

/** Der E12-Satz: warum Einspeisen bei 0,0 ct richtig sein kann. */
export function nullCtSatz(satzCt: number): string {
  return (
    `Prämie gilt noch (${ct(satzCt)}) — erst unter 0,0${NBSP}ct ruht sie. ` +
    'Deshalb kann Einspeisen richtig sein, obwohl der Speicher Platz hat.'
  );
}

export interface Ebene2Input {
  money: SiteEarnings;
  /** Ob der Speicher aus dem Netz laden darf (`site.netzladenErlaubt`). */
  netzladenErlaubt?: boolean | null;
}

export function ebene2(input: Ebene2Input): Ebene2 {
  const money = input.money;
  const zeilen: PreisTabellenZeile[] = [];
  const glossar: GlossarEintrag[] = [];

  // --- Bezugspreis -------------------------------------------------------
  const param = num(money.tarifParamCtKwh);
  const bezugSchnitt = num(money.bezugspreisCtKwh);
  if (money.tarifArt === 'fest' && param != null) {
    zeilen.push({ label: 'Bezugspreis', wert: `${ct(param)}/kWh · fester Tarif` });
  } else if (money.tarifArt === 'dynamisch') {
    const schnitt = bezugSchnitt == null ? '' : ` · Ø ${ct(bezugSchnitt, 1)}`;
    zeilen.push({
      label: 'Bezugspreis',
      wert: `Börsenpreis + ${ct(param ?? 0, 1)} Aufschlag${schnitt}`,
    });
    glossar.push(GLOSSAR.boerse);
  } else if (money.tarifPriced) {
    const schnitt = bezugSchnitt == null ? '' : ` · Ø ${ct(bezugSchnitt, 1)}`;
    zeilen.push({
      label: 'Bezugspreis',
      wert: `Börsenpreis + übliche Netzentgelte, Abgaben, Umsatzsteuer${schnitt} — Tarif hinterlegen ›`,
    });
    glossar.push(GLOSSAR.boerse);
  } else {
    const schnitt = bezugSchnitt == null ? '' : ` · Ø ${ct(bezugSchnitt, 1)}`;
    zeilen.push({ label: 'Bezugspreis', wert: `Börsenpreis${schnitt} — Tarif hinterlegen ›` });
    glossar.push(GLOSSAR.boerse);
  }

  // --- Einspeisepreis ----------------------------------------------------
  const e = num(money.einspeiseErloesEur);
  const kwh = num(money.eingespeistKwh);
  if (money.plantKind === 'direktvermarktung') {
    const realized = num(money.realizedExportCtKwh);
    zeilen.push({
      label: 'Einspeisepreis',
      wert:
        realized == null
          ? 'Börsenpreis Ihrer Einspeise-Zeiten'
          : `Börsenpreis Ihrer Einspeise-Zeiten · Ø ${ct(realized)}`,
    });
    if (!glossar.includes(GLOSSAR.boerse)) glossar.push(GLOSSAR.boerse);
    const mv = num(money.marketValueSolarCtKwh);
    const aw = num(money.anzulegenderWertCtKwh);
    if (mv != null) {
      zeilen.push({
        label: 'Monatsmarktwert Solar',
        wert: `${ct(mv)}${money.marketValueProvisional ? ' · vorläufig' : ''}`,
      });
      glossar.push(GLOSSAR.monatsmarktwert);
    }
    if (aw != null) {
      zeilen.push({ label: 'Anzulegender Wert', wert: ct(aw) });
      glossar.push(GLOSSAR.anzulegender);
      const satz = rundeKaufmaennisch(aw - (mv ?? 0), 2);
      const praemie = num(money.marktpraemieEur);
      if (praemie != null) {
        const ruht = e != null && e < 0 ? ' · ruht bei Börsenpreis unter 0' : '';
        zeilen.push({
          label: 'Marktprämie',
          wert: `${ct(Math.max(satz, 0))}/kWh · ${eurAmount(rundeKaufmaennisch(praemie, 2))} im Zeitraum${ruht}`,
        });
        glossar.push(GLOSSAR.praemie);
      }
      // E12 (Captain-Entscheid a): der Hebelsatz gehört auf Ebene 2, wortgleich.
      if (satz > 0) zeilen.push({ label: 'Bei 0,0 ct Börsenpreis', wert: nullCtSatz(satz) });
    }
  } else if (money.exportVerguetungPriced) {
    const preis = durchschnittCt(e, kwh);
    zeilen.push({
      label: 'Einspeisepreis',
      wert:
        preis == null
          ? 'feste Vergütung (EEG), 20 Jahre ab Inbetriebnahme'
          : `${ct(preis)}/kWh · feste Vergütung (EEG), 20 Jahre ab Inbetriebnahme`,
    });
    glossar.push(GLOSSAR.feste);
  } else {
    const preis = durchschnittCt(e, kwh);
    zeilen.push({
      label: 'Einspeisepreis',
      wert:
        preis == null
          ? 'Börsenpreis — nicht verknüpft: Anlage verknüpfen ›'
          : `Börsenpreis · Ø ${ct(preis)} — nicht verknüpft: Anlage verknüpfen ›`,
    });
    if (!glossar.includes(GLOSSAR.boerse)) glossar.push(GLOSSAR.boerse);
  }

  // --- Speicher + Bewertung ---------------------------------------------
  if (input.netzladenErlaubt != null) {
    zeilen.push({
      label: 'Speicher',
      wert: input.netzladenErlaubt ? 'darf aus dem Netz laden' : 'lädt nur Sonnenstrom',
    });
  }
  zeilen.push({
    label: 'Bewertung',
    wert: 'heutige Tarif- und Vergütungsangaben — nicht Ihre Abrechnung',
  });

  glossar.push(GLOSSAR.eigenverbrauch, GLOSSAR.netzbezug, GLOSSAR.ergebnis);
  if (num(money.speicherWertEur) != null) glossar.push(GLOSSAR.planwert);

  return { kopf: EBENE2_KOPF, zeilen, glossar };
}

/* ---------------------------------------------------------------------------
 * Die SPEICHER-ERKLÄRUNG als Schritte 1–5 (§3.3, letzte Zeile der Tabelle)
 *
 * Inhaltlich ist es die Erklärung, die `steuerungFormel()` als Fließtext
 * liefert — der Captain hat sie freigegeben, und die Rechen-Tiefe wird
 * ausdrücklich NICHT gekürzt. Neu ist nur die FORM: Schritte mit den
 * EINGESETZTEN Zahlen statt Prosa.
 * ------------------------------------------------------------------------ */

export interface SpeicherSchritteInput {
  money: SiteEarnings;
  /**
   * Der Anteil eines STUR arbeitenden Speichers (`savedSpeicherEur`, #591).
   * `undefined` = ein älteres Backend liefert das Feld nicht — dann entfallen
   * die Schritte 4 und 5 wortlos; ein fehlendes Feld ist kein fehlendes
   * Stammdatum (§3.6).
   */
  sturEur?: number | null;
  /** Der Anteil der Steuerung (`savedSteuerungEur`). */
  steuerungEur?: number | null;
  /** `no_battery_data` = die Stammdaten FEHLEN — das sagt Schritt 4 dann. */
  splitReason?: 'no_battery_data' | null;
  /** Die vorab GEPLANTE Ersparnis des Fahrplans (Historie-Antwort). */
  geplantEur?: number | null;
}

/** „24,55 € Gutschrift" / „3,12 € Kosten" — das Vorzeichen wird zum Wort. */
function gutschrift(v: number): string {
  return `${eurAmount(Math.abs(rundeKaufmaennisch(v, 2)))} ${v >= 0 ? 'Gutschrift' : 'Kosten'}`;
}

/** „a − b" bzw. „a + |b|" — ein doppeltes Minus liest sich niemand. */
function differenz(a: number, b: number): string {
  return `${zahl(a)} ${folgeTerm(-b)}`;
}

function vorzeichen(v: number): string {
  return `${v < 0 ? '−' : '+'} ${eurAmount(Math.abs(v))}`;
}

export function speicherSchritte(input: SpeicherSchritteInput): RechenZeile[] {
  const money = input.money;
  const saved = num(money.savedEur);
  const actual = num(money.actualEur);
  const baseline = num(money.baselineEur);
  if (saved == null || actual == null || baseline == null) return [];

  // Die Stromrechnung ist eine KOSTEN-Größe; als Gutschrift gelesen dreht sie
  // ihr Vorzeichen genau einmal.
  const mit = -actual;
  const ohne = -baseline;
  const out: RechenZeile[] = [
    {
      formel: `Schritt 1 · gemessen: ${gutschrift(mit)}`,
      herkunft:
        'Ihre Stromrechnung mit VoltPilot: Netzbezug × Bezugspreis − Einspeisung × Einspeisepreis, je Viertelstunde',
    },
    {
      formel: `Schritt 2 · gerechnet: ${gutschrift(ohne)}`,
      herkunft:
        'dieselbe Anlage ohne Speicher: gleiche Sonne, gleicher Verbrauch, Speicher aus',
    },
    {
      formel: `Schritt 3 · Speicher gesamt: ${differenz(rundeKaufmaennisch(mit, 2), rundeKaufmaennisch(ohne, 2))} = ${vorzeichen(rundeKaufmaennisch(saved, 2))}`,
      // ⚠ Der Bestandskonto-Hinweis steht GENAU EINMAL (§3.12) — hier.
      herkunft:
        'Kassenrechnung — was jetzt im Speicher liegt, zählt erst beim späteren Netzbezug; deshalb kann die Zahl mittags sinken',
      probe: { ist: rundeKaufmaennisch(mit, 2) - rundeKaufmaennisch(ohne, 2), soll: saved },
    },
  ];

  const stur = num(input.sturEur ?? null);
  const steuerung = num(input.steuerungEur ?? null);
  if (stur != null && steuerung != null) {
    out.push({
      formel: `Schritt 4 · sturer Speicher: ${vorzeichen(rundeKaufmaennisch(stur, 2))}`,
      herkunft: 'lädt jeden Überschuss, deckt jeden Bedarf, kennt keine Preise, hält nie für später',
    });
    out.push({
      formel: `Schritt 5 · Steuerung: ${differenz(rundeKaufmaennisch(saved, 2), rundeKaufmaennisch(stur, 2))} = ${vorzeichen(rundeKaufmaennisch(steuerung, 2))}`,
      herkunft: 'Preisfenster, Halten für den Abend, Abregelung',
      probe: { ist: rundeKaufmaennisch(saved, 2) - rundeKaufmaennisch(stur, 2), soll: steuerung },
    });
  } else if (input.splitReason === 'no_battery_data') {
    out.push({
      formel: 'Schritt 4 · Steuerung: —',
      herkunft:
        'ohne Kapazität sowie Lade- und Entladeleistung gibt es keinen Vergleichsspeicher: Speicher-Daten nachtragen ›',
    });
  }

  const delta = num(money.speicherDeltaKwh);
  const lambda = num(money.speicherWertCtKwh);
  const wert = num(money.speicherWertEur);
  if (delta != null && lambda != null && wert != null) {
    out.push({
      formel: `Planwert: ${fmtNum(Math.abs(delta), 'kWh')} × ${ct(lambda)} = ${eurAmount(Math.abs(rundeKaufmaennisch(wert, 2)))}`,
      herkunft:
        'Speicherenergie nach Ladestand × Wert einer gespeicherten Kilowattstunde laut Fahrplan — Einordnung, kein Abzug',
      probe: { ist: (Math.abs(delta) * lambda) / 100, soll: Math.abs(wert) },
    });
  }

  const geplant = num(input.geplantEur ?? null);
  if (geplant != null) {
    out.push({
      formel: `Fahrplan: ${vorzeichen(rundeKaufmaennisch(geplant, 2))} geplant`,
      herkunft: 'vorab geplante Speicher-Ersparnis des Fahrplans — eine Plan-Zahl, keine Messung',
    });
  }
  return out;
}
