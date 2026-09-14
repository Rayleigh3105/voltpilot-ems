/**
 * Die GERÄTESEITE ergänzt (UEMS AP-04 IP-12): die Karte „Gerät“, die Karte
 * „Einstellungen“ mit „Ändern ab <Zeitpunkt>“ und die Messkanäle mit
 * „speist MS-06 (führend)“ — als reine Ableitung aus den Fakten der Routen
 * (`GeraetDto`, `EinstellungDto`, `MesskanalDto`). Die Komponenten rendern nur.
 *
 * ⚠ Die Sätze einer Einstellungs-Fassung (Wert, Wirkung, Folgen) bildet NICHT
 * dieses Modul: es RUFT den Vertrags-Zwilling `uemsEinstellung.ts` an, der von
 * `quelle-einstellung-vectors.json` gepinnt ist. Zwei Formulierungen wären zwei
 * Wahrheiten — und die Folgen-Karte des Dialogs sagte etwas anderes als der
 * Server nach dem Eintragen.
 *
 * ⚠ Nicht erhoben ist nie geraten: eine fehlende Seriennummer heißt „nicht
 * erfasst“, und ein aus dem Bestand abgeleitetes Gerät (`aus_bestand`) nennt
 * den Beginn seines Verlaufs „in VoltPilot seit“, nie „eingebaut am“.
 */
import type {
  EinstellungEingetragen,
  EinstellungFassung,
  EinstellungNeu,
  GeraetEinstellungen,
  Messkanal,
  MesskanalSpeist,
  UemsGeraet,
} from './api';
import { parseDecimal } from './anlageFlow';
import { iso, zeitpunkteVon } from './bezugsPeriode';
import { channelLabel } from './channels';
import {
  ARTEN,
  folgen,
  gueltigZu,
  neueFassung,
  status as fassungStatus,
  wertText,
  zeitpunktText,
  ZEITZONE,
  type AnwendungsArt,
  type ArtCode,
  type Bestehende,
  type FehlerCode,
  type Status,
} from './uemsEinstellung';
import { aufzaehlung, teile } from './uemsZustand';

/** Eine Label/Wert-Zeile — dieselbe Form wie die übrigen Zeilen der Geräteseite. */
export interface Zeile {
  label: string;
  wert: string;
  detail?: string;
}

export const NICHT_ERFASST = 'nicht erfasst';

// ------------------------------------------------------------------ Gerät

/** Die Geräteart als Kundenwort (Vokabular `geraet_geraeteart_chk`). */
export const GERAETEART_WORT: Record<string, string> = {
  zaehler: 'Zähler',
  wechselrichter: 'Wechselrichter',
  controller: 'Controller',
  ladestation: 'Ladestation',
  speicher: 'Speicher',
  sonstiges: 'Gerät',
};

export interface GeraetKarte {
  /** „Zähler Z-5b“ — die Art und das konkret eingebaute Gerät. */
  titel: string;
  /** „GR-4“ — nur, wenn der Einbau anders heißt als das Gerät (nach einem Wechsel). */
  kennzeichen: string | null;
  zeilen: Zeile[];
  /** Die Energiekarten eines Controllers, nach Steckplatz. */
  karten: Zeile[];
  /** Die früheren Einbauten, der jüngste zuerst — leer heißt: keine Sektion. */
  vorgaenger: Zeile[];
}

export interface GeraetNamen {
  /** Die Namen der Komponenten, die die Seite kennt (Komponenten-ID → Name). */
  komponenten: ReadonlyMap<string, string>;
  /** Die Kennzeichen der Messstellen, die ein Kanal dieses Geräts gerade speist. */
  messstellen: readonly string[];
}

const herstellerTyp = (hersteller: string | null | undefined, typ: string | null | undefined): string | null =>
  [hersteller, typ].filter((t): t is string => Boolean(t)).join(' · ') || null;

