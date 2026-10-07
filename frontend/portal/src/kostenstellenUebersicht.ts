/**
 * Die Reiter „Kostenstellen“ und „Prozesse“ der Welt Messstellen am Unternehmen (UEMS AP-13 IP-9 = AP-10 IP-15; Neubau
 * nach dem Messen-Konzept m1 §6.6/§6.7/§8, Captain-Freigabe 05.10.2026) - rein abgeleitet aus
 * `GET /api/v1/unternehmen/kostenstellen/{id}/energie` (AP-10 IP-11) je Kostenstelle,
 * `GET /api/v1/unternehmen/prozesse/{id}/messstellen` (AP-16 IP-14) je Prozess, dem Register (`GET /api/v1/messstellen`)
 * und der Werte-Route je Messstelle.
 *
 * ⚠ **Keine Summe über Kostenstellen oder Prozesse - und kein Satz darüber.** Es gibt keine Summenzeile, also nichts zu
 * erklären (Copy-Prinzip „Antwort zuerst“, Regel 3 „Zeigen statt erklären“); warum, steht im Aufklapper „Was ist eine
 * Kostenstelle?“. Dieses Modul kennt KEINE Zahl über Karten oder Reihen hinweg - kein Feld, keine Funktion.
 *
 * ⚠ **Keine Rechnung.** Jede Menge ist ein Feld der Route bzw. der Werte-Route; gerundet wird nur zur Anzeige über
 * `uemsErgebnis.zahl` (E11). Der Anteil eines Postens („30 %“) ist eine Angabe der Verteilung, keine Menge; „von
 * 88.200 kWh“ ist die Menge der Messstelle aus der Werte-Route, nie ein Produkt aus Anteil und Menge. Die Warnung vor
 * doppelter Zählung sind die Sätze der Route (`verteilung-vectors.json` Regel `doppelzaehlung`) - sie ändert keine Zahl.
 *
 * ⚠ **„Ohne Kostenstelle“ statt „nicht verteilt“** (Konzept §6.6): die Messstellen des Registers, die in KEINER
 * Kostenstelle des Zeitraums als Posten stehen - eine Aussage über die Zuordnung, keine Menge; ihr Wert kommt aus der
 * Werte-Route. Sie steht erst, wenn alle Kostenstellen geantwortet haben (sonst stünde eine Messstelle zu Unrecht darin).
 *
 * ⚠ **Ablesezähler** (bis „Ablesezeiträume verteilen“, Konzept Entscheid 3): die Sicht verteilt je Tag, ein
 * Ablesezeitraum hat keinen Tageswert (Grund `kein_tageswert`). Dann sagt die Fläche das EINMAL und ruhig (§6.11) statt
 * Strichen ohne Grund. Liefert die Route die Menge des Ablesezeitraums, trägt der Posten seine Menge, und der Satz
 * verschwindet von selbst - die Fläche liest dieselben Felder.
 *
 * ⚠ **Prozesse zeigen ihre Messstellen** (Entscheid 4): je Prozess die gemessenen Messstellen mit ihrem Wert; eine
 * Prozess-Summe (eine berechnete Messstelle des Prozesses) hat Vorrang. Mehrere ohne Summe stehen einzeln, nie addiert.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type {
  Kostenstelle,
  KostenstelleDoppeltEnthalten,
  KostenstelleEnergie,
  KostenstelleEnergieBlock,
  KostenstelleEnergiePeriode,
  KostenstelleEnergiePosten,
  MessstelleRegisterZeile,
  MessstelleVerteilung,
  MessstelleWerte,
  Prozess,
  ProzessMessstelle,
  ProzessMessstellen,
  ProzessSummeHinweis,
} from './api';
import { UEMS_BEWERTUNG_SAETZE, UEMS_KOSTENSTELLE, UEMS_MESSSTELLE } from './glossar';
import { woherDerZeile } from './messstellenListe';
import type { Ton } from './messstellen';
import { hashForRoute, pageRoute } from './nav';
import { ROLLE_KUNDENWORT, TEXTE, datumZeit } from './rechte';
import { ende, zeitraumText } from './uebersichtBausteine';
import { KWH, OHNE_ZAHL, VOR_EINHEIT, zahl } from './uemsErgebnis';
import { periodeSchluessel, sprungziel, type Sprung } from './uemsOberflaechen';
import { ERBE_ANTEIL_WECHSELT, GRUND_ANTEIL_WECHSELT } from './uemsVerteilung';

// ------------------------------------------------------------------------------------------------ Wörter

/** Die Unterzeilen der Titel: sie SIND die Erklärung des Worts (Konzept §7, Stufe 1). */
export const KOSTENSTELLEN_SATZ = 'Wem Ihr Verbrauch in der Kostenrechnung zugerechnet wird.';
export const PROZESSE_SATZ = 'Arbeitsschritte, die Energie brauchen – und was sie verbraucht haben.';

/** Was der Aufklapper über die Fläche sagt - der Ort für das „Warum keine Summe“ (Konzept §8.1). */
export const KOSTENSTELLEN_MEHR =
  'Eine Gesamtsumme steht hier nicht: Messstellen können anteilig zu mehreren Kostenstellen gehören, und ein Hauptzähler enthält oft seine Abzweige. Den Gesamtverbrauch zeigt die Übersicht.';
export const PROZESSE_MEHR = 'Eine Messstelle kann zu mehreren Prozessen gehören – darum steht hier keine Summe über alle.';

/** Die Zeitwahl der beiden Reiter (Konzept §6.6): Monat · Jahr. */
export const ZEITWAHL: readonly { id: KostenstelleEnergiePeriode; label: string }[] = [
  { id: 'monat', label: 'Monat' },
  { id: 'jahr', label: 'Jahr' },
];

/** Der Strich der Anzeige („-“): kein Wert, nie 0. */
export const OHNE_WERT = OHNE_ZAHL;

export const GANZ = 'ganz';
/** Messen PR4: der Anteil wechselt mitten in einem Ablesezeitraum - für ihn gibt es keine Menge (Konzept §10.3). */
export const ANTEIL_GEAENDERT_AM = 'Anteil am {tag} geändert';
export const ANTEIL_GEAENDERT = 'Anteil im Ablesezeitraum geändert';
export const OHNE_MENGE_IM_ABLESEZEITRAUM = 'für diesen Ablesezeitraum keine Menge';
/** Wechselt der Anteil nur in EINEM Monat eines längeren Zeitraums, gilt „keine Menge“ nur für ihn (Prüfung r4 S19). */
export const OHNE_MENGE_IM_MONAT = 'für {monat} keine Menge';
/** Messen PR4: ein Monat mit Anteil, aber noch ohne gespeicherte Ablesung. */
export const NOCH_KEINE_ABLESUNG = 'für {monat} noch keine Ablesung';
export const ANTEIL = '{anteil}\u00a0%';
export const ANTEIL_VON = '{anteil}\u00a0% von {menge}';
export const BERECHNET_POSTEN = 'berechnet';
export const NOCH_KEINE_MESSSTELLE = `Noch keine ${UEMS_MESSSTELLE} zugeordnet.`;
export const MESSSTELLE_ZUORDNEN = `${UEMS_MESSSTELLE} zuordnen`;
export const ERNEUT = 'Erneut versuchen';

