import { request } from './api';
import { NBSP } from './format';
import { grundText } from './mispelMengen';

/**
 * Die Pauschaloption der MiSpeL-Festlegung im Portal (MP-27, Bedienkonzept BK-27 Variante A „Jahresband“): Anlage 2,
 * Formelsätze P1–P3, Begriffe und Formelnummern wie dort. Die Zahlen des Jahresstands kommen nur aus dem
 * gespeicherten Jahreslauf des Rechenwerks (MP-25) über `GET …/mispel/pauschal/jahre/{jahr}`; die Pauschalgrenzen der
 * Einrichtung rechnet das Portal aus dem Aufbau nach denselben Formeln (A2 S. 28–30, S. 54–55) — geprüft gegen
 * `docs/contracts/v2/mispel-pauschal-vectors.json`. Unbekannt ist keine Null: fehlt ein Wert, steht „offen“.
 */

/** Ein (Rumpf-)Jahr des Jahreslaufs, je Zeitraum die jüngste Fassung (Vertrag mispel-pauschal.md „Jahresstand“). */
export interface PauschalStand {
  tag_von: string;
  tag_bis: string;
  rumpfjahr: boolean;
  fassung: number;
  formelsatz: string;
  basisfall: string | null;
  stand: 'vorlaeufig' | 'endgueltig' | string;
  stand_gruende: string[];
  wertequelle: string | null;
  viertelstunden_erwartet: number;
  viertelstunden_gerechnet: number;
  gerechnet_am: string;
  stammdaten: Record<string, number | null>;
  jahreswerte: Record<string, number | null>;
}

export interface PauschalJahr {
  site_id: string;
  jahr: number;
  anwendbar_ab: string | null;
  staende: PauschalStand[];
  /** Schätzung bis Jahresende — erst mit Jahresprofil; bis dahin immer `null` (kein Hochrechnen mit dem Tempo). */
  schaetzung: null;
}

export const mispelPauschalApi = {
  jahr: (siteId: string, jahr: number) =>
    request<PauschalJahr>(`/api/v1/sites/${encodeURIComponent(siteId)}/mispel/pauschal/jahre/${jahr}`),
};

// ---------------------------------------------------------------------------
// Pauschalgrenzen (A2 Abschn. 4.2.1, S. 28–30) und Rumpfjahr (A2 Abschn. 5, S. 51–55)
// ---------------------------------------------------------------------------

/** (P1) = Pinst • 500 kWh/kWp (A2 S. 28). */
export const KWH_JE_KWP = 500;
/** (P17): Tage der Sommerperiode 1. April bis 30. September (A2 S. 54). */
export const TAGE_SOMMERPERIODE = 183;
/** Höchstgrenze der installierten Solarleistung ohne Steckersolargeräte (Voraussetzung 3, A2 S. 19). */
export const GRENZE_KWP = 30;

export type Fallkonstellation = 'P1' | 'P2' | 'P3';

export const FALL_BEGRIFF: Record<Fallkonstellation, string> = {
  P1: 'Stromspeicher',
  P2: 'Ladepunkt',
  P3: 'Stromspeicher und Ladepunkt',
};

export interface Pauschalgrenzen {
  fall: Fallkonstellation;
  pinst: number;
  skinst: number | null;
  p1: number;
  /** Die Rechengröße des Falls: (P2)P1, (P2)P2 oder (P2)P3. */
  p2: number;
  p2Name: '(P2)P1' | '(P2)P2' | '(P2)P3';
  p3: number;
  p4: number;
}

/**
 * Die Pauschalgrenzen eines Kalenderjahres: (P1) = Pinst • 500; (P2)P1 = 0,1 • Pinst / SKinst; (P2)P2 = 0,2;
 * (P2)P3 = MIN [ (P2)P1 ; (P2)P2 ]; (P3) = (P2) • (P1); (P4) = (P1) + (P3) (A2 S. 28–30). `null`, wenn eine Angabe
 * fehlt — Pinst unbekannt oder im Fall P1/P3 keine Speicherkapazität.
 */
