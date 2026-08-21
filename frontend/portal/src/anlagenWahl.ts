/**
 * Die ANLAGEN-AUSWAHL der Kopfzeile als Picker-Zeilen - der Vorzeige-Picker
 * (Konzept `vp-picker-system`, Captain-Entscheid 4: „durchsuchbar, je Anlage
 * Gesundheits-Punkt + Ort in der Liste").
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 *
 * <b>⚠ DIE DATENLAGE, ehrlich benannt.</b> Der Anlagen-Endpunkt trägt KEINE
 * Adresse und keinen Ortsnamen: eine Anlage kennt `latitude`/`longitude` und
 * ihre `biddingZone`, mehr nicht (der Ortsname der Anlege-Suche wird nie
 * gespeichert - `AnlageFlow` schickt nur die Koordinaten). Also:
 *
 * - Der ORT ist das LAND aus der Gebotszone („Deutschland"), und er steht nur
 *   da, wo er etwas UNTERSCHEIDET - in einer Flotte, die ganz in einem Land
 *   liegt, stünde sonst auf jeder Zeile dasselbe Wort. Das ist kein
 *   Informationsgewinn, sondern Rauschen vor der Aussage, die zählt.
 * - Koordinaten werden NICHT gerendert: „48,8790° N · 10,7714° O" ist keine
 *   Ortsangabe, die ein Kunde über seine Anlage liest. Sie sind aber
 *   DURCHSUCHBAR (unsichtbare Stichwörter), damit ein Betreiber, der nach
 *   ihnen sucht, trotzdem fündig wird.
 * - Ein Ortsname würde ERFUNDEN - das tut diese Datei nicht.
 *
 * <b>Der Gesundheits-Punkt ist DIESELBE Ableitung wie die Kopfzeile</b>
 * (`liveness.deviceHealthForSite` → `health.healthBadge`), nur je Anlage statt
 * nur für die geöffnete. Eine zweite Gesundheits-Rechnung liesse Kopfzeile und
 * Liste über dieselbe Anlage Verschiedenes behaupten.
 */
import type { Site } from './api';
import { zoneLabel } from './format';
import { healthBadge, type HealthBadgeState } from './health';
import { deviceHealthForSite, type DevicesSnapshot } from './liveness';
import type { VpOption, VpPunkt } from './picker/optionen';

/** Der Wert, der „Alle Anlagen" (die Flotten-Ebene) meint. */
export const ALLE_ANLAGEN = '__all__';

/** Der Zustands-Punkt zum Gesundheits-Urteil. */
export function punktFuer(state: HealthBadgeState | null): VpPunkt | null {
  if (state === 'ok') return 'ok';
  if (state === 'warnung') return 'warn';
  if (state === 'hinweis') return 'off';
  return null;
}

/**
 * Die NEBENZEILE einer Anlage: der Gesundheits-Satz, und der Ort nur dort, wo
 * er unterscheidet.
 *
 * ⚠ Sie behauptet nichts, was nicht gemessen wurde: ohne Gesundheits-Urteil
 * (Geräteliste noch nie geladen) steht dort nur der Ort, und ohne beides gar
 * nichts - nie ein erfundenes „Alles in Ordnung".
 */
export function nebenzeile(
  gesundheit: string | null,
  ort: string | null,
): string | null {
  const teile = [gesundheit, ort].filter((t): t is string => !!t && t.trim() !== '');
  return teile.length > 0 ? teile.join(' · ') : null;
}

export interface AnlagenWahlEingabe {
  sites: Site[];
  /** Die Geräteliste samt ihrer Bezugszeit - beide immer gemeinsam. */
  devices: DevicesSnapshot;
  /** Gibt es eine Flotten-Ebene, auf die „Alle Anlagen" zurückführt? */
  mitFlotte: boolean;
  now?: number;
}

/**
 * Die Zeilen des Anlagen-Pickers.
 *
 * „Alle Anlagen" steht bewusst GANZ OBEN und ohne Punkt: es ist kein Zustand,
 * sondern ein Ortswechsel - ein Punkt daneben behauptete eine Gesundheit über
 * eine Flotte, die diese Zeile gar nicht misst.
 */
export function anlagenOptionen({
  sites,
  devices,
  mitFlotte,
  now = Date.now(),
}: AnlagenWahlEingabe): VpOption[] {
  // Der Ort steht nur da, wo er unterscheidet - siehe Kopf dieser Datei.
  const zonen = new Set(sites.map((s) => s.biddingZone).filter(Boolean));
  const ortZeigen = zonen.size > 1;

  const zeilen: VpOption[] = sites.map((s) => {
    const counts = deviceHealthForSite(devices, s.id, now);
    const badge = counts ? healthBadge({ devices: counts }) : null;
    const ort = ortZeigen ? zoneLabel(s.biddingZone) : null;
    return {
      value: s.id,
      label: s.name,
      sub: nebenzeile(badge?.label ?? null, ort || null),
      dot: punktFuer(badge?.state ?? null),
      // Durchsuchbar, aber nicht gerendert: Land und Koordinaten. Wer danach
      // sucht, findet - ohne dass jede Zeile damit zugestellt wird.
      keywords: [zoneLabel(s.biddingZone), s.latitude, s.longitude]
        .filter((v) => v != null && v !== '')
        .join(' '),
    };
  });

  if (mitFlotte) {
    zeilen.unshift({ value: ALLE_ANLAGEN, label: 'Alle Anlagen', sub: 'Zurück zur Übersicht' });
  }
  return zeilen;
}
