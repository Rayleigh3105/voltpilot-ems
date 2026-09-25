/**
 * Die GEOMETRIE des Bildfahrplans (Konzept „Tagesuhr und Bildfahrplan", E10:
 * ab 900 px Inhaltsbreite zeigt die Fahrplan-Seite dieses Bild statt der Uhr).
 *
 * Die Idee kommt vom grafischen Fahrplan der Bahn: die Zeit läuft nach rechts,
 * der Weg nach oben, jede Fahrt ist eine Linie. Der „Weg" des Speichers ist
 * sein Ladestand zwischen „leer" und „voll": steigt die Linie, lädt er; fällt
 * sie, gibt er ab; liegt sie flach, wartet er. Darüber liegen die Ursachen als
 * eigene Spuren (Strompreis, Sonne und Verbrauch), darunter die Tätigkeit —
 * wer eine Spalte von oben nach unten liest, liest das Warum.
 *
 * Dieses Modul rechnet nur Formen und Positionen; Farben, Wörter und Bedienung
 * liegen in `components/FahrplanBildfahrplan.tsx`. Die Daten kommen aus dem
 * Tagesmodell (`fahrplanTag.ts`), dieselbe Quelle wie die Uhr. Rein.
 *
 * Ehrlichkeit: Vergangene Viertelstunden zeigen den PLAN, der für sie galt
 * (Tages-Splice) — gedämpft und nie als Messung. Gemessen sind nur Sonne und
 * Verbrauch, soweit die Viertelstunden sie tragen; eine fehlende Messung bleibt
 * eine Lücke, nie eine 0.
 */

import { TAG_MINUTEN, ladestandPlan, uhrzeit, type TagModell } from './fahrplanTag';
import type { PhaseKind, SlotRole } from './fahrplanWhy';

/** Die Spuren von oben nach unten und ihre Höhen (Pixel). */
const SPUR = {
  oben: 25,
  preis: 44,
  luecke1: 8,
  sonne: 44,
  luecke2: 12,
  ladestand: 122,
  luecke3: 9,
  taetigkeit: 26,
  achse: 22,
} as const;

/** Breite der Beschriftungsspalte links und des Randes rechts. */
export const BILD_LINKS = 112;
export const BILD_RECHTS = 44;

export interface BildGeometrie {
  breite: number;
  hoehe: number;
  links: number;
  rechts: number;
  preis: [number, number];
  sonne: [number, number];
  ladestand: [number, number];
  taetigkeit: [number, number];
  achseY: number;
  /** x einer Uhrzeit. */
  x: (minute: number) => number;
  /** y eines Ladestands in Prozent. */
  y: (pct: number) => number;
  /** Uhrzeit an einer x-Position; null außerhalb der Zeichenfläche. */
  minuteBei: (x: number) => number | null;
}

/**
 * `mitPreis = false`: der Tag trägt keinen Preis, der den Plan treibt
 * (`fahrplanTag.bildPreisArt`) — dann entfällt die Spur samt ihrer Lücke, statt
 * leer über dem Bild zu stehen.
 */
export function bildGeometrie(breite: number, mitPreis = true): BildGeometrie {
  const b = Math.max(480, breite);
  let y = SPUR.oben;
  const preisHoehe = mitPreis ? SPUR.preis : 0;
  const preis: [number, number] = [y, y + preisHoehe];
  y += preisHoehe + (mitPreis ? SPUR.luecke1 : 0);
  const sonne: [number, number] = [y, y + SPUR.sonne];
  y += SPUR.sonne + SPUR.luecke2;
  const ladestand: [number, number] = [y, y + SPUR.ladestand];
  y += SPUR.ladestand + SPUR.luecke3;
  const taetigkeit: [number, number] = [y, y + SPUR.taetigkeit];
  y += SPUR.taetigkeit;
  const flaeche = b - BILD_LINKS - BILD_RECHTS;
  return {
    breite: b,
    hoehe: y + SPUR.achse,
    links: BILD_LINKS,
    rechts: BILD_RECHTS,
    preis,
    sonne,
    ladestand,
    taetigkeit,
    achseY: y + 16,
    x: (m) => BILD_LINKS + (m / TAG_MINUTEN) * flaeche,
    y: (pct) => ladestand[1] - (Math.max(0, Math.min(100, pct)) / 100) * (ladestand[1] - ladestand[0]),
    minuteBei: (x) => {
      if (x < BILD_LINKS - 2 || x > BILD_LINKS + flaeche + 2) return null;
      return Math.max(0, Math.min(TAG_MINUTEN - 0.001, ((x - BILD_LINKS) / flaeche) * TAG_MINUTEN));
    },
  };
}

