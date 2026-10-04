/**
 * **MiSpeL · Mengen nach Anlage 1** (MP-18, Bedienkonzept BK-18 Variante A) — das reine Ansichtsmodell der Karte in
 * Verlauf › Erlöse (Monat und Jahr).
 *
 * ⚠ Keine eigene Rechnung: jede Menge und jeder Betrag kommt aus der Route
 *   `GET /api/v1/sites/{id}/mispel/abgrenzung/monate/{JJJJ-MM}` bzw. `…/jahre/{JJJJ}` — gelesen aus den gespeicherten
 *   Läufen des Rechenwerks (MP-8, MP-21). Hier wird nur formatiert und beschriftet; die Breite eines Balkenstücks ist
 *   sein Anteil an der Einspeisung (4) — Darstellung, keine Zahl, die irgendwo steht.
 * ⚠ Unbekannt ist nie 0: ein Betrag `offen` bleibt „offen“, ein Monat ohne Lauf heißt „noch nicht bestimmt“.
 * ⚠ Die Farben sind die der Festlegung (A1 S. 18, Abschn. 2.3) und stehen nie allein — immer mit Wort und Formelnummer.
 */
import { NBSP, eurAmount } from './format';
import type { MispelGutschrift } from './speicherAussage';

export type MispelFarbeId = 'gruen' | 'gelb' | 'rot' | 'grau';

export interface MispelMenge {
  nr: string;
  begriff: string;
  fundstelle: string;
  kwh: number | null;
}

export interface MispelFarbe {
  farbe: MispelFarbeId;
  formel: string;
  begriff: string;
  fundstelle: string;
  kwh: number | null;
}

export interface MispelAenderung {
  vorherFassung: number;
  vorherWertequelle: string | null;
  vorherGruende: string[];
  vorherSummeEur: number | null;
  differenzEur: number | null;
}

export interface MispelTeil {
  schluessel: string;
  ersterTag: string;
  letzterTag: string;
  formelsatz: string;
  formelsatzBezeichnung: string;
  fassung: number;
  stand: 'endgueltig' | 'vorlaeufig';
  standGruende: string[];
  wertequelle: string | null;
  gerechnetAm: string;
  luecken: number;
  einspeisung: MispelMenge;
  farben: MispelFarbe[];
  netzbezug: MispelMenge;
  umlagereduziert: MispelMenge;
  umlagebelastet: MispelMenge;
  foerderfaehig: MispelMenge | null;
  aenderung: MispelAenderung | null;
}

export interface MispelBetrag {
  stand: 'bestimmt' | 'offen';
  eur: number | null;
  mengeKwh: number | null;
  formel: string;
  satzCt: number | null;
  grund: string | null;
}

export interface MispelWert {
  vermiedeneUmlagen: MispelBetrag;
  vermiedenesNetzentgelt: MispelBetrag;
  marktpraemie: MispelBetrag | null;
  summeOhneMarktpraemieEur: number | null;
  ustPct: number | null;
}

export interface MispelMonat {
  monat: string;
  foerderweg: string | null;
  foerderwegBegriff: string | null;
  mispel: boolean;
  abgrenzung: boolean;
  stand: 'endgueltig' | 'vorlaeufig' | null;
  gruende: string[];
  giltAlsNachweis: boolean;
  teile: MispelTeil[];
  wert: MispelWert | null;
}

export interface MispelJahr {
  jahr: number;
  mispel: boolean;
  abgrenzung: boolean;
  stand: 'endgueltig' | 'vorlaeufig' | null;
  gruende: string[];
  giltAlsNachweis: boolean;
  monate: MispelMonat[];
  wert: MispelWert | null;
  mitteilungBis: string;
}

