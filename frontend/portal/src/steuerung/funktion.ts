/**
 * Die Funktion „Steuern & Optimieren“ dieser Anlage, wie die Steuerung sie
 * zeigt (UEMS AP-01 IP-11, AP-14 #965/#986, Steuern-Regel #779) - rein.
 *
 * Quelle ist `/funktionen`, dieselbe Antwort wie Funktionen-Karte und
 * Assistent. Fehlt sie (älterer Server, Fehler), behauptet die Seite nichts
 * und bleibt, wie sie ohne Funktion ist: unbekannt ist kein Zustand.
 *
 * - **Ruhe** (R0): entwurf, eingerichtet und angehalten - wie
 *   `RuheHinweisRegel` im Server - und beendet, denn auch „beenden“ schreibt
 *   die Ruhe ohne Ende (`FunktionService`). Die Box ruht im Pause-Zustand;
 *   `/interventions` zeigt das bewusst NICHT. Eine Pause oder ein Eingriff
 *   endete mit 409 - die Seite sperrt sie vorher und sagt warum.
 * - **Ohne Teilnahme** (kein Objekt, beendet): kein Anstoß zum Steuern, also
 *   keine Vorschläge und kein „Gerät fehlt?“. Steuerart und Regeln bleiben
 *   erreichbar. Den Einstieg (Satz und Knopf) bekommt nur „kein Objekt“.
 */
import type { FunktionTeilnahme, Funktionen } from '../api';
import type { FunktionZustand } from '../uemsFunktion';
import { steuerungFunktionsAnzeige } from '../steuerungArea';

export interface FunktionsLage {
  /** `null` = `/funktionen` hat nicht geantwortet oder kennt die Anlage nicht. */
  zustand: FunktionZustand | null;
  standortId: string | null;
  /** Die Box ruht ohne Ende: Eingriffe und Pause sind gesperrt. */
  ruht: boolean;
  /** Die Anlage nimmt nicht an „Steuern & Optimieren“ teil. */
  ohneTeilnahme: boolean;
  /** Was die Plakette in Ruhe statt „Automatik an“ sagt. */
  plakette: string | null;
  /** Der Zustandssatz des Bandes („Angehalten seit …“, „Eingerichtet am … — …“). */
  satz: string | null;
  /** Was der Zustand für die Anlage heißt (zweiter Satz des Bandes). */
  folge: string | null;
  /** Die zuständige Box hält die Ruhe nur, solange sie verbunden ist (#986). */
  ruheHinweis: boolean;
  /** Satz und Knopf „Steuern & Optimieren einrichten“ (#965). */
  einstieg: boolean;
  /** Warum Eingriffe und Pause gesperrt sind; `null` = nicht gesperrt. */
  sperre: string | null;
}

export const OHNE_FUNKTION: FunktionsLage = {
  zustand: null,
  standortId: null,
  ruht: false,
  ohneTeilnahme: false,
  plakette: null,
  satz: null,
  folge: null,
  ruheHinweis: false,
  einstieg: false,
  sperre: null,
};

const RUHE: readonly FunktionZustand[] = ['entwurf', 'eingerichtet', 'angehalten', 'archiviert'];
const OHNE_TEILNAHME: readonly FunktionZustand[] = ['kein_objekt', 'archiviert'];

const SCHUTZ = 'Schutzgrenzen gelten weiter.';

export function funktionsLage(funktionen: Funktionen | null | undefined, siteId: string): FunktionsLage {
  for (const s of funktionen?.standorte ?? []) {
    const anlage = s.steuern.anlagen.find((a) => a.id === siteId);
    if (anlage) return lageAus(anlage.teilnahme, s.id, s.zeitzone);
  }
  return OHNE_FUNKTION;
}

function lageAus(t: FunktionTeilnahme, standortId: string, zeitzone: string): FunktionsLage {
  const z = t.zustand;
  const ruht = RUHE.includes(z);
  const lage: FunktionsLage = {
    ...OHNE_FUNKTION,
    zustand: z,
    standortId,
    ruht,
    ohneTeilnahme: OHNE_TEILNAHME.includes(z),
    ruheHinweis: ruht && t.ruhe_hinweis?.jetzt === true,
    einstieg: z === 'kein_objekt',
  };
  if (!ruht) return lage;
  const anzeige = steuerungFunktionsAnzeige(t, zeitzone);
  if (z === 'angehalten') {
    return {
      ...lage,
      plakette: t.seit ? `Angehalten seit ${tagMonat(t.seit, zeitzone)}` : 'Angehalten',
      satz: anzeige.kopf,
      folge: `VoltPilot sendet keine Sollwerte; Regeln und das Betriebsmodell des Speichers wirken nicht. ${SCHUTZ}`,
      sperre: 'Eingriffe und Pause gibt es wieder, sobald die Steuerung fortgesetzt ist.',
    };
  }
  if (z === 'archiviert') {
    return {
      ...lage,
      plakette: 'Steuerung beendet',
      satz: t.text,
      folge: `VoltPilot sendet keine Sollwerte mehr. ${SCHUTZ}`,
      sperre: 'Die Steuerung dieser Anlage ist beendet; Eingriffe und Pause gibt es hier nicht.',
    };
  }
  return {
    ...lage,
    plakette: 'Noch nicht gestartet',
    satz: z === 'eingerichtet' ? anzeige.kopf : 'Noch nicht eingerichtet — Steuerung noch nicht gestartet',
    folge: `VoltPilot sendet noch keine Sollwerte. ${SCHUTZ}`,
    sperre: 'Eingriffe und Pause gibt es, sobald die Steuerung gestartet ist.',
  };
}

function tagMonat(iso: string, zeitzone: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: zeitzone, day: '2-digit', month: '2-digit' }).format(new Date(iso));
}
