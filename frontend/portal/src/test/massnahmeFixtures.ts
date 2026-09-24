/**
 * UEMS AP-18 IP-13: Antworten der Maßnahme-Routen (IP-10, OpenAPI `Massnahme*`) für Tests und die E2E-Bühne
 * `e2e/massnahmen.tsx` — Referenzunternehmen Ahrenberg 1.9, R3, R7, R9: M-2028-0001 „Werkzeugheizungen in
 * Betriebspausen abschalten“ (Murat Demirci, Termin 31.01.2028, KZ-0004 × BB-0001 Fassung 2, Ausgangslage Dezember 2027
 * +12,9 % als Kopie mit Prüfsumme, EZ-2028-0001, erwartet 3 % weniger; umgesetzt am 22.01.2028) und M-2028-0002
 * „Druckluft-Leckagen orten und beseitigen“ an EE-3 ohne Messgrundlage (Ines Kaltenbach, Termin 29.02.2028; am
 * 15.03.2028 überfällig seit 15 Tagen). Zahlen, Sätze und Fristen stellt hier die Fixture — das Portal rechnet keine.
 * Die Ablehnungen spielen die Regeln der Route nach (Zahl ohne Messgrundlage, Tag in der Zukunft, nicht geplant).
 */
import { ApiError, type api, type Energieeinsatz, type Massnahme, type MassnahmeEintrag } from '../api';
import type { BenutzerEintrag } from '../benutzer';
import type { BezugsbasisVergleich } from '../bezugsbasisVergleich';
import { BB_IDS } from './bezugsbasisFixtures';
import { EZ_IDS } from './energiezielFixtures';
import { R2_DEZEMBER, R2_NOVEMBER, vergleichR2 } from './bezugsbasisVergleichFixtures';

export const M_IDS = {
  m1: 'a7000000-0000-4000-8000-000000000001',
  m2: 'a7000000-0000-4000-8000-000000000002',
  neu: 'a7000000-0000-4000-8000-0000000000aa',
  ee1: 'ee000000-0000-4000-8000-000000000001',
  ee3: 'ee000000-0000-4000-8000-000000000003',
} as const;

const MD = { sub: 'MD', name: 'Murat Demirci' };
const IK = { sub: 'IK', name: 'Ines Kaltenbach' };
export const PRUEFSUMME_R3 = 'sha256:9d2c7a41e0b35f86c1a4d7e92b0f3c58a6e1d4b7c09f2a35e8d6b1c4f7a90e23';
const AUSGANGSLAGE_R3 =
  '{"fassung":2,"kennzahl":"KZ-0004","monate":[{"periode":"2027-12","gemessen":"78000","version":1,"erwartet":"69098","delta_prozent":"12.9","urteil":"schlechter","band_prozent":"2.0"}]}';
export const SATZ_MESSGRUNDLAGE_R3 =
  'Messgrundlage: KZ-0004 Stromeinsatz Spritzguss je kg, Bezugsbasis BB-0001, Fassung 2 — bereinigt um Produktionsmenge (Modell mit einer Einflussgröße). Ausgangslage Dezember 2027: 12,9 % mehr als erwartet (Version 1, Kopie vom 15.01.2028). Erwartete Wirkung: 3 % weniger — ‚Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.‘';
export const SATZ_OHNE_R7 =
  'M-2028-0002 · Druckluft-Leckagen orten und beseitigen · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht Druckluft eine Energieleistungskennzahl (zum Beispiel Stromeinsatz je Betriebsstunde mit einer Bezugsbasis).';
export const KOPF_R3 =
  'M-2028-0001 · Werkzeugheizungen in Betriebspausen abschalten · Verantwortlich Murat Demirci · Termin 31.01.2028 · umgesetzt am 22.01.2028.';
export const UEBERFAELLIG_R9 = 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.';
const OHNE_KENNZEICHEN = 'ohne Messgrundlage — Wirkung nicht messbar';

