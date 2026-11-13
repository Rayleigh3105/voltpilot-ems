/**
 * Das Meldungs-Center, rein (Alerting Scheibe 1+2, Konzept vp-alerting-konzept-m1 §6.8/§6.9).
 *
 * Die Kundenwörter dieser Fläche (Entscheid 6A, 15.10.2026): „Meldung", „Überwachung",
 * „Hinweis · Warnung · Dringend", „Gesehen". Sie stehen hier als Konstanten, bevor sie irgendwo
 * im Markup auftauchen (`frontend/portal/AGENTS.md` „Kundenwörter zuerst …"); der volle Eintrag im
 * Fachmodell-Glossar (`docs/fachmodell`) ist für diese Scheibe bewusst zurückgestellt - das
 * Glossar verlangt belegte Zeilenverweise gegen einen festgehaltenen Repo-Stand, den eine neue
 * Scheibe noch nicht hat; die Wörter selbst sind in der Fläche schon verbindlich.
 *
 * Scheibe 2 (§6.3, §6.4, §6.8) fügt Wörter derselben, noch zurückgestellten Familie hinzu:
 * „Überwachen" (Titel des Blatts), „Rückkehrschwelle" und „Erholdauer" (die zwei genannten,
 * änderbaren Vorgaben der Bedingung, §9). Seit Konzept b1 (20.10.2026, E3) gibt es kein Menü-Verb
 * und keine Marke „überwacht“ mehr am Wert: angelegt wird nur unter Meldungen › Einstellen.
 * Dieselbe Begründung wie oben gilt unverändert: sie sind Teil der noch nicht fachmodell-reifen
 * Überwachungs-Mechanik, nicht eigenständige, von ihr unabhängige Begriffe.
 *
 * Nur das Lazy-Stück `pages/MeldungenPage.tsx` importiert dieses Modul - die Glocke und die
 * Zustands-Anzeige im Einstiegs-Bündel nutzen das schlankere `meldungenApi.ts` direkt.
 */
import type { Anlagensteuerung } from './api';
import { einheitGeraetId } from './geraetAdresse';
import { meldungenApi } from './meldungenApi';
import type { Meldung, Schwere, UeberwachungsRegel } from './meldungenApi';
import { energiezielRoute, geraetSeiteHash, hashForRoute, kennzahlRoute, messstelleRoute } from './nav';
import { katalogEintrag } from './werteKatalog';

export { meldungenApi };
export type { Meldung, MeldungZustand, Schwere, UeberwachungsRegel } from './meldungenApi';

export const WORT_MELDUNG = 'Meldung';
export const WORT_MELDUNGEN = 'Meldungen';
export const WORT_UEBERWACHUNG = 'Überwachung';
export const WORT_GESEHEN = 'Gesehen';

/** Der Titel des Blatts „Überwachen“ (§6.8) - siehe Kommentar oben zur Zurückstellung. */
export const WORT_UEBERWACHEN = 'Überwachen';
/** Die Rückkehrschwelle einer Bedingung (§6.4, §9) - VoltPilot wählt und nennt sie, änderbar im Blatt. */
export const WORT_RUECKKEHRSCHWELLE = 'Rückkehrschwelle';
/** Die Erholdauer einer Bedingung (§6.4, §9) - erst so lange zurück, dann "wieder normal". */
export const WORT_ERHOLDAUER = 'Erholdauer';

/** Hinweis · Warnung · Dringend (Entscheid 6A) - nicht Severity, nicht Priorität. */
export const SCHWERE_WORT: Record<Schwere, string> = {
  hinweis: 'Hinweis',
  warnung: 'Warnung',
  dringend: 'Dringend',
};

/** Reihenfolge in der Liste (§6.8 Entwurf 2): Dringend vor Warnung vor Hinweis. */
const SCHWERE_RANG: Record<Schwere, number> = { dringend: 0, warnung: 1, hinweis: 2 };

/**
 * Die Wertart als Satzname, großgeschrieben für den Satzanfang (§6.8 Meldungsliste). Seit
 * Scheibe 2 dient der Werte-Katalog (`werteKatalog.ts`) dem Portal wirklich - er deckt `box.erreichbar`
 * und `datenquelle.liefert_daten` (Scheibe 1) ebenso ab wie die neuen `anlagenfluss`-Wertarten;
 * eine unbekannte Wertart fällt auf ihren rohen Schlüssel zurück, nie auf eine erfundene Übersetzung.
 */
export function wertartSatzname(wertart: string): string {
  const satzname = katalogEintrag(wertart)?.satzname ?? wertart;
  return satzname.charAt(0).toUpperCase() + satzname.slice(1);
}

