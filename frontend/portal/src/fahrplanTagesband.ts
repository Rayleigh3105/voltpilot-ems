/**
 * Die GEOMETRIE des TAGESBANDS - das Tagesbild der Fahrplan-Seite am Rechner
 * (Überblick 20.10.2026, Nachfolger des Bildfahrplans).
 *
 * Gelesen wird von oben nach unten, wie eine Kundin den Tag erzählt:
 *  1. **Was der Speicher tut** - die Phasen als beschriftete Blöcke (Wort,
 *     Symbol, Uhrzeit). Kein Farbstreifen am unteren Rand mehr, den man erst
 *     den Kurven darüber zuordnen muss: die Geschichte steht oben.
 *  2. **Was daraus wird** - der Ladestand: links von jetzt GEMESSEN
 *     (durchgezogen, Ist-Spur), rechts GEPLANT (gestrichelt). Ohne Messung
 *     bleibt links der Plan, blass („war geplant").
 *  3. **Warum** - die zwei Ursachen als schmale Spuren: Sonne und Strompreis
 *     (nur, wenn ein Preis den Plan treibt, `fahrplanTag.bildPreisArt`).
 *
 * Dieses Modul rechnet nur Formen und Positionen; Farben, Wörter und Bedienung
 * stehen in `components/FahrplanTagesband.tsx`. Daten: das Tagesmodell
 * (`fahrplanTag.ts`) und die Ist-Spur (`fahrplanIst.ts`). Rein.
 *
 * Ehrlichkeit wie überall im Tagesbild: Vergangenes ist entweder gemessen oder
 * „war geplant", nie beides ununterscheidbar; eine fehlende Messung ist eine
 * Lücke, nie eine 0; „voll"/„leer" steht nur, wo der Plan die Grenze als
 * bindend trägt.
 */

import { TAG_MINUTEN, ladestandPlan, uhrzeit, type TagModell } from './fahrplanTag';
import type { SlotRole } from './fahrplanWhy';

/** Die Spuren von oben nach unten (Pixel). */
const SPUR = {
  ueber: 18,
  kopf: 50,
  luecke0: 14,
  ladestand: 150,
  luecke1: 18,
  sonne: 34,
  luecke2: 10,
  preis: 20,
  preisMarke: 16,
  achse: 22,
} as const;

/** Beschriftungsspalte links, Rand rechts (für die Prozentzahl am Tagesende). */
export const BAND_LINKS = 92;
export const BAND_RECHTS = 46;

export interface BandGeometrie {
  breite: number;
  hoehe: number;
  links: number;
  rechts: number;
  kopf: [number, number];
  ladestand: [number, number];
  sonne: [number, number];
  /** null = der Tag trägt keinen Preis, der den Plan treibt. */
  preis: [number, number] | null;
  achseY: number;
  x: (minute: number) => number;
  y: (pct: number) => number;
  minuteBei: (x: number) => number | null;
}

export function bandGeometrie(breite: number, mitPreis = true): BandGeometrie {
  const b = Math.max(560, breite);
  let y = SPUR.ueber;
  const kopf: [number, number] = [y, y + SPUR.kopf];
  y += SPUR.kopf + SPUR.luecke0;
  const ladestand: [number, number] = [y, y + SPUR.ladestand];
  y += SPUR.ladestand + SPUR.luecke1;
  const sonne: [number, number] = [y, y + SPUR.sonne];
  y += SPUR.sonne;
  let preis: [number, number] | null = null;
  if (mitPreis) {
    y += SPUR.luecke2;
    preis = [y, y + SPUR.preis];
    y += SPUR.preis + SPUR.preisMarke;
  }
  const flaeche = b - BAND_LINKS - BAND_RECHTS;
  return {
    breite: b,
    hoehe: y + SPUR.achse,
    links: BAND_LINKS,
    rechts: BAND_RECHTS,
    kopf,
    ladestand,
    sonne,
    preis,
    achseY: y + 16,
    x: (m) => BAND_LINKS + (m / TAG_MINUTEN) * flaeche,
    y: (pct) => ladestand[1] - (Math.max(0, Math.min(100, pct)) / 100) * (ladestand[1] - ladestand[0]),
    minuteBei: (x) => {
      if (x < BAND_LINKS - 2 || x > BAND_LINKS + flaeche + 2) return null;
      return Math.max(0, Math.min(TAG_MINUTEN - 0.001, ((x - BAND_LINKS) / flaeche) * TAG_MINUTEN));
    },
  };
}

