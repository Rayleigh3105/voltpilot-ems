import type { Bilanz, BilanzEingang, BilanzMessstelleRef, BilanzSumme } from '../api';
import { dez, dezText } from '../bezugsdaten';
import { herkunft, live, rest, summe, type Eingang, type LiveTerm, type Summand } from '../uemsBilanz';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import faelle from './oberflaechenFaelle.json';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Energiebilanz je Anlage des Referenzunternehmens Ahrenberg — Antworten von `GET /api/v1/sites/{id}/bilanz` in
 * der Form der Route (AP-10 IP-9/IP-12) für die Bühne und die Tests der Übersicht (AP-13 IP-7) und der Energiebilanz
 * je Anlage (AP-13 IP-8).
 *
 * Die Zahlen stammen allein aus den Referenzfällen (`oberflaechenFaelle.json`, Kopie von `referenzfaelle.json`):
 * O2 — Oktober 2026, Netzbezug der drei Hauptzähler; O4 — Halle 2 im Oktober (Unterzähler); O6 — Halle 1 im Oktober
 * (Erzeuger, Speicher-Anteile, Abgabe, Unterzähler); O3 — Werk Lindach am 18.10.2026; O7 — Halle 2 am 04.11.2026 (MS-14
 * ohne Werte). Jeder andere Zeitraum antwortet mit denselben Termen OHNE Werte — erfunden wird keine Zahl.
 *
 * Summe, Rest, Herkunft und Live-Wert rechnen die ZWILLINGE (`uemsBilanz.summe`/`rest`/`herkunft`/`live`) — wie
 * `BilanzService` mit `BilanzAbleitung`; Namen und IDs kommen aus dem Register, der Live-Wert aus der Momentaufnahme
 * des Registers (`Wirkleistung`, 20.10.2026 10:15 — O8: 96,5 − 94,9 = 1,6 kW). ⚠ Die Bühne setzt den Stand der
 * Momentaufnahme auf ihre Uhr (eine Minute davor): Zahlen aus O8, der Zeitpunkt aus `jetzt`.
 */

type Rolle = BilanzEingang['rolle'];
type Anteil = BilanzEingang['anteil'];
type Periode = Bilanz['periode'];
type Gegeben = Record<string, unknown>;

const gegeben = (id: string): Gegeben => {
  const f = (faelle as unknown as { faelle: { id: string; gegeben: Gegeben }[] }).faelle.find((x) => x.id === id);
  if (!f) throw new Error(`Referenzfall ${id} fehlt`);
  return f.gegeben;
};
/** „AN-1 (MS-01)“ → MS-01. */
const kennzeichenAus = (schluessel: string) => /(MS-\d+)/.exec(schluessel)?.[1] ?? schluessel;

interface Wert {
  menge: number | null;
  kennzeichen?: string[];
  abdeckung?: number;
}

/** Werte je Term-Schlüssel: „MS-04|negativ“ für einen Anteil, sonst das Kennzeichen. */
const werteAus = (werte: unknown): Record<string, Wert> =>
  Object.fromEntries(
    Object.entries(werte as Record<string, number>).map(([k, v]) => {
      const kz = kennzeichenAus(k);
      const anteil = /negativer Anteil/.test(k) ? '|negativ' : /positiver Anteil/.test(k) ? '|positiv' : '';
      return [`${kz}${anteil}`, { menge: v }];
    }),
  );

const O2 = gegeben('O2');
const O3 = gegeben('O3');
const O4 = gegeben('O4');
const O5 = gegeben('O5');
const O6 = gegeben('O6');
const O7 = gegeben('O7');

const { an1, an2, an3 } = FIXTURE_IDS;
const REGISTER = new Map(ahrenbergRegister().register.map((z) => [z.kennzeichen, z]));

interface Term {
  messstelle: string;
  rolle: Rolle;
  anteil: Anteil;
}
const term = (messstelle: string, rolle: Rolle, anteil: Anteil = 'gesamt'): Term => ({ messstelle, rolle, anteil });
const schluessel = (t: Term) => (t.anteil === 'gesamt' ? t.messstelle : `${t.messstelle}|${t.anteil}`);

