import type {
  Nutzung,
  OrtFehler,
  StandortAmStichtag,
  StandorteAmStichtag,
  StandortStammdaten,
  Unternehmen,
} from './api';
import { datumText, lokalerTag, m2Text, nameBelegt, nameBelegtSatz, VORGABE_ZEITZONE, type Ortsbaum } from './uemsOrtsbaum';

/**
 * Der Standort-Dialog und die Liste „Unternehmen › Standorte“ (UEMS AP-02 IP-6,
 * Mockups T1/T2) als reine Schicht: Wörter, Fassung des Dialogs, Vorbelegung,
 * Prüfung vor dem Senden und die Anfrage. Die Komponenten rendern nur.
 *
 * Jede Regel ist die des Servers (`OrtFelder`, `StandortService`,
 * `OrtsbaumAbleitung`) — Sätze Zeichen für Zeichen gleich, damit ein Fehler vor
 * dem Senden genauso klingt wie danach. Die Namensregel wird nicht nachgebaut,
 * sie wird AUFGERUFEN (`nameBelegt`/`nameBelegtSatz` aus `uemsOrtsbaum.ts`).
 *
 * ⚠ Die Bezugsfläche eines Standorts hat heute keine Schreibroute (nur Gebäude
 * und Bereiche: `PUT /api/v1/orte/{id}/flaeche`). Der Dialog zeigt sie darum
 * nur lesend; die Eingabe mit „gültig ab“ kommt, sobald es die Route gibt.
 */

// ───────────────────────────────────────────────────────────── Vokabulare

/** E4 — das geschlossene Vokabular in seiner Reihenfolge, Code → Kundenwort. */
export const NUTZUNGEN: readonly { code: Nutzung; wort: string }[] = [
  { code: 'produktion', wort: 'Produktion' },
  { code: 'montage', wort: 'Montage' },
  { code: 'lager', wort: 'Lager' },
  { code: 'logistik', wort: 'Logistik' },
  { code: 'buero', wort: 'Büro' },
  { code: 'technik', wort: 'Technik' },
  { code: 'aussenflaeche', wort: 'Außenfläche' },
  { code: 'werkstatt', wort: 'Werkstatt' },
  { code: 'labor', wort: 'Labor' },
  { code: 'verkauf', wort: 'Verkauf' },
  { code: 'sozialraeume', wort: 'Sozialräume' },
  { code: 'sonstiges', wort: 'Sonstiges' },
];

export function nutzungWort(code: Nutzung): string {
  return NUTZUNGEN.find((n) => n.code === code)?.wort ?? code;
}

/** §4.1 — die Zeitzonen des DACH-Raums; die erste ist die Vorgabe. */
export const ZEITZONEN = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'] as const;

export type Land = 'DE' | 'AT' | 'CH';

/** Das Land einer Adresse mit seinem Kundenwort und der Stellenzahl der PLZ (`OrtFelder`). */
export const LAENDER: readonly { code: Land; wort: string; zu: string; plzStellen: 4 | 5 }[] = [
  { code: 'DE', wort: 'Deutschland', zu: 'zu Deutschland', plzStellen: 5 },
  { code: 'AT', wort: 'Österreich', zu: 'zu Österreich', plzStellen: 4 },
  { code: 'CH', wort: 'Schweiz', zu: 'zur Schweiz', plzStellen: 4 },
];

export const NAME_HOECHSTENS = 120;
export const KURZZEICHEN_HOECHSTENS = 24;
export const NOTIZ_HOECHSTENS = 500;

// ───────────────────────────────────────────────────────────── Sätze