/** Die Karte „Gerät“ aus einem UEMS-Gerät (`GET /api/v1/sites/{id}/geraete`). */
export function geraetKarte(g: UemsGeraet, namen: GeraetNamen): GeraetKarte {
  const art = GERAETEART_WORT[g.geraeteart ?? 'sonstiges'] ?? GERAETEART_WORT.sonstiges;
  const zeilen: Zeile[] = [
    { label: 'Hersteller und Typ', wert: herstellerTyp(g.hersteller, g.typ) ?? NICHT_ERFASST },
    { label: 'Seriennummer', wert: g.seriennummer ?? NICHT_ERFASST },
  ];
  if (g.bezeichnung) zeilen.push({ label: 'Bezeichnung', wert: g.bezeichnung });
  if (g.eingebaut_am) {
    zeilen.push(
      g.aus_bestand
        ? {
            label: 'In VoltPilot seit',
            wert: zeitpunktText(g.eingebaut_am),
            detail: 'Beginn des Verlaufs — der Einbautag ist nicht erfasst.',
          }
        : { label: 'Eingebaut am', wert: zeitpunktText(g.eingebaut_am) },
    );
  }
  const laufend = g.komponenten.filter((k) => k.gueltig_bis === null);
  if (laufend.length > 0) {
    const bekannt = laufend.map((k) => namen.komponenten.get(k.entity_id)).filter((n): n is string => Boolean(n));
    const fremd = laufend.length - bekannt.length;
    const worte = fremd > 0 ? [...bekannt, fremd === 1 ? 'eine weitere Komponente' : `${fremd} weitere Komponenten`] : bekannt;
    zeilen.push({ label: 'Speist', wert: aufzaehlung(worte) });
  }
  const messstellen = [...new Set(namen.messstellen)].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  if (messstellen.length > 0) zeilen.push({ label: 'Messstellen', wert: aufzaehlung(messstellen) });

  const karten = (g.teile ?? [])
    .filter((t) => t.ausgebaut_am === null)
    .sort((a, b) => (a.steckplatz ?? Number.MAX_SAFE_INTEGER) - (b.steckplatz ?? Number.MAX_SAFE_INTEGER))
    .map((t) => {
      const detail = [t.bezeichnung ? t.typ : null, t.seriennummer ? `Seriennr. ${t.seriennummer}` : null]
        .filter((s): s is string => Boolean(s))
        .join(' · ');
      return {
        label: t.steckplatz === null ? 'Steckplatz nicht erfasst' : `Steckplatz ${t.steckplatz}`,
        wert: t.bezeichnung ?? t.typ ?? 'Energiekarte',
        ...(detail ? { detail } : {}),
      };
    });

  const vorgaenger = (g.vorgaenger ?? []).map((v) => {
    const detail = [
      herstellerTyp(v.hersteller, v.typ),
      v.seriennummer ? `Seriennr. ${v.seriennummer}` : null,
      `eingebaut am ${zeitpunktText(v.eingebaut_am)}`,
    ]
      .filter((s): s is string => Boolean(s))
      .join(' · ');
    return {
      label: v.einbau_kennzeichen,
      wert: v.ausgebaut_am ? `ausgebaut am ${zeitpunktText(v.ausgebaut_am)}` : `eingebaut am ${zeitpunktText(v.eingebaut_am)}`,
      detail,
    };
  });

  return {
    titel: `${art} ${g.einbau_kennzeichen}`,
    kennzeichen: g.kennzeichen !== g.einbau_kennzeichen ? g.kennzeichen : null,
    zeilen,
    karten,
    vorgaenger,
  };
}

// ------------------------------------------------------------------ Messkanäle

/** Die Wertart der Quelle als Kundenwort (Katalog `aggregation_kind`). */
export const WERTART_WORT: Record<string, string> = {
  counter: 'Zählerstand',
  gauge: 'Momentanwert',
  state: 'Zustand',
  bitfield: 'Zustand',
  text: 'Text',
};

/** „alle 15 min“, „alle 10 s“, „alle 1 h“ — `null` ohne Kadenz. */
export function kadenzText(sekunden: number | null | undefined): string | null {
  if (!sekunden || sekunden <= 0) return null;
  if (sekunden < 60 || sekunden % 60 !== 0) return `alle ${sekunden} s`;
  if (sekunden % 3600 === 0) return `alle ${sekunden / 3600} h`;
  return `alle ${sekunden / 60} min`;
}

