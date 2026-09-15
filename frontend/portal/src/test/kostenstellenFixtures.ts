import type {
  KostenstelleDoppeltEnthalten,
  KostenstelleEnergie,
  KostenstelleEnergieBlock,
  KostenstelleEnergiePeriode,
  KostenstelleEnergiePosten,
  KostenstelleEnergieSumme,
  KostenstelleEnergieTag,
  MessstelleProzesse,
  MessstelleWerte,
  MessstelleWerteRaster,
} from '../api';
import { ende } from '../uebersichtBausteine';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { kostenstellenAhrenberg, prozesseAhrenberg } from './messstelleSeiteFixtures';

/**
 * Die Kostenstellen-Sicht des Referenzunternehmens Ahrenberg (UEMS AP-13 IP-9, Fall O9) — Antworten von
 * `GET …/kostenstellen/{id}/energie` und, für die Prozess-Summe, von `GET …/messstellen/{id}/prozesse` und
 * `GET …/messstellen/{kennzeichen}/werte`. Abgeschrieben aus `uems-referenzunternehmen.json` 1.4
 * (`beispielwerte.oktober_2026_kwh`, `kostenstellen_anteile`, `prozesse`) und `verteilung-vectors.json` (Regel
 * `doppelzaehlung` für 4100 im Oktober, F12 für den 15.01.2027). Die Fixture RECHNET NICHT: jede Block-Menge steht als
 * Zahl da, so wie die Route sie liefert (4100: 83 700 · 11 130 · 88 630 · Summe 183 460 — die Summe zählt MS-06, MS-07
 * und MS-11 doppelt, genau davor warnt die Route).
 *
 * Annahmen (nicht im Referenzunternehmen): `tage[]` trägt nur den Anteil je Tag, keine Tagesmengen; MS-04 (Speicher,
 * zwei Richtungen) fehlt im Block „nicht verteilt“; außerhalb von Oktober 2026 und dem 15.01.2027 antwortet die Sicht an
 * denselben Zuordnungen mit „keine Werte“.
 */

const REGISTER = ahrenbergRegister().register;

function ref(kz: string): KostenstelleEnergiePosten['messstelle'] {
  const z = REGISTER.find((r) => r.kennzeichen === kz);
  if (!z) throw new Error(`keine Messstelle ${kz} im Register`);
  return { id: z.id, kennzeichen: kz, name: z.name, art: z.art };
}

type Groesse = { groesse: string; richtung: string; einheit: string };
const BEZUG: Groesse = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh' };
const ABGABE: Groesse = { groesse: 'Wirkenergie', richtung: 'Abgabe', einheit: 'kWh' };
const ERZEUGUNG: Groesse = { groesse: 'Wirkenergie', richtung: 'Erzeugung', einheit: 'kWh' };
const GAS: Groesse = { groesse: 'Volumen', richtung: 'Bezug', einheit: 'm³' };

/** Ein Posten: Menge der Periode, Anteil je Tag ab `ab` (sonst ab Beginn), die Kennzeichen der Route. */
interface Def {
  kz: string;
  menge: number | null;
  anteil: number | null;
  woerter: string[];
  ab?: string;
  bis?: string;
  groesse?: Groesse;
}

const verteilt = (kz: string, anteil: number) => `verteilt (${anteil} % von ${kz})`;
const gemessen = (kz: string, menge: number | null, extra: Partial<Def> = {}): Def => ({ kz, menge, anteil: 100, woerter: [verteilt(kz, 100)], ...extra });

function tageVon(periode: KostenstelleEnergiePeriode, am: string, d: Def): KostenstelleEnergieTag[] {
  const out: KostenstelleEnergieTag[] = [];
  const bis = ende(periode, am);
  for (let t = new Date(`${am}T00:00:00Z`); ; t.setUTCDate(t.getUTCDate() + 1)) {
    const tag = t.toISOString().slice(0, 10);
    if (tag > bis) break;
    const gilt = d.anteil !== null && (!d.ab || tag >= d.ab) && (!d.bis || tag <= d.bis);
    out.push({ tag, anteil_prozent: gilt ? d.anteil : null, quelle_menge: null, menge: null, zustand: null, abdeckung_prozent: null, version: 1, grund: null, herkunft: null });
  }
  return out;
}

