/**
 * Die Liste der Bezugsgrößen und die Seite einer Bezugsgröße (UEMS AP-09 IP-9; Neubau nach dem Messen-Konzept m1 §6.8,
 * Captain-Freigabe 05.10.2026) - rein abgeleitet: die Werte aus `GET …/bezugsgroessen/{id}/werte`, die Flächen aus
 * `GET /api/v1/bezugsflaechen`, ein Stammdatum aus `…/stammdatum`.
 *
 * ⚠ Gerechnet wird an KEINEM Betrag: gezeigt wird der Dezimaltext des Servers mit Tausenderpunkt (`zahlDe`), ein
 * fehlender Wert ist der Strich bzw. „noch kein Wert“, nie 0. Gerechnet wird nur mit Kalendern und Reihenfolgen (welcher
 * Monat fällig ist, welcher Monatsname, wie die Kacheln stehen) - `bezugsgroessenUebersicht.test.ts` hält die Stellen fest.
 */
import type { Bezugsflaechen, Bezugsgroesse, BezugsgroesseStammdatum, BezugsgroesseWert, BezugsgroesseWerte } from './api';
import { schluesselVon, spanneVon, tagPlus } from './bezugsPeriode';
import { PERIODE, ortKey, type Ort } from './bezugsgroesseListe';
import { UEMS_TEMPERATUR_BEZOGEN } from './glossar';

/** Die Unterzeile des Titels: sie IST die Erklärung des Worts (Konzept §7, Stufe 1). */
export const KOPF_SATZ = 'Womit Sie Ihren Verbrauch vergleichen: Menge, Schichten, Wetter oder Fläche.';
export const WERTE_IMPORTIEREN = 'Werte importieren';
export const WERTE_IMPORTIEREN_HINWEIS = 'CSV-Datei';
export const IMPORT_PROTOKOLL = 'Import-Protokoll';
export const ARCHIVIERTE_ZEIGEN = 'Archivierte zeigen';
export const ARCHIVIERTE_AUSBLENDEN = 'Archivierte ausblenden';
export const WERT_EINTRAGEN = 'Wert eintragen';
export const EINTRAGEN = 'Eintragen';
export const ALLE_BEZUGSGROESSEN = 'Alle Bezugsgrößen';
export const ARCHIVIEREN = 'Archivieren';
export const LADEFEHLER = { titel: 'Bezugsgrößen nicht geladen', satz: 'Die Bezugsgrößen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.' } as const;
export const WERTE_JE: Record<NonNullable<Bezugsgroesse['periode_art']>, string> = {
  tag: 'Werte je Tag',
  woche: 'Werte je Woche',
  monat: 'Werte je Monat',
  jahr: 'Werte je Jahr',
};
export const SPALTEN = { bezugsgroesse: 'Bezugsgröße', zustand: 'Zustand', woher: 'Woher' } as const;
export const FLAECHEN = { titel: 'Flächen', unter: 'aus dem Gebäudeplan, heute', aendern: 'Am Gebäude ändern', keine: 'nicht angegeben' } as const;
/** Eigene Angaben ohne Periode, die keine Fläche sind (Mitarbeitende, Zählerstände) - nie unter „Flächen“. */
export const WEITERE = { titel: 'Weitere Bezugsgrößen' } as const;
/** Einige Werte kamen nicht an: ehrlich sagen statt „alles eingetragen“, mit dem Weg zurück. */
export const NICHT_ALLE_ABRUFBAR = 'Einige Werte sind gerade nicht abrufbar.';
export const WOHER = {
  eingabe: 'von Hand eingetragen',
  import: 'importiert',
  messkanal: 'aus einem Messkanal',
  wetter: 'aus dem Wetter-Archiv',
  eigen: 'eigene Angabe',
  stand: 'Zählerstand',
} as const;
export const ZUSTAND = {
  bis: 'eingetragen bis {kurz}',
  fehlt: 'für {kurz} fehlt der Wert',
  keiner: 'noch kein Wert',
  archiviert: 'archiviert',
  /** Die Werte kamen nicht an - unbekannt, nicht „noch kein Wert“. */
  nichtAbrufbar: 'gerade nicht abrufbar',
} as const;
export const STATUS = {
  ok: 'Werte bis {periode} eingetragen',
  okOhnePeriode: 'Alle fälligen Werte eingetragen',
  fehltEiner: 'Für {periode} fehlt der Wert von {name}',
  fehlen: 'Für {periode} fehlen {n} Werte',
  fehlenSatz: '{namen} · Der Vergleich mit Ihrem Verbrauch braucht sie.',
  fehlenGemischt: 'Es fehlen {n} Werte',
} as const;

