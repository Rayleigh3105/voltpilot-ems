/**
 * Die Seite einer Messstelle nach Konzept Messen m1 (§6.4/§6.5, Captain-Freigabe 05.10.2026; Messen-Bau m2 PR2) - die
 * reine Hälfte. Oben steht, ob die Messstelle aktuell ist und was zu tun ist; darunter der Verbrauch als Kachel, die
 * Monate als Balken, die Ablesungen, die Zuordnung und woher die Werte kommen. `pages/MessstelleSeite.tsx` und ihre
 * Karten rendern nur, was hier entschieden wird.
 *
 * ⚠ KEINE EIGENE RECHNUNG. Jede Menge und jeder Zustand kommt aus der Werte-Route und spricht über den Ergebnis-Vertrag
 * (`uemsWerteKarte.anzeige`); der Vergleich mit dem Vorjahr rechnet ausschließlich der Bericht-Zwilling
 * (`uemsBericht.vergleich`), die Frist der nächsten Ablesung ist die des Registers (`quelle.ablesung.faellig_ab`).
 * Rein: kein Netz, keine Uhr, kein React.
 */
import type {
  Ablesung,
  Messstelle,
  MessstelleRegisterZeile,
  MessstelleWerte,
  MessstelleWerteWert,
} from './api';
import type { KachelTon } from './components/kacheln/Kachel';
import {
  UEMS_ABLESUNG_EINTRAGEN,
  UEMS_MESSSTELLE,
  UEMS_NAECHSTE_ABLESUNG,
  UEMS_WEG_GERAET,
  UEMS_ZUORDNUNG,
} from './glossar';
import { lebenszyklusWort, type Lebenszyklus } from './messstellen';
import { standWann, standZahl } from './messstellenListe';
import { MONATE } from './picker/datum';
import { vergleich as berichtVergleich } from './uemsBericht';
import { ANZEIGE_EINHEITEN, OHNE_ZAHL, pruefeMenge } from './uemsErgebnis';
import { lokalerTag, type Tag } from './uemsOrtsbaum';
import { anzeige, karte, monatTitel, type QuellenNamen } from './uemsWerteKarte';

// -------------------------------------------------------------------- Wörter

export const ABLESUNG_EINTRAGEN = UEMS_ABLESUNG_EINTRAGEN;
export const ZAEHLERSTAND = 'Zählerstand';
export const NAECHSTE_ABLESUNG = UEMS_NAECHSTE_ABLESUNG;
export const IM_PLAN = 'im Plan';
export const UEBERFAELLIG = 'überfällig';
export const SPAETESTENS = 'spätestens; danach gilt sie als überfällig';
export const ZUORDNUNG = UEMS_ZUORDNUNG;
export const WAS_HEISST_DAS = 'Was heißt das?';
export const AENDERN = 'Ändern';
export const ABLESUNGEN = 'Ablesungen';
export const AUS_ABLESUNGEN = 'aus Ablesungen';
export const VOM_GERAET = 'vom Gerät';
export const BERECHNET = 'berechnet';
export const ZAEHLER_VERBINDEN = 'Zähler mit Gerät verbinden (Quelle binden)';
export const QUELLE_BINDEN = 'Quelle binden';
export const KORREKTUREN_UND_ERSATZWERTE = 'Korrekturen und Ersatzwerte';
export const ZUSAMMENGESETZT_AUS = 'Zusammengesetzt aus';
export const FORMEL_AENDERN = 'Formel ändern';
export const MONATLICH = 'monatlich';
export const NOCH_KEINE_QUELLE_TITEL = 'Noch keine Quelle';
export const NOCH_KEINE_QUELLE_SATZ = 'Werte kommen, sobald Sie einen Zähler verbinden oder eine Ablesung eintragen.';
export const AUS_ANDEREN_MESSSTELLEN = 'Aus anderen Messstellen berechnet';
export const GGU_VORJAHR = 'ggü. Vorjahr';
export const UNVERAENDERT = 'unverändert';

