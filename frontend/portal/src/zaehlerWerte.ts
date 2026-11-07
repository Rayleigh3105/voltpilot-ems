/**
 * Die Zählerwerte EINES Geräts für seine Geräteseite (Unterverteilungen, Konzept
 * `vp-unterzaehler-anzeige`, Entscheid UV-3 A vom 07.11.2026): die Leistung je Phase und
 * die beiden Zählerstände eines Shelly Pro 3EM - als Unterzähler wie als Netz-Zähler, für
 * Kunde und Admin gleich.
 *
 * Die Werte sind die letzten der Topologie (`GET …/topology`, je Kanal `value`); Kanäle
 * ohne Rolle (Zählerstand, Phase) stehen dort genauso wie `power_kw`. Zwei Ehrlichkeitsregeln:
 *
 *  - **Fehlend ist keine Null.** Ein Kanal ohne Wert zeigt „—“; ein Gerät ohne einen
 *    einzigen Zählerkanal bekommt gar keine Karte.
 *  - **Veraltet ist nicht aktuell.** Meldet sich das Gerät nicht (Gesundheit nicht `ok`),
 *    steht statt Zahlen der Satz, warum - eine alte Phase als Momentwert wäre eine Lüge.
 *
 * Rein + rahmenfrei (getestet in `zaehlerWerte.test.ts`).
 */
import type { TopologyEntity } from './api';
import { channelLabelFor } from './channels';
import { fmtNum } from './format';

/** Die Zählerkanäle in ihrer Lesereihenfolge (Box: `sources.MeterDetailChannels`). */
export const ZAEHLER_KANAELE = ['power_l1_kw', 'power_l2_kw', 'power_l3_kw', 'energy_kwh', 'energy_export_kwh'] as const;

export interface ZaehlerZeile {
  kanal: string;
  label: string;
  /** Der Text: „3,9 kW“, „70.802 kWh“ oder „—“. */
  wert: string;
}

export interface ZaehlerWerte {
  entityId: string;
  zeilen: ZaehlerZeile[];
  /** `null` = die Zahlen gelten; sonst der Satz statt der Zahlen. */
  stumm: string | null;
}

const ZAEHLER_SET = new Set<string>(ZAEHLER_KANAELE);

/**
 * Die Zählerwerte der ERSTEN Komponente dieses Geräts, die Zählerkanäle nennt - ein
 * Shelly-Zähler ist genau eine Komponente. `null`, wenn keine es tut.
 */
export function zaehlerWerte(
  entityIds: readonly string[],
  topologie: readonly TopologyEntity[] | null | undefined,
): ZaehlerWerte | null {
  if (!topologie) return null;
  for (const id of entityIds) {
    const e = topologie.find((t) => t.id === id);
    if (!e) continue;
    const caps = e.capabilities.filter((c) => ZAEHLER_SET.has(c.channel));
    if (caps.length === 0) continue;
    const byChannel = new Map(caps.map((c) => [c.channel, c] as const));
    const zeilen: ZaehlerZeile[] = [];
    for (const kanal of ZAEHLER_KANAELE) {
      const c = byChannel.get(kanal);
      if (!c) continue;
      zeilen.push({ kanal, label: channelLabelFor(kanal, e.entityType), wert: format(kanal, c.value) });
    }
    const stumm = e.health === 'ok'
      ? null
      : e.health === 'stale'
        ? 'Der Zähler meldet sich gerade nicht - die letzten Werte stehen im Verlauf unter „Messwerte“.'
        : 'Noch keine Zählerwerte - sie kommen mit der ersten Lesung der Box.';
    return { entityId: e.id, zeilen, stumm };
  }
  return null;
}

/** Phasen wie jede Leistung mit einer Stelle, Zählerstände als ganze kWh (UEMS-Zahlenformat). */
function format(kanal: string, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const zaehlerstand = kanal.endsWith('_kwh');
  const stellen = zaehlerstand ? 0 : 1;
  // Ein Rauschen unter der letzten Stelle ist 0, kein „-0,0“; ein echtes Minus ist „−“.
  const gerundet = Math.round(v * 10 ** stellen) / 10 ** stellen;
  return fmtNum(gerundet === 0 ? 0 : gerundet, zaehlerstand ? 'kWh' : 'kW', stellen).replace(/^-/, '−');
}
