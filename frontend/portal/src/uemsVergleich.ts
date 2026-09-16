/**
 * Der VERGLEICH einer Messstelle (UEMS AP-13 IP-5, E6 = A) als reine Ableitung — die zweite Hälfte des Verlaufs
 * (`uemsVerlauf.ts`), die aus einer Reihe eine Einordnung macht.
 *
 * Die Regeln stehen in AP-13 §4.7 (VG1–VG5). Hier wird NICHTS gerechnet, was ein anderes Modul schon rechnet:
 *  - **VG1 · zwei Formen.** (a) die Überlagerung derselben Messstelle mit ihrer Vorperiode oder ihrem Vorjahr
 *    (Umschalter `aus · Vorperiode · Vorjahr`, Adresse `v=`); (b) bis {@link VERGLEICH_HOECHSTENS} passende
 *    Messstellen nebeneinander — „passend“ ist die Regel von IP-1 (`uemsOberflaechen.passend`), der Picker nennt
 *    bei den anderen den Grund.
 *  - **VG2 · das Δ ist die Regel von AP-12.** Gerechnet wird im Zwilling `uemsBericht.vergleich` (Q5/DA1): kWh und
 *    Prozent mit einer Nachkommastelle; fehlt der Vergleichswert, steht der Grund aus `grund_ohne_vergleich`
 *    (`vor_bestehen` · `quelle_beendet` · `keine_werte`) — nie eine 0, nie ein Strich ohne Erklärung. AP-13 bildet
 *    keine eigene Differenz und keinen eigenen Prozentsatz.
 *  - **VG3 · die Ehrlichkeitsregeln des Bestands.** Ohne Vergleichswert kein Δ; eine laufende Periode wird gesagt;
 *    eine Messstelle hat keine Richtung „gut“ — es gibt Zahl und Prozent, nie ein Pfeil-Urteil. Eine Basis, die nicht
 *    „vollständig“ ist, trägt ihr Zustandswort an der Δ-Zeile (der Leser sieht, worauf der Unterschied ruht).
 *  - **VG4 · zwischen Messstellen gibt es kein Δ.** Zwei Reihen, zwei Karten, keine Differenz-Zeile.
 *  - **VG5 · eine datenlose Vergleichsperiode wird gesagt, nicht gezeichnet.**
 *
 * Die Woche hat keine eigene Zahl (die Route kennt kein Wochen-Raster, summiert wird nie) — dort gibt es keine Δ-Zeile,
 * und der Satz sagt, warum. Im Jahr fallen „Vorperiode“ und „Vorjahr“ zusammen; der Umschalter zeigt dann zwei Wahlen.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type { MessstelleGroesse, MessstelleRegisterZeile, MessstelleWerte, MessstelleWerteWert } from './api';
import {
  UEMS_VERGLEICH_ENTFERNEN,
  UEMS_VERGLEICH_GEGENUEBER,
  UEMS_VERGLEICH_GRUND,
  UEMS_VERGLEICH_LAEUFT,
  UEMS_VERGLEICH_OHNE_ZAHL,
  UEMS_VERGLEICH_WAHL,
  UEMS_VERGLEICH_WEITERE_VOLL,
  UEMS_VERGLEICH_WOCHE,
} from './glossar';
import { datumVon, isoWoche, montagDerWoche, verschiebe } from './picker/datum';
import { ANZEIGE_EINHEITEN, KEINE_WERTE, OHNE_ZAHL, TRENNER, VOLLSTAENDIG, korrigiert, menge, pruefeMenge } from './uemsErgebnis';
import {
  GRUENDE_OHNE_VERGLEICH,
  KEINE_WERTE as GRUND_KEINE_WERTE,
  QUELLE_BEENDET,
  VOR_BESTEHEN,
  vergleich as berichtVergleich,
  vergleichGrund,
  vorBeginn,
} from './uemsBericht';
import { VERGLEICH_HOECHSTENS, passend, passendSatz, type Zeitraum } from './uemsOberflaechen';
import { blaettere, ersterTag, letzterTag, wertAm } from './uemsVerlauf';
import { anzeige, monatTitel, tagTitel, type Ton } from './uemsWerteKarte';

const fuelle = (vorlage: string, werte: Record<string, string>): string =>
  Object.entries(werte).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), vorlage);

// ------------------------------------------------------------------ 1 · Der Umschalter (VG1, Adresse `v=`)

export type VergleichWahl = 'aus' | 'vorperiode' | 'vorjahr';

export const VERGLEICH_AUS: VergleichWahl = 'aus';

/** Die Wahlen in der Reihenfolge des Umschalters. */
export const VERGLEICH_WAHLEN: readonly VergleichWahl[] = ['aus', 'vorperiode', 'vorjahr'];