/** Jetzt-Reiter: Dringend vor Warnung vor Hinweis, darin das Älteste zuerst (§6.8). */
export function sortiereJetzt(meldungen: readonly Meldung[]): Meldung[] {
  return [...meldungen].sort((a, b) => {
    const rang = SCHWERE_RANG[a.schwere] - SCHWERE_RANG[b.schwere];
    return rang !== 0 ? rang : a.ausgeloestAm.localeCompare(b.ausgeloestAm);
  });
}

/** Verlauf-Reiter: jüngste zuerst. */
export function sortiereVerlauf(meldungen: readonly Meldung[]): Meldung[] {
  return [...meldungen].sort((a, b) => b.ausgeloestAm.localeCompare(a.ausgeloestAm));
}

/**
 * Die Marke „eigene Überwachung“ (Alerting Scheibe 5, §6.4 Nr. 7) - jede Meldung einer der fünf
 * Scheibe-5-Wertarten ist strukturell IMMER aus einer selbst angelegten Überwachung (Entscheid 9A:
 * kein Läufer sät eine davon ab Werk) - die Marke braucht dafür keine eigene Herkunfts-Abfrage.
 */
export const WORT_EIGENE_UEBERWACHUNG = 'eigene Überwachung';

/** Die fünf Wertarten dieser Scheibe (§6.3) - bezug `messstelle`/`kennzahl`/`energieziel`. */
const SCHEIBE_5_WERTARTEN = new Set([
  'kennzahl.bezugsbasis',
  'energieziel.kurs',
  'messstelle.menge',
  'messstelle.beobachtung',
  'messstelle.monat_unvollstaendig',
]);

/** Ob eine Meldung aus einer der fünf Scheibe-5-Wertarten stammt (§6.4 Nr. 7). */
export function istEigeneUeberwachung(wertart: string): boolean {
  return SCHEIBE_5_WERTARTEN.has(wertart);
}

/** Die Kennung aus einem rohen Bezug (`"kennzahl:<uuid>"` → `"<uuid>"`) - wie der Server ihn baut. */
function bezugId(bezugKennung: string | null): string | null {
  if (!bezugKennung) return null;
  const teile = bezugKennung.split(':');
  return teile.length === 2 ? teile[1] : null;
}

/**
 * „Zur Auffälligkeit zur Quelle“ (§6.4 Nr. 7): wohin eine Scheibe-5-Meldung führt - `null` für jede
 * andere Wertart (sie hat schon `anlageName`). Es gibt heute keine eigene Ebene „Auffälligkeiten“ an
 * der Kennzahl-Seite (nur `ebene: 'bezugsbasis'`, `nav.ts`) - „Zur Kennzahl“ führt auf die Kennzahl
 * selbst, auf der eine Auffälligkeit sichtbar wird, statt eine nicht vorhandene Adresse zu erfinden.
 */
export function meldungQuelleLink(m: Meldung): { label: string; hash: string } | null {
  const id = bezugId(m.bezugKennung);
  if (!id) return null;
  switch (m.wertart) {
    case 'kennzahl.bezugsbasis':
      return { label: 'Zur Kennzahl', hash: hashForRoute(kennzahlRoute(id)) };
    case 'energieziel.kurs':
      return { label: 'Zum Energieziel', hash: hashForRoute(energiezielRoute(id)) };
    case 'messstelle.menge':
    case 'messstelle.beobachtung':
    case 'messstelle.monat_unvollstaendig':
      return { label: 'Zur Messstelle', hash: hashForRoute(messstelleRoute(id)) };
    default:
      return null;
  }
}

/** Die Einheit eines Alarms je Einheit (EZ-11): `einheit:<Steuerung>;te=<n>` → Steuerung und TE-Nr.; null sonst. */
export function einheitAusBezug(bezugKennung: string | null): { geraetId: string; teNr: number } | null {
  const m = bezugKennung ? /^einheit:([^;:]+);te=(\d+)$/.exec(bezugKennung) : null;
  return m ? { geraetId: m[1], teNr: Number(m[2]) } : null;
}

/**
 * „Zum Wechselrichter“ (GE-3): ein Alarm je Einheit führt auf die Seite DIESER Einheit (`as-<Entität>~te-<n>`). Die
 * Meldung nennt nur die Steuerung (Gerät) — die Entität kommt aus `…/anlagensteuerungen` der Anlage, die Box aus
 * derselben Regel wie überall (`boxRefOf`). Fehlt eines davon oder ist die Einheit nicht eingetragen: kein Weg.
 */
