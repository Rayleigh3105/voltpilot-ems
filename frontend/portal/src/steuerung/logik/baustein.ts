/**
 * Ableitungen für Bausteine (Steuerlogik Stufe 5): der Satz als Zeile, die Regler der Lücken und der Tag aus den
 * Proben („So verhält sie sich“). Rein. Was ein Wert bedeutet, ob er passt und was die Logik daraus macht, rechnet
 * nur der Logik-Dienst; hier wird nur gestellt und gezeigt.
 */
import type { BausteinKopf, BausteinLuecke, BausteinMoment, BausteinSatzTeil } from '../../api';
import type { IcName } from '../Ic';

const NBSP = ' ';

/** Die Werte der Lücken in der Form des Dokuments (`"45 °C"`, `"06:00"`, Kennung eines Geräts). */
export function startWerte(luecken: BausteinLuecke[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const l of luecken) if (l.wert !== undefined && l.wert !== null) out[l.kennung] = l.wert;
  return out;
}

/** Eine Zahl mit Einheit in der Form des Dokuments lesen: `"45 °C"` → 45, `"1.5 kW"` → 1,5. */
export function zahlVon(w: unknown): number | null {
  if (typeof w === 'number') return w;
  if (typeof w !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(w);
  return m ? Number(m[1]) : null;
}

function rund(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Ein Schritt am Regler einer Zahl: auf dem Raster ab dem unteren Ende des Bereichs, nie darüber hinaus; `null` am
 * Rand. Heraus kommt die Form des Dokuments mit Punkt (`"1.5 kW"`).
 */
export function zahlSchritt(l: BausteinLuecke, wert: unknown, richtung: 1 | -1): string | null {
  const s = l.stellwert;
  if (!s || s.art !== 'zahl') return null;
  const jetzt = zahlVon(wert) ?? zahlVon(s.vorgabe) ?? 0;
  const schritt = s.schritt && s.schritt > 0 ? s.schritt : 1;
  const basis = s.von ?? 0;
  let neu = rund(basis + Math.round((jetzt - basis) / schritt + richtung) * schritt);
  if (s.von != null && neu < s.von) neu = s.von;
  if (s.bis != null && neu > s.bis) neu = s.bis;
  if (rund(neu) === rund(jetzt)) return null;
  return `${neu}${s.einheit ? ` ${s.einheit}` : ''}`;
}

/** Ein Schritt an einer Uhrzeit: eine halbe Stunde, über Mitternacht. */
export function uhrSchritt(wert: unknown, richtung: 1 | -1, minuten = 30): string {
  const m = typeof wert === 'string' ? /^(\d{2}):(\d{2})$/.exec(wert) : null;
  const jetzt = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  const neu = (((Math.round(jetzt / minuten) + richtung) * minuten) % 1440 + 1440) % 1440;
  return `${String(Math.floor(neu / 60)).padStart(2, '0')}:${String(neu % 60).padStart(2, '0')}`;
}

/**
 * Ein Wert für Menschen, wie der Dienst ihn schreibt: Komma, geschütztes Leerzeichen vor der Einheit, Leistungen
 * unter 10 kW mit einer Stelle; `an`/`aus`; der Name einer Auswahl; beim Gerät sein Name.
 */
export function wertText(l: BausteinLuecke, wert: unknown): string {
  if (l.art !== 'stellwert') {
    return l.kandidaten?.find((k) => k.entity_id === wert)?.name ?? l.wert_text ?? 'wählen';
  }
  const s = l.stellwert;
  if (wert === l.wert && l.wert_text) return l.wert_text;
  if (!s) return String(wert ?? '');
  if (s.art === 'boolean') return wert === 'on' || wert === true ? 'an' : 'aus';
  if (s.art === 'select') return s.optionen?.find((o) => o.wert === wert)?.name ?? String(wert ?? '');
  if (s.art === 'uhrzeit') return String(wert ?? '');
  const n = zahlVon(wert);
  if (n == null) return String(wert ?? '');
  const stellen = s.einheit === 'kW' && Math.abs(n) < 10 ? 1 : Number.isInteger(n) ? 0 : 1;
  const text = n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: 2 }).replace('-', '−');
  return s.einheit ? `${text}${NBSP}${s.einheit}` : text;
}

/** Der Satz in einer Zeile, jede Lücke mit ihrem Wert (die Karte in der Liste). */
export function satzZeile(satz: BausteinSatzTeil[], luecken: BausteinLuecke[], werte?: Record<string, unknown>): string {
  return satz.map((t) => {
    if (t.luecke == null) return t.text ?? '';
    const l = luecken.find((x) => x.kennung === t.luecke);
    return l ? wertText(l, werte ? werte[l.kennung] : l.wert) : '…';
  }).join('');
}

/** Die Lücken, die der Satz nicht nennt: Geräte und Fühler darunter, je mit dem Wort der Logik. */
export function unterDemSatz(luecken: BausteinLuecke[]): BausteinLuecke[] {
  return luecken.filter((l) => !l.im_satz && l.art !== 'stellwert');
}

/** Welche Bausteine die Liste zeigt: lesbar und passend zur Anlage; die eigenen auch sonst (zum Entfernen). */
export function zeigbar(liste: BausteinKopf[]): BausteinKopf[] {
  return liste.filter((b) => (b.lesbar && b.passt) || b.eigen);
}

/** Das Symbol eines Bausteins nach dem, was er seinem ersten Gerät stellt. */
export function symbol(b: { luecken: BausteinLuecke[] }): IcName {
  const g = b.luecken.find((l) => l.art === 'geraet');
  const a = g?.ausgaenge ?? [];
  if (a.includes('setpoint')) return a.includes('mode') ? 'fan' : 'snowflake';
  if (a.includes('mode')) return 'heatpump';
  if (a.includes('level')) return 'flame';
  return 'plug';
}

/** Ein Moment des Tages für „So verhält sie sich“. */
export interface Moment {
  uhr: string;
  titel: string;
  /** solar, grid, waiting, idle, fault: Farbe des Punkts. */
  art: string;
  satz: string;
  fall: string;
  besteht: boolean;
}

/** Die Proben als Tag: nach der Uhrzeit (der Dienst ordnet schon), ohne Lage der Name als Titel. */
export function tag(verhalten: BausteinMoment[]): Moment[] {
  return verhalten.map((p) => ({
    uhr: p.uhr,
    titel: p.lage?.titel ?? p.name,
    art: p.lage?.art ?? 'idle',
    satz: p.lage?.satz ?? '',
    fall: p.name,
    besteht: p.besteht,
  }));
}

/** Die Klasse der Pille zu einer Art der Lage. */
export function artKlasse(art: string): 'on' | 'done' | 'wait' | 'off' | 'lock' | 'hand' {
  switch (art) {
    case 'solar':
      return 'on';
    case 'grid':
      return 'hand';
    case 'waiting':
      return 'wait';
    case 'fault':
      return 'lock';
    default:
      return 'off';
  }
}

/**
 * Ein Vorschlag für den Satz, wenn ein Fachbetrieb eine Logik als Baustein speichert: die Beschreibung der Logik und
 * dahinter ihre Geräte als Lücken. Der Fachbetrieb schreibt ihn um; `{name}` bleibt eine Lücke.
 */
export function satzVorschlag(beschreibung: string | null | undefined, geraete: string[]): string {
  const vorne = (beschreibung ?? '').trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  const hinten = geraete.map((g) => `{${g}}`).join(', ');
  if (!vorne) return geraete.length ? `Steuert ${hinten}.` : '';
  return geraete.length ? `${vorne}: ${hinten}.` : `${vorne}.`;
}