export const SATZ_NAME_FEHLT = 'Bitte geben Sie einen Namen an.';
export const SATZ_NAME_ZU_LANG = `Der Name hat höchstens ${NAME_HOECHSTENS} Zeichen.`;
export const SATZ_KURZZEICHEN_FEHLT = 'Das Kurzzeichen fehlt.';
export const SATZ_KURZZEICHEN_ZU_LANG = `Das Kurzzeichen hat höchstens ${KURZZEICHEN_HOECHSTENS} Zeichen.`;
export const SATZ_ADRESSE = 'Bitte geben Sie die Adresse an: Straße mit Hausnummer, Ort und Land.';
export const SATZ_ZEITZONE = 'Die Zeitzone ist Europe/Berlin, Europe/Vienna oder Europe/Zurich.';
export const SATZ_NOTIZ_ZU_LANG = `Die Notiz hat höchstens ${NOTIZ_HOECHSTENS} Zeichen.`;

/** §5.10: „Die PLZ 84xxx passt nicht zu Österreich (vierstellig).“ */
export function plzSatz(plz: string, land: Land): string {
  const l = LAENDER.find((x) => x.code === land)!;
  return `Die PLZ ${plz} passt nicht ${l.zu} (${l.plzStellen === 5 ? 'fünfstellig' : 'vierstellig'}).`;
}

// ───────────────────────────────────────────────────────────── Dialog

/** Die drei Fassungen des Dialogs (T2 + §5.1 „Standort vervollständigen“). */
export type DialogFassung = 'anlegen' | 'bearbeiten' | 'vervollstaendigen';

/** Ohne Standort: anlegen. Ein Entwurf (E10: es fehlt die Adresse): vervollständigen. Sonst: bearbeiten. */
export function dialogFassung(standort: StandortAmStichtag | null): DialogFassung {
  if (!standort) return 'anlegen';
  return standort.zustand === 'entwurf' ? 'vervollstaendigen' : 'bearbeiten';
}

export const DIALOG_TITEL: Record<DialogFassung, string> = {
  anlegen: 'Standort anlegen',
  bearbeiten: 'Standort bearbeiten',
  vervollstaendigen: 'Standort vervollständigen',
};

export const DIALOG_SENDEN: Record<DialogFassung, string> = {
  anlegen: 'Standort anlegen',
  bearbeiten: 'Speichern',
  vervollstaendigen: 'Speichern',
};

/** E10: der Satz eines Entwurfs — auf der Liste und im Dialog derselbe. */
export function esFehltSatz(standort: StandortAmStichtag): string | null {
  return standort.zustand === 'entwurf' && standort.esFehlt.includes('adresse')
    ? 'Noch nicht eingerichtet — es fehlt: Adresse'
    : null;
}

/** Die Zeile unter dem Titel (T2: „Name und Adresse sind Pflicht; Kurzzeichen ST-2 wird vergeben.“). */
export function dialogVorspann(
  fassung: DialogFassung,
  standort: StandortAmStichtag | null,
  kurzzeichenVorschlag: string | null,
): string {
  if (fassung === 'anlegen') {
    return kurzzeichenVorschlag
      ? `Name und Adresse sind Pflicht; Kurzzeichen ${kurzzeichenVorschlag} wird vergeben.`
      : 'Name und Adresse sind Pflicht.';
  }
  const fehlt = fassung === 'vervollstaendigen' && standort ? esFehltSatz(standort) : null;
  if (fehlt) return `${fehlt}. Name und Adresse sind Pflicht.`;
  return 'Name und Adresse sind Pflicht.';
}

export interface StandortFormular {
  name: string;
  kurzzeichen: string;
  strasse: string;
  plz: string;
  ort: string;
  land: Land | '';
  zeitzone: string;
  /** In der Reihenfolge der Auswahl — die erste ist die Hauptnutzung (E4). */
  nutzung: Nutzung[];
  notiz: string;
}

/** Die Zeitzone, die ein neuer Standort vorbelegt bekommt: die des Unternehmens, sonst die Vorgabe. */
export function vorbelegteZeitzone(unternehmen: Unternehmen | null): string {
  const z = unternehmen?.zeitzone;
  return z && (ZEITZONEN as readonly string[]).includes(z) ? z : VORGABE_ZEITZONE;
}

