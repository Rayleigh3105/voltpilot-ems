/**
 * DIE GELD-REGEL JE ANLAGE (UEMS AP-01 IP-8; Konzept `data/vp-uems-ap01-portalaufbau`
 * §4.6, §5.5, A13 — Captain-Vorgabe 10.09.2026: „Die Messdatenkunden brauchen
 * keine Geldanzeige.").
 *
 * IP-6 hat die Regel für die Ebene durchgesetzt (`uebersicht.geldAnlagen`), dieses
 * Modul setzt sie je Anlage durch: eine Anlage, die weder aktiv an „Steuern &
 * Optimieren" teilnimmt noch einen Erzeuger oder Speicher hat, zeigt im Cockpit
 * keinen Geld-Held, keine Steuerungs-Karte und keine Marktpreise, im Verlauf
 * keine Erlöse, Marktpreise und Lastspitzen.
 *
 * Der Grundfakt kommt wie auf der Ebene aus `geldAnlagen` über die Zeile der
 * Übersicht (`roleCounts`, Katalog-Kategorie) und die Funktionen. W7 erhält auf
 * den Anlagenflächen zusätzlich tarifbasierte Kosten. Die AE7-Signale `hasPv`/
 * `hasStorage` lesen dagegen gemessene Rollen; sie dürften über dieselbe Anlage
 * etwas anderes sagen als die Übersicht, deshalb liest die Regel sie nie.
 *
 * ⚠ Die Regel greift nur, wo es die Ebene gibt: die Anlage steht in
 * `GET /funktionen` (heute einem Standort zugeordnet oder mit Teilnahme). Ohne
 * Funktionen (älteres Backend, Fehler) und für jede Anlage ohne Standort bleibt
 * alles zeichengleich wie vorher — dieselbe Grenze wie IP-6.
 *
 * Reines Modul: keine React-Importe, kein Netzwerk.
 */
import type { Funktionen, OverviewSite } from './api';
import { VERLAUF_TABS } from './ebenenNav';
import type { BausteinId } from './cockpitLayout';
import type { AnlagenSub } from './nav';
import type { AnlageSurface, CockpitBlockId, DeepViewId } from './surface';
import { geldAnlagen } from './uebersicht';

/**
 * Zeigt dieser Cockpit-Baustein Geld? VOLLSTÄNDIG über alle Bausteine: wer einen
 * neuen ergänzt, muss hier entscheiden — sonst bricht der Typ-Check, und der
 * Wächter in `anlageGeld.test.ts` vergleicht die Schlüssel mit den kanonischen
 * Listen des Cockpits.
 */
export const GELD_BAUSTEIN: Readonly<Record<BausteinId, boolean>> = {
  status: false,
  energiefluss: false,
  // Der Geld-Held: „Unterm Strich" (Leiste in der Bühne, am Telefon die Geld-Karte).
  geld: true,
  // Die Steuerungs-Karte (Sollwert, Wächter) gehört zu „Steuern & Optimieren".
  steuerung: true,
  fahrplan: false,
  // Die Marktpreise im Cockpit.
  strompreis: true,
  laden: false,
  // Die Kacheln tragen Geld nur über ihre Blöcke — die nimmt `ohneGeld` heraus.
  kacheln: false,
  komponenten: false,
  zustand: false,
};

/** Trägt dieser Block des Lese-Modells Geld? Vollständig wie {@link GELD_BAUSTEIN}. */
export const GELD_BLOCK: Readonly<Record<CockpitBlockId, boolean>> = {
  status: false,
  'lade-budget': false,
  // Die Lastspitze rechnet vermiedene Leistungskosten.
  'peak-band': true,
  'erloes-komposition': true,
  handel: true,
  energiefluss: false,
  // Autarkie und Eigenverbrauch in Prozent.
  eigenverbrauch: false,
  'geraete-automatik': false,
  'toolbox-pointer': false,
};

