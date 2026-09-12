// Das ÄNDERUNGSPROTOKOLL als Fläche (UEMS AP-04 IP-21) — die reine Schicht.
//
// Sie ist die EINE Wahrheit darüber, **wie eine Protokoll-Zeile in Kundensprache
// lautet**: was geändert wurde, wann es gilt, wann es eingetragen wurde, wer es
// war und ob es rückwirkend oder angekündigt war. `components/ProtokollListe.tsx`
// rendert sie und entscheidet nichts.
//
// ⚠ **Sie formuliert das WAS nicht neu.** Der Satz „Zähler gewechselt: Z-5a →
// Z-5b" kommt als `text` vom Server (`AenderungSatz`), weil dort die Fakten
// `alt`/`neu` liegen; zwei Formulierungen über denselben Vorgang wären zwei
// Wahrheiten. Diese Datei setzt nur die ZEITEN, den URHEBER und die ZEITFORM
// daneben — und tut es nach dem Muster des Befehls-Verlaufs (`befehleVerlauf.ts`):
// jüngste Zeile oben, Datumszeile bei jedem Tageswechsel.
//
// ⚠ **ZWEI ZEITACHSEN.** Ein Eintrag gilt zu einem Zeitpunkt und wurde zu einem
// anderen eingetragen. Der rückwirkende Zählerwechsel gilt am 18.11. um 10:40
// und wurde um 11:05 eingetragen. Welche Achse gruppiert und filtert, sagt der
// Server in seiner Antwort (`achse`); diese Datei liest sie von dort, statt sie
// zu raten — sonst stünde eine Zeile unter dem falschen Tag.
import type { Protokoll, ProtokollEintrag, UemsGeraet } from './api';

/** Die Plattform-Zeitzone — dieselbe, in der der Server seine Zeitpunkte ausweist. */
const ZONE = 'Europe/Berlin';

/** Wie viele Zeilen eine Seite trägt (die Vorgabe des Servers ist 100). */
export const SEITE = 25;

/**
 * Die ZEITFORM als Kundenwort — das Abzeichen neben der Zeile.
 *
 * „sofort" bekommt KEINS: der Normalfall braucht kein Etikett, und ein Abzeichen
 * an jeder Zeile wäre keins mehr.
 */
export const ZEITFORM_LABEL: Record<ProtokollEintrag['zeitform'], string | null> = {
  rueckwirkend: 'rückwirkend',
  angekuendigt: 'angekündigt',
  sofort: null,
};

/**
 * Die ROLLE als Kundenwort (die Kennungen des Rechte-Vertrags). Eine Rolle, die
 * das Journal nicht festhält, ist `null` — dann steht nur der Name da, nie eine
 * geratene Rolle.
 */
export const ROLLE_LABEL: Record<string, string> = {
  kundenadministrator: 'Kundenadministrator',
  energiemanager: 'Energiemanager',
  bearbeiter: 'Bearbeiter',
  bedienberechtigt: 'Bedienberechtigt',
  leser: 'Leser',
  unterstuetzer: 'Unterstützer',
  voltpilot_betrieb: 'VoltPilot',
};

/** Eine fertige Zeile — jedes Feld ist entweder ein Fakt oder `null`. */
export interface ProtokollZeile {
  key: string;
  /** Der Satz „was wurde geändert" — wörtlich vom Server. */
  satz: string;
  /** Die Uhrzeit auf der Achse, nach der gruppiert wird („10:40"). */
  zeit: string;
  /** „gilt ab 18.11.2026, 10:40 Uhr" — immer beide Zeitpunkte, nie nur einer. */
  giltAb: string;
  /** „eingetragen am 18.11.2026, 11:05 Uhr". */
  eingetragen: string;
  /** „rückwirkend" · „angekündigt" · null. */
  marke: string | null;
  /** „Ines Kaltenbach · Kundenadministrator" — ohne festgehaltene Rolle nur der Name. */
  urheber: string;
  /** Die Begründung, die der Schreiber mitgegeben hat; null = keine. */
  grund: string | null;
  /** „MS-06 · Hauptzähler Werk" — null im Protokoll genau dieses Objekts. */
  bezug: string | null;
  /** Der Berliner Kalendertag der gruppierenden Achse (`YYYY-MM-DD`), oder null. */
  tag: string | null;
}

