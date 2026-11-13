/**
 * Der Text einer Meldung im Portal (Kunden-Alarmierung P1, Konzept vp-kunden-alarmierung-konzept §6.4) - der
 * Zwilling von `services/api/.../ueberwachung/MeldungsText.java`. Mail und Push rendert der Server, das Portal
 * hier, beide aus denselben Vorlagen (`katalog.json` ↔ `meldungsTexte.ts`) und gegen dieselben Vektoren
 * (`docs/contracts/v2/meldungs-text-vectors.json`, `meldungsText.vectors.test.ts`).
 *
 * Keine internen Schlüssel, keine Rohwerte, keine ISO-Zeiten: Zeiten in deutscher Ortszeit (Europe/Berlin, auch
 * wenn der Browser woanders steht), Zahlen mit Einheit. Eine Vorlage darf eine Liste von Alternativen sein; es
 * gilt die erste, deren Platzhalter alle belegt sind, sonst entfällt der Satz.
 */
import { MELDUNG_ALLGEMEIN, WERTART_TEXTE, type TextVorlage, type MeldungsartTexte } from './meldungsTexte';
import { katalogEintrag } from './werteKatalog';

/** Der Wert beim Auslösen: Zahl mit Einheit ODER Zustand, dazu optional der Satz des Lesers. */
export interface MeldungsTextWert {
  zahl: number | null;
  einheit: string | null;
  zustand: string | null;
  satz: string | null;
}

/** Die Eingabe des Texts - genau das Feld `text` einer Meldung aus `GET /api/v1/meldungen`. */
export interface MeldungsTextEingabe {
  wertart: string;
  herkunft: string | null;
  regelName: string | null;
  schwere: string | null;
  bezugArt: string | null;
  ort: string | null;
  bedingung: Record<string, unknown> | null;
  wert: MeldungsTextWert | null;
  beginn: string | null;
  ende: string | null;
}

export interface MeldungsNachricht {
  titel: string;
  saetze: string[];
  betreff: string;
  pushTitel: string;
  pushText: string;
}

const ZONE = 'Europe/Berlin';
const MINUS = '−';
const PLATZHALTER = /\{([A-Za-z_]+)\}/g;

type Werte = Record<string, string | undefined>;

// ------------------------------------------------------------------------------------------------- Nachrichten

export function ausgeloest(e: MeldungsTextEingabe, jetzt: Date): MeldungsNachricht {
  const w = werte(e, jetzt);
  const art = feste(e);
  let titelKern: string | null;
  const saetze: string[] = [];
  let push: string | null;
  if (art) {
    titelKern = vorlage(art.titel, w);
    hinzu(saetze, vorlage(art.lage, w));
    hinzu(saetze, vorlage(art.ursache, w));
    hinzu(saetze, vorlage(art.was_tun, w));
    push = vorlage(art.push, w);
  } else {
    const eigene = MELDUNG_ALLGEMEIN.eigene;
    const schluessel = eigeneSchluessel(e);
    titelKern = vorlage(eigene.titel[schluessel], w) ?? w.wertname ?? null;
    hinzu(saetze, vorlage(eigene.lage[schluessel], w));
    hinzu(saetze, vorlage(eigene.ursache, w));
    hinzu(saetze, vorlage(eigene.was_tun, w));
    push = vorlage(eigene.push, w);
  }
  w.titel = titelKern ?? undefined;
  const titel = vorlage(MELDUNG_ALLGEMEIN.titel, w) ?? '';
  const dringend = e.schwere === 'dringend';
  const pushTitel = (dringend ? MELDUNG_ALLGEMEIN.dringend_push : '') + (vorlage(MELDUNG_ALLGEMEIN.push_titel, w) ?? '');
  const zusatz = MELDUNG_ALLGEMEIN.push_zusatz;
  const pushText = push === null ? zusatz : `${push} ${zusatz}`;
  const betreff = (dringend ? MELDUNG_ALLGEMEIN.dringend_betreff : '') + titel;
  return { titel, saetze, betreff, pushTitel, pushText };
}

/** Die Entwarnung - nur mit `ende` (sonst endete die Meldung anders, etwa weil die Regel gelöscht wurde). */
export function entwarnung(e: MeldungsTextEingabe, jetzt: Date): MeldungsNachricht | null {
  if (!e.ende) return null;
  const w = werte(e, jetzt);
  const quelle = feste(e) ?? MELDUNG_ALLGEMEIN.eigene;
  const titelKern = vorlage(quelle.entwarnung_titel, w);
  const saetze: string[] = [];
  const lage = vorlage(quelle.entwarnung, w);
  hinzu(saetze, lage);
  hinzu(saetze, vorlage(quelle.entwarnung_dauer, w));
  w.titel = titelKern ?? undefined;
  const titel = vorlage(MELDUNG_ALLGEMEIN.titel, w) ?? '';
  const pushTitel = vorlage(MELDUNG_ALLGEMEIN.push_titel, w) ?? '';
  return { titel, saetze, betreff: titel, pushTitel, pushText: lage ?? '' };
}

