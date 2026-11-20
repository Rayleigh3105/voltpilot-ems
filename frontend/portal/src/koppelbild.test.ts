import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

/**
 * VoltPilot-Koppelbild v1 (KB-1): `docs/contracts/v2/koppelbild.md`, sein Schema und die Vektor-Datei.
 *
 * Hier rechnen ein unabhängiger Schreiber, ein unabhängiger Baustein, ein unabhängiger Leser und eine unabhängige
 * Lage der Edge jeden Fall Schritt für Schritt nach - nur mit den Konstanten der Datei und den Regeln des Vertrags.
 * Die Vektor-Datei kommt aus einem Referenzmodell außerhalb des Repos; stimmen beide überein, gehen die Regeln auf.
 * Dazu: der Aufbau ist lückenlos, Vertrag und Datei nennen dieselben Adressen, Typen, Bits, Codes und
 * Reihenfolgen, das Siegel ist CRC-16/MODBUS, und die Rechenbeispiele des Vertrags rechnen richtig.
 */
const ROOT = resolve(process.cwd(), '../..');
const V2 = resolve(ROOT, 'docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const schema: Json = lies(resolve(V2, 'koppelbild.schema.json'));
const vektoren: Json = lies(resolve(V2, 'koppelbild-vectors.json'));
const vertrag = readFileSync(resolve(V2, 'koppelbild.md'), 'utf8');

const LAEUFER_SCHLUESSEL = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'anyOf',
  'enum', 'const', 'pattern', 'minItems', 'minLength', 'maxLength', 'minimum', 'maximum',
]);

const fremdeSchluessel = (s: Json, pfad: string): string[] => {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return [];
  return Object.entries(s).flatMap(([k, v]: [string, Json]) => {
    const hier = LAEUFER_SCHLUESSEL.has(k) ? [] : [`${pfad}.${k}`];
    if (k === 'properties' || k === '$defs') {
      return [...hier, ...Object.entries(v).flatMap(([n, t]) => fremdeSchluessel(t, `${pfad}.${k}.${n}`))];
    }
    if (k === 'items' || k === 'additionalProperties') return [...hier, ...fremdeSchluessel(v, `${pfad}.${k}`)];
    if (k === 'anyOf') return [...hier, ...(v as Json[]).flatMap((t, i) => fremdeSchluessel(t, `${pfad}.anyOf[${i}]`))];
    return hier;
  });
};

// ---- Konstanten nur aus der Datei ----
const W = vektoren.w;
const Q = vektoren.q;
const PLAETZE: number = vektoren.koppelbild.plaetze;
const feldIn = (liste: Json[], name: string): Json => liste.find((f: Json) => f.feld === name);
const wk = (name: string): Json => feldIn(W.kopf, name);
const wp = (name: string): Json => feldIn(W.platz.felder, name);
const qk = (name: string): Json => feldIn(Q.kopf, name);
const qp = (name: string): Json => feldIn(Q.platz.felder, name);
const SIG_W: number[] = wk('signatur').soll_woerter;
const SIG_Q: number[] = qk('signatur').soll_woerter;
const PRUEF: number[] = wk('wortfolge').soll_woerter;
const VERSION: number = wk('version').soll.wort;
const HAUPT: number = wk('version').soll.hauptversion;
const S32_MAX = 0x7fffffff;
const U32_MAX = 0xffffffff;
const code = (vok: string): Record<string, number> => Object.fromEntries(vektoren.vokabular[vok].map((v: Json) => [v.name, v.code]));
const name = (vok: string): Record<number, string> => Object.fromEntries(vektoren.vokabular[vok].map((v: Json) => [v.code, v.name]));
const ART = code('art');
const ZIEL = code('ziel');
const GRUND = code('grund');
const KU = code('kopf_urteil');
const QU = code('q_urteil');
const bitNr = (feld: string, n: string): number => vektoren.bitfelder[feld].bits.find((b: Json) => b.name === n).bit;
const bitsAus = (feld: string, namen: string[]): number => namen.reduce((s, n) => s | (1 << bitNr(feld, n)), 0);
const bitNamen = (feld: string, wort: number): string[] =>
  vektoren.bitfelder[feld].bits.filter((b: Json) => (wort >> b.bit) & 1).map((b: Json) => b.name);
const FRIST = vektoren.sps.frist_s;
const EDGE_LEBT_MS: number = vektoren.sps.edge_lebt_ms;
const EDGE = vektoren.edge;

// ---- Rechnen ----
function crc16(woerter: number[]): number {
  let c = 0xffff;
  for (const w of woerter) {
    for (const b of [w >> 8, w & 0xff]) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ vektoren.siegel.polynom_gespiegelt : c >>> 1;
    }
  }
  return c;
}
const ohneWort = (w: number[], i: number): number[] => [...w.slice(0, i), ...w.slice(i + 1)];
const siegelW = (w: number[]) => crc16(ohneWort(w, W.siegel_wort - W.basis));
const siegelQ = (q: number[]) => crc16(ohneWort(q, Q.siegel_wort - Q.basis));
const zwei = (v: number): number[] => {
  const u = v < 0 ? v + 2 ** 32 : v;
  return [Math.floor(u / 65536), u % 65536];
};
const roh32 = (w: number[], a: number): number => w[a] * 65536 + w[a + 1];
const s32 = (u: number): number => (u >= 2 ** 31 ? u - 2 ** 32 : u);
const wPlatz = (n: number, f: string) => W.platz.basis + (n - 1) * W.platz.laenge + wp(f).adresse;
const qPlatz = (n: number, f: string) => Q.platz.basis - Q.basis + (n - 1) * Q.platz.laenge + qp(f).adresse;
const qKopf = (f: string) => qk(f).adresse - Q.basis;

