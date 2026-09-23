/**
 * UEMS AP-16 IP-6/IP-12 — die Welt „Bewertung“ am Unternehmen: Umfang, Energieeinsätze, Rangliste und Einstufung.
 *
 * Reines Modul: jede Ableitung der Seiten `BewertungPage`/`EnergieeinsatzSeite` und ihrer Dialoge steht hier, damit sie
 * ohne DOM prüfbar ist. Zahlen und Kriterienurteile kommen aus der Ranglistenroute; das Portal formatiert sie nur.
 * Eine Einstufung entsteht ausschließlich durch die begründete Entscheidung einer Person (§8.4 M2).
 *
 * Rechte (R14): sehen mit `energieeinsatz.ansehen` am Unternehmen ODER an einem Standort; anlegen, ändern, beenden und
 * den Umfang festlegen nur mit `energieeinsatz.verwalten` am Unternehmen. Entscheiden tut weiter die Route.
 */
import {
  ApiError,
  type Bezugsgroesse,
  type BewertungUmfang,
  type BewertungUmfangAusschluss,
  type BewertungUmfangSpeichern,
  type BewertungKriterienFassung,
  type BewertungKriterienWerte,
  type BewertungRangliste,
  type BewertungRanglisteEinsatz,
  type EnergieeinsatzEinstufungFassung,
  type EnergieTraeger,
  type Energieeinsatz,
  type EnergieeinsatzAenderung,
  type EnergieeinsatzAnlegen,
  type EnergieeinsatzEinfluss,
  type EnergieeinsatzMessstelle,
  type EnergieeinsatzVerantwortlicher,
  type EnergieeinsatzVorschlag,
  type Prozess,
  type Selbstauskunft,
} from './api';
import type { BenutzerEintrag } from './benutzer';
import type { VpGruppe, VpOption } from './picker/optionen';
import { UEMS_BEWERTUNG, UEMS_BEWERTUNG_SAETZE, UEMS_BEWERTUNG_URTEILE, UEMS_EINSTUFUNGEN, UEMS_ENERGIEEINSAETZE, UEMS_ENERGIEEINSATZ } from './glossar';

// ------------------------------------------------------------------ Wörter

export const TITEL = UEMS_BEWERTUNG;
export const EINSAETZE_TITEL = UEMS_ENERGIEEINSAETZE;
export const LEER = UEMS_BEWERTUNG_SAETZE.leer();
export const LADEN = 'Energieeinsätze werden geladen …';
export const ANLEGEN_KNOPF = 'Energieeinsatz anlegen';
export const ANLEGEN_TITEL = 'Energieeinsatz anlegen';
export const BEARBEITEN_TITEL = 'Energieeinsatz bearbeiten';
export const UMFANG_TITEL = 'Umfang';
export const UMFANG_FESTLEGEN = 'Umfang festlegen';
export const UMFANG_AENDERN = 'Umfang ändern';
export const NUR_LESEN =
  'Energieeinsätze und Umfang anlegen oder ändern können Kundenadministratoren und Energiemanager. Sie sehen, was an Ihren Standorten gemessen wird.';
export const ZURUECK = 'Alle Energieeinsätze';
export const KEINE_WERTE = 'keine Werte';
export const KEINE_WERTE_SATZ =
  'Keine gemessene Messstelle dieses Trägers hat eine Menge im letzten vollen Monat — das ist keine Null.';
export const KEINE_MESSSTELLEN = 'Der Prozess hat heute keine Messstelle.';
export const OHNE_VERANTWORTLICH = 'noch niemand';
export const VERSUCHEN = 'Erneut versuchen';
export const SPEICHERN = 'Speichern';
export const ABBRECHEN = 'Abbrechen';
export const VERANTWORTLICH = 'Verantwortlich';
export const EINFLUSSGROESSEN = 'Einflussgrößen';
export const KEINE_EINFLUSSGROESSEN = 'Noch keine Einflussgrößen.';
export const VERBRAUCHER = 'Verbraucher';
export const PROZESS = 'Prozess';
export const TRAEGER = 'Träger';
export const MESSSTELLEN = 'Messstellen des Prozesses';
export const PROTOKOLL = 'Protokoll';
export const BEENDEN_KNOPF = 'Beenden';
export const BEENDEN_TITEL = 'Energieeinsatz beenden';
export const BEENDEN_SATZ =
  'Der Energieeinsatz bleibt mit seinem Protokoll lesbar; für denselben Prozess und Träger lässt sich danach ein neuer anlegen.';

