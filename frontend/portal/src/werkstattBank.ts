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
import { geraetName, type WerkstattAbnahme, type WerkstattBox } from './werkstatt';
import { zeitpunkt } from './adminFernwartung';
import { fallSeite, type FallSeite } from './werkstattLauf';
import { istPfc200, PFC200, PFC200_NAME, PHASEN_PFC200, SCHRITTE_PFC200, type EdgeIndustrieFassung } from './werkstattPfc200';

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

/**
 * Die Freigabe für den WAGO PFC200 in der Ansicht (`freigabe_pfc200.freigabe`): `edge_industrie` statt `openwrt`
 * und `edge_light`.
 */
export interface FreigabeDateiPfc200 {
  kennung: string;
  box_art: string;
  gueltig_bis: string;
  edge_industrie: { fassung: string; quelle?: string; programm_sha256?: string; skripte_sha256?: string; wartung_sha256?: string };
}

/** Ein Gerät, das die Werkstatt einrichtet (`lauf.box_art`, `anschluss_geraet`). */
export type Geraet = 'mango' | 'pfc200';

/** Das Gerät eines Laufs oder einer Angabe des Dienstes: alles außer `pfc200` ist die Mango. */
export function geraetVon(boxArt: string | null | undefined): Geraet {
  return istPfc200(boxArt) ? PFC200 : 'mango';
}

/** Wie das Gerät an der Werkbank heißt. */
export function geraetWort(geraet: Geraet): string {
  return geraet === PFC200 ? PFC200_NAME : 'Mango';
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
  /** Additiv: die Freigabe für den PFC200. Fehlt, solange der Dienst keine PFC200 einrichtet. */
  freigabe_pfc200?: { laufend: boolean; grund?: string; freigabe?: FreigabeDateiPfc200 | null; boxen: number } | null;
  /** Additiv: `mango` oder `pfc200`, sobald der Dienst das Gerät am Anschluss an seiner Adresse erkennt. */
  anschluss_geraet?: string;
  anschluss?: string;
  /** Code des Zustands am Anschluss, solange kein Lauf arbeitet (Vertrag, „Fälle am Anschluss“). */
  anschluss_fall?: string;
  anschluss_loesung?: Loesung | null;
  lauf?: LaufStand | null;
  /** Box-Druckdateien, die im Portal noch nicht liegen (additiv, vp-mango-3mf-pro-box). */
  gehaeuse?: GehaeuseAuftragAnsicht[];
}