const KZ4 = { id: BB_IDS.kz4, kennzeichen: 'KZ-0004', name: 'Stromeinsatz Spritzguss je kg' };
const BB1 = { id: BB_IDS.bb1, kennzeichen: 'BB-0001', name: null };
const EZ1 = { id: EZ_IDS.ez1, kennzeichen: 'EZ-2028-0001', name: 'Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt' };

const eintrag = (nr: number, art: MassnahmeEintrag['art'], person: string, am: string, over: Partial<MassnahmeEintrag> = {}): MassnahmeEintrag => ({
  nr, art, alt: null, neu: null, begruendung: null, kommentar: null, person, am, ...over,
});

const keineFrist = (abruf: string, termin: string): Massnahme['frist'] => ({ abruf, termin, faellig: null, seit_tagen: null, satz: null });

/** R3: M-2028-0001 mit Messgrundlage, aus AW-2028-0001; `umgesetzt` nach R3 (22.01.2028). */
export function m1(abruf = '2028-01-20', over: Partial<Massnahme> = {}): Massnahme {
  return {
    id: M_IDS.m1,
    kennzeichen: 'M-2028-0001',
    titel: 'Werkzeugheizungen in Betriebspausen abschalten',
    verantwortlich: MD,
    termin: '2028-01-31',
    standort_id: null,
    zustand: 'geplant',
    herkunft: { art: 'abweichung', kennung: 'AW-2028-0001' },
    messgrundlage: {
      kennzahl: KZ4,
      bezugsbasis: BB1,
      fassung: 2,
      bewertungsmethode: 'bereinigt um Produktionsmenge (Modell mit einer Einflussgröße, Bezugsbasis BB-0001, Fassung 2)',
      ausgangslage: AUSGANGSLAGE_R3,
      pruefsumme: PRUEFSUMME_R3,
      ausgangslage_inhalt: JSON.parse(AUSGANGSLAGE_R3) as Record<string, unknown>,
      satz: SATZ_MESSGRUNDLAGE_R3,
    },
    ohne_messgrundlage: null,
    einsatz: { id: M_IDS.ee1, kennzeichen: 'EE-1', name: 'Spritzguss' },
    einstufung_fassung: 1,
    energieziel: EZ1,
    erwartete_wirkung_prozent: '-3.0',
    erwartete_wirkung_wortlaut: 'Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.',
    angelegt_am: '2028-01-15',
    umgesetzt_am: null,
    umgesetzt_begruendung: null,
    verworfen_am: null,
    verworfen_grund: null,
    frist: keineFrist(abruf, '2028-01-31'),
    kopf_satz: null,
    verlauf: [
      eintrag(1, 'massnahme_angelegt', 'Ines Kaltenbach', '2028-01-15T10:12:00+01:00'),
      eintrag(2, 'kommentar', 'Murat Demirci', '2028-01-17T08:40:00+01:00', {
        kommentar: 'Zeitschaltung für die Maschinen 3 bis 6 ist bestellt; Einbau in der nächsten Betriebspause.',
      }),
    ],
    ...over,
  };
}

export function m1Umgesetzt(abruf = '2028-03-15'): Massnahme {
  const m = m1(abruf);
  return {
    ...m,
    zustand: 'umgesetzt',
    umgesetzt_am: '2028-01-22',
    umgesetzt_begruendung: 'Zeitschaltung an den Maschinen 3 bis 6 aktiv, Probelauf ohne Befund.',
    kopf_satz: KOPF_R3,
    verlauf: [
      ...(m.verlauf ?? []),
      eintrag(3, 'massnahme_umgesetzt', 'Murat Demirci', '2028-01-22T16:05:00+01:00', {
        begruendung: 'Zeitschaltung an den Maschinen 3 bis 6 aktiv, Probelauf ohne Befund.',
      }),
    ],
  };
}

