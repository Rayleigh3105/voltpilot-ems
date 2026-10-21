/**
 * „+ Überwachung“ unter Meldungen › Überwachungen (Konzept b1, 20.10.2026, Entscheid E3): der EINE
 * Ort, an dem eine Überwachung entsteht. Erst der Ort (Anlage, Messstelle, Kennzahl, Energieziel),
 * dann der Wert, dann das vorhandene Blatt „Überwachen“ (`UeberwachenBlatt`). Dieses Modul ist rein:
 * es baut die Auswahl-Zeilen, die Fläche rendert sie (`NeueUeberwachung.tsx`).
 *
 * Woher die Werte kommen:
 * - Anlage: `GET /api/v1/werte?bezug=anlage:<id>` - die Live-Werte (Leserart `anlagenfluss`) mit
 *   letztem Wert und je Komponenten-Kanal ein `geraet.messwert` (die Geräte der Anlage stehen also
 *   dort, kein eigener Ort „Gerät“).
 * - Messstelle, Kennzahl, Energieziel: die Einträge des Werte-Katalogs mit diesem Bezug (der Zwilling
 *   `werteKatalog.ts`); ihr Wert ist periodisch oder ein Zustand, einen Live-Wert gibt es nicht.
 * - Erzeugeranlage (UEMS EZ-11): dieselbe Route liefert an einer Anlage mit Anlagensteuerung die fünf
 *   Alarm-Vorlagen (`erzeuger.*`) mit ihrem Zustand - eine eigene Gruppe vor den Geräte-Kanälen.
 */
import { channelLabel } from './channels';
import type { UeberwachenBezug } from './components/UeberwachenBlatt';
import { fmtNum } from './format';
import { UEMS_ENERGIEZIELE, UEMS_KENNZAHLEN, UEMS_MESSSTELLE } from './glossar';
import type { VpGruppe, VpOption } from './picker/optionen';
import type { Wertverweis } from './ueberwachungApi';
import { zustandswortAnzeige } from './ueberwachungSatz';
import { WERTE_KATALOG } from './werteKatalog';

export type OrtArt = 'anlage' | 'messstelle' | 'kennzahl' | 'energieziel';

/** Ein Ort, an dem etwas überwacht werden kann. */
export interface UeberwachungOrt {
  art: OrtArt;
  id: string;
  name: string;
  /** Die Nebenzeile im Auswahlfeld (Kennzeichen), wenn es eine gibt. */
  sub?: string | null;
}

/** Eine wählbare Zeile „Welcher Wert?“ - alles, was das Blatt „Überwachen“ braucht. */
export interface WertWahl {
  schluessel: string;
  wertart: string;
  bezug: UeberwachenBezug;
  /** Die Zeile, wie sie der Kunde liest. */
  name: string;
  /** Der letzte Wert als Text (nur Anlage), sonst `null`. */
  wertText: string | null;
  gruppe: WertGruppe;
  aktuellerWert: number | null;
  einheit?: string;
  /** Der Zusatz im Titel des Blatts („Überwachen: …“). */
  titelZusatz: string;
}

export type WertGruppe = 'live' | 'erzeuger' | 'geraet' | 'ort';

/** Die Reihenfolge der Gruppen unter „Welcher Wert?“. */
export const WERT_GRUPPEN: readonly WertGruppe[] = ['live', 'erzeuger', 'geraet', 'ort'];

/** Die Gruppen des Ortsfelds, in dieser Reihenfolge. */
export const ORT_GRUPPEN: VpGruppe[] = [
  { key: 'anlage', label: 'Anlagen' },
  { key: 'messstelle', label: `${UEMS_MESSSTELLE}n` },
  { key: 'kennzahl', label: UEMS_KENNZAHLEN },
  { key: 'energieziel', label: UEMS_ENERGIEZIELE },
];

/** Die Überschriften über den Wert-Zeilen. */
export const WERT_GRUPPE_TITEL: Record<WertGruppe, string> = {
  live: 'Live-Werte der Anlage',
  erzeuger: 'Alarme der Erzeugeranlage',
  geraet: 'Messwerte der Geräte',
  ort: 'Werte',
};

