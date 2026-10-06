import type { BezugsbasisGrund, Kennzahl, KennzahlAuswertung, KennzahlAuswertungZiel } from './api';
import { miniAbweichung, miniLinie, type MiniAbweichung, type MiniLinie } from './auswertenGrafik';
import { abweichungKurz, abweichungSatz, prozentText, urteilAnsicht, type UrteilTon } from './bezugsbasisUrteil';
import { UEMS_KENNZAHL, UEMS_KENNZAHLEN, UEMS_LEITKENNZAHL } from './glossar';
import { GELTUNG_WORT } from './kennzahlKarte';
import { TRENNER, zahlMitStellen } from './uemsErgebnis';
import { ANZEIGE_NACHKOMMASTELLEN, einheitWort, OBERGRENZE, periodeText, UNTERGRENZE } from './uemsKennzahl';

/**
 * Die Liste „Kennzahlen“ (Konzept Auswerten a1 §6.4, §6.10, §6.14) - REIN: aus `GET /api/v1/kennzahlen?mit=auswertung`
 * die zwei Gruppen „Mit Bezugsbasis“ und „Zum Beobachten“, je Karte das Urteil mit den Wörtern der Übersicht, die zwölf
 * Monate, das Energieziel, und die Hinweiskarte bei Handlungsbedarf. Gerechnet wird nichts: Urteil, Abweichungen und die
 * Veränderung zum Vorjahr kommen vom Server; hier wird gewählt, benannt und formatiert.
 */

// ------------------------------------------------------------------ Wörter der Fläche

export const UNTERZEILE =
  'Wie effizient Sie Energie einsetzen - je kg, je Stück oder je m², verglichen mit dem, was zu erwarten war.';
export const unterzeileStandort = (standort: string): string =>
  `Wie effizient ${standort} Energie einsetzt - je kg, je Stück oder je m², verglichen mit dem, was zu erwarten war.`;
export const GRUPPE_MIT = { titel: 'Mit Bezugsbasis', leise: 'zeigen, ob es besser wird' } as const;
export const GRUPPE_OHNE = { titel: 'Zum Beobachten', leise: 'ohne Bezugsbasis' } as const;
export const SPALTEN_MIT = [UEMS_KENNZAHL, 'Wert', 'Gegen die Bezugsbasis', 'Energieziel', '12 Monate'] as const;
export const SPALTEN_OHNE = [UEMS_KENNZAHL, 'Wert', 'Gegen das Vorjahr', 'Bezugsbasis', '12 Monate'] as const;
export const ZWOELF_MONATE = '12 Monate';
export const LISTE_LADEFEHLER = `Die ${UEMS_KENNZAHLEN} ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.`;
export const ANSEHEN = 'Ansehen';
export const OHNE_URTEIL = 'ohne Urteil';
export const KEIN_ENERGIEZIEL = 'kein Energieziel';
export const KEINE_BEZUGSBASIS = 'keine';
export const BEZUGSBASIS_FESTLEGEN = 'Bezugsbasis festlegen';
export const BEZUGSBASIS_VORLAEUFIG = 'Bezugsbasis vorläufig';
export const OHNE_VORJAHR = 'ohne Vorjahreswert';
/** Der Stern an der Leitkennzahl - dieselbe, die die Leitkachel der Übersicht zeigt. */
export const LEITKENNZAHL = `${UEMS_LEITKENNZAHL} - sie steht auf der Übersicht`;
export const archivTitel = (n: number): string => `Archiviert${TRENNER}${n} ${n === 1 ? UEMS_KENNZAHL : UEMS_KENNZAHLEN}`;

// ------------------------------------------------------------------ kleine Wörter

const monatText = (periode: string): string => periodeText('monat', periode);

/** Der Monat nach `periode` (`JJJJ-MM`). */
const naechsterMonat = (periode: string): string => {
  const j = Number(periode.slice(0, 4));
  const m = Number(periode.slice(5, 7));
  return m === 12 ? `${j + 1}-01` : `${j}-${String(m + 1).padStart(2, '0')}`;
};

/** Der Kennzahlwert in zwei Teilen: die Zahl „0,29“ (zwei Stellen, U4) und die Einheit „kWh je kg“. */
export function zahlUndEinheit(
  wert: string | null,
  einheit: string | null,
  richtung: string | null = null,
): { zahl: string | null; einheit: string | null; vor: string | null } {
  if (wert === null) return { zahl: null, einheit: null, vor: null };
  const zahl = zahlMitStellen(wert, ANZEIGE_NACHKOMMASTELLEN, '').trimEnd();
  const vor = richtung === UNTERGRENZE ? 'mindestens' : richtung === OBERGRENZE ? 'höchstens' : null;
  return { zahl, einheit: einheit ? einheitWort(einheit) : null, vor };
}

