/**
 * UEMS AP-13 IP-9 (= AP-10 IP-15, Listen-Teil; E8 = A, B6/B7) — Kostenstellen und Prozesse NEBENEINANDER: die Reiter
 * „Kostenstellen“ und „Prozesse“ der Welt Messstellen am Unternehmen, rein abgeleitet aus
 * `GET /api/v1/unternehmen/kostenstellen/{id}/energie` (AP-10 IP-11) je Kostenstelle und den beiden Katalogen.
 *
 * ⚠ **Keine Summe über Kostenstellen.** Die Fläche zeigt je Kostenstelle, was die Route liefert (gemessen · verteilt ·
 * berechnet · Summe), und sagt statt eines Fußes, warum es keine Gesamtsumme gibt (`KEINE_SUMME`): „nicht verteilt“
 * gehört keiner, und ein Posten kann in einem anderen enthalten sein (MS-20 enthält MS-06). Dieses Modul kennt darum
 * KEINE Zahl über Karten hinweg — kein Feld, keine Funktion; `kostenstellenUebersicht.test.ts` hält das fest.
 *
 * ⚠ **„Nicht verteilt“ steht EINMAL** über allen Karten, aus einer beliebigen Antwort (sie ist in jeder gleich) — nie je
 * Karte, nie aufgeteilt, ohne eigene Zahl („n Messstellen“). Hauptzähler stehen darin, weil die Verteilung keine
 * Stellung kennt (Befund AP-10 IP-11); die Fläche zeigt, was die Route sagt (O9 Schritt 1).
 *
 * ⚠ **Keine Rechnung.** Jede Zahl ist ein Feld der Route (Blöcke, Posten, Summen je Größe) bzw. der Werte-Route (die
 * Prozess-Summe); gerundet wird nur zur Anzeige über `uemsErgebnis.zahl` (E11). Die Doppelzählungs-Warnung sind die
 * Sätze der Route (`verteilung-vectors.json` Regel `doppelzaehlung`) — sie ändert keine Zahl.
 *
 * ⚠ **Die Prozess-Summe ist eine berechnete Messstelle** (AP-10 §5.7: MS-20), die dem Prozess zugeordnet ist. Eine Route
 * „Messstellen eines Prozesses“ gibt es nicht (Befund) — die Fläche fragt die Prozesse der BERECHNETEN Messstellen des
 * Registers ab und liest deren Wert über die Werte-Route. Auch über Prozesse gibt es keine Summe.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type {
  Kostenstelle,
  KostenstelleEnergie,
  KostenstelleEnergieBlock,
  KostenstelleEnergiePeriode,
  KostenstelleEnergiePosten,
  MessstelleProzesse,
  MessstelleRegisterZeile,
  MessstelleWerte,
  MessstelleWerteRaster,
  Prozess,
} from './api';
import { UEMS_KOSTENSTELLE, UEMS_PROZESS_SUMME } from './glossar';
import { hashForRoute, pageRoute } from './nav';
import { datumZeit } from './rechte';
import { ende, zeitraumText } from './uebersichtBausteine';
import { KWH, zahl } from './uemsErgebnis';
import { periodeSchluessel, sprungziel, type Sprung } from './uemsOberflaechen';
import { NICHT_VERTEILT } from './uemsVerteilung';

// ------------------------------------------------------------------------------------------------ Wörter

/** Der Satz statt einer Gesamtsumme (O9 Schritt 4) — wichtiger als jede Zahl dieser Seite. */
export const KEINE_SUMME = 'Die Kostenstellen sind nicht summierbar — nicht verteilte Mengen gehören keiner.';
export const PROZESSE_KEINE_SUMME = 'Die Prozesse sind nicht summierbar — eine Messstelle kann zu mehreren Prozessen gehören.';