/**
 * „Für April 2029 fehlt noch die Ablesung.“ - ein Zeitraum des Ablesezählers ohne Ablesung (Konzept §8.1: statt „Die
 * Werte kommen aus Ablesungen. Ein Monat summiert ganze Ablesezeiträume …“).
 */
export function ablesungFehltSatz(art: string, wert: string): string {
  return art === 'jahr' ? `Für ${wert} fehlen noch die Ablesungen.` : `Für ${monatTitel(`${wert.slice(0, 7)}-01`)} fehlt noch die Ablesung.`;
}

/** „Alle 25“ - der Weg zu den älteren Ablesungen. */
export const alleText = (n: number): string => `Alle ${n}`;

// -------------------------------------------------------------------- Rolle

/** Was die Hauptgröße einer Messstelle ist, in einem Wort - und der Ton ihrer Kachel und Balken. */
export interface Rolle {
  wort: string;
  ton: KachelTon;
}

const ROLLEN: Readonly<Record<string, Rolle>> = {
  Bezug: { wort: 'Verbrauch', ton: 'load' },
  Abgabe: { wort: 'Einspeisung', ton: 'grid' },
  Erzeugung: { wort: 'Erzeugung', ton: 'pv' },
  Laden: { wort: 'Laden', ton: 'batt' },
  Entladen: { wort: 'Entladen', ton: 'batt' },
  'Laden / Entladen': { wort: 'Speicher', ton: 'batt' },
  saldiert: { wort: 'Saldo', ton: 'neutral' },
};

/** „Verbrauch“ für einen Bezug, „Erzeugung“ für PV - sonst die Größe selbst, ohne Rollenfarbe. */
export function rolle(h: { groesse: string; richtung: string } | null | undefined): Rolle {
  return (h && ROLLEN[h.richtung]) ?? { wort: h?.groesse ?? 'Werte', ton: 'neutral' };
}

/** Eine Menge je Zeitraum gibt es nur für einen Zählerstand oder eine Intervallmenge - nie für eine Leistung. */
export function hatMenge(h: { wertart: string } | null | undefined): boolean {
  return h?.wertart === 'Zählerstand' || h?.wertart === 'Intervallmenge';
}

// -------------------------------------------------------------------- Woher die Werte kommen

/** Der Weg der Werte, wie die Seite ihn liest: aus dem Register von heute. */
export type Herkunft = 'geraet' | 'ablesung' | 'berechnet' | 'keine';

export function herkunftAus(zeile: MessstelleRegisterZeile | null, m: Pick<Messstelle, 'art'>): Herkunft {
  if (m.art === 'berechnet' || zeile?.quelle.stand === 'berechnet') return 'berechnet';
  if (zeile?.quelle.stand === 'gebunden') return 'geraet';
  if (zeile?.quelle.stand === 'ablesung') return 'ablesung';
  return 'keine';
}

// -------------------------------------------------------------------- Kopf

export interface SeitenKopf {
  titel: string;
  kennzeichen: string;
  /** „Strom · Halle 2 · Werk Ahrenberg“ - Medium und wo die Messstelle hängt. */
  unter: string;
  /** Der Lebenszyklus nur, wenn er nicht „aktiv“ ist (Konzept §6.2 „Begriffe“). */
  lebenszyklus: string | null;
}

export function seitenKopf(m: Messstelle, zeile: MessstelleRegisterZeile | null): SeitenKopf {
  const ort = zeile?.ort.name ?? null;
  const standort = zeile?.ort.standort_name ?? null;
  return {
    titel: m.name ?? `${UEMS_MESSSTELLE} ohne Namen`,
    kennzeichen: m.kennzeichen,
    unter: [zeile?.medium ?? m.medium, ort, standort !== ort ? standort : null]
      .filter((t): t is string => Boolean(t))
      .join(' · '),
    lebenszyklus: m.lebenszyklus === 'aktiv' ? null : lebenszyklusWort(m.lebenszyklus as Lebenszyklus),
  };
}

export type Ton = 'ok' | 'warn' | 'off';