export function pauschalgrenzen(fall: Fallkonstellation, pinst: number | null, skinst: number | null): Pauschalgrenzen | null {
  if (pinst == null || !(pinst > 0)) return null;
  const p1 = pinst * KWH_JE_KWP;
  let p2: number;
  let p2Name: Pauschalgrenzen['p2Name'];
  if (fall === 'P2') {
    p2 = 0.2;
    p2Name = '(P2)P2';
  } else {
    if (skinst == null || !(skinst > 0)) return null;
    const p2p1 = (0.1 * pinst) / skinst;
    p2 = fall === 'P3' ? Math.min(p2p1, 0.2) : p2p1;
    p2Name = fall === 'P3' ? '(P2)P3' : '(P2)P1';
  }
  const p3 = p2 * p1;
  return { fall, pinst, skinst, p1, p2, p2Name, p3, p4: p1 + p3 };
}

function tageZwischen(von: string, bis: string): number {
  return Math.round((Date.parse(`${bis}T00:00:00Z`) - Date.parse(`${von}T00:00:00Z`)) / 86_400_000) + 1;
}

/** ANZAHL [ TRS ]: Tage des Rumpfjahres in der Sommerperiode 1. April bis 30. September, beide Tage eingeschlossen. */
export function sommertage(von: string, bis: string): number {
  const jahr = von.slice(0, 4);
  const a = von > `${jahr}-04-01` ? von : `${jahr}-04-01`;
  const b = bis < `${jahr}-09-30` ? bis : `${jahr}-09-30`;
  return a > b ? 0 : tageZwischen(a, b);
}

export interface RumpfjahrGrenzen {
  von: string;
  bis: string;
  tage: number;
  sommer: number;
  p1r: number;
  p3r: number;
  p4r: number;
}

/**
 * Die Grenzen im Rumpfjahr (A2 S. 54–55): (P1)R = (P19)R • (P1) / (P17) mit (P19)R = Sommertage des Rumpfjahres;
 * (P3)R = (P22)R • (P3) / (P20) mit (P22)R = Tage des Rumpfjahres und (P20) = Tage des Kalenderjahres;
 * (P4)R = (P1)R + (P3)R.
 */
export function rumpfjahrGrenzen(von: string, bis: string, g: Pick<Pauschalgrenzen, 'p1' | 'p3'>): RumpfjahrGrenzen {
  const jahr = Number(von.slice(0, 4));
  const jahrestage = tageZwischen(`${jahr}-01-01`, `${jahr}-12-31`);
  const tage = tageZwischen(von, bis);
  const sommer = sommertage(von, bis);
  const p1r = (sommer * g.p1) / TAGE_SOMMERPERIODE;
  const p3r = (tage * g.p3) / jahrestage;
  return { von, bis, tage, sommer, p1r, p3r, p4r: p1r + p3r };
}

// ---------------------------------------------------------------------------
// Jahresstand (A2 Abschn. 2.1, Abb. 1: eine Einspeisung, drei Bereiche)
// ---------------------------------------------------------------------------

export type Bereich = 'foerderfaehig' | 'indifferent' | 'saldierungsfaehig';

export const BEREICH_WORT: Record<Bereich, string> = {
  foerderfaehig: 'förderfähig',
  indifferent: 'indifferent',
  saldierungsfaehig: 'saldierungsfähig',
};