export const NICHT_VERTEILT_TITEL = 'Nicht verteilt';
export const NICHT_VERTEILT_UNTER = `gehört keiner ${UEMS_KOSTENSTELLE} und steht in keiner Summe`;
export const NICHT_VERTEILT_ANZAHL = { singular: '{n} Messstelle', plural: '{n} Messstellen' } as const;
export const NICHT_VERTEILT_LEER = 'Im Zeitraum hat jede Messstelle mit Wert eine Verteilung.';

export type BlockArt = 'gemessen' | 'verteilt' | 'berechnet' | 'summe';
export const BLOCK_ARTEN: readonly BlockArt[] = ['gemessen', 'verteilt', 'berechnet', 'summe'];
export const BLOCK_WORT: Readonly<Record<BlockArt, string>> = {
  gemessen: 'gemessen',
  verteilt: 'verteilt',
  berechnet: 'berechnet',
  summe: 'Summe',
};

/** Die Sätze je `grund` eines Blocks (AP-13 §5.8). */
export const GRUND_SATZ: Readonly<Record<NonNullable<KostenstelleEnergieBlock['grund']>, string>> = {
  keine_zuordnung: 'Dieser Kostenstelle ist im Zeitraum keine Messstelle zugeordnet.',
  groessen_gemischt: 'Die Posten haben verschiedene Größen — je Größe eine Summe.',
};

export const DOPPELT_TITEL = 'Doppelt gezählt';
export const DOPPELT_HINWEIS =
  'Die Summe dieser Kostenstelle enthält diese Mengen doppelt. Die Zahlen bleiben, wie sie gemessen und verteilt sind.';

export const GUELTIG_AB = 'gültig ab {tag}';
export const GUELTIG_BIS = 'gültig bis {tag}';
export const AB = 'ab {tag}';
export const BIS = 'bis {tag}';
export const VORHER_BEENDET = 'Vor diesem Zeitraum beendet: {liste}';
export const ZONE = 'Zeiten in {zone}';
export const BERECHNET_AM = 'berechnet am {am}';

export const KOSTENSTELLEN_LEER = 'In diesem Zeitraum besteht keine Kostenstelle.';
export const PROZESSE_LEER = 'In diesem Zeitraum besteht kein Prozess.';
export const NICHT_ABRUFBAR = 'Diese Kostenstelle ist gerade nicht abrufbar.';
export const ALLE_NICHT_ABRUFBAR = 'Die Kostenstellen sind gerade nicht abrufbar.';
export const PROZESSE_NICHT_ABRUFBAR = 'Die Prozesse sind gerade nicht abrufbar.';

export const PROZESS_SUMME_OHNE = `Keine ${UEMS_PROZESS_SUMME}: sie ist eine berechnete Messstelle, die diesem Prozess zugeordnet ist.`;
export const PROZESS_SUMME_NICHT_ABRUFBAR = 'Der Wert ist gerade nicht abrufbar.';
export const PROZESS_TEIL_VON = 'Teil von {prozess}';

const fuelle = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

const einmal = (xs: string[]): string[] => [...new Set(xs)];

/** `2026-10-15` → „15.10.2026“. */
const tag = (t: string): string => `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}`;

const spanneTage = (von: string, bis: string): string => (von === bis ? tag(von) : `${tag(von)}–${tag(bis)}`);

const VOLLSTAENDIG = 'vollständig';

// ------------------------------------------------------------------------------------ Reiter und Adresse

export type MessstellenReiter = 'liste' | 'kostenstellen' | 'prozesse';

export const REITER_WORT: Readonly<Record<MessstellenReiter, string>> = {
  liste: 'Liste',
  kostenstellen: 'Kostenstellen',
  prozesse: 'Prozesse',
};

/** Der zugängliche Name der Reiter-Leiste. */
export const REITER_LABEL = 'Reiter der Messstellen';

/**
 * Die Reiter der Welt Messstellen am Unternehmen — nur mit Inhalt: ohne Kostenstelle und ohne Prozess gibt es keine
 * Leiste, und das Register bleibt zeichengleich (Bestandsschutz). „Liste“ ist das Register.
 */