export interface StatusZeile {
  ton: Ton;
  /** Der Satz des Servers, wörtlich („Abgelesen am 01.10.2026“, „Liefert keine Daten seit 14:15“). */
  text: string;
  /** Bei Ablesungen im Plan: „nächste bis 01.12.2026“. */
  neben: string | null;
}

/**
 * Die Statuszeile unter dem Kopf: der Satz des Registers mit seinem Punkt. Ohne Beobachtung (eine berechnete Messstelle)
 * spricht die Berechnung („vollständig“/„unvollständig seit …“); ohne beides steht keine Zeile.
 */
export function statusZeile(zeile: MessstelleRegisterZeile | null, zone: string): StatusZeile | null {
  if (!zeile) return null;
  const b = zeile.beobachtung;
  if (b) {
    const ton: Ton = b.zustand === 'liefert' ? 'ok' : b.zustand === 'liefert_nicht_seit' ? 'warn' : 'off';
    const faellig = zeile.quelle.ablesung?.faellig_ab;
    const neben = zeile.quelle.stand === 'ablesung' && ton === 'ok' && faellig ? `nächste bis ${tagText(faellig, zone)}` : null;
    return { ton, text: b.text, neben };
  }
  if (zeile.berechnung) {
    return { ton: zeile.berechnung.zustand === 'vollstaendig' ? 'ok' : 'warn', text: zeile.berechnung.text, neben: null };
  }
  return null;
}

/** „01.12.2026“ eines Zeitpunkts in der Zone der Messstelle. */
export function tagText(zeitpunkt: string, zone: string): string {
  const [j, m, t] = lokalerTag(zeitpunkt, zone).split('-');
  return `${t}.${m}.${j}`;
}

// -------------------------------------------------------------------- Monate

/** Der letzte vollständige Monat am Tag `heute` (`JJJJ-MM`). */
export function letzterVollerMonat(heute: Tag): string {
  return monatPlus(heute.slice(0, 7), -1);
}

/** `JJJJ-MM` plus `n` Monate. */
export function monatPlus(monat: string, n: number): string {
  const [j, m] = monat.split('-').map(Number);
  const z = j * 12 + (m - 1) + n;
  return `${Math.floor(z / 12)}-${String((z % 12) + 1).padStart(2, '0')}`;
}

/** Der erste Tag eines Monats und der letzte (`JJJJ-MM-TT`, einschließlich) - wie die Zeit-Leiste fragt. */
export function monatsTage(von: string, bis: string): { von: Tag; bis: Tag } {
  const [j, m] = bis.split('-').map(Number);
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return { von: `${von}-01`, bis: `${bis}-${String(letzter).padStart(2, '0')}` };
}

/**
 * Womit die Werte öffnen (Konzept §6.4 „Zustände“: startet beim letzten vollständigen Monat): im Monat davor - es sei
 * denn, die Messstelle hat dort noch keine Quelle (eine eben eingerichtete). Dann öffnet sie im laufenden Monat, wo es
 * schon Werte gibt; eine Messstelle mit Gerät dann am heutigen Tag.
 */
export function werteStart(e: {
  heute: Tag;
  herkunft: Herkunft;
  /** Der Beginn der ersten führenden Quelle (`JJJJ-MM-TT`), soweit bekannt. */
  quelleSeit: Tag | null;
}): { art: 'tag' | 'monat'; wert: string } {
  const voll = letzterVollerMonat(e.heute);
  const naechster = `${monatPlus(voll, 1)}-01`;
  if (e.quelleSeit === null || e.quelleSeit < naechster) return { art: 'monat', wert: voll };
  return e.herkunft === 'geraet' ? { art: 'tag', wert: e.heute } : { art: 'monat', wert: e.heute.slice(0, 7) };
}

/** Der Monat eines Schritts der Route (`JJJJ-MM`) - aus der Beschriftung der Periode, nie aus der Uhr. */
const monatDes = (w: MessstelleWerteWert): string => w.von.slice(0, 7);