// ---- der unabhängige Schreiber ----
function schreibe(a: Json): number[] {
  const w = new Array(W.woerter).fill(0);
  w.splice(wk('signatur').adresse, 2, ...SIG_W);
  w.splice(wk('wortfolge').adresse, 2, ...PRUEF);
  w[wk('version').adresse] = VERSION;
  w[wk('platz_anzahl').adresse] = wk('platz_anzahl').soll;
  w[wk('sitzung').adresse] = a.sitzung;
  w[wk('herzschlag').adresse] = a.herzschlag;
  w.splice(wk('steuerung_id').adresse, 2, ...zwei(a.steuerung_id));
  w[wk('frist_s').adresse] = a.frist_s;
  w[wk('e_bits').adresse] = bitsAus('e_bits', a.e_bits);
  for (let n = 1; n <= PLAETZE; n++) {
    const p = a.plaetze[String(n)];
    const mit = p && p.art !== 'keiner';
    w[wPlatz(n, 'w_art')] = mit ? ART[p.art] : 0;
    w[wPlatz(n, 'w_grund')] = mit ? GRUND[p.grund] : 0;
    w.splice(wPlatz(n, 'w_wert'), 2, ...zwei(mit ? p.wert : S32_MAX));
    w[wPlatz(n, 'w_folge')] = p ? p.folge : 0;
  }
  w[W.siegel_wort] = siegelW(w);
  return w;
}

// ---- der unabhängige Baustein ----
type Sps = {
  herzschlag: number; tSekunde: number | null; angenommen: number; abgelehnt: number; kopfUrteil: string;
  letzte: number[] | null; t: number[] | null; fristEnde: number | null; ohneFrist: string; tAnnahme: number | null;
  qSitzung: number; qHerzschlag: number; erster: boolean;
};
const neueSps = (a: Json): Sps => ({
  herzschlag: a.herzschlag, tSekunde: null, angenommen: a.angenommen_zaehler, abgelehnt: a.abgelehnt_zaehler,
  kopfUrteil: 'keins', letzte: null, t: null, fristEnde: null, ohneFrist: 'keins', tAnnahme: null, qSitzung: 0,
  qHerzschlag: 0, erster: true,
});

function kopfPruefen(w: number[], id: number): string | null {
  const reihe: [string, boolean][] = [
    ['signatur_fremd', w[0] !== SIG_W[0] || w[1] !== SIG_W[1]],
    ['version_fremd', w[wk('version').adresse] >> 8 !== HAUPT],
    ['wortfolge_falsch', w[2] !== PRUEF[0] || w[3] !== PRUEF[1]],
    ['siegel_falsch', siegelW(w) !== w[W.siegel_wort]],
    ['steuerung_fremd', roh32(w, wk('steuerung_id').adresse) !== id],
    ['kopf_ungueltig', w[wk('frist_s').adresse] < FRIST.min || w[wk('frist_s').adresse] > FRIST.max
      || w[wk('sitzung').adresse] === 0 || w[wk('sitzung').adresse] === 0xffff
      || w[wk('platz_anzahl').adresse] !== wk('platz_anzahl').soll],
  ];
  const treffer = reihe.find(([, ja]) => ja);
  return treffer ? treffer[0] : null;
}