/** Ein offener Gehäuse-Auftrag der Ansicht (noch keine Druckdatei im Portal). */
export interface GehaeuseAuftragAnsicht {
  referenz: string;
  zustand: 'wartet' | 'baut' | 'fertig' | 'fehler';
  grund?: string;
  bestellt: string;
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

/**
 * Eine Freigabe der Werkstatt (`/api/v1/admin/werkstatt/freigaben`): der Beleg, was wann galt. Seit 16.11.2026 legt
 * sie die Regel „neueste Fassung“ selbst an (`quelle: 'regel'`, mit dem Release im Register); die von Hand davor
 * (`'formular'`) bleiben lesbar.
 */
export interface WerkstattFreigabe {
  id: string;
  kennung: string;
  /** Das Gerät der Zeile: `mango` (hier immer; die Zeilen des PFC200 sind {@link WerkstattFreigabePfc200}). */
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
  /** Fehlt bei einer API vor der Regel: dann war jede von Hand. */
  quelle?: 'regel' | 'formular';
  edgeReleaseSeq?: number | null;
}

/**
 * Eine Freigabe für den PFC200 (`/api/v1/admin/werkstatt/freigaben?geraet=pfc200`): kein OpenWrt-Abbild, und
 * `edgeLight` trägt die Edge-Industrie-Fassung mit dem Tunnel-Programm.
 */
export interface WerkstattFreigabePfc200 extends Omit<WerkstattFreigabe, 'openwrt' | 'edgeLight'> {
  openwrt: null;
  edgeLight: EdgeIndustrieFassung;
}

/** Nur die Zeilen des PFC200: Eine API vor dem Gerät `pfc200` übergeht `?geraet=` und liefert die der Mango. */
export function liesFreigabenPfc200(liste: unknown): WerkstattFreigabePfc200[] {
  if (!Array.isArray(liste)) return [];
  return (liste as { boxArt?: unknown; openwrt?: unknown }[]).filter((f) => f?.boxArt === PFC200 && f.openwrt == null) as WerkstattFreigabePfc200[];
}

/** Ein Eintrag im Protokoll von „Werkstatt anhalten“ und „Werkstatt fortsetzen“. */
export interface WerkstattBetrieb {
  angehalten: boolean;
  grund: string | null;
  am: string;
  von: string;
}

/**
 * Der Stand der Werkstatt (`/api/v1/admin/werkstatt/regel`): Sie nimmt immer die neueste Fassung und läuft, bis
 * jemand sie anhält. `grund`: warum sie nicht nach der Regel läuft. `edgeLight` mit `releaseSeq`: die neueste
 * Fassung, wenn sie passt; `openwrt` steht fest im Code. `freigabe`: die Zeile, die der Dienst gerade bekommt
 * (`vonHand`: eine Freigabe von Hand im Übergang). `heute`: Boxen, die heute angemeldet wurden.
 */
export interface WerkstattRegel {
  zustand: 'laeuft' | 'angehalten' | 'wartet';
  grund: string | null;
  neueste: string | null;
  openwrt: { fassung: string; datei: string; sha256: string; quelle: string };
  edgeLight: { fassung: string; quelle: string; programmSha256: string; skripteSha256: string } | null;
  releaseSeq: number | null;
  freigabe: string | null;
  vonHand: boolean;
  heute: number;
  tagesgrenze: number;
  angehalten: WerkstattBetrieb | null;
  verlauf: WerkstattBetrieb[];
}

/** Was die Karte oben über die Werkstatt sagt: ein Zustand, eine Zeile, ein Knopf. */
export interface WerkstattStand {
  zustand: WerkstattRegel['zustand'];
  titel: string;
  badge: { text: string; variant: 'ok' | 'warn' };
  zeile: string;
  knopf: 'anhalten' | 'fortsetzen';
}

/** „2026.11.13“ aus „edge-light-2026.11.13“. */
export function edgeLightKurz(fassung: string): string {
  return fassung.replace(/^edge-light-/, '');
}

/**
 * Die Karte oben in der Übersicht: läuft (mit dem, was gerade aufgespielt wird, und wie viele Boxen heute),
 * angehalten (von wem, wann, warum) oder wartet (warum). Im Übergang läuft sie mit der Freigabe von Hand.
 */
export function werkstattStand(r: WerkstattRegel, freigaben: readonly WerkstattFreigabe[], jetzt: Date): WerkstattStand {
  const heute = `heute ${r.heute} von ${r.tagesgrenze} Boxen`;
  if (r.zustand === 'angehalten') {
    const a = r.angehalten;
    const wer = a ? `von ${a.von}, ${zeitpunkt(a.am, jetzt)}` : '';
    return {
      zustand: 'angehalten',
      titel: 'Werkstatt',
      badge: { text: 'angehalten', variant: 'warn' },
      zeile: [wer, a?.grund ? `„${a.grund}“` : null].filter(Boolean).join(' · ') || 'Bis du sie fortsetzt, richtet der Dienst keine Box ein.',
      knopf: 'fortsetzen',
    };
  }
  if (r.zustand === 'wartet') {
    return {
      zustand: 'wartet',
      titel: 'Werkstatt',
      badge: { text: 'wartet', variant: 'warn' },
      zeile: r.grund ?? 'Gerade passt keine Fassung.',
      knopf: 'anhalten',
    };
  }
  const vonHand = r.vonHand ? freigaben.find((f) => f.kennung === r.freigabe) ?? null : null;
  if (vonHand) {
    return {
      zustand: 'laeuft',
      titel: `Werkstatt noch mit ${vonHand.kennung}`,
      badge: { text: 'läuft', variant: 'ok' },
      zeile: `${freigabeZeile(vonHand)} · ${heute}`,
      knopf: 'anhalten',
    };
  }
  const edge = r.edgeLight ? `Edge Light ${edgeLightKurz(r.edgeLight.fassung)}` : 'Edge Light: neueste Fassung';
  return {
    zustand: 'laeuft',
    titel: 'Werkstatt nimmt die neueste Fassung',
    badge: { text: 'läuft', variant: 'ok' },
    zeile: `${edge} · OpenWrt ${r.openwrt.fassung} · ${heute}`,
    knopf: 'anhalten',
  };
}

/** Eine Freigabe in der Liste: die der Regel mit ihrem Release, die von Hand mit ihrem Ende. */
export function freigabeListenZeile(f: WerkstattFreigabe): string {
  if (f.quelle === 'regel') {
    return `Regel · Edge Light ${edgeLightKurz(f.edgeLight.fassung)} · OpenWrt ${f.openwrt.fassung}`
      + (f.edgeReleaseSeq != null ? ` · Release ${f.edgeReleaseSeq}` : '');
  }
  return `von Hand (${f.erteiltVon}) · ${freigabeZeile(f)}`;
}

/** Eine Prüfsumme kurz: die ersten 12 Zeichen. */
export function kurzSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
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
  { id: 'einrichten', titel: 'Einrichten', klein: 'Passwort, Notfall-Schlüssel, Programm, Einrichtungs-WLAN', schritte: ['internet', 'passwort', 'notfall', 'programm', 'einrichtung_wlan'] },
  { id: 'anmelden', titel: 'Bei VoltPilot anmelden', klein: 'Geräteschlüssel und Wartungstunnel', schritte: ['tunnel_schluessel', 'einloesen', 'tunnel_adresse', 'tunnel'] },
  { id: 'probe', titel: 'Probe über den Wartungstunnel', klein: 'Netz der Box, Neustart, Anmeldung über den Tunnel', schritte: ['lan', 'neustart', 'probe'] },
  { id: 'abnahme', titel: 'Abnahme', klein: 'Alle zehn Prüfungen mit Beleg', schritte: ['internet_weg', 'uebergabe'] },
] as const;