/** Spricht der Schritt eine Zahl? Dieselbe Prüfung wie die Karte (`anzeige`), nie eine eigene. */
const spricht = (a: MessstelleWerte, w: MessstelleWerteWert): boolean => anzeige(a, w, false).zustand !== null && w.menge !== null;

/** „88.200“ und „kWh“ aus der angezeigten Zahl „88.200 kWh“ - getrennt für die große Zahl der Kachel. */
export function zahlUndEinheit(zahl: string): { wert: string; einheit: string } {
  const i = zahl.lastIndexOf(' ');
  return i < 0 ? { wert: zahl, einheit: '' } : { wert: zahl.slice(0, i), einheit: zahl.slice(i + 1) };
}

/** Ein Balken: ein Monat der Reihe, seine Zahl, seine Höhe (0…1 auf EINER Skala) und ob er gewählt ist. */
export interface Balken {
  monat: string;
  /** „O“, „N“, „D“ … - die Achse. */
  kurz: string;
  /** „Oktober 2026“ */
  titel: string;
  /** „88.200 kWh“ oder „—“. */
  zahl: string;
  /** `null` = kein Wert - kein Balken, nie eine 0. */
  hoehe: number | null;
  zustand: string | null;
  gewaehlt: boolean;
}

/** Die Monate der Reihe als Balken auf einer Skala; der gewählte Monat ist der kräftige. */
export function balken(serie: MessstelleWerte, gewaehlt: string): Balken[] {
  const zeilen = serie.werte.map((w) => ({ w, a: anzeige(serie, w, false) }));
  const zahlen = zeilen.map(({ w, a }) => (a.zustand !== null && w.menge !== null ? Math.max(0, w.menge) : null));
  const max = Math.max(0, ...zahlen.filter((z): z is number => z !== null));
  return zeilen.map(({ w, a }, i) => {
    const monat = monatDes(w);
    const z = zahlen[i];
    return {
      monat,
      kurz: MONATE[Number(monat.slice(5, 7)) - 1].slice(0, 1),
      titel: monatTitel(w.von),
      zahl: a.zahl,
      hoehe: z === null ? null : max > 0 ? z / max : 0,
      zustand: a.zustand,
      gewaehlt: monat === gewaehlt,
    };
  });
}

// -------------------------------------------------------------------- Kacheln

export interface Marke {
  text: string;
  ton: 'neutral' | 'plan' | 'ok' | 'warn';
}

export interface LeitKachel {
  /** „Verbrauch · September 2026“ */
  name: string;
  ton: KachelTon;
  wert: string;
  einheit: string;
  /** „unverändert ggü. Vorjahr“ · „▲ 3 % ggü. Vorjahr“ - nur, wo beide Monate eine Zahl haben. */
  marke: Marke | null;
  /** Die zwölf Monate bis zum Monat der Kachel; `null` = kein Wert (eine Lücke, keine 0). */
  verlauf: (number | null)[];
  /** „September 2025: 88.200 kWh · aus Ablesungen“ */
  unter: string;
  /**
   * Fehlt die Zahl des Monats: beim Ablesezähler der Satz und der Schritt (Konzept §6.4 „Zustände“), sonst der Grund
   * der Route (z. B. „Die Quelle deckt den Zeitraum nur zum Teil …“), wo sie einen nennt.
   */
  fehlt: { satz: string; schritt: string | null } | null;
}

const HERKUNFT_WORT: Readonly<Record<Herkunft, string | null>> = {
  ablesung: AUS_ABLESUNGEN,
  geraet: VOM_GERAET,
  berechnet: BERECHNET,
  keine: null,
};

/**
 * Die Leitkachel (Konzept §6.4 Punkt 4): die Menge des Monats in der Rolle der Messstelle, der Vergleich mit dem
 * Vorjahresmonat, der Verlauf über zwölf Monate. `serie` ist die Antwort der Route im Raster `monat` über die
 * dreizehn Monate bis `monat` (die Route liefert jeden Monat, auch ohne Wert).
 */