export const OHNE_KOSTENSTELLE = {
  titel: `Ohne ${UEMS_KOSTENSTELLE}`,
  anzahl: { singular: '1 Messstelle', plural: '{n} Messstellen' },
  satz: `Ihr Verbrauch ist keiner ${UEMS_KOSTENSTELLE} zugerechnet. Ordnen Sie sie an der Messstelle zu, wenn sie in die Kostenrechnung gehören.`,
  kurz: `ihr Verbrauch ist keiner ${UEMS_KOSTENSTELLE} zugerechnet`,
  zustand: `keine ${UEMS_KOSTENSTELLE}`,
  weitere: '{n} weitere',
  alle: 'Alle {n}',
} as const;
/** Nur, wenn es stimmt (Konzept §8.1): keine Messstelle steht ohne Kostenstelle. */
export const ALLE_ZUGEORDNET = `Jede Messstelle gehört einer ${UEMS_KOSTENSTELLE}.`;
/** Wie viele Reihen „Ohne Kostenstelle“ zugeklappt zeigt (Konzept: die ersten drei, „4 weitere ›“). */
export const OHNE_ZUGEKLAPPT = 3;

/** Ablesezähler, solange die Sicht je Tag verteilt (Konzept §6.11) - ruhig, ohne Schuld beim Nutzer. */
export const ABLESUNG_OHNE_TAGESWERT = {
  titel: 'Für {zeitraum} noch keine Werte.',
  satz: 'Ihre Zähler werden monatlich abgelesen, diese Ansicht verteilt heute je Tag. Die Monatsmengen stehen an jeder Messstelle. Sie müssen nichts tun.',
} as const;

export const DOPPELT_MARKE = 'zählt doppelt';
export const DOPPELT_PRUEFEN = 'Verteilung von {kennzeichen} prüfen';
/** Der Anteil eines Postens unter 100 % hinter dem Satz der Route: „MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)“. */
export const DOPPELT_ANTEIL = '(Anteil {anteil} %)';
export const DOPPELT_TITEL = 'Doppelt gezählt';
export const DOPPELT_HINWEIS =
  'Die Summe dieser Kostenstelle enthält diese Mengen doppelt. Die Zahlen bleiben, wie sie gemessen und verteilt sind.';
/** Posten verschiedener Größe: je Größe eine Zahl der Route, nie zusammengezählt. */
export const GETRENNT = 'getrennt nach Größe';

export const GUELTIG_AB = 'gültig ab {tag}';
export const GUELTIG_BIS = 'gültig bis {tag}';
export const AB = 'ab {tag}';
export const BIS = 'bis {tag}';
export const VORHER_BEENDET = 'Vor diesem Zeitraum beendet: {liste}';
/** Zone und Stand einmal am Fuß (Konzept Entscheid 6). */
export const FUSS = 'Zeiten: {zone} · Stand {am}';

export const KOSTENSTELLEN_LEER = 'In diesem Zeitraum besteht keine Kostenstelle.';
export const PROZESSE_LEER = 'In diesem Zeitraum besteht kein Prozess.';
export const NICHT_ABRUFBAR = 'Diese Kostenstelle ist gerade nicht abrufbar.';
export const ALLE_NICHT_ABRUFBAR = 'Die Kostenstellen sind gerade nicht abrufbar.';
export const PROZESSE_NICHT_ABRUFBAR = 'Die Prozesse sind gerade nicht abrufbar.';
export const WERT_NICHT_ABRUFBAR = 'Der Wert ist gerade nicht abrufbar.';

/**
 * Kostenstelle B (21.09.2026): die Mengen je Kostenstelle trägt `…/energie`, und die prüft `messwerte.ansehen` auf
 * Unternehmensebene — eine U-Zelle haben nur diese Rollen, seit AP-19 IP-12 auch Einsicht (`rechte-matrix.json`; der Test
 * hält beides zusammen).
 * Wer sie nicht hat, sieht die Stammdaten der Liste und statt der Zahlen EINEN Satz, warum und wer sie sieht.
 */
export const MENGEN_RECHT = 'messwerte.ansehen';
export const MENGEN_ROLLEN = ['energiemanager', 'kundenadministrator', 'einsicht'] as const;
export const OHNE_MENGEN = `Die Mengen je Kostenstelle sehen nur die Rollen ${ROLLE_KUNDENWORT.energiemanager}, ${ROLLE_KUNDENWORT.kundenadministrator} und ${ROLLE_KUNDENWORT.einsicht}, weil eine Kostenstelle Messstellen aller Standorte umfassen kann.`;

/** {@link OHNE_MENGEN} mit dem Weg aus der Selbstauskunft (Muster AP-03: wer es hat, wen man fragt). */
export function ohneMengenSatz(kundenadministratoren: readonly { name: string }[]): string {
  const namen = kundenadministratoren.map((p) => p.name);
  if (namen.length === 0) return OHNE_MENGEN;
  const weg = namen.length === 1 ? TEXTE.weg_ein_kundenadministrator : TEXTE.weg_kundenadministratoren;
  return `${OHNE_MENGEN} ${weg.replace('{namen}', namen.join(', '))}`;
}

export const PROZESSE_ANZAHL = { singular: '1 Prozess', plural: '{n} Prozesse' } as const;
export const GEMESSEN_VON = 'gemessen von {messstelle}';
export const ZUSAMMENGERECHNET_IN = 'zusammengerechnet in {messstelle}';
export const EINZELN = '{n} Messstellen, einzeln';
export const NOCH_KEINE_MESSSTELLE_KLEIN = `noch keine ${UEMS_MESSSTELLE} zugeordnet`;
export const ZUORDNEN = 'Zuordnen';
export const AUCH_BEI = 'auch bei {prozess} gezählt';
export const PROZESS_TEIL_VON = 'Teil von {prozess}';
export const KEINE_WERTE = 'keine Werte';

const fuelle = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

const einmal = (xs: string[]): string[] => [...new Set(xs)];

/** `2026-10-15` → „15.10.2026“. */
const tag = (t: string): string => `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}`;

const spanneTage = (von: string, bis: string): string => (von === bis ? tag(von) : `${tag(von)}–${tag(bis)}`);

const VOLLSTAENDIG = 'vollständig';
/** Der Grund eines Monats ohne gespeicherte Ablesung (Messen PR4, `KostenstelleEnergieRegeln.GRUND_KEINE_ABLESUNG`). */
const GRUND_KEINE_ABLESUNG = 'keine_ablesung';

/** Ein Name, der vor einer Zahl nicht umbricht („Halle 1“, nie „Halle / 1“) - nur zur Anzeige. */
export const ohneUmbruchVorZahl = (name: string): string => name.replace(/ (?=\d)/g, '\u00a0');

/** Wohin „Messstelle zuordnen“ führt: die Liste der Messstellen - zugeordnet wird an der Messstelle. */
export const ZUORDNEN_HASH = (): string => hashForRoute(pageRoute('portfolio-messstellen'));

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

