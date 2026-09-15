import type { Bilanz, BilanzEingang, BilanzSumme } from '../api';
import faelle from './oberflaechenFaelle.json';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Energiebilanz je Anlage des Referenzunternehmens Ahrenberg — Antworten von `GET /api/v1/sites/{id}/bilanz` in
 * der Form der Route (AP-10 IP-9) für die Bühne und die Übersichts-Tests (UEMS AP-13 IP-7).
 *
 * Die Zahlen stammen allein aus den Referenzfällen (`oberflaechenFaelle.json`, Kopie von `referenzfaelle.json`):
 * O2 — Oktober 2026, Netzbezug der drei Hauptzähler; O4 — Halle 2 im Oktober (Unterzähler und Rest); O3 — Werk Lindach
 * am 18.10.2026. Die Terme je Anlage sind die Stellung des Registers, soweit ein Fall ihre Werte nennt (Halle 1 trägt
 * darum nur ihren Hauptzähler). Jeder andere Zeitraum antwortet mit denselben Termen OHNE Werte — erfunden wird keine Zahl.
 */

type Rolle = BilanzEingang['rolle'];
type Periode = Bilanz['periode'];
type Gegeben = Record<string, unknown>;

const gegeben = (id: string): Gegeben => {
  const f = (faelle as unknown as { faelle: { id: string; gegeben: Gegeben }[] }).faelle.find((x) => x.id === id);
  if (!f) throw new Error(`Referenzfall ${id} fehlt`);
  return f.gegeben;
};
/** „AN-1 (MS-01)“ → MS-01. */
const kennzeichenAus = (schluessel: string) => /(MS-\d+)/.exec(schluessel)?.[1] ?? schluessel;
const jeMessstelle = (werte: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(werte as Record<string, number>).map(([k, v]) => [kennzeichenAus(k), v]));

const O2 = gegeben('O2');
const O3 = gegeben('O3');
const O4 = gegeben('O4');

const { an1, an2, an3 } = FIXTURE_IDS;

const ANLAGEN: Record<string, { name: string; terme: { messstelle: string; rolle: Rolle }[]; rest: string | null }> = {
  [an1]: { name: 'Werk Ahrenberg – Halle 1', terme: [{ messstelle: 'MS-01', rolle: 'zufluss' }], rest: null },
  [an2]: {
    name: 'Werk Ahrenberg – Halle 2',
    terme: [
      { messstelle: 'MS-10', rolle: 'zufluss' },
      { messstelle: 'MS-11', rolle: 'zugeordnet' },
      { messstelle: 'MS-12', rolle: 'zugeordnet' },
      { messstelle: 'MS-13', rolle: 'zugeordnet' },
      { messstelle: 'MS-14', rolle: 'zugeordnet' },
    ],
    rest: 'MS-15',
  },
  [an3]: {
    name: 'Werk Lindach',
    terme: [
      { messstelle: 'MS-16', rolle: 'zufluss' },
      { messstelle: 'MS-17', rolle: 'zugeordnet' },
      { messstelle: 'MS-18', rolle: 'zugeordnet' },
    ],
    rest: 'MS-22',
  },
};

interface Wert {
  menge: number;
  kennzeichen?: string[];
}

/** Die Werte je Zeitraum (`periode|am`) und Messstelle; `rest` je Anlage. */
const WERTE: Record<string, { messstellen: Record<string, Wert>; rest: Record<string, number> }> = {
  'monat|2026-10-01': {
    messstellen: {
      ...Object.fromEntries(Object.entries(jeMessstelle(O2.bezug_kwh)).map(([k, v]) => [k, { menge: v }])),
      ...Object.fromEntries(Object.entries(jeMessstelle(O4.im_gebaeude)).map(([k, v]) => [k, { menge: v }])),
      ...Object.fromEntries(Object.entries(jeMessstelle(O4.ausserhalb_im_system)).map(([k, v]) => [k, { menge: v }])),
      // bilanz-vectors F8: Lindach erbt „ab 15.10.2026“ (die Anlage hängt erst seit dem 15.10. am Standort).
      'MS-16': { menge: jeMessstelle(O2.bezug_kwh)['MS-16'], kennzeichen: ['ab 15.10.2026'] },
    },
    rest: { [an2]: O4.rest_des_systems as number },
  },
  'tag|2026-10-18': {
    messstellen: Object.fromEntries(['MS-16', 'MS-17', 'MS-18'].map((k) => [k, { menge: O3[k] as number }])),
    rest: { [an3]: O3['MS-22'] as number },
  },
};

