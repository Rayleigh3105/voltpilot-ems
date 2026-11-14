/**
 * Gestellte Antworten für den Anlagen-Check (Bedienkonzept vp-privatkunde-bedienkonzept §6, BK-4/BK-5/BK-7 = A) -
 * fiktiv, nur für Bühnen (`cockpit-privat`, `unterverteilung`). Die Urteile hier sind ausgedacht, nicht gerechnet:
 * gerechnet wird auf dem Server (`AnlagenCheckRegel`, Vektoren `anlagencheck/regel-vektoren.json`).
 *
 * `?solar=` gut | warn | eine | sonne | fehlt | abgeregelt | frueh | aus (Standard: keine Antwort = keine Kachel)
 * `?einheiten=wr` nennt die Einheiten wie die Wechselrichter einer Beobachtungs-Anlage (Kaco 1–3, PIKO), sonst
 * Dach Scheune · Dach Wohnhaus · Carport. `?bilanz=` normal | wenig | ohnekap | schlecht | aus.
 */
import type { AnlagenCheck, AnlagenCheckEinheit, AnlagenCheckGesamt, AnlagenCheckZeitraum, SpeicherBilanz } from '../src/api';
import { anlagenCheckApi } from '../src/anlagenCheckApi';

type Fall = 'gut' | 'warn' | 'eine' | 'sonne' | 'fehlt' | 'abgeregelt' | 'frueh';
type Bilanz = 'normal' | 'wenig' | 'ohnekap' | 'schlecht';

interface Einheit {
  id: string;
  name: string;
  /** erwartete kWh an einem mittleren Tag */
  erwartet: number;
}

const WR: Einheit[] = [
  { id: 'e-kaco1', name: 'Kaco 1', erwartet: 52 },
  { id: 'e-kaco2', name: 'Kaco 2', erwartet: 52 },
  { id: 'e-kaco3', name: 'Kaco 3', erwartet: 36 },
  { id: 'e-piko', name: 'PIKO', erwartet: 52 },
];
const DAECHER: Einheit[] = [
  { id: 'e-scheune', name: 'Dach Scheune', erwartet: 22 },
  { id: 'e-wohnhaus', name: 'Dach Wohnhaus', erwartet: 11 },
  { id: 'e-carport', name: 'Carport', erwartet: 4.4 },
];

const ISO = (d: Date) => d.toISOString().slice(0, 10);
const plus = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ISO(d);
};
/** Der Berliner Tag einer Uhrzeit (Bühnen laufen mit fester Uhr). */
const berlinTag = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);

/** Wetter des Tages (0,4…1,1) - fest, damit die Säulen stehen wie im Bild. */
const WETTER = [0.78, 0.82, 1.0, 0.98, 0.8, 1.04, 0.56];
const wetter = (iso: string) => WETTER[new Date(`${iso}T12:00:00Z`).getUTCDay()];

/** Verhältnis gemessen/erwartet je Einheit und Tag im Fall. */
function verhaeltnis(fall: Fall, i: number, n: number, tagIndex: number): number | null {
  const basis = [1.01, 0.98, 0.99, 1.0][i % 4];
  // Die abfallende Einheit: bei vier Wechselrichtern Kaco 3, sonst die letzte (Carport).
  const letzte = n === 4 ? i === 2 : i === n - 1;
  if (fall === 'warn' && letzte) return tagIndex >= 2 ? 0.68 : 0.97; // ab dem dritten Tag weniger
  if (fall === 'fehlt' && letzte && tagIndex >= 1) return null; // keine Werte mehr
  return basis;
}

function zeitraumFenster(z: AnlagenCheckZeitraum['z'], at: string): { von: string; bis: string } {
  const d = new Date(`${at}T12:00:00Z`);
  if (z === 'tag') return { von: at, bis: at };
  if (z === 'woche') {
    const wd = (d.getUTCDay() + 6) % 7;
    const von = plus(at, -wd);
    return { von, bis: plus(von, 6) };
  }
  if (z === 'monat') {
    const von = `${at.slice(0, 7)}-01`;
    const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return { von, bis: plus(von, n - 1) };
  }
  return { von: `${at.slice(0, 4)}-01-01`, bis: `${at.slice(0, 4)}-12-31` };
}

function gesamtVon(fall: Fall): AnlagenCheckGesamt {
  return fall === 'warn' ? 'weniger' : fall === 'fehlt' ? 'messwerte_fehlen' : fall === 'sonne' ? 'zu_wenig_sonne'
    : fall === 'frueh' ? 'noch_zu_frueh' : 'wie_erwartet';
}