function zyklus(s: Sps, t: number, halte: number[], e: Json): { q: number[]; aus: Json } {
  if (s.tSekunde === null) s.tSekunde = t;
  while (t - s.tSekunde >= 1000) {
    s.herzschlag = (s.herzschlag + 1) % 65536;
    s.tSekunde += 1000;
  }
  const frei: boolean = e.fernsteuerung_frei;
  if (s.erster) {
    s.erster = false;
    s.letzte = [...halte];
  } else if (halte.some((x, i) => x !== s.letzte![i])) {
    s.letzte = [...halte];
    const grund = kopfPruefen(halte, e.steuerung_id);
    if (grund) {
      s.abgelehnt = (s.abgelehnt + 1) % 65536;
      s.kopfUrteil = grund;
    } else {
      s.t = [...halte];
      s.qSitzung = halte[wk('sitzung').adresse];
      s.qHerzschlag = halte[wk('herzschlag').adresse];
      s.angenommen = (s.angenommen + 1) % 65536;
      s.tAnnahme = t;
      if (frei) {
        s.fristEnde = t + Math.min(halte[wk('frist_s').adresse], e.hoechste_frist_s) * 1000;
        s.kopfUrteil = 'angenommen';
      } else {
        [s.fristEnde, s.ohneFrist, s.kopfUrteil] = [null, 'gesperrt', 'gesperrt'];
      }
    }
  }
  if (!frei && s.fristEnde !== null) [s.fristEnde, s.ohneFrist, s.kopfUrteil] = [null, 'gesperrt', 'gesperrt'];
  if (s.fristEnde !== null && t >= s.fristEnde) [s.fristEnde, s.ohneFrist, s.kopfUrteil] = [null, 'abgelaufen', 'abgelaufen'];
  const rest = s.fristEnde === null ? 0 : Math.ceil((s.fristEnde - t) / 1000);
  const edgeLebt = s.tAnnahme !== null && t - s.tAnnahme < EDGE_LEBT_MS;
  const q = new Array(Q.woerter).fill(0);
  q.splice(qKopf('signatur'), 2, ...SIG_Q);
  q.splice(qKopf('wortfolge'), 2, ...PRUEF);
  q[qKopf('version')] = VERSION;
  q[qKopf('herzschlag')] = s.herzschlag;
  q[qKopf('bibliothek')] = e.bibliothek;
  q.splice(qKopf('steuerung_id'), 2, ...zwei(e.steuerung_id));
  q[qKopf('kopf_urteil')] = KU[s.kopfUrteil];
  q[qKopf('q_sitzung')] = s.qSitzung;
  q[qKopf('q_herzschlag')] = s.qHerzschlag;
  q[qKopf('rest_s')] = rest;
  q[qKopf('q_bits')] = bitsAus('q_bits', [
    ...(frei ? ['fernsteuerung_frei'] : []), ...(edgeLebt ? ['edge_lebt'] : []), ...(e.hand_ort ? ['hand_ort'] : []),
  ]);
  q[qKopf('angenommen_zaehler')] = s.angenommen;
  q[qKopf('abgelehnt_zaehler')] = s.abgelehnt;
  let anzahl = 0;
  const wunsch: Json[] = [];
  for (let n = 1; n <= PLAETZE; n++) {
    const a = e.angebot[String(n)];
    const r = e.rueck[String(n)] ?? {};
    const leer = !a || a.art === 'keiner';
    if (!leer) anzahl++;
    const bereit = !leer && a.bereit && !e.hand_ort;
    const gruende = leer ? [] : [...a.gruende, ...(e.hand_ort ? ['grund_hand_ort'] : [])];
    let urteil = 'kein_wunsch';
    let gilt = false;
    let wert: number | null = null;
    let grund: Json = null;
    let folge = 0;
    if (s.t) {
      const art = s.t[wPlatz(n, 'w_art')];
      const ww = s32(roh32(s.t, wPlatz(n, 'w_wert')));
      folge = s.t[wPlatz(n, 'w_folge')];
      if (s.fristEnde === null) {
        if (art !== 0) urteil = s.ohneFrist === 'abgelaufen' ? 'abgelaufen' : s.ohneFrist === 'gesperrt' ? 'nicht_bereit' : 'kein_wunsch';
      } else if (art === 0) urteil = 'kein_wunsch';
      else if (leer || art !== ART[a.art]) urteil = 'art_fremd';
      else if (ww === S32_MAX) urteil = 'wert_ungueltig';
      else if (!bereit) urteil = 'nicht_bereit';
      else {
        wert = Math.min(Math.max(ww, a.min), a.max);
        urteil = r.ueberstimmt ? 'ueberstimmt' : wert !== ww ? 'begrenzt' : 'angenommen';
        gilt = true;
        const g = s.t[wPlatz(n, 'w_grund')];
        grund = name('grund')[g] ?? g;
      }
    }
    const b = qPlatz(n, 'a_art');
    q[b] = leer ? 0 : ART[a.art];
    q[qPlatz(n, 'a_ziel')] = leer ? 0 : ZIEL[a.ziel];
    q[qPlatz(n, 'a_nr')] = leer ? 0 : a.nr;
    q[qPlatz(n, 'a_bits')] = leer ? 0 : bitsAus('a_bits', [...(bereit ? ['bereit'] : []), ...new Set(gruende)]);
    q.splice(qPlatz(n, 'a_min'), 2, ...zwei(leer ? S32_MAX : a.min));
    q.splice(qPlatz(n, 'a_max'), 2, ...zwei(leer ? S32_MAX : a.max));
    q[qPlatz(n, 'q_urteil')] = QU[urteil];
    q[qPlatz(n, 'q_folge')] = folge;
    q.splice(qPlatz(n, 'q_wirksam'), 2, ...zwei(r.wirksam ?? S32_MAX));
    wunsch.push({ gilt, wert, grund, urteil });
  }
  q[qKopf('platz_anzahl')] = anzahl;
  q[Q.siegel_wort - Q.basis] = siegelQ(q);
  return { q, aus: { kopf_urteil: s.kopfUrteil, rest_s: rest, edge_lebt: edgeLebt, wunsch } };
}