/**
 * „speist MS-06 (führend)“ bzw. „speist MS-01 (Vergleich · Plausibilität)“ —
 * die Rolle steht IMMER dabei: nur die führende Quelle liefert die Werte der
 * Messstelle, ein Vergleich steht daneben.
 */
export function speistText(s: MesskanalSpeist): string {
  if (s.rolle === 'fuehrend') return `speist ${s.messstelle} (führend)`;
  return `speist ${s.messstelle} (Vergleich${s.zweck ? ` · ${s.zweck}` : ''})`;
}

export const SPEIST_KEINE = 'speist keine Messstelle';

export interface KanalZeile {
  schluessel: string;
  name: string;
  /** „Zählerstand · kWh · alle 15 min“ — nur, was belegt ist. */
  detail: string;
  speist: { text: string; fuehrend: boolean }[];
  /** Die Box zeichnet den Kanal gerade nicht auf (abgewählt, aber sichtbar). */
  abgewaehlt: boolean;
}

/** Eine Zeile der Kanal-Liste: Name, Wertart/Einheit/Kadenz und was er speist. */
export function kanalZeile(k: Messkanal, entityId = ''): KanalZeile {
  const detail = [k.wertart ? WERTART_WORT[k.wertart] : null, k.einheit, kadenzText(k.kadenz_s)]
    .filter((s): s is string => Boolean(s))
    .join(' · ');
  const speist = [...(k.speist ?? [])]
    .sort((a, b) =>
      a.rolle === b.rolle ? a.messstelle.localeCompare(b.messstelle, 'de', { numeric: true }) : a.rolle === 'fuehrend' ? -1 : 1,
    )
    .map((s) => ({ text: speistText(s), fuehrend: s.rolle === 'fuehrend' }));
  return {
    schluessel: `${entityId}|${k.kanal}`,
    name: k.anzeigename ?? channelLabel(k.kanal),
    detail,
    speist,
    abgewaehlt: !k.aktiv,
  };
}

// ------------------------------------------------------------------ Einstellungen

export interface HistorieZeile {
  id: string;
  wert: string;
  /** „01.10.2026 – 01.02.2027“, „seit 01.10.2026“, „ab 01.02.2027“. */
  zeitraum: string;
  status: Status;
  /** „geplant“, „rückwirkend“ — als Wort, nie nur als Farbe. */
  marken: string[];
  zeilen: string[];
}

export interface EinstellungGruppe {
  schluessel: string;
  art: string;
  titel: string;
  /** „Messwert Leistung“, „Komponente Speicher“ — `null`: gilt für das ganze Gerät. */
  quelle: string | null;
  entityId: string | null;
  kanal: string | null;
  /** Der Wert, der jetzt gilt (sonst der nächste geplante, sonst der letzte). */
  wert: string;
  detail: string;
  /** „Ab 01.02.2027: 400/5 A“ — eine angekündigte Fassung. */
  geplant: string | null;
  historie: HistorieZeile[];
}

export interface EinstellungNamen {
  /**
   * Die Komponenten DIESER Seite (ID → Name). ⚠ Zugleich der Filter: eine
   * Fassung an einer anderen Komponente desselben Geräts (die Energiekarte
   * nebenan) gehört nicht auf diese Seite; eine Fassung am Gerät gilt für alle.
   */
  komponenten: ReadonlyMap<string, string>;
  /** `${entityId}|${kanal}` → Anzeigename des Messkanals. */
  kanaele: ReadonlyMap<string, string>;
}

const ms = (t: string): number => Date.parse(t);

function quelleWort(f: EinstellungFassung, namen: EinstellungNamen): string | null {
  if (f.entity_id === null) return null;
  if (f.kanal !== null) {
    return `Messwert ${namen.kanaele.get(`${f.entity_id}|${f.kanal}`) ?? channelLabel(f.kanal)}`;
  }
  // Trägt die Seite nur DIESE Komponente, wäre ihr Name hier eine Wiederholung
  // der Überschrift (bei 375 px drei Zeilen, gemessen am EK-2-Bild).
  if (namen.komponenten.size === 1) return null;
  return `Komponente ${namen.komponenten.get(f.entity_id)}`;
}

