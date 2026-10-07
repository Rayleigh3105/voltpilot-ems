import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import type { GeplanteReihe } from './geplanteMessstellen';
import { UEMS_MESSSTELLE, UEMS_NOCH_KEINE_QUELLE, UEMS_UNTERNEHMEN, UEMS_WOHER_DIE_WERTE } from './glossar';
import { alleFundstellen, hervorheben, normalisiereSuche, type Fundstellen, type TextTeil } from './picker/suche';
import {
  KEIN_ORT,
  TITEL,
  ablesungsZiele,
  zeitpunktText,
  type MessstellenEbene,
  type RegisterEintrag,
  type Ton,
  type ZeileWoerter,
} from './messstellen';
import { MONATE } from './picker/datum';
import { datumText, lokalerTag } from './uemsOrtsbaum';
import { OHNE_ZAHL, UNVOLLSTAENDIG } from './uemsErgebnis';
import { anzeige, monatTitel } from './uemsWerteKarte';

/**
 * DIE LISTE „Messstellen“ (Konzept Messen m1, §6.2/§6.3, Captain-Freigabe 05.10.2026): alle Zähler nach Ort, je mit
 * Zustand und Wert - und in Sekunden gefunden.
 *
 * Rein und deterministisch - kein React, kein Netz. Die Antwort des Registers (`GET /api/v1/messstellen`) bringt jede
 * Ableitung schon mit (Ort, Stellung, Quelle, Beobachtung, letzter Wert, Aggregat); `messstellen.ts` spricht daraus die
 * Wörter einer Zeile. Hier entsteht, was die neue Liste darüber hinaus braucht:
 *
 *  - die Gruppen je Ort (Gebäude, Bereich, Standort) in der Reihenfolge des Ortsbaums, im Ort der Hauptzähler zuerst;
 *  - die eine tolerante Suche (dieselbe Normalisierung wie überall, `picker/suche.ts`) über Name, Kennzeichen, Ort,
 *    Medium und das Gerät der führenden Quelle - nie die Anlage (MS-20 liegt in Halle 2, hängt aber an der Anlage
 *    Halle 1: ein Treffer für „halle 1“ wäre überraschend);
 *  - die Marken, die nur erscheinen, wenn es sie gibt, und zugleich filtern;
 *  - die Statuszeile („10 von 10 Messstellen liefern Daten“, der Satz des Servers) und ihre Hinweiskarten bei
 *    Handlungsbedarf (Status-Variante A der Übersicht);
 *  - woher die Werte einer Messstelle kommen: automatisch vom Gerät, von Hand abgelesen oder berechnet.
 *
 * Gesucht und gefiltert wird in der GELADENEN Antwort - keine Serveranfrage je Taste, auch nicht mit „Stand am“. Die
 * Filter der Adresse (`?ort=`, `?anlage=`) bleiben Parameter derselben Route (`registerAnfrage`).
 */

// ───────────────────────────────────────────────────────────── Wörter

/** Die Unterzeile des Titels: sie IST die Erklärung des Worts (Konzept §7, Stufe 1). */
export const KOPF_SATZ = 'Wo Ihr Verbrauch gemessen, abgelesen oder berechnet wird – nach Ort geordnet.';

export const SUCHE_LABEL = `${TITEL} suchen`;
export const SUCHE_PLATZHALTER = 'Name, Kennzeichen oder Ort …';
export const SUCHE_LEEREN = 'Suche leeren';
export const SUCHE_WORIN = 'Gesucht wird in Name, Kennzeichen, Ort und Gerät.';
export const AUCH_IN_ALLEN = `Auch in allen ${TITEL} suchen`;
export const MESSSTELLE_ANLEGEN = `${UEMS_MESSSTELLE} anlegen`;
export const STAND_AN_EINEM_TAG = 'Stand an einem Tag ansehen';
export const STAND_AN_EINEM_TAG_HINWEIS = 'Nur lesen, z. B. für eine Prüfung';
export const KORREKTUREN_AM_STANDORT = 'Korrekturen am Standort';
export const WEITERE_AKTIONEN = 'Weitere Aktionen';
export const ARCHIVIERT = 'Archiviert';
export const MARKEN_LABEL = 'Nur diese zeigen';
export const NOCH_KEINE_QUELLE = `${UEMS_NOCH_KEINE_QUELLE.charAt(0).toUpperCase()}${UEMS_NOCH_KEINE_QUELLE.slice(1)} · zuordnen`;

/** Der leere Satz einer Suche - mit dem Begriff, wie er getippt wurde. */
export const keineTreffer = (suche: string) => `Keine ${UEMS_MESSSTELLE} passt zu „${suche.trim()}“.`;

/** Woher die Werte einer Messstelle kommen (Konzept „Woher die Werte kommen“ statt „Quelle (führend)“). */
export type Weg = 'geraet' | 'ablesung' | 'berechnet' | 'ohne';

/** Die Wege in Kundensprache - in der Liste, auf der Seite der Messstelle und im Dialog dieselben Wörter. */
export const WEG_WORT: Record<Weg, string> = {
  geraet: 'automatisch vom Gerät',
  ablesung: 'von Hand abgelesen',
  berechnet: 'berechnet aus anderen Messstellen',
  ohne: UEMS_NOCH_KEINE_QUELLE,
};

/**
 * Am Telefon steht der Weg hinter dem Satz des Servers, wo der Satz ihn nicht schon sagt: „Liefert Daten · vom Gerät“;
 * „Abgelesen am 01.10.2026“ und „Ablesung überfällig seit …“ sagen ihn selbst.
 */
const WEG_KURZ: Record<Weg, string | null> = {
  geraet: 'vom Gerät',
  ablesung: null,
  berechnet: 'berechnet',
  ohne: null,
};

