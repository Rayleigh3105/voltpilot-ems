import {
  ApiError,
  type BewertungUmfang,
  type BewertungUmfangSpeichern,
  type BewertungKriterienFassung,
  type BewertungKriterienSpeichern,
  type BewertungRangliste,
  type EnergieTraeger,
  type Energieeinsatz,
  type EnergieeinsatzAenderung,
  type EnergieeinsatzAnlegen,
  type EnergieeinsatzEinfluss,
  type EnergieeinsatzMessstelle,
  type EnergieeinsatzEinstufungFassung,
  type EnergieeinsatzEinstufungSpeichern,
  type MessstelleQuellenListe,
} from '../api';
import { ahrenbergBezugsgroessen, ahrenbergProzesse } from './kennzahlAnlegenFixtures';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { rechteSeed } from './rollenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';
import { r16ProzessSummeHinweis } from './kostenstellenFixtures';
import { ahrenbergMessabdeckung, GR5_ID, gr5Messmittel, z5bMessmittel } from './messmittelFixtures';

/**
 * Die Bewertung des Referenzunternehmens Ahrenberg (UEMS AP-16 IP-6) — abgeschrieben aus
 * `docs/contracts/v2/uems-referenzunternehmen.json` 1.6 (`bewertung_umfang`, `energieeinsaetze`, `personen`,
 * `messstellen[].prozesse`). Zwei Stände:
 *
 * - `leer`: vor dem 04.11.2026 — kein Umfang (die Route liefert die Vorgabe mit `fassung: null`), kein Einsatz (R11).
 * - `voll`: ab dem 04.11.2026 — Fassung 1 (ST-1, ST-2; Strom mit Anteil, Gas ohne) und EE-1 … EE-7.
 *
 * {@link bewertungBuehne} spielt die Routen nach (Anlegen, Rangliste, Einstufung, Kriterien und Historie), damit
 * Komponententests und die E2E-Bühne `e2e/bewertung.tsx` DENSELBEN Ablauf sehen. Vertragszahlen werden abgeschrieben,
 * nur die geänderte K1-Schwelle wird für den sichtbaren Vorschlag nachgezogen.
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

const KRITERIEN = { K1: '10', K2: '80', K3: '100000', K5: '90', K6: '5', K7: 12, K8: '80', mindest_monate: 3 };
const KRITERIEN_ZEILEN = [
  ['K1', '10', '%', '>='], ['K2', '80', '%', 'kumuliert bis'], ['K3', '100000', 'kWh', '>='],
  ['K4', null, null, null], ['K5', '90', '%', '>='], ['K6', '5', '%', '<='], ['K7', 12, 'Monate', '='], ['K8', '80', '%', '>='],
] as const;
const ikAkteur = () => ({ ...person('IK'), rolle: 'energiemanager', art: 'kunde' as const });

function kriterienFassung(fassung = 1, werte = KRITERIEN, begruendung: string | null = null): BewertungKriterienFassung {
  return {
    fassung, werte: { ...werte }, kriterien: KRITERIEN_ZEILEN.map(([kennung, schwelle, einheit, vergleich]) => ({ kennung, schwelle, einheit, vergleich })),
    herkunft: fassung === 1 ? 'Vorgabe' : 'Unternehmen', gueltig_ab: fassung === 1 ? null : '2026-11-20', begruendung,
    akteur: fassung === 1 ? null : ikAkteur(), vieraugen: false, freigabe_status: 'freigegeben', entschieden_von: null,
    entschieden_am: null, entscheidungs_begruendung: null, created_at: fassung === 1 ? null : '2026-11-20T10:00:00+01:00', aufgehoben_am: null,
  };
}

const MENGEN: Record<number, { menge: string; anteil: string; rang: number; ms: [string, string][] }> = {
  1: { menge: '77500', anteil: '41.8', rang: 1, ms: [['MS-06', '55100'], ['MS-11', '22400']] },
  3: { menge: '15900', anteil: '8.6', rang: 2, ms: [['MS-07', '15900']] },
  2: { menge: '9640', anteil: '5.2', rang: 3, ms: [['MS-12', '6040'], ['MS-18', '3600']] },
  6: { menge: '8700', anteil: '4.7', rang: 4, ms: [['MS-05', '4900'], ['MS-14', '3800']] },
  5: { menge: '7800', anteil: '4.2', rang: 5, ms: [['MS-13', '4200'], ['MS-17', '3600']] },
  4: { menge: '6200', anteil: '3.3', rang: 6, ms: [['MS-08', '6200']] },
};
const BILANZEN = [
  [FIXTURE_IDS.an1, '139380'], [FIXTURE_IDS.an2, '36900'], [FIXTURE_IDS.an3, '9100'],
] as const;

export function ahrenbergRangliste(leer = false, kriterien = kriterienFassung()): BewertungRangliste {
  const einsaetze = ahrenbergEinsaetze();
  const basis = { von: '2026-10-01', bis: '2026-10-31', umfang_id: leer ? null : 'b0000000-0000-4000-8000-000000000001', umfang_fassung: leer ? null : 1,
    teilansicht: false, monate: 1, kriterien: { fassung: kriterien.fassung, werte: kriterien.werte }, urteil: { K7: 'vorlaeufig' as const, K8: 'unter_schwelle' as const } };
  if (leer) return { ...basis, nenner: { wert: null, einheit: 'kWh', vorhanden: 0, gesamt: 3, anlagen: '0 von 3', zustand: 'unvollständig' },
    zugeordnet: null, rest: null, abdeckung_prozent: null, zustand: 'unvollständig', anlagen: [], einsaetze: [], weitere_traeger: [] };
  const zeilen = [1, 3, 2, 6, 5, 4].map((n) => {
    const e = einsaetze[n - 1], m = MENGEN[n];
    const ueber = Number(m.anteil) >= Number(kriterien.werte.K1);
    const urteil = { K1: ueber ? 'ueber_schwelle' as const : 'unter_schwelle' as const, K2: 'nicht_belastbar' as const,
      K3: 'nicht_anwendbar' as const, K5: 'erfuellt' as const, K6: 'erfuellt' as const };
    return { id: e.id, kennzeichen: e.kennzeichen, name: e.name, prozess_id: e.prozess.id, traeger: e.traeger, einheit: 'kWh', menge: m.menge,
      zustand: 'vollständig', ersatz: '0', ersatz_prozent: '0', datenlage_prozent: '100', anteil_prozent: m.anteil,
      kumuliert_zugeordnet_prozent: null, anteil_zustand: 'vollständig', rang: m.rang, urteil,
      vorschlag: ueber ? 'ueber_schwelle' as const : 'unter_schwelle' as const,
      herkunft: { zeitraum: '2026-10', kriterien_fassung: kriterien.fassung,
        eingaenge: m.ms.map(([objekt, wert]) => ({ objekt, von: '2026-10-01', bis: '2026-10-31', wert, version: 1, zustand: 'vollständig' })),
        nenner: { wert: '185380', anlagen: '3 von 3', bilanzwerte: BILANZEN.map(([anlage, wert]) => ({ anlage, von: '2026-10-01', bis: '2026-10-31', wert, version: 1, zustand: 'vollständig', eingaenge: [] })) },
        urteil, vorschlag: ueber ? 'ueber_schwelle' as const : 'unter_schwelle' as const }, messstellen: [],
      prozess_summe_hinweise: n === 1 ? [r16ProzessSummeHinweis()] : [] };
  });
  const gas = einsaetze[6];
  const gasUrteil = { K1: 'nicht_anwendbar' as const, K2: 'nicht_anwendbar' as const, K3: 'nicht_anwendbar' as const, K5: 'erfuellt' as const, K6: 'erfuellt' as const };
  return { ...basis, nenner: { wert: '185380', einheit: 'kWh', vorhanden: 3, gesamt: 3, anlagen: '3 von 3', zustand: 'vollständig' },
    zugeordnet: '125740', rest: '59640', abdeckung_prozent: '67.8', zustand: 'vollständig',
    anlagen: [{ id: FIXTURE_IDS.an1, name: 'Halle 1', ab: '2026-10-01', nenner: '139380', zugeordnet: '84800', rest: '54580', rest_anteil_prozent: '39.2', zustand: 'vollständig' },
      { id: FIXTURE_IDS.an2, name: 'Halle 2', ab: '2026-10-01', nenner: '36900', zugeordnet: '33040', rest: '3860', rest_anteil_prozent: '10.5', zustand: 'vollständig' },
      { id: FIXTURE_IDS.an3, name: 'Werk Lindach', ab: '2026-10-01', nenner: '9100', zugeordnet: '7900', rest: '1200', rest_anteil_prozent: '13.2', zustand: 'vollständig' }],
    einsaetze: zeilen, weitere_traeger: [{ id: gas.id, kennzeichen: gas.kennzeichen, name: gas.name, prozess_id: gas.prozess.id, traeger: 'Gas', einheit: 'm³', menge: '1240', zustand: 'vollständig', ersatz: '0', ersatz_prozent: '0', datenlage_prozent: '100', anteil_prozent: null, kumuliert_zugeordnet_prozent: null, anteil_zustand: 'ohne Anteil', rang: null, urteil: gasUrteil, vorschlag: 'unter_schwelle', herkunft: { zeitraum: '2026-10', kriterien_fassung: kriterien.fassung, eingaenge: [{ objekt: 'MS-21', von: '2026-10-01', bis: '2026-10-31', wert: '1240', version: 1, zustand: 'vollständig' }], nenner: null, urteil: gasUrteil, vorschlag: 'unter_schwelle' }, messstellen: [], prozess_summe_hinweise: [] }] };
}

const fehler = (status: number, code: string, message: string) => new ApiError(status, message, { code, message });

/** Bühne (IP-18): welches Gerät die Hauptgröße einer Messstelle führend liest. */
const FUEHREND_GERAET: Record<string, { id: string; kz: string; einbau: string }> = {
  'MS-06': { id: '9b000000-0000-4000-8000-000000000004', kz: 'GR-4', einbau: 'Z-5b' },
  'MS-07': { id: GR5_ID, kz: 'GR-5', einbau: 'GR-5' },
};

