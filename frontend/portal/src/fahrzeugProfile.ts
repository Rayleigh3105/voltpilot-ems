/**
 * FAHRZEUG-PROFILE (Verbrauchsmanagement v1 / P7, Konzept §4.5) — die reine
 * Schicht: Typen, Wörter und jede Ableitung. Die Flächen rendern NUR.
 *
 * ⚠ EIN FAHRZEUG IST EINE LADEKARTE, und ihr Schlüssel ist ein PSEUDONYM, das
 * die BOX gebildet hat. Der Klartext der Karte verlässt sie nie — das Portal
 * bekommt ihn gar nicht zu sehen, und es kann ihn auch nicht zurückrechnen.
 * Genau deshalb heißt eine unbenannte Karte hier „Karte 1f2e…" und nicht
 * „RFID 04A2B7": die vier Zeichen sind das, was den Kunden wiedererkennen
 * lässt, welche Zeile er gerade benennt.
 *
 * ⚠ EIN PROFIL TRÄGT EINE QUELLE UND NIE EIN ZIEL. Ein Ziel („bis 06:00
 * fertig") wird Stunden im Voraus für einen LADEPUNKT geplant, und welches Auto
 * dann dort steckt, weiß zum Planungszeitpunkt niemand. Der Dialog bietet
 * deshalb genau die zwei Quellen an, die die Quellen-Bahn der Box ausdrücken
 * kann — eine Wahl anzubieten, die der Server danach ablehnen müsste, wäre die
 * Sorte Zusage, die dieses Haus nicht macht (die `registerZugang`-Regel).
 *
 * ⚠ VORRANG: Handeingriff › Profil › Säule. Er entsteht auf der BOX durch die
 * Bauform (Boost und Halter greifen nach dem Profil), nicht durch eine Zusage
 * hier — die Fläche sagt ihn nur.
 */

import type { Steuerart } from './verbraucherZone';

// ---------------------------------------------------------------------------
// Die Form, in der die api liefert (`GET /sites/{id}/fahrzeuge`)
// ---------------------------------------------------------------------------

export interface Fahrzeug {
  /** Das Pseudonym der Box — nie ein Klartext-IdTag. */
  tagRef: string;
  /** Der Kundenname; `null` = gesehen, aber noch nicht benannt. */
  name?: string | null;
  /** `null` = kein Profil: die Karte fährt die Bahn ihrer Säule. */
  steuerart?: Steuerart | null;
  mindestleistungKw?: number | null;
  ersteSichtungAm?: string | null;
  letzteSichtungAm?: string | null;
  letzterLadepunkt?: string | null;
  /** Lädt gerade — aus dem Herzschlag, nie aus der Sichtungszeit geraten. */
  laedt?: boolean;
}

export interface SiteFahrzeuge {
  fahrzeuge: Fahrzeug[];
}

/** Der Rumpf des `PUT`. Jedes Feld EINZELN optional — siehe `wunschAus`. */
export interface FahrzeugWunsch {
  name?: string;
  /**
   * ⚠ DREI Zustände, die Haus-Regel jeder PATCH-Route: ABWESEND heißt „an der
   * Steuerart nichts ändern", ein Wort setzt sie, und die LEERE Zeichenkette
   * NIMMT SIE ZURÜCK (die Karte lädt wieder wie ihr Ladepunkt).
   */
  quelle?: FahrzeugQuelle | '';
  ueberschussModus?: 'pausieren' | 'mindestleistung';
  mindestleistungKw?: number;
}

/** Die zwei Quellen, die eine SITZUNG tragen kann. */
export type FahrzeugQuelle = 'sofort' | 'ueberschuss';

// ---------------------------------------------------------------------------
// Die Wörter
// ---------------------------------------------------------------------------

export const ABSCHNITT_TITEL = 'Fahrzeuge';
export const ABSCHNITT_INTRO =
  'Ladekarten, die hier schon geladen haben. Geben Sie einer einen Namen, wenn sie anders '
  + 'laden soll als der Ladepunkt.';

/** Der Leer-Zustand: ehrlich, und er nennt den Weg. */
export const KEINE_KARTEN =
  'Noch keine Ladekarte gesehen. Sobald jemand hier lädt, erscheint seine Karte hier — '
  + 'dann können Sie ihr einen Namen und eine Steuerart geben.';

/** Was ein Profil ist, in einem Satz — der Kasten über der Liste. */
export const WAS_IST_DAS =
  'Ein Fahrzeug-Profil gilt für die Ladung DIESER Karte, an jedem Ladepunkt. Ein '
  + 'Eingriff („Jetzt voll laden“) geht weiterhin vor.';

