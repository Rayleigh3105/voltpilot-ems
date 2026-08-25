/**
 * Die REZEPTE — seit Steuerung Stufe 2 die VORBELEGUNGEN des Baukastens
 * (Konzept `vp-steuerung-konzept-b3` §3.3 + Stufenplan Stufe 2,
 * Captain-Entscheid „nur Builder").
 *
 * ⚠ Die KARTEN-GALERIE als erste Tür ist ERSATZLOS entfallen (`RezeptGalerie.tsx`
 * gelöscht, `rezeptGalerie`/`GALERIE_*` mit ihr). Was bleibt, ist der Bestand
 * an Absichten und die Maschine dahinter — sie füllen jetzt den Baukasten vor,
 * statt hinter dem Rücken des Kunden eine fertige Regel zu erzeugen:
 *
 *  - Rezepte 1–4 füllen den Verbraucher-Regelbaukasten vor
 *    (`consumers/questions.ts` → `consumers/policy.ts`) — der Wenn/Dann-
 *    Baukasten kann eine Frist-Aufgabe heute nicht ausdrücken, also öffnet die
 *    Absicht die Maschine, die es kann.
 *  - Rezept 5 („Speicher schützen") ist eine Vorbefüllung des Wenn/Dann-
 *    Baukastens (`speicherSchutzRegel`).
 *  - Rezept 6 („Sag mir Bescheid") wird NICHT angeboten — der Zustellweg fehlt;
 *    ein Startpunkt ist eine Einladung, und eine, die niemand annehmen kann,
 *    ist die Sackgasse, gegen die diese Stufe gebaut ist. Gezählt wird er
 *    trotzdem (`vorbelegungen().hinweis`).
 *
 * PURE + unit-getestet (`rezepte.test.ts`).
 */
import type { SiteTopology } from '../api';
import type { ConsumerDraft } from '../consumers/questions';
import { CONSUMER_TEMPLATE_PREFILL } from '../consumers/vorlagen';
import type { GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import type { TemplateRole } from '../flows/customerTemplates';
import { partition, plantRoles, sharedReason } from '../flows/templateFilter';

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
// Der Kontext einer Anlage
// ---------------------------------------------------------------------------

export interface RezeptKontext {
  entities: EditorEntity[];
  topology?: SiteTopology | null;
}

// ---------------------------------------------------------------------------
// Die VORBELEGUNGEN des Baukastens (Steuerung Stufe 2)
// ---------------------------------------------------------------------------

/**
 * Ein Rezept als STARTPUNKT im Baukasten (Konzept `vp-steuerung-konzept-b3`
 * §3.3 „Der Builder (die EINE Regel-Mechanik) … ohne Rezept-Galerie", Stufenplan
 * Stufe 2 „Rezept-Galerie entfällt (Rezepte werden Vorbelegungen des Builders)";
 * Captain-Entscheid „nur Builder").
 *
 * ⚠ Es entsteht KEINE zweite Maschine und keine Vorlagen-Mechanik: eine
 * Vorbelegung FÜLLT den Baukasten (bzw. den Verbraucher-Fragenbaum, der die
 * Absicht ausführen kann) — sie erzeugt nie hinter dem Rücken des Kunden eine
 * fertige Regel. Was danach passiert, entscheidet er im Baukasten, und vor dem
 * Aktivieren steht die Folgen-Karte.
 */
export interface Vorbelegung {
  id: RezeptId;
  titel: string;
  /** Der Ergebnis-Satz in Kundendeutsch — dieselbe Copy wie in der Galerie. */
  ergebnis: string;
}

export interface VorbelegungenView {
  /** Die anklickbaren Startpunkte — NUR was diese Anlage wirklich bauen kann. */
  liste: Vorbelegung[];
  /**
   * Was NICHT angeboten wird, mit dem echten Grund, sofern alle Übersprungenen
   * denselben haben — nie verschwiegen, aber auch nie als toter Knopf.
   */
  hinweis: string | null;
  /** Die Sackgassen-Rettung: keine einzige schaltbare Komponente. */
  brauchtKomponente: boolean;
}

/** Die Frage über der Startpunkt-Reihe. */
export const VORBELEGUNG_FRAGE = 'Womit anfangen?';

/**
 * Die Startpunkte für DIESE Anlage.
 *
 * ⚠ Ein Startpunkt ist eine EINLADUNG — deshalb steht hier nur, was wählbar
 * ist (ein „bald"-Rezept und ein unpassendes sind es nicht). Der Rest wird
 * GEZÄHLT und, wo alle denselben Grund teilen, beim Namen genannt: das ist der
 * Unterschied zwischen „ehrlich" und der Galerie, die dem Kunden dieselbe
 * Sackgasse dreimal zeigte (Befund B7 des Konzepts).
 */
export function vorbelegungen(ctx: RezeptKontext): VorbelegungenView {
  const eingabe = { entities: ctx.entities ?? [], topology: ctx.topology ?? null };
  const nutzbar = REZEPTE.filter((r) => r.maschine !== 'bald');
  const teil = partition(nutzbar, eingabe);
  // ⚠ Der Rollen-Vorfilter ist GRÖBER als die Maschine dahinter: `plantRoles`
  // liest die Rolle aus Typ/Kategorie, `speicherSchutzRegel` braucht wirklich
  // einen gemessenen Ladestand. Im Browser aufgefallen — der Startpunkt wurde
  // angeboten und tat beim Klick nichts. Ein Startpunkt ist eine EINLADUNG,
  // also entscheidet hier dieselbe Funktion, die danach baut.
  const baubar = teil.fitting.filter(
    (r) => r.id !== 'storage-protect' || speicherSchutzRegel(eingabe.entities) != null,
  );
  const nichtBaubar = teil.fitting.length - baubar.length;
  const bald = REZEPTE.filter((r) => r.maschine === 'bald').length;
  const uebersprungen = teil.notFitting.length + bald + nichtBaubar;
  // Der Grund wird NUR genannt, wenn er wirklich für alle Übersprungenen gilt —
  // ein „bald"-Rezept hat seinen eigenen (der Zustellweg fehlt), also schweigt
  // die Zeile dann über die Ursache, statt eine falsche zu behaupten.
  const grund = bald === 0 && nichtBaubar === 0 ? sharedReason(teil) : null;
  const zahl = uebersprungen === 1
    ? '1 weiterer Startpunkt passt'
    : `${uebersprungen} weitere Startpunkte passen`;
  return {
    liste: baubar.map((r) => ({ id: r.id, titel: r.titel, ergebnis: r.ergebnis })),
    hinweis: uebersprungen === 0
      ? null
      : `${zahl} nicht zu Ihrer Anlage${grund ? ` (${grund})` : ''}.`,
    brauchtKomponente: !plantRoles(eingabe).has('consumer'),
  };
}

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
