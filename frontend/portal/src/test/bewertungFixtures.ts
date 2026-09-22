import {
  ApiError,
  type BewertungUmfang,
  type BewertungUmfangSpeichern,
  type EnergieTraeger,
  type Energieeinsatz,
  type EnergieeinsatzAenderung,
  type EnergieeinsatzAnlegen,
  type EnergieeinsatzEinfluss,
  type EnergieeinsatzMessstelle,
} from '../api';
import { ahrenbergBezugsgroessen, ahrenbergProzesse } from './kennzahlAnlegenFixtures';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { rechteSeed } from './rollenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Bewertung des Referenzunternehmens Ahrenberg (UEMS AP-16 IP-6) — abgeschrieben aus
 * `docs/contracts/v2/uems-referenzunternehmen.json` 1.6 (`bewertung_umfang`, `energieeinsaetze`, `personen`,
 * `messstellen[].prozesse`). Zwei Stände:
 *
 * - `leer`: vor dem 04.11.2026 — kein Umfang (die Route liefert die Vorgabe mit `fassung: null`), kein Einsatz (R11).
 * - `voll`: ab dem 04.11.2026 — Fassung 1 (ST-1, ST-2; Strom mit Anteil, Gas ohne) und EE-1 … EE-7.
 *
 * {@link bewertungBuehne} spielt die Routen nach (Anlegen mit 409 `einsatz_laeuft_bereits`, Protokoll mit Akteur), damit
 * Komponententests und die E2E-Bühne `e2e/bewertung.tsx` DENSELBEN Ablauf sehen. Die Fixture rechnet nichts.
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

const person = (kuerzel: string) => {
  const { benutzer } = rechteSeed(kuerzel);
  return { sub: benutzer.kennung, name: benutzer.name };
};