/** Die Antwort des Anlagen-Checks für einen Fall. */
export function anlagenCheckFixture(fall: Fall, namen: 'wr' | 'daecher', z: AnlagenCheckZeitraum['z'] | undefined, at: string | undefined, jetzt: Date): AnlagenCheck {
  const ganze = fall === 'eine';
  const einheiten: Einheit[] = ganze ? [{ id: 'anlage', name: 'Ganze Anlage', erwartet: 18 }] : namen === 'wr' ? WR : DAECHER;
  const heute = berlinTag(jetzt);
  const gestern = plus(heute, -1);
  const fensterTage = ganze ? 14 : fall === 'sonne' ? 14 : 7;
  const kVon = plus(gestern, -(fensterTage - 1));
  const gesamt = gesamtVon(fall);
  const ohneUrteil = fall === 'sonne' || fall === 'frueh';

  const zeile = (e: Einheit, i: number, von: string, bis: string, gewertet: boolean): AnlagenCheckEinheit => {
    let gem = 0;
    let erw = 0;
    let keineWerteSeit: string | null = null;
    let wenigerSeit: string | null = null;
    let tage = 0;
    for (let d = von, k = 0; d <= bis; d = plus(d, 1), k += 1) {
      const e1 = e.erwartet * wetter(d) * (fall === 'sonne' ? 0.25 : 1);
      const v = verhaeltnis(fall, i, einheiten.length, k);
      erw += e1;
      if (v == null) {
        keineWerteSeit ??= d;
        continue;
      }
      if (fall === 'warn' && v < 0.8) wenigerSeit ??= d;
      gem += e1 * v;
      tage += 1;
    }
    const istWarn = fall === 'warn' && (einheiten.length === 4 ? i === 2 : i === einheiten.length - 1);
    const fehlt = fall === 'fehlt' && keineWerteSeit != null;
    return {
      id: e.id,
      name: e.name,
      gemessenKwh: Math.round(gem * 10) / 10,
      erwartetKwh: Math.round(erw * 10) / 10,
      verhaeltnis: ohneUrteil || fehlt || !gewertet ? null : Math.round((gem / erw) * 100) / 100,
      zustand: !gewertet ? 'offen' : fehlt ? 'fehlt' : ohneUrteil ? 'offen' : istWarn ? 'weniger' : 'wie_erwartet',
      keineWerteSeit: fehlt ? keineWerteSeit : null,
      wenigerSeit: istWarn ? wenigerSeit : null,
      gewerteteTage: tage,
    };
  };

  let zeitraum: AnlagenCheckZeitraum | null = null;
  if (z && at) {
    const { von, bis } = zeitraumFenster(z, at);
    const abgeschlossen = bis < gestern ? bis : gestern;
    if (abgeschlossen < von) {
      zeitraum = { z, von, bis, bisAbgeschlossen: null, gemessenKwh: null, erwartetKwh: null, gesamt: null, sonnenTage: 0, abgeregelteTage: 0,
        einheiten: einheiten.map((e) => ({ id: e.id, name: e.name, gemessenKwh: null, erwartetKwh: null, verhaeltnis: null, zustand: 'offen', keineWerteSeit: null, wenigerSeit: null, gewerteteTage: 0 })),
        eimer: z === 'jahr' ? 'monat' : 'tag', saeulen: [] };
    } else {
      const zeilen = einheiten.map((e, i) => zeile(e, i, von, abgeschlossen, z !== 'tag'));
      const saeulen: AnlagenCheckZeitraum['saeulen'] = [];
      for (let d = von, k = 0; d <= abgeschlossen; d = plus(d, 1), k += 1) {
        const key = z === 'jahr' ? `${d.slice(0, 7)}-01` : d;
        let s = saeulen.find((x) => x.start === key);
        if (!s) {
          s = { start: key, kwh: einheiten.map(() => null) };
          saeulen.push(s);
        }
        einheiten.forEach((e, i) => {
          const v = verhaeltnis(fall, i, einheiten.length, k);
          if (v == null) return;
          s!.kwh[i] = Math.round(((s!.kwh[i] ?? 0) + e.erwartet * wetter(d) * v) * 10) / 10;
        });
      }
      zeitraum = {
        z, von, bis, bisAbgeschlossen: abgeschlossen,
        gemessenKwh: Math.round(zeilen.reduce((a, x) => a + (x.gemessenKwh ?? 0), 0) * 10) / 10,
        erwartetKwh: Math.round(zeilen.reduce((a, x) => a + (x.erwartetKwh ?? 0), 0) * 10) / 10,
        gesamt: z === 'tag' ? null : gesamt,
        sonnenTage: fall === 'abgeregelt' ? 5 : 7,
        abgeregelteTage: fall === 'abgeregelt' ? 2 : 0,
        einheiten: zeilen,
        eimer: z === 'jahr' ? 'monat' : 'tag',
        saeulen,
      };
    }
  }

  return {
    pv: true,
    modus: ganze ? 'ganze_anlage' : 'einheiten',
    kachel: {
      gesamt,
      von: kVon,
      bis: gestern,
      fensterTage,
      sonnenTage: fall === 'sonne' ? 2 : fall === 'frueh' ? 1 : fall === 'abgeregelt' ? 5 : fensterTage,
      abgeregelteTage: fall === 'abgeregelt' ? 2 : 0,
      einheiten: einheiten.map((e, i) => zeile(e, i, kVon, gestern, true)),
    },
    zeitraum,
    ohneGeraet: [],
  };
}