/** Was ein Profil NICHT kann — gesagt, nicht verschwiegen. */
export const KEIN_ZIEL_HINWEIS =
  'Ein Ziel wie „bis 06:00 fertig“ gehört zum Ladepunkt: es wird Stunden im Voraus '
  + 'geplant, und welches Auto dann dort steckt, weiß vorher niemand.';

export const OHNE_STEUERART = 'Lädt wie der Ladepunkt';
export const NIE_GESEHEN = 'noch nicht gesehen';
export const LAEDT_GERADE = 'lädt gerade';

export const QUELLE_TEXT: Record<FahrzeugQuelle, { titel: string; text: string }> = {
  sofort: {
    titel: 'Sofort laden',
    text: 'Diese Karte lädt, sobald sie eingesteckt ist — mit der Leistung, die der '
      + 'Anschluss hergibt.',
  },
  ueberschuss: {
    titel: 'Solar-Überschuss',
    text: 'Diese Karte lädt aus dem gemessenen Sonnenüberschuss.',
  },
};

export const MODUS_TEXT: Record<'pausieren' | 'mindestleistung', string> = {
  pausieren: 'Pausieren, wenn die Sonne nicht reicht',
  mindestleistung: 'Mindestleistung halten',
};

// ---------------------------------------------------------------------------
// Die Ableitungen
// ---------------------------------------------------------------------------

/**
 * Die vier Zeichen, an denen ein Kunde eine unbenannte Karte wiedererkennt.
 * Sie sind der ANFANG des Pseudonyms, damit dieselbe Karte überall dieselbe
 * Kurzform trägt — und nie der ganze Bezug: eine Fläche, die 24 Hexzeichen
 * zeigt, hilft niemandem.
 */
export function kartenKurz(tagRef: string | null | undefined): string {
  const t = (tagRef ?? '').trim();
  return t.startsWith('tagref_') && t.length >= 11 ? t.slice(7, 11) : '';
}

/** „Dienstwagen", sonst „Karte 1f2e…" — nie ein erfundener Name. */
export function fahrzeugName(f: Fahrzeug): string {
  const name = (f.name ?? '').trim();
  if (name) return name;
  const kurz = kartenKurz(f.tagRef);
  return kurz ? `Karte ${kurz}…` : 'Unbekannte Karte';
}

/** Ist das eine BENANNTE Karte (also ein Fahrzeug, das der Kunde kennt)? */
export function benannt(f: Fahrzeug): boolean {
  return !!(f.name ?? '').trim();
}

/** Trägt sie ein Profil (also eine eigene Steuerart)? */
export function hatProfil(f: Fahrzeug): boolean {
  return !!f.steuerart?.quelle;
}

/**
 * „zuletzt geladen: gestern, 18:42" — die Sichtung, in Kundenworten.
 *
 * ⚠ Ohne Zeitstempel wird NICHTS behauptet (`null`), nie „gerade eben". Und
 * „lädt gerade" kommt aus dem Herzschlag, nicht aus einer frischen Sichtung:
 * „vor zwei Minuten gesehen" ist keine laufende Ladung.
 */
export function sichtungText(f: Fahrzeug, nowMs?: number): string | null {
  if (f.laedt) return LAEDT_GERADE;
  const iso = f.letzteSichtungAm;
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const now = nowMs ?? Date.now();
  const tage = kalendertageZurueck(t, now);
  const uhr = new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (tage <= 0) return `zuletzt heute, ${uhr}`;
  if (tage === 1) return `zuletzt gestern, ${uhr}`;
  if (tage < 7) return `zuletzt vor ${tage} Tagen`;
  return `zuletzt am ${new Date(t).toLocaleDateString('de-DE')}`;
}

/** Ganze Kalendertage zwischen zwei Zeitpunkten (lokal, wie der Kunde zählt). */
function kalendertageZurueck(thenMs: number, nowMs: number): number {
  const a = new Date(thenMs);
  const b = new Date(nowMs);
  const tagA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const tagB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((tagB - tagA) / 86400000);
}

/** Der Steuerart-Chip einer Zeile — oder der ehrliche Rückfall. */
export function steuerartChip(f: Fahrzeug): string {
  const q = f.steuerart?.quelle;
  if (q === 'sofort') return QUELLE_TEXT.sofort.titel;
  if (q === 'ueberschuss') {
    const modus = f.steuerart?.ueberschussModus;
    const kw = f.steuerart?.mindestleistungKw;
    if (modus === 'mindestleistung' && typeof kw === 'number' && kw > 0) {
      return `${QUELLE_TEXT.ueberschuss.titel} (mind. ${kwText(kw)})`;
    }
    return QUELLE_TEXT.ueberschuss.titel;
  }
  return OHNE_STEUERART;
}

/** Eine Zahl in der kurzen Haus-Form (max. eine Nachkommastelle). */
function kwText(kw: number): string {
  const s = Math.round(kw * 10) / 10;
  return `${String(s).replace('.', ',')} kW`;
}