function zeitraumText(f: EinstellungFassung, s: Status): string {
  if (f.gueltig_bis !== null && s !== 'geplant') {
    return `${zeitpunktText(f.gueltig_ab)} – ${zeitpunktText(f.gueltig_bis)}`;
  }
  return s === 'geplant' ? `ab ${zeitpunktText(f.gueltig_ab)}` : `seit ${zeitpunktText(f.gueltig_ab)}`;
}

function historieZeile(f: EinstellungFassung, jetzt: string): HistorieZeile {
  const s = fassungStatus(f.gueltig_ab, f.gueltig_bis, jetzt);
  const marken: string[] = [];
  if (s === 'geplant') marken.push('geplant');
  if (f.rueckwirkend) marken.push('rückwirkend');
  const zeilen = [f.anwendung_text];
  if (f.tatsaechlich_ab) zeilen.push(`tatsächlich geändert am ${zeitpunktText(f.tatsaechlich_ab)}`);
  if (f.begruendung) zeilen.push(`Begründung: ${f.begruendung}`);
  if (f.eingetragen) zeilen.push(`eingetragen am ${zeitpunktText(f.eingetragen.am)} von ${f.eingetragen.von}`);
  return { id: f.id, wert: f.wert_text, zeitraum: zeitraumText(f, s), status: s, marken, zeilen };
}

/**
 * Die Karte „Einstellungen“: je Quelle und Art EINE Zeile mit dem Wert, der
 * jetzt gilt, und ihrer Historie (jüngste Fassung zuerst). Reihenfolge der
 * Arten wie der Vertrag, darin das Gerät vor Komponente vor Messwert.
 */
export function einstellungGruppen(
  e: GeraetEinstellungen,
  jetzt: string,
  namen: EinstellungNamen,
): EinstellungGruppe[] {
  const gruppen = new Map<string, EinstellungFassung[]>();
  for (const f of e.historie) {
    if (f.entity_id !== null && !namen.komponenten.has(f.entity_id)) continue;
    const schluessel = `${f.entity_id ?? ''}|${f.kanal ?? ''}|${f.art}`;
    gruppen.set(schluessel, [...(gruppen.get(schluessel) ?? []), f]);
  }
  const artRang = (art: string) => {
    const i = ARTEN.findIndex((a) => a.art === art);
    return i < 0 ? ARTEN.length : i;
  };
  const quelleRang = (f: EinstellungFassung) => (f.entity_id === null ? 0 : f.kanal === null ? 1 : 2);

  return [...gruppen.entries()]
    .map(([schluessel, fassungen]): EinstellungGruppe => {
      const sortiert = [...fassungen].sort((a, b) => ms(a.gueltig_ab) - ms(b.gueltig_ab));
      const jetztGilt = sortiert.find((f) => fassungStatus(f.gueltig_ab, f.gueltig_bis, jetzt) === 'gueltig') ?? null;
      const naechste = sortiert.find((f) => fassungStatus(f.gueltig_ab, f.gueltig_bis, jetzt) === 'geplant') ?? null;
      const zeigt = jetztGilt ?? naechste ?? sortiert[sortiert.length - 1];
      const s = fassungStatus(zeigt.gueltig_ab, zeigt.gueltig_bis, jetzt);
      const wann =
        s === 'gueltig'
          ? `gilt seit ${zeitpunktText(zeigt.gueltig_ab)}`
          : s === 'geplant'
            ? `gilt ab ${zeitpunktText(zeigt.gueltig_ab)}`
            : `galt bis ${zeitpunktText(zeigt.gueltig_bis as string)}`;
      return {
        schluessel,
        art: zeigt.art,
        titel: zeigt.art_kundenwort,
        quelle: quelleWort(zeigt, namen),
        entityId: zeigt.entity_id,
        kanal: zeigt.kanal,
        wert: zeigt.wert_text,
        detail: `${zeigt.anwendung_text} · ${wann}`,
        geplant: jetztGilt && naechste ? `Ab ${zeitpunktText(naechste.gueltig_ab)}: ${naechste.wert_text}` : null,
        historie: [...sortiert].reverse().map((f) => historieZeile(f, jetzt)),
      };
    })
    .sort((a, b) => {
      const fa = gruppen.get(a.schluessel)![0];
      const fb = gruppen.get(b.schluessel)![0];
      return artRang(a.art) - artRang(b.art) || quelleRang(fa) - quelleRang(fb) || a.schluessel.localeCompare(b.schluessel);
    });
}