export function reiterDa(kostenstellen: number, prozesse: number): MessstellenReiter[] {
  if (kostenstellen === 0 && prozesse === 0) return [];
  const out: MessstellenReiter[] = ['liste'];
  if (kostenstellen > 0) out.push('kostenstellen');
  if (prozesse > 0) out.push('prozesse');
  return out;
}

const query = (hash: string): URLSearchParams => new URLSearchParams(hash.split('?').slice(1).join('?'));

/** Der Reiter der Adresse (`#/portfolio/messstellen?reiter=kostenstellen`); ohne oder unbekannt die Liste. */
export function reiterAus(hash: string): MessstellenReiter {
  const r = query(hash).get('reiter');
  return r === 'kostenstellen' || r === 'prozesse' ? r : 'liste';
}

/** Die Kostenstelle, auf die ein Sprung zeigt (`kostenstelle=4200`) — ihre Karte wird hervorgehoben. */
export const hervorAus = (hash: string): string | null => query(hash).get('kostenstelle')?.trim() || null;

/** Die Adresse eines Reiters mit Zeitraum — ein Lesezeichen hält beides. */
export function reiterHash(reiter: MessstellenReiter, zeitraum: { periode: KostenstelleEnergiePeriode; am: string } | null): string {
  const basis = hashForRoute(pageRoute('portfolio-messstellen'));
  if (reiter === 'liste') return basis;
  const q = new URLSearchParams({ reiter });
  if (zeitraum) {
    q.set('periode', zeitraum.periode);
    q.set('am', zeitraum.am);
  }
  return `${basis}?${q.toString()}`;
}

// ------------------------------------------------------------------------------------------- Zeitraum

/** Besteht das Objekt an mindestens einem Tag des Zeitraums (Tage, der letzte einschließlich)? */
export const imZeitraum = (o: { gueltig_ab: string; gueltig_bis: string | null }, von: string, bis: string): boolean =>
  o.gueltig_ab <= bis && (o.gueltig_bis === null || o.gueltig_bis >= von);

/** Ist das Objekt vor dem Zeitraum beendet (F12: 9000 im Januar 2027)? */
export const vorherBeendet = (o: { gueltig_bis: string | null }, von: string): boolean => o.gueltig_bis !== null && o.gueltig_bis < von;

const nachKennzeichen = <T extends { kennzeichen: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen, 'de', { numeric: true }));

/** Die Kostenstellen, die im Zeitraum bestehen — je eine Karte, je ein Aufruf (bis AP-10 „alle einer Periode“ liefert). */
export const kostenstellenImZeitraum = (katalog: Kostenstelle[], periode: KostenstelleEnergiePeriode, am: string): Kostenstelle[] =>
  nachKennzeichen(katalog.filter((k) => imZeitraum(k, am, ende(periode, am))));

/** „gültig ab …“ nur, wenn sie im Zeitraum beginnt; „gültig bis …“ an jeder beendeten (F12). */
function gueltigText(o: { gueltig_ab: string; gueltig_bis: string | null }, von: string): string | null {
  const teile: string[] = [];
  if (o.gueltig_ab > von) teile.push(fuelle(GUELTIG_AB, { tag: tag(o.gueltig_ab) }));
  if (o.gueltig_bis !== null) teile.push(fuelle(GUELTIG_BIS, { tag: tag(o.gueltig_bis) }));
  return teile.length > 0 ? teile.join(' · ') : null;
}

function vorherBeendetText(katalog: Array<{ kennzeichen: string; name: string; gueltig_bis: string | null }>, von: string): string | null {
  const beendet = nachKennzeichen(katalog.filter((o) => vorherBeendet(o, von)));
  if (beendet.length === 0) return null;
  const liste = beendet.map((o) => `${o.kennzeichen} ${o.name} (${fuelle(GUELTIG_BIS, { tag: tag(o.gueltig_bis as string) })})`);
  return fuelle(VORHER_BEENDET, { liste: liste.join(' · ') });
}