/** Das leere Formular „Standort anlegen“: Zeitzone vom Unternehmen, Land vom Sitz (wenn bekannt). */
export function leeresFormular(unternehmen: Unternehmen | null): StandortFormular {
  return {
    name: '',
    kurzzeichen: '',
    strasse: '',
    plz: '',
    ort: '',
    land: unternehmen?.sitz?.land ?? '',
    zeitzone: vorbelegteZeitzone(unternehmen),
    nutzung: [],
    notiz: '',
  };
}

/** Das Formular eines bestehenden Standorts, wie er heute gespeichert ist. */
export function formularAus(s: StandortAmStichtag): StandortFormular {
  return {
    name: s.name,
    kurzzeichen: s.kurzzeichen,
    strasse: s.adresse?.strasse ?? '',
    plz: s.adresse?.plz ?? '',
    ort: s.adresse?.ort ?? '',
    land: s.adresse?.land ?? '',
    zeitzone: s.zeitzone,
    nutzung: s.nutzung ?? [],
    notiz: s.notiz ?? '',
  };
}

/** Die Felder in der Reihenfolge des Dialogs — der erste Fehler bekommt den Fokus. */
export const FELDER = [
  'name',
  'kurzzeichen',
  'strasse',
  'plz',
  'ort',
  'land',
  'zeitzone',
  'nutzung',
  'notiz',
] as const;
export type FeldName = (typeof FELDER)[number];
export type FeldFehler = Partial<Record<FeldName, string>>;

export interface Pruefung {
  fehler: FeldFehler;
  /** Der Standort, der den Namen schon trägt — für „oder öffnen Sie …“. */
  belegtVon: StandortAmStichtag | null;
}

function zeichen(t: string): number {
  return [...t].length;
}

/**
 * Regel 13 über den EINEN Vertrag: der Baum aus den Standorten, die es heute gibt
 * (archivierte geben ihren Namen frei), und `nameBelegt` am Unternehmen.
 */
export function standortMitNamen(
  standorte: StandortAmStichtag[],
  name: string,
  heute: string,
  ausser: string | null,
): StandortAmStichtag | null {
  const lebend = standorte.filter((s) => s.zustand !== 'archiviert' && s.bestand === 'vorhanden');
  const baum: Ortsbaum = {
    zeitzone: VORGABE_ZEITZONE,
    orte: lebend.map((s) => ({
      kennzeichen: s.kurzzeichen,
      art: 'standort' as const,
      name: s.name,
      intervalle: [{ ab: heute, bis: null, eltern: null }],
    })),
    anlagen: [],
    messstellen: [],
  };
  const ort = nameBelegt(baum, 'standort', null, name, heute, ausser);
  return ort ? lebend.find((s) => s.kurzzeichen === ort.kennzeichen) ?? null : null;
}

/** Der Satz zu einem belegten Namen (§5.10), gesprochen von `nameBelegtSatz`. */
export function belegtSatz(s: StandortAmStichtag): string {
  return nameBelegtSatz({ kennzeichen: s.kurzzeichen, art: 'standort', name: s.name, intervalle: [] });
}

/**
 * Prüft vor dem Senden, was der Server ablehnen würde. Die Adresse ist in ALLEN
 * drei Fassungen Pflicht: anlegen (§4.1), bearbeiten (eingerichtet — sie darf
 * nicht mehr fehlen) und vervollständigen (genau dafür ist die Fassung da).
 */