export interface BildPreisBalken {
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = günstigste, 1 = teuerste Viertelstunde; null = kein Preis. */
  stufe: number | null;
}

export interface BildBeschriftung {
  x: number;
  y: number;
  text: string;
  anker: 'start' | 'middle' | 'end';
}

export interface BildLinienStueck {
  role: SlotRole;
  kind: PhaseKind;
  d: string;
  vorbei: boolean;
}

export interface BildBand {
  phaseIndex: number;
  role: SlotRole;
  kind: PhaseKind;
  x: number;
  w: number;
  vorbei: boolean;
  /** Das Wort im Band, wenn es hineinpasst; sonst nur das Symbol (oder nichts). */
  text: string | null;
  symbol: boolean;
}

export interface BildModell {
  preis: BildPreisBalken[];
  preisMarken: (BildBeschriftung & { art: 'min' | 'max'; ct: number })[];
  /** Die Null-Linie, falls der Preis unter null fällt; sonst null. */
  preisNull: number | null;
  sonnePrognose: string | null;
  sonneGemessen: string | null;
  verbrauchPrognose: string | null;
  verbrauchGemessen: string | null;
  sonneSpitze: (BildBeschriftung & { kw: number; gemessen: boolean }) | null;
  ladestandFlaeche: string | null;
  ladestandLinie: BildLinienStueck[];
  /** „voll 17:15", „leer 07:15" und der Stand um Mitternacht. */
  ladestandMarken: (BildBeschriftung & { art: 'voll' | 'leer' | 'ende'; px: number; py: number })[];
  baender: BildBand[];
  achse: { x: number; text: string | null; gross: boolean }[];
  jetztX: number | null;
}

/** Ungefähre Textbreite (px) für die Frage, ob ein Wort ins Band passt. */
function textBreite(text: string, px = 12): number {
  return text.length * px * 0.55;
}

function zahl(v: unknown): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