/** Der Rhythmus einer Ablesung (Z7: monatlich, nach zwei Monaten ohne Ablesung überfällig). */
const ABLESE_RHYTHMUS = 'monatlich';

/** Die Spalten der Reihen ab 760 px - dieselben Wörter wie am Telefon, nur nebeneinander. */
export const SPALTE = {
  messstelle: UEMS_MESSSTELLE,
  zustand: 'Zustand',
  woher: UEMS_WOHER_DIE_WERTE,
  stand: 'Letzter Stand',
} as const;

// ───────────────────────────────────────────────────────────── Suche

/**
 * Die Begriffe einer Suche, normalisiert wie überall (`picker/suche.ts`): jedes Wort muss passen (UND), und eine Zahl
 * ist ein eigener Begriff - „halle 1“, „Halle-1“ und „halle1“ suchen dasselbe (`['halle', '1']`), „MS-06“ und „ms 6“
 * ebenso (`['ms', '6']`, führende Nullen zählen nicht).
 *
 * Eine Zahl wird nur als ganze Zahl gefunden („1“ trifft „Halle 1“, nie „Halle 10“; „3“ trifft „AZ-3“, nie „AZ-30“) und
 * gehört zum Begriff davor (`passtZurSuche`).
 */
export function suchTerme(suche: string): string[] {
  const terme: string[] = [];
  for (const wort of suche.trim().split(/\s+/)) {
    const n = normalisiereSuche(wort);
    if (n === '') continue;
    // Vor jeder Zahl, die auf einen Buchstaben folgt, beginnt ein neuer Begriff („ms06“ → „ms“, „06“).
    for (const teil of n.split(/(?<=\D)(?=\d)/)) terme.push(/^\d/.test(teil) ? teil.replace(/^0+(?=\d)/, '') : teil);
  }
  return terme;
}

const istZiffer = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Die Fundstellen eines Begriffs in einem normalisierten Feld, mit Zahlgrenze: beginnt der Begriff mit einer Ziffer,
 * steht davor keine (außer führenden Nullen, die zur Fundstelle gehören - „6“ trifft „06“ in „MS-06“, nicht „16“); endet
 * er mit einer Ziffer, folgt keine („1“ trifft „Halle 1“, nicht „Halle 10“).
 */
export const zahlFundstellen: Fundstellen = (flach, begriff) => {
  const out: Array<[number, number]> = [];
  for (const [at, bis] of alleFundstellen(flach, begriff)) {
    if (istZiffer(begriff[begriff.length - 1]) && istZiffer(flach[bis])) continue;
    let von = at;
    if (istZiffer(begriff[0])) {
      while (von > 0 && flach[von - 1] === '0') von -= 1;
      if (istZiffer(flach[von - 1])) continue;
    }
    out.push([von, bis]);
  }
  return out;
};

const kommtVor = (feld: string, begriff: string) => zahlFundstellen(feld, begriff).length > 0;

/**
 * Ein Wort und die Zahlen, die ihm folgen: „halle 1 nord“ → `halle` + `1`, dann `nord`. Eine Zahl am Anfang der Suche
 * steht für sich.
 */
function gruppen(terme: readonly string[]): Array<{ wort: string | null; zahlen: string[] }> {
  const out: Array<{ wort: string | null; zahlen: string[] }> = [];
  for (const t of terme) {
    if (/^\d/.test(t) && out.length > 0) out[out.length - 1].zahlen.push(t);
    else if (/^\d/.test(t)) out.push({ wort: null, zahlen: [t] });
    else out.push({ wort: t, zahlen: [] });
  }
  return out;
}

/** Die Felder einer Zeile, in denen gesucht wird - je Feld getrennt, damit kein Treffer über eine Feldgrenze läuft. */
function suchFelder(z: MessstelleRegisterZeile): string[] {
  const f = z.quelle.fuehrend;
  const roh = [
    z.name,
    z.kennzeichen,
    z.ort.name,
    z.ort.kennzeichen,
    z.ort.standort_name,
    z.ort.standort,
    ...z.ort.pfad,
    z.medium,
    f?.komponente_name,
    f?.geraet.geraet,
    f?.geraet.einbau,
    f?.geraet.bezeichnung,
  ];
  return roh.filter((t): t is string => typeof t === 'string' && t !== '').map(normalisiereSuche);
}

/**
 * Passt eine Zeile? Jedes Wort muss in mindestens einem Feld stehen, jede Zahl als ganze Zahl.
 *
 * Eine Zahl gehört zum Wort davor: steht sie mit ihm im selben Feld, passt sie dort („spritzguss 2“ findet „Spritzguss
 * Halle 2“). Trägt das Wort im Feld schon selbst eine Zahl („Halle 2“), muss es diese sein - sonst fände „halle 1“ über
 * „ST-1“ jede Halle des Standorts. Sonst darf die Zahl in einem anderen Feld stehen („druck 3“ findet „Druckluft“ in
 * „Halle 3“).
 */
export function passtZurSuche(z: MessstelleRegisterZeile, terme: readonly string[]): boolean {
  if (terme.length === 0) return true;
  const felder = suchFelder(z);
  const irgendwo = (t: string) => felder.some((f) => kommtVor(f, t));
  return gruppen(terme).every(({ wort, zahlen }) => {
    if (wort === null) return zahlen.every(irgendwo);
    const mitWort = felder.filter((f) => f.includes(wort));
    if (mitWort.some((f) => zahlen.every((t) => kommtVor(f, t)))) return true;
    const frei = mitWort.some((f) => alleFundstellen(f, wort).some(([, bis]) => !istZiffer(f[bis])));
    return frei && zahlen.every(irgendwo);
  });
}

