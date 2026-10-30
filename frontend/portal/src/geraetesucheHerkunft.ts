/**
 * Die Herkunft aus der Gerätesuche (Folgepaket `vp-gs-folge-herkunft`; Konzept `vp-portal-geraetesuche-konzept` §4
 * „Verlauf", §7 „Protokoll und was der Kunde sieht", Bild d1). Rein: kein React, kein Abruf.
 *
 * - **Woher eine Komponente stammt:** „aus der Gerätesuche vom 30.10.2026" - aus `SiteComponentRow.herkunft`, die der
 *   Server aus dem Protokoll der Suche liest. Das Protokoll überlebt den Läufer nach 30 Tagen (DP-3 A); der Satz
 *   bleibt also, wenn Suche und Fund gelöscht sind. Ohne Herkunft kein Satz - nie geraten.
 * - **Die Aktivität der Box:** die Zeilen des fünften Stroms `geraetesuche` im Kommando-Verlauf
 *   („Gerätesuche im Heimnetz · Sie · 38 s · nur gelesen", „Gerät angelegt: Wechselrichter (aus der Gerätesuche)").
 *   `befehle.film()` rendert sie wie jede andere Zeile; hier steht nur, was sie sagen.
 * - **Was das Portal beim Übernehmen mitschickt:** den Bezug auf Suche und Fund (`geraetesucheBezug`).
 */
import type { CommandEntry, GeraetesucheBezug, KomponenteHerkunft, ProtokollUrheber } from './api';
import type { BefehlTon, RohZeile } from './befehle';
import {
  GERAETESUCHE_GRUPPEN,
  type GeraetesucheGruppeWort,
  type GeraetesucheUrheber,
  type GeraetesucheZustand,
} from './geraetesuche';
import { dauerText, verlaufErgebnis, wer } from './geraetesucheAnsicht';

const ZONE = 'Europe/Berlin';

/** Die Zeile einer Suche im Heimnetz - der Satz aus Bild d1. */
export const SUCHE_SATZ = 'Gerätesuche im Heimnetz';
/** Die Suche liest nur: das steht an jeder ihrer Zeilen (Konzept §7 „Nur lesen"). */
export const NUR_GELESEN = 'nur gelesen';

/** Der Bezug, den das Portal bei „Übernehmen" mitschickt; ohne Suche (alter Einstieg) keiner. */
export function geraetesucheBezug(suchId: string | null | undefined, schluessel: string): GeraetesucheBezug | null {
  return suchId ? { suchId, fund: schluessel } : null;
}

/** „30.10.2026" in der Zone des Portals; null bei einem unlesbaren Zeitpunkt. */
function tagText(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ZONE });
}

/** „aus der Gerätesuche vom 30.10.2026"; null ohne (bekannte) Herkunft - ein fremdes Wort behauptet nichts. */
export function herkunftSatz(h: KomponenteHerkunft | null | undefined): string | null {
  if (!h || h.art !== 'geraetesuche') return null;
  const tag = tagText(h.gesuchtAm);
  return tag ? `aus der Gerätesuche vom ${tag}` : null;
}

/** Die Zeile „Angelegt" unter „Gerät & Verbindung" der Geräteseite; null ohne Herkunft. */
export function herkunftZeile(h: KomponenteHerkunft | null | undefined): { label: string; wert: string } | null {
  const satz = herkunftSatz(h);
  return satz ? { label: 'Angelegt', wert: satz } : null;
}

/** Was eine Zeile des Stroms `geraetesuche` sagt; `zeit`, `tag` und `strom` setzt `befehle.film()`. */
export interface SucheZeile {
  satz: string;
  urteil: string | null;
  herkunft: string;
  ton: BefehlTon;
  laufend: boolean;
  roh: RohZeile[];
}

/**
 * Eine Zeile des Stroms `geraetesuche`, oder null, wenn dieser Portal-Stand ihre Art nicht kennt (dann behauptet sie
 * nichts - die Unbekannt-bleibt-ohne-Behauptung-Regel des Verlaufs).
 *
 * @param ich der Name der eigenen Person („Sie" statt des Namens), null = unbekannt
 */
export function sucheZeile(e: CommandEntry, ich: string | null): SucheZeile | null {
  const g = e.geraetesuche;
  if (!g) return null;
  const person = e.urheber ? wer(urheber(e.urheber), ich) : null;
  switch (e.eventKind) {
    case 'geraetesuche': {
      if (!g.zustand) return null;
      const laufend = g.zustand === 'wartet' || g.zustand === 'laeuft';
      const roh: RohZeile[] = [];
      if (g.abgebrochenVon) roh.push({ label: 'Abbruch ausgelöst von', wert: wer(urheber(g.abgebrochenVon), ich) });
      roh.push({ label: 'Kennung der Suche', wert: g.suchId });
      return {
        satz: SUCHE_SATZ,
        urteil: ergebnis(g.zustand, g),
        herkunft: [person, dauerText(g.dauerMs), NUR_GELESEN].filter(Boolean).join(' · '),
        ton: laufend ? 'info' : WARN.has(g.zustand) || g.grund === 'neustart' ? 'warn' : 'ruhig',
        laufend,
        roh,
      };
    }
    case 'geraet_uebernommen':
    case 'adresse_uebernommen': {
      const was = e.eventKind === 'geraet_uebernommen' ? 'Gerät angelegt' : 'Neue Adresse übernommen';
      const roh: RohZeile[] = [];
      if (g.fund) roh.push({ label: 'Fund', wert: g.fund });
      const gesucht = g.gesuchtAm ? tagText(g.gesuchtAm) : null;
      if (gesucht) roh.push({ label: 'Gesucht am', wert: gesucht });
      return {
        satz: g.komponente
          ? `${was}: ${g.komponente} (aus der Gerätesuche)`
          : `${was} (aus der Gerätesuche) · das Gerät ist inzwischen entfernt`,
        urteil: null,
        herkunft: person ?? '',
        ton: 'ok',
        laufend: false,
        roh,
      };
    }
    default:
      return null;
  }
}

/** Eine Suche, die nicht ohne Störung endete: Bernstein, nie rot - es wurde nur gelesen. */
const WARN = new Set(['keine_antwort', 'fehlgeschlagen', 'abgelehnt']);

/** Das Ergebnis in einem Wort - dieselben Wörter wie „Letzte Suchen" (m10); ohne Zähler keine erfundene Zahl. */
function ergebnis(zustand: GeraetesucheZustand, g: NonNullable<CommandEntry['geraetesuche']>): string {
  if (zustand === 'fertig' && !g.zaehler) return 'fertig';
  const leer = Object.fromEntries(GERAETESUCHE_GRUPPEN.map((k) => [k, 0])) as Record<GeraetesucheGruppeWort, number>;
  return verlaufErgebnis({
    suchId: g.suchId,
    deviceId: '',
    zustand,
    grund: g.grund,
    gestartetAm: '',
    gestartetVon: { name: '', rolle: null, art: null },
    dauerMs: g.dauerMs,
    zaehler: { ...leer, ...g.zaehler },
  });
}

/** Der Urheber im Wortschatz der Suche; eine Art, die sie nicht kennt, nennt nur den Namen. */
function urheber(u: ProtokollUrheber): GeraetesucheUrheber {
  const art = u.art === 'kunde' || u.art === 'unterstuetzung' || u.art === 'voltpilot' || u.art === 'notfall' ? u.art : null;
  return { name: u.name, rolle: u.rolle, art };
}
