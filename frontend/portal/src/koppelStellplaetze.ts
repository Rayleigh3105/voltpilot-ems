/**
 * **Stellplätze einer Anlagensteuerung** (PFC200 Stufe 4 „Wünschen“, Vertrag `docs/contracts/v2/koppelbild.md`
 * §5, §7, §10, §15): was die Steuerung je Stellplatz anbietet und drei getrennte Zeilen - der Wunsch der Box, die
 * Quittung der Steuerung und was die Anlage wirklich anwendet. Ein Wunsch ist nie ein Befehl: die Steuerung
 * entscheidet, und die Wirkung an der Anlage sieht nur ein Mensch vor Ort.
 *
 * Die Werte kommen in ganzen Einheiten des Bilds (W, 0,1 %, 0/1, Betriebsart 1 bis 8, 0,1 °C). Diese Datei rechnet
 * und formuliert nur; `components/KoppelStellplaetze.tsx` und `KoppelStellplatzDialog.tsx` rendern ihr Ergebnis.
 *
 * Fehlend ist keine Null: ohne lesbare Quittung steht „unbekannt“, ein alter Stand trägt seine Uhrzeit und gilt
 * nie als jetzt.
 */
import type { KoppelbildAngebot, Koppelbild, KoppelbildStand, KoppelbildFreigabe, KoppelbildStellplatz, KoppelTestAntwort } from './api';
import { NBSP, ortsUhrzeit } from './format';
import { KOPPEL_SCHALT_TEST, KOPPEL_STELLPLATZ } from './glossar';
import { zahlText } from './zahl';

/** Wie lange ein Schalt-Test seinen Testwunsch schreibt (§15). */
export const KOPPEL_TEST_S = 30;

const MINUS = '−';
const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF01 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export const UNBEKANNT = 'unbekannt';

// ---------------------------------------------------------------------------
// Art, Ziel, Wert
// ---------------------------------------------------------------------------

export type KoppelArt = 'limit_w' | 'limit_pct' | 'setpoint_w' | 'on_off' | 'mode' | 'setpoint_c';

/** Was ein Stellplatz der Art stellt - die Zeile über dem Band. */
const ART_NAME: Record<KoppelArt, string> = {
  limit_w: 'Obergrenze der Leistung',
  limit_pct: 'Obergrenze in Prozent',
  setpoint_w: 'Sollwert der Leistung',
  on_off: 'Ein und Aus',
  mode: 'Betriebsart',
  setpoint_c: 'Sollwert der Temperatur',
};

const istArt = (art: string): art is KoppelArt => art in ART_NAME;

export function artName(art: string): string {
  return istArt(art) ? ART_NAME[art] : 'unbekannte Art';
}

/** Eine Grenze begrenzt und fordert nie an: ohne sie begrenzt niemand. */
const istGrenze = (art: string) => art === 'limit_w' || art === 'limit_pct';

/** Das Ziel eines Stellplatzes in Kundenwörtern; `einheit` ist die Nummer der Erzeugungseinheit (für den Weg dorthin). */
export function zielText(ziel: string, nr: number): { text: string; einheit: number | null } {
  switch (ziel) {
    case 'erzeugung_gesamt':
      return { text: 'ganze Erzeugung', einheit: null };
    case 'erzeugungseinheit':
      return { text: `Einheit ${nr}`, einheit: nr };
    case 'speicher':
      return { text: `Speicher ${nr}`, einheit: null };
    case 'verbraucher':
      return { text: `Verbraucher ${nr}`, einheit: null };
    case 'netzbezug':
      return { text: 'Netzbezug', einheit: null };
    case 'einspeisung':
      return { text: 'Einspeisung', einheit: null };
    case 'probe':
      return { text: 'Lampe am Gerät', einheit: null };
    default:
      return { text: 'unbekanntes Ziel', einheit: null };
  }
}

/** Ein Vorzeichen nur, wenn die gerundete Zahl nicht null ist - nie „−0,0“. */
function mitMinus(betrag: string, negativ: boolean): string {
  return negativ && /[1-9]/.test(betrag) ? `${MINUS}${betrag}` : betrag;
}

/** W → „159,0 kW“ (eine Stelle, echtes Minus). */
export function kwAusW(w: number): string {
  return `${mitMinus(NF1.format(Math.abs(w) / 1000), w < 0)}${NBSP}kW`;
}