// ------------------------------------------------------------------ Ändern ab <Zeitpunkt>

export interface WertFeld {
  feld: string;
  label: string;
  typ: 'zahl' | 'text' | 'janein';
  einheit?: string;
}

/** Die Eingabefelder je Art — dieselben Felder wie der Vertrag (`ARTEN[].felder`). */
export const WERT_FELDER: Record<ArtCode, WertFeld[]> = {
  wandler_strom: [
    { feld: 'primaer_a', label: 'Primär', typ: 'zahl', einheit: 'A' },
    { feld: 'sekundaer_a', label: 'Sekundär', typ: 'zahl', einheit: 'A' },
  ],
  wandler_spannung: [
    { feld: 'primaer_v', label: 'Primär', typ: 'zahl', einheit: 'V' },
    { feld: 'sekundaer_v', label: 'Sekundär', typ: 'zahl', einheit: 'V' },
  ],
  skalierung: [{ feld: 'faktor', label: 'Faktor', typ: 'zahl' }],
  offset: [
    { feld: 'wert', label: 'Wert', typ: 'zahl' },
    { feld: 'einheit', label: 'Einheit', typ: 'text' },
  ],
  vorzeichen_umgekehrt: [{ feld: 'umgekehrt', label: 'Vorzeichen umgekehrt', typ: 'janein' }],
  impulswertigkeit: [{ feld: 'impulse_je_kwh', label: 'Impulse je kWh', typ: 'zahl' }],
  zaehlerkonstante: [{ feld: 'je_kwh', label: 'je kWh', typ: 'zahl' }],
};

const felderDer = (art: string): WertFeld[] => WERT_FELDER[art as ArtCode] ?? [];

/** Die Eingabe-Texte aus einem gespeicherten Wert — die Vorbelegung „bisher“. */
export function felderAusWert(art: string, wert: Record<string, unknown> | null): Record<string, string> {
  const felder: Record<string, string> = {};
  for (const f of felderDer(art)) {
    const w = wert?.[f.feld];
    if (f.typ === 'janein') felder[f.feld] = w === true ? 'ja' : 'nein';
    else if (typeof w === 'number') felder[f.feld] = String(w).replace('.', ',');
    else felder[f.feld] = typeof w === 'string' ? w : '';
  }
  return felder;
}

/** Der Wert aus den Eingabe-Texten (Dezimalkomma erlaubt) — `null`, wenn ein Feld keine Zahl ist. */
export function wertAusFeldern(art: string, felder: Record<string, string>): Record<string, unknown> | null {
  const def = felderDer(art);
  if (def.length === 0) return null;
  const wert: Record<string, unknown> = {};
  for (const f of def) {
    const text = felder[f.feld] ?? '';
    if (f.typ === 'janein') wert[f.feld] = text === 'ja';
    else if (f.typ === 'text') wert[f.feld] = text.trim();
    else {
      const n = parseDecimal(text);
      if (n === null) return null;
      wert[f.feld] = n;
    }
  }
  return wert;
}

/** „2027-02-01“ und „08:00“ für jetzt, auf die Minute, in Europe/Berlin. */
export function jetztEingabe(jetzt: string): { datum: string; uhrzeit: string } {
  const t = teile(jetzt, ZEITZONE);
  const [tag, monat, jahr] = t.tag.split('.');
  return { datum: `${jahr}-${monat}-${tag}`, uhrzeit: `${t.stunde}:${t.minute}` };
}

export const ZEIT_SAETZE = {
  datum_fehlt: 'Bitte wählen Sie ein Datum.',
  uhrzeit_fehlt: 'Bitte geben Sie eine Uhrzeit an.',
  nicht_vorhanden: 'Diese Uhrzeit gibt es an diesem Tag nicht (Zeitumstellung).',
  zweimal: 'Diese Uhrzeit gibt es an diesem Tag zweimal (Zeitumstellung). Bitte wählen Sie eine andere.',
} as const;