/** Die Speicher-Bilanz für einen Fall (Zahlen aus den Bildern des Konzepts). */
export function speicherBilanzFixture(fall: Bilanz, jetzt: Date): SpeicherBilanz {
  const heute = berlinTag(jetzt);
  const monate = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(`${heute.slice(0, 7)}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 12 + i);
    const wg = [0.9, 0.91, 0.92, 0.91, 0.9, 0.91, 0.92, 0.92, 0.91, 0.9, 0.91, 0.91][i];
    return { monat: ISO(d).slice(0, 7), hineinKwh: 210 + i * 3, herausKwh: Math.round((210 + i * 3) * wg), wirkungsgrad: wg, vollzyklen: fall === 'ohnekap' ? null : 19 + (i % 3) };
  });
  const basis: SpeicherBilanz = {
    zustand: 'normal', von: plus(heute, -30), bis: plus(heute, -1), fensterTage: 30, tageMitDaten: 30,
    hineinKwh: 212.4, herausKwh: 193.1, ausgleichKwh: 0.4, wirkungsgrad: 0.911, verlustKwh: 18.9,
    vollzyklen: 19.3, vollzyklenSeitBeginn: 412.2, kapazitaetKwh: 10, vergleichMin: 0.9, vergleichMax: 0.92,
    vergleichMonate: 12, satz: 'unauffaellig', monate,
  };
  if (fall === 'wenig') {
    return { ...basis, zustand: 'wenig', hineinKwh: 14.2, herausKwh: 9.8, wirkungsgrad: null, verlustKwh: null, vollzyklen: 1, vollzyklenSeitBeginn: 1, satz: null, vergleichMin: null, vergleichMax: null, vergleichMonate: 0, monate: [] };
  }
  if (fall === 'ohnekap') {
    return { ...basis, fensterTage: 90, von: plus(heute, -90), kapazitaetKwh: null, vollzyklen: null, vollzyklenSeitBeginn: null, ausgleichKwh: null };
  }
  if (fall === 'schlecht') {
    return { ...basis, hineinKwh: 204.3, herausKwh: 159.2, wirkungsgrad: 0.78, verlustKwh: 45.1, vollzyklen: 15.9, vollzyklenSeitBeginn: 428.3, satz: 'niedriger' };
  }
  return basis;
}

/** Hängt die gestellten Antworten an `anlagenCheckApi`, wenn die Adresse einen Fall nennt. */
export function installAnlagenCheck(): void {
  const api = anlagenCheckApi as unknown as Record<string, unknown>;
  const q = new URLSearchParams(location.search);
  const solar = q.get('solar');
  const namen = q.get('einheiten') === 'wr' ? 'wr' : 'daecher';
  const faelle: Fall[] = ['gut', 'warn', 'eine', 'sonne', 'fehlt', 'abgeregelt', 'frueh'];
  if (solar && (faelle as string[]).includes(solar)) {
    api.anlagenCheck = async (_site: string, z?: AnlagenCheckZeitraum['z'], at?: string) =>
      anlagenCheckFixture(solar as Fall, namen, z, at, new Date());
  } else if (solar === 'aus') {
    api.anlagenCheck = async () => ({ pv: false, modus: 'ganze_anlage', kachel: null, zeitraum: null, ohneGeraet: [] });
  }
  const bilanz = q.get('bilanz');
  if (bilanz && ['normal', 'wenig', 'ohnekap', 'schlecht'].includes(bilanz)) {
    api.speicherBilanz = async () => speicherBilanzFixture(bilanz as Bilanz, new Date());
  }
}
