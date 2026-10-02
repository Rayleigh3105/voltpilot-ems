/**
 * Der Förderweg je Einspeisestelle als Kundenfläche (MiSpeL MP-17, Bedienkonzept BK-17 Variante A, abgestimmt am
 * 02.10.2026). Rein, ohne React: die Zeile „Förderweg“ in Anlage › Einstellungen, die Zeile „Netzladen“ und der Dialog
 * „Förderweg ändern“ (`components/FoerderwegDialog.tsx`) rendern daraus.
 *
 * Vertrag: `docs/contracts/v2/mispel-foerderweg.md` (Fassung 1.2) und `mispel-zaehlerrolle.md`. Begriffe, Formelsätze
 * und Fundstellen wörtlich nach der Festlegung der Bundesnetzagentur (Az. 618-25-02, Beschluss 01.10.2026): „A1 S. 24“
 * = Anlage 1, Seite 24; „T“ = Tenor. Der Server prüft jede Regel selbst; dieses Modul sagt sie nur vorher und ordnet
 * jede Ablehnung dem Schritt zu, in dem sie entsteht (BK-17: „jede Ablehnung erscheint als Satz im Schritt“).
 */

export type FoerderwegWert =
  | 'einspeiseverguetung'
  | 'marktpraemie_ausschliesslichkeit'
  | 'marktpraemie_abgrenzung'
  | 'marktpraemie_pauschal'
  | 'ungefoerdert';

export interface FoerderwegBeschreibung {
  wert: FoerderwegWert;
  /** Der Begriff aus EEG und Festlegung (Vertrag § 1). */
  begriff: string;
  /** Ein Satz für den Kunden: was der Weg bedeutet und was er verlangt. */
  satz: string;
  /** Die Rechtsgrundlage, kurz. */
  rechtsgrundlage: string;
  /** Lässt der Weg Netzladen zu (Vertrag § 1)? */
  netzladenMoeglich: boolean;
  /** Kurzweg (BK-17): Schritt 1 führt direkt zu „Prüfen“. */
  kurzweg: boolean;
  /** Gesperrt mit Grund — oder `null`. */
  gesperrt: string | null;
}

/** Erst ab dem Monatsersten nach der EU-Genehmigung (T S. 3 Ziff. 9b); die Einrichtung dafür baut MP-27. */
export const PAUSCHAL_GESPERRT =
  'noch nicht anwendbar: erst ab dem Monatsersten nach der Genehmigung der EU-Kommission (Tenor Ziff. 9b)';

export const FOERDERWEGE: readonly FoerderwegBeschreibung[] = [
  {
    wert: 'einspeiseverguetung',
    begriff: 'Einspeisevergütung',
    satz: 'Feste Vergütung je eingespeister kWh vom Netzbetreiber. Der Speicher lädt nur Sonnenstrom.',
    rechtsgrundlage: '§ 19 Abs. 1 Nr. 2 EEG',
    netzladenMoeglich: false,
    kurzweg: true,
    gesperrt: null,
  },
  {
    wert: 'marktpraemie_ausschliesslichkeit',
    begriff: 'Marktprämie mit Ausschließlichkeitsoption',
    satz: 'Direktvermarktung wie bisher: Der Speicher lädt nur Sonnenstrom, die ganze Einspeisung bekommt die Marktprämie.',
    rechtsgrundlage: '§ 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG',
    netzladenMoeglich: false,
    kurzweg: true,
    gesperrt: null,
  },
  {
    wert: 'marktpraemie_abgrenzung',
    begriff: 'Marktprämie mit Abgrenzungsoption',
    satz:
      'Der Speicher darf Sonnen- und Netzstrom mischen. Sonnenstrom behält die Marktprämie, zurückgespeister Netzstrom ' +
      'wird von Umlagen und Netzentgelt befreit. Verlangt einen zweiten Zähler am Speicher.',
    rechtsgrundlage: '§ 19 Abs. 3b EEG · Anlage 1',
    netzladenMoeglich: true,
    kurzweg: false,
    gesperrt: null,
  },
  {
    wert: 'ungefoerdert',
    begriff: 'ungeförderte Direktvermarktung',
    satz: 'Keine Marktprämie; der Speicher handelt frei, z. B. ein reiner Speicher ohne EEG-Anlage.',
    rechtsgrundlage: '§ 21a EEG',
    netzladenMoeglich: true,
    kurzweg: true,
    gesperrt: null,
  },
  {
    wert: 'marktpraemie_pauschal',
    begriff: 'Marktprämie mit Pauschaloption',
    satz: 'Für PV bis 30 kWp: gefördert bis 500 kWh je kWp im Jahr, darüber saldiert. Ein Zähler genügt.',
    rechtsgrundlage: '§ 19 Abs. 3c EEG · Anlage 2',
    netzladenMoeglich: true,
    kurzweg: false,
    gesperrt: PAUSCHAL_GESPERRT,
  },
];

