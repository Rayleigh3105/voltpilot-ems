/**
 * Die Werkstatt-Bildschirme (Entscheid WI-8 A, Konzept Abschnitt 4): was der
 * Werkstatt-Dienst gerade tut, in Alltagsworten. Reine Ableitungen ohne React;
 * die Ansicht kommt aus `GET /api/v1/admin/werkstatt/dienst`
 * (`docs/contracts/werkstatt-ansicht-v1.md`, Vektor im Test).
 *
 * Regeln für Fremde an der Werkbank: eine Aufgabe je Bildschirm, der Dienst
 * merkt Handgriffe selbst (kein „Weiter“-Knopf), jede Störung sagt, was
 * passiert ist und was zu tun ist, Fachwörter nur unter „Details für Technik“.
 */
import type { WerkstattAbnahme, WerkstattBox } from './werkstatt';
import { fallSeite, type FallSeite } from './werkstattLauf';

export type LaufZustand = 'laeuft' | 'wartet' | 'fertig' | 'angehalten';

/** Der Stand eines Laufs, wie der Dienst ihn meldet (Feldnamen des Vertrags). */
export interface LaufStand {
  kennung: string;
  freigabe: string;
  box_art: string;
  box?: string;
  beginn: string;
  ende?: string;
  zustand: LaufZustand;
  schritt?: string;
  titel?: string;
  erledigt: string[];
  grund?: string;
  handgriff?: string;
  wartet_auf?: string;
  hinweis?: string;
  /** Code, warum der Lauf anhielt (Vertrag werkstatt-ansicht-v1, „Fälle eines Laufs“); nur bei angehalten. */
  fall?: string;
  loesung?: Loesung | null;
  /** Seit wann der laufende Schritt läuft und seine Frist (Lauf-Seite, additiv). */
  schritt_seit?: string;
  schritt_frist_s?: number;
  /** Je erledigtem Schritt Dauer und eine Belegzeile aus einer festen Liste, nie ein Geheimnis (E3 A). */
  belege?: SchrittBeleg[];
  /** Was vorher auf der Box war (Schritt erkennen). */
  vorher?: Vorher | null;
  /** Der Dienst erlaubt „Nochmal versuchen“ aus dem Portal (E1 A; nur ohne Handgriff an der Box). */
  nochmal_moeglich?: boolean;
  /** Seit wann der Dienst den Auftrag „Nochmal“ ausführt. */
  nochmal_seit?: string;
}

export interface SchrittBeleg {
  schritt: string;
  dauer_s: number;
  zeile: string;
}

export interface Vorher {
  system: string;
  edge_light: string;
  ersetzt?: boolean;
}

/** Eine zur Seite gelegte Box (E2 A, `GET /api/v1/admin/werkstatt/dienst` → `zurSeite`). */
export interface ZurSeite {
  id: string;
  lauf: string;
  box: string | null;
  fall: string | null;
  loesungTitel: string | null;
  schritt: string | null;
  grund: string | null;
  gelegtAm: string;
  gelegtVon: string;
}

/** Was der Mensch tun kann (Vertrag werkstatt-ansicht-v1): `selbst` = danach macht der Dienst von selbst weiter. */
export interface Loesung {
  titel: string;
  schritte: string[];
  selbst: boolean;
  zur_seite: boolean;
}

export interface FreigabeDatei {
  kennung: string;
  box_art: string;
  gueltig_bis: string;
  openwrt: { fassung: string; datei?: string; sha256?: string; quelle?: string };
  edge_light: { fassung: string; quelle?: string };
}

/** Die Ansicht des Dienstes (vp-werkstatt-ansicht.v1). */
export interface WerkstattAnsicht {
  schema: string;
  zeit: string;
  werkbank: {
    adresse: string;
    bereit: boolean;
    grund?: string;
    fassung_soll: string;
    host_schluessel?: string;
    status?: {
      fassung?: string;
      werkstatt?: { kabel: boolean };
      antworten?: { adresse: string; macs: string[] | null }[] | null;
      strom?: { unterspannung_jetzt?: boolean; unterspannung_seit_start?: boolean; quelle: string } | null;
    } | null;
    status_zeit?: string;
  };
  freigabe: { laufend: boolean; grund?: string; freigabe?: FreigabeDatei | null; boxen: number };
  anschluss?: string;
  /** Code des Zustands am Anschluss, solange kein Lauf arbeitet (Vertrag, „Fälle am Anschluss“). */
  anschluss_fall?: string;
  anschluss_loesung?: Loesung | null;
  lauf?: LaufStand | null;
}