/**
 * Was der Umschalter für DIESEN Zeitraum anbietet. Im Jahr ist die Vorperiode das Vorjahr — zwei Knöpfe mit
 * derselben Wirkung wären eine Behauptung, es gäbe zwei Vergleiche.
 */
export const wahlenFuer = (zeitraum: Zeitraum): readonly VergleichWahl[] =>
  zeitraum === 'jahr' ? ['aus', 'vorjahr'] : VERGLEICH_WAHLEN;

/** Die Optionen des Umschalters mit ihren Wörtern. */
export const wahlOptionen = (zeitraum: Zeitraum): Array<{ id: VergleichWahl; label: string }> =>
  wahlenFuer(zeitraum).map((id) => ({ id, label: UEMS_VERGLEICH_WAHL[id] }));

/**
 * Die Wahl aus der Adresse (`v=vorperiode`). Ein unbekanntes Wort und eine Wahl, die dieser Zeitraum nicht anbietet,
 * sind „aus“ — eine Adresse bestimmt nie mehr, als die Fläche hergibt.
 */
export const wahlAus = (v: string | null | undefined, zeitraum: Zeitraum): VergleichWahl => {
  const w = (v ?? '').trim();
  return (wahlenFuer(zeitraum) as readonly string[]).includes(w) ? (w as VergleichWahl) : VERGLEICH_AUS;
};

/** Was in der Adresse steht — `null` bei „aus“ (der Vorgabe): eine Adresse trägt nur, was gewählt wurde. */
export const wahlHash = (wahl: VergleichWahl): string | null => (wahl === VERGLEICH_AUS ? null : wahl);

// ------------------------------------------------------------------ 2 · Die Vergleichsperiode (VG1, VG5)

const jahrZurueck = (zeitraum: Zeitraum, wert: string): string => {
  if (zeitraum === 'tag') return verschiebe(wert, 0, -12);
  // 52 Wochen behalten den Wochentag; eine „KW 1 des Vorjahres“ über die ISO-Nummer würde den Tag verschieben.
  if (zeitraum === 'woche') return isoWoche(datumVon(verschiebe(ersterTag('woche', wert), -364), 'tag')!);
  if (zeitraum === 'monat') return blaettere('monat', wert, -12);
  return blaettere('jahr', wert, -1);
};

/**
 * Der Wert der Zeit-Leiste, gegen den verglichen wird — `null` bei „aus“. Die Vorperiode ist GENAU die Blätter-Geste
 * des Bestands (`uemsVerlauf.blaettere`), damit „Vergleich“ und „einen Zeitraum zurück“ nie auseinanderlaufen.
 */
export const vergleichsPeriode = (zeitraum: Zeitraum, wert: string, wahl: VergleichWahl): string | null => {
  if (wahl === VERGLEICH_AUS) return null;
  return wahl === 'vorjahr' ? jahrZurueck(zeitraum, wert) : blaettere(zeitraum, wert, -1);
};

/** „Di 03.11.2026“ · „KW 45 2026“ · „Oktober 2026“ · „2025“ — der Name eines Zeitraums in der Δ-Zeile. */
export const periodeTitel = (zeitraum: Zeitraum, wert: string): string => {
  if (zeitraum === 'tag') return tagTitel(wert);
  if (zeitraum === 'monat') return monatTitel(`${wert}-01`);
  if (zeitraum === 'jahr') return wert;
  const montag = montagDerWoche(datumVon(wert, 'woche')!);
  return `KW ${wert.slice(6)} ${montag.getFullYear()}`;
};

/** Die Woche hat keine eigene Zahl — deshalb auch kein Δ (dieselbe Regel wie an der Karte, IP-4). */
export const hatZahl = (zeitraum: Zeitraum): boolean => zeitraum !== 'woche';