/**
 * Ein Wert in ganzen Einheiten des Bilds als Text. Am Speicher sagt das Vorzeichen die Richtung (+ lädt,
 * − entlädt, §7); eine Prozent-Grenze zeigt ihre Zehntel, wenn sie welche hat (Rundung nie verstecken).
 */
export function wertText(art: string, wert: number, ziel?: string): string {
  switch (art) {
    case 'limit_w':
      return kwAusW(wert);
    case 'setpoint_w':
      if (ziel === 'speicher' && wert !== 0) return `${wert > 0 ? 'lädt' : 'entlädt'} ${kwAusW(Math.abs(wert))}`;
      return kwAusW(wert);
    case 'limit_pct':
      return `${mitMinus(NF01.format(Math.abs(wert) / 10), wert < 0)}${NBSP}%`;
    case 'setpoint_c':
      return `${mitMinus(NF1.format(Math.abs(wert) / 10), wert < 0)}${NBSP}°C`;
    case 'on_off':
      return wert === 1 ? 'ein' : wert === 0 ? 'aus' : `Wert ${wert}`;
    case 'mode':
      return `Betriebsart ${wert}`;
    default:
      return String(wert);
  }
}

/** Das Band eines Angebots: „0,0 bis 265,0 kW“, „aus oder ein“, „Betriebsart 1 bis 4“. */
export function bandText(a: Pick<KoppelbildAngebot, 'art' | 'min' | 'max'>, bis = 'bis'): string {
  if (a.art === 'on_off') {
    if (a.min === a.max) return `nur ${wertText('on_off', a.min)}`;
    return 'aus oder ein';
  }
  if (a.art === 'mode') return a.min === a.max ? `nur Betriebsart ${a.min}` : `Betriebsart ${a.min} bis ${a.max}`;
  // Am Speicher bleibt das Band beim Vorzeichen: „−5,0 bis 5,0 kW“ liest sich, „entlädt 5,0 bis lädt 5,0“ nicht.
  const ohneRichtung = (w: number) => wertText(a.art, w);
  const [min, max] = [ohneRichtung(a.min), ohneRichtung(a.max)];
  const einheit = min.slice(min.lastIndexOf(NBSP));
  return `${min.endsWith(einheit) ? min.slice(0, -einheit.length) : min} ${bis} ${max}`;
}

// ---------------------------------------------------------------------------
// Bereit, Grund, Quittung
// ---------------------------------------------------------------------------

/** Die Gründe aus `a_bits` (§6); mit oder ohne Vorsilbe `grund_`. */
const A_GRUND: Record<string, string> = {
  stoerung: 'Störung',
  hand_ort: 'Anlage auf Hand oder Ort',
  wartung: 'Wartung',
  vorrang: 'eine Stelle mit Vorrang bestimmt',
  sonstiger: 'sonstiger Grund',
};

function aGruende(gruende: readonly string[]): string[] {
  return gruende
    .map((g) => g.replace(/^grund_/, ''))
    .filter((g) => g !== 'bereit')
    .map((g) => A_GRUND[g] ?? 'unbekannter Grund');
}

export type Ton = 'gut' | 'warn' | 'stoerung' | 'still';

/**
 * Ob der Stellplatz jetzt gestellt werden kann. `grund_vorrang` darf neben `bereit` stehen (§6, K3): der Stellplatz
 * nimmt Wünsche an, eine Stelle mit Vorrang bestimmt trotzdem.
 */
export function bereitText(a: Pick<KoppelbildAngebot, 'bereit' | 'gruende'>): { text: string; ton: Ton } {
  const gruende = aGruende(a.gruende);
  if (a.bereit) {
    return gruende.length ? { text: `bereit · ${gruende.join(', ')}`, ton: 'warn' } : { text: 'bereit', ton: 'gut' };
  }
  return { text: gruende.length ? `nicht bereit: ${gruende.join(', ')}` : 'nicht bereit', ton: 'warn' };
}

/** Warum die Box wünscht (§7 `grund`): Auskunft, keine Weiche. */
export function grundText(grund: string | null | undefined): string | null {
  switch (grund) {
    case 'markt':
      return 'Fahrplan';
    case 'netz':
      return 'Netz';
    case 'regel':
      return 'Regel';
    case 'hand':
      return 'Handeingriff';
    case 'test':
      return KOPPEL_SCHALT_TEST;
    default:
      return null;
  }
}