const fuell = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

const MONATE: Readonly<Record<string, [string, string]>> = {
  '01': ['Januar', 'Jan'], '02': ['Februar', 'Feb'], '03': ['März', 'Mär'], '04': ['April', 'Apr'],
  '05': ['Mai', 'Mai'], '06': ['Juni', 'Jun'], '07': ['Juli', 'Jul'], '08': ['August', 'Aug'],
  '09': ['September', 'Sep'], '10': ['Oktober', 'Okt'], '11': ['November', 'Nov'], '12': ['Dezember', 'Dez'],
};

/** Ein Dezimaltext des Servers zur Anzeige: „300000“ → „300.000“, „1130.5“ → „1.130,5“ - nie gerundet, nie gerechnet. */
export function zahlDe(betrag: string): string {
  const negativ = betrag.startsWith('-');
  const [ganz, bruch] = (negativ ? betrag.slice(1) : betrag).split('.');
  return `${negativ ? '−' : ''}${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${bruch ? `,${bruch}` : ''}`;
}

/** Die Periode eines Schlüssels: lang („September 2026“) oder kurz („Sep 2026“). */
export function periodeText(schluessel: string, art: string, kurz = false): string {
  if (art === 'monat') return `${MONATE[schluessel.slice(5, 7)][kurz ? 1 : 0]} ${schluessel.slice(0, 4)}`;
  if (art === 'woche') return `KW ${schluessel.slice(6).replace(/^0/, '')} ${schluessel.slice(0, 4)}`;
  if (art === 'tag') return `${schluessel.slice(8, 10)}.${schluessel.slice(5, 7)}.${schluessel.slice(0, 4)}`;
  return schluessel;
}

/** Eine Periode im Satz: „September 2026“, „2025“, „KW 42 2026“, aber „den 19.10.2026“. */
export const periodeImSatz = (schluessel: string, art: string): string =>
  art === 'tag' ? `den ${periodeText(schluessel, art)}` : periodeText(schluessel, art);

/** Die letzte abgeschlossene Periode vor `heute` (am 06.10.2026: September 2026) - die fällige. */
export function faelligePeriode(art: string, heute: string): string {
  const laufend = spanneVon(schluesselVon(heute, art), art)[0];
  return schluesselVon(tagPlus(laufend, -1), art);
}

export type BzTon = 'gut' | 'hinweis' | 'still';

/** Ein Wert mit seinem Text der Herkunft - die wirksame Fassung des Servers. */
export function woherDesWerts(w: BezugsgroesseWert): string {
  const f = w.fassungen.find((x) => x.fassung === w.wirksame_fassung) ?? [...w.fassungen].pop();
  if (!f) return WOHER.eingabe;
  if (f.herkunft.art === 'import') return WOHER.import;
  if (f.herkunft.art === 'messkanal') return f.kennzeichen.some((k) => k === UEMS_TEMPERATUR_BEZOGEN) ? WOHER.wetter : WOHER.messkanal;
  return WOHER.eingabe;
}