/**
 * Der Tag, an dem ein Prozess seine Messstellen im Zeitraum zeigt (die Route kennt einen Tag, keinen Zeitraum): der
 * letzte Tag von Zeitraum ∩ Gültigkeit, nicht nach heute. Am ersten Tag sähe ein Prozess oder eine Zuordnung, die im
 * Zeitraum beginnt, keine Messstelle - in der Referenzwelt (Prozesse ab 01.10.2026) das ganze Jahr 2026 (Prüfung r4 S20).
 */
export function zuordnungsTag(
  p: { gueltig_ab: string; gueltig_bis: string | null },
  periode: KostenstelleEnergiePeriode,
  am: string,
  heute: string,
): string {
  const spaetestens = [ende(periode, am), p.gueltig_bis, heute >= am ? heute : null].filter((x): x is string => x !== null).sort()[0];
  return spaetestens < p.gueltig_ab ? p.gueltig_ab : spaetestens;
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
    return menge === null ? OHNE_WERT : `${new Intl.NumberFormat('de-DE').format(menge)}${VOR_EINHEIT}${einheit}`;
  }
}

/** „107.210 kWh“ → Zahl und Einheit getrennt (die Einheit steht klein daneben, Konzept `.gross`). */
export function zahlUndEinheit(text: string): { zahl: string; einheit: string | null } {
  const teile = text.split(VOR_EINHEIT);
  const einheit = teile.length > 1 ? teile.pop() ?? null : null;
  return { zahl: teile.join(VOR_EINHEIT), einheit };
}

const MONAT_KURZ: Readonly<Record<string, string>> = {
  '01': 'Jan', '02': 'Feb', '03': 'Mär', '04': 'Apr', '05': 'Mai', '06': 'Jun',
  '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Okt', '11': 'Nov', '12': 'Dez',
};

/** Der Zeitraum kurz neben einer Zahl: „Sep 2026“ · „2025“. */
export function periodeKurz(periode: KostenstelleEnergiePeriode, am: string): string {
  if (periode === 'jahr') return am.slice(0, 4);
  if (periode === 'monat') return `${MONAT_KURZ[am.slice(5, 7)]} ${am.slice(0, 4)}`;
  return tag(am);
}

/** Die Antwort der Werte-Route je Kennzeichen: `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type WerteAntwort = MessstelleWerte | 'fehler' | null;

/** Der Wert EINER Messstelle im Zeitraum: EIN Schritt der Werte-Route - mehr oder keiner ist keine Zahl des Zeitraums. */
export interface MessstellenWert {
  /** `null` = unterwegs. */
  zahl: string | null;
  zustand: string | null;
  ton: Ton;
  fehler: boolean;
}

export function messstellenWert(w: WerteAntwort, periode: KostenstelleEnergiePeriode): MessstellenWert {
  if (w === null) return { zahl: null, zustand: null, ton: 'still', fehler: false };
  if (w === 'fehler') return { zahl: OHNE_WERT, zustand: WERT_NICHT_ABRUFBAR, ton: 'still', fehler: true };
  const schritt = w.werte.length === 1 ? w.werte[0] : null;
  const menge = schritt?.menge ?? null;
  const zustand = schritt?.zustand ?? KEINE_WERTE;
  return {
    zahl: anzeige(menge, w.messstelle.einheit, periode),
    zustand,
    ton: menge === null ? 'still' : zustand === VOLLSTAENDIG ? 'gut' : 'hinweis',
    fehler: false,
  };
}

/**
 * Messen PR5: das Register trägt mit `letzterMonat` je Messstelle den letzten vollständigen Monat mit GENAU dem Schritt
 * der Werte-Route. Ist der gewählte Zeitraum dieser Monat, ist das der Wert - ohne eigene Abfrage; sonst `null`.
 */
export function registerWert(z: MessstelleRegisterZeile | undefined, periode: KostenstelleEnergiePeriode, am: string): MessstellenWert | null {
  const m = z?.letzter_monat;
  if (!z || !m || periode !== 'monat' || m.monat !== am.slice(0, 7)) return null;
  if (!m.wert) return { zahl: OHNE_WERT, zustand: m.ausserhalb_zugriff ?? KEINE_WERTE, ton: 'still', fehler: false };
  const menge = m.wert.menge;
  const zustand = m.wert.zustand ?? KEINE_WERTE;
  return {
    zahl: anzeige(menge, z.hauptgroesse?.einheit ?? null, periode),
    zustand,
    ton: menge === null ? 'still' : zustand === VOLLSTAENDIG ? 'gut' : 'hinweis',
    fehler: false,
  };
}

/** Der Wert einer Messstelle im Zeitraum: aus dem Register (PR5), sonst aus der Werte-Route. */
export const wertDerMessstelle = (
  z: MessstelleRegisterZeile | undefined,
  w: WerteAntwort,
  periode: KostenstelleEnergiePeriode,
  am: string,
): MessstellenWert => registerWert(z, periode, am) ?? messstellenWert(w, periode);

/** Die Anfrage an die Werte-Route: EIN Schritt über den Zeitraum. */
export const werteAnfrage = (periode: KostenstelleEnergiePeriode, am: string): { raster: KostenstelleEnergiePeriode; von: string; bis: string } => ({
  raster: periode,
  von: am,
  bis: ende(periode, am),
});

// ------------------------------------------------------------------------------------------ Kostenstellen

export interface PostenBild {
  id: string;
  /** Eindeutig in der Karte: dieselbe Messstelle kann in zwei Herkünften stehen (bis 14.10. ganz, ab 15.10. 70 %). */
  schluessel: string;
  kennzeichen: string;
  name: string;
  /** Woher der Posten kommt, in Alltagswörtern: „ganz“, „30 % von 88.200 kWh“, „berechnet · ganz“, „… · ab 15.10.2026“. */
  herkunft: string;
  /** Die Menge der Route für DIESE Kostenstelle; ohne Menge der Strich. */
  zahl: string;
  /** Der Zustand, wenn er weder „vollständig“ noch „keine Werte“ ist (der Strich sagt das schon). */
  zustand: string | null;
  /** Die übrigen Kennzeichen der Route wörtlich („korrigiert (Version 2)“) - ohne die, die die Herkunft schon sagt. */
  woerter: string[];
  /** Zur Messstelle › Werte mit der Periode (B6: jeder Posten ist ein Sprung). */
  sprung: Sprung | null;
  /** Die Warnung an DIESEM Posten, wenn er schon in einem anderen Posten der Kostenstelle steckt (je Summe ein Satz). */
  doppelt: string[];
}

export interface KarteBild {
  id: string;
  kennzeichen: string;
  name: string;
  gueltig: string | null;
  laedt: boolean;
  fehler: string | null;
  /** Die Summe der Route groß („107.210“ + „kWh“) mit Marke; `null` ohne Posten oder ohne Recht auf Mengen. */
  summe: { zahl: string; einheit: string | null; marke: { text: string; ton: 'ok' | 'warn' } | null; getrennt: boolean } | null;
  posten: PostenBild[];
  /** Ohne Messstelle im Zeitraum: „Noch keine Messstelle zugeordnet.“ mit dem Weg. */
  ohneZuordnung: boolean;
  doppelt: DoppeltBild | null;
}

export interface DoppeltBild {
  marke: string;
  saetze: string[];
  /** „Verteilung von MS-07 prüfen ›“ - je Teil der Sprung zur Messstelle. */
  pruefen: { text: string; sprung: Sprung | null }[];
}

