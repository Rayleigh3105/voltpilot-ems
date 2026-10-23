import type {
  OrtTreffer,
  StandortAmStichtag,
  StandorteAmStichtag,
  StandortLage,
  StandortStammdaten,
  TenantContext,
} from './api';
import { adresseKurz, type Land } from './standorte';

/**
 * Wo eine neue Anlage steht - Schritt 1 des Anlege-Flusses (Anlage-Flow a1, Paket 1), die reine Hälfte.
 *
 * Regel 1 des Konzepts: die Adresse einmal. Aus ihr folgen Standort, Kartenpunkt, Land, Zeitzone und
 * Gebotszone; die Anlage übernimmt die Lage ihres Standorts (die API, `SiteController#createSite`).
 * Vorher fragte der Weg den Ort bis zu dreimal (F1, B1, F16).
 *
 * Drei Lagen des Kunden (`ortModus`):
 *  - `erste`: noch kein Standort, noch keine Anlage - ein Adressfeld, Standort und Anlage entstehen in
 *    einem Zug (Privatkunden; Unternehmen legen ihren Standort zuerst über den Standort-Dialog an).
 *  - `wahl`: es gibt Standorte - die ausdrückliche Frage „Wo steht die neue Anlage?“ (D8 = A): am selben
 *    Ort (vorgewählt bei genau einem) oder an einer anderen Adresse, die den Standort mit anlegt.
 *  - `nur_lage`: Anlagen ohne Standort-Objekt (Bestand) - die Adresse setzt nur den Kartenpunkt der
 *    Anlage, wie bisher die Ortssuche; ein Standort entsteht hier nicht.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */

/** Wer anlegt: Privatkunde oder Unternehmen (D2) - `null`, solange die Antwort fehlt (Bestand). */
export type AnlegeWeg = 'privat' | 'unternehmen';

/**
 * Der Weg aus der Antwort der Registrierung (`tenant-context`): „Für ein Unternehmen“ ist
 * `betreiber`, „Für mein Zuhause“ `endkunde`. Ein selbst registrierter Kundenbereich ohne Antwort
 * (Segment B2C, vor der Frage) ist privat (F2: er lief sonst „nur messen“). Ohne beides `null` - dann
 * entscheidet der Fluss wie bisher.
 */
export function anlegeWeg(kontext: Pick<TenantContext, 'betriebsart' | 'segment'> | null): AnlegeWeg | null {
  if (kontext?.betriebsart === 'betreiber') return 'unternehmen';
  if (kontext?.betriebsart === 'endkunde' || kontext?.segment === 'B2C') return 'privat';
  return null;
}

/** Die Zeitzone folgt dem Land der Adresse - keine Frage mehr dafür. */
export const ZEITZONE_DES_LANDES: Record<Land, string> = {
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
};

/** Der Name einer ersten Anlage und ihres Standorts, solange der Kunde keinen anderen wählt. */
export const NAME_VORGABE = 'Zuhause';

/** Eine Adresse, wie sie der Standort trägt: Straße mit Hausnummer, PLZ, Ort, Land. */
export interface Adresse {
  strasse: string;
  plz: string | null;
  ort: string;
  land: Land;
}

/** Ein Vorschlag genügt für einen Standort, wenn er eine Straße trägt - ein Ort allein nicht. */
export function adresseAusTreffer(t: OrtTreffer): Adresse | null {
  if (!t.strasse || !t.ort) return null;
  return { strasse: t.hausnummer ? `${t.strasse} ${t.hausnummer}` : t.strasse, plz: t.plz, ort: t.ort, land: t.land };
}

export const SATZ_ADRESSE_FEHLT = 'Bitte geben Sie die Adresse Ihrer Anlage an.';
export const SATZ_STRASSE_FEHLT = 'Bitte wählen Sie eine Adresse mit Straße und Hausnummer.';
export const SATZ_NICHT_GEFUNDEN =
  'Diese Adresse finden wir nicht. Bitte prüfen Sie sie - oder geben Sie sie von Hand ein.';
/** F5: getippt, aber nicht gewählt - der erste Vorschlag gilt, der Pin zeigt ihn zur Kontrolle. */
export function satzErsterVorschlag(text: string): string {
  return `Wir haben „${text}“ gewählt. Stimmt der Punkt auf der Karte? Dann tippen Sie noch einmal auf „Weiter“.`;
}