/** Die Werte mit Betrag, neueste zuerst (ohne zurückgenommene, deren Betrag `null` ist - nie 0). */
export const mitBetrag = (werte: readonly BezugsgroesseWert[]): BezugsgroesseWert[] =>
  werte.filter((w) => w.wirksamer_betrag !== null && w.periode_von !== null).sort((a, b) => (b.periode_von ?? '').localeCompare(a.periode_von ?? ''));

export interface BzReihe {
  id: string;
  kennzeichen: string;
  name: string;
  /** „Halle 2 · kg je Monat“ - wo sie gilt und was sie zählt. */
  unter: string;
  ton: BzTon;
  zustand: string;
  woher: string;
  /** Der letzte Wert („300.000“ + „kg“); `null` = der Strich. */
  wert: { zahl: string; einheit: string } | null;
  /** „Sep 2026“ unter dem Wert, oder „Eintragen“ ohne Wert. */
  wann: string | null;
  eintragen: boolean;
  /**
   * Sind die Werte (bzw. das Stammdatum) da? `unterwegs` und `fehler` sagen nichts über den Wert - die Reihe zeigt ein
   * Skelett bzw. „gerade nicht abrufbar“, nie „noch kein Wert“ und nie „Eintragen“ (unbekannt ist keine Null).
   */
  abruf: 'da' | 'unterwegs' | 'fehler';
  /** Fehlt der Wert der fälligen Periode? (Statuszeile, Punkt im Warnton) */
  fehlt: boolean;
  /** Der Schlüssel der fälligen Periode (`2026-09`), wo es eine gibt. */
  faellig: string | null;
  periodeArt: Bezugsgroesse['periode_art'];
  wertart: Bezugsgroesse['wertart'];
  archiviert: boolean;
  original: Bezugsgroesse;
}

/** `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type WerteStand = BezugsgroesseWerte | 'fehler' | null;
export type StammStand = BezugsgroesseStammdatum | 'fehler' | null;

/** „Halle 2 · kg je Monat“ (Periodenwert) · „Halle 1 · m²“ (Stammdatum) · „Werk Ahrenberg · kWh · Zählerstand“. */
export function unterzeile(b: Bezugsgroesse): string {
  const was = b.periode_art ? `${b.einheit} je ${PERIODE[b.periode_art]}` : b.wertart === 'stand' ? `${b.einheit} · ${WOHER.stand}` : b.einheit;
  return `${b.geltung_name} · ${was}`;
}

/** Das Stammdatum, das heute gilt (das Intervall, das `heute` enthält und nicht aufgehoben ist). */
export function stammHeute(s: BezugsgroesseStammdatum, heute: string): BezugsgroesseStammdatum['intervalle'][number] | null {
  return s.intervalle.find((i) => i.aufgehoben_am === null && i.gueltig_ab <= heute && (i.gueltig_bis === null || i.gueltig_bis >= heute)) ?? null;
}

