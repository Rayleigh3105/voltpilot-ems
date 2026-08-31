/**
 * Die Zone „Verbraucher" der Steuerungsseite (Konzept
 * `data/vp-verbrauchsmgmt-konzept-v1` §6, Paket P1 — LESEND).
 *
 * Rein: keine Netzaufrufe, kein React, keine Uhr ausser der uebergebenen — das
 * `steuerungJetzt`/`betriebsmodelle`-Muster. Sie macht aus dem EINEN
 * Lese-Aggregat `GET /sites/{id}/verbraucher` Zeilen, Chips und Saetze; die
 * Flaeche rendert nur.
 *
 * **⚠ Sie ERFINDET keine Steuerart.** Quelle, Ziel und Herkunft entscheidet der
 * SERVER (`SteuerartProjektion`, §7.1/§7.2); hier entstehen nur die Woerter.
 * Was der Server nicht sagt, sagt diese Datei auch nicht — eine unbekannte
 * Quelle wird zu „Eigene Regel" statt zu einem geratenen Wort, und ein Ziel
 * ohne Zahl traegt keine.
 */
import { POLICY_LABEL, kwText } from './ladepunkte';

// ---------------------------------------------------------------------------
// Der Vertrag (die Form der Antwort)
// ---------------------------------------------------------------------------

export type SteuerartQuelle =
  | 'sofort'
  | 'ueberschuss'
  | 'guenstig'
  | 'feste_zeiten'
  | 'eigene_regel';

export type SteuerartZiel = 'bis_uhrzeit' | 'laufzeit_bis';

/** Woher der Server die Steuerart hat — sie entscheidet den Chip der Zeile. */
export type SteuerartHerkunft = 'policy' | 'standard' | 'ohne';

export type UeberschussModus = 'pausieren' | 'mindestleistung';

export interface SteuerartFenster {
  tage: string;
  von: string;
  bis: string;
}

export interface Steuerart {
  quelle: SteuerartQuelle | string;
  herkunft: SteuerartHerkunft | string;
  schwelleKw?: number | null;
  preisgrenzeCtKwh?: number | null;
  ueberschussModus?: UeberschussModus | string | null;
  mindestleistungKw?: number | null;
  fenster?: SteuerartFenster | null;
  ziel?: SteuerartZiel | string | null;
  zielFenster?: SteuerartFenster | null;
  zielEnergieKwh?: number | null;
  zielLaufzeitMinuten?: number | null;
  zielAmStueck?: boolean | null;
}

/** Der Ziel-Fortschritt — dieselbe Form wie `/consumers/{id}/fulfillment`. */
export interface VerbraucherFortschritt {
  requirementId: string;
  periodStart?: string | null;
  deadline?: string | null;
  requiredRuntimeSeconds?: number | null;
  actualRuntimeSeconds?: number | null;
  requiredEnergyKwh?: number | null;
  actualEnergyKwh?: number | null;
  energyConfirmation?: string | null;
  state: string;
  atRisk?: boolean;
  reasonCode?: string | null;
}

export interface VerbraucherEintrag {
  entityId: string;
  name: string | null;
  typ: string;
  typLabel: string;
  ladepunkt: boolean;
  chargePointId?: string | null;
  steuerart: Steuerart;
  regeln: number;
  fortschritt?: VerbraucherFortschritt | null;
  aktiv?: boolean | null;
}

export interface LadeparkRahmen {
  netzanschlussKw?: number | null;
  gepflegteGrenzeKw?: number | null;
  effektivGrenzeKw?: number | null;
  hausLastKw?: number | null;
  hoechsteHausLastKw?: number | null;
  verteiltKw?: number | null;
  budgetKw?: number | null;
  sicherheitsabstandPct?: number | null;
  mindestleistungKw?: number | null;
  modus?: string | null;
  blind?: boolean;
  hinweis?: string | null;
  steckerAnzahl?: number;
  gemeldetAm?: string | null;
}

export interface RanglisteEintrag {
  position: number;
  art: 'speicher' | 'ladepunkt' | 'verbraucher' | string;
  entityId: string | null;
  name: string;
}

