/**
 * DER KERN aller Geräteseiten (Konzept „Geräteseiten: Ein Blick, eine Antwort",
 * 25.09.2026; freigegeben mit Streichliste S1–S7, V1–V9, K1–K4 und E1–E5 = a).
 *
 * **Der behobene Befund war die Sortierung.** Die Seite stand als technisches
 * Inventar da: neun gleich laute Abschnitte (Jetzt · Befehle · Steuerung &
 * Grenzen · Komponenten · Register · Verbindung · Software · Diagnose ·
 * Plattform), eine eigene Sprungleiste, der erste Messwert am Telefon erst bei
 * 550–641 px und die erste Handlung unter dem ersten Bildschirm.
 *
 * Neu beantwortet jede Geräteseite im ersten Bildschirm drei Fragen - ist alles
 * in Ordnung, was tut das Gerät, was kann ich tun - und zwar mit denselben
 * FÜNF Bausteinen in derselben Reihenfolge:
 *
 * | Baustein | Frage |
 * |---|---|
 * | Jetzt (Bühne) | Was tut das Gerät gerade? Die eine große Zahl, ein Satz, eine Grafik. |
 * | Steuerung | Wer entscheidet gerade, und was kann ich selbst tun? |
 * | Heute | Wie verlief die Hauptgröße heute? |
 * | Aktivität | Was hat VoltPilot zuletzt geschickt - und kam es an? |
 * | Gerät & Verbindung | Modell, Anbindung, Grenzen, was es misst. |
 *
 * Dazu „Technik & Diagnose" als EIGENE Unteransicht (E1 a, `?ansicht=technik`)
 * für Register, Summenwerte, Fassungen, Rohdaten und die Plattform-Sicht.
 *
 * Fehlt einem Typ ein Baustein (ein Zähler hat keine Knöpfe), fällt er STILL
 * weg - es gibt keinen Kasten mehr, der erklärt, dass er leer ist (S5).
 *
 * Diese Datei ist rein und framework-frei (der `geraetSeite.ts`-Präzedenzfall);
 * `components/GeraetRahmen.tsx` rendert sie und entscheidet nichts.
 *
 * ⚠ **Sie formuliert KEINEN Befund neu.** Jeder Satz, der hier durchläuft
 * (Kopf-Hinweis), kommt von seiner geteilten Ableitung - `exportGuardView`,
 * `deviceLimitLine`, `controlStrip`. Zwei Formulierungen über denselben Befund
 * wären zwei Urteile.
 */

/** Ein Baustein der Hauptansicht. Die Reihenfolge ist FEST. */
export type BausteinId = 'buehne' | 'steuerung' | 'heute' | 'aktivitaet' | 'details';

/** Die kanonische Ordnung - am Telefon genau so untereinander. */
export const BAUSTEIN_ORDNUNG: readonly BausteinId[] = [
  'buehne',
  'steuerung',
  'heute',
  'aktivitaet',
  'details',
];

/** Der Name eines Bausteins - auf JEDER Geräteseite derselbe. */
export const BAUSTEIN_TITEL: Record<BausteinId, string> = {
  buehne: 'Jetzt',
  steuerung: 'Steuerung',
  heute: 'Heute',
  aktivitaet: 'Aktivität',
  details: 'Gerät & Verbindung',
};

/** Ein Teil der Unteransicht „Technik & Diagnose". */
export type TechnikId = 'register' | 'ocpp' | 'auswertung' | 'einrichtung' | 'rohdaten' | 'plattform';

export const TECHNIK_ORDNUNG: readonly TechnikId[] = [
  'register',
  'ocpp',
  'auswertung',
  'einrichtung',
  'rohdaten',
  'plattform',
];

export const TECHNIK_TITEL: Record<TechnikId, string> = {
  register: 'Register',
  ocpp: 'OCPP',
  auswertung: 'Auswertung',
  einrichtung: 'Einrichtung',
  rohdaten: 'Rohdaten',
  plattform: 'Plattform-Sicht (Admin)',
};

