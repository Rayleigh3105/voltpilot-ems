import type { Bezugsbasis, BezugsbasisAnstoss, BezugsbasisEntwurf, BezugsbasisFaktor, BezugsbasisFassung } from './api';
import * as B from './bezugsbasisAnlegen';
import type { BezugsbasisZustand } from './bezugsbasisUebersicht';
import { beendetSatz, fristSatz } from './bezugsbasisUebersicht';
import { UEMS_BEZUGSBASIS, UEMS_EINFLUSSGROESSE, UEMS_REFERENZPERIODE, UEMS_STATISCHER_FAKTOR } from './glossar';
import { datumText } from './uemsOrtsbaum';

/**
 * Die reinen Sätze der Fassungen einer Bezugsbasis (UEMS AP-17 IP-18, §5.5, §5.8): Zeitleiste, Anstoß, Frist, Faktoren,
 * Fassung n + 1, „beenden“ und „geprüft, bleibt“. Gerechnet wird nichts — die Frist kommt aus dem Leser von IP-17
 * (`zustand`, `faellig_seit_tagen`), Werte und Faktor-Sätze stehen, wie der Server sie liefert
 * (`components/BezugsbasisFassungen.tsx` zeigt nur, was hier entschieden wird). Kundenwörter nur aus `glossar.ts` (SP1).
 */

// ------------------------------------------------------------------------------------------------ Wörter

export const TITEL_NEUE_FASSUNG = 'Neue Fassung bilden';
export const TITEL_BEENDEN = `${UEMS_BEZUGSBASIS} beenden`;
export const TITEL_BLEIBT = 'Geprüft, bleibt';
export const KNOPF_NEUE_FASSUNG = TITEL_NEUE_FASSUNG;
export const KNOPF_BEENDEN = 'Beenden';
export const KNOPF_BLEIBT = 'Geprüft, bleibt';
export const KNOPF_WEITER_ZUM_ASSISTENTEN = `Weiter zur ${UEMS_REFERENZPERIODE}`;
export const ANPASSUNGSGRUENDE_TITEL = 'Anpassungsgründe';
export const FASSUNGEN_TITEL = 'Fassungen';
export const FAKTOREN_TITEL = 'Statische Faktoren';
export const ANSTOSS_TITEL = 'Anstoß liegt vor';
export const ANTWORT_HINWEIS = 'Neue Fassung bilden, die Bezugsbasis beenden oder die Fassung begründet behalten.';
export const GILT_AB_HINWEIS = `Ohne Angabe gilt die neue Fassung ab dem Tag nach ihrer ${UEMS_REFERENZPERIODE}.`;
export const BLEIBT_HINWEIS = 'Die Fassung bleibt unverändert; die Überprüfung beginnt heute neu. Offene Anstöße gelten damit als beantwortet.';
export const BEENDEN_HINWEIS = 'Eine beendete Bezugsbasis wird nie gelöscht. Danach kann die Kennzahl eine neue Bezugsbasis bekommen.';
export const RUECKWIRKEND_HINWEIS = 'Der Tag liegt vor heute — die Bezugsbasis endet rückwirkend.';
export const VORSCHAU_ALT_NEU = 'Vorschau: bisher und neu';

/** A1: die Anpassungsgründe in Kundenwörtern — Reihenfolge des Vokabulars (`bezugsbasis-vectors.json`). */
export const ANPASSUNGSGRUND_WORT: Record<string, string> = {
  referenzperiode_vervollstaendigt: `${UEMS_REFERENZPERIODE} vervollständigt`,
  grundlage_korrigiert: 'Grundlage korrigiert',
  struktur_geaendert: 'Struktur geändert',
  variable_geaendert: `${UEMS_EINFLUSSGROESSE} geändert`,
  methode_geaendert: 'Methode geändert',
  nicht_mehr_anwendbar: 'nicht mehr anwendbar',
  sonstiger: 'sonstiger Grund',
};
export const ANPASSUNGSGRUENDE = Object.keys(ANPASSUNGSGRUND_WORT);
export const grundWort = (g: string): string => ANPASSUNGSGRUND_WORT[g] ?? g;

