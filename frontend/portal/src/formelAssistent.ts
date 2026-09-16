/** AP-10 IP-16: Ergänzungen des einen Summenwert-Assistenten; die Rechnung bleibt im Zwilling. */
import type { BerechneteMessstelleAnlegen, MessstelleRegisterZeile, MessstelleVerteilungAnteil } from './api';
import {
  abgeleiteteGroesse as summenGroesse, alsAnfrage as summenAnfrage, entwurfFehler as summenFehler,
  leererEntwurf, MAX_NAME, vorschau as summenVorschau, type Entwurf, type TermEntwurf, type Vorschau,
} from './gesamtwert';
import { hauptgroesse } from './uemsMessstelleFormel';

export type AssistentTyp = 'gewichtete_summe' | 'saldo';
export type FormelTerm = TermEntwurf & { bezug?: { messstelle: string; ziel?: string } };
export type FormelEntwurf = Omit<Entwurf, 'terme'> & { terme: FormelTerm[]; typ: AssistentTyp; gueltigAb: string };
export const heute = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
export const leererFormelEntwurf = (): FormelEntwurf => ({ ...leererEntwurf(), typ: 'gewichtete_summe', gueltigAb: heute() });

export function abgeleiteteGroesse(terme: FormelTerm[], typ: AssistentTyp = 'gewichtete_summe') {
  return typ === 'saldo' && terme.length
    ? hauptgroesse('saldo', 'berechnet', 'Intervallmenge', null).hauptgroesse
    : summenGroesse(terme);
}

export function saldoFehler(terme: FormelTerm[]): string | null {
  return terme.length === 2 && terme.every(t => t.bezug && !t.bezug.ziel && t.faktor === 1 && t.quelle.groesse === 'Wirkenergie')
    && terme.some(t => t.quelle.richtung === 'Bezug' && t.vorzeichen === '+')
    && terme.some(t => t.quelle.richtung === 'Abgabe' && t.vorzeichen === '-')
    ? null : 'Wählen Sie die beiden Hauptzähler für Bezug und Abgabe derselben Anlage. Ein Saldo zählt Bezug minus Abgabe, jeweils mit Faktor 1.';
}

export function entwurfFehler(e: FormelEntwurf): string | null {
  if (!e.gueltigAb) return 'Wählen Sie den ersten Gültigkeitstag.';
  if (e.terme.some(t => t.bezug?.ziel && t.faktor !== 1)) return 'Ein Verteilungs-Anteil folgt der Verteilung und hat immer Faktor 1.';
  if (e.typ === 'saldo') return saldoFehler(e.terme) ?? (!e.name.trim() ? 'Geben Sie dem Wert einen Namen.'
    : e.name.trim().length > MAX_NAME ? `Der Name ist länger als ${MAX_NAME} Zeichen.` : null);
  return summenFehler(e);
}

export function schritt1Fertig(terme: FormelTerm[], typ: AssistentTyp = 'gewichtete_summe') {
  return typ === 'saldo' ? saldoFehler(terme) === null : terme.length > 0 && summenGroesse(terme) !== null;
}

export function vorschau(terme: FormelTerm[], typ: AssistentTyp = 'gewichtete_summe'): Vorschau {
  // Register-Snapshots sind keine Periodenmengen. Ein Verteilungs-Anteil bekommt keinen erfundenen Live-Wert.
  const live = terme.map(t => t.bezug ? { ...t, quelle: { ...t.quelle, wert: null } } : t);
  if (typ === 'saldo') return { wert: null, einheit: 'kWh', unvollstaendig: true, fehlende: terme.map(t => t.quelle.name) };
  if (terme.length && (!summenGroesse(terme) || terme.some(t => !Number.isFinite(t.faktor) || t.faktor === 0))) {
    return { wert: null, einheit: '', unvollstaendig: true, fehlende: terme.map(t => t.quelle.name) };
  }
  return summenVorschau(live);
}

export function alsAnfrage(e: FormelEntwurf): BerechneteMessstelleAnlegen {
  const a = summenAnfrage(e);
  return { ...a, formel_typ: e.typ, gueltig_ab: e.gueltigAb, terme: a.terme.map((t, i) => {
    const b = e.terme[i].bezug;
    return b ? { eingang_art: b.ziel ? 'verteilung' : 'messstelle', quell_messstelle_id: b.messstelle,
      ...(b.ziel ? { verteilung_ziel: b.ziel, anteil: 'gesamt' as const } : {}), vorzeichen: t.vorzeichen, faktor: t.faktor } : t;
  }) };
}

/** Der Geräte-Einstieg bietet ausschließlich Quellen seiner serverseitig aufgelösten Komponenten. */
export function messstellenImKontext(zeilen: MessstelleRegisterZeile[], komponenten: string[], typ: AssistentTyp) {
  return zeilen.filter(m => m.art === 'gemessen' && !m.archiviert_am
    && m.quelle.fuehrend && komponenten.includes(m.quelle.fuehrend.komponente)
    && (typ !== 'saldo' || m.elektrische_stellung?.stellung === 'Hauptzähler'
      && m.hauptgroesse.groesse === 'Wirkenergie' && ['Bezug', 'Abgabe'].includes(m.hauptgroesse.richtung)));
}

export function messstellenTerm(m: MessstelleRegisterZeile, anteil?: MessstelleVerteilungAnteil): FormelTerm {
  return { bezug: { messstelle: m.id, ...(anteil ? { ziel: anteil.kostenstelle.id } : {}) },
    vorzeichen: !anteil && m.hauptgroesse.richtung === 'Abgabe' ? '-' : '+', faktor: 1,
    quelle: { entityId: m.quelle.fuehrend!.komponente, channel: `messstelle:${m.id}:${anteil?.kostenstelle.id ?? ''}`,
      name: anteil ? `${anteil.kostenstelle.kennzeichen} von ${m.kennzeichen} · ${m.name ?? ''}` : `${m.kennzeichen} · ${m.name ?? ''}`,
      geraet: m.quelle.fuehrend?.geraet.bezeichnung ?? null, ...m.hauptgroesse, wert: null, stand: null } };
}

export const FAKTOR_ANTEIL_HINWEIS = 'Meinen Sie einen Kostenstellen-Anteil? Wählen Sie „Verteilungs-Anteil“, damit der Wert Änderungen der Verteilung folgt.';
export function faktorHinweis(terme: FormelTerm[]) {
  return terme.some(t => !t.bezug?.ziel && t.faktor === .7)
    ? FAKTOR_ANTEIL_HINWEIS : null;
}