/**
 * VG3 — läuft die gezeigte Periode noch? Dann sagt es die Fläche, statt einen halben Zeitraum gegen einen ganzen
 * zu stellen. `null` an einer abgeschlossenen Periode: da gibt es nichts klarzustellen.
 */
export const laufendSatz = (zeitraum: Zeitraum, wert: string, heute: string): string | null =>
  wertAm(zeitraum, heute) === wert ? fuelle(UEMS_VERGLEICH_LAEUFT, { periode: periodeTitel(zeitraum, wert) }) : null;

/** Der Satz, warum die Woche kein Δ trägt. */
export const WOCHE_OHNE_DELTA = UEMS_VERGLEICH_WOCHE;

// ------------------------------------------------------------------ 3 · Die Δ-Zeile (VG2, VG3)

export interface Delta {
  /** „+260 kWh (+4,3 %) gegenüber Oktober 2026 · korrigiert (Version 2)“ — `null`, wo es keinen Unterschied gibt. */
  satz: string | null;
  /** „November 2025: keine Werte — vor Beginn“ — der Grund statt einer 0 (VG2, VG5). */
  ohne: string | null;
  /** Die Differenz und der Prozentsatz, ungerundet wie der Zwilling sie bildet — für Prüfungen, nie für einen Satz. */
  differenz: string | null;
  prozent: string | null;
  /** Der Grund aus `grund_ohne_vergleich`, wenn es keinen Vergleichswert gibt. */
  grund: string | null;
  ton: Ton;
}

/** Was das Bestehen einer Messstelle angeht — so weit das Register von heute es kennt (Q5). */
export interface Bestehen {
  /** Der erste Tag, an dem eine Bindung führt; `null` = unbekannt (dann gibt es nur `keine_werte`). */
  seit: string | null;
  /** Der letzte Tag mit einer führenden Bindung; `null` = die Messstelle misst weiter. */
  beendet: string | null;
}

export const OHNE_BESTEHEN: Bestehen = { seit: null, beendet: null };

/**
 * Was das Register über das Bestehen der Hauptgröße weiß: der Beginn der FRÜHESTEN bekannten Bindung und — nur wenn
 * heute keine mehr führt — das Ende der letzten. Mehr weiß die Fläche nicht, und mehr behauptet sie nicht.
 */
export const bestehenAus = (quelle: MessstelleRegisterZeile['quelle'] | null | undefined): Bestehen => {
  if (!quelle || quelle.stand === 'berechnet') return OHNE_BESTEHEN;
  const bindungen = [quelle.davor, quelle.fuehrend].filter((b): b is NonNullable<typeof b> => b !== null);
  if (bindungen.length === 0) return OHNE_BESTEHEN;
  const tage = bindungen.map((b) => b.gueltig_ab.slice(0, 10)).sort();
  const offen = bindungen.some((b) => b.gueltig_bis === null);
  const enden = bindungen.map((b) => b.gueltig_bis?.slice(0, 10) ?? '').filter(Boolean).sort();
  return { seit: tage[0], beendet: offen || enden.length === 0 ? null : enden[enden.length - 1] };
};

const GRUND_WORT: Readonly<Record<string, string>> = {
  [VOR_BESTEHEN]: UEMS_VERGLEICH_GRUND.vor_bestehen,
  [QUELLE_BEENDET]: UEMS_VERGLEICH_GRUND.quelle_beendet,
  [GRUND_KEINE_WERTE]: UEMS_VERGLEICH_GRUND.keine_werte,
};

/**
 * Der Satz eines Grundes. `vor_bestehen` nennt den Beginn des Energiemanagements, sobald eine Route ihn liefert
 * (Kennzeichen `vor_beginn` des Bericht-Vertrags) — heute nennt ihn keine, dann steht „vor Beginn“ allein.
 */
export const grundSatz = (grund: string, emsSeit: string | null = null): string | null => {
  if (!GRUENDE_OHNE_VERGLEICH.includes(grund)) return null;
  if (grund === VOR_BESTEHEN && emsSeit) return vorBeginn(emsSeit);
  return GRUND_WORT[grund] ?? null;
};

/** Der eine Schritt einer Karte (Raster `tag` · `monat` · `jahr`) — `null`, wo die Antwort keinen trägt. */
const einziger = (a: MessstelleWerte | null): MessstelleWerteWert | null => a?.werte[0] ?? null;

