/**
 * Die REZEPT-GALERIE (Einheitsmodell Stufe 5a, Konzept `vp-komponenten-einheit-h2`
 * Teil 5b.4): die erste der drei Türen hinter „＋ Neue Regel".
 *
 * Die Drei-Türen-Mechanik bleibt (Rezept → geführter Baukasten → freier
 * Editor); NEU ist nur die erste Tür. Die vier heutigen Verbraucher-Absichten
 * werden Rezepte und erzeugen ihre Regel über die BESTEHENDEN Wege — es
 * entsteht keine zweite Maschine:
 *
 *  - Rezepte 1–4 füllen den Verbraucher-Regelbaukasten vor
 *    (`consumers/questions.ts` → `consumers/policy.ts`).
 *  - Rezept 5 („Speicher schützen") ist eine Vorbefüllung des Wenn/Dann-
 *    Baukastens (`flows/guidedBuilder.ts` `buildGuidedFlow`).
 *  - Rezept 6 („Sag mir Bescheid") wird GEZEIGT und ehrlich als „bald
 *    verfügbar" markiert — mit dem echten Grund (der Zustellweg fehlt),
 *    nicht versteckt (Captain-Entscheid 11.08.2026).
 *
 * Unpassende Rezepte werden AUSGEBLENDET, nie ausgegraut — hinter einer
 * gezählten Zeile, und jede eingeblendete Karte nennt, was fehlt. Dafür wird
 * das bestehende `flows/templateFilter.ts`-Muster WIEDERVERWENDET.
 *
 * PURE + unit-getestet (`rezepte.test.ts`).
 */