const zwei = (n: number) => String(n).padStart(2, '0');
const tagText = (d: Date) => `${d.getUTCFullYear()}-${zwei(d.getUTCMonth() + 1)}-${zwei(d.getUTCDate())}`;

function grenzen(periode: Periode, am: string): { von: string; bis: string } {
  const [j, m] = am.split('-').map(Number);
  if (periode === 'tag') return { von: am, bis: am };
  if (periode === 'monat') return { von: `${am.slice(0, 7)}-01`, bis: tagText(new Date(Date.UTC(j, m, 0))) };
  return { von: `${j}-01-01`, bis: `${j}-12-31` };
}

function summe(eingaenge: BilanzEingang[]): BilanzSumme {
  const mit = eingaenge.filter((e) => e.menge !== null);
  const fehlend = eingaenge.filter((e) => e.menge === null).map((e) => e.messstelle);
  return {
    menge: eingaenge.length === 0 ? 0 : mit.reduce((s, e) => s + (e.menge ?? 0), 0),
    zustand: fehlend.length === 0 ? 'vollständig' : 'keine Werte',
    abdeckung_prozent: fehlend.length === 0 ? 100 : null,
    mit_werten: mit.length,
    gesamt: eingaenge.length,
    fehlend,
    kennzeichen: [],
    anzeige: null,
  };
}

/** Die Bilanz einer Anlage des Referenzunternehmens; eine unbekannte Anlage hat keinen Hauptzähler (kein System). */
export function ahrenbergBilanz(siteId: string, periode: Periode = 'monat', am = '2026-10-01'): Bilanz {
  const { von, bis } = grenzen(periode, am);
  const a = ANLAGEN[siteId];
  const bilanz = (hauptzaehler: Bilanz['hauptzaehler']): Bilanz => ({
    anlage: { id: siteId, name: a?.name ?? siteId },
    periode,
    am,
    von,
    bis,
    zeitzone: 'Europe/Berlin',
    hauptzaehler,
  });
  if (!a) return bilanz([]);
  const werte = WERTE[`${periode}|${von}`];
  const eingaenge: BilanzEingang[] = a.terme.map((t) => {
    const w = werte?.messstellen[t.messstelle];
    return {
      messstelle: t.messstelle,
      rolle: t.rolle,
      anteil: 'gesamt',
      menge: w?.menge ?? null,
      zustand: w ? 'vollständig' : 'keine Werte',
      abdeckung_prozent: w ? 100 : null,
      version: 1,
      kennzeichen: w?.kennzeichen ?? [],
      grund: null,
    };
  });
  const rest = werte?.rest[siteId] ?? null;
  const hz = a.terme[0].messstelle;
  return bilanz([
    {
      messstelle: { id: `messstelle-${hz}`, kennzeichen: hz, name: null },
      rest_messstelle: a.rest ? { id: `messstelle-${a.rest}`, kennzeichen: a.rest, name: null } : null,
      vorschlag: null,
      stellung_geaendert: false,
      abschnitte: [
        {
          von,
          bis,
          raster: periode,
          terme: a.terme.map((t) => ({ messstelle: t.messstelle, messstelle_id: null, name: null, rolle: t.rolle, anteil: 'gesamt' })),
          ausserhalb: [],
          werte: [
            {
              von,
              bis,
              zufluss: summe(eingaenge.filter((e) => e.rolle === 'zufluss')),
              abfluss: summe(eingaenge.filter((e) => e.rolle === 'abfluss')),
              zugeordnet: summe(eingaenge.filter((e) => e.rolle === 'zugeordnet')),
              rest: {
                menge: rest,
                groesse: 'Wirkenergie',
                richtung: 'Bezug',
                einheit: 'kWh',
                zustand: rest === null ? 'keine Werte' : 'vollständig',
                abdeckung_prozent: rest === null ? null : 100,
                fehlend: [],
                kennzeichen: [],
                kundensatz: rest === null ? null : `${rest} kWh sind keiner Messstelle zugeordnet`,
              },
              eingaenge,
            },
          ],
        },
      ],
      live: { wert: null, einheit: 'kW', unvollstaendig: true, fehlende: [], stand: null },
    },
  ]);
}