/** Ein Eintrag der Liste: eine Datumszeile ODER eine Protokoll-Zeile. */
export type ProtokollListenEintrag =
  | { art: 'tag'; key: string; text: string }
  | { art: 'zeile'; key: string; zeile: ProtokollZeile };

export interface ProtokollView {
  eintraege: ProtokollListenEintrag[];
  /** Wie viele PROTOKOLL-Zeilen darin stehen (ohne die Datumszeilen). */
  zeilen: number;
  /** Welche Achse gruppiert und filtert — vom Server, nie geraten. */
  achse: Protokoll['achse'];
  /** Der Satz über der Liste, der die Achse nennt. */
  achseSatz: string;
  /** Der Satz einer LEEREN Liste; null, sobald eine Zeile da ist. */
  leer: string | null;
  /** Ob „Ältere laden" etwas bewirken kann — nie ein Knopf ins Leere. */
  mehrMoeglich: boolean;
  /** Der Fortsetzungszeiger der nächsten Seite, oder null. */
  weiter: string | null;
}

/**
 * Der Verlauf: **jüngste Zeile oben**, mit einer Datumszeile bei jedem
 * Tageswechsel — gruppiert nach der Achse, die der Server genannt hat.
 *
 * @param seiten die geladenen Seiten, JÜNGSTE zuerst
 * @param now die Bezugszeit — sie entscheidet nur, wie „Heute"/„Gestern" heißen
 * @param opts.mitBezug ob jede Zeile ihr Objekt nennt (der Unternehmens-Weg
 *   mischt Messstellen, Orte und Datenquellen; im Protokoll EINES Objekts wäre
 *   dieselbe Angabe an jeder Zeile Rauschen)
 */
export function protokollListe(
  seiten: readonly (Protokoll | null | undefined)[],
  now: number,
  opts: { mitBezug?: boolean } = {},
): ProtokollView {
  const echte = seiten.filter((p): p is Protokoll => Boolean(p));
  const juengste = echte[0] ?? null;
  const aelteste = echte[echte.length - 1] ?? null;
  const achse: Protokoll['achse'] = juengste?.achse ?? 'wirkung';

  const gesehen = new Set<string>();
  const zeilen: ProtokollZeile[] = [];
  for (const seite of echte) {
    for (const e of seite.eintraege) {
      // Eine doppelt gelieferte Grenzzeile gewinnt genau EINMAL — gemischt wird
      // über die `id`, die Herkunft und laufende Nummer zusammen trägt.
      if (gesehen.has(e.id)) continue;
      gesehen.add(e.id);
      zeilen.push(zeile(e, achse, opts.mitBezug === true));
    }
  }

  const eintraege: ProtokollListenEintrag[] = [];
  let letzterTag: string | null | undefined;
  for (const z of zeilen) {
    if (letzterTag === undefined || z.tag !== letzterTag) {
      letzterTag = z.tag;
      eintraege.push({ art: 'tag', key: `tag:${z.tag ?? 'unbekannt'}`, text: tagText(z.tag, now) });
    }
    eintraege.push({ art: 'zeile', key: `z:${z.key}`, zeile: z });
  }

  const weiter = aelteste?.weiter ?? null;
  return {
    eintraege,
    zeilen: zeilen.length,
    achse,
    achseSatz: achseSatz(achse),
    leer: juengste && zeilen.length === 0 ? 'Hier wurde noch nichts geändert.' : null,
    mehrMoeglich: Boolean(weiter),
    weiter,
  };
}

/** Der Satz über der Liste — er sagt, WELCHE der zwei Zeiten die Reihenfolge macht. */
export function achseSatz(achse: Protokoll['achse']): string {
  return achse === 'eintrag'
    ? 'Sortiert danach, wann die Änderung eingetragen wurde.'
    : 'Sortiert danach, ab wann die Änderung gilt.';
}

/** Eine einzelne Zeile — die Einheit, die der Wortlaut-Test prüft. */
export function zeile(
  e: ProtokollEintrag,
  achse: Protokoll['achse'],
  mitBezug: boolean,
): ProtokollZeile {
  const massgeblich = achse === 'eintrag' ? e.eingetragen_am : e.gilt_ab;
  return {
    key: e.id,
    satz: e.text,
    zeit: uhrzeit(massgeblich),
    giltAb: `gilt ab ${zeitpunktText(e.gilt_ab)}`,
    eingetragen: `eingetragen am ${zeitpunktText(e.eingetragen_am)}`,
    marke: ZEITFORM_LABEL[e.zeitform] ?? null,
    urheber: urheberText(e),
    grund: e.grund && e.grund.trim() ? e.grund.trim() : null,
    bezug: mitBezug ? bezugText(e) : null,
    tag: berlinTag(massgeblich),
  };
}