/** Der Zustand einer Fassung in der Zeitleiste: die vier der Freigabe und „beendet“ (freigegeben mit `gilt_bis`). */
export type FassungZustand = 'entwurf' | 'beantragt' | 'freigegeben' | 'abgelehnt' | 'beendet';
export const ZUSTAND_WORT: Record<FassungZustand, string> = { ...B.FREIGABE_WORT, beendet: 'beendet' };

export const fassungZustand = (f: Pick<BezugsbasisFassung, 'freigabe_status' | 'gilt_bis'>): FassungZustand =>
  f.freigabe_status === 'freigegeben' && f.gilt_bis ? 'beendet' : f.freigabe_status;

export const zustandTon = (z: FassungZustand): 'ok' | 'warn' | 'tint' | 'off' =>
  z === 'freigegeben' ? 'ok' : z === 'abgelehnt' ? 'tint' : z === 'beendet' ? 'off' : 'warn';

// ------------------------------------------------------------------------------------------------ Zeitleiste

/** „gilt ab 01.11.2026“ bzw. „gilt vom 01.11.2026 bis 31.10.2027“ (F4). */
export const geltungText = (f: Pick<BezugsbasisFassung, 'gilt_ab' | 'gilt_bis'>): string =>
  f.gilt_bis ? `gilt vom ${datumText(f.gilt_ab)} bis ${datumText(f.gilt_bis)}` : `gilt ab ${datumText(f.gilt_ab)}`;

/** Basiswert oder Modell-Kurzsatz — die Einzelheiten des Modells zeigt die Modell-Ansicht (IP-14). */
export function wertText(
  f: Pick<BezugsbasisFassung, 'methode' | 'basiswert' | 'koeffizienten' | 'streuung_prozent' | 'variablen'>,
  einheit: string | null,
): string {
  return B.modellText(f, einheit) ?? `${B.methodeWort(f.methode)} ${B.dezimal(f.basiswert)}${einheit ? ` ${B.einheitJe(einheit)}` : ''}`;
}

/** Wer entschieden hat: „freigegeben von Ines Kaltenbach am 12.11.2026“; bei Vier-Augen die zweite Person. */
export function freigeberText(
  f: Pick<BezugsbasisFassung, 'freigabe_status' | 'freigabe' | 'entscheidung' | 'freigegeben_am'>,
): string | null {
  const person = (wort: string, p: { name: string; am: string } | null | undefined, am?: string | null) =>
    p ? `${wort} von ${p.name} am ${B.tagIn(am ?? p.am)}` : null;
  if (f.freigabe_status === 'freigegeben') return person('freigegeben', f.entscheidung ?? f.freigabe, f.freigegeben_am);
  if (f.freigabe_status === 'beantragt') return person('beantragt', f.freigabe);
  if (f.freigabe_status === 'abgelehnt') return person('abgelehnt', f.entscheidung);
  return null;
}

/** „Anpassungsgründe: Grundlage korrigiert, sonstiger Grund („Zählertausch“)“ — ab Fassung 2 (A1, F4). */
export function anpassungText(f: Pick<BezugsbasisFassung, 'anpassungsgruende' | 'anpassung_wortlaut'>): string | null {
  const gruende = f.anpassungsgruende ?? [];
  if (gruende.length === 0) return null;
  const woerter = gruende.map((g) => (g === 'sonstiger' && f.anpassung_wortlaut ? `${grundWort(g)} („${f.anpassung_wortlaut}“)` : grundWort(g)));
  return `${ANPASSUNGSGRUENDE_TITEL}: ${woerter.join(', ')}`;
}

/** Die Fassungen, die neueste oben. */
export const zeitleiste = <T extends { fassung: number }>(fassungen: T[]): T[] => [...fassungen].sort((a, b) => b.fassung - a.fassung);

/** Die laufende freigegebene Fassung (ohne `gilt_bis`) — an ihr hängen Anstoß und Frist. */
export const laufendeFassung = <T extends { fassung: number; freigabe_status: string; gilt_bis?: string | null }>(fassungen: T[]): T | null =>
  zeitleiste(fassungen).find((f) => f.freigabe_status === 'freigegeben' && !f.gilt_bis) ?? null;