/** Der Name der Unteransicht - im Menü „⋯" und als ihr Titel. */
export const TECHNIK_ANSICHT_TITEL = 'Technik & Diagnose';

/**
 * Die Bausteine EINER Seite: kanonisch geordnet, doppelt Genanntes einmal,
 * Leeres (`null`/`false`) still weg.
 *
 * ⚠ Die Ordnung gehört dem Kern, nicht dem Aufrufer - sonst stünde dasselbe
 * Fach auf zwei Geräten an zwei Orten.
 */
export function bausteine(
  angebote: readonly (BausteinId | null | false | undefined)[],
): BausteinId[] {
  const da = new Set(angebote.filter((a): a is BausteinId => Boolean(a)));
  return BAUSTEIN_ORDNUNG.filter((id) => da.has(id));
}

/** Dieselbe Regel für die Teile der Technik-Ansicht. */
export function technikTeile(
  angebote: readonly (TechnikId | null | false | undefined)[],
): TechnikId[] {
  const da = new Set(angebote.filter((a): a is TechnikId => Boolean(a)));
  return TECHNIK_ORDNUNG.filter((id) => da.has(id));
}

// ---------------------------------------------------------------------------
// Adressen: `?ansicht=technik`, `?abschnitt=…`, `?kachel=…`
// ---------------------------------------------------------------------------

/**
 * Wohin eine Adresse springt: ein Baustein der Hauptansicht oder ein Teil der
 * Technik-Ansicht (`teil: null` = ihr Anfang).
 */
export type Ziel =
  | { ansicht: 'geraet'; baustein: BausteinId }
  | { ansicht: 'technik'; teil: TechnikId | null };

/**
 * Die Abschnitte des früheren Rahmens. Ihre Adressen sind Lesezeichen und
 * bleiben gültig: jeder alte Abschnitt landet dort, wo sein Inhalt heute
 * wohnt (`?abschnitt=register` öffnet die Technik-Ansicht, E1 a).
 */
export type AlterAbschnitt =
  | 'jetzt'
  | 'befehle'
  | 'steuerung'
  | 'komponenten'
  | 'register'
  | 'verbindung'
  | 'software'
  | 'diagnose'
  | 'plattform';

export const ALTER_ABSCHNITT: Record<AlterAbschnitt, Ziel> = {
  jetzt: { ansicht: 'geraet', baustein: 'buehne' },
  befehle: { ansicht: 'geraet', baustein: 'aktivitaet' },
  steuerung: { ansicht: 'geraet', baustein: 'steuerung' },
  komponenten: { ansicht: 'geraet', baustein: 'details' },
  register: { ansicht: 'technik', teil: 'register' },
  verbindung: { ansicht: 'geraet', baustein: 'details' },
  software: { ansicht: 'geraet', baustein: 'details' },
  diagnose: { ansicht: 'technik', teil: 'rohdaten' },
  plattform: { ansicht: 'technik', teil: 'plattform' },
};

/**
 * Die Parameternamen. ⚠ Es sind PARAMETER im Hash, keine zweite Raute: die App
 * ist hash-geroutet, `#/anlage/…#register` wäre keine gültige Route (das
 * `settingsNav`-Muster; `parseRoute` schneidet den Query-Teil ohnehin ab).
 */
const ABSCHNITT = 'abschnitt';
const ANSICHT = 'ansicht';
const KACHEL = 'kachel';

function params(hash: string): URLSearchParams {
  const q = hash.indexOf('?');
  return new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
}

function istBaustein(v: string): v is BausteinId {
  return (BAUSTEIN_ORDNUNG as readonly string[]).includes(v);
}

function istTechnikTeil(v: string): v is TechnikId {
  return (TECHNIK_ORDNUNG as readonly string[]).includes(v);
}

function istAlterAbschnitt(v: string): v is AlterAbschnitt {
  return Object.prototype.hasOwnProperty.call(ALTER_ABSCHNITT, v);
}