/** Die Fundstellen in einem gezeigten Text (für `<mark>`), dieselbe Regel wie die Suche: eine Zahl nur als ganze Zahl. */
export function markiert(text: string, terme: readonly string[]): TextTeil[] {
  return hervorheben(text, [...terme], zahlFundstellen);
}

const parameter = (hash: string, name: string): string | null =>
  new URLSearchParams(hash.split('?').slice(1).join('?')).get(name);

/** Die Suche aus der Adresse (`#/portfolio/messstellen?suche=druck`) - sie bleibt beim Zurückkommen stehen. */
export const sucheAus = (hash: string): string => parameter(hash, 'suche') ?? '';

/** Die Adresse mit einem Parameter (`null` = ohne ihn); andere Parameter bleiben. */
export function mitParameter(hash: string, name: string, wert: string | null): string {
  const [pfad, ...rest] = hash.split('?');
  const p = new URLSearchParams(rest.join('?'));
  if (wert !== null) p.set(name, wert);
  else p.delete(name);
  const q = p.toString();
  return `${pfad}${q ? `?${q}` : ''}`;
}

/** Die Adresse mit der Suche (leer = ohne Parameter); andere Parameter bleiben. */
export const mitSuche = (hash: string, suche: string): string => mitParameter(hash, 'suche', suche.trim() ? suche : null);

/** Die Adresse ohne einen Filter der Adresse (`ort`, `anlage`) - die Marke „Halle 1 ×“ nimmt ihn heraus. */
export const ohneParameter = (hash: string, name: string): string => mitParameter(hash, name, null);

/**
 * Die gewählte Marke aus der Adresse (`?marke=ohneQuelle`) - wie die Suche bleibt sie beim Zurückkommen von einer
 * Messstelle stehen (Konzept §6.4: „behält Suche und Marken“). Eine unbekannte Marke gilt nicht.
 */
export function markeAus(hash: string): MarkeSchluessel | null {
  const m = parameter(hash, 'marke');
  return MARKE_REIHENFOLGE.find((k) => k === m) ?? null;
}