export interface WerkstattLauf {
  kennung: string;
  freigabe: string | null;
  boxArt: string | null;
  zustand: LaufZustand;
  schritt: string | null;
  titel: string | null;
  grund: string | null;
  beginn: string;
  ende: string | null;
  aktualisiertAm: string;
  stand: LaufStand;
}

/** Antwort von `GET /api/v1/admin/werkstatt/dienst`. */
export interface WerkstattDienst {
  ansicht: WerkstattAnsicht | null;
  gemeldetAm: string | null;
  dienstZeit: string | null;
  alterSekunden: number | null;
  aktuell: boolean;
  laeufe: WerkstattLauf[];
  /** Fehlt bei einer API vor der Lauf-Seite: dann gibt es keine Liste. */
  zurSeite?: ZurSeite[];
}

/** Eine Freigabe der Werkstatt (`/api/v1/admin/werkstatt/freigaben`). */
export interface WerkstattFreigabe {
  id: string;
  kennung: string;
  boxArt: string;
  gueltigAb: string;
  gueltigBis: string;
  obergrenze: number;
  openwrt: { fassung: string; datei: string; sha256: string; quelle: string };
  edgeLight: { fassung: string; quelle: string; programmSha256: string; skripteSha256: string };
  notiz: string | null;
  erteiltAm: string;
  erteiltVon: string;
  beendetAm: string | null;
  beendetVon: string | null;
  zustand: 'laufend' | 'beendet' | 'abgelaufen';
  grund: string | null;
}

/**
 * Liest die Antwort der API so, wie der Vertrag sie meint: `erledigt` ist eine Liste. Der Dienst bis 724ebdde9 meldete
 * einen Lauf ohne erledigten Schritt mit `erledigt: null`, und die API hält je Lauf seinen letzten Stand – solche Stände
 * bleiben in `laeufe` stehen. `null` heißt hier nur „noch nichts erledigt“.
 */
export function liesDienst(d: WerkstattDienst): WerkstattDienst {
  const stand = (s: LaufStand): LaufStand => (Array.isArray(s.erledigt) ? s : { ...s, erledigt: [] });
  return {
    ...d,
    ansicht: d.ansicht?.lauf ? { ...d.ansicht, lauf: stand(d.ansicht.lauf) } : d.ansicht,
    laeufe: (d.laeufe ?? []).map((l) => (l.stand ? { ...l, stand: stand(l.stand) } : l)),
  };
}

// ── Phasen ─────────────────────────────────────────────────────────────────

export type PhaseZustand = 'ok' | 'lauf' | 'offen' | 'warn';

/** Sechs Phasen in Alltagsworten statt der Schritte des Dienstes (M3). */
export const PHASEN = [
  { id: 'erkannt', titel: 'Erkannt', klein: 'Mango erkannt', schritte: ['erkennen'] },
  { id: 'aufgespielt', titel: 'Aufgespielt', klein: 'Neues System (OpenWrt)', schritte: ['fassungen', 'openwrt', 'wiedererkennen'] },
  { id: 'einrichten', titel: 'Einrichten', klein: 'Passwort, Notfall-Schlüssel, Programm', schritte: ['internet', 'passwort', 'notfall', 'programm'] },
  { id: 'anmelden', titel: 'Bei VoltPilot anmelden', klein: 'Geräteschlüssel und Wartungstunnel', schritte: ['tunnel_schluessel', 'einloesen', 'tunnel_adresse', 'tunnel'] },
  { id: 'probe', titel: 'Probe über den Wartungstunnel', klein: 'Netz der Box, Neustart, Anmeldung über den Tunnel', schritte: ['lan', 'neustart', 'probe'] },
  { id: 'abnahme', titel: 'Abnahme', klein: 'Alle neun Prüfungen mit Beleg', schritte: ['internet_weg', 'uebergabe'] },
] as const;