export function leitKachel(e: {
  serie: MessstelleWerte;
  monat: string;
  rolle: Rolle;
  herkunft: Herkunft;
  /** Darf hier eingetragen werden (Recht, nicht archiviert, nicht „Stand am“)? Sonst ohne Schritt. */
  ablesenMoeglich: boolean;
  /** Die Namen der Bindungen (`quellenNamen`) - nur der Grund-Satz braucht sie. */
  namen?: QuellenNamen;
}): LeitKachel {
  const { serie, monat } = e;
  const jetzt = serie.werte.find((w) => monatDes(w) === monat) ?? null;
  const vorjahr = serie.werte.find((w) => monatDes(w) === monatPlus(monat, -12)) ?? null;
  const zahl = jetzt ? anzeige(serie, jetzt, false).zahl : OHNE_ZAHL;
  const { wert, einheit } = zahlUndEinheit(zahl);
  const zwoelf = Array.from({ length: 12 }, (_, i) => monatPlus(monat, i - 11));
  const verlauf = zwoelf.map((m) => {
    const w = serie.werte.find((x) => monatDes(x) === m);
    return w && spricht(serie, w) ? Math.max(0, w.menge!) : null;
  });
  const vjZahl = vorjahr ? anzeige(serie, vorjahr, false).zahl : OHNE_ZAHL;
  const woher = HERKUNFT_WORT[e.herkunft];
  const unter = [
    `${monatTitel(`${monatPlus(monat, -12)}-01`)}: ${vjZahl === OHNE_ZAHL ? 'keine Werte' : vjZahl}`,
    woher,
  ]
    .filter(Boolean)
    .join(' · ');
  const hatZahl = jetzt !== null && spricht(serie, jetzt);
  return {
    name: `${e.rolle.wort} · ${monatTitel(`${monat}-01`)}`,
    ton: e.rolle.ton,
    wert: hatZahl ? wert : OHNE_ZAHL,
    einheit: hatZahl ? einheit : '',
    marke: hatZahl && vorjahr && spricht(serie, vorjahr) ? vorjahrMarke(serie, jetzt!, vorjahr) : null,
    verlauf,
    unter,
    fehlt: hatZahl
      ? null
      : e.herkunft === 'ablesung'
        ? {
            satz: `Für ${MONATE[Number(monat.slice(5, 7)) - 1]} fehlt noch die Ablesung.`,
            schritt: e.ablesenMoeglich ? ABLESUNG_EINTRAGEN : null,
          }
        : grundDes(serie, jetzt, e.namen),
  };
}

/** Der Grund der Route für einen Monat ohne Zahl - derselbe Satz wie in der Zeile des Monats (`karte`), ohne Schritt. */
function grundDes(serie: MessstelleWerte, w: MessstelleWerteWert | null, namen: QuellenNamen = {}): LeitKachel['fehlt'] {
  const satz = w ? karte({ ...serie, werte: [w] }, namen)?.grund : null;
  return satz ? { satz, schritt: null } : null;
}

/** Der Vorjahresvergleich - gerechnet im Bericht-Zwilling, hier nur das Wort und der Pfeil (Anzeige ganz in %). */
function vorjahrMarke(serie: MessstelleWerte, jetzt: MessstelleWerteWert, vorjahr: MessstelleWerteWert): Marke | null {
  const gespeichert = serie.messstelle.einheit;
  if (pruefeMenge(gespeichert, serie.raster).length > 0) return null;
  const angezeigt = ANZEIGE_EINHEITEN.find((x) => x.gespeichert === gespeichert)?.angezeigt ?? gespeichert;
  const v = berichtVergleich({
    aktuell: String(jetzt.menge),
    vergleich: String(vorjahr.menge),
    einheit: angezeigt,
    ebene: serie.raster,
    grund: null,
  });
  if (v.prozent === null) return null;
  const p = Math.round(Number(v.prozent));
  if (p === 0) return { text: `${UNVERAENDERT} ${GGU_VORJAHR}`, ton: 'neutral' };
  return { text: `${p > 0 ? '▲' : '▼'} ${Math.abs(p)} % ${GGU_VORJAHR}`, ton: 'neutral' };
}