/** Eine Bezugsgröße als Reihe der Liste: was sie zählt, ob der fällige Wert da ist, der letzte Wert. */
export function bzReihe(b: Bezugsgroesse, werte: WerteStand, stamm: StammStand, heute: string): BzReihe {
  const basis = {
    id: b.id,
    kennzeichen: b.kennzeichen,
    name: b.name,
    unter: unterzeile(b),
    periodeArt: b.periode_art,
    wertart: b.wertart,
    archiviert: b.archiviert_am !== null,
    original: b,
  };
  if (b.wertart === 'stammdatum') {
    // Ein Stammdatum ist immer eine eigene Angabe: die Flächen des Gebäudeplans sind keine Bezugsgrößen (eigene Liste
    // `bezugsflaechen`, die Kacheln); `schreibbar` ist hier nur `false`, sobald die Bezugsgröße archiviert ist.
    if (stamm === null || stamm === 'fehler') return unbekannt(basis, stamm === null ? 'unterwegs' : 'fehler', null);
    const jetzt = stammHeute(stamm, heute);
    return {
      ...basis,
      ton: jetzt && !basis.archiviert ? 'gut' : 'still',
      zustand: basis.archiviert ? ZUSTAND.archiviert : jetzt ? fuell(GUELTIG_AB_TAG, { tag: periodeText(jetzt.gueltig_ab, 'tag') }) : ZUSTAND.keiner,
      woher: WOHER.eigen,
      wert: jetzt ? { zahl: zahlDe(jetzt.wert), einheit: b.einheit } : null,
      wann: null,
      eintragen: !jetzt && stamm.schreibbar && !basis.archiviert,
      abruf: 'da',
      fehlt: false,
      faellig: null,
    };
  }
  const art = b.periode_art;
  const faellig = art ? faelligePeriode(art, heute) : null;
  if (werte === null || werte === 'fehler') return unbekannt(basis, werte === null ? 'unterwegs' : 'fehler', faellig);
  const liste = mitBetrag(werte.werte);
  const letzter = liste[0] ?? null;
  // Fällig ist der Wert erst, wenn die Bezugsgröße vor dem Ende der Periode schon bestand.
  const erwartet = faellig !== null && art !== null && b.angelegt_am.slice(0, 10) <= spanneVon(faellig, art)[1] && !basis.archiviert;
  const da = faellig !== null && art !== null && liste.some((w) => w.periode_von === spanneVon(faellig, art)[0]);
  const fehlt = erwartet && !da;
  const letzterSchluessel = letzter?.periode_von && art ? schluesselVon(letzter.periode_von, art) : null;
  return {
    ...basis,
    ton: fehlt ? 'hinweis' : letzter ? 'gut' : 'still',
    zustand: basis.archiviert
      ? ZUSTAND.archiviert
      : fehlt && faellig && art
        ? fuell(ZUSTAND.fehlt, { kurz: periodeText(faellig, art, true) })
        : letzterSchluessel && art
          ? fuell(ZUSTAND.bis, { kurz: periodeText(letzterSchluessel, art, true) })
          : ZUSTAND.keiner,
    woher: letzter ? woherDesWerts(letzter) : b.wertart === 'stand' ? WOHER.stand : WOHER.eingabe,
    wert: letzter?.wirksamer_betrag ? { zahl: zahlDe(letzter.wirksamer_betrag), einheit: b.einheit } : null,
    wann: letzterSchluessel && art ? periodeText(letzterSchluessel, art, true) : null,
    eintragen: !letzter && !basis.archiviert,
    abruf: 'da',
    fehlt,
    faellig,
  };
}

/** Eine Reihe, deren Werte unterwegs oder nicht abrufbar sind: kein Wert, kein „Eintragen“, kein „fehlt“ - nur der Stand. */
function unbekannt(basis: Pick<BzReihe, 'id' | 'kennzeichen' | 'name' | 'unter' | 'periodeArt' | 'wertart' | 'archiviert' | 'original'>, abruf: 'unterwegs' | 'fehler', faellig: string | null): BzReihe {
  return {
    ...basis,
    ton: 'still',
    zustand: basis.archiviert ? ZUSTAND.archiviert : abruf === 'fehler' ? ZUSTAND.nichtAbrufbar : '',
    woher: '',
    wert: null,
    wann: null,
    eintragen: false,
    abruf,
    fehlt: false,
    faellig,
  };
}

const GUELTIG_AB_TAG = 'gilt seit {tag}';

/**
 * Die Statuszeile: ruhig „Werte bis September 2026 eingetragen“ - oder der Hinweis, was fehlt, mit dem Schritt. Solange
 * die Werte einer fälligen Reihe unterwegs oder nicht abrufbar sind, sagt sie NICHTS: unbekannt ist nie „eingetragen“.
 */