// ---- der unabhängige Leser ----
function liesQuittung(q: number[], soll: number): Json {
  const nicht = (grund: string) => ({ ergebnis: 'nicht_lesbar', grund });
  if (q.length < Q.woerter) return nicht('zu_wenig_woerter');
  if (q[0] !== SIG_Q[0] || q[1] !== SIG_Q[1]) return nicht('signatur_fremd');
  if (q[qKopf('version')] >> 8 !== HAUPT) return nicht('version_fremd');
  if (q[2] !== PRUEF[0] || q[3] !== PRUEF[1]) return nicht('wortfolge_falsch');
  if (siegelQ(q) !== q[Q.siegel_wort - Q.basis]) return nicht('siegel_falsch');
  if (q[qKopf('platz_anzahl')] > PLAETZE) return nicht('platz_anzahl_ungueltig');
  const leer: Record<string, string> = {};
  const u16 = (f: string, vok?: string): Json => {
    const v = q[qKopf(f)];
    if (v === 0xffff) {
      leer[f] = 'ungueltig';
      return null;
    }
    if (vok && name(vok)[v] === undefined) {
      leer[f] = 'fremd';
      return null;
    }
    return vok ? name(vok)[v] : v;
  };
  const id = roh32(q, qKopf('steuerung_id'));
  const bib = u16('bibliothek');
  const kopf: Json = {
    version_haupt: q[qKopf('version')] >> 8, version_neben: q[qKopf('version')] & 0xff,
    platz_anzahl: q[qKopf('platz_anzahl')], herzschlag: q[qKopf('herzschlag')],
    steuerung_id: id === U32_MAX ? null : id, q_sitzung: q[qKopf('q_sitzung')], q_herzschlag: q[qKopf('q_herzschlag')],
    angenommen_zaehler: q[qKopf('angenommen_zaehler')], abgelehnt_zaehler: q[qKopf('abgelehnt_zaehler')],
    bibliothek: bib === null ? null : { haupt: bib >> 8, neben: bib & 0xff },
    kopf_urteil: u16('kopf_urteil', 'kopf_urteil'), rest_s: u16('rest_s'),
  };
  const qb = q[qKopf('q_bits')];
  if (qb === 0xffff) leer.q_bits = 'ungueltig';
  kopf.q_bits = qb === 0xffff ? null : bitNamen('q_bits', qb);
  const plaetze = Array.from({ length: PLAETZE }, (_, i) => {
    const n = i + 1;
    const pl: Record<string, string> = {};
    const p: Json = { n };
    const art = q[qPlatz(n, 'a_art')];
    if (art === 0xffff || name('art')[art] === undefined) {
      pl.a_art = art === 0xffff ? 'ungueltig' : 'fremd';
      p.angebot = null;
    } else if (art === 0) p.angebot = null;
    else {
      const z = q[qPlatz(n, 'a_ziel')];
      const [lo, hi] = [roh32(q, qPlatz(n, 'a_min')), roh32(q, qPlatz(n, 'a_max'))];
      const band = vektoren.art_band[name('art')[art]];
      if (z === 0xffff || name('ziel')[z] === undefined) {
        pl.a_ziel = z === 0xffff ? 'ungueltig' : 'fremd';
        p.angebot = null;
      } else if (lo === S32_MAX || hi === S32_MAX || !(band.min <= s32(lo) && s32(lo) <= s32(hi) && s32(hi) <= band.max)
        || q[qPlatz(n, 'a_nr')] === 0xffff || q[qPlatz(n, 'a_bits')] === 0xffff) {
        pl.angebot = 'angebot_ungueltig';
        p.angebot = null;
      } else {
        p.angebot = {
          art: name('art')[art], ziel: name('ziel')[z], nr: q[qPlatz(n, 'a_nr')], min: s32(lo), max: s32(hi),
          bits: bitNamen('a_bits', q[qPlatz(n, 'a_bits')]),
        };
      }
    }
    const u = q[qPlatz(n, 'q_urteil')];
    p.q_urteil = u === 0xffff ? null : (name('q_urteil')[u] ?? null);
    if (p.q_urteil === null) pl.q_urteil = u === 0xffff ? 'ungueltig' : 'fremd';
    p.q_folge = q[qPlatz(n, 'q_folge')];
    const wk2 = roh32(q, qPlatz(n, 'q_wirksam'));
    p.q_wirksam = wk2 === S32_MAX ? null : s32(wk2);
    if (wk2 === S32_MAX) pl.q_wirksam = 'ungueltig';
    p.leer = pl;
    return p;
  });
  return { ergebnis: 'lesbar', grund: kopf.steuerung_id !== soll ? 'steuerung_id_abweichend' : null, kopf, leer, plaetze };
}

// ---- die unabhängige Lage der Edge ----
type Lage = { vorige: Json; gleich: number; geschrieben: number; jeGeschrieben: boolean; sitzung: number | null;
  zweiter: boolean; ruhe: number };
const neueLage = (): Lage => ({ vorige: null, gleich: 0, geschrieben: 0, jeGeschrieben: false, sitzung: null, zweiter: false, ruhe: 0 });
const LAGE = Object.fromEntries(EDGE.lage.map((l: Json) => [l.name, l]));
const urteil = (lage: string) => ({ lage, schreibt: LAGE[lage].schreibt, wuenscht: LAGE[lage].wuenscht });