function posten(d: Def, periode: KostenstelleEnergiePeriode, am: string, mitWerten: boolean): KostenstelleEnergiePosten {
  const menge = mitWerten ? d.menge : null;
  return {
    messstelle: ref(d.kz),
    ...(d.groesse ?? BEZUG),
    menge,
    zustand: menge === null ? 'keine Werte' : 'vollständig',
    abdeckung_prozent: menge === null ? null : 100,
    version: 1,
    kennzeichen: d.woerter,
    fassungen: d.anteil === null ? [] : [1],
    fehlend: [],
    tage: tageVon(periode, am, d),
    herkunft: null,
  };
}

const summe = (g: Groesse, menge: number | null): KostenstelleEnergieSumme => ({
  ...g,
  menge,
  zustand: menge === null ? 'keine Werte' : 'vollständig',
  abdeckung_prozent: menge === null ? null : 100,
  vorhanden: menge === null ? 0 : 1,
  gesamt: 1,
  fehlend: [],
});

/** Ein Block ohne Posten: keine Menge, nie 0 (`KostenstelleEnergieApiTest.eineKostenstelleOhneZuordnungLiefertNullNichtNull`). */
const OHNE: KostenstelleEnergieBlock = { menge: null, einheit: null, zustand: null, grund: 'keine_zuordnung', summen: [], posten: [] };

/** `menge` = die Zahl der Route für EINE Größe; `summen` = je Größe eine Zahl (dann `groessen_gemischt`). */
type Menge = { menge: number } | { summen: Array<[Groesse, number]> };

/** Die Zahlen eines Blocks ohne Posten — so steht die Summe da. */
function mengen(menge: Menge | null, mitWerten: boolean): KostenstelleEnergieBlock {
  if (menge === null) return OHNE;
  if ('summen' in menge) {
    const summen = menge.summen.map(([g, m]) => summe(g, mitWerten ? m : null));
    return { menge: null, einheit: null, zustand: null, grund: 'groessen_gemischt', summen, posten: [] };
  }
  const m = mitWerten ? menge.menge : null;
  return { menge: m, einheit: 'kWh', zustand: m === null ? 'keine Werte' : 'vollständig', grund: null, summen: [summe(BEZUG, m)], posten: [] };
}

function block(
  defs: Def[],
  menge: Menge | null,
  periode: KostenstelleEnergiePeriode,
  am: string,
  mitWerten: boolean,
): KostenstelleEnergieBlock {
  if (defs.length === 0 || menge === null) return OHNE;
  return { ...mengen(menge, mitWerten), posten: defs.map((d) => posten(d, periode, am, mitWerten)) };
}

interface Karte {
  gemessen: [Def[], Menge | null];
  verteilt: [Def[], Menge | null];
  berechnet: [Def[], Menge | null];
  summe: Menge | null;
}

/** Die Zuordnungen je Kostenstelle (Oktober 2026 mit Mengen). */
const KARTEN: Record<string, Karte> = {
  '4100': {
    gemessen: [[gemessen('MS-06', 55100), gemessen('MS-08', 6200), gemessen('MS-11', 22400)], { menge: 83700 }],
    verteilt: [[{ kz: 'MS-07', menge: 11130, anteil: 70, woerter: [verteilt('MS-07', 70)] }], { menge: 11130 }],
    berechnet: [[{ kz: 'MS-20', menge: 88630, anteil: 100, woerter: [verteilt('MS-20', 100), 'berechnet (Summe)'] }], { menge: 88630 }],
    summe: { menge: 183460 },
  },
  '4200': {
    gemessen: [[gemessen('MS-12', 6100), gemessen('MS-18', 3600, { ab: '2026-10-15' })], { menge: 9700 }],
    verteilt: [[{ kz: 'MS-07', menge: 4770, anteil: 30, woerter: [verteilt('MS-07', 30)] }], { menge: 4770 }],
    berechnet: [[], null],
    summe: { menge: 14470 },
  },
  '4300': {
    gemessen: [[gemessen('MS-13', 3500), gemessen('MS-17', 4300, { ab: '2026-10-15' })], { menge: 7800 }],
    verteilt: [[], null],
    berechnet: [[{ kz: 'MS-15', menge: 3800, anteil: 100, woerter: [verteilt('MS-15', 100), 'berechnet (Differenz)'] }], { menge: 3800 }],
    summe: { menge: 11600 },
  },
  '9000': {
    gemessen: [[], null],
    verteilt: [[], null],
    berechnet: [
      [{ kz: 'MS-09', menge: 54580, anteil: 100, bis: '2026-12-31', woerter: [verteilt('MS-09', 100), 'berechnet (Differenz)'] }],
      { menge: 54580 },
    ],
    summe: { menge: 54580 },
  },
  '9100': {
    gemessen: [
      [gemessen('MS-05', 7600), gemessen('MS-14', 1100), gemessen('MS-21', 1240, { groesse: GAS })],
      { summen: [[BEZUG, 8700], [GAS, 1240]] },
    ],
    verteilt: [[], null],
    berechnet: [[], null],
    summe: { summen: [[BEZUG, 8700], [GAS, 1240]] },
  },
};