const eeId = (n: number) => `ee000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const P = Object.fromEntries(ahrenbergProzesse().map((p) => [p.kennzeichen, p]));
const BZ = Object.fromEntries(ahrenbergBezugsgroessen().bezugsgroessen.map((b) => [b.kennzeichen, b]));

/** Die Messstellen je Prozess (`messstellen[].prozesse` der Referenzdatei). */
const PROZESS_MS: Record<string, string[]> = {
  'P-1': ['MS-06', 'MS-11', 'MS-20'],
  'P-2': ['MS-12', 'MS-18'],
  'P-3': ['MS-07'],
  'P-4': ['MS-08'],
  'P-5': ['MS-13', 'MS-17'],
  'P-6': ['MS-05', 'MS-14', 'MS-21'],
};

function messstellenVon(prozessKz: string, traeger: EnergieTraeger): EnergieeinsatzMessstelle[] {
  const register = ahrenbergRegister().register;
  return (PROZESS_MS[prozessKz] ?? []).flatMap((kz) => {
    const z = register.find((r) => r.kennzeichen === kz);
    if (!z) return [];
    const gas = kz === 'MS-21';
    if ((traeger === 'Gas') !== gas) return [];
    return [{
      id: z.id,
      kennzeichen: kz,
      name: z.name ?? kz,
      art: z.art === 'berechnet' ? 'berechnet' : 'gemessen',
      traeger: gas ? 'Gas' : 'Strom',
      orte: z.ort.kennzeichen && z.ort.ort_art
        ? [{ ort_art: z.ort.ort_art, kennzeichen: z.ort.kennzeichen, gueltig_ab: z.ort.gueltig_ab ?? '2026-10-01', gueltig_bis: null }]
        : [],
      zustand: z.lebenszyklus ?? 'aktiv',
    } satisfies EnergieeinsatzMessstelle];
  });
}

interface Def {
  n: number;
  name: string;
  prozess: string;
  traeger: EnergieTraeger;
  verantwortlich: string;
  verbraucher: string;
  einfluesse: EnergieeinsatzEinfluss[];
}

const bz = (kz: string, art: EnergieeinsatzEinfluss['art']): EnergieeinsatzEinfluss => ({ art, bezugsgroesse_id: BZ[kz].id, wortlaut: null });
const text = (wortlaut: string, art: EnergieeinsatzEinfluss['art']): EnergieeinsatzEinfluss => ({ art, bezugsgroesse_id: null, wortlaut });

const DEFS: Def[] = [
  { n: 1, name: 'Spritzguss', prozess: 'P-1', traeger: 'Strom', verantwortlich: 'MD', verbraucher: 'Spritzgussmaschinen SG01–SG06 (Halle 1 Nord) und SG07–SG10 (Halle 2 Spritzguss)', einfluesse: [bz('BZ-1', 'produktion'), bz('BZ-3', 'betriebszeit')] },
  { n: 2, name: 'Montage', prozess: 'P-2', traeger: 'Strom', verantwortlich: 'PH', verbraucher: 'Montagelinie M1 (Halle 2) und M2 (Montagehalle Lindach)', einfluesse: [bz('BZ-2', 'produktion'), bz('BZ-6', 'produktion'), bz('BZ-7', 'produktion')] },
  { n: 3, name: 'Druckluft', prozess: 'P-3', traeger: 'Strom', verantwortlich: 'IK', verbraucher: 'Kompressoren K1+K2 (Technikraum Halle 1 Süd) — Querschnitt: versorgt Spritzguss und Montage', einfluesse: [bz('BZ-3', 'betriebszeit'), text('Leckagerate (ohne Zahl)', 'sonstige')] },
  { n: 4, name: 'Kühlung', prozess: 'P-4', traeger: 'Strom', verantwortlich: 'IK', verbraucher: 'Kaltwassersatz (bis 28.02.2027 Halle 1 Süd, ab 01.03.2027 Halle 2 Montage)', einfluesse: [text('Außentemperatur', 'wetter')] },
  { n: 5, name: 'Logistik', prozess: 'P-5', traeger: 'Strom', verantwortlich: 'PH', verbraucher: 'Lager Halle 2 (Allgemeinstrom), Lagerhalle Lindach (Tore, Förderer, Beleuchtung)', einfluesse: [text('Schichten', 'betriebszeit')] },
  { n: 6, name: 'Verwaltung', prozess: 'P-6', traeger: 'Strom', verantwortlich: 'JW', verbraucher: 'Büro, IT, Ladepunkt Parkplatz Halle 2', einfluesse: [text('Mitarbeitende', 'sonstige')] },
  { n: 7, name: 'Heizung Verwaltung (Gas)', prozess: 'P-6', traeger: 'Gas', verantwortlich: 'JW', verbraucher: 'Gasheizung Verwaltung (monatlich abgelesen, m³)', einfluesse: [text('Gradtage', 'wetter')] },
];

function einsatzAus(n: number, a: EnergieeinsatzAnlegen, gueltigAb: string): Energieeinsatz {
  const p = ahrenbergProzesse().find((x) => x.id === a.prozess_id)!;
  const wer = a.verantwortlich_sub ? rechteSeedNachSub(a.verantwortlich_sub) : null;
  const messstellen = messstellenVon(p.kennzeichen, a.traeger);
  return {
    id: eeId(n),
    kennzeichen: `EE-${n}`,
    prozess: { id: p.id, kennzeichen: p.kennzeichen, name: p.name },
    traeger: a.traeger,
    name: a.name,
    wortlaut: a.wortlaut ?? null,
    verbraucher_wortlaut: a.verbraucher_wortlaut ?? null,
    verantwortlich: wer ? { sub: wer.sub, name: wer.name, konto: wer.sub, zustand: 'aktiv', ohne_konto_seit: null } : { sub: null, name: null },
    einflussgroessen: a.einflussgroessen ?? [],
    messstellen,
    // Die Fixture rechnet nichts: nur die Gas-Messstelle hat keinen Kanal, also keine Menge im letzten Monat (R12).
    keine_werte: messstellen.every((m) => m.traeger === 'Gas'),
    gueltig_ab: gueltigAb,
    gueltig_bis: null,
    beendet_am: null,
    beendet_grund: null,
  };
}

const PERSONEN = ['JW', 'IK', 'PH', 'SR', 'MD', 'CB'];
function rechteSeedNachSub(sub: string) {
  for (const k of PERSONEN) {
    const p = person(k);
    if (p.sub === sub) return p;
  }
  return null;
}

const anfrageVon = (d: Def): EnergieeinsatzAnlegen => ({
  prozess_id: P[d.prozess].id,
  traeger: d.traeger,
  name: d.name,
  verbraucher_wortlaut: d.verbraucher,
  verantwortlich_sub: person(d.verantwortlich).sub,
  einflussgroessen: d.einfluesse,
});

/** EE-1 … EE-7 am 04.11.2026 (R1/R12/R14). */
export function ahrenbergEinsaetze(): Energieeinsatz[] {
  return DEFS.map((d) => einsatzAus(d.n, anfrageVon(d), '2026-11-04'));
}

const STANDORTE = [
  { id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg', anlagen: [{ id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' }, { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' }] },
  { id: FIXTURE_IDS.st2, name: 'Werk Lindach', anlagen: [{ id: FIXTURE_IDS.an3, name: 'Werk Lindach' }] },
];

function umfangAus(fassung: number | null, s: BewertungUmfangSpeichern | null, am: string): BewertungUmfang {
  const ik = person('IK');
  const ids = s?.standort_ids ?? STANDORTE.map((x) => x.id);
  const ausgeschlossen = new Set((s?.ausschluesse ?? []).filter((a) => a.art === 'anlage').map((a) => a.verweis));
  const standorte = STANDORTE.filter((x) => ids.includes(x.id)).map((x) => {
    const anlagen = x.anlagen.filter((a) => !ausgeschlossen.has(a.id));
    return { id: x.id, name: x.name, anlagen_im_umfang: anlagen, anzahl_anlagen_im_umfang: anlagen.length };
  });
  const traeger = (s?.traeger ?? ['Strom']).map((name) => ({ name, mit_anteil: name === 'Strom' }));
  const anlagen = standorte.flatMap((x) => x.anlagen_im_umfang);
  return {
    id: fassung === null ? null : `b0000000-0000-4000-8000-00000000000${fassung}`,
    fassung,
    gueltig_ab: s?.gueltig_ab ?? null,
    am,
    standorte,
    traeger,
    ausschluesse: s?.ausschluesse ?? [],
    anlagen_im_umfang: anlagen,
    anzahl_anlagen_im_umfang: anlagen.length,
    nenner_traeger: traeger.some((t) => t.name === 'Strom') ? 'Strom' : null,
    begruendung: s?.begruendung ?? null,
    akteur: fassung === null ? null : { sub: ik.sub, name: ik.name, rolle: 'energiemanager', art: 'kunde' },
    created_at: fassung === null ? null : `${s?.gueltig_ab ?? '2026-11-04'}T09:12:00+01:00`,
    aufgehoben_am: null,
    teilansicht: false,
  };
}

/** Fassung 1 der Referenzdatei (04.11.2026, Ines Kaltenbach). */
export function ahrenbergUmfang(am = '2026-11-04'): BewertungUmfang {
  return umfangAus(1, {
    gueltig_ab: '2026-11-04',
    standort_ids: STANDORTE.map((x) => x.id),
    traeger: ['Strom', 'Gas'],
    ausschluesse: [],
    begruendung: 'Erster Betrachtungsumfang der energetischen Bewertung: beide Werke, Strom mit Anteil und Gas ohne gemeinsamen Nenner.',
  }, am);
}

/** Die ungespeicherte Vorgabe der Route (kein Umfang): alle Standorte, Strom. */
export const ahrenbergUmfangVorgabe = (am: string) => umfangAus(null, null, am);

const fehler = (status: number, code: string, message: string) => new ApiError(status, message, { code, message });

/**
 * Die Routen der Bewertung als Zustandsmaschine im Speicher. `ich` ist das Kürzel des Aufrufers (der Akteur im
 * Protokoll); `heute` der Kalendertag der Bühne.
 */
export function bewertungBuehne(stand: 'leer' | 'voll', ich = 'IK', heute = stand === 'leer' ? '2026-11-04' : '2026-11-20') {
  let umfangFassung: { nr: number; s: BewertungUmfangSpeichern } | null = stand === 'voll'
    ? { nr: 1, s: { gueltig_ab: '2026-11-04', standort_ids: STANDORTE.map((x) => x.id), traeger: ['Strom', 'Gas'], ausschluesse: [], begruendung: null } }
    : null;
  const einsaetze: Energieeinsatz[] = stand === 'voll' ? ahrenbergEinsaetze() : [];
  const protokolle = new Map<string, EnergieeinsatzAenderung[]>();
  let zaehler = einsaetze.length;
  let aenderung = 100;
  const akteur = () => ({ ...person(ich), rolle: ich === 'IK' ? 'energiemanager' : null, art: 'kunde' as const });
  const protokolliere = (id: string, art: EnergieeinsatzAenderung['art'], zeit = `${heute}T09:30:00+01:00`) =>
    protokolle.set(id, [...(protokolle.get(id) ?? []), { id: ++aenderung, art, alt: null, neu: null, akteur: akteur(), zeit }]);
  for (const e of einsaetze) protokolle.set(e.id, [{ id: ++aenderung, art: 'angelegt', alt: null, neu: null, akteur: { ...person('IK'), rolle: 'energiemanager', art: 'kunde' }, zeit: '2026-11-04T10:12:00+01:00' }]);
  const finde = (id: string) => {
    const e = einsaetze.find((x) => x.id === id);
    if (!e) throw fehler(404, 'nicht_gefunden', 'Energieeinsatz nicht gefunden.');
    return e;
  };
  const ersetze = (e: Energieeinsatz) => {
    einsaetze.splice(einsaetze.findIndex((x) => x.id === e.id), 1, e);
    return structuredClone(e);
  };
  return {
    bewertungUmfang: async () => structuredClone(umfangFassung ? umfangAus(umfangFassung.nr, umfangFassung.s, heute) : umfangAus(null, null, heute)),
    bewertungUmfangSpeichern: async (s: BewertungUmfangSpeichern) => {
      if (s.ausschluesse.some((a) => !a.begruendung.trim())) throw fehler(422, 'begruendung_fehlt', 'Ein Ausschluss braucht eine Begründung.');
      umfangFassung = { nr: (umfangFassung?.nr ?? 0) + 1, s };
      return structuredClone(umfangAus(umfangFassung.nr, s, s.gueltig_ab));
    },
    energieeinsaetze: async () => ({ energieeinsaetze: structuredClone(einsaetze) }),
    energieeinsatzVorschlaege: async () => ({
      vorschlaege: ahrenbergProzesse()
        .filter((p) => !einsaetze.some((e) => e.prozess.id === p.id && e.traeger === 'Strom' && !e.gueltig_bis))
        .map((p) => ({ prozess: { id: p.id, kennzeichen: p.kennzeichen, name: p.name }, traeger: 'Strom' as const })),
    }),
    energieeinsatz: async (id: string) => structuredClone(finde(id)),
    energieeinsatzAnlegen: async (a: EnergieeinsatzAnlegen) => {
      if (!a.name.trim()) throw fehler(422, 'name_fehlt', 'Bitte geben Sie einen Namen an.');
      if (einsaetze.some((e) => e.prozess.id === a.prozess_id && e.traeger === a.traeger && !e.gueltig_bis))
        throw fehler(409, 'einsatz_laeuft_bereits', 'Für diesen Prozess und Träger gibt es bereits einen laufenden Energieeinsatz.');
      const e = einsatzAus(++zaehler, a, a.gueltig_ab ?? heute);
      einsaetze.push(e);
      protokolliere(e.id, 'angelegt');
      return structuredClone(e);
    },
    energieeinsatzBearbeiten: async (id: string, b: { name: string; verbraucher_wortlaut?: string | null }) => {
      protokolliere(id, 'bearbeitet');
      return ersetze({ ...finde(id), name: b.name, verbraucher_wortlaut: b.verbraucher_wortlaut ?? null });
    },
    energieeinsatzVerantwortlicher: async (id: string, sub: string | null) => {
      const wer = sub ? rechteSeedNachSub(sub) : null;
      protokolliere(id, 'verantwortlicher');
      return ersetze({ ...finde(id), verantwortlich: wer ? { sub: wer.sub, name: wer.name, konto: wer.sub, zustand: 'aktiv' } : { sub: null, name: null } });
    },
    energieeinsatzEinflussgroessen: async (id: string, einflussgroessen: EnergieeinsatzEinfluss[]) => {
      protokolliere(id, 'einflussgroessen');
      return ersetze({ ...finde(id), einflussgroessen });
    },
    energieeinsatzBeenden: async (id: string, b: { grund: string; gueltig_bis?: string }) => {
      protokolliere(id, 'beendet');
      return ersetze({ ...finde(id), gueltig_bis: b.gueltig_bis ?? heute, beendet_am: `${heute}T09:30:00+01:00`, beendet_grund: b.grund });
    },
    energieeinsatzProtokoll: async (id: string) => ({ aenderungen: structuredClone(protokolle.get(finde(id).id) ?? []) }),
  };
}