const gesperrt = (stand: KoppelbildStand | null) => stand?.lage === 'gesperrt' || stand?.fernsteuerung_frei === false;

/** Die Quittung der Steuerung zu einem Wunsch (`q_urteil`, §7) - nie die Wirkung. */
export function urteilText(urteil: string, angebot: KoppelbildAngebot | null, stand: KoppelbildStand | null): string {
  switch (urteil) {
    case 'angenommen':
      return 'angenommen';
    case 'begrenzt':
      return 'auf das Band begrenzt';
    case 'ueberstimmt':
      return 'überstimmt - eine Stelle mit Vorrang bestimmt';
    case 'art_fremd':
      return 'Art passt nicht zum Angebot';
    case 'wert_ungueltig':
      return 'Wert ungültig';
    case 'nicht_bereit': {
      if (gesperrt(stand)) return 'nicht bereit: Fernsteuerung an der Anlage gesperrt';
      const gruende = angebot ? aGruende(angebot.gruende).filter((g) => g !== A_GRUND.vorrang) : [];
      return gruende.length ? `nicht bereit: ${gruende.join(', ')}` : 'nicht bereit';
    }
    case 'abgelaufen':
      return 'abgelaufen - die Anlage fährt mit eigenen Werten';
    case 'kein_wunsch':
      return 'kein Wunsch';
    default:
      return 'unbekannte Quittung';
  }
}

const URTEIL_TON: Record<string, Ton> = {
  angenommen: 'gut',
  begrenzt: 'warn',
  ueberstimmt: 'warn',
  art_fremd: 'stoerung',
  wert_ungueltig: 'stoerung',
  nicht_bereit: 'warn',
  abgelaufen: 'warn',
  kein_wunsch: 'still',
};

// ---------------------------------------------------------------------------
// Kopf: Lage, Frist, Bibliothek, Datenalter
// ---------------------------------------------------------------------------

/** Der Satz zur Lage der Box gegenüber der Steuerung (§10). */
export function lageSatz(lage: string, grund: string | null): { satz: string; ton: Ton } {
  switch (lage) {
    case 'bereit':
      return { satz: 'Die Steuerung nimmt Wünsche der Box an.', ton: 'gut' };
    case 'gesperrt':
      return { satz: 'Fernsteuerung an der Anlage gesperrt - die Steuerung nimmt gerade keine Wünsche an.', ton: 'warn' };
    case 'sps_neustart':
      return { satz: 'Steuerung neu gestartet - die Box bildet ihre Wünsche neu.', ton: 'warn' };
    case 'sps_steht':
      return { satz: 'Steuerung steht - ihre Werte gelten als veraltet, die Box wünscht nichts.', ton: 'stoerung' };
    case 'zweiter_schreiber':
      return {
        satz: 'Zweiter Schreiber - ein anderes Gerät schickt dieser Steuerung Wünsche. Die Box schreibt darum nicht mehr.',
        ton: 'stoerung',
      };
    case 'steuerung_fremd':
      return { satz: 'Falsche Steuerung - die Steuerungskennung passt nicht. Die Box schreibt nichts.', ton: 'stoerung' };
    case 'nicht_lesbar':
      return grund === 'signatur_fremd'
        ? { satz: 'Diese Steuerung hat kein Koppelbild - die Box schickt ihr keine Wünsche.', ton: 'still' }
        : { satz: 'Quittung nicht lesbar - die Box schreibt nichts, bis sie wieder lesbar ist.', ton: 'stoerung' };
    case 'keine_antwort':
      return { satz: 'Keine Antwort - die Steuerung antwortet der Box nicht.', ton: 'stoerung' };
    case 'ohne_soll':
      return {
        satz: 'Steuerungskennung fehlt - in der Fassung dieser Steuerung ist keine eingetragen, darum schreibt die Box nie.',
        ton: 'stoerung',
      };
    default:
      return { satz: 'Die Box meldet eine unbekannte Lage.', ton: 'stoerung' };
  }
}

const gleicherTag = (d: Date, now: Date) => d.toDateString() === now.toDateString();
const tagText = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;