/**
 * „Ines Kaltenbach · Kundenadministrator" — und ohne festgehaltene Rolle nur der
 * Name. Eine Rolle, die das Journal nicht kennt, wird nicht erfunden (die
 * Orts-Einträge tragen sie bis heute nicht).
 */
export function urheberText(e: ProtokollEintrag): string {
  const name = e.urheber?.name?.trim();
  if (!name) return 'Urheber nicht festgehalten';
  const rolle = e.urheber.rolle ? ROLLE_LABEL[e.urheber.rolle] : null;
  return rolle ? `${name} · ${rolle}` : name;
}

/** „MS-06 · Hauptzähler Werk" — was von beidem da ist; null, wenn nichts da ist. */
export function bezugText(e: ProtokollEintrag): string | null {
  const teile = [e.bezug?.kennzeichen, e.bezug?.name].filter(
    (t): t is string => Boolean(t && t.trim()),
  );
  return teile.length ? teile.join(' · ') : null;
}

/** „18.11.2026, 10:40 Uhr" in der Plattform-Zeitzone. */
export function zeitpunktText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Zeitpunkt unbekannt';
  const tag = d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: ZONE,
  });
  return `${tag}, ${uhrzeit(iso)} Uhr`;
}

/** „10:40" in der Plattform-Zeitzone; ein unlesbarer Zeitpunkt sagt das. */
export function uhrzeit(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: ZONE });
}

/** Der Berliner Kalendertag eines Zeitpunkts (`YYYY-MM-DD`), oder null. */
export function berlinTag(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: ZONE });
}

/**
 * Die Überschrift einer Tagesgruppe: „Heute" · „Gestern" · „Mittwoch, 18.
 * November 2026" — dieselbe Regel wie im Befehls-Verlauf.
 *
 * ⚠ Ein Zeitpunkt ohne lesbaren Tag bekommt seine EIGENE Gruppe mit dem
 * ehrlichen Wort — ihn der Gruppe darüber zuzuschlagen wäre eine erfundene
 * Datierung.
 */
export function tagText(tag: string | null, now: number): string {
  if (!tag) return 'Zeitpunkt unbekannt';
  const heute = new Date(now).toLocaleDateString('sv-SE', { timeZone: ZONE });
  if (tag === heute) return 'Heute';
  if (tag === minusTag(heute)) return 'Gestern';
  return new Date(`${tag}T12:00:00Z`).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Der Vortag eines `YYYY-MM-DD` — reine Arithmetik, keine Zone. */
function minusTag(tagIso: string): string {
  const d = new Date(`${tagIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Der Weg von der Komponente zum GERÄT
// ---------------------------------------------------------------------------

/**
 * Welches UEMS-Gerät speist diese Komponenten? — der Weg, den die Geräteseite
 * braucht: sie kennt ihre Komponenten, das Protokoll hängt am Gerät.
 *
 * ⚠ Gewählt wird der EINGEBAUTE Einbau (`ausgebaut_am === null`) mit einer
 * LAUFENDEN Speisung (`gueltig_bis === null`) auf eine der Komponenten. Passt
 * keiner, ist die Antwort `null` — dann zeigt die Fläche gar nichts, statt das
 * Protokoll eines fremden Geräts zu zeigen. Speisen mehrere Geräte dieselben
 * Komponenten (ein Controller mit Karten), gewinnt das erste in der Reihenfolge
 * des Servers; die Fläche nennt das Gerät, damit sichtbar bleibt, welches.
 */
export function geraetZuKomponenten(
  geraete: readonly UemsGeraet[] | null | undefined,
  entityIds: readonly string[],
): UemsGeraet | null {
  if (!geraete || entityIds.length === 0) return null;
  const gesucht = new Set(entityIds);
  for (const g of geraete) {
    if (g.ausgebaut_am) continue;
    if (g.komponenten.some((k) => k.gueltig_bis === null && gesucht.has(k.entity_id))) return g;
  }
  return null;
}