/**
 * Die Routen der Bewertung als Zustandsmaschine im Speicher. `ich` ist das Kürzel des Aufrufers (der Akteur im
 * Protokoll); `heute` der Kalendertag der Bühne.
 */
export function bewertungBuehne(stand: 'leer' | 'voll', ich = 'IK', heute = stand === 'leer' ? '2026-11-04' : '2026-11-20', vieraugen = false, historieR13 = false) {
  let umfangFassung: { nr: number; s: BewertungUmfangSpeichern } | null = stand === 'voll'
    ? { nr: 1, s: { gueltig_ab: '2026-11-04', standort_ids: STANDORTE.map((x) => x.id), traeger: ['Strom', 'Gas'], ausschluesse: [], begruendung: null } }
    : null;
  const einsaetze: Energieeinsatz[] = stand === 'voll' ? ahrenbergEinsaetze() : [];
  const protokolle = new Map<string, EnergieeinsatzAenderung[]>();
  let zaehler = einsaetze.length;
  let aenderung = 100;
  let aktuelleKriterien = kriterienFassung();
  const einstufungen = new Map<string, EnergieeinsatzEinstufungFassung[]>();
  const akteur = () => ({ ...person(ich), rolle: ich === 'IK' ? 'energiemanager' : null, art: 'kunde' as const });
  const protokolliere = (id: string, art: EnergieeinsatzAenderung['art'], zeit = `${heute}T09:30:00+01:00`) =>
    protokolle.set(id, [...(protokolle.get(id) ?? []), { id: ++aenderung, art, alt: null, neu: null, akteur: akteur(), zeit }]);
  for (const e of einsaetze) protokolle.set(e.id, [{ id: ++aenderung, art: 'angelegt', alt: null, neu: null, akteur: { ...person('IK'), rolle: 'energiemanager', art: 'kunde' }, zeit: '2026-11-04T10:12:00+01:00' }]);
  if (stand === 'voll') {
    const r = ahrenbergRangliste(false, aktuelleKriterien);
    const gruende = ['41,8 % des Stromeinsatzes; größter Einsatz an beiden Hallen.', '5,2 %; Montage läuft an zwei Standorten.', '8,6 % — unter der Schwelle; Querschnitt für Spritzguss und Montage, Leckageverluste vermutet.', '3,3 % im Oktober.', '4,2 % im Oktober.', '4,7 %; Ladepark 2027 erhöht ihn — Wiedervorlage.', 'Gas ohne Anteil; nur Bürobeheizung.'];
    for (const e of [...r.einsaetze, ...r.weitere_traeger]) {
      const n = Number(e.kennzeichen.slice(3));
      const wesentlich = n === 1 || n === 3;
      einstufungen.set(e.id, [{ fassung: 1, einstufung: wesentlich ? 'wesentlich' : 'nicht_wesentlich', begruendung: gruende[n - 1], grund: n === 1 ? ['K1'] : n === 3 ? ['K4'] : [], herkunft: e.herkunft,
        vorgeschlagen_ab: '2026-11-06', gueltig_ab: '2026-11-06', gueltig_bis: null, rueckwirkend: false, akteur: ikAkteur(), vieraugen: false,
        freigabe_status: 'freigegeben', entschieden_von: null, entschieden_am: null, created_at: '2026-11-06T10:00:00+01:00' }]);
    }
    if (historieR13) {
      const ee3 = r.einsaetze.find((e) => e.kennzeichen === 'EE-3')!;
      const f1 = einstufungen.get(ee3.id)![0];
      einstufungen.set(ee3.id, [
        { ...f1, fassung: 3, einstufung: 'nicht_wesentlich', grund: ['K1', 'K2'], vorgeschlagen_ab: '2028-11-20', gueltig_ab: '2028-11-20', gueltig_bis: null,
          begruendung: 'Leckagen beseitigt; 6,2 %, hinter dem 80-%-Block; Wiedervorlage 2029.', created_at: '2028-11-20T10:00:00+01:00', herkunft: { ...f1.herkunft, zeitraum: '2027-11/2028-10' } },
        { ...f1, fassung: 2, grund: ['K2'], vorgeschlagen_ab: '2027-11-24', gueltig_ab: '2027-11-24', gueltig_bis: '2028-11-19',
          begruendung: 'Der belastbare 80-%-Block trägt die Einstufung.', created_at: '2027-11-24T10:00:00+01:00', herkunft: { ...f1.herkunft, zeitraum: '2026-11/2027-10' } },
        { ...f1, gueltig_bis: '2027-11-23' },
      ]);
    }
  }
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
    bewertungRangliste: async () => structuredClone(ahrenbergRangliste(stand === 'leer' && einsaetze.length === 0, aktuelleKriterien)),
    // AP-16 IP-18: Messabdeckung (§5.3) und der Weg Messstelle → führende Quelle → Messmittel (R8: MS-07 an GR-5 ohne
    // Angabe, MS-06 an Z-5b mit Werksbescheinigung). Die übrigen Messstellen haben auf der Bühne keine führende Quelle.
    bewertungMessabdeckung: async () => structuredClone(ahrenbergMessabdeckung()),
    messstelleQuellen: async (id: string) => {
      const kz = ahrenbergRegister().register.find((r) => r.id === id)?.kennzeichen ?? '';
      const geraet = FUEHREND_GERAET[kz];
      return {
        messstelle_id: id, kennzeichen: kz, stichtag: `${heute}T12:00:00+01:00`, quellen: [],
        groessen: [{ groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand', hauptgroesse: true, lebenszyklus: 'aktiv',
          fuehrend: geraet ? { geraet: { id: geraet.id, geraet: geraet.kz, einbau: geraet.einbau } } : null, vergleich: [], zeitstrahl: [] }],
      } as unknown as MessstelleQuellenListe;
    },
    geraetMessmittel: async (id: string) => structuredClone(id === GR5_ID ? gr5Messmittel() : z5bMessmittel(id)),
    bewertungKriterien: async () => structuredClone(aktuelleKriterien),
    bewertungKriterienSpeichern: async (s: BewertungKriterienSpeichern) => {
      if (!s.begruendung.trim()) throw fehler(422, 'begruendung_fehlt', 'Bitte geben Sie eine Begründung an.');
      aktuelleKriterien = kriterienFassung(aktuelleKriterien.fassung + 1, s.werte, s.begruendung.trim());
      return structuredClone(aktuelleKriterien);
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
    energieeinsatzEinstufungen: async (id: string) => ({ fassungen: structuredClone(einstufungen.get(finde(id).id) ?? []) }),
    energieeinsatzEinstufen: async (id: string, s: EnergieeinsatzEinstufungSpeichern) => {
      finde(id);
      if (!s.begruendung.trim()) throw fehler(422, 'begruendung_fehlt', 'Bitte geben Sie eine Begründung an.');
      const alt = einstufungen.get(id) ?? [];
      const f: EnergieeinsatzEinstufungFassung = { ...s, begruendung: s.begruendung.trim(), fassung: (alt[0]?.fassung ?? 0) + 1,
        vorgeschlagen_ab: heute, gueltig_ab: vieraugen ? null : heute, gueltig_bis: null, rueckwirkend: false, akteur: akteur(), vieraugen,
        freigabe_status: vieraugen ? 'beantragt' : 'freigegeben', entschieden_von: null, entschieden_am: null, created_at: `${heute}T10:00:00+01:00` };
      einstufungen.set(id, [f, ...alt]);
      return structuredClone(f);
    },
    energieeinsatzEinstufungBestaetigen: async (id: string) => {
      const alt = einstufungen.get(finde(id).id) ?? [];
      const offen = alt.find((f) => f.freigabe_status === 'beantragt');
      if (!offen) throw fehler(409, 'bereits_entschieden', 'Es wartet keine Einstufung auf Bestätigung.');
      if (offen.akteur.sub === akteur().sub) throw fehler(403, 'zweite_person_noetig', 'Eine zweite Person muss bestätigen.');
      const f = { ...offen, gueltig_ab: heute, freigabe_status: 'freigegeben' as const, entschieden_von: akteur(), entschieden_am: `${heute}T11:00:00+01:00` };
      einstufungen.set(id, alt.map((x) => x.fassung === f.fassung ? f : x));
      return structuredClone(f);
    },
  };
}