export interface SiteVerbraucher {
  verbraucher: VerbraucherEintrag[];
  ladepunkte: {
    standard: Steuerart | null;
    standardFolger: number;
    gesamt: number;
    rahmen: LadeparkRahmen | null;
  };
  rangliste: RanglisteEintrag[];
}

// ---------------------------------------------------------------------------
// Kopien (§6.3, woertlich aus den abgenommenen Mockups)
// ---------------------------------------------------------------------------

export const ZONE_TITEL = 'Verbraucher';
export const ZONE_INTRO = 'Wie jedes Gerät lädt oder läuft. Eine Regel geht immer vor.';

export const ABSCHNITT_LADEPUNKTE = 'Ladepunkte';
export const ABSCHNITT_WEITERE = 'Weitere Verbraucher';

export const STANDARD_TITEL = 'Anlagen-Standard für Ladepunkte';
export const RAHMEN_TITEL = 'Ladepark-Rahmen';
export const RAHMEN_EINSTELLUNGEN = 'Einstellungen';
export const RANGLISTE_TITEL = 'Reihenfolge bei knapper Leistung';

/** Der Leer-Zustand: EIN Satz mit dem Weg (§6.3). */
export const ZONE_LEER =
  'Noch kein steuerbares Gerät. Legen Sie eines im Anlagen-Modell an — die '
  + 'Steuerart wählen Sie dann hier.';

/** Eine Zeile ohne Regel sagt das ruhig — sie ist KEIN Link (§6.2). */
export const OHNE_REGEL = 'Ohne Regel';

/** Die Chips „Standard" / „abweichend" eines Ladepunkts. */
export const CHIP_STANDARD = 'Standard';
export const CHIP_ABWEICHEND = 'abweichend';

/**
 * Wo die Steuerart HEUTE eingestellt wird.
 *
 * **⚠ P1 ist lesend**: die Zeile oeffnet noch keinen Steuerart-Dialog (das ist
 * P2). Statt eines toten Klicks nennt die Zone den Weg, den es wirklich gibt —
 * die Haus-Regel „eine Handlung, die strukturell nichts bewirken kann, wird
 * nicht angeboten; stattdessen steht der Grund da".
 */
export const WEG_LADEPUNKT =
  'Die Steuerart Ihrer Ladepunkte stellen Sie zurzeit im Ladepark unter '
  + '„Einstellungen" ein.';
export const WEG_VERBRAUCHER =
  'Die Steuerart eines Verbrauchers stellen Sie zurzeit unter „Regeln" auf '
  + 'dieser Seite ein.';

/**
 * Der Modus als KURZFORM fuer einen Chip.
 *
 * **⚠ ZWILLING von `POLICY_LABEL` (`ladepunkte.ts`)** — dieselbe Wahl, einmal
 * lang (die Radios der Ladepark-Kapsel, wo der Kunde sie trifft) und einmal
 * kurz (der Chip einer Zeile). `pausieren` ist `nur_sonne`,
 * `mindestleistung` ist `sonne_zuerst`; **beide zusammen aendern**, sonst
 * heisst dieselbe Wahl an zwei Orten verschieden. `verbraucherZone.test.ts`
 * haelt die Paarung fest.
 */
export const MODUS_KURZ: Record<UeberschussModus, string> = {
  pausieren: 'nur Sonne',
  mindestleistung: 'Sonne zuerst',
};

/** Die lange Fassung desselben Modus — woertlich die der Ladepark-Kapsel. */
export function modusLang(modus: string | null | undefined): string | null {
  if (modus === 'pausieren') return POLICY_LABEL.nur_sonne;
  if (modus === 'mindestleistung') return POLICY_LABEL.sonne_zuerst;
  return null;
}

// ---------------------------------------------------------------------------
// Die Woerter einer Steuerart
// ---------------------------------------------------------------------------

const QUELLE_WORT: Record<string, string> = {
  sofort: 'Sofort',
  ueberschuss: 'Überschuss',
  guenstig: 'Günstige Stunden',
  feste_zeiten: 'Feste Zeiten',
  eigene_regel: 'Eigene Regel',
};

