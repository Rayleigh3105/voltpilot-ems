/**
 * Die Datenquellen-Vorschlagsliste im Portal (UEMS AP-06 IP-4, Vertrag
 * `docs/contracts/v2/data-source-assignment.md` §8) — die REINE Logik hinter
 * `DatenquelleVorschlagListe`: Zeilen in Kundensprache, die Anfrage „so, wie die Liste sie zeigt“
 * und das Urteil über eine 409.
 *
 * Erster Aufrufer ist Schritt 2 des Messen-Assistenten: ohne diese Liste verknüpfte kein
 * Portal-Aufruf eine Komponente mit einer Datenquelle, und der Writer schrieb jeden Wert ohne
 * Zuordnung (Untersuchung `vp-uems-messkunde-portalweg-datenquelle`, 21.09.2026). Der spätere
 * Übernahme-Assistent für Bestandskunden nutzt dieselbe Liste.
 *
 * AP-06 E1 = A: nichts ändert sich, bis der Kunde „Übernehmen“ bestätigt — das GET liest nur.
 * Messwelt-Sprache: kein Wort über Steuern oder Geld (die Steuerquelle wird nicht gezeigt).
 */
import type {
  UemsDatenquelleAusgelassen,
  UemsDatenquelleBestaetigt,
  UemsDatenquelleUebernommen,
  UemsDatenquelleVorschlag,
  UemsDatenquelleVorschlagsliste,
  UemsVorschlagKomponente,
} from './api';
import { PROTOKOLLE } from './uemsDatenquelle';

export const DQ_TITEL = 'Datenquellen aus Ihren Geräten';
export const DQ_SATZ =
  'Diese Adressen liest Ihre Box bereits. Erst mit „Übernehmen“ werden sie zu Datenquellen, und VoltPilot ordnet ihre Werte zu. Bis dahin ändert sich nichts.';
export const DQ_LEER = 'Kein angebundenes Gerät dieser Anlage wartet auf eine Datenquelle.';
export const DQ_LAEDT = 'Vorschläge werden geladen …';
export const DQ_UEBERNEHMEN = 'Übernehmen';
export const DQ_LADEFEHLER = 'Die Datenquellen-Vorschläge konnten nicht geladen werden.';
export const DQ_NEU_LADEN = 'Erneut laden';
export const DQ_FEHLER = 'Die Datenquellen konnten nicht übernommen werden. Bitte versuchen Sie es erneut.';
export const DQ_GEAENDERT =
  'Die Vorschläge haben sich inzwischen geändert. Die Liste ist neu geladen, bitte prüfen Sie sie und übernehmen Sie erneut.';
export const DQ_OHNE = 'Ohne Datenquelle';

/** Die Arten der Komponenten, die ohne Kundenname sonst nur als Code erschienen. */
const ART_WORT: Record<string, string> = {
  'grid-meter': 'Netzanschlusszähler',
  'house-load': 'Hausverbrauch',
  'modbus-generic': 'Messgerät',
  producer: 'Erzeuger',
  'battery-hybrid': 'Batteriespeicher',
  wallbox: 'Wallbox',
  'generic-load': 'Verbraucher',
};

/** Das Protokoll in Kundenworten (`PROTOKOLLE`), ein unbekanntes Wort unverändert. */
export function protokollName(code: string): string {
  return PROTOKOLLE.find((p) => p.code === code)?.name ?? code;
}

/** Der Name, den der Kunde vergeben hat — sonst die Art in Kundenworten. */
export function komponentenName(k: UemsVorschlagKomponente): string {
  const name = k.name?.trim();
  if (name) return name;
  return (k.art && ART_WORT[k.art]) || 'Gerät ohne Namen';
}

/** Eine Zeile der Liste: „Box · Protokoll · Adresse“, dahinter die Geräte, und was die Bestätigung bewirkt. */
export interface DqZeile {
  schluessel: string;
  kopf: string;
  geraete: string;
  /** Der Satz des Servers: „Ab … liest …“ oder der Grund der Sperre. */
  satz: string;
  /** `frei`: „Übernehmen“ nimmt sie mit; `hinzufuegen`: an die vorhandene Quelle hängen; `gesperrt`: kein Weg. */
  art: 'frei' | 'hinzufuegen' | 'gesperrt';
  ziel: string | null;
  vorschlag: UemsDatenquelleVorschlag;
}