export interface OhneReihe {
  id: string;
  kennzeichen: string;
  name: string;
  /** Der Ort („Halle 1“). */
  ort: string | null;
  woher: string;
  wert: MessstellenWert;
  wann: string;
  sprung: Sprung | null;
}

export interface OhneKostenstelleBild {
  titel: string;
  anzahl: string;
  satz: string;
  reihen: OhneReihe[];
}

export interface KostenstellenBild {
  zeitraum: string;
  /** Die Spalte des Werts ab 760 px („September 2026“). */
  wertSpalte: string;
  /** „Zeiten: Europe/Berlin · Stand 06.10.2026 18:35“ - einmal am Fuß. */
  fuss: string | null;
  /** Ablesezähler ohne Tageswert (Konzept §6.11) - einmal oben, ruhig. */
  ablesung: { titel: string; satz: string } | null;
  karten: KarteBild[];
  /** `null` = (noch) nicht sicher bestimmbar; leer gibt es nicht - dann steht {@link ALLE_ZUGEORDNET}. */
  ohne: OhneKostenstelleBild | null;
  alleZugeordnet: boolean;
  vorherBeendet: string | null;
  leer: string | null;
  alleFehler: boolean;
  /** Ohne Recht auf die Mengen: der Satz, warum hier keine Zahlen stehen — die Karten tragen dann nur ihren Kopf. */
  ohneMengen: string | null;
}

/** Die Antwort je Kostenstelle: `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type EnergieAntwort = KostenstelleEnergie | 'fehler' | null;

const BLOECKE = ['gemessen', 'verteilt', 'berechnet'] as const;
type Block = (typeof BLOECKE)[number];

/**
 * Welchen Teil des Zeitraums der Posten trägt („ab 15.10.2026“) - `null`, wenn er ihn ganz trägt. Ein Posten aus
 * Ablesungen (Messen PR4) trägt Monate statt Tage: dann in Monaten („ab Okt 2026“, „Mär 2026–Sep 2026“).
 */
function spanne(p: KostenstelleEnergiePosten, von: string, bis: string): string | null {
  const monate = p.monate ?? [];
  const mit = (
    monate.length > 0
      ? monate.filter((m) => m.anteil_prozent !== null || m.grund === GRUND_ANTEIL_WECHSELT).map((m) => m.monat)
      : p.tage.filter((t) => t.anteil_prozent !== null).map((t) => t.tag)
  ).sort();
  if (mit.length === 0) return null;
  const [erster, letzter] = [mit[0], mit[mit.length - 1]];
  if (monate.length > 0) {
    const [vonMonat, bisMonat] = [von.slice(0, 7), bis.slice(0, 7)];
    const kurz = (m: string) => periodeKurz('monat', `${m}-01`);
    if (erster > vonMonat && letzter < bisMonat) return erster === letzter ? kurz(erster) : `${kurz(erster)}–${kurz(letzter)}`;
    if (erster > vonMonat) return fuelle(AB, { tag: kurz(erster) });
    if (letzter < bisMonat) return fuelle(BIS, { tag: kurz(letzter) });
    return null;
  }
  if (erster > von && letzter < bis) return spanneTage(erster, letzter);
  if (erster > von) return fuelle(AB, { tag: tag(erster) });
  if (letzter < bis) return fuelle(BIS, { tag: tag(letzter) });
  return null;
}

/**
 * Die Anteile eines Postens unter 100 % („70“, „60 und 70“) - aus seinen Tagen, wie die Route sie verteilt hat; `null`
 * bei 100 % oder ohne Anteil. Der Anteil ist eine Angabe der Verteilung, keine Menge: niemand rechnet damit.
 */
function anteilUnterVoll(p: KostenstelleEnergiePosten | undefined): string | null {
  if (!p) return null;
  // Tage (gemessen) oder - bei Ablesungen über Monat und Jahr (Messen PR4) - Monate tragen den Anteil.
  const roh = [...p.tage.map((t) => t.anteil_prozent), ...(p.monate ?? []).map((m) => m.anteil_prozent)];
  const anteile = [...new Set(roh.filter((a): a is number => a !== null && a < 100))];
  if (anteile.length === 0) return null;
  return anteile
    .map((a) => String(a).replace('.', ','))
    .sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))
    .join(' und ');
}