export function bzStatus(reihen: readonly BzReihe[]): { ton: 'ok' | 'hinweis'; text: string; satz: string | null; ziel: BzReihe | null } | null {
  const faellige = reihen.filter((r) => !r.archiviert && r.wertart === 'periodenwert' && r.faellig !== null);
  if (faellige.length === 0 || faellige.some((r) => r.abruf !== 'da')) return null;
  const fehlen = faellige.filter((r) => r.fehlt);
  const arten = [...new Set(faellige.map((r) => `${r.periodeArt}|${r.faellig}`))];
  const einePeriode = arten.length === 1 ? { art: faellige[0].periodeArt as string, schluessel: faellige[0].faellig as string } : null;
  const periode = einePeriode ? periodeText(einePeriode.schluessel, einePeriode.art) : null;
  if (fehlen.length === 0) {
    return { ton: 'ok', text: periode ? fuell(STATUS.ok, { periode }) : STATUS.okOhnePeriode, satz: null, ziel: null };
  }
  const p = periodeImSatz(fehlen[0].faellig as string, fehlen[0].periodeArt as string);
  // Fehlen Werte verschiedener Perioden (ein Tag, ein Monat), nennt der Satz die Zahl und die Namen je mit Periode.
  if (new Set(fehlen.map((r) => `${r.periodeArt}|${r.faellig}`)).size > 1) {
    return {
      ton: 'hinweis',
      text: fuell(STATUS.fehlenGemischt, { n: fehlen.length }),
      satz: fuell(STATUS.fehlenSatz, { namen: fehlen.map((r) => `${r.name} (${periodeText(r.faellig as string, r.periodeArt as string)})`).join(', ') }),
      ziel: fehlen[0],
    };
  }
  return fehlen.length === 1
    ? { ton: 'hinweis', text: fuell(STATUS.fehltEiner, { periode: p, name: fehlen[0].name }), satz: null, ziel: fehlen[0] }
    : {
        ton: 'hinweis',
        text: fuell(STATUS.fehlen, { periode: p, n: fehlen.length }),
        satz: fuell(STATUS.fehlenSatz, { namen: fehlen.map((r) => r.name).join(', ') }),
        ziel: fehlen[0],
      };
}

/** Die Reihen in Gruppen je Periode („Werte je Monat“), in der Reihenfolge Monat · Jahr · Woche · Tag, je nach Kennzeichen. */
export function bzGruppen(reihen: readonly BzReihe[]): { art: NonNullable<Bezugsgroesse['periode_art']>; titel: string; reihen: BzReihe[] }[] {
  const reihenfolge: NonNullable<Bezugsgroesse['periode_art']>[] = ['monat', 'jahr', 'woche', 'tag'];
  const nachKz = (a: BzReihe, b: BzReihe) => a.kennzeichen.localeCompare(b.kennzeichen, 'de', { numeric: true });
  return reihenfolge
    .map((art) => ({ art, titel: WERTE_JE[art], reihen: reihen.filter((r) => r.periodeArt === art && r.wertart === 'periodenwert').sort(nachKz) }))
    .filter((g) => g.reihen.length > 0);
}

const nachKennzeichen = (a: BzReihe, b: BzReihe) => a.kennzeichen.localeCompare(b.kennzeichen, 'de', { numeric: true });

/** Eigene Flächen-Angaben: Bezugsgrößen der Art Bezugsfläche - sie stehen unter den Flächen des Gebäudeplans. */
export const bzEigeneFlaechen = (reihen: readonly BzReihe[]): BzReihe[] =>
  reihen.filter((r) => r.wertart !== 'periodenwert' && r.original.art === 'bezugsflaeche').sort(nachKennzeichen);

/** Die übrigen Reihen ohne Periode (Mitarbeitende, Zählerstände): eine eigene Gruppe, nie unter „Flächen“. */
export const bzWeitere = (reihen: readonly BzReihe[]): BzReihe[] =>
  reihen.filter((r) => r.wertart !== 'periodenwert' && r.original.art !== 'bezugsflaeche').sort(nachKennzeichen);