/** R7/R9: M-2028-0002 ohne Messgrundlage an EE-3; am 15.03.2028 überfällig seit 15 Tagen. */
export function m2(abruf = '2028-03-15'): Massnahme {
  const ueberfaellig = abruf > '2028-02-29';
  return {
    id: M_IDS.m2,
    kennzeichen: 'M-2028-0002',
    titel: 'Druckluft-Leckagen orten und beseitigen',
    verantwortlich: IK,
    termin: '2028-02-29',
    standort_id: null,
    zustand: 'geplant',
    herkunft: { art: 'einsatz', kennung: 'EE-3' },
    messgrundlage: null,
    ohne_messgrundlage: { kennzeichen: OHNE_KENNZEICHEN, hinweis: 'Druckluft: zum Beispiel Stromeinsatz je Betriebsstunde', satz: SATZ_OHNE_R7 },
    einsatz: { id: M_IDS.ee3, kennzeichen: 'EE-3', name: 'Druckluft' },
    einstufung_fassung: 2,
    energieziel: null,
    erwartete_wirkung_prozent: null,
    erwartete_wirkung_wortlaut: 'Leckagen verursachen erfahrungsgemäß einen großen Teil des Druckluft-Stroms außerhalb der Produktion.',
    angelegt_am: '2028-01-20',
    umgesetzt_am: null,
    umgesetzt_begruendung: null,
    verworfen_am: null,
    verworfen_grund: null,
    frist: ueberfaellig
      ? { abruf, termin: '2028-02-29', faellig: 'ueberfaellig', seit_tagen: 15, satz: UEBERFAELLIG_R9 }
      : keineFrist(abruf, '2028-02-29'),
    kopf_satz: null,
    verlauf: [eintrag(1, 'massnahme_angelegt', 'Ines Kaltenbach', '2028-01-20T09:30:00+01:00')],
  };
}

/** Die aktiven Konten des Kundenbereichs (dazu ein gesperrtes — es steht nicht zur Wahl). */
export function kontenAhrenberg(): BenutzerEintrag[] {
  const konto = (sub: string, anzeigename: string, zustand: BenutzerEintrag['zustand']) =>
    ({ sub, anzeigename, email: `${sub.toLowerCase()}@ahrenberg.example`, zustand, zuweisungen: [] }) as unknown as BenutzerEintrag;
  return [
    konto('IK', 'Ines Kaltenbach', 'aktiv'),
    konto('MD', 'Murat Demirci', 'aktiv'),
    konto('JW', 'Jonas Wendlinger', 'aktiv'),
    konto('AL', 'Anna Lorenz', 'gesperrt'),
  ];
}

export function einsaetzeAhrenberg(): Energieeinsatz[] {
  const e = (id: string, kennzeichen: string, name: string) =>
    ({ id, kennzeichen, name, traeger: 'Strom', beendet_am: null }) as unknown as Energieeinsatz;
  return [e(M_IDS.ee1, 'EE-1', 'Spritzguss'), e(M_IDS.ee3, 'EE-3', 'Druckluft')];
}

/** Der Vergleich-Leser an KZ-0004 über die gewählten Monate (R2-Zahlen, Dezember 2027 +12,9 %). */
export function vergleichKz4(von: string, bis: string): BezugsbasisVergleich {
  const v = vergleichR2();
  const monate = [R2_NOVEMBER, R2_DEZEMBER, ...v.monate.slice(2)].filter((m) => m.periode >= von && m.periode <= bis);
  return { ...v, kennzahl: { ...v.kennzahl, ...KZ4 }, von, bis, monate };
}

export type MassnahmeLage = 'leer' | 'geplant' | 'r9';

/**
 * Die Routen der Maßnahme im Gedächtnis: `leer` (keine) · `geplant` (M-2028-0001 geplant, Abruf 20.01.2028) · `r9`
 * (M-2028-0001 umgesetzt, M-2028-0002 überfällig seit 15 Tagen, Abruf 15.03.2028). `heute` ist der Tag der Route.
 */