export function bildModell(tag: TagModell, g: BildGeometrie): BildModell {
  const x = g.x;
  const n = (v: number) => v.toFixed(1);

  // ---- Strompreis ------------------------------------------------------------
  const pr = tag.preis;
  const preis: BildPreisBalken[] = [];
  const preisMarken: BildModell['preisMarken'] = [];
  let preisNull: number | null = null;
  if (pr) {
    const lo = Math.min(0, pr.min);
    const hi = Math.max(pr.max, 0.1) * 1.22;
    const py = (v: number) => g.preis[1] - ((v - lo) / (hi - lo)) * (g.preis[1] - g.preis[0]);
    const y0 = py(0);
    if (pr.min < 0) preisNull = y0;
    const spanne = pr.max > pr.min ? pr.max - pr.min : 0;
    tag.viertel.forEach((v) => {
      const ct = pr.ct[v.i];
      if (ct == null) return;
      const yv = py(ct);
      preis.push({
        i: v.i,
        x: x(v.von) + 0.5,
        y: Math.min(yv, y0),
        w: Math.max(0.5, x(v.bis) - x(v.von) - 1),
        h: Math.abs(y0 - yv),
        stufe: spanne > 0 ? (ct - pr.min) / spanne : 0.5,
      });
    });
    for (const [art, i] of [['min', pr.iMin], ['max', pr.iMax]] as const) {
      const v = tag.viertel[i];
      const ct = pr.ct[i] as number;
      const cx = Math.max(g.links + 22, Math.min(g.breite - g.rechts - 18, x((v.von + v.bis) / 2)));
      preisMarken.push({ art, ct, x: cx, y: Math.min(py(ct), y0) - 4, text: '', anker: 'middle' });
    }
  }

  // ---- Sonne und Verbrauch ------------------------------------------------------
  const pvF = tag.slots.map((s) => zahl(s.pvKw));
  const ldF = tag.slots.map((s) => zahl(s.loadKw));
  const gemessenErlaubt = tag.viertel.map((v) => v.vorbei || v.laeuft);
  const pvM = tag.slots.map((s, i) => (gemessenErlaubt[i] ? zahl(s.measuredPvKw) : null));
  const ldM = tag.slots.map((s, i) => (gemessenErlaubt[i] ? zahl(s.measuredLoadKw) : null));
  const alle = [...pvF, ...ldF, ...pvM, ...ldM].filter((v): v is number => v != null);
  const sMax = Math.max(1, ...alle) * 1.18;
  const sy = (v: number) => g.sonne[1] - (Math.max(0, v) / sMax) * (g.sonne[1] - g.sonne[0]);
  const mitte = (i: number) => (tag.viertel[i].von + tag.viertel[i].bis) / 2;

  /** Fläche über zusammenhängende Werte; Lücken schließen die Fläche. */
  const flaeche = (werte: (number | null)[]): string | null => {
    let d = '';
    let offen = false;
    let letztesX = 0;
    werte.forEach((v, i) => {
      if (v == null) {
        if (offen) d += `L${n(letztesX)} ${n(g.sonne[1])}Z`;
        offen = false;
        return;
      }
      const px = x(mitte(i));
      if (!offen) d += `M${n(px)} ${n(g.sonne[1])}`;
      d += `L${n(px)} ${n(sy(v))}`;
      offen = true;
      letztesX = px;
    });
    if (offen) d += `L${n(letztesX)} ${n(g.sonne[1])}Z`;
    return d || null;
  };
  const linie = (werte: (number | null)[]): string | null => {
    let d = '';
    let offen = false;
    werte.forEach((v, i) => {
      if (v == null) {
        offen = false;
        return;
      }
      d += `${offen ? 'L' : 'M'}${n(x(mitte(i)))} ${n(sy(v))}`;
      offen = true;
    });
    return d || null;
  };
  // Die Prognose zeichnet nur, was noch kommt oder läuft — für die
  // Vergangenheit steht die Messung da, soweit es sie gibt; ohne Messung
  // bleibt die (gedämpfte) Prognose stehen, damit keine Lücke entsteht, die
  // wie „keine Sonne" aussieht.
  const pvFZukunft = pvF.map((v, i) => (pvM[i] != null ? null : v));
  const ldFZukunft = ldF.map((v, i) => (ldM[i] != null ? null : v));

  // Die Spitze ist der höchste GEZEICHNETE Wert: wo gemessen wurde die
  // Messung, sonst die Prognose — nie eine Prognose, die im Bild nicht steht.
  let sonneSpitze: BildModell['sonneSpitze'] = null;
  let spitzeI = -1;
  let spitzeV = 0;
  pvF.forEach((v, i) => {
    const w = pvM[i] ?? v ?? 0;
    if (w > spitzeV + 1e-9) {
      spitzeV = w;
      spitzeI = i;
    }
  });
  if (spitzeI >= 0 && spitzeV > 0.05) {
    const gemessen = pvM[spitzeI] != null;
    const kw = gemessen ? (pvM[spitzeI] as number) : (pvF[spitzeI] as number);
    sonneSpitze = {
      x: x(mitte(spitzeI)),
      y: Math.max(g.sonne[0] + 10, sy(spitzeV) - 4),
      text: '',
      anker: 'middle',
      kw,
      gemessen,
    };
  }

  // ---- Ladestand: die Fahrlinie ----------------------------------------------
  const soc = ladestandPlan(tag);
  const punkte: { m: number; v: number; i: number }[] = [];
  tag.viertel.forEach((v) => {
    const s = soc[v.i];
    if (s != null) punkte.push({ m: v.bis, v: s, i: v.i });
  });
  let ladestandFlaeche: string | null = null;
  const ladestandLinie: BildLinienStueck[] = [];
  const ladestandMarken: BildModell['ladestandMarken'] = [];
  if (punkte.length >= 2) {
    const boden = g.y(0);
    ladestandFlaeche =
      `M${n(x(punkte[0].m))} ${n(boden)}` +
      punkte.map((q) => `L${n(x(q.m))} ${n(g.y(q.v))}`).join('') +
      `L${n(x(punkte[punkte.length - 1].m))} ${n(boden)}Z`;
    // Je Viertelstunde ein Stück von ihrem Anfangs- zu ihrem Endstand, gefärbt
    // nach der Rolle ihrer Phase; gleiche Nachbarn werden zu einem Pfad.
    let stueck: BildLinienStueck | null = null;
    for (let k = 1; k < punkte.length; k++) {
      const a = punkte[k - 1];
      const b = punkte[k];
      const s = tag.slots[b.i];
      const role = (s.slotRole ?? 'warten') as SlotRole;
      const ph = tag.phasen.find((p) => {
        const roh = tag.phasenRoh[p.phaseIndex];
        return b.i >= roh.startIdx && b.i <= roh.endIdx;
      });
      const kind: PhaseKind = ph?.kind ?? 'idle';
      const vorbei = tag.viertel[b.i].vorbei;
      const phRole = ph?.role ?? role;
      if (stueck && stueck.role === phRole && stueck.vorbei === vorbei) {
        stueck.d += `L${n(x(b.m))} ${n(g.y(b.v))}`;
      } else {
        stueck = {
          role: phRole,
          kind,
          vorbei,
          d: `M${n(x(a.m))} ${n(g.y(a.v))}L${n(x(b.m))} ${n(g.y(b.v))}`,
        };
        ladestandLinie.push(stueck);
      }
    }
    // Direkt an der Linie: wann der Plan voll bzw. leer wird — nur, wo die
    // Viertelstunde die Grenze als BINDEND trägt (Flag), nie aus einer Zahl
    // geraten.
    const flagBei = (flag: string) =>
      tag.viertel.find((v) => (tag.slots[v.i].slotFlags ?? []).includes(flag) && soc[v.i] != null);
    const voll = flagBei('soc_max');
    if (voll) {
      const px = x(voll.von);
      ladestandMarken.push({
        art: 'voll',
        px,
        py: g.y(soc[voll.i] as number),
        x: Math.min(g.breite - g.rechts - 30, Math.max(g.links + 30, px)),
        y: g.y(soc[voll.i] as number) - 7,
        text: `voll ${uhrzeit(voll.von)}`,
        anker: 'middle',
      });
    }
    const leer = flagBei('soc_floor');
    if (leer) {
      const px = x(leer.von);
      ladestandMarken.push({
        art: 'leer',
        px,
        py: g.y(soc[leer.i] as number),
        x: Math.min(g.breite - g.rechts - 30, Math.max(g.links + 30, px)),
        y: g.y(soc[leer.i] as number) + 16,
        text: `leer ${uhrzeit(leer.von)}`,
        anker: 'middle',
      });
    }
    const letzter = punkte[punkte.length - 1];
    ladestandMarken.push({
      art: 'ende',
      px: x(letzter.m),
      py: g.y(letzter.v),
      x: x(letzter.m) + 7,
      y: g.y(letzter.v) + 4,
      text: `${Math.round(letzter.v).toLocaleString('de-DE')} %`,
      anker: 'start',
    });
  }

  // ---- Tätigkeit ---------------------------------------------------------------
  const baender: BildBand[] = tag.phasen.map((ph) => {
    const x0 = x(ph.von) + 0.6;
    const x1 = x(ph.bis) - 0.6;
    const w = Math.max(0, x1 - x0);
    const text = w >= textBreite(ph.label) + 30 ? ph.label : null;
    return {
      phaseIndex: ph.phaseIndex,
      role: ph.role,
      kind: ph.kind,
      x: x0,
      w,
      vorbei: ph.vorbei,
      text,
      symbol: w >= 18,
    };
  });

  const achse: BildModell['achse'] = [];
  for (let h = 0; h <= 24; h++) {
    achse.push({ x: x(h * 60), text: h % 3 === 0 ? uhrzeit(h * 60) : null, gross: h % 3 === 0 });
  }

  return {
    preis,
    preisMarken,
    preisNull,
    sonnePrognose: flaeche(pvFZukunft),
    sonneGemessen: flaeche(pvM),
    verbrauchPrognose: linie(ldFZukunft),
    verbrauchGemessen: linie(ldM),
    sonneSpitze,
    ladestandFlaeche,
    ladestandLinie,
    ladestandMarken,
    baender,
    achse,
    jetztX: tag.jetzt == null ? null : x(tag.jetzt),
  };
}