export function ortWert(ort: Pick<UeberwachungOrt, 'art' | 'id'>): string {
  return `${ort.art}:${ort.id}`;
}

/** Das Ortsfeld: nach Art gruppiert, innerhalb der Art nach Namen. */
export function ortOptionen(orte: readonly UeberwachungOrt[]): VpOption[] {
  const reihe = new Map(ORT_GRUPPEN.map((g, i) => [g.key, i]));
  return [...orte]
    .sort((a, b) => (reihe.get(a.art)! - reihe.get(b.art)!) || a.name.localeCompare(b.name, 'de'))
    .map((o) => ({ value: ortWert(o), label: o.name, sub: o.sub ?? null, group: o.art }));
}

/** Der letzte Wert eines Wertverweises in Worten - fehlend ist kein Wert (nie eine erfundene 0). */
export function wertText(w: Pick<Wertverweis, 'bekannt' | 'zahlenwert' | 'zustandswort' | 'einheit'>): string | null {
  if (w.zustandswort) return w.zustandswort;
  if (w.bekannt === false || w.zahlenwert == null) return null;
  return fmtNum(w.zahlenwert, w.einheit ?? '', w.einheit === '%' ? 0 : 1);
}

function bezugAus(json: string): UeberwachenBezug | null {
  try {
    const b = JSON.parse(json) as Record<string, unknown>;
    if (typeof b.anlage === 'string') return { anlage: b.anlage };
    if (typeof b.komponente === 'string' && typeof b.kanal === 'string') return { komponente: b.komponente, kanal: b.kanal };
    return null;
  } catch {
    return null;
  }
}

/**
 * Der Name eines Geräte-Kanals: der Server liefert „<Gerät> · <roher Kanal>“, die Fläche zeigt den
 * Kanal in Kundenworten (dieselbe Beschriftung wie auf der Geräteseite).
 */
function geraeteName(name: string, bezug: { kanal: string }): string {
  const i = name.lastIndexOf(' · ');
  const geraet = i >= 0 ? name.slice(0, i) : name;
  return `${geraet} · ${channelLabel(bezug.kanal)}`;
}

/** Die Werte einer Anlage aus `GET /api/v1/werte` - Live-Werte, Erzeuger-Alarme, dann die Geräte-Kanäle. */
export function anlageWerte(werte: readonly Wertverweis[]): WertWahl[] {
  const out: WertWahl[] = [];
  for (const w of werte) {
    const bezug = bezugAus(w.bezugJson);
    if (!bezug) continue;
    const geraet = 'komponente' in bezug;
    const erzeuger = w.wertart.startsWith('erzeuger.');
    const name = geraet ? geraeteName(w.name, bezug) : w.name;
    out.push({
      schluessel: `${w.wertart}:${w.bezugJson}`,
      wertart: w.wertart,
      bezug,
      name,
      // Ein Erzeuger-Zustand in Kundenworten („folgt nicht“), nie das Maschinenwort.
      wertText: erzeuger ? (w.zustandswort ? zustandswortAnzeige(w.zustandswort) : null) : wertText(w),
      gruppe: geraet ? 'geraet' : erzeuger ? 'erzeuger' : 'live',
      aktuellerWert: w.bekannt === false ? null : w.zahlenwert,
      einheit: w.einheit ?? undefined,
      titelZusatz: name,
    });
  }
  return WERT_GRUPPEN.flatMap((g) => out.filter((w) => w.gruppe === g));
}

/** Die Werte einer Messstelle, Kennzahl oder eines Energieziels aus dem Werte-Katalog. */
export function katalogWerte(ort: UeberwachungOrt): WertWahl[] {
  if (ort.art === 'anlage') return [];
  const bezug = { [ort.art]: ort.id } as UeberwachenBezug;
  return WERTE_KATALOG.filter((e) => e.bezug === ort.art).map((e) => ({
    schluessel: `${e.wertart}:${ort.id}`,
    wertart: e.wertart,
    bezug,
    name: e.name,
    wertText: null,
    gruppe: 'ort' as const,
    aktuellerWert: null,
    titelZusatz: `${e.name} · ${ort.name}`,
  }));
}