/** Ein offener Entwurf oder Antrag sperrt „Neue Fassung bilden“ — er wird erst entschieden (F1/F2). */
export const offeneFassung = <T extends { freigabe_status: string }>(fassungen: T[]): T | null =>
  fassungen.find((f) => f.freigabe_status === 'entwurf' || f.freigabe_status === 'beantragt') ?? null;

// ------------------------------------------------------------------------------------------------ Anstoß und Frist

export const ANSTOSS_ART_WORT: Record<BezugsbasisAnstoss['art'], string> = {
  grundlage_korrigiert: ANPASSUNGSGRUND_WORT.grundlage_korrigiert,
  struktur_geaendert: ANPASSUNGSGRUND_WORT.struktur_geaendert,
  variable_geaendert: ANPASSUNGSGRUND_WORT.variable_geaendert,
  nicht_mehr_anwendbar: ANPASSUNGSGRUND_WORT.nicht_mehr_anwendbar,
};

/** §5.8 „Anstoß“: den Satz spricht der Server (`anlass_satz`); fehlt er, Art und Tag des Anstoßes. */
export function anstossSatz(basis: Pick<Bezugsbasis, 'kennzeichen'>, a: BezugsbasisAnstoss): string {
  if (a.anlass_satz) return a.anlass_satz;
  return `${UEMS_BEZUGSBASIS} ${basis.kennzeichen}: ${ANSTOSS_ART_WORT[a.art] ?? a.art} (${B.tagIn(a.zeitpunkt)}) — Fassung ${a.fassung} prüfen.`;
}

/** Die offenen Anstöße der laufenden Fassung (A4: beantwortete stehen nicht mehr im Kasten). */
export const offeneAnstoesse = (anstoesse: BezugsbasisAnstoss[] | undefined, fassung: number | null): BezugsbasisAnstoss[] =>
  (anstoesse ?? []).filter((a) => a.offen && (fassung === null || a.fassung === fassung));

/** Nur der Zustand „Anstoß liegt vor“ ist bekannt (Rückfall Übersicht, IP-17), nicht sein Anlass. */
export const anstossOhneAnlass = (basis: Pick<Bezugsbasis, 'kennzeichen'>, fassung: number): string =>
  `${UEMS_BEZUGSBASIS} ${basis.kennzeichen}: ${ANSTOSS_TITEL} — Fassung ${fassung} prüfen.`;

/**
 * Die Frist-Zeile (§5.8 „Frist“): aus dem Feld `frist` der Basis (Nachlese 3); fehlt es, als Rückfall der Eintrag der
 * Übersicht (IP-17). Nur, wenn der Server „fällig“ sagt — sonst keine Zeile.
 */
export function fristZeile(
  basis: Pick<Bezugsbasis, 'kennzeichen' | 'frist'>,
  laufend: { fassung: number; freigegeben_am?: string | null } | null,
  rueckfall: BezugsbasisZustand | null,
): string | null {
  if (basis.frist) {
    if (!basis.frist.ueberpruefung_faellig) return null;
    const am = laufend?.freigegeben_am ? B.tagIn(laufend.freigegeben_am).split('.').reverse().join('-') : null;
    return fristSatz({ kennzeichen: basis.kennzeichen, fassung: laufend?.fassung ?? null, freigegeben_am: am, faellig_seit_tagen: basis.frist.faellig_seit_tagen });
  }
  return rueckfall && rueckfall.zustand === 'ueberpruefung_faellig' ? fristSatz(rueckfall) : null;
}

/** Nach „beenden“: was Vergleiche danach sagen (§5.8 „Beendet“, R5). */
export const nachBeendenSatz = (z: Pick<BezugsbasisZustand, 'beendet_zum' | 'beendet_grund'>): string | null =>
  z.beendet_zum ? `Vergleiche danach: ${beendetSatz(z.beendet_zum, z.beendet_grund ? grundWort(z.beendet_grund) : null)}` : null;

export const nachBleibtSatz = (z: BezugsbasisZustand): string =>
  `Geprüft: Fassung ${z.fassung ?? '—'} bleibt${z.faellig_am ? ` · nächste Überprüfung am ${datumText(z.faellig_am)}` : ''}.`;

