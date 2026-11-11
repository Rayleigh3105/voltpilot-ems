import type { EntityLocalSetup, MastrPreview, SiteAsset, SiteEntity } from './api';
import { adoptableSources, adoptedSources, inverterSetup, sourceSummary } from './rollen';
import { guidedAdoptions, typeLabel, type AdoptionPlan } from './setupPath';
import { zahl } from './zahl';

export { kwpText, pvLage, type PvLage } from './pvLage';

/**
 * Schritt 3 des Anlege-Flusses: „Was gehört zu Ihrer Anlage?“ (Anlage-Flow a1, Paket 2) - die reine Hälfte.
 *
 * Bestätigen ist leichter als Abtippen: was die Box meldet, steht als Liste da und wird mit „Stimmt so“
 * übernommen (vorher fragte die Übernahme im Einrichtungspfad Modulleistung und MaStR-Nummer leer, auch
 * wenn beides schon in den Anlagen-Daten stand - F17). Die MaStR-Nummer ist ein Link „Aus dem Register
 * holen“ statt eines eigenen Schritts (R4). Ohne Box reichen zwei Zahlen für die Prognose.
 *
 * Gemeldet ist nicht übernommen, und übernommen ist keine Wirkung: die Liste sagt „gefunden“, bis der Server
 * die Übernahme angenommen hat; was ein Gerät danach tut, zeigt das Cockpit an seinen Messwerten.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */

/** Eine Zeile der Liste „Das hat Ihre Box gefunden“. */
export interface GefundeneZeile {
  id: string;
  /** Wechselrichter (Info, kommt aus den Stammdaten), ein gemeldetes Gerät oder ein schon übernommenes. */
  art: 'wechselrichter' | 'gemeldet' | 'einordnung' | 'uebernommen';
  titel: string;
  zeile: string;
  /** Nur bei `gemeldet`: wie VoltPilot es übernimmt. */
  plan: AdoptionPlan | null;
}

/**
 * Die Liste aus dem, was die Box meldet (`/entities` → `localSetup`): zuerst der Wechselrichter, dann die
 * gemeldeten Geräte, die der geführte Weg übernehmen kann, dann solche, die eine Einordnung durch VoltPilot
 * brauchen, zuletzt die schon übernommenen.
 */
export function gefundeneZeilen(localSetup: readonly EntityLocalSetup[]): GefundeneZeile[] {
  const setup = [...localSetup];
  const plaene = guidedAdoptions(adoptableSources(setup));
  const geplant = new Set(plaene.map((p) => p.sourceId));
  const zeilen: GefundeneZeile[] = inverterSetup(setup).map((w) => ({
    id: w.id,
    art: 'wechselrichter',
    titel: 'Wechselrichter',
    zeile: sourceSummary(w),
    plan: null,
  }));
  for (const p of plaene) {
    zeilen.push({ id: p.sourceId, art: 'gemeldet', titel: p.typeLabel, zeile: p.summary, plan: p });
  }
  for (const q of adoptableSources(setup).filter((q) => !geplant.has(q.id))) {
    zeilen.push({ id: q.id, art: 'einordnung', titel: q.roleLabel, zeile: q.summary, plan: null });
  }
  for (const u of adoptedSources(setup)) {
    zeilen.push({ id: u.id, art: 'uebernommen', titel: titelUebernommen(u), zeile: sourceSummary(u), plan: null });
  }
  return zeilen;
}

function titelUebernommen(u: EntityLocalSetup): string {
  if (u.role === 'pv-generation') return typeLabel('producer');
  if (u.role === 'grid-meter') return typeLabel('grid-meter');
  return 'Gerät';
}

/** Die übernehmbaren Erzeuger (PV-Wechselrichter, die die Box meldet). */
export function erzeugerPlaene(zeilen: readonly GefundeneZeile[]): AdoptionPlan[] {
  return zeilen.flatMap((z) => (z.plan && z.plan.entityType === 'producer' ? [z.plan] : []));
}

/** Der Speicher, wie ihn die Anlagen-Daten schon kennen - `null`, wenn keiner eingetragen ist. */
export function bekannterSpeicher(assets: readonly SiteAsset[] | null): { kwh: number } | null {
  const b = (assets ?? []).find((a) => a.type === 'battery');
  return b?.capacityKwh != null && b.capacityKwh > 0 ? { kwh: b.capacityKwh } : null;
}

/** Hat der Kunde schon Geräte übernommen (dann ist die Liste kein erster Fund mehr)? */
export function hatUebernommeneErzeuger(entities: readonly SiteEntity[]): boolean {
  return entities.some((e) => e.entityType === 'producer');
}

function stellen(text: string): number {
  return text.trim().split(',')[1]?.length ?? 0;
}

export type Pruefung = { ok: true; wert: number | null } | { ok: false; satz: string };

/**
 * Die Leistung der Solarmodule: leer heißt „weiß ich nicht“ (nie eine Null); sonst über 0, höchstens zwei
 * Nachkommastellen, unter 100.000 kWp - dieselben Grenzen wie der Server (`SavePvRequest`, die Übernahme).
 */
export function pruefeKwp(text: string): Pruefung {
  if (!text.trim()) return { ok: true, wert: null };
  const wert = zahl(text);
  if (wert == null || wert <= 0) {
    return { ok: false, satz: 'Bitte geben Sie die Leistung der Solarmodule als Zahl über 0 kWp an, z. B. 9,8.' };
  }
  if (stellen(text) > 2 || wert >= 100_000) return { ok: false, satz: 'Höchstens zwei Nachkommastellen, z. B. 9,8 kWp.' };
  return { ok: true, wert };
}

/** Kapazität und Leistung des Speichers: beide Pflicht, sobald „Speicher“ gewählt ist. */
export function pruefeSpeicher(kwh: string, kw: string): { kwh?: string; kw?: string; werte?: { kwh: number; kw: number } } {
  const k = zahl(kwh);
  const l = zahl(kw);
  const fehler: { kwh?: string; kw?: string } = {};
  if (k == null || k <= 0) fehler.kwh = 'Bitte geben Sie die Kapazität des Speichers als Zahl über 0 kWh an, z. B. 10.';
  if (l == null || l <= 0) fehler.kw = 'Bitte geben Sie die Leistung des Speichers als Zahl über 0 kW an, z. B. 5.';
  if (fehler.kwh || fehler.kw) return fehler;
  return { werte: { kwh: k as number, kw: l as number } };
}

/**
 * R4: der Ort aus dem Register gegen die Adresse der Anlage. Heute stand dort „89150 Laichingen - stimmt
 * das?“, und ein „nein“ hatte keine Handlung. Jetzt: passt die Postleitzahl nicht, sagt der Satz, was nicht
 * passt; „Andere Nummer“ führt zurück. `null`, wenn eines fehlt oder beide passen.
 */
export function registerortWarnung(preview: MastrPreview, plzDerAnlage: string | null, ortDerAnlage: string | null): string | null {
  if (!preview.plz || !plzDerAnlage) return null;
  if (preview.plz.trim() === plzDerAnlage.trim()) return null;
  const register = [preview.plz, preview.ort].filter(Boolean).join(' ');
  const anlage = [plzDerAnlage, ortDerAnlage].filter(Boolean).join(' ');
  return `Das Register nennt ${register}, Ihre Anlage steht in ${anlage}. Ist das die richtige Nummer?`;
}

export function kwhText(kwh: number): string {
  return `${kwh.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kWh`;
}