export function meldungEinheitLink(
  m: Meldung,
  steuerungen: readonly Anlagensteuerung[] | undefined,
  boxRef: string | null,
): { label: string; hash: string } | null {
  const bezug = einheitAusBezug(m.bezugKennung);
  if (!bezug || !m.anlageId || !boxRef) return null;
  const s = steuerungen?.find((x) => x.geraet_id === bezug.geraetId);
  const e = s?.einheiten.find((x) => x.te_nr === bezug.teNr);
  if (!s || !e) return null;
  const label = e.einheit_art === 'bhkw_motor' ? 'Zum Motor' : e.einheit_art === 'pv_wechselrichter' ? 'Zum Wechselrichter' : 'Zur Einheit';
  return { label, hash: geraetSeiteHash(m.anlageId, boxRef, einheitGeraetId(s.entity_id, bezug.teNr)) };
}

/** `?anlage=<id>` aus der rohen Adresse - die Seite liest ihre Filter selbst (kein Routen-Feld, §6.2). */
export function anlageAusHash(hash: string): string | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  return new URLSearchParams(hash.slice(frage + 1)).get('anlage');
}

/**
 * `?reiter=verlauf` aus der rohen Adresse (Alerting Scheibe 5, Entscheid 14A): das Energiemanagement-
 * Verzeichnis zeigt EINE Zeile, die direkt auf den Verlauf des Meldungs-Centers zeigt
 * (`#/meldungen?reiter=verlauf`) - derselbe Filter-Weg wie `anlageAusHash`, kein Routen-Feld.
 */
export function reiterAusHash(hash: string): 'jetzt' | 'verlauf' | 'einstellen' | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  const wert = new URLSearchParams(hash.slice(frage + 1)).get('reiter');
  // Kunden-Alarmierung P3: „Überwachungen“ (`regeln`) ging in „Einstellen“ auf - alte Links landen dort.
  if (wert === 'regeln' || wert === 'einstellen') return 'einstellen';
  return wert === 'jetzt' || wert === 'verlauf' ? wert : null;
}

/** Der Weg zu „Meldungen › Einstellen“ (Kunden-Alarmierung P3, KA-6 A: hinter der Glocke liegt alles). */
export const MELDUNGEN_EINSTELLEN_HASH = '#/meldungen?reiter=einstellen';

/**
 * „Leise“ (Kunden-Alarmierung P3, KA-4 B): ein Hinweis steht unter „Leise“, nicht als Karte, und zählt nicht in der
 * Glocke - die Zahl an der Glocke heißt dann immer: Da ist etwas.
 */
export function istLeise(m: Meldung): boolean {
  return m.schwere === 'hinweis';
}

/** Dauer zwischen zwei Zeitpunkten in Kundenwörtern: „42 Min.“, „3 Std. 5 Min.“, „2 Tage 4 Std.“. */
export function dauerText(vonIso: string, bisIso: string): string {
  const minuten = Math.max(0, Math.round((Date.parse(bisIso) - Date.parse(vonIso)) / 60000));
  if (minuten < 1) return 'unter 1 Min.';
  if (minuten < 60) return `${minuten} Min.`;
  const stunden = Math.floor(minuten / 60);
  if (stunden < 24) {
    const rest = minuten % 60;
    return rest ? `${stunden} Std. ${rest} Min.` : `${stunden} Std.`;
  }
  const tage = Math.floor(stunden / 24);
  const restStd = stunden % 24;
  return `${tage} ${tage === 1 ? 'Tag' : 'Tage'}${restStd ? ` ${restStd} Std.` : ''}`;
}

/**
 * Die Meldungsarten in Kundenwörtern (Kunden-Alarmierung §6.3): eine Regel ab Werk heißt nach dem, was sie meldet,
 * nicht nach ihrem Wert („Box meldet sich nicht“ statt „Box erreichbar“). Eine eigene Regel trägt ihren Namen
 * oder den Satznamen ihres Werts.
 */
export const MELDUNGSART_WORT: Record<string, string> = {
  'box.erreichbar': 'Box meldet sich nicht',
  'datenquelle.liefert_daten': 'Gerät liefert keine Daten',
  'ladepunkt.wallbox_meldet_sich_nicht': 'Wallbox meldet sich nicht',
  'ladepunkt.ziel_wird_knapp': 'Ladeziel wird knapp',
  'ladepunkt.ladung_fertig': 'Auto fertig geladen',
  'anlage.preis.jetzt': 'Strom gerade günstig',
  'anlage.netz.lastspitze_laufend': 'Lastspitze droht',
};