function lageNach(z: Lage, l: Json): Json {
  if (l === null) {
    [z.vorige, z.gleich, z.geschrieben] = [null, 0, 0];
    return urteil('keine_antwort');
  }
  if (l.ergebnis !== 'lesbar') return urteil('nicht_lesbar');
  const geschrieben = z.geschrieben;
  z.geschrieben = 0;
  const k = l.kopf;
  if (l.grund === 'steuerung_id_abweichend') {
    [z.vorige, z.gleich] = [k, 0];
    return urteil('steuerung_fremd');
  }
  let neustart = false;
  if (z.vorige) {
    const [alt, neu] = [z.vorige.herzschlag, k.herzschlag];
    if (neu === alt) z.gleich++;
    else {
      z.gleich = 1;
      if (neu < alt && neu + 65536 - alt > EDGE.schrittgrenze) neustart = true;
    }
  } else z.gleich = 1;
  const vorige = z.vorige;
  z.vorige = k;
  if (z.gleich >= EDGE.herzschlag_steht_ab_lesung) return urteil('sps_steht');
  if (z.zweiter) {
    const gewachsen = vorige && k.angenommen_zaehler !== vorige.angenommen_zaehler;
    z.ruhe = gewachsen ? 0 : z.ruhe + 1;
    if (z.ruhe < EDGE.ruhe_lesungen) return urteil('zweiter_schreiber');
    z.zweiter = false;
  }
  if (neustart || (k.kopf_urteil === 'keins' && z.jeGeschrieben && vorige && vorige.kopf_urteil !== 'keins')) {
    return urteil('sps_neustart');
  }
  if (geschrieben && vorige && ['angenommen', 'gesperrt'].includes(k.kopf_urteil)) {
    const mehr = (k.angenommen_zaehler - vorige.angenommen_zaehler + 65536) % 65536 > geschrieben;
    if (k.q_sitzung !== z.sitzung || mehr) {
      [z.zweiter, z.ruhe] = [true, 0];
      return urteil('zweiter_schreiber');
    }
  }
  if (k.kopf_urteil === 'gesperrt' || (k.q_bits && !k.q_bits.includes('fernsteuerung_frei'))) return urteil('gesperrt');
  return urteil('bereit');
}

/** Ein Fall Schritt für Schritt: Halteregister, Baustein, Leser, Lage - jede Abweichung mit Ort. */
function rechneFall(f: Json): string[] {
  const fehler: string[] = [];
  let sps = neueSps(f.sps_anfang);
  let lage = neueLage();
  let halte = new Array(W.woerter).fill(0);
  let eingang: Json = null;
  let letztesQ: number[] = [];
  f.schritte.forEach((s: Json, i: number) => {
    const wo = `${f.name} Schritt ${i + 1} (t=${s.t_ms})`;
    if (s.sps) eingang = s.sps;
    if (s.sps_neustart) {
      sps = neueSps({ herzschlag: 0, angenommen_zaehler: 0, abgelehnt_zaehler: 0 });
      halte = new Array(W.woerter).fill(0);
    }
    if (s.edge_neustart) lage = neueLage();
    if (s.nur_lesen) {
      // nur für Leser: dieselbe Steuerung, eine Lesung, die der Baustein nie erzeugt
    } else {
      if (s.w) {
        if (s.w.absicht) {
          const w = schreibe(s.w.absicht);
          if (JSON.stringify(w) !== JSON.stringify(s.w.woerter)) fehler.push(`${wo}: Schreiber ${w} statt ${s.w.woerter}`);
        }
        halte = s.w.woerter;
        if (s.w.von === 'edge') {
          lage.geschrieben++;
          lage.jeGeschrieben = true;
          lage.sitzung = s.w.woerter[wk('sitzung').adresse];
        }
      }
      if (s.sps_steht) {
        if (JSON.stringify(s.q_woerter) !== JSON.stringify(letztesQ)) fehler.push(`${wo}: das Abbild steht nicht`);
      } else {
        const { q, aus } = zyklus(sps, s.t_ms, halte, eingang);
        letztesQ = q;
        if (JSON.stringify(q) !== JSON.stringify(s.q_woerter)) {
          const k = q.findIndex((x, j) => x !== s.q_woerter[j]);
          fehler.push(`${wo}: Quittung Wort ${Q.basis + k}: ${q[k]} statt ${s.q_woerter[k]}`);
        }
        if (JSON.stringify(aus) !== JSON.stringify(s.erwartet_sps)) fehler.push(`${wo}: Baustein ${JSON.stringify(aus)} statt ${JSON.stringify(s.erwartet_sps)}`);
      }
    }
    if (s.liest === false) return;
    const gelesen = s.lesung?.keine_antwort ? null : liesQuittung(s.lesung?.woerter ?? s.q_woerter, f.steuerung_soll);
    if (s.nur_lesen) lage.vorige = null;
    try {
      expect(gelesen).toEqual(s.erwartet_lesung);
    } catch {
      fehler.push(`${wo}: Leser ${JSON.stringify(gelesen).slice(0, 300)}`);
    }
    const l = lageNach(lage, gelesen);
    if (JSON.stringify(l) !== JSON.stringify(s.erwartet_lage)) fehler.push(`${wo}: Lage ${JSON.stringify(l)} statt ${JSON.stringify(s.erwartet_lage)}`);
  });
  return fehler;
}