/** Ein Block der Kopfzeile: eine Phase mit ihrem Wort, wenn es hineinpasst. */
export interface BandBlock {
  phaseIndex: number;
  role: SlotRole;
  x: number;
  w: number;
  vorbei: boolean;
  laeuft: boolean;
  /** Das Wort im Block; null = zu schmal (dann nur das Symbol oder nichts). */
  text: string | null;
  /** „10:30–12:00" unter dem Wort; null = passt nicht. */
  zeit: string | null;
  symbol: boolean;
  /**
   * Das Wort ÜBER einem schmalen Block (eine Zeile über der Kopfzeile), wenn
   * es dort niemanden verdeckt; null = es steht im Block oder gar nicht (dann
   * nennt es die Lupe und „Ihr Tag").
   */
  ueber: { text: string; x: number } | null;
}

export interface BandPunkt {
  x: number;
  y: number;
}

export interface BandMarke {
  x: number;
  y: number;
  text: string;
  anker: 'start' | 'middle' | 'end';
}

export interface BandModell {
  bloecke: BandBlock[];
  /** x der Phasengrenzen (für die feinen Trennlinien durch das Bild). */
  grenzen: number[];
  /** Gemessener Ladestand (Ist): Linie und Fläche; null ohne Messung. */
  istLinie: string | null;
  istFlaeche: string | null;
  /** Geplanter Ladestand ab jetzt (bzw. des ganzen Tages ohne Jetzt). */
  planLinie: string | null;
  planFlaeche: string | null;
  /** Der vergangene PLAN, wo keine Messung da ist („war geplant"). */
  planVorbeiLinie: string | null;
  /** Der Punkt „jetzt" auf der Ladestandslinie mit seinem Wert. */
  jetztPunkt: (BandPunkt & { pct: number; gemessen: boolean }) | null;
  /** „voll 12:30", „leer 07:15" und der Stand am Tagesende. */
  marken: (BandMarke & { art: 'voll' | 'leer' | 'ende' | 'anfang' })[];
  sonneGemessen: string | null;
  sonneErwartet: string | null;
  sonneSpitze: (BandMarke & { gemessen: boolean; kw: number }) | null;
  preis: { x: number; w: number; stufe: number }[];
  preisMarken: (BandMarke & { art: 'min' | 'max'; ct: number })[];
  achse: { x: number; text: string | null; gross: boolean }[];
  jetztX: number | null;
}

/** Ungefähre Textbreite (px) bei 12,5 px Schrift. */
export function bandTextBreite(text: string, px = 12.5): number {
  return text.length * px * 0.56;
}

function zahl(v: unknown): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

const n = (v: number) => v.toFixed(1);

/** Eine Linie durch Punkte; null-Werte öffnen eine Lücke. */
function linie(punkte: ({ x: number; y: number } | null)[]): string | null {
  let d = '';
  let offen = false;
  for (const p of punkte) {
    if (!p) {
      offen = false;
      continue;
    }
    d += `${offen ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`;
    offen = true;
  }
  return d || null;
}

/** Die Fläche unter zusammenhängenden Punkten bis `boden`. */
function flaeche(punkte: ({ x: number; y: number } | null)[], boden: number): string | null {
  let d = '';
  let lauf: { x: number; y: number }[] = [];
  const schliessen = () => {
    if (lauf.length >= 2) {
      d +=
        `M${n(lauf[0].x)} ${n(boden)}` +
        lauf.map((p) => `L${n(p.x)} ${n(p.y)}`).join('') +
        `L${n(lauf[lauf.length - 1].x)} ${n(boden)}Z`;
    }
    lauf = [];
  };
  for (const p of punkte) {
    if (!p) schliessen();
    else lauf.push(p);
  }
  schliessen();
  return d || null;
}