/** Die Träger in der Reihenfolge des Vertrags (`BewertungUmfangSpeichern.traeger`). */
export const TRAEGER_ALLE: readonly EnergieTraeger[] = ['Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft'];

export const EINFLUSS_ARTEN: readonly { wert: EnergieeinsatzEinfluss['art']; label: string }[] = [
  { wert: 'produktion', label: 'Produktion' },
  { wert: 'betriebszeit', label: 'Betriebszeit' },
  { wert: 'wetter', label: 'Wetter' },
  { wert: 'sonstige', label: 'Sonstige' },
];

const ZUSTAND_MESSSTELLE: Record<string, string> = {
  entwurf: 'Entwurf',
  aktiv: 'aktiv',
  ruhend: 'ruhend',
  archiviert: 'archiviert',
};

// ------------------------------------------------------------------ Rechte

type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

/** Sieht die Person Energieeinsätze (an irgendeinem Standort oder am Unternehmen)? Unbekannt ist nein. */
export function darfAnsehen(s: Rechte | null | undefined): boolean {
  if (!s) return false;
  return s.unternehmen_rechte.includes('energieeinsatz.ansehen') || s.standorte.some((st) => st.rechte.includes('energieeinsatz.ansehen'));
}

/** Darf die Person anlegen, ändern, beenden und den Umfang festlegen? Nur am Unternehmen (KA U · EM U). */
export function darfVerwalten(s: Rechte | null | undefined): boolean {
  return !!s && s.unternehmen_rechte.includes('energieeinsatz.verwalten');
}

// ------------------------------------------------------------------ Datum