/** Zeigt diese Tiefen-Ansicht Geld? Vollständig wie {@link GELD_BAUSTEIN}. */
export const GELD_ANSICHT: Readonly<Record<DeepViewId, boolean>> = {
  ladevorgaenge: false,
  live: false,
  geraete: false,
  'telemetrie-historie': false,
  wetter: false,
  'erloes-historie': true,
  fahrplan: false,
  marktpreise: true,
  prognosequalitaet: false,
  lastspitzen: true,
  'flow-editor': false,
};

/** Die Verlauf-Reiter mit Geld — aus den Reitern selbst gelesen, keine zweite Liste. */
export const GELD_UNTERSEITEN: readonly AnlagenSub[] = VERLAUF_TABS.filter(
  (t) => t.view != null && GELD_ANSICHT[t.view],
).map((t) => t.sub);

/** Steht die Anlage auf einer Ebene — also in `GET /funktionen`? */
export function anlageAufEbene(siteId: string, funktionen: Funktionen | null): boolean {
  return funktionen?.standorte.some((st) => st.steuern.anlagen.some((a) => a.id === siteId)) ?? false;
}

/**
 * Bleibt diese Anlage ohne Geld? Nur auf einer Ebene, grundsätzlich dann, wenn
 * `geldAnlagen` sie nicht nennt; ein expliziter Tarif erhält nach W7 die
 * Anlagenflächen. Ohne Zeile der Übersicht gibt es keine Rolle — unbekannt ist
 * nie „erlaubt" (dieselbe Regel wie IP-6).
 */
export function anlageOhneGeld(
  siteId: string,
  funktionen: Funktionen | null,
  zeile: OverviewSite | null,
  tarifArt?: string | null,
): boolean {
  if (!anlageAufEbene(siteId, funktionen)) return false;
  // W7: Die Ebenen-Übersicht folgt weiterhin allein `geldAnlagen`. Auf den
  // Bestandsflächen der Anlage bleiben tarifbasierte Kosten dagegen sichtbar;
  // ein Standort darf sie durch die Zuordnung nicht verschwinden lassen. Damit
  // zeigt auch eine reine Messanlage dort Geld, sobald der Kunde einen Tarif setzt.
  if (tarifArt === 'fest' || tarifArt === 'dynamisch') return false;
  const fakt = zeile?.id === siteId ? zeile : ({ id: siteId } as OverviewSite);
  return !geldAnlagen([fakt], funktionen).has(siteId);
}

/**
 * Das Lese-Modell ohne Geld: keine Geld-Blöcke, keine Geld-Ströme, keine
 * Geld-Ansichten. Die Betriebsmodelle bleiben — sie sind die Wahrheit der
 * Steuerungsseite, nicht des Geldes. `geldfrei` trägt die Entscheidung zu jeder
 * Fläche, die nicht aus Blöcken und Ansichten liest (Cockpit-Bausteine, Adressen).
 */
export function ohneGeld(surface: AnlageSurface): AnlageSurface {
  return {
    ...surface,
    cockpitBlocks: surface.cockpitBlocks.filter((b) => !GELD_BLOCK[b.id]),
    moneyStreams: [],
    deepViews: surface.deepViews.filter((v) => !GELD_ANSICHT[v]),
    geldfrei: true,
  };
}

/** Die Cockpit-Bausteine, die eine geldfreie Anlage behält. */
export function bausteineOhneGeld(ids: readonly BausteinId[], surface: AnlageSurface | null): BausteinId[] {
  return surface?.geldfrei ? ids.filter((id) => !GELD_BAUSTEIN[id]) : [...ids];
}

/**
 * Die Unterseite, die tatsächlich erscheint: ein Lesezeichen auf „Erlöse",
 * „Marktpreise" oder „Lastspitzen" einer geldfreien Anlage landet auf den
 * Messwerten — nie auf einer Geld-Seite, die es für sie nicht gibt.
 */
export function unterseiteOhneGeld(sub: AnlagenSub, surface: AnlageSurface | null): AnlagenSub {
  return surface?.geldfrei && GELD_UNTERSEITEN.includes(sub) ? 'messwerte' : sub;
}