export function bandModell(
  tag: TagModell,
  g: BandGeometrie,
  ist: readonly (number | null)[] = [],
): BandModell {
  const x = g.x;

  // ---- 1. Kopf: die Phasen als Blöcke ------------------------------------------
  const bloecke: BandBlock[] = tag.phasen.map((ph) => {
    const x0 = x(ph.von) + 1;
    const x1 = x(ph.bis) - 1;
    const w = Math.max(0, x1 - x0);
    const zeit = `${uhrzeit(ph.von)}–${uhrzeit(ph.bis)}`;
    // Symbol (15 px) + Abstände: was danach bleibt, trägt das Wort.
    const platz = w - 38;
    const text = platz >= bandTextBreite(ph.label) ? ph.label : null;
    return {
      phaseIndex: ph.phaseIndex,
      role: ph.role,
      x: x0,
      w,
      vorbei: ph.vorbei,
      laeuft: ph.laeuft,
      text,
      zeit: text && platz >= bandTextBreite(zeit, 11.5) ? zeit : null,
      symbol: w >= 20,
      ueber: null,
    };
  });
  // Schmale Blöcke bekommen ihr Wort ÜBER die Kopfzeile - der Reihe nach, die
  // längsten zuerst, und nur, wo es keinen Nachbarn verdeckt.
  const belegt: [number, number][] = [];
  const reihe = bloecke
    .filter((b) => b.text == null && b.w >= 12)
    .sort((a, b) => b.w - a.w);
  for (const b of reihe) {
    const label = tag.phasen.find((p) => p.phaseIndex === b.phaseIndex)?.label ?? '';
    const breiteText = bandTextBreite(label, 11.5);
    const mitte = Math.max(g.links + breiteText / 2, Math.min(g.breite - g.rechts - breiteText / 2, b.x + b.w / 2));
    const von = mitte - breiteText / 2 - 6;
    const bis = mitte + breiteText / 2 + 6;
    if (belegt.some(([a, c]) => von < c && bis > a)) continue;
    belegt.push([von, bis]);
    b.ueber = { text: label, x: mitte };
  }
  const grenzen = tag.phasen.slice(1).map((ph) => x(ph.von));

  // ---- 2. Ladestand: Ist links, Plan rechts --------------------------------------
  // Werte gelten am ENDE ihrer Viertelstunde; der Tagesanfang bekommt den Stand
  // vor der ersten Viertelstunde nicht (unbekannt), die Linie beginnt beim
  // ersten Ende.
  const plan = ladestandPlan(tag);
  const jetztI = tag.jetztIndex;
  const punkt = (i: number, v: number | null) =>
    v == null ? null : { x: x(tag.viertel[i].bis), y: g.y(v), v };
  // Der Plan ab jetzt: beginnt am Ende der laufenden Viertelstunde, damit er
  // an den letzten gemessenen Punkt anschließt.
  const planAb = jetztI >= 0 ? jetztI : 0;
  const planPunkte = tag.viertel.map((v) => (v.i >= planAb ? punkt(v.i, plan[v.i]) : null));
  const istPunkte = tag.viertel.map((v) => punkt(v.i, ist[v.i] ?? null));
  const hatIst = istPunkte.some((p) => p != null);
  // Vergangener Plan nur, wo die Messung fehlt.
  const planVorbei =
    jetztI >= 0
      ? tag.viertel.map((v) => (v.i < jetztI && istPunkte[v.i] == null ? punkt(v.i, plan[v.i]) : null))
      : [];
  const boden = g.y(0);

  // Wo gemessen wurde, schließt der Plan an die Messung an: ein kurzer Steg vom
  // letzten Ist-Punkt zum ersten Plan-Punkt (sonst klaffte zwischen beiden eine
  // Lücke, die wie ein Sprung aussieht).
  let letzterIst: { x: number; y: number } | null = null;
  for (const p of istPunkte) if (p) letzterIst = p;
  const planMitAnschluss =
    letzterIst && jetztI >= 0 ? [letzterIst, ...planPunkte.slice(jetztI)] : planPunkte;

  let jetztPunkt: BandModell['jetztPunkt'] = null;
  if (jetztI >= 0 && tag.jetzt != null) {
    const istJetzt = ist[jetztI] ?? null;
    const planJetzt = plan[jetztI];
    const pct = istJetzt ?? planJetzt;
    if (pct != null) {
      jetztPunkt = { x: x(tag.jetzt), y: g.y(pct), pct, gemessen: istJetzt != null };
    }
  }

  const marken: BandModell['marken'] = [];
  const flagBei = (flag: string) =>
    tag.viertel.find((v) => v.i >= planAb && (tag.slots[v.i].slotFlags ?? []).includes(flag) && plan[v.i] != null);
  // „voll" erst ab der NÄCHSTEN Viertelstunde: ist der Speicher jetzt schon
  // voll, sagt es die Jetzt-Karte („Speicher voll"), und die Marke läge auf
  // der Jetzt-Linie.
  const voll = (() => {
    const v = flagBei('soc_max');
    return v && v.i > jetztI ? v : null;
  })();
  if (voll) {
    marken.push({
      art: 'voll',
      x: Math.min(g.breite - g.rechts - 24, Math.max(g.links + 24, x(voll.von))),
      y: g.y(plan[voll.i] as number) - 8,
      text: `voll ${uhrzeit(voll.von)}`,
      anker: 'middle',
    });
  }
  const leer = flagBei('soc_floor');
  if (leer) {
    marken.push({
      art: 'leer',
      x: Math.min(g.breite - g.rechts - 24, Math.max(g.links + 24, x(leer.von))),
      y: g.y(plan[leer.i] as number) + 16,
      text: `leer ${uhrzeit(leer.von)}`,
      anker: 'middle',
    });
  }
  const letzterPlan = [...planPunkte].reverse().find((p) => p != null);
  if (letzterPlan) {
    marken.push({
      art: 'ende',
      x: letzterPlan.x + 7,
      y: letzterPlan.y + 4,
      text: `${Math.round(letzterPlan.v).toLocaleString('de-DE')} %`,
      anker: 'start',
    });
  }
  const ersterWert = istPunkte.find((p) => p != null) ?? planVorbei.find((p) => p != null) ?? null;
  if (ersterWert && jetztI !== 0) {
    marken.push({
      art: 'anfang',
      x: ersterWert.x + 4,
      y: ersterWert.y - 8,
      text: `${Math.round(ersterWert.v).toLocaleString('de-DE')} %`,
      anker: 'start',
    });
  }

  // ---- 3a. Sonne -----------------------------------------------------------------------
  const pvF = tag.slots.map((s) => zahl(s.pvKw));
  const gewesen = tag.viertel.map((v) => v.vorbei || v.laeuft);
  const pvM = tag.slots.map((s, i) => (gewesen[i] ? zahl(s.measuredPvKw) : null));
  const sMax = Math.max(0.5, ...pvF.filter((v): v is number => v != null), ...pvM.filter((v): v is number => v != null));
  const sy = (v: number) => g.sonne[1] - (Math.max(0, v) / sMax) * (g.sonne[1] - g.sonne[0] - 4);
  const mitte = (i: number) => (tag.viertel[i].von + tag.viertel[i].bis) / 2;
  const sonnePunkt = (i: number, v: number | null) => (v == null ? null : { x: x(mitte(i)), y: sy(v) });
  const sonneGemessen = flaeche(pvM.map((v, i) => sonnePunkt(i, v)), g.sonne[1]);
  const sonneErwartet = flaeche(
    pvF.map((v, i) => sonnePunkt(i, pvM[i] != null ? null : v)),
    g.sonne[1],
  );
  let spitzeI = -1;
  let spitzeV = 0;
  pvF.forEach((v, i) => {
    const w = pvM[i] ?? v ?? 0;
    if (w > spitzeV + 1e-9) {
      spitzeV = w;
      spitzeI = i;
    }
  });
  const sonneSpitze =
    spitzeI >= 0 && spitzeV > 0.05
      ? {
          x: x(mitte(spitzeI)),
          y: sy(spitzeV) - 4,
          text: '',
          anker: 'middle' as const,
          gemessen: pvM[spitzeI] != null,
          kw: spitzeV,
        }
      : null;

  // ---- 3b. Strompreis ----------------------------------------------------------------
  const preis: BandModell['preis'] = [];
  const preisMarken: BandModell['preisMarken'] = [];
  const pr = tag.preis;
  if (pr && g.preis) {
    const spanne = pr.max > pr.min ? pr.max - pr.min : 0;
    tag.viertel.forEach((v) => {
      const ct = pr.ct[v.i];
      if (ct == null) return;
      preis.push({
        x: x(v.von),
        w: Math.max(0.5, x(v.bis) - x(v.von)),
        stufe: spanne > 0 ? (ct - pr.min) / spanne : 0.5,
      });
    });
    for (const [art, i] of [['min', pr.iMin], ['max', pr.iMax]] as const) {
      const v = tag.viertel[i];
      preisMarken.push({
        art,
        ct: pr.ct[i] as number,
        x: Math.max(g.links + 40, Math.min(g.breite - g.rechts - 40, x((v.von + v.bis) / 2))),
        y: g.preis[1] + 12,
        text: '',
        anker: 'middle',
      });
    }
  }

  const achse: BandModell['achse'] = [];
  for (let h = 0; h <= 24; h++) {
    achse.push({ x: x(h * 60), text: h % 3 === 0 ? uhrzeit(h * 60) : null, gross: h % 3 === 0 });
  }

  return {
    bloecke,
    grenzen,
    istLinie: hatIst ? linie(istPunkte) : null,
    istFlaeche: hatIst ? flaeche(istPunkte, boden) : null,
    planLinie: linie(planMitAnschluss),
    planFlaeche: flaeche(planMitAnschluss, boden),
    planVorbeiLinie: linie(planVorbei),
    jetztPunkt,
    marken,
    sonneGemessen,
    sonneErwartet,
    sonneSpitze,
    preis,
    preisMarken,
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