const OKTOBER = { periode: 'monat', am: '2026-10-01' } as const;
export const F12_TAG = '2027-01-15';

/** „Nicht verteilt“ im Oktober 2026: Werte ohne Verteilungszeile — Hauptzähler, Erzeuger, Summen des Unternehmens. */
const NICHT_VERTEILT_OKTOBER: [Def[], Menge] = [
  [
    { kz: 'MS-01', menge: 128400, anteil: null, woerter: ['nicht verteilt'] },
    { kz: 'MS-02', menge: 3120, anteil: null, woerter: ['nicht verteilt'], groesse: ABGABE },
    { kz: 'MS-03', menge: 14900, anteil: null, woerter: ['nicht verteilt'], groesse: ERZEUGUNG },
    { kz: 'MS-10', menge: 36900, anteil: null, woerter: ['nicht verteilt'] },
    { kz: 'MS-16', menge: 9100, anteil: null, woerter: ['nicht verteilt'] },
    { kz: 'MS-19', menge: 174400, anteil: null, woerter: ['nicht verteilt'] },
    { kz: 'MS-22', menge: 1200, anteil: null, woerter: ['nicht verteilt'] },
  ],
  { summen: [[BEZUG, 350000], [ABGABE, 3120], [ERZEUGUNG, 14900]] },
];

/** F12 am 15.01.2027: MS-03 bleibt „nicht verteilt“ — nie still auf 9010/9020 (`verteilung-vectors.json`). */
const NICHT_VERTEILT_F12: [Def[], Menge] = [[{ kz: 'MS-03', menge: 480, anteil: null, woerter: ['nicht verteilt'], groesse: ERZEUGUNG }], { menge: 480 }];

const LEER_OFFEN: KostenstelleEnergieBlock = { menge: null, einheit: null, zustand: null, grund: null, summen: [], posten: [] };

function doppelt4100(von: string, bis: string): KostenstelleDoppeltEnthalten[] {
  return ['MS-06', 'MS-07', 'MS-11'].map((teil) => ({
    teil,
    summe: 'MS-20',
    umfang: 'ganz',
    kette: ['MS-20', teil],
    zeitraeume: [{ von, bis }],
    satz: `${teil} ist bereits in MS-20 enthalten`,
  }));
}