/** Die Schritte des Dienstes in ihrer Reihenfolge. */
export const SCHRITTE: readonly string[] = PHASEN.flatMap((p) => p.schritte);

/** Ungefähre Dauer je Schritt in Minuten an der Mango (PS-3 misst nach); die Lauf-Seite nimmt gemessene Dauern, wenn es sie gibt. */
export const MINUTEN: Record<string, number> = {
  erkennen: 0.5, fassungen: 1, openwrt: 2, wiedererkennen: 4, internet: 0.5, passwort: 0.5, notfall: 0.3,
  programm: 2, tunnel_schluessel: 0.3, einloesen: 0.3, tunnel_adresse: 0.3, tunnel: 1, lan: 0.5, neustart: 3,
  probe: 1.5, internet_weg: 0.3, uebergabe: 0.2,
};

/** Wo der Lauf steht: Index des laufenden Schritts; fertig = alles; unbekannt = nach dem letzten erledigten. */
function stelle(s: LaufStand): number {
  if (s.zustand === 'fertig') return SCHRITTE.length;
  const i = s.schritt ? SCHRITTE.indexOf(s.schritt) : -1;
  if (i >= 0) return i;
  return Math.max(-1, ...s.erledigt.map((e) => SCHRITTE.indexOf(e))) + 1;
}

/** Einlösen (mit API) und die Eingabe der Tunnel-Adresse (ohne) sind zwei Wege für dasselbe; nur einer zählt. */
export function zaehlt(s: LaufStand, schritt: string): boolean {
  const vonHand = s.schritt === 'tunnel_adresse' || s.erledigt.includes('tunnel_adresse');
  return schritt === 'tunnel_adresse' ? vonHand : schritt === 'einloesen' ? !vonHand : true;
}

export interface Phase {
  id: string;
  titel: string;
  klein: string;
  zustand: PhaseZustand;
}

export function phasen(s: LaufStand): Phase[] {
  const i = stelle(s);
  return PHASEN.map((p) => {
    const idx = p.schritte.map((x) => SCHRITTE.indexOf(x));
    const erste = Math.min(...idx);
    const letzte = Math.max(...idx);
    let zustand: PhaseZustand = 'offen';
    if (i > letzte) zustand = 'ok';
    else if (i >= erste) zustand = s.zustand === 'angehalten' ? 'warn' : 'lauf';
    return { id: p.id, titel: p.titel, klein: p.klein, zustand };
  });
}

/** Die Phase, in der der Lauf steht (oder hielt). */
export function aktuellePhase(s: LaufStand): Phase | null {
  return phasen(s).find((p) => p.zustand === 'lauf' || p.zustand === 'warn') ?? null;
}

/** Restzeit in ganzen Minuten (mindestens 1, solange nicht fertig) und Anteil 0..1. */
export function fortschritt(s: LaufStand): { restMinuten: number; anteil: number } {
  if (s.zustand === 'fertig') return { restMinuten: 0, anteil: 1 };
  const i = stelle(s);
  let fertig = 0;
  let rest = 0;
  SCHRITTE.forEach((x, n) => {
    if (!zaehlt(s, x)) return;
    if (n < i) fertig += MINUTEN[x] ?? 0.5;
    else rest += MINUTEN[x] ?? 0.5;
  });
  const summe = fertig + rest;
  return { restMinuten: Math.max(1, Math.ceil(rest)), anteil: summe > 0 ? fertig / summe : 0 };
}

// ── Welcher Bildschirm ─────────────────────────────────────────────────────