// ------------------------------------------------------------------------------------------------ Faktoren

/**
 * Je Faktor der Satz des Servers (§17: „Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)“, „… (Wortlaut, ohne
 * Anstoß)“) — fehlt er, aus Art, Kennung, Wert und Stichtag zusammengesetzt, ohne zu rechnen.
 */
export const FAKTOR_ART_WORT: Record<BezugsbasisFaktor['art'], string> = {
  flaeche: 'Fläche', standort: 'Standort', anlage: 'Anlage', prozess: 'Prozess', kostenstelle: 'Kostenstelle', wortlaut: 'Wortlaut',
};
export function faktorSatz(f: BezugsbasisFaktor): string {
  if (f.satz) return f.satz;
  const vorn = `${UEMS_STATISCHER_FAKTOR.charAt(0).toUpperCase()}${UEMS_STATISCHER_FAKTOR.slice(1)}`;
  if (f.art === 'wortlaut') return `${vorn}: ${f.wortlaut ?? ''} (Wortlaut, ohne Anstoß)`;
  const was = [FAKTOR_ART_WORT[f.art], f.kennung, f.bezeichnung].filter(Boolean).join(' ');
  const wert = f.wert ? ` ${B.dezimal(f.wert)}${f.einheit ? ` ${f.einheit}` : ''}` : '';
  return `${vorn}: ${was}${wert} (Stand ${datumText(f.stichtag)})`;
}

// ------------------------------------------------------------------------------------------------ Fassung n + 1

export interface Anpassung {
  gruende: string[];
  wortlaut: string;
  begruendung: string;
  giltAb: string;
}

/** A1/F4 vor dem Senden — die Route prüft dasselbe und hat das letzte Wort. */
export function anpassungFehler(a: Anpassung): { gruende: string | null; wortlaut: string | null; begruendung: string | null } {
  const w = a.wortlaut.trim();
  return {
    gruende: a.gruende.length === 0 ? 'Bitte wählen Sie mindestens einen Anpassungsgrund.' : null,
    wortlaut: !a.gruende.includes('sonstiger')
      ? null
      : w.length === 0
        ? 'Bitte nennen Sie den sonstigen Grund.'
        : w.length > 500
          ? 'Der sonstige Grund hat höchstens 500 Zeichen.'
          : null,
    begruendung: B.begruendungFehler(a.begruendung),
  };
}

/** Der Teil des Körpers von `POST …/fassungen`, den ab Fassung 2 jede Bildung trägt (auch „Monate prüfen“). */
export function anpassungKoerper(a: Anpassung): Pick<BezugsbasisEntwurf, 'anpassungsgruende' | 'anpassung_wortlaut' | 'begruendung' | 'gilt_ab'> {
  return {
    anpassungsgruende: ANPASSUNGSGRUENDE.filter((g) => a.gruende.includes(g)),
    anpassung_wortlaut: a.gruende.includes('sonstiger') ? a.wortlaut.trim() : null,
    begruendung: a.begruendung.trim(),
    ...(a.giltAb ? { gilt_ab: a.giltAb } : {}),
  };
}

/** Ein offener Entwurf ab Fassung 2 trägt seine Gründe schon — „Entwurf bearbeiten“ nimmt sie mit. */
export const anpassungAus = (f: Pick<BezugsbasisFassung, 'anpassungsgruende' | 'anpassung_wortlaut' | 'begruendung'>): Anpassung => ({
  gruende: f.anpassungsgruende ?? [],
  wortlaut: f.anpassung_wortlaut ?? '',
  begruendung: f.begruendung ?? '',
  giltAb: '',
});