/** Datum + Uhrzeit (Ortszeit Europe/Berlin) → ISO mit Versatz; nie geraten an der Zeitumstellung. */
export function zeitpunktAus(datum: string, uhrzeit: string): { iso: string } | { fehler: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return { fehler: ZEIT_SAETZE.datum_fehlt };
  if (!/^\d{2}:\d{2}$/.test(uhrzeit)) return { fehler: ZEIT_SAETZE.uhrzeit_fehlt };
  const treffer = zeitpunkteVon(`${datum}T${uhrzeit}:00`, ZEITZONE);
  if (treffer.length === 0) return { fehler: ZEIT_SAETZE.nicht_vorhanden };
  if (treffer.length > 1) return { fehler: ZEIT_SAETZE.zweimal };
  return { iso: iso(treffer[0], ZEITZONE) };
}

export interface AenderungEingabe {
  art: string;
  entityId: string | null;
  kanal: string | null;
  felder: Record<string, string>;
  anwendung: AnwendungsArt;
  datum: string;
  uhrzeit: string;
  /** „Die Änderung geschah schon früher“ — dann zählt `tatsaechlich…`. */
  frueher: boolean;
  tatsaechlichDatum: string;
  tatsaechlichUhrzeit: string;
  begruendung: string;
}

export type AenderungFeld = 'wert' | 'gueltig_ab' | 'tatsaechlich_ab';

export interface AenderungUrteil {
  /** Je Feld der Grund — in Feld-Reihenfolge des Dialogs. */
  fehler: Partial<Record<AenderungFeld, string>>;
  /** Der Wert, der zu „gilt ab“ bisher gilt („bisher 250/5 A“); `null` ohne Vorgänger. */
  bisher: string | null;
  /** Die Folgen-Karte (§5.7, A5) — leer, solange Wert oder Zeitpunkt fehlen. */
  folgen: string[];
  /** Die Anfrage für `POST …/einstellungen`; `null` bei einem Fehler. */
  neu: EinstellungNeu | null;
}

/** Die Gründe des Zwillings in Kundensätzen — je Feld, an dem der Kunde etwas ändern kann. */
const FEHLER_FELD: Record<FehlerCode, { feld: AenderungFeld; text: string }> = {
  wert_ungueltig: { feld: 'wert', text: 'Bitte geben Sie einen gültigen Wert an — Zahlen über 0.' },
  zeitpunkt_ungueltig: { feld: 'gueltig_ab', text: 'Der Zeitpunkt muss auf die Minute genau sein.' },
  vor_beginn: { feld: 'gueltig_ab', text: 'Zu diesem Zeitpunkt war das Gerät noch nicht eingebaut.' },
  nach_ende: { feld: 'gueltig_ab', text: 'Zu diesem Zeitpunkt ist das Gerät schon ausgebaut.' },
  tatsaechlich_ungueltig: {
    feld: 'tatsaechlich_ab',
    text: 'Die tatsächliche Änderung liegt vor „Gilt ab“ und nicht vor dem Einbau.',
  },
  beginn_belegt: { feld: 'gueltig_ab', text: 'Zu diesem Zeitpunkt beginnt schon eine Fassung dieser Einstellung.' },
  unveraendert: { feld: 'wert', text: 'Das ist schon der Wert, der zu diesem Zeitpunkt gilt.' },
};

/**
 * Prüft eine Änderung wie der Server (Zwilling `neueFassung`) und bildet die
 * Folgen-Sätze AUS DEN FAKTEN der Eingabe (`folgen` des Zwillings): Wert,
 * Wirkung, „gilt ab“, „tatsächlich“ und der Vorgänger zu „gilt ab“.
 *
 * `beginn` ist der Einbau des Geräts: für eine Quelle am Gerät genau ihr
 * Beginn, für Komponente oder Messwert höchstens früher — der Server prüft
 * dann genauer, der Dialog lehnt nie etwas ab, das der Server annähme.
 */