import type { SiteTopology } from '../api';
import type { ConsumerDraft } from '../consumers/questions';
import { CONSUMER_TEMPLATE_PREFILL } from '../consumers/vorlagen';
import type { GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import type { TemplateRole } from '../flows/customerTemplates';
import { hiddenDisclosure, missingReason, partition, plantRoles } from '../flows/templateFilter';

export type RezeptId =
  | 'pv-surplus-consumer'
  | 'schedule-consumer'
  | 'price-consumer'
  | 'deadline-consumer'
  | 'storage-protect'
  | 'notify';

/** Womit ein Rezept seine Regel baut — die Tür dahinter, für den Kunden unsichtbar. */
export type RezeptMaschine = 'verbraucher' | 'baukasten' | 'bald';

export interface RezeptDef {
  id: RezeptId;
  titel: string;
  /** Der Ergebnis-Satz in Kundendeutsch (K4-Klartext). */
  ergebnis: string;
  /** Die ruhige Fußzeile der Karte („3–5 Fragen · reagiert sofort"). */
  fussnote: string;
  maschine: RezeptMaschine;
  /** Was die Anlage dafür braucht (der `templateFilter`-Vorfilter). */
  requiresRoles: TemplateRole[];
  /**
   * Der EHRLICHE Grund, warum ein Rezept noch nicht nutzbar ist — nur bei
   * `maschine: 'bald'` gesetzt, und nie eine Floskel.
   */
  baldGrund?: string;
}

/**
 * Die Vorbefüllung der VERBRAUCHER-Rezepte. Die zwei Absichten, die schon als
 * Galerie-Vorlage existierten, kommen WÖRTLICH aus `consumers/vorlagen.ts`
 * (dort per Lockstep-Test an die Flow-Vorlagen gebunden); die zwei neuen wohnen
 * hier, wo die Galerie sie braucht.
 */
export const REZEPT_PREFILL: Partial<Record<RezeptId, Partial<ConsumerDraft>>> = {
  'pv-surplus-consumer': CONSUMER_TEMPLATE_PREFILL['pv-surplus-consumer'],
  'schedule-consumer': CONSUMER_TEMPLATE_PREFILL['schedule-consumer'],
  // Die Preisfenster rechnet die Cloud vor (der Verbraucher-Knoten bekommt
  // fertige UTC-Fenster) — das Rezept hängt deshalb NICHT am Preis-Kanal auf
  // dem Gerät, der dem freien Editor noch fehlt.
  'price-consumer': {
    intent: 'cheap',
    conditions: [{ signal: 'market.import_price_ct_kwh', operator: 'lt', value: 20 }],
    target: { kind: 'on_off', value: true },
    gridEnergyPolicy: 'allow',
  },
  'deadline-consumer': {
    intent: 'deadline',
    recurrence: { days: 'daily', from: '22:00', to: '06:00' },
    demandMode: 'runtime',
    runtimeMinutes: 120,
    contiguous: false,
    target: { kind: 'on_off', value: true },
    gridEnergyPolicy: 'allow',
  },
};

export const REZEPTE: RezeptDef[] = [
  {
    id: 'pv-surplus-consumer',
    titel: 'PV-Überschuss nutzen',
    ergebnis: 'Ein Gerät läuft, wenn mehr Solarstrom da ist, als das Haus gerade braucht.',
    fussnote: '3–5 Fragen · reagiert sofort',
    maschine: 'verbraucher',
    requiresRoles: ['consumer'],
  },
  {
    id: 'schedule-consumer',
    titel: 'Feste Zeiten',
    ergebnis: 'Läuft täglich im gewählten Zeitfenster — z. B. die Poolpumpe von 11 bis 15 Uhr.',
    fussnote: '2–4 Fragen · mit Erfüllungs-Nachweis',
    maschine: 'verbraucher',
    requiresRoles: ['consumer'],
  },
  {
    id: 'price-consumer',
    titel: 'Günstige Stunden nutzen',
    ergebnis:
      'Läuft in den günstigsten Börsenstunden — die Fenster rechnet VoltPilot täglich aus.',
    fussnote: '3–5 Fragen · Preisfenster kommen von VoltPilot',
    maschine: 'verbraucher',
    requiresRoles: ['consumer'],
  },
  {
    id: 'deadline-consumer',
    titel: 'Bis zu einer Frist erledigen',
    ergebnis:
      'Bis zur Frist ist die Aufgabe erledigt — den Zeitpunkt wählt VoltPilot, '
      + 'notfalls startet Ihr Gerät selbst.',
    fussnote: '4–6 Fragen · Nachweis + Frist-Absicherung',
    maschine: 'verbraucher',
    requiresRoles: ['consumer'],
  },
  {
    id: 'storage-protect',
    titel: 'Speicher schützen',
    ergebnis: 'Ein Gerät läuft nur, solange der Ladestand über einem Wert liegt.',
    fussnote: '3 Fragen · Wenn/Dann-Regel',
    maschine: 'baukasten',
    requiresRoles: ['consumer', 'storage'],
  },
  {
    id: 'notify',
    titel: 'Sag mir Bescheid',
    ergebnis: 'Wenn etwas Wichtiges passiert, bekommen Sie eine Nachricht.',
    fussnote: 'Wenn/Dann-Regel mit Benachrichtigung',
    maschine: 'bald',
    requiresRoles: [],
    baldGrund:
      'Der Zustellweg fehlt noch (Postfach oder E-Mail) — die Karte schaltet frei, '
      + 'sobald Nachrichten wirklich ankommen.',
  },
];

/** Ein Rezept nachschlagen (null bei einer unbekannten Id — nie geraten). */
export function rezept(id: string): RezeptDef | null {
  return REZEPTE.find((r) => r.id === id) ?? null;
}

/** Die Vorbefüllung des Verbraucher-Baukastens, oder null. */
export function rezeptPrefill(id: string): Partial<ConsumerDraft> | null {
  return REZEPT_PREFILL[id as RezeptId] ?? null;
}

/** Ob ein Rezept über den VERBRAUCHER-Baukasten läuft. */
export function istVerbraucherRezept(id: string): boolean {
  return rezept(id)?.maschine === 'verbraucher';
}

// ---------------------------------------------------------------------------
// Die Galerie
// ---------------------------------------------------------------------------

export interface RezeptKarte {
  id: RezeptId;
  titel: string;
  ergebnis: string;
  fussnote: string;
  /** Anklickbar? Ein „bald"-Rezept und ein unpassendes sind es nicht. */
  waehlbar: boolean;
  /** „bald verfügbar" — mit dem echten Grund in `grund`. */
  bald: boolean;
  /** Der ehrliche Grund (fehlende Rolle bzw. der Zustellweg), sonst null. */
  grund: string | null;
}

export interface RezeptGalerie {
  /** Was diese Anlage jetzt bauen kann. */
  passend: RezeptKarte[];
  /** Gezeigt, aber ehrlich vertagt (der Zustellweg fehlt). */
  bald: RezeptKarte[];
  /** Ausgeblendet hinter der gezählten Zeile — jede Karte nennt, was fehlt. */
  ausgeblendet: RezeptKarte[];
  /** Die gezählte Aufklapp-Zeile, oder null wenn nichts ausgeblendet ist. */
  aufklappZeile: string | null;
  /**
   * Die Sackgassen-Rettung: keine einzige schaltbare Komponente. Dann bietet
   * die Galerie „Komponente anlegen" an, statt eine leere Liste zu zeigen.
   */
  brauchtKomponente: boolean;
}

export interface RezeptKontext {
  entities: EditorEntity[];
  topology?: SiteTopology | null;
}

function karte(def: RezeptDef, grund: string | null): RezeptKarte {
  return {
    id: def.id,
    titel: def.titel,
    ergebnis: def.ergebnis,
    fussnote: def.fussnote,
    waehlbar: def.maschine !== 'bald' && grund == null,
    bald: def.maschine === 'bald',
    grund,
  };
}

/**
 * Die Galerie für DIESE Anlage. Ein Rezept, dessen Voraussetzung fehlt, wird
 * ausgeblendet (nie ausgegraut) und nennt beim Aufklappen den Grund; „Sag mir
 * Bescheid" steht immer sichtbar mit seinem echten Grund.
 */
export function rezeptGalerie(ctx: RezeptKontext): RezeptGalerie {
  const have = plantRoles({ entities: ctx.entities ?? [], topology: ctx.topology ?? null });
  const nutzbar = REZEPTE.filter((r) => r.maschine !== 'bald');
  const teil = partition(nutzbar, { entities: ctx.entities ?? [], topology: ctx.topology ?? null });
  const bald = REZEPTE.filter((r) => r.maschine === 'bald').map(
    (r) => karte(r, r.baldGrund ?? null),
  );
  return {
    passend: teil.fitting.map((r) => karte(r, null)),
    bald,
    ausgeblendet: teil.notFitting.map((n) => karte(n.template, n.reason)),
    aufklappZeile: hiddenDisclosure(teil, {
      eins: '1 weiteres Rezept passt nicht zu Ihrer Anlage',
      viele: (n) => `${n} weitere Rezepte passen nicht zu Ihrer Anlage`,
    }),
    brauchtKomponente: !have.has('consumer'),
  };
}

/** Der ehrliche Grund eines einzelnen Rezepts (null = es passt). */
export function rezeptGrund(def: RezeptDef, ctx: RezeptKontext): string | null {
  if (def.maschine === 'bald') return def.baldGrund ?? null;
  return missingReason(def, { entities: ctx.entities ?? [], topology: ctx.topology ?? null });
}

/** Die Einleitung über der Galerie (auch der leere Zustand der Kapsel). */
export const GALERIE_FRAGE = 'Was soll Ihre Anlage für Sie erledigen?';

export const GALERIE_INTRO =
  'Wählen Sie ein Rezept — die Fragen passen sich an. Danach wird die Regel geprüft '
  + 'und simuliert, bevor sie läuft.';

export const KOMPONENTE_ANLEGEN =
  'Noch kein schaltbares Gerät? Legen Sie zuerst eine Komponente an — Ihr Regel-Entwurf '
  + 'bleibt dabei erhalten.';

// ---------------------------------------------------------------------------
// „Speicher schützen" — die Vorbefüllung des Wenn/Dann-Baukastens
// ---------------------------------------------------------------------------

/** Die Komponente, die den Ladestand misst (null = die Anlage hat keinen Speicher). */
export function speicherEntity(entities: EditorEntity[]): EditorEntity | null {
  return (entities ?? []).find((e) => (e.measure ?? []).includes('soc_pct')) ?? null;
}

/** Die schaltbaren Komponenten (dieselbe Bedingung wie der Vorfilter). */
export function schaltbareKomponenten(entities: EditorEntity[]): EditorEntity[] {
  return (entities ?? []).filter(
    (e) => e.entityType !== 'battery-hybrid' && (e.actuate ?? []).includes('on_off'),
  );
}

/**
 * Die vorbefüllte Wenn/Dann-Regel des Rezepts „Speicher schützen": das Gerät
 * läuft nur, solange der Ladestand über 25 % liegt (mit Hysterese, damit ein
 * schwankender Ladestand das Gerät nicht flattern lässt). Null, wenn die Anlage
 * die Zutaten nicht hat — dann wird nichts erfunden.
 */
export function speicherSchutzRegel(entities: EditorEntity[]): GuidedRule | null {
  const speicher = speicherEntity(entities);
  const geraet = schaltbareKomponenten(entities)[0];
  if (!speicher || !geraet) return null;
  return {
    conditions: [
      {
        kind: 'entity',
        entityId: speicher.id,
        channel: 'soc_pct',
        direction: 'above',
        threshold: 25,
        hysteresis: 5,
      },
    ],
    combinator: 'and',
    action: { kind: 'onoff', entityId: geraet.id, ttlS: 300 },
  };
}