/** „13–15 Uhr" aus einem Fenster; null, wenn es keines gibt. */
export function fensterText(f: SteuerartFenster | null | undefined): string | null {
  if (!f || !f.von || !f.bis) return null;
  const kurz = (t: string): string => (t.endsWith(':00') ? t.slice(0, -3) : t);
  return `${kurz(f.von)}–${kurz(f.bis)} Uhr`;
}

/**
 * Der QUELLEN-Chip einer Zeile („Überschuss", „Feste Zeiten 13–15 Uhr").
 *
 * **⚠ Eine Quelle, die dieser Portal-Stand nicht kennt, wird „Eigene Regel"** —
 * nie ein geratenes Wort. Sie reist als Datum mit und behauptet nichts.
 */
export function quelleChip(s: Steuerart | null | undefined): string {
  if (!s) return QUELLE_WORT.eigene_regel;
  const wort = QUELLE_WORT[s.quelle];
  if (!wort) return QUELLE_WORT.eigene_regel;
  if (s.quelle === 'feste_zeiten') {
    const f = fensterText(s.fenster);
    return f ? `${wort} ${f}` : wort;
  }
  return wort;
}

/**
 * Die Quelle als LANGE Zeile („Überschuss (Sonne zuerst)", „Überschuss ab
 * 2,5 kW", „Günstige Stunden unter 12 ct/kWh") — fuer den Standard-Kopf und
 * die Jetzt-Zeile. Ohne belegte Zahl bleibt es beim nackten Wort.
 */
export function quelleLang(s: Steuerart | null | undefined): string {
  const wort = quelleChip(s);
  if (!s) return wort;
  if (s.quelle === 'ueberschuss') {
    const modus = s.ueberschussModus === 'pausieren' || s.ueberschussModus === 'mindestleistung'
      ? MODUS_KURZ[s.ueberschussModus] : null;
    if (modus) return `${wort} (${modus})`;
    if (typeof s.schwelleKw === 'number') {
      return `${wort} ab ${kwText(s.schwelleKw)}`;
    }
    return wort;
  }
  if (s.quelle === 'guenstig' && typeof s.preisgrenzeCtKwh === 'number') {
    return `${wort} unter ${zahl(s.preisgrenzeCtKwh, 'ct/kWh')}`;
  }
  return wort;
}

/** „06:00" aus einem Ziel-Fenster; null, wenn es keines gibt. */
function zielUhrzeit(s: Steuerart): string | null {
  const bis = s.zielFenster?.bis;
  return bis ? bis : null;
}

/**
 * Der ZIEL-Chip („bis 06:00 · 20 kWh", mit Beleg „bis 06:00 · 12,1 von
 * 20 kWh", verpasst „bis 06:00 · nicht geschafft (14,2 von 20 kWh)").
 *
 * **⚠ Bewusste Abweichung vom Mockup-Wortlaut „bis 06:00 voll".** „Voll" waere
 * eine Aussage ueber die Batterie des AUTOS, die niemand kennt — VoltPilot
 * kennt nur das kWh-Ziel des Kunden. Der Chip nennt deshalb die Zahl, die
 * wirklich vorliegt.
 */
export function zielChip(
  s: Steuerart | null | undefined,
  fortschritt?: VerbraucherFortschritt | null,
): string | null {
  if (!s || !s.ziel) return null;
  const uhr = zielUhrzeit(s);
  const kopf = uhr ? `bis ${uhr}` : 'bis zur Frist';
  const verpasst = fortschritt?.state === 'missed';
  if (s.ziel === 'bis_uhrzeit') {
    const soll = num(s.zielEnergieKwh) ?? num(fortschritt?.requiredEnergyKwh);
    const ist = num(fortschritt?.actualEnergyKwh);
    if (soll == null) return kopf;
    const sollText = zahl(soll, 'kWh');
    if (ist == null) return `${kopf} · ${sollText}`;
    const beleg = `${zahl(ist, '')} von ${sollText}`;
    return verpasst ? `${kopf} · nicht geschafft (${beleg})` : `${kopf} · ${beleg}`;
  }
  if (s.ziel === 'laufzeit_bis') {
    const soll = num(s.zielLaufzeitMinuten) ?? minuten(fortschritt?.requiredRuntimeSeconds);
    const ist = minuten(fortschritt?.actualRuntimeSeconds);
    if (soll == null) return kopf;
    const sollText = zahl(soll, 'Min.');
    if (ist == null) return `${kopf} · ${sollText}`;
    const beleg = `${zahl(ist, '')} von ${sollText}`;
    return verpasst ? `${kopf} · nicht geschafft (${beleg})` : `${kopf} · ${beleg}`;
  }
  return kopf;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Eine Zahl mit ihrer Einheit - HÖCHSTENS eine Nachkommastelle, wie
 * `ladepunkte.kwText`. Die Zone steht auf derselben Seite wie die
 * Ladepunkt-Flächen; „20 kWh" und „20,0 kWh" nebeneinander wären zwei
 * Schreibweisen für dieselbe Zahl.
 */
function zahl(v: number, einheit: string): string {
  const n = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v);
  return einheit ? `${n} ${einheit}` : n;
}