/** Die Kennzeichen der Route, die die Herkunft nicht schon sagt (der Anteil, „nicht verteilt“, der Ablesezeitraum). */
const restWoerter = (woerter: string[], wechselt: boolean): string[] =>
  woerter.filter(
    (w) =>
      !/^verteilt \(/.test(w) &&
      w !== 'nicht verteilt' &&
      !/^Ablesezeitraum/.test(w) &&
      // Wechselt der Anteil im Ablesezeitraum, sagt die Herkunft es in eigenen Worten.
      !(wechselt && (w === ERBE_ANTEIL_WECHSELT || /^Verteilung geändert am /.test(w))),
  );

/** Die Monate eines Postens aus Ablesungen, in denen der Anteil mitten im Ablesezeitraum wechselt (Messen PR4). */
const wechselMonate = (p: KostenstelleEnergiePosten) => (p.monate ?? []).filter((m) => m.grund === GRUND_ANTEIL_WECHSELT);
/** „Anteil am 15.11.2026 geändert“ - der Tag des Wechsels, sonst ohne Tag. */
const geaendert = (m: { geaendert_am: string | null }): string =>
  m.geaendert_am ? fuelle(ANTEIL_GEAENDERT_AM, { tag: tag(m.geaendert_am) }) : ANTEIL_GEAENDERT;
/** Die Monate eines Postens aus Ablesungen, für die noch keine Ablesung gespeichert ist. */
const ohneAblesung = (p: KostenstelleEnergiePosten) => (p.monate ?? []).filter((m) => m.grund === GRUND_KEINE_ABLESUNG);

/**
 * Die Menge der Quelle eines anteiligen Postens („von 88.200 kWh“): bei Ablesungen über EINEN Monat die Monatsmenge der
 * Route (`monate[].quelle_menge`, Messen PR4 - dieselbe Zahl wie die Werte-Route), sonst die Werte-Route; sonst nichts.
 */
function quelleMenge(p: KostenstelleEnergiePosten, w: WerteAntwort, periode: KostenstelleEnergiePeriode): string | null {
  const monate = p.monate ?? [];
  if (monate.length === 1 && monate[0].quelle_menge !== null) return anzeige(monate[0].quelle_menge, p.einheit, periode);
  if (w === null || w === 'fehler') return null;
  const schritt = w.werte.length === 1 ? w.werte[0] : null;
  return schritt?.menge == null ? null : anzeige(schritt.menge, w.messstelle.einheit, periode);
}

/** Trägt der Posten den ganzen Zeitraum mit EINEM Anteil? Nur dann stammt seine Menge aus der ganzen Menge der Quelle. */
const traegtGanz = (p: KostenstelleEnergiePosten, von: string, bis: string): boolean =>
  spanne(p, von, bis) === null && wechselMonate(p).length === 0;

function herkunft(block: Block, p: KostenstelleEnergiePosten, quelle: string | null, von: string, bis: string): string {
  const berechnet = block === 'berechnet' ? BERECHNET_POSTEN : null;
  const wechsel = wechselMonate(p);
  if (wechsel.length > 0 && !(p.monate ?? []).some((m) => m.anteil_prozent !== null)) {
    // Messen PR4: der Anteil wechselt mitten im Ablesezeitraum - keine Zahl, und das in Worten, nicht als Code.
    return [berechnet, geaendert(wechsel[0]), OHNE_MENGE_IM_ABLESEZEITRAUM].filter(Boolean).join(' · ');
  }
  const anteil = anteilUnterVoll(p);
  // „von 15.500 kWh“ nur, wenn EIN Anteil den ganzen Zeitraum trägt: ab 15.10. sind 70 % nie 70 % des Monats, und ein
  // Anteil, der im Zeitraum wechselt („60 und 70“), hat keine EINE Menge, von der er stammt (Prüfung r4 S18).
  const teil =
    anteil === null ? GANZ : quelle && traegtGanz(p, von, bis) && !anteil.includes(' ') ? fuelle(ANTEIL_VON, { anteil, menge: quelle }) : fuelle(ANTEIL, { anteil });
  const fehlt = ohneAblesung(p).map((m) => fuelle(NOCH_KEINE_ABLESUNG, { monat: periodeKurz('monat', `${m.monat}-01`) }));
  // Ein Wechsel in EINEM Monat eines Jahres nimmt nur diesem die Zahl - der Rest des Postens steht (S19).
  const gewechselt = wechsel.flatMap((m) => [geaendert(m), fuelle(OHNE_MENGE_IM_MONAT, { monat: periodeKurz('monat', `${m.monat}-01`) })]);
  return [berechnet, teil, spanne(p, von, bis), ...gewechselt, ...fehlt].filter(Boolean).join(' · ');
}

function postenBild(
  block: Block,
  p: KostenstelleEnergiePosten,
  werte: ReadonlyMap<string, WerteAntwort>,
  periode: KostenstelleEnergiePeriode,
  am: string,
): PostenBild {
  return {
    id: p.messstelle.id,
    schluessel: `${block}:${p.messstelle.id}`,
    kennzeichen: p.messstelle.kennzeichen,
    name: p.messstelle.name ?? p.messstelle.kennzeichen,
    herkunft: herkunft(block, p, quelleMenge(p, werte.get(p.messstelle.kennzeichen) ?? null, periode), am, ende(periode, am)),
    zahl: anzeige(p.menge, p.einheit, periode),
    zustand: p.zustand && p.zustand !== VOLLSTAENDIG && !p.zustand.startsWith(KEINE_WERTE) ? p.zustand : null,
    woerter: restWoerter(p.kennzeichen, wechselMonate(p).length > 0),
    sprung: sprungziel({ art: 'messstelle', id: p.messstelle.id, periode: werteperiode(periode, am) }),
    doppelt: [],
  };
}

/** Die Kennzeichen der anteiligen Posten - ihre Menge („von 88.200 kWh“) liest die Fläche aus der Werte-Route. */
export function anteiligeQuellen(antworten: ReadonlyMap<string, EnergieAntwort>): string[] {
  const out = new Set<string>();
  for (const a of antworten.values()) {
    if (a === null || a === 'fehler') continue;
    for (const b of BLOECKE) {
      for (const p of a[b].posten) {
        // Ablesungen über EINEN Monat bringen die Menge der Messstelle schon mit (Messen PR4) - dann keine Abfrage; und
        // ein Posten, der den Zeitraum nicht ganz trägt, nennt keine Menge „von“ (S18) - dann auch keine.
        const mitMonatsmenge = p.monate?.length === 1 && p.monate[0].quelle_menge !== null;
        if (anteilUnterVoll(p) !== null && !mitMonatsmenge && traegtGanz(p, a.von, a.bis)) out.add(p.messstelle.kennzeichen);
      }
    }
  }
  return [...out].sort();
}

/**
 * Der Satz der Route zu EINEM enthaltenen Posten — wörtlich, dahinter die Tage (wenn nicht der ganze Zeitraum) und der
 * Anteil des Postens (wenn unter 100 %: die Summe trägt dann genau diesen Anteil).
 */
function enthaltenSatz(e: KostenstelleEnergie, x: KostenstelleDoppeltEnthalten, teil: KostenstelleEnergiePosten | undefined): string {
  const ganz = x.zeitraeume.length === 1 && x.zeitraeume[0].von <= e.von && x.zeitraeume[0].bis >= e.bis;
  const anteil = anteilUnterVoll(teil);
  return [
    x.satz,
    ganz ? null : `(${x.zeitraeume.map((z) => spanneTage(z.von, z.bis)).join(', ')})`,
    anteil ? fuelle(DOPPELT_ANTEIL, { anteil }) : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Der Posten mit dem Kennzeichen in den drei Herkünften (ein Teil steht in genau einer). */
function postenVon(e: KostenstelleEnergie, kennzeichen: string): KostenstelleEnergiePosten | undefined {
  return BLOECKE.flatMap((b) => e[b].posten).find((p) => p.messstelle.kennzeichen === kennzeichen);
}

function doppeltBild(e: KostenstelleEnergie, periode: KostenstelleEnergiePeriode, am: string): DoppeltBild | null {
  const { enthalten, nicht_pruefbar } = e.doppelzaehlung;
  if (enthalten.length === 0 && nicht_pruefbar.length === 0) return null;
  const saetze = [...enthalten.map((x) => enthaltenSatz(e, x, postenVon(e, x.teil))), ...nicht_pruefbar.map((n) => n.satz)];
  const teile = [...new Set(enthalten.map((x) => x.teil))];
  return {
    marke: DOPPELT_MARKE,
    saetze: einmal(saetze),
    pruefen: teile.map((kz) => {
      const p = postenVon(e, kz);
      return {
        text: fuelle(DOPPELT_PRUEFEN, { kennzeichen: kz }),
        sprung: p ? sprungziel({ art: 'messstelle', id: p.messstelle.id, periode: werteperiode(periode, am) }) : null,
      };
    }),
  };
}

/** Die Warnung an jedem Posten, der Teil ist: dieselben Sätze wie an der Karte, nur seine. */
function mitDoppelt(posten: PostenBild[], e: KostenstelleEnergie): PostenBild[] {
  if (e.doppelzaehlung.enthalten.length === 0) return posten;
  return posten.map((p) => {
    const saetze = e.doppelzaehlung.enthalten
      .filter((x) => x.teil === p.kennzeichen)
      .map((x) => enthaltenSatz(e, x, postenVon(e, x.teil)));
    return saetze.length === 0 ? p : { ...p, doppelt: einmal(saetze) };
  });
}

function summeBild(b: KostenstelleEnergieBlock, periode: KostenstelleEnergiePeriode, doppelt: boolean): KarteBild['summe'] {
  if (b.grund === 'keine_zuordnung') return null;
  if (b.grund === 'groessen_gemischt') {
    const text = b.summen.map((s) => anzeige(s.menge, s.einheit, periode)).join(' · ');
    return { zahl: text, einheit: null, marke: null, getrennt: true };
  }
  const { zahl: z, einheit } = zahlUndEinheit(anzeige(b.menge, b.einheit, periode));
  const marke =
    b.menge === null || !b.zustand
      ? null
      : b.zustand === VOLLSTAENDIG && !doppelt
        ? { text: VOLLSTAENDIG, ton: 'ok' as const }
        : b.zustand === VOLLSTAENDIG
          ? null
          : { text: b.zustand, ton: 'warn' as const };
  return { zahl: z, einheit, marke, getrennt: false };
}

export function karteBild(
  k: Kostenstelle,
  antwort: EnergieAntwort,
  werte: ReadonlyMap<string, WerteAntwort>,
  periode: KostenstelleEnergiePeriode,
  am: string,
): KarteBild {
  const kopf = { id: k.id, kennzeichen: k.kennzeichen, name: k.name, gueltig: gueltigText(k, am) };
  if (antwort === null || antwort === 'fehler') {
    return { ...kopf, laedt: antwort === null, fehler: antwort === 'fehler' ? NICHT_ABRUFBAR : null, summe: null, posten: [], ohneZuordnung: false, doppelt: null };
  }
  const posten = mitDoppelt(
    BLOECKE.flatMap((b) => antwort[b].posten.map((p) => postenBild(b, p, werte, periode, am))),
    antwort,
  );
  const doppelt = doppeltBild(antwort, periode, am);
  const ohneZuordnung = posten.length === 0;
  return {
    ...kopf,
    laedt: false,
    fehler: null,
    summe: ohneZuordnung ? null : summeBild(antwort.summe, periode, doppelt !== null),
    posten,
    ohneZuordnung,
    doppelt,
  };
}

/** Nur Messstellen, die Werte haben können, gehören in „Ohne Kostenstelle“ (kein Entwurf, nichts Archiviertes). */
const zaehlt = (z: MessstelleRegisterZeile): boolean => z.lebenszyklus !== 'archiviert' && z.lebenszyklus !== 'entwurf' && z.archiviert_am === null;

const istHauptzaehler = (z: MessstelleRegisterZeile): boolean => z.elektrische_stellung?.stellung === 'Hauptzähler';

/** Die Messstellen ohne Kostenstelle im Zeitraum - `null`, solange nicht ALLE Kostenstellen und das Register da sind. */
export function ohneKostenstelle(
  im: Kostenstelle[],
  antworten: ReadonlyMap<string, EnergieAntwort>,
  register: MessstelleRegisterZeile[] | null,
): MessstelleRegisterZeile[] | null {
  if (register === null) return null;
  const geladen = im.map((k) => antworten.get(k.id) ?? null);
  if (geladen.some((a) => a === null || a === 'fehler')) return null;
  const zugeordnet = new Set(
    (geladen as KostenstelleEnergie[]).flatMap((a) => BLOECKE.flatMap((b) => a[b].posten.map((p) => p.messstelle.id))),
  );
  const ohne = nachKennzeichen(register.filter((z) => zaehlt(z) && !zugeordnet.has(z.id)));
  return [...ohne.filter(istHauptzaehler), ...ohne.filter((z) => !istHauptzaehler(z))];
}

/** Ein Posten eines Ablesezählers ohne Tageswert - die Sicht verteilt je Tag (bis „Ablesezeiträume verteilen“). */
function ablesungOhneTageswert(p: KostenstelleEnergiePosten, ablesezaehler: ReadonlySet<string>): boolean {
  return p.menge === null && ablesezaehler.has(p.messstelle.id) && p.tage.length > 0 && p.tage.every((t) => t.grund === 'kein_tageswert');
}

/**
 * Der Reiter „Kostenstellen“: je Kostenstelle des Zeitraums eine Karte mit Summe und Posten (Herkunft statt Blöcken),
 * dazu „Ohne Kostenstelle“ - keine Gesamtsumme, kein Satz darüber. Der Stand ist der älteste `berechnet_am` der Antworten.
 */
export function kostenstellenBild(e: {
  katalog: Kostenstelle[];
  antworten: ReadonlyMap<string, EnergieAntwort>;
  register: MessstelleRegisterZeile[] | null;
  werte: ReadonlyMap<string, WerteAntwort>;
  periode: KostenstelleEnergiePeriode;
  am: string;
  ohneMengen?: string | null;
}): KostenstellenBild {
  const { katalog, antworten, register, werte, periode, am } = e;
  const im = kostenstellenImZeitraum(katalog, periode, am);
  const basis = {
    zeitraum: zeitraumText(periode, am),
    wertSpalte: zeitraumText(periode, am),
    vorherBeendet: vorherBeendetText(katalog, am),
    leer: im.length === 0 ? KOSTENSTELLEN_LEER : null,
  };
  if (e.ohneMengen) {
    return {
      ...basis,
      fuss: null,
      ablesung: null,
      karten: im.map((k) => ({ ...karteBild(k, null, werte, periode, am), laedt: false })),
      ohne: null,
      alleZugeordnet: false,
      alleFehler: false,
      ohneMengen: im.length > 0 ? e.ohneMengen : null,
    };
  }
  const geladen = im
    .map((k) => antworten.get(k.id) ?? null)
    .filter((a): a is KostenstelleEnergie => a !== null && a !== 'fehler');
  const aelteste = geladen.reduce<KostenstelleEnergie | null>(
    (a, b) => (a === null || Date.parse(b.berechnet_am) < Date.parse(a.berechnet_am) ? b : a),
    null,
  );
  const ablesezaehler = new Set((register ?? []).filter((z) => z.quelle.stand === 'ablesung').map((z) => z.id));
  const ablesung = geladen.some((a) => BLOECKE.some((b) => a[b].posten.some((p) => ablesungOhneTageswert(p, ablesezaehler))))
    ? { titel: fuelle(ABLESUNG_OHNE_TAGESWERT.titel, { zeitraum: zeitraumText(periode, am) }), satz: ABLESUNG_OHNE_TAGESWERT.satz }
    : null;
  const ohne = ohneKostenstelle(im, antworten, register);
  return {
    ...basis,
    fuss: aelteste ? fuelle(FUSS, { zone: aelteste.zeitzone, am: datumZeit(aelteste.berechnet_am, aelteste.zeitzone) }) : null,
    ablesung,
    karten: im.map((k) => karteBild(k, antworten.get(k.id) ?? null, werte, periode, am)),
    ohne:
      ohne && ohne.length > 0
        ? {
            titel: OHNE_KOSTENSTELLE.titel,
            anzahl: ohne.length === 1 ? OHNE_KOSTENSTELLE.anzahl.singular : fuelle(OHNE_KOSTENSTELLE.anzahl.plural, { n: ohne.length }),
            satz: OHNE_KOSTENSTELLE.satz,
            reihen: ohne.map((z) => ({
              id: z.id,
              kennzeichen: z.kennzeichen,
              name: z.name ?? z.kennzeichen,
              ort: z.ort.name,
              woher: woherDerZeile(z).zeile,
              wert: wertDerMessstelle(z, werte.get(z.kennzeichen) ?? null, periode, am),
              wann: periodeKurz(periode, am),
              sprung: sprungziel({ art: 'messstelle', id: z.id, periode: werteperiode(periode, am) }),
            })),
          }
        : null,
    alleZugeordnet: ohne !== null && ohne.length === 0 && im.length > 0,
    alleFehler: im.length > 0 && im.every((k) => antworten.get(k.id) === 'fehler'),
    ohneMengen: null,
  };
}

// ---------------------------------------------------------------------------------------------- Prozesse

/** Die Antwort je Prozess: `null` = unterwegs, `'fehler'` = nicht abrufbar. */
export type ZuordnungAntwort = ProzessMessstellen | 'fehler' | null;

/** Eine Messstelle eines Prozesses mit ihrem Wert (bei mehreren ohne Summe: je eine Zeile, nie addiert). */
export interface ProzessTeil {
  id: string;
  kennzeichen: string;
  name: string;
  wert: MessstellenWert;
  sprung: Sprung | null;
}

export interface ProzessReihe {
  id: string;
  kennzeichen: string;
  name: string;
  /** „Teil von P-1 Spritzguss“, sonst der Standort der Messstellen („Werk Ahrenberg“). */
  unter: string | null;
  ton: Ton;
  /** „vollständig“ · „noch keine Messstelle zugeordnet“ · „keine Werte“ … */
  zustand: string;
  /** „gemessen von AZ-3 Zähler Druckluft“ · „zusammengerechnet in MS-20 …“ · „2 Messstellen, einzeln“; `null` ohne Messstelle. */
  quelle: string | null;
  /** „auch bei Montage gezählt“ - die Messstelle zählt schon bei einem Prozess weiter oben. */
  auch: string | null;
  /** Der Wert bei GENAU einer Messstelle (bzw. der Summe); bei mehreren stehen sie als {@link teile}. */
  wert: MessstellenWert | null;
  wann: string;
  teile: ProzessTeil[];
  /** Die ganze Reihe führt zur Messstelle (bei genau einer). */
  sprung: Sprung | null;
  /** Ohne Messstelle: „Messstelle zuordnen ›“ - zugeordnet wird an der Messstelle. */
  zuordnen: boolean;
  hinweise: string[];
  /** Die Zuordnung dieses Prozesses ist unterwegs. */
  laedt: boolean;
  fehler: boolean;
}

export interface ProzesseBild {
  zeitraum: string;
  wertSpalte: string;
  /** „8 Prozesse“ und - haben alle Messstellen EINEN Standort - „Werk Ahrenberg“. */
  anzahl: string;
  standort: string | null;
  reihen: ProzessReihe[];
  vorherBeendet: string | null;
  leer: string | null;
}

export function prozessSummeHinweisSatz(h: ProzessSummeHinweis): string {
  const p = h.prozesse[0] ?? { kennzeichen: '—', name: 'einem anderen Prozess' };
  return UEMS_BEWERTUNG_SAETZE.prozessSummeHinweis(h.summe.name, h.summe.kennzeichen,
    h.messstelle.name, h.messstelle.kennzeichen, p.name, p.kennzeichen,
    h.anteil_prozent, h.verteilung);
}

/** Die Messstellen, die für einen Prozess zählen: eine Prozess-Summe hat Vorrang, sonst die gemessenen. */
export function prozessQuellen(a: ProzessMessstellen): { art: 'summe' | 'gemessen'; messstellen: ProzessMessstelle[] } {
  return a.berechnet.length > 0 ? { art: 'summe', messstellen: a.berechnet } : { art: 'gemessen', messstellen: a.gemessen };
}

/** Die Kennzeichen, deren Wert die Prozesse brauchen (in Reihenfolge, je eines). */
export function prozessKennzeichen(zuordnungen: ReadonlyMap<string, ZuordnungAntwort>): string[] {
  const out = new Set<string>();
  for (const a of zuordnungen.values()) if (a && a !== 'fehler') for (const m of prozessQuellen(a).messstellen) out.add(m.kennzeichen);
  return [...out];
}

const nachKennzeichenListe = <T extends { kennzeichen: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen, 'de', { numeric: true }));

/**
 * Der Reiter „Prozesse“: je Prozess des Zeitraums eine Reihe mit den Messstellen, die ihn messen, und ihrem Wert - oder
 * ruhig „noch keine Messstelle zugeordnet“ mit dem Weg. Keine Summe über Prozesse.
 */
export function prozesseBild(e: {
  katalog: Prozess[];
  zuordnungen: ReadonlyMap<string, ZuordnungAntwort>;
  werte: ReadonlyMap<string, WerteAntwort>;
  register: MessstelleRegisterZeile[] | null;
  periode: KostenstelleEnergiePeriode;
  am: string;
}): ProzesseBild {
  const { katalog, zuordnungen, werte, register, periode, am } = e;
  const bis = ende(periode, am);
  const im = nachKennzeichenListe(katalog.filter((p) => imZeitraum(p, am, bis)));
  const wann = periodeKurz(periode, am);
  const standortVon = (id: string): string | null => register?.find((z) => z.id === id)?.ort.standort_name ?? null;
  const gesehen = new Map<string, string>();
  const alleStandorte = new Set<string>();
  const reihen = im.map((p): ProzessReihe => {
    const eltern = p.eltern ? katalog.find((x) => x.id === p.eltern?.id) : undefined;
    const teilVon = p.eltern ? fuelle(PROZESS_TEIL_VON, { prozess: `${p.eltern.kennzeichen} ${eltern?.name ?? ''}`.trim() }) : null;
    const a = zuordnungen.get(p.id) ?? null;
    const leer = { id: p.id, kennzeichen: p.kennzeichen, name: p.name, wann, teile: [], sprung: null, hinweise: [] as string[] };
    if (a === null || a === 'fehler') {
      return { ...leer, unter: teilVon, ton: 'still', zustand: a === 'fehler' ? PROZESSE_NICHT_ABRUFBAR : '', quelle: null, auch: null, wert: null, zuordnen: false, laedt: a === null, fehler: a === 'fehler' };
    }
    const q = prozessQuellen(a);
    const ms = q.messstellen;
    const standorte = [...new Set(ms.map((m) => standortVon(m.id)).filter((s): s is string => s !== null))];
    for (const s of standorte) alleStandorte.add(s);
    const hinweise = a.hinweise.map(prozessSummeHinweisSatz);
    if (ms.length === 0) {
      return { ...leer, unter: teilVon, ton: 'still', zustand: NOCH_KEINE_MESSSTELLE_KLEIN, quelle: null, auch: null, wert: null, zuordnen: true, hinweise, laedt: false, fehler: false };
    }
    const vorher = ms.map((m) => gesehen.get(m.id)).find((x): x is string => Boolean(x)) ?? null;
    for (const m of ms) if (!gesehen.has(m.id)) gesehen.set(m.id, p.name);
    const teile = ms.map(
      (m): ProzessTeil => ({
        id: m.id,
        kennzeichen: m.kennzeichen,
        name: m.name,
        wert: wertDerMessstelle(register?.find((z) => z.id === m.id), werte.get(m.kennzeichen) ?? null, periode, am),
        sprung: sprungziel({ art: 'messstelle', id: m.id, periode: werteperiode(periode, am) }),
      }),
    );
    const eine = teile.length === 1 ? teile[0] : null;
    const quelle = eine
      ? fuelle(q.art === 'summe' ? ZUSAMMENGERECHNET_IN : GEMESSEN_VON, { messstelle: `${eine.kennzeichen} ${eine.name}` })
      : fuelle(EINZELN, { n: teile.length });
    // Der Zustand der Reihe: der des einen Werts; bei mehreren der „schlechteste“ (Warnung vor ruhig vor gut).
    const tone = teile.map((t) => t.wert);
    const schlechtester =
      tone.find((w) => w.zahl !== null && w.ton === 'hinweis') ?? tone.find((w) => w.zahl !== null && w.ton === 'still') ?? tone[0];
    return {
      ...leer,
      unter: teilVon ?? (standorte.length === 1 ? standorte[0] : null),
      ton: schlechtester.zahl === null ? 'still' : schlechtester.ton,
      zustand: schlechtester.zustand ?? '',
      quelle,
      auch: vorher ? fuelle(AUCH_BEI, { prozess: vorher }) : null,
      wert: eine ? eine.wert : null,
      teile: eine ? [] : teile,
      sprung: eine?.sprung ?? null,
      zuordnen: false,
      hinweise,
      laedt: false,
      fehler: false,
    };
  });
  return {
    zeitraum: zeitraumText(periode, am),
    wertSpalte: zeitraumText(periode, am),
    anzahl: im.length === 1 ? PROZESSE_ANZAHL.singular : fuelle(PROZESSE_ANZAHL.plural, { n: im.length }),
    standort: alleStandorte.size === 1 ? [...alleStandorte][0] : null,
    reihen,
    vorherBeendet: vorherBeendetText(katalog, am),
    leer: im.length === 0 ? PROZESSE_LEER : null,
  };
}

/**
 * „Bei Ihnen bekommt KS-100 Produktion Spritzguss 70 % von MS-20 Spritzguss und KS-200 Montage 30 %.“ - das Beispiel des
 * Aufklappers aus den eigenen Kostenstellen: die erste Messstelle, die anteilig auf zwei Kostenstellen geht; sonst eine,
 * die ganz zu einer gehört. `null` ohne geladene Posten.
 */
export function kostenstelleBeispiel(antworten: ReadonlyMap<string, EnergieAntwort>): { teile: { kostenstelle: string; anteil: string | null }[]; messstelle: string } | null {
  const je = new Map<string, { kostenstelle: string; anteil: string | null }[]>();
  const namen = new Map<string, string>();
  for (const a of antworten.values()) {
    if (a === null || a === 'fehler') continue;
    for (const b of BLOECKE) {
      for (const p of a[b].posten) {
        namen.set(p.messstelle.kennzeichen, `${p.messstelle.kennzeichen} ${p.messstelle.name ?? ''}`.trim());
        const liste = je.get(p.messstelle.kennzeichen) ?? [];
        liste.push({ kostenstelle: `${a.kostenstelle.kennzeichen} ${a.kostenstelle.name}`, anteil: anteilUnterVoll(p) });
        je.set(p.messstelle.kennzeichen, liste);
      }
    }
  }
  const sortiert = [...je.entries()].sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true }));
  const geteilt = sortiert.find(([, l]) => l.length > 1 && l.every((x) => x.anteil !== null));
  const wahl = geteilt ?? sortiert[0];
  if (!wahl) return null;
  const [kz, teile] = wahl;
  // Der größte Anteil zuerst (ein Vergleich von Anteilen als Text, keine Rechnung).
  const groesserZuerst = [...teile].sort((a, b) => (b.anteil ?? '100').localeCompare(a.anteil ?? '100', 'de', { numeric: true }));
  return { messstelle: namen.get(kz) ?? kz, teile: groesserZuerst };
}