/** „Hauptstraße 12, 91710 Gunzenhausen“. */
export function adresseText(a: Adresse): string {
  return `${a.strasse}, ${[a.plz, a.ort].filter(Boolean).join(' ')}`;
}

/** Die Anfrage an `POST /api/v1/standorte` aus einer Adresse - Zeitzone aus dem Land. */
export function standortAnfrage(name: string, a: Adresse, lage: StandortLage | null): StandortStammdaten {
  return {
    name,
    adresse: { strasse: a.strasse, plz: a.plz, ort: a.ort, land: a.land },
    zeitzone: ZEITZONE_DES_LANDES[a.land],
    lage,
  };
}

/**
 * Die Namen, die ein Standort an einer ANDEREN Adresse bekommt (D8): die Straße; ist sie unter den
 * Standorten schon vergeben (409 `name_belegt`), Straße und Ort. Umbenennen geht in den Einstellungen.
 */
export function standortNamen(a: Adresse): string[] {
  return [a.strasse, `${a.strasse}, ${a.ort}`];
}

/** Die Standorte, an denen eine neue Anlage entstehen kann: vorhanden und nicht archiviert. */
export function offeneStandorte(antwort: StandorteAmStichtag | null): StandortAmStichtag[] {
  return (antwort?.standorte ?? []).filter((s) => s.bestand === 'vorhanden' && s.zustand !== 'archiviert');
}

export type OrtModus = 'erste' | 'wahl' | 'nur_lage';

export function ortModus(standorte: readonly StandortAmStichtag[], hatAnlagen: boolean): OrtModus {
  if (standorte.length > 0) return 'wahl';
  return hatAnlagen ? 'nur_lage' : 'erste';
}

/** Die Wahl in Schritt 1: ein vorhandener Standort oder eine andere Adresse. */
export type OrtWahl = { art: 'standort'; id: string } | { art: 'neu' };

/** Die Vorwahl: der vom Wirt genannte Standort, sonst bei genau einem dieser - mehrere wählt der Kunde. */
export function ortVorwahl(standorte: readonly StandortAmStichtag[], vorwahl: string | null): OrtWahl | null {
  if (vorwahl && standorte.some((s) => s.id === vorwahl)) return { art: 'standort', id: vorwahl };
  return standorte.length === 1 ? { art: 'standort', id: standorte[0].id } : null;
}

/** Die Zeile einer Wahl am Standort: „Am selben Ort wie „Zuhause““ und seine Adresse (oder was fehlt). */
export function ortZeile(s: StandortAmStichtag): { titel: string; zeile: string; ohneAdresse: boolean } {
  const adresse = adresseKurz(s);
  return {
    titel: `Am selben Ort wie „${s.name}“`,
    zeile: adresse ?? 'Adresse noch nicht hinterlegt',
    ohneAdresse: !adresse,
  };
}

/**
 * Der Satz unter der Wahl - was sie bewirkt (F16: die neue Anlage landete still am Standort einer
 * anderen Anlage, und alles, was der Standort zusammenzählt, mischte zwei Orte).
 */
export function ortWahlFolge(wahl: OrtWahl | null, standorte: readonly StandortAmStichtag[]): string | null {
  if (!wahl) return null;
  if (wahl.art === 'neu') return 'Für die neue Adresse legen wir einen eigenen Standort an.';
  const s = standorte.find((x) => x.id === wahl.id);
  if (!s) return null;
  return `Die neue Anlage gehört ab heute zu ${s.name}. Bilanz und Netzanschluss des Standorts zählen sie mit.`;
}

/**
 * Der Satz, wenn der gewählte Standort keine Lage hat (ohne Kartenpunkt kein Wetter für die Anlage) - und
 * der Knopf dazu: fehlt die Adresse, „Adresse nachtragen“; fehlt nur der Punkt, „Punkt auf der Karte setzen“.
 * `null`, wenn der Standort eine Lage hat.
 */
export function standortOhneLage(s: StandortAmStichtag): { satz: string; knopf: string } | null {
  if (s.lage) return null;
  return adresseKurz(s)
    ? {
        satz: 'Für diesen Standort fehlt noch der Punkt auf der Karte - ohne ihn fehlen Wetter und Sonnenprognose.',
        knopf: 'Punkt auf der Karte setzen',
      }
    : {
        satz: 'Für diesen Standort ist noch keine Adresse hinterlegt - ohne sie fehlen Wetter und Sonnenprognose.',
        knopf: 'Adresse nachtragen',
      };
}