/**
 * Der Text einer Mail (auch Team-Kanal und Telegram) - rendert der Server; hier nur, damit die Vektoren denselben
 * Wortlaut in beiden Sprachen festhalten.
 */
export function mailText(n: MeldungsNachricht, kennzeichen: string, basisUrl: string): string {
  const basis = basisUrl.replace(/\/+$/, '');
  const zeilen = [
    n.saetze.join('\n'),
    '',
    vorlage(MELDUNG_ALLGEMEIN.link_meldung, { link: `${basis}/#/meldungen?meldung=${kennzeichen}` }),
    vorlage(MELDUNG_ALLGEMEIN.link_einstellen, { link: `${basis}/#/meldungen?reiter=einstellen` }),
    '',
    vorlage(MELDUNG_ALLGEMEIN.kennzeichen, { kennzeichen }),
  ];
  return `${zeilen.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------- Auswahl, Werte

function feste(e: MeldungsTextEingabe): MeldungsartTexte | null {
  const art = WERTART_TEXTE[e.wertart]?.meldung;
  if (!art) return null;
  const zustand = e.wert?.zustand ?? null;
  if (zustand !== null && (art.gilt_bei.zustaende ?? []).includes(zustand)) return art;
  if (art.gilt_bei.herkunft !== undefined && art.gilt_bei.herkunft === e.herkunft) return art;
  return null;
}

function text(b: Record<string, unknown> | null, feld: string): string | null {
  const v = b?.[feld];
  return typeof v === 'string' ? v : null;
}

function zahlFeld(b: Record<string, unknown> | null, feld: string): number | null {
  const v = b?.[feld];
  return typeof v === 'number' ? v : null;
}

function eigeneSchluessel(e: MeldungsTextEingabe): string {
  const b = e.bedingung;
  const art = text(b, 'art') ?? '';
  if (art === 'periode') return `periode_${text(b, 'richtung') === 'unter' ? 'unter' : 'ueber'}`;
  if (art === 'aenderung') {
    const r = text(b, 'richtung');
    return `aenderung_${r === 'niedriger' ? 'niedriger' : r === 'beide' ? 'beide' : 'hoeher'}`;
  }
  return art;
}

function werte(e: MeldungsTextEingabe, jetzt: Date): Werte {
  const w: Werte = {};
  const eintrag = katalogEintrag(e.wertart);
  const name = eintrag ? eintrag.name : 'Wert';
  const satzname = eintrag ? eintrag.satzname : 'der Wert';
  w.wertname = name;
  w.satzname = satzname;
  w.Satzname = gross(satzname);
  const ersatz = MELDUNG_ALLGEMEIN.ort_ersatz;
  w.ort = e.ort && e.ort.trim() !== '' ? e.ort : (ersatz[e.bezugArt ?? 'anlage'] ?? ersatz.anlage);
  const beginn = e.beginn ? new Date(e.beginn) : null;
  const ende = e.ende ? new Date(e.ende) : null;
  if (beginn) w.beginn = zeit(beginn, jetzt);
  if (ende) w.ende = zeit(ende, jetzt);
  if (beginn && ende) w.dauer = dauer(Math.floor(ende.getTime() / 1000) - Math.floor(beginn.getTime() / 1000));
  const wert = e.wert ?? { zahl: null, einheit: null, zustand: null, satz: null };
  const einheit = wert.einheit;
  if (wert.zahl !== null && wert.zahl !== undefined) w.wert = zahl(wert.zahl, einheit);
  if (wert.satz && wert.satz.trim() !== '') w.satz = wert.satz;
  const worte = WERTART_TEXTE[e.wertart]?.zustandsworte;
  if (wert.zustand !== null && wert.zustand !== undefined) w.zustandswort = zustandswort(worte, wert.zustand);
  const b = e.bedingung;
  if (b) {
    const schwelle = zahlFeld(b, 'schwelle');
    if (schwelle !== null) w.schwelle = zahl(schwelle, einheit);
    const unten = zahlFeld(b, 'schwelle_unten');
    if (unten !== null) w.schwelle_unten = zahl(unten, einheit);
    const oben = zahlFeld(b, 'schwelle_oben');
    if (oben !== null) w.schwelle_oben = zahl(oben, einheit);
    const prozent = zahlFeld(b, 'schwelle_prozent');
    if (prozent !== null) w.prozent = zahl(prozent, '%');
    const ziel = b.ziel;
    if (Array.isArray(ziel) && ziel.length > 0) {
      w.zielworte = ziel.map((z) => zustandswort(worte, String(z))).join(' oder ');
    }
    const dauerS = zahlFeld(b, 'dauer_s') ?? 0;
    const art = text(b, 'art') ?? '';
    const mitWartezeit = dauerS > 0 && ['ueber', 'unter', 'ausserhalb', 'keine_daten', 'zustand'].includes(art);
    w.wartezeit = mitWartezeit ? (vorlage(MELDUNG_ALLGEMEIN.eigene.wartezeit, { wartezeit: dauer(dauerS) }) ?? '') : '';
  } else {
    w.wartezeit = '';
  }
  const regelName = e.regelName;
  if (regelName && regelName.trim() !== '' && e.herkunft !== 'ab_werk' && regelName !== name) w.name = regelName;
  const bedingung = vorlage(MELDUNG_ALLGEMEIN.eigene.bedingung[eigeneSchluessel(e)], w);
  if (bedingung !== null) w.bedingung = bedingung;
  return w;
}

function zustandswort(worte: Record<string, string> | undefined, zustand: string): string {
  return worte?.[zustand] ?? MELDUNG_ALLGEMEIN.zustandswort_ersatz;
}

// ---------------------------------------------------------------------------------------------- Vorlagen

export function vorlage(v: TextVorlage | undefined, w: Werte): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    for (const alternative of v) {
      const t = fuellen(alternative, w);
      if (t !== null) return t;
    }
    return null;
  }
  return fuellen(v, w);
}

function fuellen(v: string, w: Werte): string | null {
  let fehlt = false;
  const t = v.replace(PLATZHALTER, (_, name: string) => {
    const wert = w[name];
    if (wert === undefined) {
      fehlt = true;
      return '';
    }
    return wert;
  });
  return fehlt ? null : t;
}

function hinzu(saetze: string[], satz: string | null) {
  if (satz !== null && satz.trim() !== '') saetze.push(satz);
}

function gross(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

// ------------------------------------------------------------------------------------------------ Formate

interface Teile {
  jahr: number;
  monat: number;
  tag: number;
  stunde: number;
  minute: number;
}

const FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

function teile(d: Date): Teile {
  const p: Record<string, number> = {};
  for (const t of FORMAT.formatToParts(d)) {
    if (t.type !== 'literal') p[t.type] = Number(t.value);
  }
  return { jahr: p.year, monat: p.month, tag: p.day, stunde: p.hour, minute: p.minute };
}

/** Kalendertag als Zahl (UTC-Mitternacht des Berliner Datums) - für „heute“/„gestern“ ohne Zeitzonen-Fallen. */
function tagZahl(t: Teile): number {
  return Date.UTC(t.jahr, t.monat - 1, t.tag) / 86_400_000;
}

/** Uhrzeit in deutscher Ortszeit: „12:18 Uhr“ (heute), „gestern, 23:50 Uhr“, „12.11., 9:05 Uhr“, mit Jahr wenn anders. */
export function zeit(t: Date, jetzt: Date): string {
  const z = teile(t);
  const h = teile(jetzt);
  const uhr = `${z.stunde}:${String(z.minute).padStart(2, '0')} Uhr`;
  const abstand = tagZahl(h) - tagZahl(z);
  if (abstand === 0) return uhr;
  if (abstand === 1) return `gestern, ${uhr}`;
  let datum = `${z.tag}.${z.monat}.`;
  if (z.jahr !== h.jahr) datum += String(z.jahr);
  return `${datum}, ${uhr}`;
}

function minuten(m: number): string {
  return m === 1 ? 'eine Minute' : `${m} Minuten`;
}

/** Eine Dauer in Worten, auf die Minute gerundet: „42 Minuten“, „eine Stunde und 5 Minuten“, „2 Tage“. */
export function dauer(sekunden: number): string {
  const m = Math.floor((Math.max(0, sekunden) + 30) / 60);
  if (m < 1) return 'weniger als eine Minute';
  if (m < 60) return minuten(m);
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return (h === 1 ? 'eine Stunde' : `${h} Stunden`) + (rest > 0 ? ` und ${minuten(rest)}` : '');
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return (d === 1 ? 'einen Tag' : `${d} Tage`) + (h > 0 ? ` und ${h === 1 ? 'eine Stunde' : `${h} Stunden`}` : '');
}

function gruppiert(ganz: number): string {
  const s = String(ganz);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s.charAt(i);
  }
  return out;
}

/**
 * Eine Zahl mit Einheit, deutsch (UEMS-Zahlenformat): Euro zwei Stellen („12,30 €“), Prozent keine („45 %“),
 * kWh ab 100 keine („1.234 kWh“), sonst eine („10,0 kW“, „6,6 ct/kWh“); Tausenderpunkt, echtes Minus,
 * geschütztes Leerzeichen vor der Einheit. Ohne Einheit nur die Zahl.
 */
export function zahl(wert: number, einheit: string | null): string {
  const euro = einheit === 'EUR' || einheit === '€';
  const stellen = euro ? 2 : einheit === '%' ? 0 : einheit === 'kWh' && Math.abs(wert) >= 100 ? 0 : 1;
  const faktor = stellen === 2 ? 100 : stellen === 1 ? 10 : 1;
  const n = Math.round(Math.abs(wert) * faktor);
  const ganz = Math.floor(n / faktor);
  const rest = n % faktor;
  let t = n !== 0 && wert < 0 ? MINUS : '';
  t += gruppiert(ganz);
  if (stellen > 0) t += `,${String(rest).padStart(stellen, '0')}`;
  const anzeige = euro ? '€' : einheit;
  if (anzeige && anzeige.trim() !== '') t += `\u00a0${anzeige}`;
  return t;
}