// ---- Tabellen aus Markdown ----
const zellen = (zeile: string): string[] => zeile.split('|').slice(1, -1).map((z) => z.trim());
const ohneMarkup = (z: string): string => z.replace(/`/g, '').trim();
const abschnitt = (nr: number): string => vertrag.split(`\n## ${nr}. `)[1].split('\n## ')[0];
const hex = (n: number | null): string => (n === null ? '–' : `0x${n.toString(16).toUpperCase()}`);
const fall = (praefix: string): Json => vektoren.faelle.find((f: Json) => f.name.startsWith(`${praefix} `));
const hexWoerter = (z: string): number[] => ohneMarkup(z).split(' ').map((h) => parseInt(h, 16));

describe('VoltPilot-Koppelbild v1: Schema und Aufbau', () => {
  it('das Schema bleibt in der Teilmenge des Schema-Läufers', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(fremdeSchluessel(schema, '$')).toEqual([]);
  });

  it('die Vektor-Datei hält das Schema; ein belegter Fall oder ein Feld ohne Typ fällt auf', () => {
    expect(schemaVerstoesse(vektoren, schema)).toEqual([]);
    const daten = structuredClone(vektoren);
    daten.faelle[0].belegt = true;
    delete daten.w.kopf[0].typ;
    expect(schemaVerstoesse(daten, schema)).toEqual(['$.w.kopf[0]: Pflichtfeld typ fehlt', '$.faelle[0].belegt: true ist nicht false']);
  });

  it('W ist lückenlos 0–63, Q lückenlos 1000–1115; 32 bit auf geraden Adressen; Stellplätze wie in §2', () => {
    for (const [abschnittWQ, kopfBis] of [[W, W.platz.basis], [Q, Q.platz.basis]] as [Json, number][]) {
      let a = abschnittWQ.basis;
      for (const f of abschnittWQ.kopf) {
        expect(f.adresse, f.feld).toBe(a);
        if (f.typ.endsWith('32')) expect(f.adresse % 2, f.feld).toBe(0);
        a += f.woerter;
      }
      expect(a).toBe(kopfBis);
      let v = 0;
      for (const f of abschnittWQ.platz.felder) {
        expect(f.adresse, f.feld).toBe(v);
        if (f.typ.endsWith('32')) expect((abschnittWQ.platz.basis + f.adresse) % 2, f.feld).toBe(0);
        v += f.woerter;
      }
      expect(v).toBe(abschnittWQ.platz.laenge);
      expect(kopfBis + PLAETZE * abschnittWQ.platz.laenge).toBe(abschnittWQ.basis + abschnittWQ.woerter);
    }
    expect([W.basis, W.woerter, W.platz.basis, W.platz.laenge, W.siegel_wort]).toEqual([0, 64, 16, 6, 15]);
    expect([Q.basis, Q.woerter, Q.platz.basis, Q.platz.laenge, Q.siegel_wort]).toEqual([1000, 116, 1020, 12, 1019]);
    expect(Math.max(W.woerter, Q.woerter)).toBeLessThanOrEqual(120);
  });

  it('ungültig ist das Typ-Maximum - außer bei Zählern, Echos, Prüfwerten, freien Wörtern und Siegeln', () => {
    const maximum: Record<string, number> = Object.fromEntries(vektoren.typen.map((t: Json) => [t.typ, t.ungueltig]));
    for (const f of [...W.kopf, ...W.platz.felder, ...Q.kopf, ...Q.platz.felder]) {
      const ohne = ['zaehler', 'echo', 'pruefwert', 'version', 'fest', 'frei', 'siegel'].includes(f.art);
      expect(f.ungueltig, f.feld).toBe(ohne ? null : maximum[f.typ]);
    }
  });

  it('Bits sind lückenlos ab 0 und liegen unter „frei ab“; Vokabulare haben eindeutige Codes', () => {
    for (const [feld, b] of Object.entries(vektoren.bitfelder) as [string, Json][]) {
      expect(b.bits.map((x: Json) => x.bit), feld).toEqual([...b.bits.keys()]);
      expect(b.frei_ab, feld).toBe(b.bits.length);
    }
    for (const [vok, liste] of Object.entries(vektoren.vokabular) as [string, Json][]) {
      const codes = liste.map((v: Json) => v.code);
      expect(new Set(codes).size, vok).toBe(codes.length);
    }
  });
});