/** Die Periode der Werte-Seite einer Messstelle (`2026-10-15` · `2026-10` · `2026`) — der Sprung eines Postens. */
export const werteperiode = (periode: KostenstelleEnergiePeriode, am: string): string => periodeSchluessel(periode, am);

// ------------------------------------------------------------------------------------------------ Zahl

/** Eine Menge der Route, gerundet nur zur Anzeige; ohne Menge der Strich — nie eine 0. */
function anzeige(menge: number | null, einheit: string | null, periode: KostenstelleEnergiePeriode): string {
  try {
    return zahl(menge, einheit ?? KWH, periode);
  } catch {
    // Eine Einheit ohne Anzeige-Regel: die Zahl der Route ungerundet mit ihrer Einheit, nie still weggelassen.
    return menge === null ? zahl(null, KWH, periode) : `${new Intl.NumberFormat('de-DE').format(menge)} ${einheit}`;
  }
}

// ------------------------------------------------------------------------------------------------- Bild

export interface PostenBild {
  id: string;
  kennzeichen: string;
  name: string;
  zahl: string;
  /** Der Zustand, wenn er nicht „vollständig“ ist. */
  zustand: string | null;
  /** Die Kennzeichen der Route wörtlich („verteilt (30 % von MS-07)“, „berechnet (Summe)“). */
  woerter: string[];
  /** „ab 15.10.2026“, wenn der Anteil nicht den ganzen Zeitraum gilt. */
  spanne: string | null;
  /** Zur Messstelle › Werte mit der Periode (B6: jeder Posten ist ein Sprung). */
  sprung: Sprung | null;
}

export interface BlockBild {
  art: BlockArt;
  wort: string;
  zahl: string;
  zustand: string | null;
  /** Nur bei `groessen_gemischt`: je Größe eine Zahl der Route („1.240 m³ (Volumen)“). */
  summen: string[];
  posten: PostenBild[];
}

export interface DoppeltBild {
  titel: string;
  saetze: string[];
  hinweis: string | null;
}

export interface KarteBild {
  id: string;
  kennzeichen: string;
  name: string;
  gueltig: string | null;
  laedt: boolean;
  fehler: string | null;
  bloecke: BlockBild[];
  /** Die Gründe der Blöcke, jeder einmal. */
  saetze: string[];
  doppelt: DoppeltBild | null;
}

export interface NichtVerteiltBild {
  titel: string;
  unter: string;
  anzahl: string;
  posten: PostenBild[];
  leer: string | null;
}

export interface KostenstellenBild {
  zeitraum: string;
  zone: string | null;
  stand: string | null;
  /** Steht, sobald es Karten gibt — an der Stelle, an der sonst eine Gesamtsumme stünde. */
  keineSumme: string | null;
  nichtVerteilt: NichtVerteiltBild | null;
  karten: KarteBild[];
  vorherBeendet: string | null;
  leer: string | null;
  alleFehler: boolean;
}