/** „Prozess Spritzguss“ - das Unternehmen ohne seinen Namen, alles andere mit (§6.4: „März 2029 · Unternehmen“). */
export const ortText = (k: Pick<Kennzahl, 'geltung_art' | 'geltung_name'>): string =>
  k.geltung_art === 'unternehmen' || !k.geltung_name ? GELTUNG_WORT[k.geltung_art] : `${GELTUNG_WORT[k.geltung_art]} ${k.geltung_name}`;

/** Warum der Monat kein Urteil trägt - kurz, für die Marke der Karte; der ganze Satz des Servers steht auf der Seite. */
export function grundKurz(grund: BezugsbasisGrund | null, monat: string, ersterMonat: string | null): string {
  const m = monatText(monat);
  switch (grund) {
    case 'basis_fehlt':
      return ersterMonat ? `Vergleich ab ${monatText(naechsterMonat(ersterMonat))}` : `${m}: noch keine Bezugsbasis`;
    case 'basis_beendet':
      return 'Bezugsbasis beendet';
    case 'keine_werte':
      return `${m}: noch kein Wert`;
    case 'periode_nicht_zu_ende':
      return `${m} läuft noch`;
    case 'variable_fehlt':
      return `${m}: Bezugsgröße fehlt`;
    case 'variable_ausserhalb':
      return `${m}: außerhalb der Spanne`;
    default:
      return `${m}: nicht bewertbar`;
  }
}

/** „2029“ · „2028/2029“ - die Jahre der Zielperiode. */
export function zielJahre(z: Pick<KennzahlAuswertungZiel, 'zielperiode'>): string {
  const [von, bis] = z.zielperiode.split('/');
  const jv = von?.slice(0, 4) ?? '';
  const jb = bis?.slice(0, 4) ?? jv;
  return jv === jb ? jv : `${jv}/${jb}`;
}

/** „Energieziel 2029“. */
export const zielKopf = (z: Pick<KennzahlAuswertungZiel, 'zielperiode'>): string => `Energieziel ${zielJahre(z)}`;

/** „4 % weniger“ aus dem Zielwert (negativ = weniger als erwartet). */
export function zielWert(z: Pick<KennzahlAuswertungZiel, 'zielwert_prozent'>): string {
  return `${prozentText(z.zielwert_prozent, 0)} ${z.zielwert_prozent.trim().startsWith('-') ? 'weniger' : 'mehr'}`;
}

/** „bisher 2,2 % mehr (1 von 10 Monaten)“ · „noch kein Monat bewertbar (0 von 10)“ - der Stand über die Zielperiode (Z3). */
export function zielStandSatz(z: KennzahlAuswertungZiel): string {
  if (z.monate_bewertbar === 0 || z.delta_prozent === null) return `noch kein Monat bewertbar (0 von ${z.monate_soll})`;
  const stand = z.richtung === 'gleich' ? 'bisher wie erwartet' : `bisher ${abweichungKurz(z.delta_prozent, z.richtung)}`;
  return `${stand} (${z.monate_bewertbar} von ${z.monate_soll} ${z.monate_soll === 1 ? 'Monat' : 'Monaten'})`;
}

/** Die Veränderung zum Vorjahr ohne Farbe; Pfeil erst ab 0,5 % (wie die Kacheln der Übersicht). */
export function vorjahrText(v: KennzahlAuswertung['vorjahr']): string | null {
  if (!v) return null;
  const d = Number(v.delta_prozent);
  if (!Number.isFinite(d) || Math.abs(d) < 0.5) return 'unverändert ggü. Vorjahr';
  return `${d > 0 ? '▲' : '▼'} ${prozentText(v.delta_prozent, 0)} ggü. Vorjahr`;
}

// ------------------------------------------------------------------ Modelle

interface Basis {
  id: string;
  kennzeichen: string;
  name: string;
  /** „Prozess Spritzguss · Ines Kaltenbach“ - die Zeile unter dem Namen am Rechner. */
  unter: string;
  zahl: string | null;
  einheit: string | null;
  /** „mindestens“ bei einer Untergrenze (Q3). */
  vor: string | null;
  /** Der Monat des gezeigten Werts, „März 2029“. */
  wertMonat: string | null;
}

/** Eine Karte der Gruppe „Mit Bezugsbasis“. */
export interface KarteMitBasis extends Basis {
  art: 'mit';
  leit: boolean;
  /** „März 2029 · Prozess Spritzguss“. */
  per: string;
  urteil: { wort: string; ton: UrteilTon } | null;
  /** Die Abweichung als Satz: „2,2 % mehr als erwartet“; am Rechner kürzer. */
  abweichung: string | null;
  abweichungKurz: string | null;
  /** Ohne Urteil: warum, kurz („Vergleich ab Dezember 2026“). */
  ohneUrteil: string | null;
  vorlaeufig: boolean;
  /** „± 2 %“ - das Band, im Rahmen am Rechner genannt. */
  band: string | null;
  mini: MiniAbweichung;
  ziel: { kopf: string; jahre: string; wert: string; stand: string } | null;
}