/** F3/O5: MS-15 geht zu 100 % an 4300 („4300 Logistik“ → Kennzeichen 4300, wie `BerechnetePeriodenRepository.verteilungen`). */
const [verteilZiel, verteilAnteil] = Object.entries(O5.verteilung_ms15 as Record<string, number>)[0];

const ANLAGEN: Record<string, { name: string; terme: Term[]; rest: string; verteilung: { ziel: string; anteil_prozent: string } | null }> = {
  [an1]: {
    name: 'Werk Ahrenberg – Halle 1',
    terme: [
      term('MS-01', 'zufluss'),
      term('MS-03', 'zufluss'),
      term('MS-04', 'zufluss', 'negativ'),
      term('MS-02', 'abfluss'),
      term('MS-04', 'abfluss', 'positiv'),
      ...['MS-05', 'MS-06', 'MS-07', 'MS-08'].map((kz) => term(kz, 'zugeordnet')),
    ],
    rest: 'MS-09',
    verteilung: null,
  },
  [an2]: {
    name: 'Werk Ahrenberg – Halle 2',
    terme: [term('MS-10', 'zufluss'), ...['MS-11', 'MS-12', 'MS-13', 'MS-14'].map((kz) => term(kz, 'zugeordnet'))],
    rest: 'MS-15',
    verteilung: { ziel: verteilZiel.split(' ')[0], anteil_prozent: String(verteilAnteil) },
  },
  [an3]: {
    name: 'Werk Lindach',
    terme: [term('MS-16', 'zufluss'), term('MS-17', 'zugeordnet'), term('MS-18', 'zugeordnet')],
    rest: 'MS-22',
    verteilung: null,
  },
};

/** Die Werte je Zeitraum (`periode|von`). */
const WERTE: Record<string, Record<string, Wert>> = {
  'monat|2026-10-01': {
    ...werteAus(O2.bezug_kwh),
    ...werteAus(O4.im_gebaeude),
    ...werteAus(O4.ausserhalb_im_system),
    ...werteAus(O6.zufluss),
    ...werteAus(O6.abfluss),
    ...werteAus(O6.zugeordnet),
    // bilanz-vectors F8: Lindach erbt „ab 15.10.2026“ (die Anlage hängt erst seit dem 15.10. am Standort).
    'MS-16': { menge: werteAus(O2.bezug_kwh)['MS-16'].menge, kennzeichen: ['ab 15.10.2026'] },
  },
  'tag|2026-10-18': Object.fromEntries(['MS-16', 'MS-17', 'MS-18'].map((k) => [k, { menge: O3[k] as number }])),
  // O7 (AP-10 F5): der Ladepunkt meldet den ganzen Tag nicht — keine Werte, 0 von 1 440.
  'tag|2026-11-04': Object.fromEntries(
    ['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14'].map((k) => [k, typeof O7[k] === 'number' ? { menge: O7[k] as number } : { menge: null, abdeckung: 0 }]),
  ),
};

const zwei = (n: number) => String(n).padStart(2, '0');
const tagText = (d: Date) => `${d.getUTCFullYear()}-${zwei(d.getUTCMonth() + 1)}-${zwei(d.getUTCDate())}`;
const nachTag = (tag: string) => tagText(new Date(Date.parse(`${tag}T00:00:00Z`) + 86_400_000));

function grenzen(periode: Periode, am: string): { von: string; bis: string } {
  const [j, m] = am.split('-').map(Number);
  if (periode === 'tag') return { von: am, bis: am };
  if (periode === 'monat') return { von: `${am.slice(0, 7)}-01`, bis: tagText(new Date(Date.UTC(j, m, 0))) };
  return { von: `${j}-01-01`, bis: `${j}-12-31` };
}

const BERLIN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** „2026-11-05T09:00:00+01:00“ — ein Zeitpunkt in der Zone des Standorts, sekundengenau (wie `BilanzwertHerkunft`). */
function berlinIso(ms: number): string {
  const sekunde = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(BERLIN.formatToParts(sekunde).map((x) => [x.type, x.value]));
  const minuten = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - sekunde) / 60_000);
  const zone = `${minuten < 0 ? '-' : '+'}${zwei(Math.floor(Math.abs(minuten) / 60))}:${zwei(Math.abs(minuten) % 60)}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${zone}`;
}