/** Der Tag von „Stand an einem Tag ansehen“ aus der Adresse (`?stand=2029-04-30`); `null` = heute. */
export function standAus(hash: string): string | null {
  const t = parameter(hash, 'stand');
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`)) ? t : null;
}

// ───────────────────────────────────────────────────────────── Eine Reihe

/** Eine Messstelle als Reihe der Liste: was sie ist, ob sie aktuell ist, woher die Werte kommen, der Wert. */
export interface Reihe {
  id: string;
  kennzeichen: string;
  name: string;
  /** Der Punkt vor dem Namen: grün liefert, Warnton überfällig oder liefert nicht, grau ohne Wert oder Zuordnung. */
  ton: Ton;
  /** Der Satz unter dem Namen - der des Servers („Abgelesen am 01.10.2026“), nie umformuliert. */
  satz: string | null;
  /** Woher die Werte kommen. */
  weg: Weg;
  /** Am Telefon hinter dem Satz („vom Gerät“), wo der Satz den Weg nicht selbst nennt. */
  wegKurz: string | null;
  /** Ab 760 px die Spalte „Woher die Werte kommen“: der Weg und, bei einem Gerät, Komponente und Messwert. */
  woher: { zeile: string; neben: string | null };
  /** Ab 760 px unter dem Namen: Stellung im Stromnetz und Medium („Hauptzähler · Strom“). */
  unter: string;
  /** Festgehaltene Tatsachen der Quelle unter dem Satz („Einstellung geändert ab 15.01.2027 09:00“, A4). */
  fakten: string[];
  /**
   * Der Wert rechts: der Verbrauch des letzten vollständigen Monats („25.650 kWh · Sep 2026“), bei einer Hauptgröße ohne
   * Menge der letzte Stand mit seinem Zeitpunkt („Stand 01.10.“); `null` = der Strich (`OHNE_ANGABE`), nie 0.
   */
  wert: { zahl: string; einheit: string | null; wann: string; monat?: true; hinweis?: string } | null;
  /** Hauptzähler stehen in ihrem Ort zuerst. */
  hauptzaehler: boolean;
  /** Archiviert: in der zugeklappten Gruppe am Ende. */
  archiviert: boolean;
  /** Der Schritt „Ablesungen eintragen“ der Wiedervorlage zeigt auf diese Reihe (`data-entscheid`). */
  ablesungsZiel: boolean;
  /** Für die Marken: welche Lage die Reihe hat („geplant“ ist keine Lage einer Messstelle, sondern die Reihen der Bedarfe). */
  lage: Record<Exclude<MarkeSchluessel, 'geplant'>, boolean>;
  /** Die Zeile des Registers - Suche und Gruppen lesen daraus. */
  zeile: MessstelleRegisterZeile;
}

/** Eine Menge je Zeitraum gibt es nur für einen Zählerstand oder eine Intervallmenge - nie für eine Leistung. */
export function hatMenge(h: { wertart: string } | null | undefined): boolean {
  return h?.wertart === 'Zählerstand' || h?.wertart === 'Intervallmenge';
}

/** „Sep 2026“ - der Monat einer Reihe, kurz (Konzept §6.2: „25.650 kWh · Sep 2026“). */
export function monatKurz(monat: string): string {
  return `${MONATE[Number(monat.slice(5, 7)) - 1].slice(0, 3)} ${monat.slice(0, 4)}`;
}

/** „September 2026“ - der Kopf der Spalte am Rechner, wenn die Reihen den letzten Monat zeigen. */
export function monatLang(monat: string): string {
  return monatTitel(`${monat}-01`);
}

/**
 * Der Verbrauch des letzten vollständigen Monats (Konzept §6.2, Entscheid 2 = A): der Schritt, den das Register mit
 * `letzterMonat=true` trägt - gesprochen mit derselben `anzeige()` wie jede Werte-Karte, ohne eigene Rechnung. Ohne
 * Feld (eine Anfrage ohne Monat) oder für eine Hauptgröße ohne Menge (eine Leistung) `null`: dann steht der letzte
 * Stand. Ein Monat ohne Zahl ist der Strich, nie 0.
 */
export function monatWert(z: MessstelleRegisterZeile): Reihe['wert'] {
  const lm = z.letzter_monat;
  if (!lm || !z.hauptgroesse || !hatMenge(z.hauptgroesse)) return null;
  if (!lm.wert) return { zahl: OHNE_ZAHL, einheit: null, wann: monatKurz(lm.monat), monat: true };
  const a = anzeige(
    { messstelle: { id: z.id, kennzeichen: z.kennzeichen, name: z.name, art: z.art, ...z.hauptgroesse }, raster: 'monat' },
    lm.wert,
    false,
  );
  const i = a.zahl.lastIndexOf('\u00a0');
  // Review r4 S3: ein unvollständiger Monat darf eine Zahl tragen - dann sagt die Reihe es, statt wie ein ganzer Monat
  // auszusehen.
  const hinweis = a.zahl !== OHNE_ZAHL && lm.wert.zustand === UNVOLLSTAENDIG ? { hinweis: UNVOLLSTAENDIG } : {};
  return i < 0
    ? { zahl: a.zahl, einheit: null, wann: monatKurz(lm.monat), monat: true, ...hinweis }
    : { zahl: a.zahl.slice(0, i), einheit: a.zahl.slice(i + 1), wann: monatKurz(lm.monat), monat: true, ...hinweis };
}

/** Stellen je Einheit wie E11 (kW 1, kWh 1, m³ 1); ganze Werte stehen ganz („970.680 kWh“, nicht „970.680,0 kWh“). */
const STELLEN: Record<string, number> = { kW: 1, kWh: 1, 'm³': 1, kvar: 1, kvarh: 1, '%': 0 };

/** „970.680“ · „312,4“ · „−40“ - Tausenderpunkt, U+2212; ohne unnötige „,0“. */
export function standZahl(wert: number, einheit: string | null): string {
  const stellen = einheit !== null ? STELLEN[einheit] : undefined;
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: stellen ?? 3 })
    .format(wert)
    .replace('-', '−');
}

/** „Stand 01.10.“ - am selben Tag wie die Antwort nur die Uhrzeit („Stand 08:55“), ein anderes Jahr mit Jahr. */
export function standWann(iso: string, zone: string, bezug: string): string {
  const tag = lokalerTag(iso, zone);
  if (tag === lokalerTag(bezug, zone)) return `Stand ${zeitpunktText(iso, zone, bezug)}`;
  const [j, m, t] = tag.split('-');
  return tag.slice(0, 4) === lokalerTag(bezug, zone).slice(0, 4) ? `Stand ${t}.${m}.` : `Stand ${t}.${m}.${j}`;
}

/** Die Stellung im Stromnetz in Alltagswörtern - mit der Anlage nur, wo sie nicht schon der Ort ist. */
function stellungUnter(z: MessstelleRegisterZeile): string | null {
  const s = z.elektrische_stellung;
  if (!s || s.stellung === 'keine') return null;
  const wort = s.stellung === 'Unterzähler' && s.unterzaehler_von ? `Unterzähler von ${s.unterzaehler_von}` : s.stellung;
  const anlage = s.anlage_name;
  if (!anlage) return wort;
  const ort = z.ort.name;
  if (ort && anlage.includes(ort)) return wort;
  // „Werk Ahrenberg – Halle 1“ heißt am Standort Werk Ahrenberg kurz „Halle 1“ - nur, wenn der Name so beginnt.
  const standort = z.ort.standort_name;
  const kurz = standort && anlage.startsWith(`${standort} – `) ? anlage.slice(standort.length + 3) : anlage;
  return `${wort} in ${kurz}`;
}

function wegAus(z: MessstelleRegisterZeile): Weg {
  switch (z.quelle.stand) {
    case 'gebunden':
      return z.quelle.fuehrend ? 'geraet' : 'ohne';
    case 'ablesung':
      return 'ablesung';
    case 'berechnet':
      return 'berechnet';
    default:
      return z.art === 'berechnet' ? 'berechnet' : 'ohne';
  }
}

function woherAus(z: MessstelleRegisterZeile, weg: Weg): Reihe['woher'] {
  if (weg === 'geraet' && z.quelle.fuehrend) {
    const f = z.quelle.fuehrend;
    const geraet = f.komponente_name ?? f.geraet.bezeichnung ?? f.geraet.geraet;
    return { zeile: WEG_WORT.geraet, neben: [geraet, f.kanal_name ?? null].filter(Boolean).join(' · ') || null };
  }
  if (weg === 'ablesung') return { zeile: `${WEG_WORT.ablesung}, ${ABLESE_RHYTHMUS}`, neben: null };
  return { zeile: WEG_WORT[weg], neben: null };
}

/**
 * Der Satz unter dem Namen. Aktiv: der Satz des Servers (Beobachtung bzw. die Vollständigkeit einer berechneten
 * Messstelle), ohne Quelle „Noch keine Quelle · zuordnen“. Nicht aktiv: der Lebenszyklus („Entwurf · es fehlt: Ort“,
 * „angehalten seit …“) - er steht nur, wenn er nicht „aktiv“ ist (Konzept §6.2, Begriffe).
 */
function satzAus(w: ZeileWoerter, z: MessstelleRegisterZeile, weg: Weg): string | null {
  // Ohne Quelle sagt die Reihe, was fehlt - „eingerichtet“ (der Lebenszyklus vor der ersten Quelle) spricht dann nicht
  // mit, und der Satz des Servers „Keine Datenquelle“ weicht dem Kundenwort (Konzept Anhang A F).
  if (weg === 'ohne' && (z.lebenszyklus === 'aktiv' || z.lebenszyklus === 'eingerichtet')) return NOCH_KEINE_QUELLE;
  if (z.lebenszyklus !== 'aktiv') {
    const beob = z.lebenszyklus === 'entwurf' || z.lebenszyklus === 'archiviert' ? null : w.beobachtung?.text ?? null;
    return [w.zustand, beob].filter(Boolean).join(' · ');
  }
  return w.beobachtung?.text ?? null;
}

/**
 * Eine Zeile des Registers als Reihe. `zone` ist die des Standorts (bzw. die Vorgabe), `zeitpunkt` der Augenblick der
 * Antwort - am selben Tag steht nur die Uhrzeit des Stands.
 */
export function reiheAus(w: ZeileWoerter, z: MessstelleRegisterZeile, zone: string, zeitpunkt: string, ziel: boolean): Reihe {
  const weg = wegAus(z);
  const aktiv = z.lebenszyklus === 'aktiv';
  const ton: Ton = !aktiv || weg === 'ohne' ? 'still' : (w.beobachtung?.ton ?? 'still');
  const lw = z.letzter_wert;
  const beob = z.beobachtung;
  return {
    id: z.id,
    kennzeichen: z.kennzeichen,
    name: w.name,
    ton,
    satz: satzAus(w, z, weg),
    weg,
    wegKurz: aktiv ? WEG_KURZ[weg] : null,
    woher: woherAus(z, weg),
    unter: [stellungUnter(z), z.medium].filter(Boolean).join(' · '),
    fakten: w.fakten,
    // Rechts der Verbrauch des letzten Monats (Konzept §6.2); ohne Monat (Leistung, Anfrage ohne Monat) der letzte Stand.
    wert:
      monatWert(z) ??
      (lw && lw.wert !== null
        ? { zahl: standZahl(lw.wert, lw.einheit), einheit: lw.einheit, wann: standWann(lw.zeitpunkt, zone, zeitpunkt) }
        : null),
    hauptzaehler: z.elektrische_stellung?.stellung === 'Hauptzähler',
    archiviert: z.lebenszyklus === 'archiviert',
    ablesungsZiel: ziel,
    lage: {
      ablesungFehlt: aktiv && weg === 'ablesung' && beob?.zustand === 'liefert_nicht_seit',
      liefertNicht:
        aktiv && weg === 'geraet' && (beob?.zustand === 'liefert_nicht_seit' || beob?.zuordnung === 'nicht_zugeordnet'),
      ohneQuelle: z.art === 'gemessen' && weg === 'ohne' && z.lebenszyklus !== 'archiviert',
      entwurf: z.lebenszyklus === 'entwurf',
      angehalten: z.lebenszyklus === 'angehalten',
    },
    zeile: z,
  };
}

// ───────────────────────────────────────────────────────────── Gruppen je Ort

export interface OrtGruppe {
  key: string;
  /** „Halle 1“ - der Ort, an dem die Messstellen stehen. */
  titel: string;
  /**
   * Das Kurzzeichen der Ablese-Runde (`?ablesen=G-1`), wenn an dem Ort ein Zähler von Hand abgelesen wird (Konzept
   * §6.2: „Ablesen ›“ im Kopf der Karte): sein Ableseort (`ableseortVon`), bei einem Bereich also sein Gebäude; sonst
   * `null`.
   */
  ablesen: string | null;
  /** Die Runde ist die des Orts selbst (Gebäude, Standort) - nicht die seines Gebäudes (Bereich). */
  ablesenHier: boolean;
  /** Der Standort des Orts (für das Recht „ablesung.erfassen“); `null` am Unternehmen. */
  standortId: string | null;
  /** Der Standort darüber (nur am Unternehmen und nur, wenn der Ort nicht selbst der Standort ist). */
  standort: string | null;
  reihen: Reihe[];
  /** So viele hat der Ort ohne Suche und Marke - „1 von 8“. */
  gesamt: number;
  /** Die geplanten Messstellen des Orts (offene Messbedarfe), die Suche und Marke zeigen - nach den Messstellen. */
  geplant: GeplanteReihe[];
}

const nachZiffern = (a: string, b: string) => a.localeCompare(b, 'de-DE', { numeric: true });

/** Der Schlüssel, nach dem die Orte stehen: der Pfad von oben (Standort, Gebäude, Bereich) - wie der Ortsbaum. */
export function ortReihenfolge(z: MessstelleRegisterZeile): string {
  const o = z.ort;
  switch (o.grund) {
    case 'am_unternehmen':
      return '0';
    case 'verortet':
      return `1/${[...o.pfad].reverse().join('/')}`;
    case 'ort_nicht_im_baum':
      return `2/${o.kennzeichen ?? o.name ?? ''}`;
    default:
      return '3';
  }
}

/** Ein Ablesezähler: wird von Hand abgelesen, misst einen Zählerstand und ist weder archiviert noch im Entwurf. */
export function abzulesen(z: MessstelleRegisterZeile): boolean {
  return (
    z.quelle.stand === 'ablesung' &&
    z.hauptgroesse?.wertart === 'Zählerstand' &&
    (z.lebenszyklus === 'aktiv' || z.lebenszyklus === 'eingerichtet')
  );
}

/**
 * Wo man eine Messstelle abliest - dieselbe Regel wie der Server (`MessstelleRegisterService.ableseort`, Wiedervorlage
 * „Zählerablesung“): das erste Gebäude auf dem Pfad von ihrem Ort hinauf, ohne Gebäude ihr Standort, am Unternehmen
 * `U`. Der Pfad läuft vom Ort hinauf; ein Gebäude hängt immer am Standort, ein Bereich an einem Gebäude oder am Standort
 * und nie in einem Bereich - das Gebäude ist also der Ort selbst oder der Elternteil eines Bereichs. `null` = an keinem
 * Ort.
 */
export function ableseortVon(z: MessstelleRegisterZeile): string | null {
  const o = z.ort;
  if (o.kennzeichen === 'U' || o.ort_art === 'unternehmen') return 'U';
  if (o.grund !== 'verortet' || !o.standort || !o.kennzeichen) return null;
  if (o.ort_art === 'gebaeude') return o.kennzeichen;
  if (o.ort_art === 'bereich' && o.pfad.length >= 3) return o.pfad[1];
  return o.standort;
}

export function ortKopf(z: MessstelleRegisterZeile, ebene: MessstellenEbene): { key: string; titel: string; standort: string | null } {
  const o = z.ort;
  switch (o.grund) {
    case 'am_unternehmen':
      return { key: 'unternehmen', titel: UEMS_UNTERNEHMEN, standort: null };
    case 'verortet':
      return {
        key: o.id ?? o.kennzeichen ?? 'ort',
        titel: o.ort_art === 'standort' ? (o.standort_name ?? o.name ?? o.kennzeichen ?? KEIN_ORT) : (o.name ?? o.kennzeichen ?? KEIN_ORT),
        standort: ebene.art === 'unternehmen' && o.ort_art !== 'standort' ? (o.standort_name ?? o.standort) : null,
      };
    case 'ort_nicht_im_baum':
      return { key: `nicht-im-baum-${o.id ?? o.kennzeichen}`, titel: `${o.name ?? o.kennzeichen ?? 'Ort'} – an diesem Tag keinem Standort zugeordnet`, standort: null };
    default:
      return { key: 'ohne-ort', titel: KEIN_ORT, standort: null };
  }
}

/** Im Ort der Hauptzähler zuerst, dann nach Kennzeichen (AZ-2 vor AZ-10). */
function imOrt(a: Reihe, b: Reihe): number {
  if (a.hauptzaehler !== b.hauptzaehler) return a.hauptzaehler ? -1 : 1;
  return nachZiffern(a.kennzeichen, b.kennzeichen);
}

// ───────────────────────────────────────────────────────────── Marken

export type MarkeSchluessel = 'ablesungFehlt' | 'liefertNicht' | 'ohneQuelle' | 'entwurf' | 'angehalten' | 'geplant';

export interface Marke {
  schluessel: MarkeSchluessel;
  text: string;
  ton: 'warn' | 'neutral';
  anzahl: number;
}

const MARKE_REIHENFOLGE: MarkeSchluessel[] = ['ablesungFehlt', 'liefertNicht', 'ohneQuelle', 'entwurf', 'angehalten', 'geplant'];

function markeText(s: MarkeSchluessel, n: number): string {
  switch (s) {
    case 'ablesungFehlt':
      return n === 1 ? '1 Ablesung überfällig' : `${n} Ablesungen überfällig`;
    case 'liefertNicht':
      return n === 1 ? '1 liefert keine Daten' : `${n} liefern keine Daten`;
    case 'ohneQuelle':
      return `${n} ohne Quelle`;
    case 'entwurf':
      return n === 1 ? '1 Entwurf' : `${n} Entwürfe`;
    case 'angehalten':
      return `${n} angehalten`;
    case 'geplant':
      return `${n} geplant`;
  }
}

/**
 * Die Marken - nur, was es gibt (nie „0 ohne Quelle“); sie zählen die Messstellen ohne die archivierten, „geplant“ die
 * geplanten Messstellen (offene Messbedarfe).
 */
export function marken(reihen: readonly Reihe[], geplant = 0): Marke[] {
  const aktiv = reihen.filter((r) => !r.archiviert);
  return MARKE_REIHENFOLGE.flatMap((s) => {
    const n = s === 'geplant' ? geplant : aktiv.filter((r) => r.lage[s]).length;
    return n > 0 ? [{ schluessel: s, text: markeText(s, n), ton: s === 'ablesungFehlt' || s === 'liefertNicht' ? ('warn' as const) : ('neutral' as const), anzahl: n }] : [];
  });
}

// ───────────────────────────────────────────────────────────── Status

/** Eine Hinweiskarte unter dem Kopf - nur bei Handlungsbedarf (Status-Variante A, wie die Übersicht). */
export interface Hinweis {
  titel: string;
  satz: string;
  ton: 'warn' | 'off';
  /** Die Marke, auf die die Karte filtert; `null` = keine (dann ist die Karte kein Knopf). */
  marke: MarkeSchluessel | null;
  /** Der Schritt rechts („Ablesen“); `null` = keiner. */
  schritt: string | null;
}

export interface Status {
  /** Die ruhige Zeile: der Satz des Servers mit seinem Punkt - oder `null`, wenn Hinweiskarten an ihre Stelle treten. */
  zeile: { text: string; ton: 'ok' | 'still' } | null;
  hinweise: Hinweis[];
}

function namenListe(namen: readonly string[]): string {
  if (namen.length <= 1) return namen[0] ?? '';
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/** Die Orte einer Lage, in der Reihenfolge des Ortsbaums, ohne Doppel - „Halle 1, Halle 2 und Verwaltung“. */
function orteVon(reihen: readonly Reihe[], ebene: MessstellenEbene): string {
  const sortiert = [...reihen].sort((a, b) => nachZiffern(ortReihenfolge(a.zeile), ortReihenfolge(b.zeile)));
  return namenListe([...new Set(sortiert.map((r) => ortKopf(r.zeile, ebene).titel))]);
}

/** Der früheste „seit“ einer Lage als Tag („seit 01.12.2026“) - am selben Tag wie die Antwort mit Uhrzeit. */
function seitVon(reihen: readonly Reihe[], zone: string, zeitpunkt: string): string | null {
  const seit = reihen.map((r) => r.zeile.beobachtung?.seit).filter((s): s is string => Boolean(s)).sort()[0];
  if (!seit) return null;
  return lokalerTag(seit, zone) === lokalerTag(zeitpunkt, zone) ? zeitpunktText(seit, zone, zeitpunkt) : datumText(lokalerTag(seit, zone));
}

/**
 * Die Statuszeile beantwortet die Frage der Gruppe „Wird alles erfasst?“: ruhig mit dem Satz des Servers, solange alles
 * liefert; bei Handlungsbedarf treten Hinweiskarten an ihre Stelle - eine überfällige Ablesung (mit dem Schritt
 * „Ablesen“) und Geräte, die keine Daten liefern. Mit Stichtag in der Vergangenheitsform und ohne Schritt: an einem
 * vergangenen Tag lässt sich nichts eintragen.
 */
export function status(
  antwort: MessstellenRegister,
  reihen: readonly Reihe[],
  i: {
    ebene: MessstellenEbene;
    zone: string;
    stichtag: string | null;
    /** Die Karte der geplanten Messstellen mit überschrittener Frist (`geplantHinweis`) - nach denen der Messstellen. */
    geplant?: Hinweis | null;
  },
): Status {
  const aktiv = reihen.filter((r) => !r.archiviert);
  const hinweise: Hinweis[] = [];
  const fehlt = aktiv.filter((r) => r.lage.ablesungFehlt);
  if (fehlt.length > 0) {
    const wer = fehlt.length === 1 ? `${fehlt[0].name} (${fehlt[0].kennzeichen})` : `${fehlt.length} ${TITEL}`;
    const seit = seitVon(fehlt, i.zone, antwort.zeitpunkt);
    hinweise.push({
      titel: `Bei ${wer} ${i.stichtag ? 'war' : 'ist'} die Ablesung überfällig`,
      satz: [seit ? `Seit ${seit}` : null, orteVon(fehlt, i.ebene), i.stichtag ? 'am Stichtag lässt sich nichts eintragen' : null]
        .filter(Boolean)
        .join(' · '),
      ton: 'warn',
      marke: 'ablesungFehlt',
      schritt: i.stichtag ? null : 'Ablesen',
    });
  }
  const still = aktiv.filter((r) => r.lage.liefertNicht);
  if (still.length > 0) {
    const titel = still.length === 1
      ? `${still[0].name} (${still[0].kennzeichen}) ${i.stichtag ? 'lieferte' : 'liefert'} keine Daten`
      : `${still.length} ${TITEL} ${i.stichtag ? 'lieferten' : 'liefern'} keine Daten`;
    const seit = seitVon(still, i.zone, antwort.zeitpunkt);
    hinweise.push({
      titel,
      satz: [seit ? `Seit ${seit}` : null, orteVon(still, i.ebene)].filter(Boolean).join(' · '),
      ton: 'warn',
      marke: 'liefertNicht',
      schritt: 'Ansehen',
    });
  }
  if (i.geplant) hinweise.push(i.geplant);
  const a = antwort.aggregat?.unternehmen;
  if (!a || a.gesamt === 0) return { zeile: null, hinweise };
  if (hinweise.length > 0) return { zeile: null, hinweise };
  if (a.erfuellt < a.gesamt) {
    // Nicht alles liefert, aber nichts davon ist überfällig oder ausgefallen (ohne Quelle, Entwurf, wartet): ein
    // ruhiger Hinweis ohne Schritt - wie die Datenlage der Übersicht.
    return { zeile: null, hinweise: [{ titel: a.text, satz: '', ton: 'off', marke: null, schritt: null }] };
  }
  return { zeile: { text: a.text, ton: 'ok' }, hinweise };
}

// ───────────────────────────────────────────────────────────── Die Liste

export interface Liste {
  gruppen: OrtGruppe[];
  archiviert: Reihe[];
  /** Am Stichtag noch nicht im Portal: benannt mit dem Satz, nie weggelassen. */
  nochNicht: { id: string; kennzeichen: string; name: string; satz: string }[];
  /** Alle Reihen (ohne archivierte) - für Marken und Status. */
  reihen: Reihe[];
  /** So viele zeigt die Liste gerade (Suche und Marke). */
  treffer: number;
  /** So viele geplante Messstellen zeigt sie gerade - sie zählen nicht zu den Messstellen. */
  geplant: number;
  /** So viele gäbe es ohne Suche und Marke. */
  gesamt: number;
  /** An wie vielen Orten die gezeigten stehen. */
  orte: number;
}

/**
 * Die Liste aus den Einträgen des Registers (`registerEintraege`): Reihen, nach Ort gruppiert, gefiltert durch Suche
 * und Marke. Leere Gruppen fallen weg; jede Gruppe zählt ihre Treffer gegen ihren ganzen Bestand („1 von 8“). Die
 * geplanten Messstellen (`geplanteAus`) stehen an ihrem Ort nach den Messstellen - ein Ort nur mit geplanten bekommt
 * eine eigene Gruppe; die Marke „geplant“ zeigt nur sie, jede andere Marke nur Messstellen.
 */
export function liste(
  eintraege: readonly RegisterEintrag[],
  i: {
    ebene: MessstellenEbene;
    zone: string;
    zeitpunkt: string;
    suche: string;
    marke: MarkeSchluessel | null;
    geplante?: readonly GeplanteReihe[];
  },
): Liste {
  const ziele = ablesungsZiele(eintraege.flatMap((e) => (e.art === 'messstelle' ? [e.woerter] : [])));
  const reihen: Reihe[] = [];
  const nochNicht: Liste['nochNicht'] = [];
  for (const e of eintraege) {
    if (e.art === 'gab_es_noch_nicht') nochNicht.push({ id: e.id, kennzeichen: e.kennzeichen, name: e.name, satz: e.satz });
    else reihen.push(reiheAus(e.woerter, e.zeile, i.zone, i.zeitpunkt, ziele.has(e.woerter.id)));
  }
  const terme = suchTerme(i.suche);
  const passt = (r: Reihe) => passtZurSuche(r.zeile, terme) && (i.marke === null || (i.marke !== 'geplant' && r.lage[i.marke]));
  const passtGeplant = (g: GeplanteReihe) => (i.marke === null || i.marke === 'geplant') && geplantPasstZurSuche(g, terme);
  const offen = reihen.filter((r) => !r.archiviert);
  const je = new Map<string, OrtGruppe & { ordnung: string }>();
  for (const r of offen) {
    const k = ortKopf(r.zeile, i.ebene);
    const g = je.get(k.key) ?? {
      ...k,
      ablesen: null,
      ablesenHier: false,
      standortId: r.zeile.ort.standort_id,
      reihen: [],
      gesamt: 0,
      geplant: [],
      ordnung: ortReihenfolge(r.zeile),
    };
    g.gesamt += 1;
    // Die Runde gilt dem Ableseort der Zähler der Karte (ihr Gebäude, ohne Gebäude ihr Standort) - wie die Wiedervorlage.
    if (!g.ablesen && abzulesen(r.zeile)) {
      g.ablesen = ableseortVon(r.zeile);
      g.ablesenHier = g.ablesen !== null && g.ablesen === r.zeile.ort.kennzeichen;
    }
    if (passt(r)) g.reihen.push(r);
    je.set(k.key, g);
  }
  for (const p of i.geplante ?? []) {
    if (!passtGeplant(p)) continue;
    const { key, titel, standort, standortId, ordnung } = p.ort;
    const g = je.get(key) ?? { key, titel, standort, standortId, ablesen: null, ablesenHier: false, reihen: [], gesamt: 0, geplant: [], ordnung };
    g.geplant.push(p);
    je.set(key, g);
  }
  const gruppen = [...je.values()]
    .filter((g) => g.reihen.length > 0 || g.geplant.length > 0)
    .sort((a, b) => nachZiffern(a.ordnung, b.ordnung))
    .map(({ ordnung: _o, ...g }) => ({ ...g, reihen: [...g.reihen].sort(imOrt) }));
  const treffer = gruppen.reduce((n, g) => n + g.reihen.length, 0);
  return {
    gruppen,
    archiviert: reihen.filter((r) => r.archiviert && passtZurSuche(r.zeile, terme)).sort(imOrt),
    nochNicht,
    reihen: offen,
    treffer,
    geplant: gruppen.reduce((n, g) => n + g.geplant.length, 0),
    gesamt: offen.length,
    orte: gruppen.filter((g) => g.reihen.length > 0).length,
  };
}

/** Eine geplante Messstelle wird wie eine Messstelle gesucht: in Name (Wortlaut), Kennzeichen, Ort und Einsatz. */
function geplantPasstZurSuche(g: GeplanteReihe, terme: readonly string[]): boolean {
  if (terme.length === 0) return true;
  const felder = [g.name, g.kennzeichen, g.ort.titel, g.ort.standort ?? '', g.einsatz?.text ?? ''].map(normalisiereSuche);
  return terme.every((t) => felder.some((f) => f.includes(t)));
}

/**
 * Das Beispiel aus der eigenen Firma für „Was ist eine Messstelle?“ (Konzept §7, Stufe 2): ein Hauptzähler und eine
 * zweite Messstelle mit anderem Namen, aus den eigenen Daten, nicht aus dem Lehrbuch. Ohne Messstellen keins.
 */
export function messstelleBeispiel(reihen: readonly Reihe[]): { id: string; name: string; kennzeichen: string }[] {
  const offen = reihen.filter((r) => !r.archiviert);
  const erste = offen.find((r) => r.hauptzaehler) ?? offen[0];
  if (!erste) return [];
  const zweite = offen.find((r) => r !== erste && r.name !== erste.name && !r.hauptzaehler) ?? offen.find((r) => r !== erste);
  return [erste, zweite].filter((r): r is Reihe => Boolean(r)).map((r) => ({ id: r.id, name: r.name, kennzeichen: r.kennzeichen }));
}

/** „10 Messstellen an 3 Orten“ - ohne Suche; mit Suche oder Marke „2 von 10 Messstellen“. */
export function trefferSatz(l: Pick<Liste, 'treffer' | 'gesamt' | 'orte'>, gefiltert: boolean): string {
  const wort = (n: number) => (n === 1 ? UEMS_MESSSTELLE : TITEL);
  if (gefiltert) return `${l.treffer} von ${l.gesamt} ${wort(l.gesamt)}`;
  return `${l.gesamt} ${wort(l.gesamt)} an ${l.orte} ${l.orte === 1 ? 'Ort' : 'Orten'}`;
}

/** Der Kopf einer Gruppe rechts: „Werk Ahrenberg · 8“, mit Suche „1 von 8“; am Standort ohne Standort. */
export function gruppenZahl(g: OrtGruppe, gefiltert: boolean): string {
  const n = gefiltert ? `${g.reihen.length} von ${g.gesamt}` : `${g.gesamt}`;
  return [g.standort, n].filter(Boolean).join(' · ');
}