function minuten(sekunden: number | null | undefined): number | null {
  const s = num(sekunden);
  return s == null ? null : Math.round(s / 60);
}

/** „2 Regeln →" / „1 Regel →"; null bei keiner (dann steht `OHNE_REGEL`). */
export function regelnChip(n: number): string | null {
  if (!n || n <= 0) return null;
  return `${n} ${n === 1 ? 'Regel' : 'Regeln'} →`;
}

// ---------------------------------------------------------------------------
// Die Zeilen der Zone
// ---------------------------------------------------------------------------

export interface ZeilenView {
  entityId: string;
  /** Der Anzeigename — nie leer: ohne Namen steht der Typ da. */
  name: string;
  ladepunkt: boolean;
  /** „Standard" / „abweichend"; null fuer alles, was kein Ladepunkt ist. */
  chip: string | null;
  quelle: string;
  ziel: string | null;
  /** „2 Regeln →"; null = ohne Regel (dann rendert die Flaeche `OHNE_REGEL`). */
  regeln: string | null;
  /** Die Anzahl selbst — der Sprung braucht sie, der Text nicht. */
  regelZahl: number;
  /** Die Steuerart ist nicht abbildbar: die Zeile fuehrt in den Baukasten. */
  eigeneRegel: boolean;
}

/** Der Name einer Zeile: der vergebene, sonst der Typ (nie leer, nie „null"). */
export function zeilenName(e: VerbraucherEintrag): string {
  const n = (e.name ?? '').trim();
  return n || e.typLabel || e.typ;
}

export function zeile(e: VerbraucherEintrag): ZeilenView {
  const eigeneRegel = e.steuerart?.quelle === 'eigene_regel'
    || QUELLE_WORT[e.steuerart?.quelle] === undefined;
  return {
    entityId: e.entityId,
    name: zeilenName(e),
    ladepunkt: e.ladepunkt,
    chip: e.ladepunkt ? (e.steuerart?.herkunft === 'standard' ? CHIP_STANDARD : CHIP_ABWEICHEND)
      : null,
    quelle: quelleChip(e.steuerart),
    ziel: zielChip(e.steuerart, e.fortschritt),
    regeln: regelnChip(e.regeln),
    regelZahl: e.regeln,
    eigeneRegel,
  };
}

export interface ZoneView {
  ladepunkte: ZeilenView[];
  weitere: ZeilenView[];
  /** Nur gesetzt, wenn es GAR NICHTS Steuerbares gibt. */
  leer: string | null;
  /** „Gilt für 3 von 4 Ladepunkten"; null ohne Ladepunkt. */
  standardSatz: string | null;
  standard: Steuerart | null;
  standardQuelle: string | null;
  standardZiel: string | null;
  rahmen: RahmenView | null;
  rangliste: RanglisteEintrag[];
  /** „Speicher zuerst · 8 Einträge"; null bei leerer Liste. */
  ranglisteZusammenfassung: string | null;
  /** Ab wie vielen Zeilen die Flaeche ein Suchfeld zeigt (§6.4). */
  sucheAb: number;
  /** Ab wie vielen Standard-Folgern sie zusammengeklappt werden (§6.4). */
  klappenAb: number;
}