// ---- Die Lupe: der Energiefluss einer Viertelstunde ------------------------------

export type FlussKnoten = 'sonne' | 'netz' | 'speicher' | 'haus';

export interface FlussStrom {
  von: FlussKnoten;
  nach: FlussKnoten;
  kw: number;
}

/**
 * Wohin die Energie einer Viertelstunde fließt, aus vier Leistungen (kW,
 * Vorzeichen wie im Vertrag: Speicher > 0 lädt). Die Sonne versorgt zuerst das
 * Haus, dann den Speicher, der Rest geht ins Netz; was dem Haus fehlt, kommt
 * aus dem Speicher (wenn er abgibt) und dann aus dem Netz. Werte unter
 * 0,05 kW sind Rauschen und fallen weg. Abgeregelte Leistung fließt nicht.
 */
export function energieFluss(w: {
  pvKw: number | null;
  loadKw: number | null;
  batteryKw: number | null;
  curtailKw?: number | null;
}): FlussStrom[] | null {
  if (w.loadKw == null || w.batteryKw == null) return null;
  const pv = Math.max(0, (w.pvKw ?? 0) - Math.max(0, w.curtailKw ?? 0));
  const last = Math.max(0, w.loadKw);
  const b = w.batteryKw;
  const pvHaus = Math.min(pv, last);
  let rest = pv - pvHaus;
  let bedarf = last - pvHaus;
  let pvSpeicher = 0;
  let netzSpeicher = 0;
  let speicherHaus = 0;
  let speicherNetz = 0;
  if (b > 0) {
    pvSpeicher = Math.min(rest, b);
    rest -= pvSpeicher;
    netzSpeicher = b - pvSpeicher;
  } else if (b < 0) {
    speicherHaus = Math.min(-b, bedarf);
    bedarf -= speicherHaus;
    speicherNetz = -b - speicherHaus;
  }
  const stroeme: FlussStrom[] = [
    { von: 'sonne', nach: 'haus', kw: pvHaus },
    { von: 'sonne', nach: 'speicher', kw: pvSpeicher },
    { von: 'sonne', nach: 'netz', kw: rest },
    { von: 'netz', nach: 'haus', kw: bedarf },
    { von: 'netz', nach: 'speicher', kw: netzSpeicher },
    { von: 'speicher', nach: 'haus', kw: speicherHaus },
    { von: 'speicher', nach: 'netz', kw: speicherNetz },
  ];
  return stroeme.filter((s) => s.kw > 0.05);
}
