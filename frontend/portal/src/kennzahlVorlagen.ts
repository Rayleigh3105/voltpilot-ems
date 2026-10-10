/**
 * Der Vorlagen-Katalog der Kennzahlen (UEMS AP-11 IP-10, §4.12, E9 = A) — reines Modul.
 *
 * `src/kennzahlen/kennzahl-vorlagen.json` ist die BYTE-gleiche Kopie der Server-Ressource
 * `services/api/src/main/resources/kennzahlen/kennzahl-vorlagen.json` (`kennzahlVorlagen.sync.test.ts`);
 * `GET /api/v1/kennzahl-vorlagen` antwortet dieselben Knoten. Die Form hält
 * `docs/contracts/v2/kennzahl-vorlagen.schema.json` fest.
 *
 * Eine Vorlage ist nie eine Kennzahl und nie ein Kundenobjekt: sie belegt den Assistenten „Kennzahl anlegen“ (IP-14)
 * vor — Rechenform, Name, Zweck, beim Anteil das Komplement — und sagt, was sie an Menge und Bezugsgröße erwartet.
 * Die Eingänge bindet der Kunde ausdrücklich; die Vorschau (`api.kennzahlVorschau`) prüft die vorbelegte Anfrage.
 * Die Vorbelegung ruft `vorlage` aus `uemsKennzahl.ts` (Zwilling von `KennzahlRegeln.vorlage`); die Java-Seite
 * `KennzahlVorlagen.vorbelegung` setzt dieselben Felder.
 */
import type { KennzahlAnfrage, KennzahlGeltungArt, KennzahlVorlage } from './api';
import katalog from './kennzahlen/kennzahl-vorlagen.json';
import { ANTEIL, vorlage as belegung } from './uemsKennzahl';

/** Der Platzhalter am Ende jedes Name-Vorschlags; er wird der Name des Geltungsobjekts. */
export const PLATZHALTER = '{Geltungsbereich}';

const ENDUNG = ` — ${PLATZHALTER}`;

/** Die Vorlagen in Katalog-Reihenfolge. */
export const KENNZAHL_VORLAGEN: readonly KennzahlVorlage[] = (katalog as unknown as { vorlagen: KennzahlVorlage[] }).vorlagen;

export const kennzahlVorlage = (kennung: string): KennzahlVorlage | null =>
  KENNZAHL_VORLAGEN.find((v) => v.kennung === kennung) ?? null;

/** Die Überschrift einer Vorlage (Karte in Schritt 1): der Name-Vorschlag ohne „ — {Geltungsbereich}“. */
export const vorlagenTitel = (v: KennzahlVorlage): string =>
  v.name_vorschlag.endsWith(ENDUNG) ? v.name_vorschlag.slice(0, -ENDUNG.length) : v.name_vorschlag;

/**
 * Die Vorbelegung einer Anfrage an `POST /api/v1/kennzahlen` und `…/vorschau` (K20): Rechenform, Name mit dem
 * Geltungsobjekt, Zweck, beim Anteil das Komplement — sonst nichts. Kennzeichen, Verantwortlich und Periode bleiben
 * leer (der Server vergibt bzw. nimmt den Aufrufer), die Eingänge bindet der Kunde.
 */
export const vorbelegung = (
  v: KennzahlVorlage,
  geltung: { art: KennzahlGeltungArt; id: string; name: string },
): KennzahlAnfrage => {
  const b = belegung(v.rechenform, v.name_vorschlag, v.zweck_vorschlag, geltung.name);
  return {
    kennzeichen: null,
    name: b.name,
    rechenform: b.rechenform,
    geltung_art: geltung.art,
    geltung_id: geltung.id,
    verantwortlich_name: null,
    zweck: b.zweck,
    periode_art: null,
    komplement: b.rechenform === ANTEIL ? v.komplement : null,
    eingaenge: [],
  };
};
