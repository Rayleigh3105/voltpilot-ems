/**
 * Die Kundenfläche der GEMEINSAMEN STEUERUNG (UEMS AP-15 IP-23, Konzept §5.2, §5.5, §5.8) — reine Ableitungen;
 * `components/GemeinsameSteuerungKarte.tsx` und `components/GemeinsameSteuerungEinrichten.tsx` rendern ihr Ergebnis.
 *
 * Jeder Satz kommt aus `uemsGemeinsameSteuerung.ts` (§5.8 in `SAETZE`, die übrigen in `FLAECHE`); hier wird nur
 * eingesetzt. Die Karte erscheint nur, wenn die Anlage steuert UND mehr als eine Box hat — wer nur misst, sieht sie
 * nie. Der Kunde richtet ein und hält an; er schaltet nicht scharf (I5).
 */
import {
  deviceLiveStatus,
  type Device,
  type Funktionen,
  type UemsDreiwert,
  type UemsErklaerungLuecke,
  type UemsGemeinsameSteuerungAuslegung,
  type UemsGemeinsameSteuerungBefund,
  type UemsGemeinsameSteuerungEinrichten,
  type UemsGemeinsameSteuerungSetzen,
  type UemsGemeinsameSteuerungZustand,
  type UemsSteuerRichtung,
  type UemsVerlustSumme,
} from './api';
import { flaechenSatz, KUNDENWORT, satz, ZUSTAENDE } from './uemsGemeinsameSteuerung';
import { teile, VORGABE_ZEITZONE } from './uemsZustand';

// ───────────────────────────────────────────────────────────── Sichtbarkeit

/**
 * Steuert die Anlage? Dieselbe Regel wie „Steuern & Optimieren“ am Standort (`uebersicht.steuernSpricht`): eine
 * Teilnahme im Entwurf, eingerichtet, angehalten oder aktiv spricht; `kein_objekt` und `archiviert` schweigen.
 * Unbekannt (Funktionen nicht geladen) ist nie „steuert“.
 */
export function anlageSteuert(funktionen: Funktionen | null, siteId: string): boolean {
  if (!funktionen) return false;
  for (const st of funktionen.standorte) {
    const a = st.steuern.anlagen.find((x) => x.id === siteId);
    if (a) return a.teilnahme.zustand !== 'kein_objekt' && a.teilnahme.zustand !== 'archiviert';
  }
  return false;
}

/**
 * Die Karte erscheint nur, wenn die Anlage steuert UND mehr als eine Box hat (§5.2). Eine schon eingerichtete
 * Gemeinsame Steuerung bleibt erreichbar, auch wenn gerade nur eine Box übrig ist — sonst gäbe es keinen Weg zum
 * Anhalten.
 */
export function karteSichtbar(e: { steuert: boolean; boxen: number; eingerichtet: boolean }): boolean {
  return e.steuert && (e.boxen > 1 || e.eingerichtet);
}

// ───────────────────────────────────────────────────────────── Zahlen und Namen