/** Mitternacht eines Tages in Berlin (Winter- oder Sommerzeit). */
const mitternacht = (tag: string): string =>
  [`${tag}T00:00:00+01:00`, `${tag}T00:00:00+02:00`].map((s) => berlinIso(Date.parse(s))).find((s) => s.slice(11, 19) === '00:00:00')!;

const alsDez = (m: number | null) => (m === null ? null : dez(String(m)));
const ref = (kz: string): BilanzMessstelleRef => ({ id: REGISTER.get(kz)?.id ?? `messstelle-${kz}`, kennzeichen: kz, name: REGISTER.get(kz)?.name ?? null });

/** `BilanzService.summe`: eine Rolle ohne Term hat Menge und Zustand `null`, nie 0. */
function summeDer(rolle: Rolle, eingaenge: BilanzEingang[], ebene: string): BilanzSumme {
  const s = eingaenge.filter((e) => e.rolle === rolle);
  const u = summe(
    'kWh',
    ebene,
    s.map((e): Summand => ({ ...e, menge: alsDez(e.menge), vorzeichen: '+', faktor: dez('1') })),
  );
  const leer = s.length === 0;
  return {
    menge: leer ? null : Number(dezText(u.menge)),
    zustand: leer ? null : u.zustand,
    abdeckung_prozent: u.abdeckung_prozent,
    mit_werten: u.vorhanden,
    gesamt: u.gesamt,
    fehlend: u.fehlend,
    kennzeichen: leer ? [] : u.kennzeichen,
    anzeige: u.anzeige,
  };
}

/** Die Momentaufnahme `Wirkleistung` des Registers (20.10.2026 10:15). */
const kw = (kz: string): number | null =>
  REGISTER.get(kz)?.nebengroessen.find((n) => n.groesse.groesse === 'Wirkleistung')?.letzter_wert?.wert ?? null;

export interface BilanzBuehne {
  /** Die Uhr der Bühne — Rechenzeitpunkt der Herkunft und Stand der Live-Zeile (eine Minute davor). */
  jetzt?: number;
  /** O8-Variante: MS-14 ist veraltet — der Live-Wert wird `null`, nie die Teilsumme. */
  live?: 'frisch' | 'veraltet';
  /** Die Anlage hat keinen Hauptzähler in der Stellung (Leerzustand Z4). */
  ohneHauptzaehler?: boolean;
  /** Der Hauptzähler hat noch keine Rest-Messstelle — die Route schlägt „Rest anlegen“ vor (E18). */
  restVorschlag?: boolean;
}