export function massnahmeBuehne(lage: MassnahmeLage, heute: string, name = 'Ines Kaltenbach'): Partial<typeof api> {
  const start: Massnahme[] = lage === 'leer' ? [] : lage === 'geplant' ? [m1(heute)] : [m1Umgesetzt(heute), m2(heute)];
  const liste = new Map(start.map((m) => [m.id, m]));
  let zaehler = start.length;
  const holen = (id: string) => {
    const m = liste.get(id);
    if (!m) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
    return m;
  };
  const nurGeplant = (m: Massnahme) => {
    if (m.zustand !== 'geplant') throw new ApiError(409, 'massnahme_nicht_geplant', { code: 'massnahme_nicht_geplant' });
  };
  const weiter = (m: Massnahme, art: MassnahmeEintrag['art'], over: Partial<MassnahmeEintrag>) => [
    ...(m.verlauf ?? []),
    eintrag((m.verlauf?.length ?? 0) + 1, art, name, `${heute}T10:00:00+01:00`, over),
  ];
  const konten = kontenAhrenberg();
  return {
    massnahmen: async () => ({ abruf: heute, massnahmen: [...liste.values()].map((m) => ({ ...m, verlauf: null })) }),
    massnahme: async (id) => holen(id),
    massnahmeAnlegen: async (body) => {
      const person = konten.find((k) => k.sub === body.verantwortlich && k.zustand === 'aktiv');
      if (!person) throw new ApiError(422, 'benutzer_unbekannt', { code: 'benutzer_unbekannt' });
      if (!body.erwartete_wirkung_wortlaut?.trim()) throw new ApiError(422, 'wortlaut_fehlt', { code: 'wortlaut_fehlt' });
      if (!body.kennzahl && body.erwartete_wirkung_prozent !== undefined) {
        throw new ApiError(422, 'ohne_messgrundlage', { code: 'ohne_messgrundlage' });
      }
      zaehler += 1;
      const kennzeichen = `M-${heute.slice(0, 4)}-${String(zaehler).padStart(4, '0')}`;
      const basis = m1(heute);
      const einsatz = einsaetzeAhrenberg().find((x) => x.id === body.einsatz);
      const m: Massnahme = {
        ...basis,
        id: zaehler === 1 ? M_IDS.neu : `${M_IDS.neu.slice(0, -2)}${String(zaehler).padStart(2, '0')}`,
        kennzeichen,
        titel: body.titel,
        verantwortlich: { sub: person.sub, name: person.anzeigename },
        termin: body.termin,
        herkunft: { art: body.herkunft ?? 'von_hand', kennung: body.herkunft_kennung ?? (body.herkunft === 'energieziel' ? 'EZ-2028-0001' : body.herkunft === 'einsatz' ? (einsatz?.kennzeichen ?? null) : null) },
        messgrundlage: body.kennzahl
          ? {
              ...basis.messgrundlage!,
              satz: body.monate === '2027-12' ? basis.messgrundlage!.satz!.replace('3 % weniger — ‚Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.‘', `${body.erwartete_wirkung_prozent === undefined ? '—' : `${Math.abs(body.erwartete_wirkung_prozent)} % weniger`} — ‚${body.erwartete_wirkung_wortlaut}‘`).replace('Kopie vom 15.01.2028', `Kopie vom ${heute.split('-').reverse().join('.')}`) : null,
            }
          : null,
        ohne_messgrundlage: body.kennzahl
          ? null
          : {
              kennzeichen: OHNE_KENNZEICHEN,
              hinweis: `${einsatz?.name ?? 'dieser Energieeinsatz'}: zum Beispiel Stromeinsatz je Betriebsstunde`,
              satz: `${kennzeichen} · ${body.titel} · ${OHNE_KENNZEICHEN}. Um die Wirkung zu messen, braucht ${einsatz?.name ?? 'dieser Energieeinsatz'} eine Energieleistungskennzahl (zum Beispiel Stromeinsatz je Betriebsstunde mit einer Bezugsbasis).`,
            },
        einsatz: einsatz ? { id: einsatz.id, kennzeichen: einsatz.kennzeichen, name: einsatz.name } : null,
        einstufung_fassung: body.einstufung_fassung ?? null,
        energieziel: body.energieziel ? EZ1 : null,
        erwartete_wirkung_prozent: body.erwartete_wirkung_prozent === undefined ? null : body.erwartete_wirkung_prozent.toFixed(1),
        erwartete_wirkung_wortlaut: body.erwartete_wirkung_wortlaut,
        angelegt_am: heute,
        frist: keineFrist(heute, body.termin),
        verlauf: [eintrag(1, 'massnahme_angelegt', name, `${heute}T10:00:00+01:00`)],
      };
      liste.set(m.id, m);
      return m;
    },
    massnahmeAendern: async (id, body) => {
      const m = holen(id);
      nurGeplant(m);
      if (m.messgrundlage === null && body.erwartete_wirkung_prozent !== undefined) {
        throw new ApiError(422, 'ohne_messgrundlage', { code: 'ohne_messgrundlage' });
      }
      const neu: Massnahme = {
        ...m,
        ...(body.titel ? { titel: body.titel } : {}),
        ...(body.termin ? { termin: body.termin, frist: keineFrist(heute, body.termin) } : {}),
        ...(body.erwartete_wirkung_wortlaut ? { erwartete_wirkung_wortlaut: body.erwartete_wirkung_wortlaut } : {}),
        ...(body.erwartete_wirkung_prozent !== undefined ? { erwartete_wirkung_prozent: body.erwartete_wirkung_prozent.toFixed(1) } : {}),
        verlauf: weiter(m, 'massnahme_geaendert', { begruendung: body.begruendung }),
      };
      liste.set(id, neu);
      return neu;
    },
    massnahmeVerantwortlicher: async (id, body) => {
      const m = holen(id);
      nurGeplant(m);
      const person = konten.find((k) => k.sub === body.benutzer && k.zustand === 'aktiv');
      if (!person) throw new ApiError(422, 'benutzer_unbekannt', { code: 'benutzer_unbekannt' });
      const neu = { ...m, verantwortlich: { sub: person.sub, name: person.anzeigename }, verlauf: weiter(m, 'verantwortlicher_geaendert', { begruendung: body.begruendung }) };
      liste.set(id, neu);
      return neu;
    },
    massnahmeUmgesetzt: async (id, body) => {
      const m = holen(id);
      nurGeplant(m);
      if (body.am > heute) throw new ApiError(422, 'umgesetzt_in_der_zukunft', { code: 'umgesetzt_in_der_zukunft' });
      const am = body.am.split('-').reverse().join('.');
      const neu: Massnahme = {
        ...m,
        zustand: 'umgesetzt',
        umgesetzt_am: body.am,
        umgesetzt_begruendung: body.begruendung,
        frist: keineFrist(heute, m.termin),
        kopf_satz: `${m.kennzeichen} · ${m.titel} · Verantwortlich ${m.verantwortlich.name} · Termin ${m.termin.split('-').reverse().join('.')} · umgesetzt am ${am}.`,
        verlauf: weiter(m, 'massnahme_umgesetzt', { begruendung: body.begruendung }),
      };
      liste.set(id, neu);
      return neu;
    },
    massnahmeVerwerfen: async (id, body) => {
      const m = holen(id);
      nurGeplant(m);
      const neu: Massnahme = { ...m, zustand: 'verworfen', verworfen_am: `${heute}T10:00:00+01:00`, verworfen_grund: body.begruendung, verlauf: weiter(m, 'massnahme_verworfen', { begruendung: body.begruendung }) };
      liste.set(id, neu);
      return neu;
    },
    massnahmeKommentar: async (id, body) => {
      const m = holen(id);
      if (m.zustand !== 'geplant' && m.zustand !== 'umgesetzt') throw new ApiError(409, 'massnahme_nicht_geplant', { code: 'massnahme_nicht_geplant' });
      const neu = { ...m, verlauf: weiter(m, 'kommentar', { kommentar: body.text }) };
      liste.set(id, neu);
      return neu;
    },
    energieeinsaetze: async () => ({ energieeinsaetze: einsaetzeAhrenberg() }),
    bezugsbasisVergleich: async (_id, wahl = {}) => vergleichKz4(wahl.von ?? '2027-12', wahl.bis ?? wahl.von ?? '2027-12'),
  };
}