/** Die Antwort je Kostenstelle: `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type EnergieAntwort = KostenstelleEnergie | 'fehler' | null;

function spanne(p: KostenstelleEnergiePosten, von: string, bis: string): string | null {
  const mit = p.tage
    .filter((t) => t.anteil_prozent !== null)
    .map((t) => t.tag)
    .sort();
  if (mit.length === 0) return null;
  const [erster, letzter] = [mit[0], mit[mit.length - 1]];
  if (erster > von && letzter < bis) return spanneTage(erster, letzter);
  if (erster > von) return fuelle(AB, { tag: tag(erster) });
  if (letzter < bis) return fuelle(BIS, { tag: tag(letzter) });
  return null;
}

export function postenBild(
  p: KostenstelleEnergiePosten,
  periode: KostenstelleEnergiePeriode,
  am: string,
  ohneWort: string | null = null,
): PostenBild {
  return {
    id: p.messstelle.id,
    kennzeichen: p.messstelle.kennzeichen,
    name: p.messstelle.name ?? p.messstelle.kennzeichen,
    zahl: anzeige(p.menge, p.einheit, periode),
    zustand: p.zustand && p.zustand !== VOLLSTAENDIG ? p.zustand : null,
    woerter: p.kennzeichen.filter((w) => w !== ohneWort),
    spanne: spanne(p, am, ende(periode, am)),
    sprung: sprungziel({ art: 'messstelle', id: p.messstelle.id, periode: werteperiode(periode, am) }),
  };
}

function blockBild(art: BlockArt, b: KostenstelleEnergieBlock, periode: KostenstelleEnergiePeriode, am: string): BlockBild {
  const gemischt = b.grund === 'groessen_gemischt';
  // Ein Block ohne Posten hat keinen Zustand — sein Strich heißt „nichts zugeordnet“, nicht „keine Werte“.
  const mitZustand = art === 'summe' || b.posten.length > 0;
  return {
    art,
    wort: BLOCK_WORT[art],
    zahl: anzeige(b.menge, b.einheit, periode),
    zustand: mitZustand && !gemischt && b.zustand && b.zustand !== VOLLSTAENDIG ? b.zustand : null,
    summen: gemischt ? b.summen.map((s) => `${anzeige(s.menge, s.einheit, periode)} (${s.groesse})`) : [],
    posten: art === 'summe' ? [] : b.posten.map((p) => postenBild(p, periode, am)),
  };
}

function doppeltBild(e: KostenstelleEnergie): DoppeltBild | null {
  const { enthalten, nicht_pruefbar } = e.doppelzaehlung;
  if (enthalten.length === 0 && nicht_pruefbar.length === 0) return null;
  const ganz = (zs: { von: string; bis: string }[]) => zs.length === 1 && zs[0].von <= e.von && zs[0].bis >= e.bis;
  const saetze = [
    ...enthalten.map((x) =>
      ganz(x.zeitraeume) ? x.satz : `${x.satz} (${x.zeitraeume.map((z) => spanneTage(z.von, z.bis)).join(', ')})`,
    ),
    ...nicht_pruefbar.map((n) => n.satz),
  ];
  return { titel: DOPPELT_TITEL, saetze: einmal(saetze), hinweis: enthalten.length > 0 ? DOPPELT_HINWEIS : null };
}

export function karteBild(k: Kostenstelle, antwort: EnergieAntwort, periode: KostenstelleEnergiePeriode, am: string): KarteBild {
  const kopf = { id: k.id, kennzeichen: k.kennzeichen, name: k.name, gueltig: gueltigText(k, am) };
  if (antwort === null || antwort === 'fehler') {
    return { ...kopf, laedt: antwort === null, fehler: antwort === 'fehler' ? NICHT_ABRUFBAR : null, bloecke: [], saetze: [], doppelt: null };
  }
  const bloecke = BLOCK_ARTEN.map((art) => blockBild(art, antwort[art], periode, am));
  // `keine_zuordnung` an einem Block heißt nur „dieser Block hat keinen Posten“ (sein Strich sagt es, 4200 berechnet) —
  // der Satz gilt der Kostenstelle erst, wenn auch die Summe keinen hat (9010 im Januar 2027). „Verschiedene Größen“
  // gilt, wo immer er steht.
  const saetze = [
    ...(antwort.summe.grund === 'keine_zuordnung' ? [GRUND_SATZ.keine_zuordnung] : []),
    ...(BLOCK_ARTEN.some((art) => antwort[art].grund === 'groessen_gemischt') ? [GRUND_SATZ.groessen_gemischt] : []),
  ];
  return { ...kopf, laedt: false, fehler: null, bloecke, saetze, doppelt: doppeltBild(antwort) };
}

function nichtVerteiltBild(b: KostenstelleEnergieBlock, periode: KostenstelleEnergiePeriode, am: string): NichtVerteiltBild {
  const posten = b.posten.map((p) => postenBild(p, periode, am, NICHT_VERTEILT));
  const n = posten.length;
  return {
    titel: NICHT_VERTEILT_TITEL,
    unter: NICHT_VERTEILT_UNTER,
    anzahl: fuelle(n === 1 ? NICHT_VERTEILT_ANZAHL.singular : NICHT_VERTEILT_ANZAHL.plural, { n }),
    posten,
    leer: n === 0 ? NICHT_VERTEILT_LEER : null,
  };
}

/**
 * Der Reiter „Kostenstellen“: je Kostenstelle des Zeitraums eine Karte, „nicht verteilt“ EINMAL aus der ersten
 * geladenen Antwort, der Satz statt einer Gesamtsumme. Der Stand ist der älteste `berechnet_am` der gezeigten Antworten.
 */