/** kW mit höchstens einer Stelle, deutsche Schreibweise (AP-08 E11). */
export function kw(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

/** Der Box-Name ohne das Wort „Box“ — die Sätze setzen es selbst davor. */
export function boxName(name: string | null | undefined, ersatz: string): string {
  const n = (name ?? '').trim();
  if (!n) return ersatz;
  return n.replace(/^Box\s+/u, '');
}

export type BoxNamen = ReadonlyMap<string, string>;

/** Box-Namen aus der Geräteliste und — wo vorhanden — aus `GET …/einrichten` (dessen Namen gewinnen). */
export function boxNamen(devices: readonly Device[], einrichten: UemsGemeinsameSteuerungEinrichten | null): BoxNamen {
  const m = new Map<string, string>();
  for (const d of devices) m.set(d.id, boxName(d.name, d.externalRef));
  for (const b of einrichten?.boxen ?? []) m.set(b.box_id, boxName(b.name, m.get(b.box_id) ?? b.box_id));
  return m;
}

const nameVon = (namen: BoxNamen, id: string | null | undefined) => (id && namen.get(id)) || 'ohne Namen';

// ───────────────────────────────────────────────────────────── Zustand

export type KartenLage = 'nicht_eingerichtet' | 'eingerichtet' | 'wird_geprueft' | 'aktiv' | 'angehalten';

/** Die vier Zustände der Kundensprache (S1) aus dem Vertragszustand; `aufgeloest` beginnt wieder von vorn. */
export function lage(z: UemsGemeinsameSteuerungZustand | null): KartenLage {
  switch (z?.zustand) {
    case 'erklaert':
      return 'eingerichtet';
    case 'beobachtet':
    case 'geprueft':
      return 'wird_geprueft';
    case 'anteile_aktiv':
      return 'aktiv';
    case 'angehalten':
      return 'angehalten';
    default:
      return 'nicht_eingerichtet';
  }
}

/** Die Anteile je Box und Richtung aus der Auslegung (Frage 6). */
export function anteilVon(
  ergebnis: UemsGemeinsameSteuerungEinrichten['ergebnis'],
  richtung: UemsSteuerRichtung,
  boxId: string,
): number | null {
  return ergebnis?.[richtung]?.anteile.find((a) => a.box_id === boxId)?.kw ?? null;
}

const fuehrendeBox = (z: UemsGemeinsameSteuerungZustand | null) => z?.mitglieder?.find((m) => m.rolle === 'fuehrt')?.box_id ?? null;

/**
 * Die Zustandszeile: in `aktiv` der Satz aus §5.8 mit Boxen und Grenzen, in `angehalten` der Anhalte-Satz, sonst
 * Kundenwort + Zustand. `null` ohne Gemeinsame Steuerung.
 */
export function zustandsZeile(
  z: UemsGemeinsameSteuerungZustand | null,
  einrichten: UemsGemeinsameSteuerungEinrichten | null,
  namen: BoxNamen,
): string | null {
  const l = lage(z);
  if (l === 'nicht_eingerichtet') return null;
  if (l === 'eingerichtet') return `${KUNDENWORT} ${ZUSTAENDE.eingerichtet}`;
  if (l === 'wird_geprueft') return satz('pruefung_laeuft');
  if (l === 'angehalten') return satz('angehalten', { box: nameVon(namen, fuehrendeBox(z)) });
  const g = einrichten?.grenzen;
  if (g?.einspeisung_kw == null || g.bezug_kw == null) return `${KUNDENWORT} ${ZUSTAENDE.aktiv}`;
  return satz('karte_aktiv', {
    boxen: String(z?.mitglieder?.length ?? 0),
    einspeisung_kw: kw(g.einspeisung_kw),
    bezug_kw: kw(g.bezug_kw),
  });
}

export interface BoxZeile {
  boxId: string;
  text: string;
  verlust: string | null;
  ausfall: string | null;
}

/** Die Box-Zeilen: führend zuerst, dann mitsteuernd mit Anteil (aktiv/angehalten) oder vorgesehenem Anteil. */
export function boxZeilen(
  z: UemsGemeinsameSteuerungZustand | null,
  einrichten: UemsGemeinsameSteuerungEinrichten | null,
  namen: BoxNamen,
  ausfall: ReadonlyMap<string, string>,
  variante: VerlustVariante,
): BoxZeile[] {
  const l = lage(z);
  if (l === 'nicht_eingerichtet') return [];
  const inKraft = l === 'aktiv' || l === 'angehalten';
  const mitglieder = [...(z?.mitglieder ?? [])].sort((a, b) => (a.rolle === b.rolle ? 0 : a.rolle === 'fuehrt' ? -1 : 1));
  return mitglieder.map((m) => {
    const box = nameVon(namen, m.box_id);
    let text: string;
    if (m.rolle === 'fuehrt') {
      text = satz('box_fuehrend', { box });
    } else {
      const ein = anteilVon(einrichten?.ergebnis ?? null, 'einspeisung', m.box_id);
      const bez = anteilVon(einrichten?.ergebnis ?? null, 'bezug', m.box_id);
      if (ein == null || bez == null) text = flaechenSatz(inKraft ? 'box_mitsteuernd_kurz' : 'box_mitsteuernd_geplant_kurz', { box });
      else {
        const werte = { box, einspeisung_kw: kw(ein), bezug_kw: kw(bez) };
        text = inKraft ? satz('box_mitsteuernd', werte) : flaechenSatz('box_mitsteuernd_geplant', werte);
      }
    }
    return {
      boxId: m.box_id,
      text,
      verlust: m.rolle === 'steuert_mit' && inKraft ? verlustZeile(m.anteil_verlust?.heute ?? null, variante) : null,
      ausfall: ausfall.get(m.box_id) ?? null,
    };
  });
}

// ───────────────────────────────────────────────────────────── Ausfall-Sätze

/**
 * Die Ausfall-Sätze der Matrix (A1, A2, A4) — nur, solange Anteile in Kraft sind (aktiv, angehalten): vorher hält
 * keine Box einen Anteil, und S2 verlangt, dass ein Satz nur dort steht, wo die Matrix ihn trägt.
 *
 * ⚠ `GET …/gemeinsame-steuerung` nennt keine Erreichbarkeit je Mitglied. Die Karte nimmt den Herzschlag der Box aus
 * der Geräteliste (`deviceLiveStatus`, dieselbe Quelle wie das Abzeichen „online“): `stale` heißt „antwortet seit
 * {letzter Herzschlag} nicht“. Eine Box ohne Eintrag oder ohne je einen Herzschlag ist unbekannt — kein Satz.
 */
export function ausfallSaetze(
  z: UemsGemeinsameSteuerungZustand | null,
  devices: readonly Device[],
  namen: BoxNamen,
  jetzt: Date,
  zone: string = VORGABE_ZEITZONE,
): Map<string, string> {
  const out = new Map<string, string>();
  const l = lage(z);
  if (l !== 'aktiv' && l !== 'angehalten') return out;
  const mitglieder = z?.mitglieder ?? [];
  const stumm = mitglieder.filter((m) => {
    const d = devices.find((x) => x.id === m.box_id);
    return d != null && deviceLiveStatus(d, jetzt) === 'stale';
  });
  if (mitglieder.length === 2 && stumm.length === 2) {
    for (const m of mitglieder) out.set(m.box_id, satz('beide_nicht_verbunden'));
    return out;
  }
  for (const m of stumm) {
    const box = nameVon(namen, m.box_id);
    if (m.rolle === 'fuehrt') {
      out.set(m.box_id, satz('fuehrende_box_stumm', { box }));
    } else {
      const d = devices.find((x) => x.id === m.box_id)!;
      out.set(m.box_id, satz('box_stumm', { box, uhrzeit: seitText(d.lastSeenAt!, jetzt, zone) }));
    }
  }
  return out;
}

/** „13:10“ am selben Tag der Anlage, sonst „20.10.2026 13:10“. */
function seitText(iso: string, jetzt: Date, zone: string): string {
  const s = teile(iso, zone);
  const j = teile(jetzt.toISOString(), zone);
  return s.tag === j.tag ? `${s.stunde}:${s.minute}` : `${s.tag} ${s.stunde}:${s.minute}`;
}

// ───────────────────────────────────────────────────────────── Befunde

export interface BefundSatz {
  text: string;
  /** Ein Weg zur Stelle, an der es sich beheben lässt. */
  weg: 'netzanschluss' | 'datenquelle' | 'aendern' | null;
}

/**
 * Was fehlt — als Sätze für den Kunden. `nachweis_fehlt` (die Sprungprobe) ist Sache von VoltPilot und steht im
 * Satz „wird geprüft“; `fuehrende_box_misst_nicht` heißt in einer scharfen Anlage A7 („sieht den Netzzähler nicht“),
 * davor die Frage 2 aus §5.2.
 */
export function befundSaetze(z: UemsGemeinsameSteuerungZustand | null, namen: BoxNamen): BefundSatz[] {
  const inKraft = lage(z) === 'aktiv' || lage(z) === 'angehalten';
  const out: BefundSatz[] = [];
  const gesehen = new Set<string>();
  const dazu = (b: BefundSatz) => {
    if (gesehen.has(b.text)) return;
    gesehen.add(b.text);
    out.push(b);
  };
  for (const f of z?.fehlt ?? []) dazu(befund(f, namen, inKraft));
  return out.filter((b) => b.text !== '');
}

function befund(f: UemsGemeinsameSteuerungBefund, namen: BoxNamen, inKraft: boolean): BefundSatz {
  const box = nameVon(namen, f.box_id);
  switch (f.wort) {
    case 'kein_netzanschluss':
      return { text: flaechenSatz('netzanschluss_fehlt'), weg: 'netzanschluss' };
    case 'grenze_fehlt':
      return { text: flaechenSatz('grenze_fehlt'), weg: 'netzanschluss' };
    case 'fuehrende_box_misst_nicht':
      return inKraft
        ? { text: satz('zaehler_fehlt', { box }), weg: null }
        : { text: flaechenSatz('netzzaehler_fehlt'), weg: 'datenquelle' };
    case 'mitsteuernde_box_misst_nicht':
      return { text: flaechenSatz('abgangszaehler_fehlt', { box }), weg: 'aendern' };
    case 'faehigkeit_fehlt':
      return { text: satz('update_noetig', { box }), weg: null };
    case 'box_nicht_in_anlage':
      return { text: satz('fremde_anlage'), weg: 'aendern' };
    case 'vorgabe_signal_nicht_an_jeder_box':
      return { text: flaechenSatz('signal_ladepunkte'), weg: 'aendern' };
    case 'auslegung_passt_nicht':
      return { text: flaechenSatz('auslegung_passt_nicht'), weg: 'aendern' };
    case 'nachweis_fehlt':
    default:
      return { text: '', weg: null };
  }
}

// ───────────────────────────────────────────────────────────── Verlust-Zeile

/**
 * Zwei Varianten der Verlust-Zeile (R2, IP-22: `kwh` ist eine UNTERGRENZE, `gebunden_s` exakt):
 * - **A** kWh, wenn es mindestens 1 kWh sind — dann als „mindestens“; sonst die gebundene Zeit.
 * - **B** immer die gebundene Zeit; kWh nur als Zusatz „mindestens …“, wenn es mindestens 1 kWh sind.
 * Ohne gebundene Zeit und ohne kWh: keine Zeile. kWh wird abgerundet, damit die Untergrenze eine bleibt.
 */
export type VerlustVariante = 'A' | 'B';

/** Die empfohlene Variante (Begründung in der Ansicht und im PR). */
export const VERLUST_VARIANTE: VerlustVariante = 'B';

export function verlustZeile(v: UemsVerlustSumme | null, variante: VerlustVariante): string | null {
  if (!v) return null;
  const kwh = Math.floor(v.kwh);
  const s = Math.max(0, v.gebunden_s);
  if (s <= 0 && kwh < 1) return null;
  if (variante === 'A') {
    if (kwh >= 1) return flaechenSatz('verlust_mindestens', { kwh: kwh.toLocaleString('de-DE') });
    return flaechenSatz('verlust_zeit', { dauer: dauerText(s) });
  }
  if (kwh >= 1) return flaechenSatz('verlust_zeit_mindestens', { dauer: dauerText(s), kwh: kwh.toLocaleString('de-DE') });
  return flaechenSatz('verlust_zeit', { dauer: dauerText(s) });
}

/** „40 Minuten“ · „1 Stunde“ · „9,1 Stunden“. */
export function dauerText(sekunden: number): string {
  if (sekunden < 3600) {
    const min = Math.max(1, Math.round(sekunden / 60));
    return min === 1 ? '1 Minute' : `${min} Minuten`;
  }
  const h = Math.round((sekunden / 3600) * 10) / 10;
  return h === 1 ? '1 Stunde' : `${h.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Stunden`;
}

// ───────────────────────────────────────────────────────────── Einrichten in sechs Fragen

export interface GeraetEntwurf {
  komponenteId: string;
  name: string;
  typ: string;
  richtung: UemsSteuerRichtung;
  /** Die Nennleistung als Eingabetext (deutsche Schreibweise); leer = fehlt. */
  nenn: string;
}

export interface BoxEntwurf {
  boxId: string;
  name: string;
  mit: boolean;
  /** Messpunkt = Datenquelle dieser Anlage; `null` = kein eigener Zähler. */
  messpunkt: string | null;
  signal: UemsDreiwert;
  geraete: GeraetEntwurf[];
}

export interface Entwurf {
  fuehrt: string | null;
  boxen: BoxEntwurf[];
  erzeugerArt: 'keine' | 'liste' | null;
  erzeuger: { bezeichnung: string; nenn: string }[];
  /** Vorbehalt der Bezugsseite als Eingabetext; leer = nicht erklärt. */
  vorbehaltBezug: string;
}

const zahlText = (n: number | null | undefined) => (n == null ? '' : kw(n));

/**
 * Der vorbelegte Entwurf aus dem Vorschlag: Frage 1 jede Box, hinter der ein steuerbares Gerät antwortet (oder das
 * bisherige Mitglied); Frage 2 die Box am Netzzähler; Frage 5 JEDE Komponente mit Schreibfreigabe je Richtung,
 * Nennleistung aus dem Bestand oder der bisherigen Erklärung; Signal und Messpunkt wie bisher.
 */
export function entwurfAus(
  e: UemsGemeinsameSteuerungEinrichten,
  z: UemsGemeinsameSteuerungZustand | null,
): Entwurf {
  const mitglied = (id: string) => z?.mitglieder?.find((m) => m.box_id === id) ?? null;
  const eingerichtet = e.eingerichtet && (z?.mitglieder?.length ?? 0) > 0;
  const fuehrt = e.boxen.find((b) => b.rolle === 'fuehrt')?.box_id ?? e.netzzaehler_box_id ?? null;
  const boxen = e.boxen.map((b): BoxEntwurf => {
    const erklaert = new Map((b.geraete ?? []).map((g) => [`${g.komponente_id}|${g.richtung}`, g.nenn_kw]));
    const geraete: GeraetEntwurf[] = [];
    for (const k of b.komponenten) {
      if (!k.schreibfreigabe) continue;
      for (const r of k.richtungen) {
        geraete.push({
          komponenteId: k.komponente_id,
          name: k.name ?? k.typ,
          typ: k.typ,
          richtung: r,
          nenn: zahlText(erklaert.get(`${k.komponente_id}|${r}`) ?? k.nenn_kw),
        });
      }
    }
    const steuerbar = b.komponenten.some((k) => k.schreibfreigabe);
    return {
      boxId: b.box_id,
      name: boxName(b.name, b.box_id),
      mit: eingerichtet ? b.rolle != null : steuerbar || b.box_id === fuehrt,
      messpunkt: b.messpunkt_id ?? null,
      signal: mitglied(b.box_id)?.vorgabe_signal ?? 'unbekannt',
      geraete,
    };
  });
  const u = e.ungesteuerte_erzeuger;
  return {
    fuehrt,
    boxen,
    erzeugerArt: u === 'keine' ? 'keine' : Array.isArray(u) ? 'liste' : null,
    erzeuger: Array.isArray(u) ? u.map((x) => ({ bezeichnung: x.bezeichnung, nenn: kw(x.nenn_kw) })) : [],
    vorbehaltBezug: zahlText(e.vorbehalt?.bezug_kw ?? e.vorbehalt?.aus_messwerten?.kw ?? null),
  };
}

/** Eine deutsche Zahleneingabe > 0 („77“, „24,6“); sonst `null`. */
export function positiveZahl(text: string): number | null {
  const t = text.trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** Eine Lücke im Entwurf an ihrer Stelle: Frage, Box, Komponente/Richtung oder Erzeuger-Zeile. */
export interface EntwurfLuecke {
  frage: 1 | 2 | 4 | 5;
  boxId?: string;
  komponenteId?: string;
  richtung?: UemsSteuerRichtung;
  erzeuger?: number;
  text: string;
}

/** Was vor dem Absenden fehlt — dieselben Pflichten, die der Server mit 400/422 ablehnen würde. */
export function entwurfLuecken(e: Entwurf): EntwurfLuecke[] {
  const out: EntwurfLuecke[] = [];
  const mit = e.boxen.filter((b) => b.mit);
  if (mit.length < 2) out.push({ frage: 1, text: 'Bitte mindestens zwei Boxen wählen.' });
  const fuehrt = mit.find((b) => b.boxId === e.fuehrt);
  if (!fuehrt) out.push({ frage: 2, text: 'Bitte die Box wählen, die am Netzanschluss misst.' });
  else if (!fuehrt.messpunkt) out.push({ frage: 2, boxId: fuehrt.boxId, text: 'Bitte die Datenquelle des Netzzählers wählen.' });
  if (e.erzeugerArt == null) out.push({ frage: 4, text: 'Bitte „Keine“ wählen oder die Erzeuger eintragen.' });
  if (e.erzeugerArt === 'liste') {
    if (e.erzeuger.length === 0) out.push({ frage: 4, text: 'Bitte mindestens einen Erzeuger eintragen.' });
    e.erzeuger.forEach((x, i) => {
      if (!x.bezeichnung.trim() || positiveZahl(x.nenn) == null) {
        out.push({ frage: 4, erzeuger: i, text: 'Bitte Bezeichnung und Nennleistung in kW angeben.' });
      }
    });
  }
  if (e.vorbehaltBezug.trim() !== '' && positiveZahlOderNull(e.vorbehaltBezug) == null) {
    out.push({ frage: 4, text: 'Bitte den Wert in kW angeben, z. B. 473.' });
  }
  for (const b of mit) {
    for (const g of b.geraete) {
      if (positiveZahl(g.nenn) == null) {
        out.push({ frage: 5, boxId: b.boxId, komponenteId: g.komponenteId, richtung: g.richtung, text: 'Bitte die Nennleistung in kW angeben.' });
      }
    }
  }
  return out;
}

function positiveZahlOderNull(text: string): number | null {
  return text.trim() === '0' ? 0 : positiveZahl(text);
}

/** Der Körper für `PUT …/gemeinsame-steuerung` — erst, wenn {@link entwurfLuecken} leer ist. */
export function koerper(e: Entwurf): UemsGemeinsameSteuerungSetzen {
  const vorbehalt = e.vorbehaltBezug.trim() === '' ? null : positiveZahlOderNull(e.vorbehaltBezug);
  return {
    mitglieder: e.boxen
      .filter((b) => b.mit)
      .map((b) => ({
        box_id: b.boxId,
        rolle: b.boxId === e.fuehrt ? 'fuehrt' as const : 'steuert_mit' as const,
        messpunkt_id: b.messpunkt,
        vorgabe_signal: b.signal,
        geraete: b.geraete.map((g) => ({ komponente_id: g.komponenteId, richtung: g.richtung, nenn_kw: positiveZahl(g.nenn)! })),
      })),
    ungesteuerte_erzeuger: e.erzeugerArt === 'liste'
      ? e.erzeuger.map((x) => ({ bezeichnung: x.bezeichnung.trim(), nenn_kw: positiveZahl(x.nenn)! }))
      : 'keine',
    ...(vorbehalt == null ? {} : { vorbehalt: { bezug_kw: vorbehalt } }),
  };
}

/** Die Lücken einer 422 `erklaerung_unvollstaendig`, übersetzt an IHRE Stelle in der Folge. */
export function lueckenAusAntwort(body: unknown): EntwurfLuecke[] {
  const b = body as { code?: string; fehlt?: UemsErklaerungLuecke[] } | undefined;
  if (b?.code !== 'erklaerung_unvollstaendig' || !Array.isArray(b.fehlt)) return [];
  return b.fehlt.map((l): EntwurfLuecke => {
    if (l.wort === 'ungesteuerte_erzeuger') return { frage: 4, text: 'Bitte „Keine“ wählen oder die Erzeuger eintragen.' };
    if (l.wort === 'komponente') {
      return { frage: 5, boxId: l.box_id ?? undefined, komponenteId: l.komponente_id ?? undefined,
        text: 'Dieses Gerät fehlt noch in der Liste dieser Box. Bitte die Seite neu laden und die Nennleistung angeben.' };
    }
    return { frage: 5, boxId: l.box_id ?? undefined, text: 'Für diese Box fehlen noch ihre Geräte.' };
  });
}

// ───────────────────────────────────────────────────────────── Frage 6: Ergebnis

/** „Passt die Anlage zur Grenze?“ — je Richtung. */
export function urteilSatz(a: UemsGemeinsameSteuerungAuslegung | null | undefined): string {
  if (!a) return flaechenSatz('urteil_offen');
  if (a.urteil === 'passt') return flaechenSatz('urteil_passt');
  if (a.urteil === 'vorbehalt_ueber_grenze') return flaechenSatz('urteil_vorbehalt_ueber_grenze');
  return flaechenSatz('urteil_passt_nicht', { summe_kw: kw(a.summe_rueckfall_kw), verteilbar_kw: kw(a.verteilbar_kw) });
}

export interface ErgebnisHinweis {
  text: string;
  /** Rückfall am Gerät hinterlegen: die Komponente und ihre Richtung. */
  rueckfall?: { komponenteId: string; richtung: UemsSteuerRichtung };
}

const istLadepunkt = (typ: string) => /charg|lade|wallbox/iu.test(typ);

/**
 * Was fehlt — die vier Sätze aus §5.2 Nr. 6, in dieser Reihenfolge: Update nötig (`faehigkeit_fehlt`), kein
 * sicherer Rückfallwert (erklärtes Gerät, das ohne Box frei läuft oder keinen Wert kennt), der Ladepark an einer
 * mitsteuernden Box (G7, mit ihrem Bezugs-Anteil) und das Signal des Netzbetreibers (G6).
 */
export function ergebnisHinweise(
  e: UemsGemeinsameSteuerungEinrichten,
  z: UemsGemeinsameSteuerungZustand | null,
  namen: BoxNamen,
): ErgebnisHinweis[] {
  const out: ErgebnisHinweis[] = [];
  for (const f of z?.fehlt ?? []) {
    if (f.wort === 'faehigkeit_fehlt') out.push({ text: satz('update_noetig', { box: nameVon(namen, f.box_id) }) });
  }
  const namenDerKomponenten = new Map(e.boxen.flatMap((b) => b.komponenten.map((k) => [k.komponente_id, k.name ?? k.typ] as const)));
  for (const b of e.boxen) {
    for (const g of b.geraete ?? []) {
      const ohne = g.rueckfall_herkunft === 'ohne_angabe' || g.rueckfall == null || g.rueckfall === 'laeuft_frei' || g.rueckfall === 'unbekannt';
      if (ohne) {
        out.push({
          text: flaechenSatz('rueckfall_fehlt', { geraet: namenDerKomponenten.get(g.komponente_id) ?? 'ohne Namen' }),
          rueckfall: { komponenteId: g.komponente_id, richtung: g.richtung },
        });
      }
    }
  }
  const fuehrt = e.boxen.find((b) => b.rolle === 'fuehrt');
  for (const b of e.boxen.filter((x) => x.rolle === 'steuert_mit')) {
    const typen = new Map(b.komponenten.map((k) => [k.komponente_id, k.typ]));
    const ladepark = (b.geraete ?? []).some((g) => g.richtung === 'bezug' && istLadepunkt(typen.get(g.komponente_id) ?? ''));
    const anteil = anteilVon(e.ergebnis ?? null, 'bezug', b.box_id);
    if (ladepark && anteil != null && fuehrt) {
      out.push({ text: satz('hinweis_einrichten', { kw: kw(anteil), box: nameVon(namen, fuehrt.box_id) }) });
    }
  }
  if ((z?.fehlt ?? []).some((f) => f.wort === 'vorgabe_signal_nicht_an_jeder_box')) {
    out.push({ text: flaechenSatz('signal_ladepunkte') });
  }
  return out;
}