export function foerderweg(wert: FoerderwegWert): FoerderwegBeschreibung {
  const w = FOERDERWEGE.find((f) => f.wert === wert);
  if (!w) throw new Error(`unbekannter Förderweg ${wert}`);
  return w;
}

/** Die Wahl in Schritt 1: der heutige Weg zuerst, die Pauschaloption (gesperrt) zuletzt. */
export function foerderwegReihe(heute: FoerderwegWert | null): FoerderwegBeschreibung[] {
  const rest = FOERDERWEGE.filter((f) => f.wert !== heute);
  return heute ? [foerderweg(heute), ...rest] : [...rest];
}

/** „in der Ausschließlichkeitsoption“, „mit der Einspeisevergütung“ — die Präposition gehört zum Begriff. */
function mitDem(wert: FoerderwegWert): string {
  switch (wert) {
    case 'einspeiseverguetung':
      return 'Mit der Einspeisevergütung';
    case 'marktpraemie_ausschliesslichkeit':
      return 'In der Ausschließlichkeitsoption';
    case 'marktpraemie_abgrenzung':
      return 'Mit der Abgrenzungsoption';
    case 'marktpraemie_pauschal':
      return 'Mit der Pauschaloption';
    case 'ungefoerdert':
      return 'In der ungeförderten Direktvermarktung';
  }
}