export function aenderungPruefen(
  e: AenderungEingabe,
  historie: readonly EinstellungFassung[],
  beginn: string,
  jetzt: string,
): AenderungUrteil {
  const fehler: AenderungUrteil['fehler'] = {};
  const wert = wertAusFeldern(e.art, e.felder);
  if (wert === null) fehler.wert = FEHLER_FELD.wert_ungueltig.text;
  const ab = zeitpunktAus(e.datum, e.uhrzeit);
  if ('fehler' in ab) fehler.gueltig_ab = ab.fehler;
  let tatsaechlich: string | null = null;
  if (e.frueher) {
    const t = zeitpunktAus(e.tatsaechlichDatum, e.tatsaechlichUhrzeit);
    if ('fehler' in t) fehler.tatsaechlich_ab = t.fehler;
    else tatsaechlich = t.iso;
  }
  if (wert === null || 'fehler' in ab) return { fehler, bisher: null, folgen: [], neu: null };

  const bestehende: Bestehende[] = historie
    .filter((f) => f.art === e.art && f.entity_id === e.entityId && f.kanal === e.kanal)
    .map((f) => ({ id: f.id, wert: f.wert, anwendung: f.anwendung, gueltigAb: f.gueltig_ab, gueltigBis: f.gueltig_bis }));
  const urteil = neueFassung({
    beginn,
    ende: null,
    bestehende,
    neu: { art: e.art, wert, anwendung: e.anwendung, gueltigAb: ab.iso, tatsaechlichAb: tatsaechlich },
    jetzt,
  });
  // Auch eine abgelehnte Fassung hat einen Vorgänger — „bisher“ steht trotzdem da.
  const vorgaenger = urteil.vorgaenger ?? gueltigZu(bestehende, ab.iso);
  if (urteil.fehler !== null) {
    const f = FEHLER_FELD[urteil.fehler];
    fehler[f.feld] ??= f.text;
  }
  const bisher = vorgaenger ? wertText(e.art, vorgaenger.wert) : null;
  const saetze =
    fehler.wert || fehler.gueltig_ab
      ? []
      : folgen(
          e.art,
          'eintrag',
          { wert, anwendung: e.anwendung, gueltigAb: ab.iso, tatsaechlichAb: tatsaechlich },
          vorgaenger ? { wert: vorgaenger.wert, anwendung: vorgaenger.anwendung } : null,
        );
  const ok = Object.keys(fehler).length === 0;
  return {
    fehler,
    bisher,
    folgen: saetze,
    neu: ok
      ? {
          entity_id: e.entityId,
          kanal: e.kanal,
          art: e.art,
          wert,
          anwendung: e.anwendung,
          gueltig_ab: ab.iso,
          tatsaechlich_ab: tatsaechlich,
          begruendung: e.begruendung.trim() || null,
        }
      : null,
  };
}

/**
 * „Ab 01.02.2027, 08:00 Uhr eintragen“ — der Knopf nennt den Zeitpunkt, der
 * eingetragen wird. Kurz genug für eine Zeile bei 375 px neben „Abbrechen“
 * (gemessen: „Einstellung ab … eintragen“ lief über den Rand).
 */
export function eintragenText(datum: string, uhrzeit: string): string {
  const ab = zeitpunktAus(datum, uhrzeit);
  return 'fehler' in ab ? 'Eintragen' : `Ab ${zeitpunktText(ab.iso)} eintragen`;
}

/** Die zwei Wege, wie eine Einstellung wirkt — Wortlaut der Wahl im Dialog (W1). */
export const ANWENDUNG_WAHL: { id: AnwendungsArt; titel: string; zeile: string }[] = [
  {
    id: 'dokumentiert',
    titel: 'Im Gerät eingestellt — nur dokumentiert',
    zeile: 'Das Gerät rechnet selbst; VoltPilot merkt sich, womit gemessen wurde.',
  },
  {
    id: 'angewendet',
    titel: 'Von VoltPilot beim Erfassen angewendet',
    zeile: 'Die VoltPilot-Box rechnet ab „Gilt ab“ damit, sobald die Einstellung zugestellt ist.',
  },
];

/** „Eingetragen: Wandlerverhältnis Strom 400/5 A ab 01.02.2027. Im Protokoll von MS-11 vermerkt.“ */
export function eingetragenText(e: EinstellungEingetragen): string {
  const f = e.fassung;
  const satz = `Eingetragen: ${f.art_kundenwort} ${f.wert_text} ab ${zeitpunktText(f.gueltig_ab)}.`;
  return e.messstellen.length > 0 ? `${satz} Im Protokoll von ${aufzaehlung(e.messstellen)} vermerkt.` : satz;
}