/** Die Schritte des Dienstes in ihrer Reihenfolge. */
export const SCHRITTE: readonly string[] = PHASEN.flatMap((p) => p.schritte);

/** Eine Phase eines Laufs: ihre Schritte stehen im Lauf hintereinander. */
export interface PhaseDef {
  id: string;
  titel: string;
  klein: string;
  schritte: readonly string[];
}

/** Die Phasen eines Laufs an diesem Gerät (`lauf.box_art`): die Mango, oder der PFC200 mit seinen eigenen. */
export function phasenFuer(boxArt: string | null | undefined): readonly PhaseDef[] {
  return istPfc200(boxArt) ? PHASEN_PFC200 : PHASEN;
}

/** Die Schritte eines Laufs an diesem Gerät, in ihrer Reihenfolge. */
export function schritteFuer(boxArt: string | null | undefined): readonly string[] {
  return istPfc200(boxArt) ? SCHRITTE_PFC200 : SCHRITTE;
}

/** Ungefähre Dauer je Schritt in Minuten an der Mango (PS-3 misst nach); die Lauf-Seite nimmt gemessene Dauern, wenn es sie gibt. */
export const MINUTEN: Record<string, number> = {
  erkennen: 0.5, fassungen: 1, openwrt: 2, wiedererkennen: 4, internet: 0.5, passwort: 0.5, notfall: 0.3,
  programm: 2, einrichtung_wlan: 0.5, tunnel_schluessel: 0.3, einloesen: 0.3, tunnel_adresse: 0.3, tunnel: 1, lan: 0.5, neustart: 3,
  probe: 1.5, internet_weg: 0.3, uebergabe: 0.2,
};