function klein(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Die Zeile „Netzladen“ (BK-17): offen, wo der Förderweg es zulässt, sonst gesperrt mit Grund; die Zeile hängt an
 * einen gesperrten Satz „— Förderweg ändern“ als Knopf. Ohne bekannten Förderweg gesperrt — fehlend ist kein „erlaubt“.
 */
export function netzladenZeile(weg: FoerderwegWert | null): { offen: boolean; satz: string } {
  if (weg == null) return { offen: false, satz: 'Hängt vom Förderweg ab' };
  const w = foerderweg(weg);
  return w.netzladenMoeglich
    ? { offen: true, satz: `Ihre Einstellung — ${klein(mitDem(weg))} erlaubt` }
    : { offen: false, satz: `${mitDem(weg)} nicht möglich` };
}

/**
 * Der Satz unter dem Netzlade-Feld (ersetzt W2 „EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz
 * laden“, Captain 02.10.2026 Auflösung B): je Förderweg der richtige Satz.
 */
export function netzladenHinweis(weg: FoerderwegWert | null): string {
  switch (weg) {
    case 'einspeiseverguetung':
    case 'marktpraemie_ausschliesslichkeit':
      return (
        `${mitDem(weg)} lädt der Speicher nur Sonnenstrom; Strom aus dem Netz würde die Förderung des ` +
        'Speicherstroms kosten (§ 19 Abs. 3a EEG). Netzladen erlaubt erst ein anderer Förderweg.'
      );
    case 'marktpraemie_abgrenzung':
      return (
        'Mit der Abgrenzungsoption darf der Speicher Sonnen- und Netzstrom mischen; die Mengen werden jeden Monat nach ' +
        'Anlage 1 der Festlegung abgegrenzt. Ob er aus dem Netz lädt, entscheiden Sie hier.'
      );
    case 'marktpraemie_pauschal':
      return (
        'Mit der Pauschaloption darf der Speicher aus dem Netz laden; die Mengen werden im Kalenderjahr nach Anlage 2 ' +
        'der Festlegung bestimmt. Ob er aus dem Netz lädt, entscheiden Sie hier.'
      );
    case 'ungefoerdert':
      return 'In der ungeförderten Direktvermarktung gibt es keine Marktprämie; ob der Speicher aus dem Netz lädt, entscheiden Sie hier.';
    default:
      return 'Ob der Speicher aus dem Netz laden darf, hängt vom Förderweg Ihrer Anlage ab (Anlage › Einstellungen › Förderweg).';
  }
}

/**
 * Der Satz beim ANLEGEN einer Anlage (W2): dort gibt es noch keine Förderweg-Fassung, die Schalter SIND der Bestand
 * (Vertrag § 2) — Netzladen erlaubt heißt ungeförderte Direktvermarktung. Die Abgrenzungsoption richtet der Dialog
 * „Förderweg ändern“ ein.
 */
export const NETZLADEN_ANLEGEN_HINWEIS =
  'Mit Einspeisevergütung oder Marktprämie in der Ausschließlichkeitsoption lädt der Speicher nur Sonnenstrom ' +
  '(Ausschließlichkeitsprinzip, § 19 Abs. 3a EEG); „Erlaubt“ heißt hier ungeförderte Direktvermarktung. ' +
  'Die Abgrenzungsoption richten Sie nach dem Anlegen unter Anlage › Einstellungen › Förderweg ein.';

// ---------------------------------------------------------------------------
// Schritte und Monatserster
// ---------------------------------------------------------------------------

export type SchrittId = 'foerderweg' | 'zaehler' | 'formelsatz' | 'partner' | 'pruefen';

export const SCHRITTE: readonly { id: SchrittId; titel: string }[] = [
  { id: 'foerderweg', titel: 'Förderweg' },
  { id: 'zaehler', titel: 'Zähler' },
  { id: 'formelsatz', titel: 'Formelsatz' },
  { id: 'partner', titel: 'Partner' },
  { id: 'pruefen', titel: 'Prüfen' },
];

/** Die Schritte dieses Weges: der Kurzweg führt von „Förderweg“ direkt zu „Prüfen“ (BK-17). */
export function schritteFuer(weg: FoerderwegWert | null): SchrittId[] {
  if (weg != null && foerderweg(weg).kurzweg) return ['foerderweg', 'pruefen'];
  return SCHRITTE.map((s) => s.id);
}

export function schrittTitel(id: SchrittId): string {
  return SCHRITTE.find((s) => s.id === id)?.titel ?? id;
}

/** Der erste Kalendertag des folgenden Monats (ISO-Tag). */
export function naechsterMonatserster(heute: string): string {
  const [j, m] = heute.split('-').map(Number);
  const nj = m === 12 ? j + 1 : j;
  const nm = m === 12 ? 1 : m + 1;
  return `${nj}-${String(nm).padStart(2, '0')}-01`;
}

/**
 * Ab wann die neue Fassung gilt. Ein anderer Förderweg gilt immer ab dem ersten Tag eines Monats (§ 21b Abs. 1 S. 2
 * EEG): heute, wenn heute ein Monatserster ist, sonst der nächste (vorgemerkt, Vertrag § 5). Derselbe Weg mit anderen
 * Angaben gilt ab heute. Steht schon eine Vormerkung, wird sie berichtigt (derselbe Tag).
 */
export function giltAb(heute: string, alt: FoerderwegWert | null, neu: FoerderwegWert, vormerkungAb: string | null): string {
  if (vormerkungAb) return vormerkungAb;
  if (alt === neu) return heute;
  return heute.endsWith('-01') ? heute : naechsterMonatserster(heute);
}

/** TT.MM.JJJJ */
export function tagText(iso: string): string {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}

/** Bis wann eine Formelsatz-Wahl bindet: das Ende des Kalenderjahres von `am` (A1 S. 24). */
export function gebundenBis(am: string): string {
  return `${am.slice(0, 4)}-12-31`;
}

// ---------------------------------------------------------------------------
// Zähler und Formelsatz (Gebot der Bestnutzung)
// ---------------------------------------------------------------------------

/** Der Zustand eines Zählers der Festlegung aus den Urteilen seiner beiden Messstellen (Vertrag Zählerrolle § 3). */
export type ZaehlerZustand = 'fehlt' | 'tauglich' | 'nicht_pruefbar' | 'nicht_tauglich';

export function zaehlerZustand(urteile: (string | null | undefined)[]): ZaehlerZustand {
  if (urteile.length === 0 || urteile.some((u) => u == null || u === 'keine_rolle')) return 'fehlt';
  if (urteile.includes('nicht_tauglich')) return 'nicht_tauglich';
  if (urteile.includes('nicht_pruefbar')) return 'nicht_pruefbar';
  return 'tauglich';
}

export interface FormelsatzBeschreibung {
  wert: 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A5-Variante' | 'A10' | 'A11';
  /** Begriff der Anlage 1, wörtlich. */
  titel: string;
  satz: string;
  fundstelle: string;
}

export const FORMELSAETZE: readonly FormelsatzBeschreibung[] = [
  {
    wert: 'A1',
    titel: 'A1 · Basisfall „Stromspeicher“',
    satz: 'Eine einzelne EE-Anlage mit Stromspeicher; Zähler Z1 und Z2.',
    fundstelle: 'A1 S. 29, Abschn. 4.1.1',
  },
  {
    wert: 'A2',
    titel: 'A2 · Basisfall „Ladepunkt“',
    satz: 'Eine einzelne EE-Anlage mit Ladepunkt; Zähler Z1 und Z2 am Ladepunkt.',
    fundstelle: 'A1 S. 29, Abschn. 4.1.2',
  },
  {
    wert: 'A3',
    titel: 'A3 · Basisfall „Stromspeicher und Ladepunkt“',
    satz: 'Speicher und Ladepunkt gemeinsam hinter Z2 (vereinfachte Alternative zu A4).',
    fundstelle: 'A1 S. 30, Abschn. 4.1.3',
  },
  {
    wert: 'A4',
    titel: 'A4 · Stromspeicher und Ladepunkt mit gesonderter Messung',
    satz: 'Wie A3, der Speicher zusätzlich allein hinter Z3; Zähler Z1, Z2 und Z3.',
    fundstelle: 'A1 S. 31, Abschn. 4.1.4',
  },
  {
    wert: 'A5',
    titel: 'A5 · Mehrere gleichartige EE-Anlagen',
    satz: 'Zwei oder mehr gleichartige EE-Anlagen (z. B. zwei PV-Anlagen) mit Stromspeicher; Zähler Z1 und Z2.',
    fundstelle: 'A1 S. 43, Abschn. 5.1',
  },
  {
    wert: 'A5-Variante',
    titel: 'A5-Variante · vereinfachtes Vorgehen',
    satz: 'Wie A5, für gleichartige EE-Anlagen mit jederzeit übereinstimmenden AW>0-Zeiten.',
    fundstelle: 'A1 S. 52, Abschn. 5.4.2',
  },
  {
    wert: 'A10',
    titel: 'A10 · Rein netzgekoppelter Stromspeicher',
    satz: 'Ohne sonstige Erzeugung und ohne sonstigen Verbrauch; nur Z1 (vereinfachte Alternative zu A1).',
    fundstelle: 'A1 S. 95, Abschn. 10.2.1',
  },
  {
    wert: 'A11',
    titel: 'A11 · Stromspeicher und/oder Ladepunkt ohne sonstige Erzeugung',
    satz: 'Mit sonstigem Verbrauch; nur Z1 (vereinfachte Alternative zu den Basisfällen A1 bis A4).',
    fundstelle: 'A1 S. 98, Abschn. 10.3.1',
  },
];

/** Vereinfacht → die umfangreicheren, wie Vertrag § 3 Nr. 7 (`VEREINFACHT_STATT`, A2–A4 seit MP-32). */
const VEREINFACHT_STATT: Record<string, string[]> = {
  A3: ['A4'],
  'A5-Variante': ['A5'],
  A10: ['A1'],
  A11: ['A1', 'A2', 'A3', 'A4'],
};

/** Ob zwei Formelsätze die Wahl zwischen vereinfacht und umfangreich sind (A1 S. 24) — dann bindet sie bis 31.12. */
export function wahlPaar(a: string | null, b: string | null): boolean {
  return a != null && b != null && ((VEREINFACHT_STATT[a] ?? []).includes(b) || (VEREINFACHT_STATT[b] ?? []).includes(a));
}

/** Der Satz der Festlegung zum Gebot der Bestnutzung, wörtlich (A1 S. 24, Abschn. 3.2.3). */
export const BESTNUTZUNG_SATZ =
  'Die vereinfachten Messkonzepte und Formelsätze nach den Fallkonstellationen A3, A8, A10 und A11 können nicht ' +
  'angewendet werden, wenn die vorhandenen Messeinrichtungen dem zu dieser Fallkonstellation passenden Messkonzept ' +
  'entsprechen, das eine genauere Bestimmung nach dem dazugehörigen (umfangreicheren) Formelsatz ermöglicht.';

export interface FormelsatzOption {
  wert: FormelsatzBeschreibung['wert'];
  gesperrt: string | null;
}

export interface FormelsatzVorschlag {
  /** Der vorgeschlagene Formelsatz — `null`, wenn die Zähler keinen tragen. */
  vorschlag: FormelsatzBeschreibung['wert'] | null;
  /** Ein Satz, warum. */
  satz: string;
  optionen: FormelsatzOption[];
}

/**
 * Der Formelsatz-Vorschlag der Abgrenzungsoption nach dem Gebot der Bestnutzung (A1 S. 24, Abschn. 3.2.3), aus den
 * Zählern Z1, Z2 und (A4) Z3. Die Abgrenzungsoption mit Marktprämie hat eine geförderte EE-Anlage: mit Z1 und Z2 trägt
 * das Messkonzept die Basisfälle A1 bis A3 (bzw. A5 bei mehreren gleichartigen Anlagen); die vereinfachten A10 und A11
 * sind dann ausgeschlossen, mit Z3 auch A3 statt A4. Was hinter Z2 hängt (Speicher, Ladepunkt), weiß die Fläche nicht —
 * sie schlägt den bisherigen Formelsatz vor, sonst A1 (mit Z3: A4). `alt` und `ab`: eine schon getroffene Wahl
 * zwischen vereinfacht und umfangreich bindet bis 31.12. (A1 S. 24).
 */
export function formelsatzVorschlag(
  z1: ZaehlerZustand,
  z2: ZaehlerZustand,
  alt: string | null,
  ab: string,
  z3: ZaehlerZustand = 'fehlt',
): FormelsatzVorschlag {
  const zweiZaehler = z1 !== 'fehlt' && z2 !== 'fehlt';
  const mitZ3 = zweiZaehler && z3 !== 'fehlt';
  const gebunden = (wert: string): string | null =>
    alt && wahlPaar(alt, wert) && !ab.endsWith('-01-01')
      ? `Die Wahl ${alt} bindet bis ${tagText(gebundenBis(ab))}; ändern lässt sie sich zum 01.01. (A1 S. 24).`
      : null;
  const ohneErzeugung = zweiZaehler
    ? 'vereinfacht — nicht anwendbar, weil Ihre Zähler Z1 und Z2 die genauere Bestimmung ermöglichen (Gebot der Bestnutzung, A1 S. 24)'
    : 'gilt nur für Speicher ohne sonstige Erzeugung (A1 Abschn. 10); Ihre Anlage hat eine geförderte EE-Anlage';
  const optionen: FormelsatzOption[] = FORMELSAETZE.map((f) => {
    if (f.wert === 'A10' || f.wert === 'A11') return { wert: f.wert, gesperrt: ohneErzeugung };
    if (!zweiZaehler) return { wert: f.wert, gesperrt: 'braucht Z1 und Z2 (A1 S. 32–33)' };
    if (f.wert === 'A4' && !mitZ3) return { wert: f.wert, gesperrt: 'braucht zusätzlich Z3 am Speicher (A1 S. 31, Abschn. 4.1.4)' };
    if (f.wert === 'A3' && mitZ3) {
      return { wert: f.wert, gesperrt: 'vereinfacht — nicht anwendbar, weil Ihr Zähler Z3 die genauere Bestimmung nach A4 ermöglicht (Gebot der Bestnutzung, A1 S. 24)' };
    }
    return { wert: f.wert, gesperrt: gebunden(f.wert) };
  });
  if (!zweiZaehler) {
    return {
      vorschlag: null,
      satz:
        z1 === 'fehlt'
          ? 'Ohne Z1 am Netzanschluss trägt kein Formelsatz der Anlage 1 — bitte zuerst die Zähler erfassen (A1 S. 23).'
          : 'Ohne Z2 am Speicher trägt kein Formelsatz der Abgrenzungsoption mit geförderter EE-Anlage — bitte zuerst Z2 erfassen (A1 S. 32–33).',
      optionen,
    };
  }
  const frei = (w: string | null): w is FormelsatzBeschreibung['wert'] =>
    w != null && optionen.some((o) => o.wert === w && o.gesperrt == null);
  const vorschlag: FormelsatzBeschreibung['wert'] = frei(alt) ? alt : mitZ3 ? 'A4' : 'A1';
  return {
    vorschlag,
    satz:
      vorschlag === 'A1'
        ? 'Eine geförderte EE-Anlage, ein Speicher, Zähler Z1 und Z2: Basisfall A1. Er passt zu Ihren Zählern; einen genaueren gibt es für diese Anlage nicht.'
        : vorschlag === 'A4'
          ? 'Speicher und Ladepunkt, der Speicher allein hinter Z3: Basisfall A4 — der genaueste für Ihre Zähler.'
          : `Wie bisher: ${vorschlag}. Er passt zu Ihren Zählern.`,
    optionen,
  };
}

// ---------------------------------------------------------------------------
// Prämien-Viertelstunden (AW-Differenzierung, Vertrag § 7)
// ---------------------------------------------------------------------------

/** Die Veröffentlichungen der ÜNB (A1 S. 17 Fn. 8); „weiß ich nicht“ = `null`, die Marktprämie bleibt vorläufig. */
export const AW_REGELN: readonly { wert: string; label: string }[] = [
  { wert: 'viertelstunde', label: '1 Viertelstunde (§ 51 EEG)' },
  { wert: 'viertelstunde_2ct', label: '2ct Logik (§ 51b EEG)' },
  { wert: 'stunden_1', label: '1 Stunde (§ 51 EEG)' },
  { wert: 'stunden_2', label: '2 Stunden (§ 51 EEG)' },
  { wert: 'stunden_3', label: '3 Stunden (§ 51 EEG)' },
  { wert: 'stunden_4', label: '4 Stunden (§ 51 EEG)' },
  { wert: 'stunden_6', label: '6 Stunden (§ 51 EEG)' },
];

export const AW_UNBEKANNT = 'weiss_ich_nicht';

export function awRegelLabel(wert: string | null): string {
  if (wert == null) return 'weiß ich nicht — Marktprämie vorläufig';
  return AW_REGELN.find((r) => r.wert === wert)?.label ?? wert;
}

// ---------------------------------------------------------------------------
// Übergangszeit und Prüfen
// ---------------------------------------------------------------------------

/** Bis zu diesem Tag gilt die Festlegung nur mit dem Einverständnis von Netz- und Messstellenbetreiber (T Ziff. 9a). */
export const EINVERSTAENDNIS_BIS = '2027-09-30';

export function einverstaendnisNoetig(weg: FoerderwegWert, ab: string): boolean {
  return (weg === 'marktpraemie_abgrenzung' || weg === 'marktpraemie_pauschal') && ab <= EINVERSTAENDNIS_BIS;
}

/** „Was sich ab dann ändert“ — nur, was die Software wirklich tut. */
export function folgen(weg: FoerderwegWert): string[] {
  switch (weg) {
    case 'marktpraemie_abgrenzung':
      return [
        'VoltPilot plant den Speicher im Mischbetrieb: laden aus dem Netz, wenn es sich lohnt.',
        'Die Box darf dann aus dem Netz laden — so lange Ihre Einstellung „Netzladen“ an ist.',
        'Jeden Monat werden Ihre Mengen nach Anlage 1 bestimmt: förderfähig, saldierungsfähig, umlagebelastet.',
        'Die Marktprämie rechnet mit dem Jahresmarktwert statt dem Monatsmarktwert (gesetzlich, für jede Anlage in dieser Option).',
      ];
    case 'marktpraemie_ausschliesslichkeit':
      return [
        'Der Speicher lädt nur Sonnenstrom; Netzladen ist ab dann aus.',
        'Die ganze Einspeisung bekommt die Marktprämie wie bisher.',
      ];
    case 'einspeiseverguetung':
      return [
        'Die Einspeisung bekommt die feste Vergütung des Netzbetreibers.',
        'Der Speicher lädt nur Sonnenstrom; Netzladen ist ab dann aus.',
      ];
    case 'ungefoerdert':
      return [
        'Es gibt keine Marktprämie.',
        'Der Speicher darf aus dem Netz laden, so lange Ihre Einstellung „Netzladen“ an ist.',
      ];
    case 'marktpraemie_pauschal':
      return [PAUSCHAL_GESPERRT];
  }
}

// ---------------------------------------------------------------------------
// Ablehnungen: Satz und Schritt
// ---------------------------------------------------------------------------

export interface Ablehnung {
  code: string;
  message?: string;
  [fakt: string]: unknown;
}

const FOERDERWEG_CODES = new Set([
  'foerderweg_ungueltig',
  'pauschaloption_noch_nicht_anwendbar',
  'vor_der_festlegung',
  'erstmalige_zuordnung_vorbei',
  'foerderweg_unveraendert',
  'netzladen_ausgeschlossen',
]);
const FORMELSATZ_CODES = new Set([
  'formelsatz_ungueltig',
  'formelsatz_fehlt',
  'formelsatz_passt_nicht',
  'formelsatz_gebunden',
  'aw_regel_ungueltig',
  'aw_regel_passt_nicht',
]);
const PARTNER_CODES = new Set(['einverstaendnis_fehlt', 'partner_passt_nicht']);

/** In welchem Schritt eine Ablehnung des Förderweg-Vertrags entsteht (§ 4). */
export function ablehnungSchritt(a: Ablehnung): SchrittId {
  if (FOERDERWEG_CODES.has(a.code)) return 'foerderweg';
  if (FORMELSATZ_CODES.has(a.code)) return 'formelsatz';
  if (PARTNER_CODES.has(a.code)) return 'partner';
  if (a.code === 'anfrage_ungueltig' && a.feld === 'direktvermarkter') return 'partner';
  return 'pruefen';
}

function tag(a: Ablehnung, fakt: string): string {
  const v = a[fakt];
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? tagText(v) : '—';
}

/** Der Satz zu einer Ablehnung, mit Fundstelle; unbekannte Codes sprechen den Satz des Servers. */
export function ablehnungSatz(a: Ablehnung): string {
  switch (a.code) {
    case 'pauschaloption_noch_nicht_anwendbar':
      return 'Die Pauschaloption gilt erst ab dem Monatsersten nach der Genehmigung der EU-Kommission (Tenor Ziff. 9b).';
    case 'vor_der_festlegung':
      return 'Die Festlegung wirkt erst ab 01.10.2026 (Tenor Ziff. 8).';
    case 'foerderweg_unveraendert':
      return `Ab ${tag(a, 'am')} gilt bereits genau dieser Förderweg — es gibt nichts einzutragen.`;
    case 'netzladen_ausgeschlossen':
      return 'Dieser Förderweg schließt Netzladen aus; sonst entfällt die Förderung (§ 19 Abs. 3a EEG).';
    case 'erstmalige_zuordnung_vorbei':
      return 'Die Anlage hat schon einen eingetragenen Förderweg; jede weitere Fassung ist ein Wechsel zum Monatsersten (A1 S. 103).';
    case 'formelsatz_ungueltig':
      return `Den Formelsatz ${String(a.formelsatz ?? '')} unterstützt VoltPilot noch nicht (A1 S. 9, Übersicht 1).`;
    case 'formelsatz_passt_nicht':
      return 'Ein Formelsatz der Anlage 1 gehört nur zur Abgrenzungsoption oder zur ungeförderten Direktvermarktung (Tenor Ziff. 1 S. 2, Ziff. 3).';
    case 'aw_regel_ungueltig':
    case 'aw_regel_passt_nicht':
      return 'Die Prämien-Viertelstunden zählen nur in der Abgrenzungs- und der Pauschaloption (A1 S. 17, Formel (24)).';
    case 'foerderweg_ungueltig':
      return 'Diesen Förderweg kennt die Festlegung nicht.';
    case 'formelsatz_fehlt':
      return 'Die Abgrenzungsoption braucht einen Formelsatz der Anlage 1 (Tenor Ziff. 3).';
    case 'formelsatz_gebunden':
      return `Die Wahl ${String(a.formelsatz ?? '')} bindet bis ${tag(a, 'gebunden_bis')}; ändern lässt sie sich zum 01.01. (A1 S. 24, Abschn. 3.2.3).`;
    case 'einverstaendnis_fehlt':
      return `Bis ${tag(a, 'bis')} gilt die Festlegung nur, wenn Netzbetreiber und Messstellenbetreiber einverstanden sind (Tenor Ziff. 9a). Bitte bestätigen Sie das Einverständnis.`;
    case 'partner_passt_nicht':
      return 'Die Einspeisevergütung zahlt der Netzbetreiber; einen Direktvermarkter gibt es nur in der Direktvermarktung (§ 21b Abs. 1 EEG).';
    case 'wechsel_nur_zum_monatsersten':
      return `Ein anderer Förderweg gilt immer ab dem ersten Tag eines Monats — frühestens ab ${tag(a, 'naechster_monatserster')} (§ 21b Abs. 1 S. 2 EEG).`;
    case 'gueltig_ab_in_zukunft':
      return `Vormerken lässt sich nur der nächste Monatserste (${tag(a, 'naechster_monatserster')}).`;
    case 'foerderweg_rueckwirkend':
      return `Ab ${tag(a, 'letzte_fassung_ab')} ist schon ein Förderweg eingetragen oder vorgemerkt; davor lässt sich nichts mehr einschieben. Eine Vormerkung können Sie in den Einstellungen zurücknehmen.`;
    default:
      return typeof a.message === 'string' && a.message ? a.message : 'Der Förderweg konnte nicht eingetragen werden.';
  }
}