/** Eine Reihe der Gruppe „Zum Beobachten“. */
export interface ReiheOhneBasis extends Basis {
  art: 'ohne';
  /** „unverändert ggü. Vorjahr“, „▲ 3 % ggü. Vorjahr“ - ohne Farbe; `null` ohne Vorjahreswert. */
  vorjahr: string | null;
  /** „Bezugsbasis BB-0003 im Entwurf“ oder `null` = keine. */
  bezugsbasis: string | null;
  linie: MiniLinie;
}

export type HinweisKarte =
  | { art: 'warn'; titel: string; text: string; textKurz: string; ziele: string[] }
  | { art: 'ruhig'; text: string };

export interface KennzahlenListe {
  mit: KarteMitBasis[];
  ohne: ReiheOhneBasis[];
  archiviert: Kennzahl[];
  /** Kennzahlen ohne Monatswerte: die Liste liest ihre Werte wie bisher je Kennzahl. */
  ohneAuswertung: Kennzahl[];
  hinweis: HinweisKarte | null;
}

const unterZeile = (k: Kennzahl): string => [ortText(k), k.verantwortlich_name].filter(Boolean).join(TRENNER);

const basisVon = (k: Kennzahl, a: KennzahlAuswertung | undefined): Basis => {
  const w = a?.wert ?? null;
  const z = zahlUndEinheit(w?.wert ?? null, w?.einheit ?? k.einheit, w?.richtung ?? null);
  return {
    id: k.id,
    kennzeichen: k.kennzeichen,
    name: k.name,
    unter: unterZeile(k),
    zahl: z.zahl,
    einheit: z.einheit ?? (k.einheit_anzeige || null),
    vor: z.vor,
    wertMonat: w ? monatText(w.periode) : null,
  };
};

/**
 * Die Leitkennzahl der Übersicht: unter den Kennzahlen mit offenem Energieziel die mit dem kleinsten Kennzeichen -
 * dieselbe Wahl wie `PortfolioKpiService.leitkennzahl`.
 */
export function leitkennzahl(liste: readonly Kennzahl[]): string | null {
  const mitZiel = liste.filter((k) => k.auswertung?.energieziel).map((k) => k.kennzeichen);
  return mitZiel.length === 0 ? null : [...mitZiel].sort()[0];
}

export function karteMitBasis(k: Kennzahl, leit: boolean): KarteMitBasis {
  const a = k.auswertung as KennzahlAuswertung;
  const v = a.vergleich;
  const urteil = urteilAnsicht(v?.urteil);
  const delta = v?.delta_prozent ?? null;
  const mitZahl = delta !== null && (v?.urteil === 'besser' || v?.urteil === 'schlechter');
  const basis = basisVon(k, a);
  return {
    ...basis,
    art: 'mit',
    leit,
    per: [basis.wertMonat ?? monatText(a.monat), ortText(k)].join(TRENNER),
    urteil,
    abweichung: mitZahl ? abweichungSatz(delta, v?.richtung ?? null) : null,
    abweichungKurz: mitZahl
      ? abweichungKurz(delta, v?.richtung ?? null)
      : v?.urteil === 'im_rahmen' && delta !== null
        ? `${prozentText(delta)}${TRENNER}Band ± ${prozentText(v.band_prozent ?? '2', 0)}`
        : null,
    ohneUrteil: urteil
      ? null
      : v?.urteil === 'ohne_urteil' && delta !== null
        ? `${abweichungKurz(delta, v.richtung)}${TRENNER}${OHNE_URTEIL}, Werte unvollständig`
        : grundKurz(v?.grund ?? null, a.monat, v?.erster_monat ?? null),
    vorlaeufig: k.bezugsbasis?.vorlaeufig === true,
    band: v?.band_prozent ? `± ${prozentText(v.band_prozent, 0)}` : null,
    mini: miniAbweichung(a.monate, v?.band_prozent ?? null),
    ziel: a.energieziel
      ? { kopf: zielKopf(a.energieziel), jahre: zielJahre(a.energieziel), wert: zielWert(a.energieziel), stand: zielStandSatz(a.energieziel) }
      : null,
  };
}

export function reiheOhneBasis(k: Kennzahl): ReiheOhneBasis {
  const a = k.auswertung;
  const b = k.bezugsbasis;
  return {
    ...basisVon(k, a),
    art: 'ohne',
    vorjahr: vorjahrText(a?.vorjahr ?? null),
    bezugsbasis: b ? `${b.kennzeichen} ${b.freigabe_status === 'beantragt' ? 'zur Freigabe' : 'im Entwurf'}` : null,
    linie: miniLinie((a?.monate ?? []).map((m) => m.wert)),
  };
}