export interface StandKachel {
  wert: string;
  einheit: string;
  /** „abgelesen am 01.10.2026“ · „Stand 17:30“ */
  unter: string;
}

/**
 * „Zählerstand 3.284.100 kWh · abgelesen am 01.10.2026“ - der letzte Wert des Registers, nur bei einem Zählerstand.
 * `jetzt` ist der Zeitpunkt des Registers: am selben Tag nennt ein Gerätewert nur die Uhrzeit („Stand 17:30“).
 */
export function standKachel(zeile: MessstelleRegisterZeile | null, zone: string, jetzt: string): StandKachel | null {
  const lw = zeile?.letzter_wert;
  if (!zeile || zeile.hauptgroesse.wertart !== 'Zählerstand' || !lw || lw.wert === null) return null;
  return {
    wert: standZahl(lw.wert, lw.einheit),
    einheit: lw.einheit ?? '',
    unter: zeile.quelle.stand === 'ablesung' ? `abgelesen am ${tagText(lw.zeitpunkt, zone)}` : standWann(lw.zeitpunkt, zone, jetzt),
  };
}

export interface AblesungKachel {
  /** „01.12.“ und „2026“ - groß der Tag, klein das Jahr. */
  tag: string;
  jahr: string;
  marke: Marke;
  satz: string;
}

/**
 * „Nächste Ablesung 01.12.2026 · im Plan · spätestens; danach gilt sie als überfällig“ - die Frist des Registers
 * (`faellig_ab`), nur bei einem Ablesezähler. `jetzt` ist der Zeitpunkt des Registers.
 */
export function ablesungKachel(zeile: MessstelleRegisterZeile | null, zone: string, jetzt: string): AblesungKachel | null {
  const a = zeile?.quelle.ablesung;
  if (!zeile || zeile.quelle.stand !== 'ablesung' || !a?.faellig_ab) return null;
  const [j, m, t] = lokalerTag(a.faellig_ab, zone).split('-');
  const ueberfaellig = Date.parse(jetzt) >= Date.parse(a.faellig_ab);
  return {
    tag: `${t}.${m}.`,
    jahr: j,
    marke: ueberfaellig ? { text: UEBERFAELLIG, ton: 'warn' } : { text: IM_PLAN, ton: 'ok' },
    satz: ueberfaellig ? `seit ${t}.${m}.${j}; tragen Sie den Zählerstand ein` : SPAETESTENS,
  };
}

// -------------------------------------------------------------------- Ablesungen

export interface AblesungZeile {
  zeitpunkt: string;
  /** „01.10.“ und „2026“ - der Datumsblock. */
  tag: string;
  jahr: string;
  /** „3.284.100 kWh“ */
  stand: string;
  /** „zählt zu September 2026 · 88.200 kWh im Monat“ - der Monat, den die Ablesung schließt, und seine Menge. */
  neben: string;
  ablesung: Ablesung;
}

/**
 * Die wirksamen Ablesungen, die neueste zuerst (Konzept §6.4 Punkt 6). Eine Ablesung „zählt zu“ dem Monat, den ihr
 * Zeitraum schließt - so wie der Kunde ihn zugeordnet hat (`monat`); die Menge des Monats kommt aus der Monatsreihe
 * der Route, soweit sie ihn kennt. Die erste Ablesung ist der Anfangsstand und schließt keinen Zeitraum.
 */