/** Empfänger des Nachweises — Rollen der Festlegung (A1 Abschn. 4.3, 4.4), nie Unternehmen. */
export const EMPFAENGER = [
  { id: 'lieferant', label: 'Lieferant', satz: 'umlagereduzierende Menge für seine Mitteilung bis 31.05. — (3) (16) (19) (20) (21)' },
  { id: 'direktvermarkter', label: 'Direktvermarkter', satz: 'förderfähige Mengen — (4) (26) (31) (32)' },
  { id: 'netzbetreiber', label: 'Netzbetreiber', satz: 'beides, zur Prüfung und für die Marktprämie' },
] as const;
export type MispelEmpfaenger = (typeof EMPFAENGER)[number]['id'];

/** Wort und Kurzwort je Farbe (A1 S. 18): Kundendeutsch vorn, der Begriff der Festlegung steht daneben. */
export const FARBE: Record<MispelFarbeId, { wort: string; kurz: string }> = {
  gruen: { wort: 'Grün · förderfähig, direkt aus der PV', kurz: 'Grün · gefördert, direkt aus der PV' },
  gelb: { wort: 'Gelb · förderfähig, aus dem Speicher', kurz: 'Gelb · gefördert, aus dem Speicher' },
  rot: { wort: 'Rot · saldierungsfähig, Netzstrom aus dem Speicher', kurz: 'Rot · saldiert, Netzstrom aus dem Speicher' },
  grau: { wort: 'weder gefördert noch saldiert', kurz: 'ohne Prämie, ohne Saldierung' },
};

/** „18.420 kWh“ — ganze kWh, gerundet nur für die Anzeige (die Route liefert 3 Nachkommastellen). */
export function kwhText(kwh: number | null | undefined): string {
  if (kwh == null) return 'offen';
  return `${Math.round(kwh).toLocaleString('de-DE')}${NBSP}kWh`;
}

/** „+ 175,40 €“ für einen Betrag, „offen“ für unbekannt — nie „0 €“ für unbekannt. */
export function betragText(b: { stand: string; eur: number | null } | null | undefined): string {
  if (!b || b.stand !== 'bestimmt' || b.eur == null) return 'offen';
  return `${b.eur < 0 ? '−' : '+'}${NBSP}${eurAmount(Math.abs(b.eur))}`;
}

export function euroText(v: number | null | undefined): string {
  if (v == null) return 'offen';
  return `${v < 0 ? '−' : '+'}${NBSP}${eurAmount(Math.abs(v))}`;
}

/** Breite je Balkenstück in Prozent der Einspeisung (4); ohne Einspeisung kein Balken. */
export function balken(teil: Pick<MispelTeil, 'einspeisung' | 'farben'>): Array<{ farbe: MispelFarbeId; pct: number }> {
  const summe = teil.einspeisung.kwh ?? 0;
  if (summe <= 0) return [];
  return teil.farben.map((f) => ({ farbe: f.farbe, pct: Math.max(0, ((f.kwh ?? 0) / summe) * 100) }));
}

/** Der Stand als Chip: endgültig mit der Quelle der Werte, vorläufig mit „Gerätewerte“ oder dem Grund. */
export function standText(stand: MispelMonat['stand'], teile: MispelTeil[]): { text: string; ton: 'ok' | 'gelb' | 'leer' } {
  if (stand == null) return { text: 'noch nicht bestimmt', ton: 'leer' };
  if (stand === 'endgueltig') return { text: 'endgültig · Messstellenbetreiber', ton: 'ok' };
  const geraet = teile.some((t) => t.wertequelle === 'geraet');
  return { text: geraet ? 'vorläufig · Gerätewerte' : 'vorläufig', ton: 'gelb' };
}