/**
 * Das Ziel einer Adresse, oder null.
 *
 * ⚠ **Nie raten**: ein unbekanntes Wort öffnet nichts, statt irgendeinen
 * Baustein anzuspringen. Und `?ansicht=technik` gewinnt - ein Baustein der
 * Hauptansicht, der daneben steht, wäre dort nicht zu sehen.
 */
export function sprungZiel(hash: string): Ziel | null {
  const p = params(hash);
  const abschnitt = (p.get(ABSCHNITT) ?? '').trim();
  const technik = p.get(ANSICHT) === 'technik';
  if (technik) {
    if (istTechnikTeil(abschnitt)) return { ansicht: 'technik', teil: abschnitt };
    const alt = istAlterAbschnitt(abschnitt) ? ALTER_ABSCHNITT[abschnitt] : null;
    return { ansicht: 'technik', teil: alt?.ansicht === 'technik' ? alt.teil : null };
  }
  if (!abschnitt) return null;
  if (istBaustein(abschnitt)) return { ansicht: 'geraet', baustein: abschnitt };
  if (istTechnikTeil(abschnitt)) return { ansicht: 'technik', teil: abschnitt };
  if (istAlterAbschnitt(abschnitt)) return ALTER_ABSCHNITT[abschnitt];
  return null;
}

/** Steht die Adresse in der Technik-Ansicht? */
export function istTechnikAnsicht(hash: string): boolean {
  return sprungZiel(hash)?.ansicht === 'technik';
}

/**
 * Eine Geräte-Adresse mit Ziel (und optional Kachel). Der übrige Query-Teil
 * bleibt erhalten; `ansicht`/`abschnitt` werden ersetzt, `kachel` nur, wenn
 * sie genannt ist (`null` entfernt sie).
 */
export function zielHash(basisHash: string, ziel: Ziel | null, kachel?: string | null): string {
  const q = basisHash.indexOf('?');
  const basis = q < 0 ? basisHash : basisHash.slice(0, q);
  const p = params(basisHash);
  p.delete(ANSICHT);
  p.delete(ABSCHNITT);
  if (ziel?.ansicht === 'technik') {
    p.set(ANSICHT, 'technik');
    if (ziel.teil) p.set(ABSCHNITT, ziel.teil);
  } else if (ziel) {
    p.set(ABSCHNITT, ziel.baustein);
  }
  if (kachel) p.set(KACHEL, kachel);
  else if (kachel === null) p.delete(KACHEL);
  const rest = p.toString();
  return rest ? `${basis}?${rest}` : basis;
}

/** Die Adresse der Technik-Ansicht dieses Geräts (optional mit Teil). */
export function technikHash(basisHash: string, teil: TechnikId | null = null): string {
  return zielHash(basisHash, { ansicht: 'technik', teil });
}

/** Zurück aus der Technik-Ansicht - alle übrigen Parameter reisen mit. */
export function ohneTechnikHash(basisHash: string): string {
  return zielHash(basisHash, null);
}

/**
 * Eine Geräte-Adresse mit gezieltem Baustein und optional gezielter Kachel -
 * der Einstieg aus dem Anlagen-Modell (`?abschnitt=buehne&kachel=speicher`).
 */
export function abschnittHash(
  basisHash: string,
  id: BausteinId | null,
  kachel?: string | null,
): string {
  return zielHash(basisHash, id ? { ansicht: 'geraet', baustein: id } : null, kachel);
}

/**
 * Die angesprungene KACHEL aus einem Hash - null, wenn keine genannt ist.
 *
 * ⚠ Die Batterie hat KEINE eigene Seite - ihr Gesicht ist der Speicher-Teil des
 * Hybrid-Blatts, und ihre Komponenten-Karte im Anlagen-Modell führt deshalb auf
 * die Hybrid-Seite mit `?abschnitt=buehne&kachel=speicher`. Der Schlüssel ist
 * der stabile `HeldKachel.key`, NIE das Label: der Kunde darf eine Komponente
 * umbenennen, die Adresse darf davon nicht abhängen.
 */
