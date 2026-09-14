/**
 * Die REINE Hälfte der Quellenliste des Summenwert-Assistenten (Konzept
 * vp-agg-konzept3-r8 §2.1): aus den Katalog-Registern EINES Geräts werden
 * gegliederte, durchsuchbare Zeilen mit ehrlichem Guard. Anders als der
 * `messkanaele`-Weg des `GesamtwertDialog` (nur die selektierten Kanäle) speist
 * sich diese Liste aus dem VOLLEN Register-Inventar - die beobachteten UND die
 * noch nicht aufgezeichneten -, genau wie die Register-Sektion der Geräteseite
 * (Home-Assistant-Helfer-Prinzip: jedes Register ist quellfähig).
 *
 * Der Guard bleibt der bestehende (`gesamtwert.ts` `summierbar`/`passt`) - hier
 * nur auf die breitere Liste angewandt und um den GRUND je Sperre verfeinert:
 * nicht summierbare Register erscheinen sichtbar, aber gesperrt mit Grund (andere
 * Messgröße · keine Vertrags-Größe · kein Zahlenwert), nie stumm weggelassen.
 *
 * Rein: kein DOM, kein Netz, keine Uhr (die Uhr kommt als Parameter). Das
 * Holen/Beobachten orchestriert `components/SummenwertAssistent.tsx`.
 */
import type { MeasurementCatalogPoint } from './api';
import { normalizeTerm } from './glossar';
import type { Quellwert } from './gesamtwert';
import { groesseAus, kategorieWort, richtungAus, wertartAus } from './registerAbbildung';

/** Der Guard-Zustand einer Register-Zeile - warum sie (nicht) in die Summe darf. */
export type SperrArt =
  /** Summierbar: passt (noch nichts gewählt oder gleiche Größe/Wertart wie der Anker). */
  | 'summierbar'
  /** Summierbar, aber ANDERE Größe/Wertart als der Anker (kW ≠ kWh) - gesperrt. */
  | 'andere_groesse'
  /** Ein Zahlenwert OHNE Vertrags-Größe (Spannung, Temperatur, Strom …) - gesperrt. */
  | 'keine_groesse'
  /** Kein Zahlenwert (Zustand, Text, Ereignis) - gesperrt. */
  | 'kein_zahlenwert';

/** Der Anker einer Summe: die Größe und Wertart, auf die sich alles Weitere festlegt. */
export interface Anker {
  groesse: string;
  wertart: string;
}

/** Eine Register-Zeile der Quellenliste - rein abgeleitet aus einem Katalog-Punkt. */
export interface RegisterZeile {
  /** Der Register-Schlüssel (Server-Bindung; nie Kundentext). */
  pointKey: string;
  /** Die Komponente, an die ein Term dieses Registers bindet. */
  entityId: string;
  /** Der Kunden-Name (Katalog-Anzeigename), nie ein rohes Kürzel. */
  name: string;
  /** Die Katalog-Gruppe (Batterie, Netz, PV …) - die Gliederung von „Alle Register". */
  gruppe: string;
  /** Die abgeleiteten Vertragswörter (`registerAbbildung`). */
  groesse: string | null;
  richtung: string | null;
  wertart: string | null;
  /** Trägt das Register überhaupt einen Zahlenwert? (`gauge`/`counter`, nicht Zustand/Text). */
  numerisch: boolean;
  einheit: string | null;
  /** Ist das Register beobachtet (aufgezeichnet)? Nur dann trägt es Live-Wert + Verlauf. */
  beobachtet: boolean;
  /** Der zuletzt gemessene Wert (nur beobachtet), sonst `null` - nie eine erfundene 0. */
  wert: number | null;
  /** Der Zeitpunkt dieses Werts (ISO), für die Frische - oder `null`. */
  stand: string | null;
  /** Die Kadenz-/Volumen-Eckwerte für die „+ Beobachten"-Kostenzeile. */
  standardKadenzS: number | null;
  langzeitKadenzS: number | null;
  jahresBytes: number;
  /** Summierbar = trägt Vertrags-Größe UND Wertart (der Guard aus `gesamtwert.ts`). */
  summierbar: boolean;
  /** Summierbar, aber ohne Katalog-Richtung (der Gen-Port) - nur hier der AP-08-Haken. */
  richtungslos: boolean;
  /** Das Anzeige-Kategoriewort der Unterzeile (Wirkleistung · Erzeugung / Spannung / Zustand). */
  kategorie: string | null;
}

/** Eine Register-Zeile aus einem Katalog-Punkt (rein). `entityId` ist die Komponente. */
export function zeileAus(
  point: MeasurementCatalogPoint,
  entityId: string,
): RegisterZeile {
  const groesse = groesseAus(point.quantity);
  const richtung = richtungAus(point.direction);
  const wertart = wertartAus(point.aggregationKind);
  const numerisch = point.aggregationKind === 'gauge' || point.aggregationKind === 'counter';
  const summierbar = !!groesse && !!wertart;
  const beobachtet = point.selected;
  const roh = beobachtet ? point.decodedValue : null;
  const zahl = roh == null || roh === '' ? NaN : Number(roh);
  const wert = beobachtet && Number.isFinite(zahl) ? zahl : null;
  const kategorie = groesse
    ? `${groesse} · ${richtung ?? 'richtungslos'}`
    : kategorieWort(point.quantity, point.aggregationKind);
  return {
    pointKey: point.pointKey,
    entityId,
    name: point.labelDe ?? point.labelSource ?? point.pointKey,
    gruppe: point.group,
    groesse,
    richtung,
    wertart,
    numerisch,
    einheit: point.unit,
    beobachtet,
    wert,
    stand: point.lastReadAt,
    standardKadenzS: point.selectedCadenceS ?? point.defaultCadenceS,
    langzeitKadenzS: point.longTermCadenceS,
    jahresBytes: point.estimatedDataPerYearBytes,
    summierbar,
    richtungslos: summierbar && richtung == null,
    kategorie,
  };
}