export function kostenstellenBild(
  katalog: Kostenstelle[],
  antworten: ReadonlyMap<string, EnergieAntwort>,
  periode: KostenstelleEnergiePeriode,
  am: string,
): KostenstellenBild {
  const im = kostenstellenImZeitraum(katalog, periode, am);
  const geladen = im
    .map((k) => antworten.get(k.id) ?? null)
    .filter((a): a is KostenstelleEnergie => a !== null && a !== 'fehler');
  const erste = geladen[0] ?? null;
  const aelteste = geladen.reduce<KostenstelleEnergie | null>(
    (a, b) => (a === null || Date.parse(b.berechnet_am) < Date.parse(a.berechnet_am) ? b : a),
    null,
  );
  return {
    zeitraum: zeitraumText(periode, am),
    zone: erste ? fuelle(ZONE, { zone: erste.zeitzone }) : null,
    stand: aelteste ? fuelle(BERECHNET_AM, { am: datumZeit(aelteste.berechnet_am, aelteste.zeitzone) }) : null,
    keineSumme: im.length > 0 ? KEINE_SUMME : null,
    nichtVerteilt: erste ? nichtVerteiltBild(erste.nicht_verteilt, periode, am) : null,
    karten: im.map((k) => karteBild(k, antworten.get(k.id) ?? null, periode, am)),
    vorherBeendet: vorherBeendetText(katalog, am),
    leer: im.length === 0 ? KOSTENSTELLEN_LEER : null,
    alleFehler: im.length > 0 && im.every((k) => antworten.get(k.id) === 'fehler'),
  };
}

// ---------------------------------------------------------------------------------------------- Prozesse

/** Nur die berechneten Messstellen können eine Prozess-Summe sein — nur ihre Prozesse fragt die Fläche ab. */
export const berechnete = (register: MessstelleRegisterZeile[]): MessstelleRegisterZeile[] =>
  register.filter((z) => z.art === 'berechnet');

/** Die Anfrage an die Werte-Route für den Wert einer Prozess-Summe: EIN Schritt über den Zeitraum. */
export const prozessSummeAnfrage = (
  periode: KostenstelleEnergiePeriode,
  am: string,
): { raster: MessstelleWerteRaster; von: string; bis: string } => ({ raster: periode, von: am, bis: ende(periode, am) });

/** Je Prozess die berechneten Messstellen, die ihm an einem Tag des Zeitraums zugeordnet sind. */
export function prozessSummen(
  register: MessstelleRegisterZeile[],
  zuordnungen: ReadonlyMap<string, MessstelleProzesse | 'fehler'>,
  periode: KostenstelleEnergiePeriode,
  am: string,
): Map<string, MessstelleRegisterZeile[]> {
  const bis = ende(periode, am);
  const out = new Map<string, MessstelleRegisterZeile[]>();
  for (const z of berechnete(register)) {
    const antwort = zuordnungen.get(z.id);
    if (!antwort || antwort === 'fehler') continue;
    for (const i of antwort.prozesse) {
      if (!imZeitraum(i, am, bis)) continue;
      const liste = out.get(i.prozess.id) ?? [];
      if (!liste.some((x) => x.id === z.id)) liste.push(z);
      out.set(i.prozess.id, liste);
    }
  }
  return out;
}

