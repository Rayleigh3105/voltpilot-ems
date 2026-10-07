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
  type Bericht,
  type Bezugsgroesse,
  type BewertungUmfang,
  type BewertungUmfangAusschluss,
  type BewertungUmfangSpeichern,
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
import { UEMS_BEWERTUNG_URTEILE, UEMS_EINSTUFUNGEN, UEMS_ENERGIEEINSATZ } from './glossar';

// ------------------------------------------------------------------ Wörter

export const LADEN = 'Energieeinsätze werden geladen …';
export const ANLEGEN_KNOPF = 'Energieeinsatz anlegen';
export const ANLEGEN_TITEL = 'Energieeinsatz anlegen';
export const BEARBEITEN_TITEL = 'Energieeinsatz bearbeiten';
export const UMFANG_TITEL = 'Umfang';
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

const MONAT_JAHR = (y: number, m: number): string =>
  new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONATSENDE = (y: number, m: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

/**
 * Der Zeitraum von Rangliste und Messabdeckung (Konzept Auswerten a1, Befund 2): die Datengrundlage der energetischen
 * Bewertung (`zeitraum` „2028-04/2029-03“ eines Berichts mit `zeitraum_art` `datengrundlage`). Ohne Bewertung rechnet er
 * wie der Server beim Anlegen einer Bewertung: die zwölf vollen Monate bis zum Vormonat in der Unternehmenszeitzone
 * (`BerichtService.anlegen`). Nie ein einzelner Monat - die Kriterien verlangen mehrere Monate (K7), ein Monat bliebe
 * immer „vorläufig“.
 */
export function bewertungZeitraum(
  bericht?: Pick<Bericht, 'zeitraum' | 'zeitraum_art' | 'zeitraum_text'> | null,
  jetzt: Date = new Date(),
): { von: string; bis: string; label: string } {
  const dg = bericht?.zeitraum_art === 'datengrundlage' ? /^(\d{4})-(\d{2})(?:\/(\d{4})-(\d{2}))?$/.exec(bericht.zeitraum) : null;
  if (bericht && dg) {
    const [, vj, vm, bj = vj, bm = vm] = dg;
    return { von: `${vj}-${vm}-01`, bis: MONATSENDE(Number(bj), Number(bm)), label: bericht.zeitraum_text };
  }
  const teile = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' })
    .formatToParts(jetzt).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  // Der Vormonat ist der letzte volle Monat; elf Monate davor beginnt die Datengrundlage.
  const bisIndex = Number(teile.year) * 12 + (Number(teile.month) - 1) - 1;
  const vonIndex = bisIndex - 11;
  const [vj, vm] = [Math.floor(vonIndex / 12), (vonIndex % 12) + 1];
  const [bj, bm] = [Math.floor(bisIndex / 12), (bisIndex % 12) + 1];
  return {
    von: `${vj}-${String(vm).padStart(2, '0')}-01`,
    bis: MONATSENDE(bj, bm),
    label: `${MONAT_JAHR(vj, vm)} bis ${MONAT_JAHR(bj, bm)}`,
  };
}

export const zahlMitEinheit = (wert: string | null, einheit: string | null) => {
  if (wert === null) return 'keine Werte';
  const n = Number(wert);
  const stellen = einheit === 'kWh' ? 0 : 1;
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen })}\u00a0${einheit ?? ''}`.trim();
};

export const prozentText = (wert: string | null) => wert === null ? '—' : `${Number(wert).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0%`;
export const urteilText = (wert: string) => UEMS_BEWERTUNG_URTEILE[wert as keyof typeof UEMS_BEWERTUNG_URTEILE] ?? wert;
export const einstufungText = (wert: EnergieeinsatzEinstufungFassung['einstufung']) => UEMS_EINSTUFUNGEN[wert];


export const darfEinstufen = (s: Rechte | null | undefined) => !!s && s.unternehmen_rechte.includes('energieeinsatz.einstufen');
export const darfKriterienAendern = (s: Rechte | null | undefined) => !!s && s.unternehmen_rechte.includes('bewertung.kriterien');