/** Spricht dieser Schritt eine Zahl? Genau die Prüfung der Karte (`uemsWerteKarte.anzeige`), nie eine eigene. */
const spricht = (a: MessstelleWerte, w: MessstelleWerteWert): boolean => anzeige(a, w, false).zustand !== null && w.menge !== null;

const betrag = (w: number): string => String(w);

/** Das Vorzeichen einer Differenz aus ihrem Text — gerechnet wird damit nicht. */
const positiv = (d: string): boolean => !d.startsWith('-') && !/^0(\.0*)?$/.test(d);

export interface DeltaEingang {
  zeitraum: Zeitraum;
  /** Die Karte der gezeigten Periode (EIN Schritt) — `null`, solange sie lädt. */
  aktuell: MessstelleWerte | null;
  /** Die Karte der Vergleichsperiode — `null`, solange sie lädt. */
  vergleich: MessstelleWerte | null;
  /** Der Wert der Zeit-Leiste der Vergleichsperiode (`JJJJ-MM` …). */
  periode: string;
  bestehen?: Bestehen;
  /** Der Beginn des Energiemanagements, wenn ihn eine Route nennt — heute: keine (Befund IP-5). */
  emsSeit?: string | null;
}

/**
 * Die Δ-Zeile einer Reihe gegen IHRE eigene Vergangenheit (VG2, VG3). `null`, solange eine der beiden Karten fehlt
 * und in der Woche (dort gibt es keine Zahl). Gerechnet wird in `uemsBericht.vergleich`; hier stehen nur die Wörter.
 */
export const delta = (e: DeltaEingang): Delta | null => {
  if (!hatZahl(e.zeitraum) || !e.aktuell || !e.vergleich) return null;
  const titel = periodeTitel(e.zeitraum, e.periode);
  const av = einziger(e.aktuell);
  const vv = einziger(e.vergleich);
  const b = e.bestehen ?? OHNE_BESTEHEN;
  const hatWerte = vv !== null && spricht(e.vergleich, vv);
  const grund = vergleichGrund({
    erster_tag: ersterTag(e.zeitraum, e.periode),
    letzter_tag: letzterTag(e.zeitraum, e.periode),
    besteht_seit: b.seit,
    beendet_am: b.beendet,
    hat_werte: hatWerte,
  });

  const gespeichert = e.aktuell.messstelle.einheit;
  const ebene = e.aktuell.raster;
  const anzeigbar = pruefeMenge(gespeichert, ebene).length === 0;
  // Der Zwilling rechnet in der GESPEICHERTEN Einheit (er bekommt die Beträge der Route); seine eigene Schreibweise
  // `anzeige_differenz` bräuchte die Anzeige-Einheit und wird hier nicht gelesen — die Zahl spricht `menge` (E11).
  const angezeigt = ANZEIGE_EINHEITEN.find((x) => x.gespeichert === gespeichert)?.angezeigt ?? gespeichert;
  const eigen = av !== null && spricht(e.aktuell, av) ? av : null;

  // VG2/VG5: ohne Vergleichswert steht der Grund — nie eine 0, nie ein Strich ohne Erklärung.
  if (grund !== null || vv === null || !hatWerte || !anzeigbar) {
    const v = berichtVergleich({
      aktuell: eigen?.menge != null ? betrag(eigen.menge) : null,
      vergleich: null,
      einheit: angezeigt,
      ebene,
      grund: grund ?? GRUND_KEINE_WERTE,
    });
    const satz = grundSatz(v.grund ?? GRUND_KEINE_WERTE, e.emsSeit ?? null);
    const zustand = [v.zustand ?? KEINE_WERTE, satz].filter((t): t is string => t !== null && t.length > 0).join(' — ');
    return { satz: null, ohne: fuelle(UEMS_VERGLEICH_OHNE_ZAHL, { periode: titel, zustand }), differenz: null, prozent: null, grund: v.grund, ton: 'off' };
  }

  // VG3: ohne eigene Zahl gibt es nichts zu vergleichen — die Karte sagt schon, warum sie fehlt.
  if (!eigen || eigen.menge === null) return { satz: null, ohne: null, differenz: null, prozent: null, grund: null, ton: 'off' };

  const v = berichtVergleich({
    aktuell: betrag(eigen.menge),
    vergleich: betrag(vv.menge!),
    einheit: angezeigt,
    ebene,
    grund: null,
  });
  // Die Zahl der Differenz spricht `menge` (E11: gespeicherte Einheit → Anzeige-Einheit) — der Zwilling liefert
  // den exakten Betrag, AP-13 rundet ihn nicht selbst.
  const zahl = v.differenz === null ? OHNE_ZAHL : `${positiv(v.differenz) ? '+' : ''}${menge(v.differenz, gespeichert, ebene)}`;
  const zusatz = [
    vv.zustand !== null && vv.zustand !== VOLLSTAENDIG ? vv.zustand : null,
    vv.version !== null && vv.version >= 2 ? korrigiert(vv.version) : null,
  ].filter((t): t is string => t !== null);
  const kopf = `${zahl} (${v.anzeige_prozent}) ${fuelle(UEMS_VERGLEICH_GEGENUEBER, { periode: titel })}`;
  return {
    satz: [kopf, ...zusatz].join(TRENNER),
    ohne: null,
    differenz: v.differenz,
    prozent: v.prozent,
    grund: null,
    // Eine Messstelle hat keine Richtung „gut“ (VG3) — der Ton ordnet nie, er ruht.
    ton: 'off',
  };
};