export interface Jahresstand {
  zeitraum: PauschalStand;
  /** (P1) bzw. im Rumpfjahr (P1)R — bis hier förderfähig. */
  foerdergrenze: number;
  foerderName: '(P1)' | '(P1)R';
  /** (P4) bzw. (P4)R — darüber saldierungsfähig. */
  saldogrenze: number;
  saldoName: '(P4)' | '(P4)R';
  indifferenzName: '(P3)' | '(P3)R';
  /** (P14) Netzeinspeisung in Viertelstunden mit AW¼ > 0 · (P15) förderfähige Netzeinspeisung. */
  p14: number | null;
  p15: number | null;
  /** (P7) Netzeinspeisung bei SP¼ ≥ 0 · (P8) über (P4) · (P9) Netzbezug · (P10) saldierungsfähig · (P11) umlagebelastet. */
  p7: number | null;
  p8: number | null;
  p9: number | null;
  p10: number | null;
  p11: number | null;
  /** Wo das Jahr steht; `null`, wenn ein nötiger Wert fehlt. */
  bereich: Bereich | null;
  /** Strich „heute“ im Band, kWh; `null` = offen. */
  marke: number | null;
  /** Im Indifferenzbereich: kWh zwischen (P1) und dem Stand. */
  indifferent: number | null;
}

/** Der Zeitraum, der das Kalenderjahr heute trägt: der mit `heute` darin, sonst der jüngste. */
export function aktuellerZeitraum(staende: PauschalStand[], heute: string): PauschalStand | null {
  if (staende.length === 0) return null;
  return staende.find((s) => s.tag_von <= heute && heute <= s.tag_bis) ?? staende[staende.length - 1];
}