export type Bildschirm =
  | { art: 'kein-dienst'; alterSekunden: number | null }
  | { art: 'start' }
  | {
      art: 'anschliessen';
      kabel: boolean | null;
      meldetSich: boolean;
      freigegeben: boolean;
      grund: string | null;
      /** Lösung zum Fall am Anschluss, wenn er mehr ist als „Kabel/Strom anstecken und warten“. */
    }
  | { art: 'laeuft'; lauf: LaufStand }
  | { art: 'du'; lauf: LaufStand }
  | { art: 'fertig'; lauf: LaufStand }
  /** Ein angehaltener Lauf oder ein Fall am Anschluss: eine Seite je Fall-Code (`werkstattLauf.fallSeite`). */
  | { art: 'fall'; lauf: LaufStand | null; seite: FallSeite };

export interface BildschirmEingabe {
  dienst: WerkstattDienst | null;
  /** Hat jemand an der Werkbank sein Gerät gewählt (M1 → M2)? */
  gewaehlt: boolean;
  /** Läufe, die an der Werkbank schon weggeklickt sind („Nächste Box“) oder zur Seite liegen (E2, auch aus der API). */
  erledigt: ReadonlySet<string>;
}

/**
 * Welcher Bildschirm an der Werkbank gilt. Meldet sich der Dienst nicht (älter
 * als 60 s oder nie), sagt der Bildschirm das, statt einen alten Stand als
 * aktuell zu zeigen.
 */
export function bildschirm(e: BildschirmEingabe): Bildschirm {
  const d = e.dienst;
  if (!d || !d.aktuell || !d.ansicht) return { art: 'kein-dienst', alterSekunden: d?.alterSekunden ?? null };
  if (!e.gewaehlt) return { art: 'start' };
  const a = d.ansicht;
  const kabel = a.werkbank.status?.werkstatt?.kabel ?? null;
  const weg = new Set([...e.erledigt, ...(d.zurSeite ?? []).map((z) => z.lauf)]);
  const lauf = a.lauf && !weg.has(a.lauf.kennung) ? a.lauf : null;
  if (lauf) {
    switch (lauf.zustand) {
      case 'laeuft':
        return { art: 'laeuft', lauf };
      case 'wartet':
        return { art: 'du', lauf };
      case 'angehalten':
        if (kabel !== false) {
          return { art: 'fall', lauf, seite: fallSeite({ code: lauf.fall, loesung: lauf.loesung, wo: 'lauf', ansicht: a, lauf }) };
        }
        break;
      case 'fertig':
        if (kabel !== false) return { art: 'fertig', lauf };
        break;
    }
  }
  if (a.anschluss_fall && a.anschluss_loesung && !SCHON_GEZEIGT.has(a.anschluss_fall)) {
    return { art: 'fall', lauf: null, seite: fallSeite({ code: a.anschluss_fall, loesung: a.anschluss_loesung, wo: 'anschluss', ansicht: a, lauf: null }) };
  }
  return {
    art: 'anschliessen',
    kabel,
    meldetSich: (a.werkbank.status?.antworten ?? []).some((x) => (x.macs ?? []).length > 0),
    freigegeben: a.freigabe.laufend,
    grund: a.freigabe.laufend ? null : a.freigabe.grund ?? 'Die Werkstatt ist nicht freigegeben.',
  };
}

/** Fälle am Anschluss, die der Bildschirm „Mango anschließen“ mit seiner Liste schon zeigt; jeder andere bekommt seine Fall-Seite. */
const SCHON_GEZEIGT = new Set(['kein_kabel', 'keine_box']);

// ── Freigabe, Heute, Übersicht ─────────────────────────────────────────────

const DATUM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const UHR = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

/** „Edge Light 2026.11.1 · OpenWrt 25.12.5 · bis 30.11.“ */
export function freigabeZeile(f: { edgeLight: { fassung: string }; openwrt: { fassung: string }; gueltigBis: string }): string {
  return `Edge Light ${f.edgeLight.fassung.replace(/^edge-light-/, '')} · OpenWrt ${f.openwrt.fassung} · bis ${DATUM.format(new Date(f.gueltigBis))}`;
}

export function laufendeFreigabe(freigaben: readonly WerkstattFreigabe[]): WerkstattFreigabe | null {
  return freigaben.find((f) => f.zustand === 'laufend') ?? null;
}

export interface HeuteZeile {
  kennung: string;
  box: string | null;
  zustand: LaufZustand;
  prozent: number | null;
}