export function parseKachel(hash: string): string | null {
  const value = params(hash).get(KACHEL);
  return value && value.trim() ? value.trim() : null;
}

/** Die DOM-Kennung eines Bausteins oder Technik-Teils - der Sprungpunkt. */
export function ankerId(id: BausteinId | TechnikId): string {
  return `geraet-baustein-${id}`;
}

// ---------------------------------------------------------------------------
// Der Kopf-Hinweis (Frage 1: „ist alles in Ordnung?")
// ---------------------------------------------------------------------------

/**
 * Die Art eines Befunds. Die Reihenfolge dieser Liste IST die Rangfolge -
 * der schlimmste gewinnt, und es wird immer nur EINER gezeigt.
 */
export type BefundArt = 'verbindung' | 'ruecklesen' | 'waechter' | 'grenze';

const BEFUND_RANG: readonly BefundArt[] = ['verbindung', 'ruecklesen', 'waechter', 'grenze'];

/** Wo ein Befund seine Erklärung hat. */
const BEFUND_ZIEL: Record<BefundArt, Ziel> = {
  verbindung: { ansicht: 'geraet', baustein: 'details' },
  ruecklesen: { ansicht: 'geraet', baustein: 'aktivitaet' },
  waechter: { ansicht: 'geraet', baustein: 'details' },
  grenze: { ansicht: 'technik', teil: 'register' },
};

export interface Befund {
  art: BefundArt;
  /**
   * Der Satz - WÖRTLICH aus seiner geteilten Ableitung. Der Kern formuliert
   * keinen; ein leerer Satz ist kein Befund.
   */
  satz: string;
  ton: 'warn' | 'off';
}

export interface KopfHinweis {
  satz: string;
  ton: 'warn' | 'off';
  art: BefundArt;
  /**
   * Wo der Befund erklärt wird - ein Klick springt hin. `null`, wenn diese
   * Seite den Ort gar nicht hat: dann steht der Satz allein da, statt einen
   * Knopf ins Leere anzubieten (die `registerZugang`-Regel).
   */
  ziel: Ziel | null;
}

/**
 * Der EINE Hinweis im Kopf - der schlimmste anstehende Befund, oder nichts.
 *
 * ⚠ Der Live-Punkt steht eine Zeile darüber und beantwortet schon „läuft es,
 * wie frisch ist das?". Ihn hier zu wiederholen wäre Lärm - der Hinweis ist für
 * Befunde da, die sonst erst weiter unten stünden.
 *
 * @param befunde in beliebiger Reihenfolge; der Rang entscheidet, nicht die Position.
 * @param angeboten was es auf DIESER Seite gibt.
 */
export function kopfHinweis(
  befunde: readonly (Befund | null | undefined)[],
  angeboten: { bausteine: readonly BausteinId[]; technik: readonly TechnikId[] } = {
    bausteine: BAUSTEIN_ORDNUNG,
    technik: TECHNIK_ORDNUNG,
  },
): KopfHinweis | null {
  let beste: Befund | null = null;
  for (const b of befunde) {
    if (!b || !(b.satz ?? '').trim() || !BEFUND_RANG.includes(b.art)) continue;
    if (beste == null || BEFUND_RANG.indexOf(b.art) < BEFUND_RANG.indexOf(beste.art)) beste = b;
  }
  if (!beste) return null;
  const ziel = BEFUND_ZIEL[beste.art];
  const da = ziel.ansicht === 'geraet'
    ? angeboten.bausteine.includes(ziel.baustein)
    : ziel.teil != null && angeboten.technik.includes(ziel.teil);
  return { satz: beste.satz.trim(), ton: beste.ton, art: beste.art, ziel: da ? ziel : null };
}

/** Die Beschriftung des Sprungs zu einem Ziel („Aktivität ansehen"). */
export function zielTitel(ziel: Ziel): string {
  return ziel.ansicht === 'geraet'
    ? BAUSTEIN_TITEL[ziel.baustein]
    : ziel.teil
      ? TECHNIK_TITEL[ziel.teil]
      : TECHNIK_ANSICHT_TITEL;
}