/** Der Anker aus den schon gewählten Quell-Werten (der erste summierbare), oder `null`. */
export function ankerAus(gewaehlt: Quellwert[]): Anker | null {
  const a = gewaehlt.find((q) => !!q.groesse && !!q.wertart);
  return a ? { groesse: a.groesse as string, wertart: a.wertart as string } : null;
}

/**
 * Der Guard-Zustand einer Zeile relativ zum Anker - dieselbe Logik wie
 * `gesamtwert.passt`, nur mit dem GRUND ausdifferenziert: nicht summierbar wird
 * getrennt nach „kein Zahlenwert" (keine Wertart) und „keine Vertrags-Größe"
 * (Zahlenwert, aber keine Größe); summierbar-aber-anders ist „andere Messgröße".
 */
export function sperrArt(zeile: RegisterZeile, anker: Anker | null): SperrArt {
  if (!zeile.summierbar) {
    // Ein nicht-numerisches Register (Zustand/Text/Ereignis) trägt gar keinen
    // Zahlenwert; ein numerisches ohne Vertrags-Größe (Spannung/Temperatur) schon.
    return zeile.numerisch ? 'keine_groesse' : 'kein_zahlenwert';
  }
  if (anker && (zeile.groesse !== anker.groesse || zeile.wertart !== anker.wertart)) {
    return 'andere_groesse';
  }
  return 'summierbar';
}

/** Darf die Zeile angehakt werden? (summierbar und passend zum Anker) */
export function anhakbar(zeile: RegisterZeile, anker: Anker | null): boolean {
  return sperrArt(zeile, anker) === 'summierbar';
}

/** Das KURZE Sperr-Wort am rechten Rand der Zeile (nie eine stumme Sperre). */
export function sperrKurz(art: SperrArt): string | null {
  switch (art) {
    case 'andere_groesse':
      return 'andere Messgröße';
    case 'keine_groesse':
      return 'keine Messgröße';
    case 'kein_zahlenwert':
      return 'kein Zahlenwert';
    default:
      return null;
  }
}

/** Der ausführliche, ehrliche Sperr-Grund (für Titel/Tooltip). */
export function sperrGrund(art: SperrArt): string | null {
  switch (art) {
    case 'andere_groesse':
      return 'Andere Messgröße - passt nicht in dieselbe Summe.';
    case 'keine_groesse':
      return 'Für diesen Wert steht keine Messgröße fest, die sich summieren lässt.';
    case 'kein_zahlenwert':
      return 'Dieses Register trägt keinen Zahlenwert, den man mitzählen kann.';
    default:
      return null;
  }
}

/**
 * Die Unterzeile einer Register-Zeile: die Kategorie plus - bei einem noch nicht
 * beobachteten summierbaren Register - der ehrliche Hinweis „noch nicht
 * beobachtet". Ein gesperrtes Register nennt zusätzlich seinen Kurz-Grund.
 */
export function unterzeile(zeile: RegisterZeile, anker: Anker | null): string {
  const art = sperrArt(zeile, anker);
  const teile: string[] = [];
  if (art === 'summierbar' && !zeile.beobachtet) teile.push('noch nicht beobachtet');
  if (zeile.kategorie) teile.push(zeile.kategorie);
  return teile.join(' · ');
}

/** Ein Quell-Wert (für `gesamtwert.termAus`) aus einer anhakbaren Zeile. */
export function zuQuellwert(zeile: RegisterZeile, geraet: string | null): Quellwert {
  return {
    entityId: zeile.entityId,
    channel: zeile.pointKey,
    name: zeile.name,
    geraet,
    groesse: zeile.groesse,
    richtung: zeile.richtung,
    einheit: zeile.einheit,
    wertart: zeile.wertart,
    wert: zeile.wert,
    stand: zeile.stand,
  };
}

/** Passt die Zeile zur Suche? (Name, Gruppe, Einheit, Register-Schlüssel) - normalisiert. */
export function suchePasst(zeile: RegisterZeile, query: string): boolean {
  const tokens = normalizeTerm(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = normalizeTerm(
    [zeile.name, zeile.gruppe, zeile.einheit ?? '', zeile.kategorie ?? '', zeile.pointKey].join(' '),
  );
  return tokens.every((t) => hay.includes(t));
}

/** Die zwei Gruppen der Quellenliste: beobachtete „Messwerte" oben, „Alle Register" darunter. */
export interface Gruppen {
  messwerte: RegisterZeile[];
  alle: RegisterZeile[];
}

/**
 * Teilt die Zeilen in die beobachteten „Messwerte" (mit Live-Wert + Frische) und
 * „Alle Register des Geräts" (alles Übrige). Ein beobachtetes Register steht NUR
 * oben, nicht doppelt. Die Suche filtert beide Gruppen gleich.
 */
export function gruppen(zeilen: RegisterZeile[], query = ''): Gruppen {
  const gefiltert = zeilen.filter((z) => suchePasst(z, query));
  return {
    messwerte: gefiltert.filter((z) => z.beobachtet),
    alle: gefiltert.filter((z) => !z.beobachtet),
  };
}