export interface RahmenView {
  /** Die belegten Zahlen des Kopfes, in ihrer Reihenfolge. */
  zahlen: string[];
  /** Der Satz der BOX, woertlich durchgereicht; null, wenn sie keinen sendet. */
  hinweis: string | null;
  /** Der Satz, wenn keine Anschlussgrenze hinterlegt ist (`GRENZE_FEHLT`). */
  grenzeFehlt: boolean;
  /** Anteil des Budgets, das gerade verteilt ist (0..1); null ohne Grenze. */
  anteil: number | null;
}

/** §6.4: ab 12 Zeilen ein Suchfeld, ab 25 werden die Standard-Folger geklappt. */
export const SUCHE_AB = 12;
export const KLAPPEN_AB = 25;

export function zone(daten: SiteVerbraucher | null | undefined): ZoneView {
  const alle = daten?.verbraucher ?? [];
  const ladepunkte = alle.filter((e) => e.ladepunkt).map(zeile);
  const weitere = alle.filter((e) => !e.ladepunkt).map(zeile);
  const lp = daten?.ladepunkte;
  const standard = lp?.standard ?? null;
  return {
    ladepunkte,
    weitere,
    leer: alle.length === 0 ? ZONE_LEER : null,
    standardSatz: lp && lp.gesamt > 0
      ? `Gilt für ${lp.standardFolger} von ${lp.gesamt} ${lp.gesamt === 1 ? 'Ladepunkt' : 'Ladepunkten'}`
      : null,
    standard,
    standardQuelle: standard ? quelleLang(standard) : null,
    standardZiel: standard ? zielChip(standard) : null,
    rahmen: rahmenView(lp?.rahmen ?? null),
    rangliste: daten?.rangliste ?? [],
    ranglisteZusammenfassung: ranglisteZusammenfassung(daten?.rangliste ?? []),
    sucheAb: SUCHE_AB,
    klappenAb: KLAPPEN_AB,
  };
}

/**
 * Der Kopf des Ladepunkt-Abschnitts (§6.3: „Netzanschluss 32 kW · Reserve Haus
 * 5 kW · gerade 22 kW verteilt").
 *
 * **⚠ Es steht nur da, was BELEGT ist.** Jede Zahl ist nullable, und eine
 * fehlende faellt weg statt als 0 zu erscheinen. Die „Reserve Haus" ist die
 * hoechste bekannte Gebaeudelast, mit der die Box rechnet (`max_house_load_kw`);
 * misst sie live, steht der GEMESSENE Hausverbrauch da und sagt das auch.
 */
export function rahmenView(r: LadeparkRahmen | null | undefined): RahmenView | null {
  if (!r) return null;
  const grenze = num(r.netzanschlussKw) ?? num(r.gepflegteGrenzeKw);
  const zahlen: string[] = [];
  if (grenze != null) zahlen.push(`Netzanschluss ${kwText(grenze)}`);
  const gemessen = num(r.hausLastKw);
  const reserve = num(r.hoechsteHausLastKw);
  if (gemessen != null) {
    zahlen.push(`Gebäude ${kwText(gemessen)} (gemessen)`);
  } else if (reserve != null) {
    zahlen.push(`Reserve Haus ${kwText(reserve)}`);
  }
  const verteilt = num(r.verteiltKw);
  if (verteilt != null) zahlen.push(`gerade ${kwText(verteilt)} verteilt`);
  return {
    zahlen,
    hinweis: (r.hinweis ?? '').trim() || null,
    grenzeFehlt: grenze == null,
    anteil: grenze != null && grenze > 0 && verteilt != null
      ? Math.max(0, Math.min(1, verteilt / grenze)) : null,
  };
}

/** „Speicher zuerst · 8 Einträge" — der Satz der eingeklappten Rangliste. */
export function ranglisteZusammenfassung(liste: RanglisteEintrag[]): string | null {
  if (!liste.length) return null;
  const erste = liste[0];
  const kopf = erste.art === 'speicher' ? 'Speicher zuerst' : `${erste.name} zuerst`;
  return `${kopf} · ${liste.length} ${liste.length === 1 ? 'Eintrag' : 'Einträge'}`;
}