/** „Bei Ihnen zum Beispiel Spritzguss, Druckluft und Kühlung.“ - die ersten drei Prozesse mit Messstelle. */
export function prozessBeispiel(bild: ProzesseBild): string[] {
  const mit = bild.reihen.filter((r) => r.quelle !== null).map((r) => r.name);
  return (mit.length > 0 ? mit : bild.reihen.map((r) => r.name)).slice(0, 3);
}

// ------------------------------------------------------------------- Hinweis nach dem Setzen einer Verteilung

export const SETZEN_DOPPELT_GESPEICHERT = 'Die Verteilung ist gespeichert.';
export const SETZEN_DOPPELT_KOSTENSTELLE = `${UEMS_KOSTENSTELLE} {kostenstelle} ab {tag}`;

/** Der Hinweis nach dem Setzen einer Verteilung: je Ziel-Kostenstelle mit Befund ihre Sätze. */
export interface SetzenDoppeltBild {
  titel: string;
  gespeichert: string;
  kostenstellen: { id: string; kopf: string; saetze: string[] }[];
  hinweis: string | null;
}

/**
 * Die Antwort des PUT `…/verteilung` als Hinweis (Captain „warnen, nicht ablehnen“): dieselben Sätze wie am Posten -
 * der Satz der Route, und hinter der gesetzten Messstelle ihr gespeicherter Anteil, wenn er unter 100 % liegt. Die Route
 * prüft genau einen Tag (`am`), darum steht keine Tagesspanne hinter dem Satz. `null` = nichts zählt doppelt (oder das
 * Feld fehlt): der Dialog schließt wie bisher.
 */