/** Reihenfolge der Meldungsarten in „Das melden wir“ (§6.3); eigene Überwachungen stehen dahinter. */
const MELDUNGSART_RANG = Object.keys(MELDUNGSART_WORT);

/** Der Name einer Regel in „Das melden wir“. */
export function regelName(r: UeberwachungsRegel): string {
  if (r.herkunft === 'ab_werk' && MELDUNGSART_WORT[r.wertart]) return MELDUNGSART_WORT[r.wertart];
  return r.name ?? MELDUNGSART_WORT[r.wertart] ?? wertartSatzname(r.wertart);
}

/** Die Anlage einer Regel aus ihrem rohen Bezug (`{"anlage":"<id>"}`); `null` bei einer Auswahl oder ohne Anlage. */
export function regelAnlage(r: UeberwachungsRegel): string | null {
  if (!r.bezugJson) return null;
  try {
    const b = JSON.parse(r.bezugJson) as { anlage?: string };
    return typeof b.anlage === 'string' ? b.anlage : null;
  } catch {
    return null;
  }
}

/** Ab Werk zuerst in der Reihenfolge der Meldungsarten, dann eigene nach Namen. */
export function sortiereRegeln(regeln: readonly UeberwachungsRegel[]): UeberwachungsRegel[] {
  const rang = (r: UeberwachungsRegel) => {
    const i = MELDUNGSART_RANG.indexOf(r.wertart);
    return r.herkunft === 'ab_werk' ? (i < 0 ? MELDUNGSART_RANG.length : i) : MELDUNGSART_RANG.length + 1;
  };
  return [...regeln].sort((a, b) => rang(a) - rang(b) || regelName(a).localeCompare(regelName(b), 'de'));
}

/** Minuten in Kundenwörtern: „sofort“, „15 Minuten“, „1 Stunde“, „2 Stunden“. */
export function minutenText(minuten: number): string {
  if (minuten <= 0) return 'sofort';
  if (minuten % 60 === 0) {
    const h = minuten / 60;
    return h === 1 ? '1 Stunde' : `${h} Stunden`;
  }
  return minuten === 1 ? '1 Minute' : `${minuten} Minuten`;
}

/** „Meldet nach“ einer Regel (§6.3): die Wartezeit ihrer Bedingung (`dauer_s`), sonst `null`. */
export function wartezeitText(r: UeberwachungsRegel): string | null {
  const dauer = r.bedingung && typeof r.bedingung.dauer_s === 'number' ? r.bedingung.dauer_s : null;
  if (dauer == null) return null;
  const minuten = Math.round(dauer / 60);
  return minuten <= 0 ? 'meldet sofort' : `nach ${minutenText(minuten)}`;
}

/** Rollen als Empfänger in der Mehrzahl (KA-5: „an Administratoren, Energiemanager und Zuständige am Standort“). */
const ROLLE_MEHRZAHL: Record<string, string> = {
  kundenadministrator: 'Kundenadministratoren',
  energiemanager: 'Energiemanager',
  bearbeiter: 'Bearbeiter am Standort',
  bedienberechtigt: 'Bedienberechtigte am Standort',
  leser: 'Leser am Standort',
  einsicht: 'Einsicht',
};

/** Die Empfänger einer Regel in einem Satz; die eigene Person (am Anzeigenamen erkannt) heißt „Sie“. */
export function empfaengerText(r: UeberwachungsRegel, ichName: string | null): string | null {
  const liste = r.empfaenger ?? [];
  if (liste.length === 0) return null;
  const namen = liste.map((e) =>
    e.person
      ? e.name != null && e.name === ichName
        ? 'Sie'
        : (e.name ?? 'eine Person')
      : (ROLLE_MEHRZAHL[e.rolle ?? ''] ?? e.rolle ?? ''),
  );
  if (namen.length === 1) return namen[0] === 'Sie' ? 'an Sie' : `an ${namen[0]}`;
  return `an ${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * `?meldung=<Kennzeichen oder Kennung>` aus der rohen Adresse (Kunden-Alarmierung P1): der Link „Ansehen“ einer Mail
 * und ein Tipp auf den Push führen zu DIESER Meldung - die Seite hebt sie hervor und zeigt sie zuerst.
 */
export function meldungAusHash(hash: string): string | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  return new URLSearchParams(hash.slice(frage + 1)).get('meldung');
}

/** Ob eine Meldung die aus der Adresse ist (Kennzeichen aus der Mail, Kennung aus dem Push). */
export function istGemeinteMeldung(m: Meldung, gemeint: string | null): boolean {
  return gemeint !== null && (m.kennzeichen === gemeint || m.id === gemeint);
}