export interface FahrzeugZeile {
  key: string;
  tagRef: string;
  name: string;
  /** true, sobald der Kunde ihr einen Namen gegeben hat. */
  benannt: boolean;
  /** Der Steuerart-Chip; `OHNE_STEUERART`, solange es kein Profil gibt. */
  chip: string;
  hatProfil: boolean;
  /** „zuletzt gestern, 18:42" / „lädt gerade" / null. */
  sichtung: string | null;
  /** „an Hof Nord" — null, wenn die Box keine Säule genannt hat. */
  ort: string | null;
  laedt: boolean;
}

/**
 * Die Zeilen der Fahrzeug-Liste.
 *
 * ⚠ Die REIHENFOLGE des Servers bleibt (zuletzt gesehene zuerst) — mit EINER
 * Ausnahme: was gerade lädt, steht oben. Das ist die `LadenKachel`-Regel
 * („Aktive zuerst"), hier wiederverwendet, und sie ist reine Anzeige.
 */
export function fahrzeugZeilen(
  daten: SiteFahrzeuge | null | undefined,
  namen?: (chargePointId: string) => string | null,
  nowMs?: number,
): FahrzeugZeile[] {
  const list = daten?.fahrzeuge ?? [];
  const zeilen = list.map((f) => ({
    key: f.tagRef,
    tagRef: f.tagRef,
    name: fahrzeugName(f),
    benannt: benannt(f),
    chip: steuerartChip(f),
    hatProfil: hatProfil(f),
    sichtung: sichtungText(f, nowMs),
    ort: ortText(f, namen),
    laedt: f.laedt === true,
  }));
  return zeilen.sort((a, b) => Number(b.laedt) - Number(a.laedt));
}

/** „an Hof Nord" — der NAME der Säule, wo einer bekannt ist, sonst ihre Kennung. */
function ortText(f: Fahrzeug, namen?: (id: string) => string | null): string | null {
  const id = (f.letzterLadepunkt ?? '').trim();
  if (!id) return null;
  const name = namen?.(id);
  return `an ${name && name.trim() ? name.trim() : id}`;
}

/**
 * Der Rumpf des `PUT` aus einem Entwurf.
 *
 * ⚠ Es reist NUR, was die Wahl wirklich FRAGT: eine Mindestleistung ohne den
 * Modus „Mindestleistung halten" wäre ein verborgener Wert, den der Kunde nie
 * zu sehen bekommt — und den der Server als „Sonne zuerst" missverstehen
 * könnte (die `wunschAus`-Regel des Steuerart-Dialogs).
 *
 * ⚠ Eine AUSDRÜCKLICH gewählte Quelle `null` („Lädt wie der Ladepunkt") reist
 * als LEERE Zeichenkette und NIMMT das Profil zurück. Sie wegzulassen wäre die
 * Falle, die der Dialog selbst aufmacht: er nennt diese Karte den Weg zurück
 * und seine Folgen-Karte verspricht „lädt weiterhin so, wie der Ladepunkt es
 * vorgibt" — ein Speichern, das die gespeicherte Quelle stehen ließe, bräche
 * genau dieses Versprechen. Nur wer den Schlüssel GAR NICHT nennt (ein reines
 * Umbenennen von außerhalb des Dialogs), lässt sie unberührt.
 */
export function wunschAus(e: {
  name?: string;
  quelle?: FahrzeugQuelle | null;
  ueberschussModus?: 'pausieren' | 'mindestleistung';
  mindestleistungKw?: number | null;
}): FahrzeugWunsch {
  const w: FahrzeugWunsch = {};
  if (e.name !== undefined) w.name = e.name.trim();
  if (e.quelle !== undefined) {
    w.quelle = e.quelle ?? '';
    if (e.quelle === 'ueberschuss') {
      w.ueberschussModus = e.ueberschussModus ?? 'pausieren';
      if (e.ueberschussModus === 'mindestleistung'
        && typeof e.mindestleistungKw === 'number' && e.mindestleistungKw > 0) {
        w.mindestleistungKw = e.mindestleistungKw;
      }
    }
  }
  return w;
}

/**
 * Was das Speichern bewirkt — die Folgen-Karte des Dialogs.
 *
 * ⚠ Sie sagt nur, was der Entwurf HERGIBT: kein „Netzstrom erlaubt" an einer
 * reinen Überschuss-Quelle, und ohne Quelle kein Wort über das Laden.
 */
