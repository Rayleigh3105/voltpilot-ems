import type { StandortAmStichtag, StandortAnlage, StandorteAmStichtag } from './api';
import { UEMS_STANDORT, UEMS_STANDORT_AUF_DER_KARTE } from './glossar';
import type { VpOption } from './picker/optionen';
import { adresseKurz, esFehltSatz } from './standorte';
import { datumText } from './uemsOrtsbaum';

/**
 * Der Standort einer Anlage in „Meine Anlage“ und im Anlage-Assistenten
 * (UEMS AP-02 IP-8, Mockup T6a, W4) — die reine Hälfte.
 *
 * W4: „Standort“ ist Feld UND Objekt (E9 = B). Steht das Objekt auf der Karte,
 * heißt die Koordinaten-Zeile in der Anzeige „Standort auf der Karte“ — das
 * Label, das sie beim Bearbeiten schon trägt. ⚠ OHNE Standort-Objekt bleibt die
 * Karte Zeichen für Zeichen, wie sie war (Bestandsschutz, Snapshot-Test): kein
 * Umbenennen, keine leere Zeile.
 */

/** Die Zeile des OBJEKTS. */
export const STANDORT_OBJEKT_LABEL = UEMS_STANDORT;
/** Die Koordinaten-Zeile, wenn das Objekt daneben steht. */
export const STANDORT_KARTE_LABEL = UEMS_STANDORT_AUF_DER_KARTE;
/** Wie am Standort-Kopf (IP-6): öffnet den Standort-Dialog „vervollständigen“. */
export const KNOPF_ADRESSE_NACHTRAGEN = 'Adresse nachtragen';

export interface AnlageStandort {
  standort: StandortAmStichtag;
  zuordnung: StandortAnlage;
}

/** Der Standort, dem die Anlage am Stichtag der Antwort gehört — `null` ohne Standort-Objekt. */
export function standortDerAnlage(antwort: StandorteAmStichtag | null, anlageId: string): AnlageStandort | null {
  for (const standort of antwort?.standorte ?? []) {
    if (standort.bestand !== 'vorhanden') continue;
    const zuordnung = standort.anlagen.find((a) => a.id === anlageId);
    if (zuordnung) return { standort, zuordnung };
  }
  return null;
}

/** Die Koordinaten-Zeile: ihr bisheriges Label ohne Objekt, „Standort auf der Karte“ mit (W4). */
export function koordinatenLabel(a: AnlageStandort | null): string {
  return a ? STANDORT_KARTE_LABEL : UEMS_STANDORT;
}

export interface StandortZeile {
  /** „Werk Ahrenberg (ST-1)“ */
  name: string;
  /** „Gewerbering 7, Ahrenberg · seit 01.10.2026“ — eine fehlende Adresse bleibt weg. */
  zeile: string;
  /** „Noch nicht eingerichtet — es fehlt: Adresse“ (wie am Standort-Kopf); `null`, wenn nichts fehlt. */
  fehlt: string | null;
}

/** T6a: „Werk Ahrenberg (ST-1) · Gewerbering 7 · seit 01.10.2026“. */
export function standortZeile(a: AnlageStandort): StandortZeile {
  const { standort, zuordnung } = a;
  const teile = [adresseKurz(standort), `seit ${datumText(zuordnung.gueltigAb)}`].filter((x): x is string => !!x);
  return {
    name: `${standort.name} (${standort.kurzzeichen})`,
    zeile: teile.join(' · '),
    fehlt: esFehltSatz(standort),
  };
}

// ─────────────────────────────────────────── Anlage-Assistent, Schritt 1

/**
 * Der Satz des Servers bei mehreren Standorten ohne Wahl (422 `standort_waehlen`,
 * `AnlageStandortService`) — Zeichen für Zeichen, damit beide dasselbe sagen.
 */
export function standortWaehlenSatz(anzahl: number): string {
  return `Ihr Unternehmen hat ${anzahl} Standorte. Bitte wählen Sie, zu welchem Standort die neue Anlage gehört.`;
}

export interface StandortWahl {
  optionen: VpOption[];
  /** Genau ein Standort: er ist vorbelegt. Mehrere: `null` — die Wahl ist Pflicht. */
  vorbelegt: string | null;
}

/**
 * Die Auswahl im Assistenten. `null` heißt: KEIN Picker — ohne Standort-Objekt
 * bleibt der Schritt, wie er war, und `POST /api/v1/sites` trägt kein `standortId`.
 */
export function standortWahl(antwort: StandorteAmStichtag | null): StandortWahl | null {
  const offen = (antwort?.standorte ?? []).filter((s) => s.bestand === 'vorhanden' && s.zustand !== 'archiviert');
  if (offen.length === 0) return null;
  return {
    optionen: offen.map((s) => ({ value: s.id, label: `${s.name} (${s.kurzzeichen})`, sub: adresseKurz(s) })),
    vorbelegt: offen.length === 1 ? offen[0].id : null,
  };
}

/** Der Satz unter dem Picker: was die Wahl bewirkt (die Zuordnung beginnt am Tag des Anlegens). */
export function standortWahlHinweis(wahl: StandortWahl, gewaehlt: string | null): string | null {
  const name = wahl.optionen.find((o) => o.value === gewaehlt)?.label ?? null;
  if (wahl.optionen.length === 1 && name) return `Ihr einziger Standort ist vorbelegt: die neue Anlage gehört ab heute zu ${name}.`;
  return name ? `Die neue Anlage gehört ab heute zu ${name}.` : null;
}