/** „21:30“ am selben Tag, sonst „19.11., 21:30“ - in Ortszeit. */
export function standZeit(iso: string, now: Date): string {
  const d = new Date(iso);
  return gleicherTag(d, now) ? ortsUhrzeit(d) : `${tagText(d)}, ${ortsUhrzeit(d)}`;
}

/** „um 21:30“ am selben Tag, sonst „am 19.11. um 21:30“ - für einen Satz. */
export function zeitpunktText(iso: string, now: Date): string {
  const d = new Date(iso);
  return gleicherTag(d, now) ? `um ${ortsUhrzeit(d)}` : `am ${tagText(d)} um ${ortsUhrzeit(d)}`;
}

export interface KoppelKopf {
  satz: string;
  ton: Ton;
  /** „gilt noch 58 s“, „abgelaufen …“ - nur bei einem aktuellen Stand. */
  frist: string | null;
  /** „Stand von 21:30“, wenn der Stand älter als 120 s ist; dann ist nichts davon „jetzt“. */
  alt: string | null;
  /** „Bibliothek 1.0“. */
  bibliothek: string | null;
  /** Gesetzt, wenn die Bibliothek in der Steuerung älter ist als das Soll. */
  bibliothekWarnung: string | null;
}

/** „Stand von 21:30“ bzw. „Stand vom 19.11., 21:30“. */
function altText(iso: string, now: Date): string {
  return `${gleicherTag(new Date(iso), now) ? 'Stand von' : 'Stand vom'} ${standZeit(iso, now)}`;
}

export const BOX_KANN_NICHT = 'Die Box dieser Anlage kann der Steuerung noch keine Wünsche schicken.';