/** Wie die Angabe eines Stammdatums im Dialog heißt: „Fläche“, sonst der Name seiner Art („Mitarbeitende“). */
export const stammWort = (b: Pick<Bezugsgroesse, 'art'>, artName: string | null): string =>
  b.art === 'bezugsflaeche' ? 'Fläche' : artName ?? 'Wert';

export interface FlaecheKachel {
  key: string;
  name: string;
  kennzeichen: string | null;
  /** „8.450“; `null` = nicht angegeben (nie 0). */
  wert: string | null;
  einheit: string;
  /** Wohin „ändern“ führt: die Gebäude des Standorts. */
  standort: string | null;
}

/** Die Flächen aus dem Gebäudeplan: je Standort und Gebäude eine Kachel mit dem Wert von heute. */
export function flaechenKacheln(f: Bezugsflaechen | null, orte: Ort[]): FlaecheKachel[] {
  if (!f) return [];
  const kacheln = f.bezugsflaechen.map(({ bezugsflaeche: b, perioden }): FlaecheKachel & { istStandort: boolean } => {
    const p = [...perioden].pop();
    return {
      key: ortKey(b.geltung_art, b.geltung_id),
      name: b.geltung_name,
      kennzeichen: b.geltung_kennzeichen,
      wert: p?.betrag ? zahlDe(p.betrag) : null,
      einheit: b.einheit,
      standort: b.geltung_art === 'standort' ? b.geltung_id : orte.find((o) => o.key === ortKey(b.geltung_art, b.geltung_id))?.standort ?? null,
      istStandort: b.geltung_art === 'standort',
    };
  });
  // Je Standort zusammen: erst der Standort, dann seine Gebäude und Bereiche (Konzept: „Werk Ahrenberg · Halle 1 · …“).
  const gruppen = new Map<string | null, FlaecheKachel[]>();
  for (const { istStandort, ...k } of kacheln) {
    const g = gruppen.get(k.standort) ?? [];
    if (istStandort) g.unshift(k);
    else g.push(k);
    gruppen.set(k.standort, g);
  }
  return [...gruppen.values()].flat();
}

const ZWOELF = Array.from({ length: 12 });

/** Der Wert einer Periode für die Balken der Seite - `null` ohne Wert (eine Lücke, nie 0). */
export function zwoelfPerioden(werte: readonly BezugsgroesseWert[], art: string, bis: string): { schluessel: string; betrag: string | null }[] {
  const out: { schluessel: string; betrag: string | null }[] = [];
  let k = bis;
  for (const _ of ZWOELF) {
    const von = spanneVon(k, art)[0];
    const w = werte.find((x) => x.periode_von === von && x.wirksamer_betrag !== null);
    out.unshift({ schluessel: k, betrag: w?.wirksamer_betrag ?? null });
    k = schluesselVon(tagPlus(von, -1), art);
  }
  return out;
}

/** Der Anfangsbuchstabe eines Monats unter dem Balken („S“), sonst der kurze Schlüssel. */
export const balkenMarke = (schluessel: string, art: string): string =>
  art === 'monat' ? MONATE[schluessel.slice(5, 7)][0].charAt(0) : art === 'jahr' ? schluessel.slice(2) : periodeText(schluessel, art, true);

/** Die Vorjahresperiode eines Schlüssels (Monat: derselbe Monat ein Jahr früher), sonst `null`. */
export const vorjahr = (schluessel: string, art: string): string | null =>
  art === 'monat' ? `${Number(schluessel.slice(0, 4)) - 1}${schluessel.slice(4)}` : art === 'jahr' ? String(Number(schluessel) - 1) : null;

/** Suche erst ab dieser Zahl von Bezugsgrößen (Konzept §6.8: „ab etwa zwölf Einträgen“). */
export const SUCHE_AB = 12;