/** Die Läufe dieses Tages (Ortszeit), neueste zuerst. */
export function heute(laeufe: readonly WerkstattLauf[], jetzt: Date): HeuteZeile[] {
  const tag = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  return laeufe
    .filter((l) => tag(new Date(l.beginn)) === tag(jetzt))
    .map((l) => ({
      kennung: l.kennung,
      box: l.stand.box ?? null,
      zustand: l.zustand,
      prozent: l.zustand === 'laeuft' || l.zustand === 'wartet' ? Math.round(fortschritt(l.stand).anteil * 100) : null,
    }));
}

export type ZeilenStand = 'abgenommen' | 'problem' | 'laeuft' | 'fertig-ohne-abnahme' | 'register';

export interface UebersichtZeile {
  box: string | null;
  geraet: string;
  stand: ZeilenStand;
  text: string;
  seit: string;
  lauf: WerkstattLauf | null;
  abnahme: WerkstattAbnahme | null;
}

/**
 * Die Boxen der Übersicht (D1): jede Box des Registers mit ihrem Stand aus
 * Abnahme und letztem Lauf, dazu Läufe, deren Box noch keine Kennung hat.
 */
export function uebersicht(boxen: readonly WerkstattBox[], laeufe: readonly WerkstattLauf[]): UebersichtZeile[] {
  const jeBox = new Map<string, WerkstattLauf>();
  for (const l of laeufe) {
    const b = l.stand.box;
    if (b && !jeBox.has(b)) jeBox.set(b, l);
  }
  const zeilen: UebersichtZeile[] = boxen.map((b) => {
    const lauf = jeBox.get(b.edgeRef) ?? null;
    const abnahme = b.abnahmen[0] ?? null;
    const geraet = b.boxArt === 'edge-light' ? 'Mango' : 'Docker-Box';
    if (lauf && (lauf.zustand === 'laeuft' || lauf.zustand === 'wartet')) {
      return { box: b.edgeRef, geraet, stand: 'laeuft', text: `${aktuellePhase(lauf.stand)?.titel ?? 'läuft'} (${Math.round(fortschritt(lauf.stand).anteil * 100)} %)`, seit: lauf.beginn, lauf, abnahme };
    }
    if (abnahme && (!lauf || new Date(abnahme.erfasstAm) >= new Date(lauf.beginn))) {
      return { box: b.edgeRef, geraet, stand: 'abgenommen', text: abnahme.quelle === 'dienst' ? 'vom Dienst' : 'von Hand', seit: abnahme.erfasstAm, lauf, abnahme };
    }
    if (lauf && lauf.zustand === 'angehalten') {
      return { box: b.edgeRef, geraet, stand: 'problem', text: aktuellePhase(lauf.stand)?.titel ?? 'angehalten', seit: lauf.ende ?? lauf.aktualisiertAm, lauf, abnahme };
    }
    if (lauf && lauf.zustand === 'fertig') {
      return { box: b.edgeRef, geraet, stand: 'fertig-ohne-abnahme', text: 'fertig, Abnahme fehlt', seit: lauf.ende ?? lauf.aktualisiertAm, lauf, abnahme };
    }
    return { box: b.edgeRef, geraet, stand: 'register', text: 'im Register', seit: b.geaendertAm, lauf, abnahme };
  });
  const ohneKennung = laeufe.filter((l) => !l.stand.box && (l.zustand === 'laeuft' || l.zustand === 'wartet'));
  return [
    ...ohneKennung.map((l): UebersichtZeile => ({
      box: null, geraet: 'Mango', stand: 'laeuft', text: `${aktuellePhase(l.stand)?.titel ?? 'läuft'} (${Math.round(fortschritt(l.stand).anteil * 100)} %)`,
      seit: l.beginn, lauf: l, abnahme: null,
    })),
    ...zeilen.sort((x, y) => (y.seit > x.seit ? 1 : y.seit < x.seit ? -1 : 0)),
  ];
}

export function uhrzeit(iso: string): string {
  return UHR.format(new Date(iso));
}