export function koppelKopf(bild: Koppelbild, now: Date = new Date()): KoppelKopf {
  const leer = { frist: null, alt: null, bibliothek: null, bibliothekWarnung: null };
  const stand = bild.stand;
  if (!stand) {
    return bild.unterstuetzt
      ? { ...leer, satz: 'Die Box hat zu dieser Steuerung noch keinen Stand gemeldet.', ton: 'still' }
      : { ...leer, satz: BOX_KANN_NICHT, ton: 'still' };
  }
  const { satz, ton } = lageSatz(stand.lage, stand.grund);
  let frist: string | null = null;
  if (stand.aktuell) {
    if (stand.kopf_urteil === 'abgelaufen') frist = 'abgelaufen - die Anlage fährt mit eigenen Werten';
    else if (stand.kopf_urteil === 'angenommen' && stand.rest_s != null) frist = `gilt noch ${stand.rest_s}${NBSP}s`;
  }
  return {
    satz,
    ton: stand.aktuell ? ton : 'still',
    frist,
    alt: stand.aktuell ? null : altText(stand.empfangen_at, now),
    bibliothek: stand.bibliothek ? `Bibliothek ${stand.bibliothek}` : null,
    bibliothekWarnung:
      stand.bibliothek_veraltet === true
        ? `Die VoltPilot-Bibliothek in der Steuerung ist veraltet (${stand.bibliothek ?? UNBEKANNT}, aktuell ${stand.bibliothek_soll}).`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Freigabe
// ---------------------------------------------------------------------------

export function freigabeStatus(f: KoppelbildFreigabe): { text: string; ton: Ton } {
  switch (f.status) {
    case 'freigegeben':
      return { text: 'freigegeben', ton: 'gut' };
    case 'getestet':
      return { text: 'getestet, noch nicht freigegeben', ton: 'warn' };
    case 'verfallen':
      return { text: 'Freigabe verfallen', ton: 'warn' };
    default:
      return { text: 'nicht freigegeben', ton: 'still' };
  }
}

/** Warum die Freigabe gerade nicht geht (`freigabe_grund`). */
export function freigabeGrundText(grund: string | null): string | null {
  switch (grund) {
    case null:
      return null;
    case 'kein_test':
      return 'Für die Freigabe braucht es zuerst einen bestandenen Schalt-Test.';
    case 'test_nicht_angenommen':
      return 'Die Steuerung hat den letzten Testwunsch nicht angenommen. Fahren Sie den Schalt-Test noch einmal.';
    case 'kommando_belegt':
      return 'Für diese Art ist schon ein anderer Stellplatz freigegeben.';
    case 'angebot_fehlt':
      return 'Die Steuerung bietet an diesem Stellplatz gerade nichts an.';
    case 'box_kann_nicht':
      return BOX_KANN_NICHT;
    default:
      return 'Die Freigabe ist gerade nicht möglich.';
  }
}

/** Warum eine Freigabe verfallen ist (`verfallen_grund`) - nie ein roher Code. */
export function verfallenText(grund: string | null): string {
  return grund === 'angebot_geaendert'
    ? 'Die Freigabe ist verfallen, weil das Anlagenprogramm Art, Ziel oder Band dieses Stellplatzes geändert hat. Für eine neue braucht es einen neuen Schalt-Test.'
    : 'Die Freigabe ist verfallen. Für eine neue braucht es einen neuen Schalt-Test.';
}

export const FREIGABE_FOLGEN = [
  'Die Box darf diesem Stellplatz danach Wünsche schicken - aus Fahrplan, Regeln und Handeingriff.',
  'Die Steuerung entscheidet weiter selbst: Sie kann jeden Wunsch begrenzen oder überstimmen.',
  'Jeder Wunsch läuft nach spätestens 60 Sekunden von selbst ab. Meldet sich die Box nicht mehr, fährt die Anlage mit eigenen Werten.',
  'Ändert das Anlagenprogramm Art, Ziel oder Band dieses Stellplatzes, fällt die Freigabe.',
];

export const RUECKNAHME_FOLGEN = [
  'Die Box schickt diesem Stellplatz danach keine Wünsche mehr; die Anlage fährt hier mit eigenen Werten.',
  'Ein neuer Schalt-Test und eine neue Freigabe sind jederzeit möglich.',
];

// ---------------------------------------------------------------------------
// Ein Stellplatz als Anzeige
// ---------------------------------------------------------------------------

export interface Zeile {
  text: string;
  ton: Ton;
}

export interface StellplatzAnzeige {
  platz: number;
  titel: string;
  angebot: {
    art: string;
    ziel: string;
    /** Nummer der Erzeugungseinheit, wenn das Ziel eine ist (Weg zu ihrer Seite). */
    einheit: number | null;
    band: string;
    bereit: Zeile;
  } | null;
  wunsch: Zeile;
  quittung: Zeile;
  wirksam: Zeile;
  freigabe: Zeile;
  /** Schalt-Test und Freigabe öffnen: mit Angebot, oder um eine bestehende Freigabe zurückzunehmen. */
  bedienbar: boolean;
}

/** Ob die Werte eines Stellplatzes aus einer lesbaren Lesung stammen (§15: ohne `gelesen_at` sind sie null). */
const gelesen = (stand: KoppelbildStand | null) => stand != null && stand.gelesen_at != null;

export function wunschZeile(sp: KoppelbildStellplatz): Zeile {
  if (!sp.wunsch) return { text: 'kein Wunsch', ton: 'still' };
  const ziel = sp.angebot?.ziel;
  const grund = grundText(sp.wunsch.grund) ?? (sp.test ? KOPPEL_SCHALT_TEST : null);
  return { text: [wertText(sp.wunsch.art, sp.wunsch.wert, ziel), grund].filter(Boolean).join(' · '), ton: 'gut' };
}

export function quittungZeile(sp: KoppelbildStellplatz, stand: KoppelbildStand | null): Zeile {
  if (!gelesen(stand) || sp.urteil == null) return { text: 'keine lesbare Quittung', ton: 'still' };
  const text = urteilText(sp.urteil, sp.angebot, stand);
  // Die Steuerung quittiert eine Folge (`q_folge`); passt sie nicht zum Wunsch, gilt die Quittung einem früheren.
  const frueher = sp.wunsch != null && sp.folge != null && sp.folge !== sp.wunsch.folge && sp.urteil !== 'kein_wunsch';
  return { text: frueher ? `${text} · zu einem früheren Wunsch` : text, ton: URTEIL_TON[sp.urteil] ?? 'stoerung' };
}

export function wirksamZeile(sp: KoppelbildStellplatz, stand: KoppelbildStand | null): Zeile {
  const art = sp.angebot?.art ?? sp.wunsch?.art ?? null;
  if (sp.wirksam != null && art) return { text: wertText(art, sp.wirksam, sp.angebot?.ziel), ton: 'gut' };
  if (!gelesen(stand) || sp.wunsch != null || !art) return { text: UNBEKANNT, ton: 'still' };
  // Ohne Wunsch und ohne wirksamen Wert: eine Grenze begrenzt dann niemand, ein Sollwert kommt von der Anlage.
  return { text: istGrenze(art) ? 'niemand begrenzt' : 'die Anlage regelt selbst', ton: 'still' };
}

export function stellplatzAnzeige(sp: KoppelbildStellplatz, bild: Koppelbild): StellplatzAnzeige {
  const a = sp.angebot;
  return {
    platz: sp.platz,
    titel: `${KOPPEL_STELLPLATZ} ${sp.platz}`,
    angebot: a
      ? {
          art: artName(a.art),
          ziel: zielText(a.ziel, a.nr).text,
          einheit: zielText(a.ziel, a.nr).einheit,
          band: bandText(a),
          bereit: bereitText(a),
        }
      : null,
    wunsch: wunschZeile(sp),
    quittung: quittungZeile(sp, bild.stand),
    wirksam: wirksamZeile(sp, bild.stand),
    freigabe: freigabeStatus(sp.freigabe),
    bedienbar: a != null || sp.freigabe.status === 'freigegeben',
  };
}

export function stellplatzAnzeigen(bild: Koppelbild): StellplatzAnzeige[] {
  return [...bild.stellplaetze].sort((x, y) => x.platz - y.platz).map((sp) => stellplatzAnzeige(sp, bild));
}

// ---------------------------------------------------------------------------
// Schalt-Test: Eingabe und Ergebnis
// ---------------------------------------------------------------------------

export type TestEingabe =
  | { art: 'on_off'; werte: { wert: number; text: string }[] }
  | { art: 'mode'; werte: { wert: number; text: string }[] }
  | { art: 'zahl'; einheit: string; stellen: number; label: string };

/** Eine Zahl je Art: Eingabe in kW, %, °C; ins Bild mit `stellen` Nachkommastellen als ganze Einheiten. */
const ZAHL_EINGABE: Partial<Record<KoppelArt, { einheit: string; stellen: number }>> = {
  limit_w: { einheit: 'kW', stellen: 3 },
  setpoint_w: { einheit: 'kW', stellen: 3 },
  limit_pct: { einheit: '%', stellen: 1 },
  setpoint_c: { einheit: '°C', stellen: 1 },
};

export function testEingabe(a: KoppelbildAngebot): TestEingabe | null {
  if (a.art === 'on_off' || a.art === 'mode') {
    const werte: { wert: number; text: string }[] = [];
    for (let w = a.min; w <= a.max && werte.length < 16; w += 1) werte.push({ wert: w, text: wertText(a.art, w) });
    return { art: a.art, werte };
  }
  const z = istArt(a.art) ? ZAHL_EINGABE[a.art] : undefined;
  if (!z) return null;
  const band = bandText(a);
  const speicher = a.art === 'setpoint_w' && a.ziel === 'speicher' ? '; + lädt, − entlädt' : '';
  return { art: 'zahl', ...z, label: `Testwert in ${z.einheit} (${band}${speicher})` };
}

/**
 * Ein deutscher Zahlentext (über `zahlText`) in ganzen Einheiten mit `stellen` Nachkommastellen - exakt, ohne
 * Gleitkomma, halb vom Nullpunkt weg gerundet wie die Box (§15). Ungültig ist `null`.
 */
export function ganzeEinheiten(text: string, stellen: number): number | null {
  const s = zahlText(text.replace(/−/g, '-'));
  if (s === null) return null;
  const negativ = s.startsWith('-');
  const [ganz, bruch = ''] = s.replace(/^[+-]/, '').replace(/\./g, '').split(',');
  const ziffern = (bruch + '0'.repeat(stellen + 1)).slice(0, stellen + 1);
  let n = Number(ganz + ziffern.slice(0, stellen));
  if (Number(ziffern[stellen]) >= 5) n += 1;
  if (!Number.isSafeInteger(n)) return null;
  return negativ && n !== 0 ? -n : n;
}

/** Der Testwert aus der Eingabe, im Band des Angebots - sonst ein sichtbarer Fehler. */
export function testWert(a: KoppelbildAngebot, text: string): { wert: number } | { fehler: string } {
  const e = testEingabe(a);
  if (!e) return { fehler: 'Diese Art kann das Portal nicht testen.' };
  if (e.art !== 'zahl') {
    const wert = text.trim() === '' ? null : Number(text);
    if (wert == null || !e.werte.some((w) => w.wert === wert)) return { fehler: 'Bitte wählen Sie einen Testwert.' };
    return { wert };
  }
  if (text.trim() === '') return { fehler: 'Bitte geben Sie einen Testwert ein.' };
  const wert = ganzeEinheiten(text, e.stellen);
  if (wert == null) return { fehler: `Bitte geben Sie eine Zahl in ${e.einheit} ein, zum Beispiel 12,5.` };
  if (wert < a.min || wert > a.max) return { fehler: `Der Testwert muss zwischen ${bandText(a, 'und')} liegen.` };
  return { wert };
}

export interface TestErgebnisAnzeige {
  /** Die Steuerung hat den Testwunsch zu genau dieser Folge angenommen (auch begrenzt). */
  angenommen: boolean;
  titel: string;
  quittung: string | null;
  wirksam: string | null;
}

/** Wie die Box den Testwunsch mitnahm und was die Steuerung dazu sagte. Die Wirkung an der Anlage steht hier nie. */
export function testErgebnis(antwort: KoppelTestAntwort, a: KoppelbildAngebot): TestErgebnisAnzeige {
  const k = antwort.koppel_test;
  if (!k) return { angenommen: false, titel: antwort.satz || 'Die Box hat den Schalt-Test nicht ausgeführt.', quittung: null, wirksam: null };
  const quittung = k.urteil ? urteilText(k.urteil, a, null) : null;
  const wirksam = k.wirksam != null ? wertText(a.art, k.wirksam, a.ziel) : null;
  // `ok` heißt: der Beleg ist gespeichert - auch „überstimmt“ zählt (die Steuerung hat angenommen, eine Stelle mit
  // Vorrang bestimmt gerade); die Freigabe entscheidet trotzdem der Server.
  const angenommen = antwort.ok && (k.urteil === 'angenommen' || k.urteil === 'begrenzt' || k.urteil === 'ueberstimmt');
  let titel: string;
  if (angenommen) {
    titel = k.urteil === 'begrenzt'
      ? 'Die Steuerung hat den Testwunsch angenommen, aber auf ihr Band begrenzt.'
      : k.urteil === 'ueberstimmt'
        ? 'Die Steuerung hat den Testwunsch angenommen, aber eine Stelle mit Vorrang bestimmt gerade.'
        : 'Die Steuerung hat den Testwunsch angenommen.';
  } else if (k.geschrieben === false) {
    titel = `Die Box hat den Testwunsch nicht geschrieben. ${lageSatz(k.lage, k.grund ?? null).satz}`;
  } else if (!k.urteil) {
    titel = 'Zu diesem Testwunsch kam keine Quittung der Steuerung.';
  } else if (k.urteil === 'angenommen' || k.urteil === 'begrenzt') {
    titel = 'Die Quittung der Steuerung gehört nicht zu diesem Testwunsch.';
  } else {
    titel = 'Die Steuerung hat den Testwunsch nicht angenommen.';
  }
  return { angenommen, titel, quittung, wirksam };
}

export const WIRKUNG_HINWEIS =
  `Ob die Anlage dem Testwert folgt, zeigt die Quittung nicht. Sehen Sie an der Anlage nach - der Testwunsch gilt ${KOPPEL_TEST_S} Sekunden und läuft dann von selbst ab.`;

/** Der zuletzt gespeicherte Test eines Stellplatzes, als Zeile: „200,0 kW · angenommen · wirksam 200,0 kW · 21:30“. */
export function letzterTestText(f: KoppelbildFreigabe, a: KoppelbildAngebot | null, now: Date = new Date()): string | null {
  const t = f.test;
  if (!t || !a) return null;
  return [
    wertText(a.art, t.wert, a.ziel),
    t.urteil ? urteilText(t.urteil, a, null) : 'keine Quittung',
    t.wirksam != null ? `wirksam ${wertText(a.art, t.wirksam, a.ziel)}` : null,
    standZeit(t.at, now),
  ].filter(Boolean).join(' · ');
}