/** Die Gründe eines vorläufigen Laufs in Kundendeutsch (Codes aus MP-8 `stand_gruende`). */
export function grundText(code: string): string {
  const [art, wo] = code.split(':');
  switch (art) {
    case 'wertequelle_geraet':
      return 'Gerätewerte statt Werte des Messstellenbetreibers';
    case 'luecken':
      return 'Viertelstunden fehlen noch';
    case 'zeitraum_offen':
      return 'der Monat läuft noch';
    case 'viertelstunden_vorlaeufig':
      return 'Werte noch nicht endgültig';
    case 'aw_rueckfall':
      return 'AW>0-Zeiten noch nicht aus der Liste des Übertragungsnetzbetreibers';
    case 'lauf_vorlaeufig':
      return `Rumpfmonat ${wo ?? ''} vorläufig`.trim();
    case 'zeitraum_luecke':
      return 'eine Lücke zwischen zwei Rumpfmonaten';
    default:
      return art.startsWith('zaehler_') ? `Zähler ${wo ?? ''}: ${art.slice(8).replace(/_/g, ' ')}`.trim() : code;
  }
}

/** Warum ein Betrag offen ist (Code der Route). */
export function offenText(grund: string | null): string {
  switch (grund) {
    case 'jahresmarktwert_offen':
      return 'rechnet mit dem Jahresmarktwert Solar; den veröffentlichen die Übertragungsnetzbetreiber nach Jahresende';
    case 'anzulegender_wert_fehlt':
      return 'der anzulegende Wert der Anlage fehlt in den Einstellungen';
    case 'je_anlage_a5':
      return 'je Anlage mit ihrem eigenen anzulegenden Wert (Sonderfall A5)';
    case 'preisblatt_fehlt':
      return 'Satz fehlt im Preisblatt der Anlage';
    default:
      return 'noch nicht bestimmbar';
  }
}

/** „Stand 10.12., 13:00“ aus der Rechenzeit des jüngsten Laufs. */
export function standZeit(teile: MispelTeil[]): string | null {
  const zeiten = teile.map((x) => x.gerechnetAm).sort();
  const t = zeiten[zeiten.length - 1];
  if (!t) return null;
  const d = new Date(t);
  const tag = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
  const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return `Stand ${tag}, ${uhr}`;
}

/** „November 2026“ aus „2026-11“. */
export function monatName(monat: string): string {
  const [j, m] = monat.split('-').map(Number);
  return new Date(j, m - 1, 15).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

/** „31.05.2027“ aus einem ISO-Tag. */
export function tagText(iso: string): string {
  const [j, m, d] = iso.split('-');
  return `${d}.${m}.${j}`;
}

/** Ob die Seite den Arbitrage-Ausweis zeigen darf: für MiSpeL-Anlagen zählt nur die amtliche Formel (W5). */
export function arbitrageAusweisErlaubt(mispel: Pick<MispelMonat, 'mispel'> | Pick<MispelJahr, 'mispel'> | null): boolean {
  return !mispel?.mispel;
}

/**
 * MiSpeL MP-18c (BK-W5 A): die Gutschrift (20) des Monats für die Steuerungs-Karte — der Betrag erst, wenn beide Teile
 * (vermiedene Umlagen und vermiedenes Netzentgelt) bestimmt sind; sonst „offen“. Ohne Lauf (kein `wert`) und an
 * Anlagen ohne MiSpeL gibt es nichts hereinzureichen.
 */
export function mispelGutschrift(m: MispelMonat | null): MispelGutschrift | null {
  if (!m?.mispel || !m.wert) return null;
  const { vermiedeneUmlagen: u, vermiedenesNetzentgelt: n, summeOhneMarktpraemieEur: summe } = m.wert;
  const [j, mm] = m.monat.split('-').map(Number);
  const monat = new Date(j, mm - 1, 15).toLocaleDateString('de-DE', { month: 'long' });
  return {
    monat,
    eur: u.stand === 'bestimmt' && n.stand === 'bestimmt' && summe != null ? summe : null,
    mengeKwh: u.mengeKwh,
  };
}

/** Händler-Modus (W5 = A): Förderweg „ungeförderte Direktvermarktung“ — dort ist der Netzlade-Anteil „geschätzt“. */
export function haendlerModus(m: Pick<MispelMonat, 'foerderweg'> | null): boolean {
  return m?.foerderweg === 'ungefoerdert';
}