/** Wo der Lauf steht: Index des laufenden Schritts; fertig = alles; unbekannt = nach dem letzten erledigten. */
function stelle(s: LaufStand): number {
  const schritte = schritteFuer(s.box_art);
  if (s.zustand === 'fertig') return schritte.length;
  const i = s.schritt ? schritte.indexOf(s.schritt) : -1;
  if (i >= 0) return i;
  return Math.max(-1, ...s.erledigt.map((e) => schritte.indexOf(e))) + 1;
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
  const schritte = schritteFuer(s.box_art);
  return phasenFuer(s.box_art).map((p) => {
    const idx = p.schritte.map((x) => schritte.indexOf(x));
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

/**
 * Restzeit in ganzen Minuten (mindestens 1, solange nicht fertig) und Anteil 0..1.
 *
 * Für die Mango aus den festen Schätzungen (`MINUTEN`). Für den PFC200 gibt es keine Schätzung: Der Anteil zählt
 * die Schritte, und eine Restzeit gibt es erst, wenn `meist` für jeden offenen Schritt eine gemessene Dauer aus
 * früheren Läufen trägt (`werkstattLauf.meistDauer`); sonst ist sie `null` und die Seite nennt keine Zahl.
 */
export function fortschritt(s: LaufStand, meist?: Record<string, number>): { restMinuten: number | null; anteil: number } {
  if (s.zustand === 'fertig') return { restMinuten: 0, anteil: 1 };
  const i = stelle(s);
  if (istPfc200(s.box_art)) {
    const liste = SCHRITTE_PFC200.filter((x) => zaehlt(s, x));
    const offen = SCHRITTE_PFC200.filter((x, n) => n >= i && zaehlt(s, x));
    const gemessen = offen.every((x) => typeof meist?.[x] === 'number');
    const restSek = gemessen ? offen.reduce((a, x) => a + (meist?.[x] ?? 0), 0) : null;
    return {
      restMinuten: restSek == null ? null : Math.max(1, Math.ceil(restSek / 60)),
      anteil: liste.length > 0 ? (liste.length - offen.length) / liste.length : 0,
    };
  }
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
      /** Das Gerät, das an der Werkbank gewählt ist. */
      geraet: Geraet;
      kabel: boolean | null;
      meldetSich: boolean;
      freigegeben: boolean;
      grund: string | null;
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
  /** Welches (fehlt: die Mango). Ein Lauf zeigt immer sein eigenes Gerät, gleich was gewählt ist. */
  geraet?: Geraet;
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
        // Wartet der Lauf auf einen Handgriff am Gerät, nach dem er von selbst weitermacht (PFC200: Schalter auf
        // RUN, Kabel in X2), nennt der Dienst Fall und Lösung schon jetzt: dieselbe Seite wie für einen Fall.
        if (lauf.fall && lauf.loesung) {
          return { art: 'fall', lauf, seite: fallSeite({ code: lauf.fall, loesung: lauf.loesung, wo: 'lauf', ansicht: a, lauf, geraet: e.geraet }) };
        }
        return { art: 'du', lauf };
      case 'angehalten':
        if (kabel !== false) {
          return { art: 'fall', lauf, seite: fallSeite({ code: lauf.fall, loesung: lauf.loesung, wo: 'lauf', ansicht: a, lauf, geraet: e.geraet }) };
        }
        break;
      case 'fertig':
        if (kabel !== false) return { art: 'fertig', lauf };
        break;
    }
  }
  if (a.anschluss_fall && a.anschluss_loesung && !SCHON_GEZEIGT.has(a.anschluss_fall)) {
    return { art: 'fall', lauf: null, seite: fallSeite({ code: a.anschluss_fall, loesung: a.anschluss_loesung, wo: 'anschluss', ansicht: a, lauf: null, geraet: e.geraet }) };
  }
  const geraet: Geraet = e.geraet ?? 'mango';
  const antwortet = (a.werkbank.status?.antworten ?? []).some((x) => (x.macs ?? []).length > 0);
  // Für den PFC200 gilt seine eigene Freigabe; fehlt sie, richtet der Dienst keine PFC200 ein.
  const f = geraet === PFC200 ? a.freigabe_pfc200 ?? { laufend: false, grund: 'Der Werkstatt-Dienst richtet hier keine PFC200 ein.' } : a.freigabe;
  return {
    art: 'anschliessen',
    geraet,
    kabel,
    // Nennt der Dienst das Gerät am Kabel, zählt nur das gewählte: Eine Mango ist kein PFC200.
    meldetSich: antwortet && (!a.anschluss_geraet || geraetVon(a.anschluss_geraet) === geraet),
    freigegeben: f.laufend,
    grund: f.laufend ? null : f.grund ?? 'Die Werkstatt richtet gerade keine Box ein.',
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
  /** Das Gerät des Laufs, in Worten: „Mango“ oder „PFC200“. */
  geraet: string;
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
      geraet: geraetWort(geraetVon(l.stand.box_art ?? l.boxArt)),
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
    const geraet = geraetName(b.boxArt);
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
      box: null, geraet: geraetWort(geraetVon(l.stand.box_art ?? l.boxArt)), stand: 'laeuft', text: `${aktuellePhase(l.stand)?.titel ?? 'läuft'} (${Math.round(fortschritt(l.stand).anteil * 100)} %)`,
      seit: l.beginn, lauf: l, abnahme: null,
    })),
    ...zeilen.sort((x, y) => (y.seit > x.seit ? 1 : y.seit < x.seit ? -1 : 0)),
  ];
}

export function uhrzeit(iso: string): string {
  return UHR.format(new Date(iso));
}