export function pruefen(
  f: StandortFormular,
  fassung: DialogFassung,
  standorte: StandortAmStichtag[],
  heute: string,
  selbst: StandortAmStichtag | null,
): Pruefung {
  const fehler: FeldFehler = {};
  let belegtVon: StandortAmStichtag | null = null;
  const name = f.name.trim();
  if (!name) fehler.name = SATZ_NAME_FEHLT;
  else if (zeichen(name) > NAME_HOECHSTENS) fehler.name = SATZ_NAME_ZU_LANG;
  else {
    belegtVon = standortMitNamen(standorte, name, heute, selbst?.kurzzeichen ?? null);
    if (belegtVon) fehler.name = belegtSatz(belegtVon);
  }
  if (fassung !== 'anlegen') {
    const kz = f.kurzzeichen.trim();
    if (!kz) fehler.kurzzeichen = SATZ_KURZZEICHEN_FEHLT;
    else if (zeichen(kz) > KURZZEICHEN_HOECHSTENS) fehler.kurzzeichen = SATZ_KURZZEICHEN_ZU_LANG;
  }
  if (!f.strasse.trim()) fehler.strasse = SATZ_ADRESSE;
  const plz = f.plz.trim();
  if (plz && f.land) {
    const stellen = LAENDER.find((l) => l.code === f.land)!.plzStellen;
    if (!new RegExp(`^[0-9]{${stellen}}$`).test(plz)) fehler.plz = plzSatz(plz, f.land);
  }
  if (!f.ort.trim()) fehler.ort = SATZ_ADRESSE;
  if (!f.land) fehler.land = SATZ_ADRESSE;
  if (!(ZEITZONEN as readonly string[]).includes(f.zeitzone)) fehler.zeitzone = SATZ_ZEITZONE;
  if (zeichen(f.notiz.trim()) > NOTIZ_HOECHSTENS) fehler.notiz = SATZ_NOTIZ_ZU_LANG;
  return { fehler, belegtVon };
}

export function ersterFehler(fehler: FeldFehler): FeldName | null {
  return FELDER.find((k) => fehler[k]) ?? null;
}

/**
 * Was am Feld steht: der Satz — oder nur der rote Rand (`true`). Fehlen mehrere
 * Teile der Adresse, steht „Bitte geben Sie die Adresse an: …“ EINMAL, am ersten
 * fehlenden Feld; die übrigen sind nur markiert. Der Satz nennt schon alle drei
 * Teile, dreimal derselbe Satz machte das Formular am Telefon 84 px länger
 * (Vorschau IP-6, Variante B).
 */
export function sichtbareFehler(fehler: FeldFehler): Partial<Record<FeldName, string | true>> {
  const sichtbar: Partial<Record<FeldName, string | true>> = {};
  let adresseGesagt = false;
  for (const k of FELDER) {
    const satz = fehler[k];
    if (!satz) continue;
    if (satz === SATZ_ADRESSE) {
      sichtbar[k] = adresseGesagt ? true : satz;
      adresseGesagt = true;
    } else {
      sichtbar[k] = satz;
    }
  }
  return sichtbar;
}

function leerIstNull(t: string): string | null {
  const x = t.trim();
  return x ? x : null;
}

/**
 * Die Anfrage. POST: ohne Kurzzeichen (der Server vergibt ST-n). PUT ist die
 * GANZE Menge — die Lage auf der Karte, die der Dialog nicht zeigt, reist
 * unverändert mit, sonst wäre sie danach leer.
 */
export function anfrage(
  f: StandortFormular,
  fassung: DialogFassung,
  standort: StandortAmStichtag | null,
): StandortStammdaten {
  const basis: StandortStammdaten = {
    name: f.name.trim(),
    adresse: {
      strasse: leerIstNull(f.strasse),
      plz: leerIstNull(f.plz),
      ort: leerIstNull(f.ort),
      land: f.land || null,
    },
    zeitzone: f.zeitzone,
    nutzung: f.nutzung.length > 0 ? [...f.nutzung] : null,
    notiz: leerIstNull(f.notiz),
  };
  if (fassung === 'anlegen') return basis;
  return { ...basis, kurzzeichen: f.kurzzeichen.trim(), lage: standort?.lage ?? null };
}

/** Das Feld des Dialogs zu `feld` einer Ablehnung (`adresse.plz`, `nutzung[1]`, …); sonst `null`. */
export function feldAusServer(feld: string | undefined): FeldName | null {
  if (!feld) return null;
  if (feld === 'adresse') return 'strasse';
  const kopf = feld.replace(/^adresse\./, '').replace(/\[\d+\]$/, '');
  return (FELDER as readonly string[]).includes(kopf) ? (kopf as FeldName) : null;
}