/** Die Hinweiskarte nur bei Handlungsbedarf (Variante A der Übersicht); sonst ein ruhiger Satz, wenn es Urteile gibt. */
export function hinweisKarte(mit: readonly KarteMitBasis[], liste: readonly Kennzahl[]): HinweisKarte | null {
  const ueber = liste.filter((k) => k.auswertung?.vergleich?.urteil === 'schlechter');
  if (ueber.length > 0) {
    const monate = [...new Set(ueber.map((k) => (k.auswertung as KennzahlAuswertung).monat))];
    const monat = monate.length === 1 ? `${TRENNER}${monatText(monate[0])}` : '';
    const lang = ueber.map((k, i) => {
      const v = (k.auswertung as KennzahlAuswertung).vergleich;
      const d = v?.delta_prozent;
      if (!d) return k.name;
      return `${k.name} (${i === 0 ? abweichungSatz(d, v?.richtung ?? null) : abweichungKurz(d, v?.richtung ?? null)})`;
    });
    return {
      art: 'warn',
      titel: ueber.length === 1
        ? `1 ${UEMS_KENNZAHL} liegt über der Bezugsbasis`
        : `${ueber.length} ${UEMS_KENNZAHLEN} liegen über der Bezugsbasis`,
      text: `${aufzaehlung(lang)}${monat}`,
      textKurz: `${aufzaehlung(ueber.map((k) => k.name))}${monat}`,
      ziele: ueber.map((k) => k.id),
    };
  }
  const geurteilt = mit.filter((k) => k.urteil !== null);
  if (geurteilt.length === 0) return null;
  const monat = liste.find((k) => k.auswertung?.vergleich)?.auswertung?.monat;
  return { art: 'ruhig', text: `Alle ${UEMS_KENNZAHLEN} mit Urteil liegen im Rahmen oder besser${monat ? `${TRENNER}${monatText(monat)}` : ''}.` };
}

const MINI_WORT: Record<MiniAbweichung['saeulen'][number]['art'], [string, string]> = {
  schlechter: ['Monat über der Bezugsbasis', 'Monate über der Bezugsbasis'],
  im_rahmen: ['Monat im Rahmen', 'Monate im Rahmen'],
  besser: ['Monat besser als die Bezugsbasis', 'Monate besser als die Bezugsbasis'],
  ohne_urteil: ['Monat ohne Urteil', 'Monate ohne Urteil'],
  leer: ['Monat ohne Vergleich', 'Monate ohne Vergleich'],
};

/** Was die kleine Grafik zeigt, als Satz für den Vorleser: „12 Monate: 8 Monate über der Bezugsbasis, 2 im Rahmen …“. */
export function miniZusammenfassung(mini: MiniAbweichung): string {
  const teile = (Object.keys(MINI_WORT) as (keyof typeof MINI_WORT)[])
    .map((art) => [art, mini.saeulen.filter((s) => s.art === art).length] as const)
    .filter(([, n]) => n > 0)
    .map(([art, n]) => `${n} ${MINI_WORT[art][n === 1 ? 0 : 1]}`);
  return `${mini.saeulen.length} Monate: ${aufzaehlung(teile)}.`;
}

const aufzaehlung = (teile: readonly string[]): string =>
  teile.length <= 1 ? (teile[0] ?? '') : `${teile.slice(0, -1).join(', ')} und ${teile[teile.length - 1]}`;

/** Die ganze Liste: nicht archivierte mit Auswertung in zwei Gruppen, Archivierte zugeklappt (nach Kennzeichen). */
export function kennzahlenListe(liste: readonly Kennzahl[]): KennzahlenListe {
  const leit = leitkennzahl(liste);
  const aktiv = liste.filter((k) => k.archiviert_am === null);
  // Handlungsbedarf zuerst (über der Bezugsbasis), sonst nach Kennzeichen - wie die Hinweiskarte darüber sie nennt.
  const mit = aktiv
    .filter((k) => k.auswertung?.vergleich)
    .sort((a, b) => Number(b.auswertung?.vergleich?.urteil === 'schlechter') - Number(a.auswertung?.vergleich?.urteil === 'schlechter'))
    .map((k) => karteMitBasis(k, k.kennzeichen === leit));
  const ohne = aktiv.filter((k) => k.auswertung && !k.auswertung.vergleich).map(reiheOhneBasis);
  return {
    mit,
    ohne,
    archiviert: liste.filter((k) => k.archiviert_am !== null),
    ohneAuswertung: aktiv.filter((k) => !k.auswertung),
    hinweis: hinweisKarte(mit, aktiv),
  };
}