// ------------------------------------------------------------------ 4 · Weitere Reihen (VG1b, VG4, O12)

/** Eine Reihe im Bild: die eigene Messstelle zuerst, dann die gewählten weiteren. */
export interface ReihenWahl {
  id: string;
  kennzeichen: string;
  name: string | null;
}

export interface ReihenOption extends ReihenWahl {
  passend: boolean;
  /** „nicht passend: Laden / Entladen“ — bei einer passenden Messstelle `null` (IP-1). */
  grund: string | null;
}

const beschriftung = (z: Pick<MessstelleRegisterZeile, 'kennzeichen' | 'name'>): string =>
  [z.kennzeichen, z.name].filter(Boolean).join(' · ');

export const reihenName = beschriftung;

/**
 * Was der Picker „Weitere Messstelle“ zeigt (O12): ALLE Messstellen des Zugriffs — die passenden wählbar, die
 * anderen mit dem Grund, warum sie nicht passen. Eine leere Liste wäre keine Auskunft. Schon gezeigte Reihen und die
 * eigene stehen nicht darin; die Reihenfolge ist passend zuerst, dann nach Kennzeichen.
 *
 * ⚠ `schon` sind KENNZEICHEN, nicht Kennungen: die eigene Messstelle kommt über ihr Kennzeichen aus der Adresse, und
 * die Hauptgrößen stehen alle im Register — verglichen wird also eine Registerzeile mit einer Registerzeile.
 */
export const reihenOptionen = (
  basis: MessstelleGroesse,
  zeilen: readonly MessstelleRegisterZeile[],
  schon: readonly string[],
): ReihenOption[] =>
  zeilen
    .filter((z) => !schon.includes(z.kennzeichen))
    .map((z) => {
      const p = passend(basis, z.hauptgroesse);
      return { id: z.id, kennzeichen: z.kennzeichen, name: z.name, passend: p.passend, grund: passendSatz(p) };
    })
    .sort((a, b) => Number(b.passend) - Number(a.passend) || a.kennzeichen.localeCompare(b.kennzeichen, 'de'));

/** Darf noch eine Reihe dazu? `reihen` zählt die eigene mit (VG1: bis drei). */
export const weitereMoeglich = (reihen: number): boolean => reihen < VERGLEICH_HOECHSTENS;

/** Der Satz, wenn das Bild voll ist — der Picker bleibt sichtbar und sagt, warum er nicht mehr annimmt. */
export const VOLL_SATZ = fuelle(UEMS_VERGLEICH_WEITERE_VOLL, { n: String(VERGLEICH_HOECHSTENS) });

/** „MS-11 · Spritzguss SG07–SG10 aus dem Bild nehmen“ — der Name des Knopfes an einer weiteren Reihe. */
export const entfernenName = (r: ReihenWahl): string => fuelle(UEMS_VERGLEICH_ENTFERNEN, { messstelle: beschriftung(r) });