/** Die Bilanz einer Anlage des Referenzunternehmens; eine unbekannte Anlage hat keinen Hauptzähler (kein System). */
export function ahrenbergBilanz(siteId: string, periode: Periode = 'monat', am = '2026-10-01', b: BilanzBuehne = {}): Bilanz {
  const jetzt = b.jetzt ?? Date.parse('2026-10-20T08:16:00Z');
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
  if (!a || b.ohneHauptzaehler) return bilanz([]);
  const werte = WERTE[`${periode}|${von}`];
  const eingaenge: BilanzEingang[] = a.terme.map((t) => {
    const w = werte?.[schluessel(t)];
    const mitZahl = w !== undefined && w.menge !== null;
    return {
      messstelle: t.messstelle,
      rolle: t.rolle,
      anteil: t.anteil,
      menge: mitZahl ? w.menge : null,
      zustand: mitZahl ? 'vollständig' : 'keine Werte',
      abdeckung_prozent: w === undefined ? null : w.abdeckung ?? (mitZahl ? 100 : null),
      version: 1,
      kennzeichen: w?.kennzeichen ?? [],
      grund: null,
    };
  });
  const hz = a.terme[0].messstelle;
  const restKz = b.restVorschlag ? null : a.rest;
  const r = rest(hz, 'kWh', periode, 1, [], eingaenge.map((e): Eingang => ({ ...e, menge: alsDez(e.menge) })));
  const h = herkunft({
    art: 'berechnet',
    messstelle: restKz,
    periode: { art: periode, schluessel: periode === 'tag' ? von : periode === 'monat' ? von.slice(0, 7) : von.slice(0, 4) },
    formel_typ: 'rest',
    formel_fassung: restKz ? 1 : null,
    periode_ende: mitternacht(nachTag(bis)),
    berechnet_am: berlinIso(jetzt),
    version: Math.max(1, ...eingaenge.map((e) => e.version)),
    ausloeser: null,
    verteilung: restKz && a.verteilung ? { fassung: 1, ...a.verteilung } : null,
    eingaenge: eingaenge.map((e) => ({
      messstelle: e.messstelle,
      bilanz_rolle: e.rolle,
      anteil: e.anteil,
      menge: e.menge === null ? null : String(e.menge),
      zustand: e.zustand,
      abdeckung_prozent: e.abdeckung_prozent,
      version: e.version,
      kennzeichen: e.kennzeichen,
    })),
    ergebnis: { menge: r.menge === null ? null : dezText(r.menge), zustand: r.zustand, abdeckung_prozent: r.abdeckung_prozent, kennzeichen: r.kennzeichen },
  });
  const fehlt = [...h.fehlt, ...(restKz ? [] : ['formel_fassung'])];
  const lt = live(
    'kW',
    a.terme.map((t): LiveTerm => {
      const roh = kw(t.messstelle);
      // Ein Anteil wird je Rohwert geteilt (AP-10 IP-9 Falle 4): −40 kW am Speicher = 40 kW negativer Anteil.
      const wert = roh === null ? null : t.anteil === 'positiv' ? Math.max(roh, 0) : t.anteil === 'negativ' ? Math.max(-roh, 0) : roh;
      const veraltet = b.live === 'veraltet' && t.messstelle === 'MS-14';
      return {
        messstelle: t.messstelle,
        vorzeichen: t.rolle === 'zufluss' ? '+' : '-',
        faktor: 1,
        wert: veraltet ? null : wert,
        einheit: 'kW',
        grund: veraltet ? 'veraltet' : wert === null ? 'kein_wert' : null,
      };
    }),
  );
  return bilanz([
    {
      messstelle: ref(hz),
      rest_messstelle: restKz ? ref(restKz) : null,
      vorschlag: restKz ? null : { aktion: 'rest_anlegen', hauptzaehler_id: ref(hz).id, name: `${a.name} nicht zugeordnet` },
      stellung_geaendert: false,
      abschnitte: [
        {
          von,
          bis,
          raster: periode,
          terme: a.terme.map((t) => ({ messstelle: t.messstelle, messstelle_id: ref(t.messstelle).id, name: ref(t.messstelle).name, rolle: t.rolle, anteil: t.anteil })),
          ausserhalb: [],
          werte: [
            {
              von,
              bis,
              zufluss: summeDer('zufluss', eingaenge, periode),
              abfluss: summeDer('abfluss', eingaenge, periode),
              zugeordnet: summeDer('zugeordnet', eingaenge, periode),
              rest: {
                menge: r.menge === null ? null : Number(dezText(r.menge)),
                groesse: r.groesse ?? 'Wirkenergie',
                richtung: r.richtung ?? 'Bezug',
                einheit: r.einheit,
                zustand: r.zustand,
                abdeckung_prozent: r.abdeckung_prozent,
                fehlend: r.fehlend,
                kennzeichen: r.kennzeichen,
                kundensatz: r.kundensatz,
                herkunft: { satz: fehlt.length === 0 ? h.satz : null, fehlt },
              },
              eingaenge,
            },
          ],
        },
      ],
      live: {
        wert: lt.wert,
        einheit: 'kW',
        unvollstaendig: lt.unvollstaendig,
        fehlende: lt.fehlende as Bilanz['hauptzaehler'][number]['live']['fehlende'],
        stand: lt.wert === null ? null : new Date(Math.floor(jetzt / 60_000) * 60_000 - 60_000).toISOString(),
      },
    },
  ]);
}