describe('VoltPilot-Koppelbild v1: Vertrag ⟷ Datei', () => {
  const tabelle = (nr: number): string[][] =>
    abschnitt(nr).split('\n').filter((z) => /^\| \d+ \| [123] \| `[a-z_]+` \|/.test(z)).map(zellen);

  it('§3 nennt jedes Feld von W mit Adresse, Wörtern, Typ und Ungültig-Wert', () => {
    const soll = [...W.kopf, ...W.platz.felder.map((f: Json) => ({ ...f, adresse: W.platz.basis + f.adresse }))];
    const ist = tabelle(3);
    expect(ist.map((c) => ohneMarkup(c[2]))).toEqual(soll.map((f: Json) => f.feld));
    ist.forEach((c, i) => expect([Number(c[0]), Number(c[1]), c[3], c[4]], c[2]).toEqual(
      [soll[i].adresse, soll[i].woerter, soll[i].typ, hex(soll[i].ungueltig)]));
  });

  it('§4 nennt jedes Feld von Q mit Adresse, Wörtern, Typ und Ungültig-Wert', () => {
    const soll = [...Q.kopf, ...Q.platz.felder.map((f: Json) => ({ ...f, adresse: Q.platz.basis + f.adresse }))];
    const ist = tabelle(4);
    expect(ist.map((c) => ohneMarkup(c[2]))).toEqual(soll.map((f: Json) => f.feld));
    ist.forEach((c, i) => expect([Number(c[0]), Number(c[1]), c[3], c[4]], c[2]).toEqual(
      [soll[i].adresse, soll[i].woerter, soll[i].typ, hex(soll[i].ungueltig)]));
  });

  it('§5 nennt die Prüfreihenfolge des Bausteins und die Reihenfolge je Stellplatz', () => {
    const teil = abschnitt(5);
    const kopf = [...teil.split('Jeder Grund')[0].matchAll(/^\d\. .* → `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(kopf).toEqual(vektoren.sps.pruefreihenfolge.slice(0, 7));
    expect(/^8\. sonst `angenommen`/m.test(teil)).toBe(true);
    const platz = [...teil.split('Danach je Stellplatz')[1].matchAll(/^\d\. .*`([a-z_]+)`$/gm)].map((m) => m[1]);
    expect(platz).toEqual(vektoren.sps.platz_reihenfolge);
  });

  it('§6 nennt jedes Bit, §7 jedes Vokabular mit Code und Namen', () => {
    const bits = abschnitt(6).split('\n').filter((z) => /^\| `[a-z_]+` \| \d+ \| `[a-z_]+` \|/.test(z)).map(zellen);
    expect(bits.map((c) => [ohneMarkup(c[0]), Number(c[1]), ohneMarkup(c[2])])).toEqual(
      Object.entries(vektoren.bitfelder).flatMap(([f, b]: [string, Json]) => b.bits.map((x: Json) => [f, x.bit, x.name])));
    const frei = /Frei ab: (.*)\./.exec(abschnitt(6))![1].split(', ').map((s) => /`([a-z_]+)` Bit (\d+)/.exec(s)!.slice(1));
    expect(frei.map(([f, b]) => [f, Number(b)])).toEqual(Object.entries(vektoren.bitfelder).map(([f, b]: [string, Json]) => [f, b.frei_ab]));
    const vok = abschnitt(7).split('\n').filter((z) => /^\| `[a-z_]+` \| \d+ \| `[a-z_]+` \|/.test(z)).map(zellen);
    expect(vok.map((c) => [ohneMarkup(c[0]), Number(c[1]), ohneMarkup(c[2])])).toEqual(
      Object.entries(vektoren.vokabular).flatMap(([f, l]: [string, Json]) => l.map((v: Json) => [f, v.code, v.name])));
  });

  it('§9 nennt die Prüfreihenfolge des Lesers, §10 jede Lage der Edge mit schreibt und wünscht', () => {
    const leser = [...abschnitt(9).matchAll(/^\d\. .* → `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(leser).toEqual(vektoren.leser.pruefreihenfolge);
    const lagen = abschnitt(10).split('\n').filter((z) => /^\| `[a-z_]+` \|/.test(z)).map(zellen);
    expect(lagen.map((c) => [ohneMarkup(c[0]), c[2] === 'ja', c[3] === 'ja'])).toEqual(
      EDGE.lage.map((l: Json) => [l.name, l.schreibt, l.wuenscht]));
  });

  it('§8: das Siegel ist CRC-16/MODBUS mit dem Prüfwert 0x4B37', () => {
    const bytes = [...vektoren.siegel.pruefwert.text].map((c) => c.charCodeAt(0));
    let c = vektoren.siegel.start;
    for (const b of bytes) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ vektoren.siegel.polynom_gespiegelt : c >>> 1;
    }
    expect(c).toBe(vektoren.siegel.pruefwert.crc);
    expect(/ergibt 0x4B37/.test(abschnitt(8))).toBe(true);
    expect(crc16(new Array(63).fill(0))).toBe(0x1aab);
  });

  it('§11: die Rechenbeispiele rechnen richtig und sind die Wörter der Fälle', () => {
    const teil = abschnitt(11);
    const reihen = teil.split('\n').filter((z) => /^\| `0x[0-9A-F]{4} 0x[0-9A-F]{4}` \| [US]32 \|/.test(z)).map(zellen);
    expect(reihen.length).toBeGreaterThanOrEqual(7);
    for (const [w, typ, ergebnis] of reihen) {
      const u = roh32(hexWoerter(w), 0);
      if (ergebnis === 'kein Wert') expect(u).toBe(S32_MAX);
      else if (typ === 'S32') expect(s32(u), w).toBe(Number(ergebnis.replace('−', '-').replace(/[^\d-]/g, '')));
    }
    const zeile = (praefix: string) => hexWoerter(new RegExp(`${praefix}: \`([0-9A-Fx ]+)\``).exec(teil)![1]);
    const k1 = fall('K1').schritte;
    expect(zeile('Kopf W')).toEqual(k1[1].w.woerter.slice(0, 16));
    expect(zeile('- Stellplatz 1')).toEqual(k1[1].w.woerter.slice(16, 22));
    expect(zeile('Kopf Q')).toEqual(k1[2].q_woerter.slice(0, 20));
    expect(siegelW(k1[1].w.woerter)).toBe(0x4ed7);
    expect(siegelQ(k1[2].q_woerter)).toBe(0x8e72);
    const k3 = /Stellplatz 1 in Q: `([0-9A-Fx ]+)`/.exec(teil)![1];
    expect(hexWoerter(k3)).toEqual(fall('K3').schritte[2].q_woerter.slice(20, 32));
    const k5 = fall('K5').schritte[2].w.woerter;
    expect([k5[18], k5[15], siegelW(k5)]).toEqual([3, 0x4ed7, 0x8e6b]);
    const k20 = fall('K20').schritte[2].w.woerter;
    expect(hexWoerter(/Kopf W: `([0-9A-Fx ]+)`, Stellplatz 8/.exec(teil)![1])).toEqual(k20.slice(0, 16));
    expect(hexWoerter(/Stellplatz 8: `([0-9A-Fx ]+)`/.exec(teil)![1])).toEqual(k20.slice(58, 64));
    const k16 = /Stellplatz 2 in W: `([0-9A-Fx ]+)`/.exec(teil)![1];
    expect(hexWoerter(k16)).toEqual(fall('K16').schritte[1].w.woerter.slice(22, 28));
  });

  it('§12 nennt jeden Fall der Datei', () => {
    const genannt = new Set([...abschnitt(12).matchAll(/K\d+b?/g)].map((m) => m[0]));
    for (const f of vektoren.faelle) expect(genannt.has(f.name.split(' ')[0]) || genannt.has(f.name.split(' ')[0].replace('b', '')), f.name).toBe(true);
  });
});

describe('VoltPilot-Koppelbild v1: Fälle', () => {
  it('alle Fälle sind Vertrags-Fälle, keiner ist belegt; die Nummern sind eindeutig', () => {
    expect(vektoren.faelle.every((f: Json) => f.herkunft === 'vertrag' && f.belegt === false)).toBe(true);
    const nummern = vektoren.faelle.map((f: Json) => f.name.split(' ')[0]);
    expect(new Set(nummern).size).toBe(nummern.length);
  });

  it.each(vektoren.faelle.map((f: Json) => [f.name, f]))('%s: Schreiber, Baustein, Leser und Lage rechnen wie erwartet', (_, f: Json) => {
    expect(rechneFall(f)).toEqual([]);
  });

  it('die Fehlerbilder sind alle da: jedes Kopf-Urteil, jedes Stellplatz-Urteil, jeder Lesegrund, jede Lage', () => {
    const schritte = vektoren.faelle.flatMap((f: Json) => f.schritte);
    const kopf = new Set(schritte.filter((s: Json) => s.erwartet_sps).map((s: Json) => s.erwartet_sps.kopf_urteil));
    for (const v of vektoren.vokabular.kopf_urteil) expect(kopf, v.name).toContain(v.name);
    const platz = new Set(schritte.filter((s: Json) => s.erwartet_sps).flatMap((s: Json) => s.erwartet_sps.wunsch.map((w: Json) => w.urteil)));
    for (const v of vektoren.vokabular.q_urteil) expect(platz, v.name).toContain(v.name);
    const gruende = new Set(schritte.map((s: Json) => s.erwartet_lesung?.grund).filter(Boolean));
    for (const g of vektoren.leser.pruefreihenfolge) expect(gruende, g).toContain(g);
    const lagen = new Set(schritte.map((s: Json) => s.erwartet_lage?.lage).filter(Boolean));
    for (const l of EDGE.lage.filter((x: Json) => x.name !== 'ohne_soll')) expect(lagen, l.name).toContain(l.name);
    const leer = new Set(schritte.flatMap((s: Json) => (s.erwartet_lesung?.plaetze ?? []).flatMap((p: Json) => Object.values(p.leer))));
    for (const g of vektoren.leser.leer_gruende) expect(leer, g).toContain(g);
  });

  it('jeder Wunsch läuft von selbst ab: nach spätestens 60 s ohne neues Telegramm gilt keiner mehr (K4, K4b, K24)', () => {
    for (const k of ['K4', 'K4b', 'K24']) {
      const schritte = fall(k).schritte;
      const annahme = schritte.find((s: Json) => s.erwartet_sps?.kopf_urteil === 'angenommen').t_ms;
      for (const s of schritte.filter((x: Json) => x.erwartet_sps && x.t_ms >= annahme + 60_000)) {
        expect(s.erwartet_sps.wunsch.some((w: Json) => w.gilt), `${k} t=${s.t_ms}`).toBe(false);
        expect(s.erwartet_sps.rest_s).toBe(0);
      }
    }
  });
});