export interface ProzessSummeBild {
  id: string;
  kennzeichen: string;
  name: string;
  /** `null` = der Wert ist unterwegs. */
  zahl: string | null;
  zustand: string | null;
  hinweis: string | null;
  sprung: Sprung | null;
}

export interface ProzessKarteBild {
  id: string;
  kennzeichen: string;
  name: string;
  teilVon: string | null;
  gueltig: string | null;
  summen: ProzessSummeBild[];
  ohneSumme: string | null;
}

export interface ProzesseBild {
  zeitraum: string;
  keineSumme: string | null;
  karten: ProzessKarteBild[];
  vorherBeendet: string | null;
  leer: string | null;
  /** Die Zuordnungen der berechneten Messstellen sind noch unterwegs. */
  laedt: boolean;
}

/** Die Antwort der Werte-Route je Kennzeichen: `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type WerteAntwort = MessstelleWerte | 'fehler' | null;

function summeBild(z: MessstelleRegisterZeile, w: WerteAntwort, periode: KostenstelleEnergiePeriode, am: string): ProzessSummeBild {
  const kopf = {
    id: z.id,
    kennzeichen: z.kennzeichen,
    name: z.name ?? z.kennzeichen,
    sprung: sprungziel({ art: 'messstelle', id: z.id, periode: werteperiode(periode, am) }),
  };
  if (w === null) return { ...kopf, zahl: null, zustand: null, hinweis: null };
  if (w === 'fehler') return { ...kopf, zahl: anzeige(null, KWH, periode), zustand: null, hinweis: PROZESS_SUMME_NICHT_ABRUFBAR };
  // EIN Schritt über den Zeitraum — mehr oder keiner ist keine Zahl dieses Zeitraums.
  const schritt = w.werte.length === 1 ? w.werte[0] : null;
  const zustand = schritt?.zustand ?? null;
  return {
    ...kopf,
    zahl: anzeige(schritt?.menge ?? null, w.messstelle.einheit, periode),
    zustand: zustand && zustand !== VOLLSTAENDIG ? zustand : null,
    hinweis: null,
  };
}

/**
 * Der Reiter „Prozesse“: je Prozess des Zeitraums eine Karte mit seiner Prozess-Summe (der berechneten Messstelle, die
 * ihm zugeordnet ist, mit ihrem Wert) — oder dem Satz, dass es keine gibt. `summen === null`: die Zuordnungen fehlen noch.
 */
export function prozesseBild(
  katalog: Prozess[],
  summen: ReadonlyMap<string, MessstelleRegisterZeile[]> | null,
  werte: ReadonlyMap<string, WerteAntwort>,
  periode: KostenstelleEnergiePeriode,
  am: string,
): ProzesseBild {
  const bis = ende(periode, am);
  const im = nachKennzeichen(katalog.filter((p) => imZeitraum(p, am, bis)));
  const karten = im.map((p): ProzessKarteBild => {
    const eltern = p.eltern ? katalog.find((x) => x.id === p.eltern?.id) : undefined;
    const liste = summen?.get(p.id) ?? [];
    return {
      id: p.id,
      kennzeichen: p.kennzeichen,
      name: p.name,
      teilVon: p.eltern ? fuelle(PROZESS_TEIL_VON, { prozess: `${p.eltern.kennzeichen} ${eltern?.name ?? ''}`.trim() }) : null,
      gueltig: gueltigText(p, am),
      summen: nachKennzeichen(liste).map((z) => summeBild(z, werte.get(z.kennzeichen) ?? null, periode, am)),
      ohneSumme: summen !== null && liste.length === 0 ? PROZESS_SUMME_OHNE : null,
    };
  });
  return {
    zeitraum: zeitraumText(periode, am),
    keineSumme: im.length > 0 ? PROZESSE_KEINE_SUMME : null,
    karten,
    vorherBeendet: vorherBeendetText(katalog, am),
    leer: im.length === 0 ? PROZESSE_LEER : null,
    laedt: summen === null,
  };
}