export function setzenDoppeltBild(antwort: MessstelleVerteilung, namen: Readonly<Record<string, string>> = {}): SetzenDoppeltBild | null {
  const befunde = (antwort.doppelzaehlung ?? []).filter((d) => d.enthalten.length > 0 || d.nicht_pruefbar.length > 0);
  if (befunde.length === 0) return null;
  const anteilAm = (kostenstelle: string, am: string): string | null => {
    const a = antwort.anteile.find(
      (x) => x.kostenstelle.id === kostenstelle && x.gueltig_ab <= am && (x.gueltig_bis === null || x.gueltig_bis >= am),
    );
    // Der Dezimaltext der Route als Angabe (ohne Nullen hinter dem Komma), nie gerechnet; 100 % trägt keinen Anteil.
    const text = a?.anteil_prozent.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return text && text !== '100' ? text.replace('.', ',') : null;
  };
  return {
    titel: DOPPELT_TITEL,
    gespeichert: SETZEN_DOPPELT_GESPEICHERT,
    kostenstellen: befunde.map((d) => {
      const anteil = anteilAm(d.kostenstelle.id, d.am);
      const saetze = [
        ...d.enthalten.map((x) =>
          x.teil === antwort.kennzeichen && anteil ? `${x.satz} ${fuelle(DOPPELT_ANTEIL, { anteil })}` : x.satz,
        ),
        ...d.nicht_pruefbar.map((n) => n.satz),
      ];
      const name = namen[d.kostenstelle.id];
      return {
        id: d.kostenstelle.id,
        kopf: fuelle(SETZEN_DOPPELT_KOSTENSTELLE, { kostenstelle: name ? `${d.kostenstelle.kennzeichen} ${name}` : d.kostenstelle.kennzeichen, tag: tag(d.am) }),
        saetze: einmal(saetze),
      };
    }),
    hinweis: befunde.some((d) => d.enthalten.length > 0) ? DOPPELT_HINWEIS : null,
  };
}