/** `2026-11-04` → `04.11.2026`; alles andere bleibt, wie es kam. */
export function tag(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** Ein Zeitpunkt der Route in Berliner Zeit: `04.11.2026, 10:12`. */
export function zeitpunkt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Heute als Kalendertag in Berlin (die Vorgabe der Routen). */
export function heute(jetzt: Date = new Date()): string {
  return jetzt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

// ------------------------------------------------------------------ Umfang

export const anlagenText = (n: number) => `${n} ${n === 1 ? 'Anlage' : 'Anlagen'}`;

export interface UmfangKarte {
  /** „Fassung 1 · gültig ab 04.11.2026“ oder der Vorschlag. */
  kopf: string;
  gespeichert: boolean;
  /** Je Standort: Name und die Anlagen im Umfang am Stichtag (nur die Zahl der Route). */
  standorte: { id: string; name: string; anlagen: string }[];
  /** „am 22.09.2026 im Umfang: 3 Anlagen“ — nur y, kein erfundenes x. */
  anlagen: string;
  traeger: string[];
  ausschluesse: string[];
  akteur: string | null;
  teilansicht: string | null;
}

export function traegerText(t: { name: EnergieTraeger; mit_anteil: boolean }): string {
  return t.mit_anteil ? `${t.name} (mit Anteil)` : `${t.name} (im Umfang, ohne Anteil)`;
}

const AUSSCHLUSS_ART: Record<BewertungUmfangAusschluss['art'], string> = {
  standort: 'Standort',
  anlage: 'Anlage',
  prozess: 'Prozess',
};

/** Ein Ausschluss als Satz; der Name kommt aus dem Umfang selbst, sonst aus `namen`, sonst die Art. */
export function ausschlussText(a: BewertungUmfangAusschluss, namen: ReadonlyMap<string, string>): string {
  const name = namen.get(a.verweis);
  return `${name ? `${AUSSCHLUSS_ART[a.art]} ${name}` : AUSSCHLUSS_ART[a.art]} ausgeschlossen — ${a.begruendung}`;
}

export function umfangKarte(u: BewertungUmfang, namen: ReadonlyMap<string, string> = new Map()): UmfangKarte {
  const gespeichert = u.fassung !== null;
  return {
    kopf: gespeichert
      ? `Fassung ${u.fassung} · gültig ab ${tag(u.gueltig_ab)}`
      : 'Noch nicht festgelegt — Vorschlag: alle Standorte, Träger Strom.',
    gespeichert,
    standorte: u.standorte.map((s) => ({ id: s.id, name: s.name, anlagen: anlagenText(s.anzahl_anlagen_im_umfang) })),
    anlagen: `am ${tag(u.am)} im Umfang: ${anlagenText(u.anzahl_anlagen_im_umfang)}`,
    traeger: u.traeger.map(traegerText),
    ausschluesse: u.ausschluesse.map((a) => ausschlussText(a, namen)),
    akteur: gespeichert && u.akteur ? `${u.akteur.name}${u.created_at ? ` · ${zeitpunkt(u.created_at)}` : ''}` : null,
    teilansicht: u.teilansicht ? 'Sie sehen den Umfang an Ihren Standorten.' : null,
  };
}

/** Das Formular des Umfang-Dialogs: aus der Fassung (oder der Vorgabe) vorbelegt. */
export interface UmfangEntwurf {
  gueltigAb: string;
  standortIds: string[];
  traeger: EnergieTraeger[];
  ausschluesse: { art: BewertungUmfangAusschluss['art']; verweis: string; begruendung: string }[];
  begruendung: string;
}

export function umfangEntwurf(u: BewertungUmfang, heuteTag: string): UmfangEntwurf {
  return {
    // Eine neue Fassung beginnt frühestens mit der letzten; ohne Fassung ist heute die Vorgabe.
    gueltigAb: u.gueltig_ab && u.gueltig_ab > heuteTag ? u.gueltig_ab : heuteTag,
    standortIds: u.standorte.map((s) => s.id),
    traeger: u.traeger.length > 0 ? u.traeger.map((t) => t.name) : ['Strom'],
    ausschluesse: u.ausschluesse.map((a) => ({ ...a })),
    begruendung: '',
  };
}

export interface UmfangPruefung {
  standorte?: string;
  traeger?: string;
  gueltigAb?: string;
  /** Je Ausschluss (Index) der fehlende Teil. */
  ausschluesse: Record<number, string>;
}

export function umfangPruefen(e: UmfangEntwurf): UmfangPruefung {
  const p: UmfangPruefung = { ausschluesse: {} };
  if (e.standortIds.length === 0) p.standorte = 'Bitte wählen Sie mindestens einen Standort.';
  if (e.traeger.length === 0) p.traeger = 'Bitte wählen Sie mindestens einen Träger.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.gueltigAb)) p.gueltigAb = 'Bitte geben Sie einen Tag an.';
  e.ausschluesse.forEach((a, i) => {
    if (!a.verweis) p.ausschluesse[i] = 'Bitte wählen Sie, was ausgeschlossen wird.';
    else if (!a.begruendung.trim()) p.ausschluesse[i] = 'Ein Ausschluss braucht eine Begründung.';
  });
  return p;
}

export const umfangOk = (p: UmfangPruefung) =>
  !p.standorte && !p.traeger && !p.gueltigAb && Object.keys(p.ausschluesse).length === 0;

export function umfangAnfrage(e: UmfangEntwurf): BewertungUmfangSpeichern {
  return {
    gueltig_ab: e.gueltigAb,
    standort_ids: e.standortIds,
    traeger: e.traeger,
    ausschluesse: e.ausschluesse.map((a) => ({ art: a.art, verweis: a.verweis, begruendung: a.begruendung.trim() })),
    begruendung: e.begruendung.trim() || null,
  };
}

// ------------------------------------------------------------------ Liste und Seite

/** Die Zustandszeile: „läuft seit 04.11.2026“ oder „beendet am 30.11.2026 — Grund“. */
export function zustandText(e: Pick<Energieeinsatz, 'gueltig_ab' | 'gueltig_bis' | 'beendet_am' | 'beendet_grund'>): string {
  if (e.beendet_am || e.gueltig_bis) {
    const bis = tag(e.gueltig_bis ?? e.beendet_am);
    return `beendet, letzter Tag ${bis}${e.beendet_grund ? ` — ${e.beendet_grund}` : ''}`;
  }
  return `läuft seit ${tag(e.gueltig_ab)}`;
}

export const laeuft = (e: Pick<Energieeinsatz, 'beendet_am' | 'gueltig_bis'>) => !e.beendet_am && !e.gueltig_bis;

/** „Peter Hollerbach“, mit Vermerk, wenn das Konto endete (R14: der Name bleibt). */
export function verantwortlichText(v: EnergieeinsatzVerantwortlicher | null | undefined): string {
  if (!v || (!v.name && !v.sub)) return OHNE_VERANTWORTLICH;
  const name = v.name ?? v.konto ?? OHNE_VERANTWORTLICH;
  return v.ohne_konto_seit ? `${name} (ohne Konto seit ${tag(v.ohne_konto_seit)})` : name;
}

export const prozessText = (p: { kennzeichen: string; name: string }) => `${p.kennzeichen} ${p.name}`;

export interface EinsatzZeile {
  id: string;
  kennzeichen: string;
  name: string;
  prozess: string;
  traeger: string;
  verantwortlich: string;
  zustand: string;
  laeuft: boolean;
  messstellen: string;
  keineWerte: boolean;
}

export function einsatzZeile(e: Energieeinsatz): EinsatzZeile {
  const n = e.messstellen.length;
  return {
    id: e.id,
    kennzeichen: e.kennzeichen,
    name: e.name,
    prozess: prozessText(e.prozess),
    traeger: e.traeger,
    verantwortlich: `${VERANTWORTLICH}: ${verantwortlichText(e.verantwortlich)}`,
    zustand: zustandText(e),
    laeuft: laeuft(e),
    messstellen: n === 0 ? 'keine Messstelle' : `${n} ${n === 1 ? 'Messstelle' : 'Messstellen'}`,
    keineWerte: e.keine_werte,
  };
}

/** Der jüngste Ort einer Messstelle (Bereich vor Gebäude vor Standort) — nur das Kennzeichen der Route. */
export function messstelleOrt(m: EnergieeinsatzMessstelle): string {
  const offen = m.orte.filter((o) => o.gueltig_bis === null);
  const rang = { bereich: 0, gebaeude: 1, standort: 2, unternehmen: 3 } as const;
  const ort = [...(offen.length ? offen : m.orte)].sort((a, b) => rang[a.ort_art] - rang[b.ort_art])[0];
  return ort ? ort.kennzeichen : 'ohne Ort';
}

export const messstelleZustand = (m: EnergieeinsatzMessstelle) => ZUSTAND_MESSSTELLE[m.zustand] ?? m.zustand;

/** Eine Einflussgröße als Zeile: „Produktion: Stückzahl Spritzguss (BZ-1)“ oder „Wetter: Außentemperatur“. */
export function einflussText(e: EnergieeinsatzEinfluss): string {
  const art = EINFLUSS_ARTEN.find((a) => a.wert === e.art)?.label ?? e.art;
  if (e.bezugsgroesse_id) {
    const b = e.bezugsgroesse;
    return `${art}: ${b ? `${b.name} (${b.kennzeichen})` : 'Bezugsgröße'}`;
  }
  return `${art}: ${e.wortlaut ?? ''}`;
}

const PROTOKOLL_ART: Record<EnergieeinsatzAenderung['art'], string> = {
  angelegt: 'angelegt',
  bearbeitet: 'bearbeitet',
  verantwortlicher: 'Verantwortlichen geändert',
  einflussgroessen: 'Einflussgrößen geändert',
  beendet: 'beendet',
};

/** „angelegt · Ines Kaltenbach · 04.11.2026, 10:12“ — jede Änderung mit Akteur (§5.1 Schritt 4). */
export function protokollZeile(a: EnergieeinsatzAenderung): string {
  return [PROTOKOLL_ART[a.art] ?? a.art, a.akteur?.name, zeitpunkt(a.zeit)].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ Anlegen

export const VORSCHLAG_GRUPPE = 'vorschlag';
export const WEITERE_GRUPPE = 'weitere';
export const PROZESS_GRUPPEN: VpGruppe[] = [
  { key: VORSCHLAG_GRUPPE, label: 'Vorschlag — noch ohne Energieeinsatz' },
  { key: WEITERE_GRUPPE, label: 'Weitere Prozesse' },
];

/**
 * Der Prozess-Picker: ein Prozess ohne Einsatz steht als Vorschlag oben (§5.1 Schritt 3); einer mit laufendem Einsatz
 * für den gewählten Träger bleibt sichtbar, ist aber gesperrt und nennt den Einsatz (B1). Beendete Prozesse fehlen.
 */
export function prozessOptionen(
  prozesse: readonly Prozess[],
  vorschlaege: readonly EnergieeinsatzVorschlag[],
  einsaetze: readonly Energieeinsatz[],
  traeger: EnergieTraeger,
): VpOption[] {
  const vorgeschlagen = new Set(vorschlaege.map((v) => v.prozess.id));
  return prozesse
    .filter((p) => p.gueltig_bis === null)
    .map((p) => {
      const laufend = einsaetze.find((e) => e.prozess.id === p.id && e.traeger === traeger && laeuft(e));
      const ohneEinsatz = !einsaetze.some((e) => e.prozess.id === p.id && laeuft(e));
      return {
        value: p.id,
        label: p.name,
        sub: p.kennzeichen,
        group: vorgeschlagen.has(p.id) || ohneEinsatz ? VORSCHLAG_GRUPPE : WEITERE_GRUPPE,
        keywords: p.kennzeichen,
        disabled: laufend !== undefined,
        disabledHint: laufend ? `läuft bereits: ${laufend.kennzeichen} ${laufend.name}` : null,
      };
    });
}

/** Die Verantwortlichen: Personen des Kundenbereichs mit Konto; ein entferntes Konto ist keine Wahl mehr. */
export function verantwortlichOptionen(benutzer: readonly BenutzerEintrag[]): VpOption[] {
  return benutzer
    .filter((b) => b.zustand !== 'entfernt')
    .map((b) => ({ value: b.sub, label: b.anzeigename, sub: b.email, keywords: b.email }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

export function bezugsgroesseOptionen(liste: readonly Bezugsgroesse[]): VpOption[] {
  return liste
    .filter((b) => b.archiviert_am === null)
    .map((b) => ({ value: b.id, label: b.name, sub: `${b.kennzeichen} · ${b.einheit}`, keywords: b.kennzeichen }));
}

export interface EinflussEntwurf {
  art: EnergieeinsatzEinfluss['art'];
  quelle: 'bezugsgroesse' | 'wortlaut';
  bezugsgroesseId: string | null;
  wortlaut: string;
}

export const neuerEinfluss = (): EinflussEntwurf => ({ art: 'produktion', quelle: 'bezugsgroesse', bezugsgroesseId: null, wortlaut: '' });

export const einflussEntwurf = (e: EnergieeinsatzEinfluss): EinflussEntwurf => ({
  art: e.art,
  quelle: e.bezugsgroesse_id ? 'bezugsgroesse' : 'wortlaut',
  bezugsgroesseId: e.bezugsgroesse_id ?? null,
  wortlaut: e.wortlaut ?? '',
});

/** Genau ein Verweis ODER ein Wortlaut (Vertrag `EnergieeinsatzEinfluss`). */
export function einflussAnfrage(e: EinflussEntwurf): EnergieeinsatzEinfluss {
  return e.quelle === 'bezugsgroesse'
    ? { art: e.art, bezugsgroesse_id: e.bezugsgroesseId, wortlaut: null }
    : { art: e.art, bezugsgroesse_id: null, wortlaut: e.wortlaut.trim() };
}

export const einflussFehlt = (e: EinflussEntwurf) =>
  e.quelle === 'bezugsgroesse' ? !e.bezugsgroesseId : !e.wortlaut.trim();

export interface EinsatzEntwurf {
  prozessId: string | null;
  traeger: EnergieTraeger;
  name: string;
  verbraucher: string;
  verantwortlichSub: string | null;
  einfluesse: EinflussEntwurf[];
}

export const leererEntwurf = (): EinsatzEntwurf => ({
  prozessId: null,
  traeger: 'Strom',
  name: '',
  verbraucher: '',
  verantwortlichSub: null,
  einfluesse: [],
});

export interface EinsatzPruefung {
  prozess?: string;
  name?: string;
  einfluesse: Record<number, string>;
}

export function einsatzPruefen(e: EinsatzEntwurf, mitProzess = true): EinsatzPruefung {
  const p: EinsatzPruefung = { einfluesse: {} };
  if (mitProzess && !e.prozessId) p.prozess = 'Bitte wählen Sie einen Prozess.';
  if (!e.name.trim()) p.name = 'Bitte geben Sie einen Namen an.';
  e.einfluesse.forEach((x, i) => {
    if (einflussFehlt(x))
      p.einfluesse[i] = x.quelle === 'bezugsgroesse' ? 'Bitte wählen Sie eine Bezugsgröße.' : 'Bitte beschreiben Sie die Einflussgröße.';
  });
  return p;
}

export const einsatzOk = (p: EinsatzPruefung) => !p.prozess && !p.name && Object.keys(p.einfluesse).length === 0;

export function einsatzAnfrage(e: EinsatzEntwurf): EnergieeinsatzAnlegen {
  return {
    prozess_id: e.prozessId ?? '',
    traeger: e.traeger,
    name: e.name.trim(),
    verbraucher_wortlaut: e.verbraucher.trim() || null,
    verantwortlich_sub: e.verantwortlichSub,
    einflussgroessen: e.einfluesse.map(einflussAnfrage),
  };
}

/** Der Name, den das Formular vorschlägt, sobald ein Prozess gewählt ist und noch kein Name steht. */
export const namensVorschlag = (prozess: Pick<Prozess, 'name'> | undefined, traeger: EnergieTraeger) =>
  prozess ? (traeger === 'Strom' ? prozess.name : `${prozess.name} (${traeger})`) : '';

// ------------------------------------------------------------------ Ablehnungen

const code = (e: unknown): string | null =>
  e instanceof ApiError && e.body && typeof e.body === 'object' && typeof (e.body as { code?: unknown }).code === 'string'
    ? (e.body as { code: string }).code
    : null;

/**
 * Eine Ablehnung als Satz. „Zweiter laufender Einsatz“ (409 `einsatz_laeuft_bereits`, B1) nennt den laufenden Einsatz,
 * wenn die Liste ihn kennt; sonst spricht die Route ihren eigenen Satz.
 */
export function ablehnung(
  e: unknown,
  kontext?: { prozess?: { id: string; name: string }; traeger?: EnergieTraeger; einsaetze?: readonly Energieeinsatz[] },
): string {
  const c = code(e);
  if (c === 'einsatz_laeuft_bereits') {
    const laufend = kontext?.einsaetze?.find(
      (x) => x.prozess.id === kontext.prozess?.id && x.traeger === kontext.traeger && laeuft(x),
    );
    const wo = kontext?.prozess && kontext.traeger ? `„${kontext.prozess.name}“ mit ${kontext.traeger}` : 'diesen Prozess und Träger';
    return laufend
      ? `Für ${wo} läuft schon ${laufend.kennzeichen} ${laufend.name}. Ein Prozess hat je Träger nur einen laufenden ${UEMS_ENERGIEEINSATZ} — beenden Sie ihn zuerst oder wählen Sie einen anderen Träger.`
      : `Für ${wo} läuft schon ein ${UEMS_ENERGIEEINSATZ}. Beenden Sie ihn zuerst oder wählen Sie einen anderen Träger.`;
  }
  if (c === 'recht_fehlt' || (e instanceof ApiError && e.status === 403))
    return 'Das dürfen Kundenadministratoren und Energiemanager.';
  if (e instanceof ApiError && e.status === 404) return 'Diesen Energieeinsatz gibt es hier nicht.';
  if (e instanceof ApiError && e.message) return e.message;
  return 'Das hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.';
}

/** Ein Ladefehler der Liste: 404/403 sind endgültig (kein „Erneut versuchen“), der Rest nicht. */
export function ladeFehler(e: unknown): { satz: string; erneut: boolean } {
  if (e instanceof ApiError && (e.status === 403 || e.status === 404))
    return { satz: 'Die Bewertung ist für Ihr Konto nicht verfügbar.', erneut: false };
  return { satz: 'Die Energieeinsätze konnten nicht geladen werden.', erneut: true };
}

// ------------------------------------------------------------------ Rangliste, Einstufung und Kriterien (AP-16 IP-12)

/** Der letzte abgeschlossene Kalendermonat in der Unternehmenszeitzone. */
export function bewertungZeitraum(jetzt: Date = new Date()) {
  const teile = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' })
    .formatToParts(jetzt).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  const ersterDieser = new Date(Date.UTC(Number(teile.year), Number(teile.month) - 1, 1));
  const letzter = new Date(ersterDieser.getTime() - 86_400_000);
  const y = letzter.getUTCFullYear(), m = String(letzter.getUTCMonth() + 1).padStart(2, '0');
  const bis = `${y}-${m}-${String(new Date(Date.UTC(y, letzter.getUTCMonth() + 1, 0)).getUTCDate()).padStart(2, '0')}`;
  return { von: `${y}-${m}-01`, bis, label: letzter.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

export const zahlMitEinheit = (wert: string | null, einheit: string | null) => {
  if (wert === null) return 'keine Werte';
  const n = Number(wert);
  const stellen = einheit === 'kWh' ? 0 : 1;
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen })}\u00a0${einheit ?? ''}`.trim();
};

export const prozentText = (wert: string | null) => wert === null ? '—' : `${Number(wert).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0%`;
export const urteilText = (wert: string) => UEMS_BEWERTUNG_URTEILE[wert as keyof typeof UEMS_BEWERTUNG_URTEILE] ?? wert;
export const vorschlagText = (wert: BewertungRanglisteEinsatz['vorschlag']) => wert === 'ueber_schwelle' ? 'über Schwelle' : 'unter Schwelle';
export const einstufungText = (wert: EnergieeinsatzEinstufungFassung['einstufung']) => UEMS_EINSTUFUNGEN[wert];

export function ranglisteKopf(r: BewertungRangliste, label: string) {
  if (r.nenner.wert === null || r.abdeckung_prozent === null) return `Stromeinsatz ${label}: ohne vollständigen Nenner · ${r.nenner.anlagen} Anlagen.`;
  return UEMS_BEWERTUNG_SAETZE.ranglisteKopf(label.split(' ')[0], Number(label.split(' ')[1]), Number(r.nenner.wert), r.nenner.vorhanden, r.nenner.gesamt, Number(r.abdeckung_prozent));
}

export function groessterRest(r: BewertungRangliste) {
  return r.anlagen.filter((a) => a.rest !== null).sort((a, b) => Number(b.rest) - Number(a.rest))[0] ?? null;
}

export const darfEinstufen = (s: Rechte | null | undefined) => !!s && s.unternehmen_rechte.includes('energieeinsatz.einstufen');
export const darfKriterienAendern = (s: Rechte | null | undefined) => !!s && s.unternehmen_rechte.includes('bewertung.kriterien');

export const KRITERIEN_NAMEN: Record<keyof BewertungKriterienWerte, string> = {
  K1: 'K1 · Anteil am Stromeinsatz', K2: 'K2 · Kumulierter Block', K3: 'K3 · Jahresmenge',
  K5: 'K5 · Datenlage', K6: 'K6 · Ersatzwert-Anteil', K7: 'K7 · Volle Monate',
  K8: 'K8 · Messabdeckung', mindest_monate: 'K7 · Vorläufig bis',
};
export const KRITERIEN_EINHEIT: Record<keyof BewertungKriterienWerte, string> = {
  K1: '%', K2: '%', K3: 'kWh', K5: '%', K6: '%', K7: 'Monate', K8: '%', mindest_monate: 'Monate',
};
export const kriterienStarttext = (f: BewertungKriterienFassung, key: keyof BewertungKriterienWerte) => `${f.werte[key]} ${KRITERIEN_EINHEIT[key]}`;