function wert(s: PauschalStand, name: string): number | null {
  const v = s.jahreswerte[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Wo das Jahr steht. Lesart (Vertrag mispel-pauschal.md „Jahresstand“): förderfähig zählt die Netzeinspeisung in
 * AW>0-Zeiten bis (P1) — (P15) = MIN [ (P14) ; (P1) ]; saldierungsfähig zählt die Netzeinspeisung bei nicht negativem
 * Preis über (P4) — (P8) = MAX [ 0 ; (P7) − (P4) ] (A2 S. 30–33). Darum steht der Strich im förderfähigen Bereich bei
 * (P14), danach bei (P7); dazwischen liegt der Indifferenzbereich (P3).
 */
export function jahresstand(s: PauschalStand): Jahresstand {
  const r = s.rumpfjahr;
  const foerdergrenze = wert(s, r ? '(P1)R' : '(P1)') ?? wert(s, '(P1)');
  const saldogrenze = wert(s, r ? '(P4)R' : '(P4)') ?? wert(s, '(P4)');
  const p14 = wert(s, '(P14)');
  const p7 = wert(s, '(P7)');
  let bereich: Bereich | null = null;
  let marke: number | null = null;
  let indifferent: number | null = null;
  if (foerdergrenze != null && saldogrenze != null && p14 != null) {
    if (p14 < foerdergrenze) {
      bereich = 'foerderfaehig';
      marke = p14;
    } else if (p7 != null && p7 < saldogrenze) {
      bereich = 'indifferent';
      marke = Math.max(foerdergrenze, p7);
      indifferent = marke - foerdergrenze;
    } else if (p7 != null) {
      bereich = 'saldierungsfaehig';
      marke = p7;
      indifferent = saldogrenze - foerdergrenze;
    }
  }
  return {
    zeitraum: s,
    foerdergrenze: foerdergrenze ?? NaN,
    foerderName: r ? '(P1)R' : '(P1)',
    saldogrenze: saldogrenze ?? NaN,
    saldoName: r ? '(P4)R' : '(P4)',
    indifferenzName: r ? '(P3)R' : '(P3)',
    p14,
    p15: wert(s, '(P15)'),
    p7,
    p8: wert(s, '(P8)'),
    p9: wert(s, '(P9)'),
    p10: wert(s, '(P10)'),
    p11: wert(s, '(P11)'),
    bereich,
    marke,
    indifferent,
  };
}

/**
 * Die Geometrie des Bands in Prozent: die drei Bereiche der Anlage 2 bis zum rechten Rand. Der Rand liegt hinter
 * (P4) und hinter dem Stand, damit der saldierungsfähige Bereich sichtbar bleibt.
 */
export function bandGeometrie(j: Pick<Jahresstand, 'foerdergrenze' | 'saldogrenze' | 'marke'>): {
  foerder: number;
  indifferent: number;
  saldo: number;
  marke: number | null;
  ende: number;
} {
  // Rand wie im Bild der BNetzA (A2 Abb. 1): Platz hinter (P4) für den saldierungsfähigen Bereich und seine Beschriftung.
  const ende = Math.max(j.saldogrenze * 1.28, (j.marke ?? 0) * 1.05);
  const pct = (v: number) => Math.min(100, Math.max(0, (v / ende) * 100));
  const foerder = pct(j.foerdergrenze);
  const indiff = pct(j.saldogrenze) - foerder;
  return {
    foerder,
    indifferent: Math.max(indiff, 0),
    saldo: Math.max(100 - foerder - indiff, 0),
    marke: j.marke == null ? null : pct(j.marke),
    ende,
  };
}

/** „5.000“ — ganze kWh, Tausenderpunkt; Bruchteile nur, wo der Wert sie braucht (Rechengröße). */
export function zahl(v: number, nachkomma = 0): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
}

export function kwh(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'offen' : `${zahl(Math.round(v))}${NBSP}kWh`;
}

/** Der Satz „was die nächste kWh bekommt“ je Bereich (A2 S. 9–11). */
export function naechsteKwh(j: Jahresstand): { titel: string; satz: string } | null {
  if (j.bereich === 'foerderfaehig') {
    return {
      titel: 'Die nächste eingespeiste kWh bekommt die Marktprämie',
      satz: '— außer in Viertelstunden ohne anzulegenden Wert, etwa bei negativem Preis.',
    };
  }
  if (j.bereich === 'indifferent' && j.marke != null) {
    return {
      titel: `Die nächsten ${kwh(j.saldogrenze - j.marke)} bringen nur den Marktwert`,
      satz: '— keine Marktprämie, keine Saldierung. VoltPilot hält den Speicherstrom deshalb eher für den Abend im Haus.',
    };
  }
  if (j.bereich === 'saldierungsfaehig') {
    if (j.p9 != null && j.p10 != null && j.p10 >= j.p9) {
      return {
        titel: 'Ihr Netzbezug ist ausgeschöpft',
        satz: '— saldiert wird höchstens so viel, wie Sie im Jahr aus dem Netz beziehen (P9); weitere kWh bringen nur den Marktwert.',
      };
    }
    return {
      titel: 'Jede weitere kWh senkt die Umlagen auf Ihren Netzbezug',
      satz: '— bei nicht negativem Preis, höchstens bis zu Ihrem Netzbezug im Jahr (P9).',
    };
  }
  return null;
}

/** Der Stand als Chip — vorläufig mit dem ersten Grund in Kundendeutsch, endgültig mit Quelle. */
export function standChip(s: PauschalStand): { text: string; ton: 'ok' | 'gelb' } {
  if (s.stand === 'endgueltig') return { text: 'endgültig · Messstellenbetreiber', ton: 'ok' };
  const grund = s.stand_gruende[0];
  const wort = grund === 'eu_genehmigung_ausstehend' ? 'EU-Genehmigung ausstehend' : grund ? pauschalGrund(grund) : null;
  return { text: wort ? `vorläufig · ${wort}` : 'vorläufig', ton: 'gelb' };
}

export function pauschalGrund(code: string): string {
  switch (code.split(':')[0]) {
    case 'eu_genehmigung_ausstehend':
      return 'Pauschaloption noch nicht anwendbar (EU-Genehmigung ausstehend)';
    case 'aw_regel_fehlt':
      return 'Prämien-Viertelstunden noch nicht eingetragen';
    case 'zeitraum_offen':
      return 'das Jahr läuft noch';
    default:
      return grundText(code);
  }
}

/** „01.03.2027“ */
export function tag(iso: string): string {
  const [j, m, t] = iso.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}