export function folgen(e: { name?: string; quelle?: FahrzeugQuelle | null;
  ueberschussModus?: 'pausieren' | 'mindestleistung'; mindestleistungKw?: number | null },
  fahrzeug: string): string[] {
  const out: string[] = [];
  const name = (e.name ?? '').trim();
  if (name) out.push(`Diese Karte heißt ab jetzt „${name}“.`);
  if (!e.quelle) {
    out.push(`${fahrzeug} lädt weiterhin so, wie der Ladepunkt es vorgibt.`);
    return out;
  }
  if (e.quelle === 'sofort') {
    out.push(`${fahrzeug} lädt sofort, sobald sie eingesteckt ist — auch wenn der `
      + 'Ladepunkt gerade auf die Sonne wartet.');
  } else if (e.ueberschussModus === 'mindestleistung') {
    const kw = typeof e.mindestleistungKw === 'number' && e.mindestleistungKw > 0
      ? ` (mindestens ${kwText(e.mindestleistungKw)})` : '';
    out.push(`${fahrzeug} lädt aus dem Sonnenüberschuss und bleibt${kw} in Bewegung, `
      + 'auch wenn eine Wolke kommt.');
  } else {
    out.push(`${fahrzeug} lädt nur aus dem Sonnenüberschuss und pausiert, wenn er nicht reicht.`);
  }
  out.push('Anschlussgrenze, Sicherheitsabstand und die Reihenfolge bei knapper Leistung '
    + 'gelten unverändert.');
  out.push('Ein Eingriff („Jetzt voll laden“) geht weiterhin vor.');
  return out;
}

/** Die Folgen der RÜCKNAHME — sie nennt, was BLEIBT. */
export function entfernenFolgen(fahrzeug: string): string[] {
  return [
    `${fahrzeug} lädt wieder so, wie der Ladepunkt es vorgibt.`,
    'Der Name und die Steuerart werden entfernt.',
    'Dass diese Karte hier geladen hat, bleibt sichtbar — sie erscheint danach wieder '
      + 'als unbenannte Karte.',
  ];
}

// ---------------------------------------------------------------------------
// Das BENENNEN im Ladevorgangs-Verlauf (Konzept §4.5: „dieser Ladevorgang war
// … → Name vergeben")
// ---------------------------------------------------------------------------

/** Was eine Ladevorgangs-Zeile über die Karte sagt, die dort gerade lädt. */
export interface VerlaufFahrzeug {
  /** Die Zeile, mit der der Fahrzeug-Dialog geöffnet wird. */
  zeile: FahrzeugZeile;
  /** Das gespeicherte Fahrzeug — `null`, solange die Liste es nicht kennt. */
  fahrzeug: Fahrzeug | null;
  /** „Dienstwagen · Sofort laden" bzw. „Karte 1f2e… · Lädt wie der Ladepunkt". */
  text: string;
  /** Das Wort auf dem Knopf: benennen, solange sie keinen Namen hat. */
  aktion: string;
}

export const VERLAUF_BENENNEN = 'Fahrzeug benennen';
export const VERLAUF_AENDERN = 'Fahrzeug';

/**
 * Die Karte EINER laufenden Ladung — der Weg vom Ladevorgang zum Profil.
 *
 * ⚠ Ohne gemeldetes Pseudonym gibt es KEINE Zeile und keinen Knopf: eine Säule,
 * die ihre Karte nicht nennt (ältere Box, freier Stecker), sagt nichts über ein
 * Fahrzeug, und ein Knopf, der strukturell nichts benennen kann, ist Lärm.
 *
 * ⚠ Eine Karte, die die Liste (noch) nicht führt, bekommt trotzdem ihre Zeile —
 * SYNTHETISIERT aus dem Pseudonym allein. Das ist ehrlich und nicht geraten:
 * derselbe Herzschlag, der diese Ladung meldet, hat die Sichtung serverseitig
 * geschrieben (`ChargerStatusListener` berührt JEDE gemeldete Karte). Ohne den
 * Rückfall hinge der Weg daran, ob zwei Abrufe im selben Moment gelandet sind.
 */
export function verlaufFahrzeug(
  tagRef: string | null | undefined,
  daten: SiteFahrzeuge | null | undefined,
  nowMs?: number,
): VerlaufFahrzeug | null {
  const t = (tagRef ?? '').trim();
  if (!t) return null;
  const f = (daten?.fahrzeuge ?? []).find((x) => x.tagRef === t) ?? null;
  const basis: Fahrzeug = f ?? { tagRef: t };
  const zeile: FahrzeugZeile = {
    key: t,
    tagRef: t,
    name: fahrzeugName(basis),
    benannt: benannt(basis),
    chip: steuerartChip(basis),
    hatProfil: hatProfil(basis),
    sichtung: f ? sichtungText(f, nowMs) : LAEDT_GERADE,
    ort: null,
    laedt: true,
  };
  return {
    zeile,
    fahrzeug: f,
    text: `${zeile.name} · ${zeile.chip}`,
    aktion: zeile.benannt ? VERLAUF_AENDERN : VERLAUF_BENENNEN,
  };
}