const naechsterTag = (t: string): string => {
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Die Antwort der Kostenstellen-Sicht für eine Kostenstelle des Referenzunternehmens. Mengen nur im Oktober 2026 (und
 * „nicht verteilt“ am 15.01.2027); 9010/9020 haben keine Zuordnung. Unbekannte Kostenstelle: ein Fehler wie die 404.
 */
export function ahrenbergKostenstelleEnergie(id: string, periode: KostenstelleEnergiePeriode, am: string): KostenstelleEnergie {
  const k = kostenstellenAhrenberg().find((x) => x.id === id);
  if (!k) throw new Error('Diese Kostenstelle gibt es nicht.');
  const bis = ende(periode, am);
  const mitWerten = periode === OKTOBER.periode && am === OKTOBER.am;
  const karte = KARTEN[k.kennzeichen];
  const b = (x: [Def[], Menge | null]) => (karte ? block(x[0], x[1], periode, am, mitWerten) : OHNE);
  const nv = mitWerten ? NICHT_VERTEILT_OKTOBER : am === F12_TAG && periode === 'tag' ? NICHT_VERTEILT_F12 : null;
  return {
    kostenstelle: { id: k.id, kennzeichen: k.kennzeichen, name: k.name, gueltig_ab: k.gueltig_ab, gueltig_bis: k.gueltig_bis },
    periode,
    am,
    von: am,
    bis,
    zeitzone: 'Europe/Berlin',
    version: null,
    berechnet_am: `${naechsterTag(bis)}T00:15:00+01:00`,
    gemessen: b(karte?.gemessen ?? [[], null]),
    verteilt: b(karte?.verteilt ?? [[], null]),
    berechnet: b(karte?.berechnet ?? [[], null]),
    summe: karte ? mengen(karte.summe, mitWerten) : OHNE,
    nicht_verteilt: nv ? block(nv[0], nv[1], periode, am, true) : LEER_OFFEN,
    doppelzaehlung: { enthalten: mitWerten && k.kennzeichen === '4100' ? doppelt4100(am, bis) : [], nicht_pruefbar: [] },
  };
}

/** Die Prozesse der berechneten Messstellen: nur MS-20 „Prozess Spritzguss gesamt“ gehört zu P-1 (seit 01.10.2026). */
export function ahrenbergMessstelleProzesse(id: string): MessstelleProzesse {
  const z = REGISTER.find((r) => r.id === id);
  const p1 = prozesseAhrenberg()[0];
  return {
    messstelle_id: id,
    kennzeichen: z?.kennzeichen ?? '',
    am: null,
    prozesse:
      z?.kennzeichen === 'MS-20'
        ? [
            {
              id: 'd0000000-0000-4000-8000-000000000020',
              prozess: { id: p1.id, kennzeichen: p1.kennzeichen },
              name: p1.name,
              gueltig_ab: '2026-10-01',
              gueltig_bis: null,
              endet_mit_prozess: false,
            },
          ]
        : [],
  };
}

/** Der Wert einer Prozess-Summe: MS-20 im Oktober 2026 = 88 630 kWh (`beispielwerte`), sonst „keine Werte“. */
export function ahrenbergProzessSummeWerte(kennzeichen: string, raster: MessstelleWerteRaster, von: string, bis: string): MessstelleWerte {
  const z = REGISTER.find((r) => r.kennzeichen === kennzeichen);
  const menge = kennzeichen === 'MS-20' && raster === 'monat' && von === OKTOBER.am ? 88630 : null;
  return {
    messstelle: {
      id: z?.id ?? kennzeichen,
      kennzeichen,
      name: z?.name ?? null,
      art: z?.art ?? 'berechnet',
      groesse: 'Wirkenergie',
      richtung: 'Bezug',
      einheit: 'kWh',
      wertart: 'Intervallmenge',
    },
    raster,
    von,
    bis,
    zeitzone: 'Europe/Berlin',
    zeitzone_herkunft: 'unternehmen',
    version: menge === null ? null : 1,
    quellen: [],
    werte: [
      {
        von,
        bis,
        beschriftung: null,
        stunden: null,
        tagesdauer: null,
        menge,
        mittel: null,
        min: null,
        max: null,
        zustand: menge === null ? 'keine Werte' : 'vollständig',
        kennzeichen: menge === null ? [] : ['berechnet (Summe)'],
        erhalten: null,
        erwartet: null,
        abdeckung_prozent: menge === null ? null : 100,
        fassung: menge === null ? null : 'endgueltig',
        endgueltig_ab: null,
        version: menge === null ? null : 1,
        gebildet_aus: menge === null ? null : 'tag',
        quelle: null,
        grund: menge === null ? 'noch_nicht_gebildet' : null,
        ereignisse: [],
        herkunft: null,
        versionen: menge === null ? null : 1,
      },
    ],
  };
}