/** Die Vorbelegung des Assistenten aus Fassung n: Referenzperiode, Methode, zweite Einflussgröße, Toleranz, Faktoren. */
export interface Vorbelegung {
  von: string;
  bis: string;
  methode: string;
  zweite: string[];
  toleranz: string;
  wiedervorlage: string;
  faktoren: string[];
  wortlaut: string;
}
export function vorbelegung(f: BezugsbasisFassung): Vorbelegung {
  const [von, bis] = f.referenzperiode.split('/');
  return {
    von,
    bis,
    methode: f.methode,
    zweite: f.variablen.filter((v) => v.rolle === 'variable').map((v) => v.bezugsgroesse_id),
    toleranz: B.dezimal(f.toleranz_prozent),
    wiedervorlage: String(f.wiedervorlage_monate),
    faktoren: f.faktoren.filter((x) => x.art !== 'wortlaut' && x.objekt_id).map((x) => x.objekt_id as string),
    wortlaut: f.faktoren.find((x) => x.art === 'wortlaut')?.wortlaut ?? '',
  };
}

/** Die Vorschau alt/neu (§5.5): je Zeile das Wort, Fassung n und die neue — Ungleiches markiert. */
export function vorschauAltNeu(
  alt: BezugsbasisFassung,
  neu: BezugsbasisFassung,
  einheit: string | null,
): { wort: string; alt: string; neu: string; anders: boolean }[] {
  const zeile = (wort: string, a: string, n: string) => ({ wort, alt: a, neu: n, anders: a !== n });
  const faktoren = (f: BezugsbasisFassung) => (f.faktoren.length ? f.faktoren.map(faktorSatz).join(' · ') : 'keine');
  return [
    zeile(UEMS_REFERENZPERIODE, B.referenzperiodeText(alt.referenzperiode), B.referenzperiodeText(neu.referenzperiode)),
    zeile('Methode', wertText(alt, einheit), wertText(neu, einheit)),
    zeile('Datenlage', B.datenlageSaetze(alt).join(' · '), B.datenlageSaetze(neu).join(' · ')),
    zeile('Gültig', geltungText(alt), geltungText(neu)),
    zeile(FAKTOREN_TITEL, faktoren(alt), faktoren(neu)),
    zeile('Prüfsumme', B.pruefsummeKurz(alt.pruefsumme), B.pruefsummeKurz(neu.pruefsumme)),
  ];
}

// ------------------------------------------------------------------------------------------------ Beenden

/** F4 vor dem Senden: Tag, Grund aus A1, Begründung; vor heute nur rückwirkend (die Route: 422 `rueckwirkend_fehlt`). */
export function beendenFehler(b: { tag: string; grund: string; begruendung: string }): { tag: string | null; grund: string | null; begruendung: string | null } {
  return {
    tag: /^\d{4}-\d{2}-\d{2}$/.test(b.tag) ? null : 'Bitte wählen Sie den letzten Tag der Bezugsbasis.',
    grund: ANPASSUNGSGRUENDE.includes(b.grund) ? null : 'Bitte wählen Sie einen Grund.',
    begruendung: B.begruendungFehler(b.begruendung),
  };
}
export const rueckwirkend = (tag: string, heute: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(tag) && tag < heute;

/** Die Ablehnungen von IP-8/IP-17 als Kundensatz; Unbekanntes spricht den Satz der Route. */
export const PFLEGE_SATZ: Record<string, string> = {
  begruendung_fehlt: 'Bitte begründen Sie mit 10 bis 500 Zeichen.',
  grund_unbekannt: 'Bitte wählen Sie einen Grund aus der Liste.',
  rueckwirkend_fehlt: 'Der Tag liegt vor heute — bitte bestätigen Sie das rückwirkende Ende.',
  tag_vor_fassung: 'Der Tag liegt vor dem Beginn der laufenden Fassung.',
  bezugsbasis_beendet: 'Die Bezugsbasis ist bereits beendet.',
  keine_freigegebene_fassung: 'Es gibt noch keine freigegebene Fassung, die bleiben könnte.',
  anpassungsgrund_fehlt: 'Bitte wählen Sie mindestens einen Anpassungsgrund.',
  anpassung_wortlaut: 'Ein sonstiger Grund braucht seinen Wortlaut.',
  gilt_ab_vor_periodenende: `Die neue Fassung kann erst nach dem Ende ihrer ${UEMS_REFERENZPERIODE} gelten.`,
  gilt_ab_vor_vorgaengerin: 'Die neue Fassung kann nicht vor der laufenden Fassung gelten.',
  fassung_beantragt: 'Eine Fassung ist zur Freigabe beantragt — sie wird erst entschieden.',
};