export function ablesungZeilen(e: {
  wirksam: readonly Ablesung[];
  einheit: string;
  zone: string;
  serie: MessstelleWerte | null;
}): AblesungZeile[] {
  const sortiert = [...e.wirksam].sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt));
  const menge = (monat: string): string | null => {
    const w = e.serie?.werte.find((x) => monatDes(x) === monat);
    return e.serie && w && spricht(e.serie, w) ? anzeige(e.serie, w, false).zahl : null;
  };
  return sortiert
    .map((a, i) => {
      const [j, m, t] = lokalerTag(a.zeitpunkt, e.zone).split('-');
      const monat = a.monat?.slice(0, 7) ?? null;
      const imMonat = monat ? menge(monat) : null;
      const neben =
        i === 0
          ? 'Anfangsstand'
          : monat
            ? [`zählt zu ${monatTitel(`${monat}-01`)}`, imMonat ? `${imMonat} im Monat` : null].filter(Boolean).join(' · ')
            : 'keinem Monat zugeordnet';
      return { zeitpunkt: a.zeitpunkt, tag: `${t}.${m}.`, jahr: j, stand: `${standZahl(a.stand, e.einheit)} ${e.einheit}`, neben, ablesung: a };
    })
    .reverse();
}

// -------------------------------------------------------------------- Herkunft-Karte

export interface HerkunftKarte {
  herkunft: Herkunft;
  /** „Von Hand abgelesen“ · „Automatisch von einem Gerät“ · „Aus anderen Messstellen berechnet“ · „Noch keine Quelle“ */
  titel: string;
  /** „monatlich · 25 Ablesungen seit 01.10.2024“ */
  satz: string | null;
}

export function herkunftKarte(e: {
  herkunft: Herkunft;
  zeile: MessstelleRegisterZeile | null;
  zone: string;
  /** Die Zahl der wirksamen Ablesungen; `null` = nicht geladen. */
  ablesungen: number | null;
}): HerkunftKarte {
  if (e.herkunft === 'ablesung') {
    const seit = e.zeile?.quelle.ablesung?.seit;
    const anzahl =
      e.ablesungen === null ? null : `${e.ablesungen} ${e.ablesungen === 1 ? 'Ablesung' : 'Ablesungen'}${seit ? ` seit ${tagText(seit, e.zone)}` : ''}`;
    return { herkunft: 'ablesung', titel: 'Von Hand abgelesen', satz: [MONATLICH, anzahl].filter(Boolean).join(' · ') };
  }
  if (e.herkunft === 'geraet') {
    const f = e.zeile?.quelle.fuehrend;
    const seit = f ? `seit ${tagText(f.gueltig_ab, e.zone)}` : null;
    return { herkunft: 'geraet', titel: UEMS_WEG_GERAET, satz: seit };
  }
  if (e.herkunft === 'berechnet') return { herkunft: 'berechnet', titel: AUS_ANDEREN_MESSSTELLEN, satz: null };
  return { herkunft: 'keine', titel: NOCH_KEINE_QUELLE_TITEL, satz: NOCH_KEINE_QUELLE_SATZ };
}

// -------------------------------------------------------------------- Protokoll

/**
 * „3 Einträge · zuletzt 05.10.2026“ - der Verweis auf das Änderungsprotokoll. Die erste Seite kennt nicht alle Einträge:
 * gibt es mehr, steht „mehr als 20“.
 */
export function protokollSatz(anzahl: number, mehr: boolean, zuletzt: string | null, zone: string): string {
  const n = mehr ? `Mehr als ${anzahl} Einträge` : `${anzahl} ${anzahl === 1 ? 'Eintrag' : 'Einträge'}`;
  return zuletzt ? `${n} · zuletzt ${tagText(zuletzt, zone)}` : n;
}

/** „Stand 06.10.2026, 17:42“ - wann die Seite gelesen ist (am Fuß, Konzept Entscheid 6). */
export function standText(zeitpunkt: string, zone: string): string {
  const uhr = new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(zeitpunkt));
  return `Stand ${tagText(zeitpunkt, zone)}, ${uhr}`;
}

/** „Zeiten: Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg) · Stand 06.10.2026, 17:42“ - einmal am Fuß. */
export function fussSatz(zoneSatzText: string, zeitpunkt: string, zone: string): string {
  return `${zoneSatzText.replace(/^Zeiten in /, 'Zeiten: ')} · ${standText(zeitpunkt, zone)}`;
}