/** Ein Körper ist eine Ablehnung der Ortsstruktur, wenn er `code` und `message` trägt. */
export function alsOrtFehler(body: unknown): OrtFehler | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<OrtFehler>;
  return typeof b.code === 'string' && typeof b.message === 'string' ? (b as OrtFehler) : null;
}

// ───────────────────────────────────────────────────────────── Liste (T1)

/** „Gewerbering 7, Ahrenberg“ — PLZ und Land stehen nur im Dialog. */
export function adresseKurz(s: StandortAmStichtag): string | null {
  const teile = [s.adresse?.strasse, s.adresse?.ort].filter((x): x is string => !!x);
  return teile.length > 0 ? teile.join(', ') : null;
}

/** „3 Gebäude“ — Zahl und Wort mit geschütztem Leerzeichen, wie `m2Text`. */
function anzahl(n: number, eins: string, viele: string): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? eins : viele}`;
}

/**
 * Die Zeile unter dem Namen (T1): „Gewerbering 7, Ahrenberg · 3 Gebäude · 2 Anlagen
 * · 8 450 m²“. Fehlendes bleibt weg — eine unbekannte Fläche ist keine 0.
 */
export function standortZeile(s: StandortAmStichtag): string {
  const teile: string[] = [];
  const adresse = adresseKurz(s);
  if (adresse) teile.push(adresse);
  if (s.gebaeudeZahl != null) teile.push(anzahl(s.gebaeudeZahl, 'Gebäude', 'Gebäude'));
  if (s.anlagenZahl != null) teile.push(anzahl(s.anlagenZahl, 'Anlage', 'Anlagen'));
  if (s.flaecheM2 != null) teile.push(m2Text(s.flaecheM2));
  return teile.join(' · ');
}

/** Die Bezugsfläche mit ihrer Herkunft (§4.1: „aus Gebäuden summiert“); `null` ohne Fläche. */
export function flaecheText(s: StandortAmStichtag): string | null {
  if (s.flaecheM2 == null) return null;
  return s.flaecheQuelle === 'aus_gebaeuden_summiert'
    ? `${m2Text(s.flaecheM2)} · aus Gebäuden summiert`
    : m2Text(s.flaecheM2);
}

/** T1: „Archiviert am 30.09.2026“ — der Tag in der Zeitzone des Standorts. */
export function archiviertText(s: StandortAmStichtag): string {
  return s.archiviertAm ? `Archiviert am ${datumText(lokalerTag(s.archiviertAm, s.zeitzone))}` : 'Archiviert';
}

export interface StandortListe {
  /** Die Standorte heute, nach Kurzzeichen (ST-1, ST-2, … ST-10). */
  standorte: StandortAmStichtag[];
  archiviert: StandortAmStichtag[];
  /** Die Gruppe „Noch nicht zugeordnet“ — es gibt sie nur, solange sie etwas enthält (A15). */
  nochNichtZugeordnet: { id: string; name: string }[] | null;
}

function nachKurzzeichen(a: StandortAmStichtag, b: StandortAmStichtag): number {
  return a.kurzzeichen.localeCompare(b.kurzzeichen, 'de-DE', { numeric: true });
}

export function standortListe(antwort: StandorteAmStichtag): StandortListe {
  const anlagen = antwort.nochNichtZugeordnet?.anlagen ?? [];
  return {
    standorte: [...antwort.standorte].sort(nachKurzzeichen),
    archiviert: antwort.nichtGezeigt.filter((s) => s.bestand === 'archiviert').sort(nachKurzzeichen),
    nochNichtZugeordnet:
      anlagen.length > 0 ? [...anlagen].sort((a, b) => a.name.localeCompare(b.name, 'de-DE')) : null,
  };
}