/** Der Schlüssel eines Vorschlags: Box, Weg und Komponenten — genau das, was die Bestätigung nennt. */
export function dqSchluessel(v: UemsDatenquelleVorschlag): string {
  return [v.box.id, v.protokoll, v.adresse, ...v.komponenten.map((k) => k.id)].join('|');
}

export function dqZeilen(liste: UemsDatenquelleVorschlagsliste): DqZeile[] {
  return liste.vorschlaege.map((v) => {
    const geraeteId = v.geraete_ids.length === 1 ? ` (Geräte-ID ${v.geraete_ids[0]})`
      : v.geraete_ids.length > 1 ? ` (Geräte-IDs ${v.geraete_ids.join(', ')})` : '';
    const art: DqZeile['art'] = v.grund === null ? 'frei' : v.ziel ? 'hinzufuegen' : 'gesperrt';
    return {
      schluessel: dqSchluessel(v),
      kopf: [v.box.name ?? 'Unbekannte Box', protokollName(v.protokoll), `${v.adresse}${geraeteId}`].join(' · '),
      geraete: v.komponenten.map(komponentenName).join(', '),
      satz: v.text,
      art,
      ziel: v.ziel ? v.ziel.kennzeichen : null,
      vorschlag: v,
    };
  });
}

function bestaetigt(v: UemsDatenquelleVorschlag, ziel?: string): UemsDatenquelleBestaetigt {
  const b: UemsDatenquelleBestaetigt = {
    device_id: v.box.id,
    protokoll: v.protokoll,
    adresse: v.adresse,
    komponenten: v.komponenten.map((k) => k.id),
  };
  if (ziel) b.datenquelle_id = ziel;
  return b;
}

/**
 * „Übernehmen“: alle freien Zeilen, jede genau so, wie die Liste sie zeigt (sonst 409
 * `vorschlag_geaendert`). Leer, wenn es keine gibt — dann zeigt die Fläche keinen Knopf
 * (der Server antwortet auf eine leere Übernahme mit 400).
 */
export function dqUebernehmenAnfrage(liste: UemsDatenquelleVorschlagsliste): UemsDatenquelleBestaetigt[] {
  return liste.vorschlaege.filter((v) => v.grund === null).map((v) => bestaetigt(v));
}

/** „Zu DQ-n hinzufügen“: die gesperrte Zeile mit ihrem Ziel — die Komponenten hängen an die vorhandene Quelle. */
export function dqHinzufuegenAnfrage(v: UemsDatenquelleVorschlag): UemsDatenquelleBestaetigt[] {
  if (!v.ziel) return [];
  return [bestaetigt(v, v.ziel.id)];
}

export function dqHinzufuegenWort(ziel: string): string {
  return `Zu ${ziel} hinzufügen`;
}

/** Was die Bestätigung geschrieben hat, in einem Satz. */
export function dqErgebnisSatz(r: UemsDatenquelleUebernommen): string {
  const kennzeichen = r.datenquellen.map((q) => q.kennzeichen).join(', ');
  const angehaengt = r.angehaengt ?? 0;
  if (angehaengt > 0 && r.neu === 0) return `Die Geräte gehören jetzt zu ${kennzeichen}.`;
  if (r.neu === 0) return `Schon übernommen: ${kennzeichen}.`;
  return r.neu === 1 ? `Datenquelle ${kennzeichen} angelegt.` : `Datenquellen ${kennzeichen} angelegt.`;
}

/** 409, nach der die Liste neu geladen werden muss: der Vorschlag oder eine Komponente hat sich geändert. */
export function istDqGeaendert(e: unknown): boolean {
  const f = e as { status?: unknown; body?: { code?: unknown } | null } | null;
  return f?.status === 409 && (f.body?.code === 'vorschlag_geaendert' || f.body?.code === 'komponente_hat_quelle');
}

/**
 * Ausgelassene Komponenten, EINGEKLAPPT gezeigt wie in Schritt 3 („Nicht vorgeschlagen“): der Claim
 * legt „Netzanschlusszähler“ und „Hausverbrauch“ ohne eigene Adresse an — sie sollen nicht wie ein
 * Fehler wirken, aber ein echter Zähler ohne Adresse darf auch nicht unsichtbar werden.
 */
export function dqAusgelassen(liste: UemsDatenquelleVorschlagsliste): { schluessel: string; satz: string }[] {
  return liste.ausgelassen.map((a: UemsDatenquelleAusgelassen, i) => ({
    schluessel: `${a.komponente.id}|${i}`,
    satz: `${komponentenName(a.komponente)}: ${a.text}`,
  }));
}
