/**
 * UEMS AP-18 IP-13: Antworten der Maßnahme-Routen (IP-10, OpenAPI `Massnahme*`) für Tests und die E2E-Bühne
 * `e2e/massnahmen.tsx` — Referenzunternehmen Ahrenberg 1.9, R3, R7, R9: M-2028-0001 „Werkzeugheizungen in
 * Betriebspausen abschalten“ (Murat Demirci, Termin 31.01.2028, KZ-0004 × BB-0001 Fassung 2, Ausgangslage Dezember 2027
 * +12,9 % als Kopie mit Prüfsumme, EZ-2028-0001, erwartet 3 % weniger; umgesetzt am 22.01.2028) und M-2028-0002
 * „Druckluft-Leckagen orten und beseitigen“ an EE-3 ohne Messgrundlage (Ines Kaltenbach, Termin 29.02.2028; am
 * 15.03.2028 überfällig seit 15 Tagen). Zahlen, Sätze und Fristen stellt hier die Fixture — das Portal rechnet keine.
 * Die Ablehnungen spielen die Regeln der Route nach (Zahl ohne Messgrundlage, Tag in der Zukunft, nicht geplant).
 */
import {
  ApiError,
  type api,
  type Energieeinsatz,
  type Massnahme,
  type MassnahmeBewertung,
  type MassnahmeEintrag,
  type MassnahmeWirkung,
  type VorgangAnstoss,
} from '../api';
import type { BenutzerEintrag } from '../benutzer';
import type { BezugsbasisVergleich, BezugsbasisVergleichMonat, VergleichRichtung, VergleichUrteil } from '../bezugsbasisVergleich';
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
    bewertung: null,
    bewertung_antrag: null,
    anstoesse: [],
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
    bewertung: null,
    bewertung_antrag: null,
    anstoesse: [],
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

export type MassnahmeLage = 'leer' | 'geplant' | 'r9' | 'r5' | 'r6' | 'r12' | 'antrag';

/**
 * Die Routen der Maßnahme im Gedächtnis: `leer` (keine) · `geplant` (M-2028-0001 geplant, Abruf 20.01.2028) · `r9`
 * (M-2028-0001 umgesetzt, M-2028-0002 überfällig seit 15 Tagen, Abruf 15.03.2028). `heute` ist der Tag der Route.
 */
export function massnahmeBuehne(
  lage: MassnahmeLage,
  heute: string,
  name = 'Ines Kaltenbach',
  { sub = 'IK', vieraugen = false }: { sub?: string; vieraugen?: boolean } = {},
): Partial<typeof api> {
  const start: Massnahme[] =
    lage === 'leer' ? [] : lage === 'geplant' ? [m1(heute)] : lage === 'r9' ? [m1Umgesetzt(heute), m2(heute)] : wirkungLage(lage, heute);
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
  const staende = new Map<string, MassnahmeBewertung[]>(
    start.map((m) => [m.id, [...(m.bewertung ? [m.bewertung] : []), ...(m.bewertung_antrag ? [m.bewertung_antrag] : [])]]),
  );
  const ich = { sub, name };
  const amJetzt = `${heute}T10:00:00+01:00`;
  /** Stand Nr. n wie IP-12: Satz der Route am bewerteten Stand, Kopie und Prüfsumme nur mit Messgrundlage. */
  const stand = (m: Massnahme, over: Partial<MassnahmeBewertung>): MassnahmeBewertung => {
    const nr = (staende.get(m.id)?.length ?? 0) + 1;
    return {
      stand_nr: nr, status: 'bewertet', ergebnis: 'belegt', begruendung: '', vieraugen: false, person: ich, am: amJetzt,
      entscheidung: null, entschieden_am: null, entscheidungs_begruendung: null,
      kopie: m.messgrundlage ? KOPIE_R6 : null, pruefsumme: m.messgrundlage ? PRUEFSUMME_R6 : null, satz: null, ...over,
    };
  };
  const mitSatz = (b: MassnahmeBewertung): MassnahmeBewertung =>
    b.status !== 'bewertet' ? { ...b, satz: null } : { ...b, satz: standSatzR6(b.ergebnis, b.person.name, b.am.slice(0, 10), b.begruendung, b.stand_nr) };
  /** `bewerten` (auch über `neu_bewertet`): mit Vier-Augen wird der Stand ein Antrag, sonst bewertet. */
  const bewerten = (m: Massnahme, ergebnis: MassnahmeBewertung['ergebnis'], begruendung: string, alsAntrag: boolean): Massnahme => {
    if (m.zustand !== 'umgesetzt' && m.zustand !== 'bewertet') throw new ApiError(409, 'massnahme_nicht_umgesetzt', { code: 'massnahme_nicht_umgesetzt' });
    if (begruendung.trim().length < 10 || begruendung.trim().length > 500) throw new ApiError(422, 'begruendung_fehlt', { code: 'begruendung_fehlt' });
    if (!m.messgrundlage && ergebnis !== 'nicht_messbar') throw new ApiError(422, 'ohne_messgrundlage', { code: 'ohne_messgrundlage' });
    if (m.bewertung_antrag) throw new ApiError(409, 'bewertung_beantragt', { code: 'bewertung_beantragt' });
    const b = stand(m, { ergebnis, begruendung: begruendung.trim(), status: alsAntrag ? 'beantragt' : 'bewertet', vieraugen: alsAntrag });
    staende.set(m.id, [...(staende.get(m.id) ?? []), mitSatz(b)]);
    return alsAntrag
      ? { ...m, bewertung_antrag: b, verlauf: weiter(m, 'bewertung_beantragt', { begruendung: b.begruendung }) }
      : { ...m, zustand: 'bewertet', bewertung: mitSatz(b), verlauf: weiter(m, 'massnahme_bewertet', { begruendung: b.begruendung }) };
  };
  return {
    massnahmeWirkung: async (id) => wirkungDer(holen(id), heute),
    massnahmeBewertungen: async (id) => {
      const m = holen(id);
      return { id: m.id, kennzeichen: m.kennzeichen, zustand: m.zustand, bewertungen: staende.get(id) ?? [] };
    },
    massnahmeBewertung: async (id, schritt, body) => {
      const m = holen(id);
      // Wie IP-12: mit Vier-Augen lehnt `bewerten` ab (409 `vieraugen_beantragen`), ohne lehnt `beantragen` ab.
      if (schritt === 'bewerten' && vieraugen) throw new ApiError(409, 'vieraugen_beantragen', { code: 'vieraugen_beantragen' });
      if (schritt === 'beantragen' && !vieraugen) throw new ApiError(409, 'vieraugen_aus', { code: 'vieraugen_aus' });
      let neu: Massnahme;
      if (schritt === 'bewerten' || schritt === 'beantragen') {
        neu = bewerten(m, body.ergebnis!, body.begruendung ?? '', schritt === 'beantragen');
      } else {
        const antrag = m.bewertung_antrag;
        if (!antrag) throw new ApiError(409, 'bewertung_nicht_beantragt', { code: 'bewertung_nicht_beantragt' });
        if (antrag.person.sub === sub) throw new ApiError(422, 'vieraugen_urheber', { code: 'vieraugen_urheber' });
        if (m.verantwortlich.sub === sub) throw new ApiError(422, 'vieraugen_verantwortlich', { code: 'vieraugen_verantwortlich' });
        const text = body.begruendung?.trim() || null;
        if (schritt === 'ablehnen' && (!text || text.length < 10)) throw new ApiError(422, 'begruendung_fehlt', { code: 'begruendung_fehlt' });
        const entschieden = { ...antrag, entscheidung: ich, entschieden_am: amJetzt, entscheidungs_begruendung: text };
        const b = mitSatz({ ...entschieden, status: schritt === 'freigeben' ? 'bewertet' : 'abgelehnt' });
        staende.set(id, (staende.get(id) ?? []).map((x) => (x.stand_nr === b.stand_nr ? b : x)));
        neu =
          schritt === 'freigeben'
            ? { ...m, zustand: 'bewertet', bewertung: b, bewertung_antrag: null, verlauf: weiter(m, 'massnahme_bewertet', { begruendung: text }) }
            : { ...m, bewertung_antrag: null, verlauf: weiter(m, 'bewertung_abgelehnt', { begruendung: text }) };
      }
      liste.set(id, neu);
      return neu;
    },
    // IP-17-NAHT (M5): `bleibt` mit Begründung · `neu_kopiert` nur an der Ausgangslage · `neu_bewertet` wie `bewerten`.
    massnahmeAnstossAntwort: async (id, aid, body) => {
      const m = holen(id);
      const a = (m.anstoesse ?? []).find((x) => x.id === aid);
      if (!a) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
      if (a.zustand !== 'offen') throw new ApiError(409, 'anstoss_beantwortet', { code: 'anstoss_beantwortet' });
      if ((body.antwort === 'neu_kopiert') !== (a.art === 'ausgangslage_korrigiert') && body.antwort !== 'bleibt') {
        throw new ApiError(422, 'antwort_passt_nicht', { code: 'antwort_passt_nicht' });
      }
      const t = body.begruendung?.trim() ?? '';
      if (body.antwort === 'bleibt' && (t.length < 10 || t.length > 500)) throw new ApiError(422, 'begruendung_fehlt', { code: 'begruendung_fehlt' });
      const basis = body.antwort === 'neu_bewertet' ? bewerten(m, body.ergebnis as MassnahmeBewertung['ergebnis'], t, vieraugen) : m;
      const beantwortet: VorgangAnstoss = { ...a, zustand: 'beantwortet', antwort: body.antwort, antwort_begruendung: t || null, beantwortet_am: amJetzt, beantwortet_von: name };
      const neu: Massnahme = {
        ...basis,
        anstoesse: (m.anstoesse ?? []).map((x) => (x.id === aid ? beantwortet : x)),
        verlauf: [...(basis.verlauf ?? []), eintrag((basis.verlauf?.length ?? 0) + 1, 'anstoss_beantwortet', name, amJetzt, { begruendung: t || null })],
      };
      liste.set(id, neu);
      return neu;
    },
    massnahmen: async () => ({ abruf: heute, massnahmen: [...liste.values()].map((m) => ({ ...m, anstoesse: null, verlauf: null })) }),
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

// ------------------------------------------------------------------ IP-20: Wirkung (R5), Stand (R6), R7, Anstoß (R12)

/** R6 (Referenzdatei 1.9 `massnahmen[0].bewertungen[0]`): Begründung und Prüfsumme der Kopie. */
export const BEGRUENDUNG_R6 =
  'Zeitschaltung seit 22.01.2028 aktiv, Laufzeit der Werkzeugheizungen laut Steuerung 18 % niedriger; keine andere Änderung am Prozess Spritzguss im Zeitraum.';
export const PRUEFSUMME_R6 = 'sha256:4635f20ac0ef79c28d33bc0ce5314cc3402ef71cd0a5cc1ef98e76d2f3ed76a3';
const KOPIE_R6 =
  '{"abruf":"2028-11-15","bezugsbasis":"BB-0001","erwartete_wirkung_prozent":-3.0,"fassung":2,"kennzahl":"KZ-0004","nachher":"2028-02/2029-01","umgesetzt_am":"2028-01-22"}';
/** Die Sätze der Route (IP-11/IP-12, `MassnahmeApiTest`) — wörtlich. */
export const SATZ_WIRKUNG_R5 =
  'Wirkung von M-2028-0001, beobachtet: 2,4 % weniger Strom als die Bezugsbasis erwarten lässt (Februar bis Oktober 2028, 8 von 12 Monaten; März 2028 nicht bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis) — erwartet waren 3 % weniger. Ob die Maßnahme das bewirkt hat, sagt eine Person.';
export const SATZ_JANUAR_R6 = 'Januar 2028: Umsetzungsmonat — nicht gezählt.';
export const SATZ_MAERZ_R5 = 'März 2028: nicht bewertbar — Produktionsmenge Spritzguss 390 000 kg außerhalb der Bezugsbasis (228 600–375 100 kg).';
export const SATZ_BELEGT_R6 = `Belegt von Ines Kaltenbach am 15.11.2028: ‚${BEGRUENDUNG_R6}‘ Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. 1, Prüfsumme 4635…`;
export const BEGRUENDUNG_R7 = 'Keine Messgrundlage: Druckluft hat keine Energieleistungskennzahl.';
export const SATZ_NICHT_MESSBAR_R7 = `Bewertet am 20.11.2028 von Ines Kaltenbach: nicht messbar — ‚${BEGRUENDUNG_R7}‘`;
export const BEGRUENDUNG_R12 =
  'Version 2 ändert die Ausgangslage um 0,9 Punkte; die Maßnahme und ihre erwartete Wirkung bleiben, wie sie angelegt wurden — der Stand des Leistungsvergleichs wird revidiert.';
const KENNZEICHEN_R5 = ['bereinigt um Produktionsmenge (Modell mit einer Einflussgröße, Bezugsbasis BB-0001, Fassung 2; Streuung ± 0,8 %)', '8 von 12 Monaten'];

const tagDe = (iso: string) => iso.split('-').reverse().join('.');
/** Der Satz eines bewerteten Stands wie IP-12 (`bewertung_belegt`, `bewertung_nicht_messbar`; `nicht_belegt` hat keinen). */
function standSatzR6(ergebnis: MassnahmeBewertung['ergebnis'], person: string, am: string, begruendung: string, nr: number): string | null {
  if (ergebnis === 'belegt') return `Belegt von ${person} am ${tagDe(am)}: ‚${begruendung}‘ Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. ${nr}, Prüfsumme 4635…`;
  if (ergebnis === 'nicht_messbar') return `Bewertet am ${tagDe(am)} von ${person}: nicht messbar — ‚${begruendung}‘`;
  return null;
}

/** R12: K-2028-0001 trifft die Ausgangslage (Dezember 2027, Version 1 → 2) — ein Anstoß an M-2028-0001. */
export const ANSTOSS_R12: VorgangAnstoss = {
  id: 'ab000000-0000-4000-8000-00000000a012',
  art: 'ausgangslage_korrigiert',
  anlass_kennung: 'K-2028-0001',
  angestossen_am: '2028-04-03T09:20:00+02:00',
  zustand: 'offen',
  antwort: null,
  antwort_begruendung: null,
  beantwortet_am: null,
  beantwortet_von: null,
};

const MONATE_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const beschriftung = (p: string) => `${MONATE_DE[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

/** Ein Monat des Vergleich-Lesers an KZ-0004 (R5-Zahlen der Referenzdatei 1.9); ohne `kwh` noch nicht endgültig. */
function vm(periode: string, kwh: string | null, kg: string | null, erwartet: string | null, delta: string | null, urteil: VergleichUrteil, grund: BezugsbasisVergleichMonat['bereinigt']['grund'] = null): BezugsbasisVergleichMonat {
  const richtung: VergleichRichtung | null = delta === null ? null : delta.startsWith('-') ? 'weniger' : 'mehr';
  return {
    periode,
    beschriftung: beschriftung(periode),
    roh: { gemessen: kwh, vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null, urteil: 'ohne_urteil' },
    bereinigt: {
      fassung: { fassung: 2, methode: 'regression_eine_variable', referenzperiode: '2026-11/2027-10', datenlage: 'vollstaendig', gilt_ab: '2027-11-01', gilt_bis: null },
      gemessen: { wert: kwh, einheit: 'kWh', version: kwh === null ? null : 1, zustand: kwh === null ? null : 'vollstaendig' },
      bedingung: kg === null ? [] : [{ position: 1, quelle: 'bezugsgroesse', kennzeichen: 'BZ-1', name: 'Produktionsmenge Spritzguss', wert: kg, einheit: 'kg', fassung: 1, version: 1, zustand: 'vollstaendig' }],
      erwartet,
      delta_prozent: delta,
      band_prozent: '2.0',
      richtung,
      urteil,
      grund,
      kennzeichen: KENNZEICHEN_R5.slice(0, 1),
    },
    satz: '',
  } as BezugsbasisVergleichMonat;
}

/**
 * R5 am 15.11.2028: Umsetzungsmonat Januar 2028 (−3,5 %, „besser“ — VOR der Umsetzung, zählt nicht, R6), Februar bis
 * Oktober endgültig (März nicht bewertbar), November 2028 bis Januar 2029 noch nicht endgültig. Die Januar-Menge ist
 * auf der Bühne frei gewählt (die Referenzdatei nennt nur −3,5 %). Summe und Satz wie `MassnahmeApiTest`.
 */
export function wirkungR5(m: Massnahme, abruf = '2028-11-15'): MassnahmeWirkung {
  const zeilen: [string, string | null, string | null, string | null, string | null, VergleichUrteil][] = [
    ['2028-01', '78000', '300000', '80813', '-3.5', 'besser'],
    ['2028-02', '81500', '305000', '81985', '-0.6', 'im_rahmen'],
    ['2028-03', '100000', '390000', null, null, 'nicht_anwendbar'],
    ['2028-04', '81900', '318000', '85030', '-3.7', 'besser'],
    ['2028-05', '83900', '326000', '86905', '-3.5', 'besser'],
    ['2028-06', '85100', '331000', '88076', '-3.4', 'besser'],
    ['2028-07', '73700', '262000', '71910', '2.5', 'schlechter'],
    ['2028-08', '67800', '254000', '70035', '-3.2', 'besser'],
    ['2028-09', '86000', '335000', '89014', '-3.4', 'besser'],
    ['2028-10', '87100', '340000', '90185', '-3.4', 'besser'],
    ['2028-11', null, null, null, null, 'ohne_urteil'],
    ['2028-12', null, null, null, null, 'ohne_urteil'],
    ['2029-01', null, null, null, null, 'ohne_urteil'],
  ];
  const monate = zeilen.map(([periode, kwh, kg, erwartet, delta, urteil]) => {
    const endgueltig = kwh !== null;
    const grund = periode === '2028-01' ? ('umsetzungsmonat' as const) : periode === '2028-03' ? ('variable_ausserhalb' as const) : null;
    return {
      periode,
      endgueltig,
      gezaehlt: endgueltig && grund === null,
      grund,
      satz: periode === '2028-01' ? SATZ_JANUAR_R6 : periode === '2028-03' ? SATZ_MAERZ_R5 : null,
      kennzahl_roh: kwh && kg ? String(Number(kwh) / Number(kg)) : null,
      vergleich: vm(periode, kwh, kg, erwartet, delta, urteil, periode === '2028-03' ? 'variable_ausserhalb' : null),
    };
  });
  return {
    massnahme: m, abruf, grund: null, umsetzungsmonat: '2028-01', nachher_von: '2028-02', nachher_bis: '2029-01', monate,
    monate_bewertbar: 8, monate_endgueltig: 9, monate_soll: 12, monate_text: '8 von 12', vorlaeufig: true,
    nicht_gezaehlt: [{ monat: '2028-01', grund: 'umsetzungsmonat' }, { monat: '2028-03', grund: 'variable_ausserhalb' }],
    summe: { gemessen: '647000', erwartet: '663139.2', delta_prozent: '-2.4', band_prozent: '2.0', richtung: 'weniger', urteil: 'besser', kennzeichen: KENNZEICHEN_R5 },
    satz: SATZ_WIRKUNG_R5,
  };
}

/** Die Wirkung-Route der Bühne: mit Messgrundlage R5, ohne nur der Satz (M4), vor der Umsetzung nichts. */
function wirkungDer(m: Massnahme, abruf: string): MassnahmeWirkung {
  const leer = {
    massnahme: m, abruf, umsetzungsmonat: null, nachher_von: null, nachher_bis: null, monate: [], monate_bewertbar: null,
    monate_endgueltig: null, monate_soll: null, monate_text: null, vorlaeufig: null, nicht_gezaehlt: [], summe: null,
  };
  if (!m.messgrundlage) return { ...leer, grund: 'ohne_messgrundlage', satz: m.ohne_messgrundlage?.satz ?? null };
  if (!m.umgesetzt_am) return { ...leer, grund: 'nicht_umgesetzt', satz: null };
  return wirkungR5(m, abruf);
}

/**
 * Die IP-20-Lagen am 15.11.2028: `r5` (M-2028-0001 umgesetzt ohne Stand — „beobachtet — nicht belegt“; der Anstoß aus
 * R12 schon beantwortet; M-2028-0002 ohne Messgrundlage umgesetzt, R7) · `r6` (Stand Nr. 1 „belegt“) · `r12` (der
 * Anstoß „Ausgangslage korrigiert“ noch offen — auf der Bühne, damit die Knöpfe sichtbar sind) · `antrag` (Vier-Augen:
 * Jonas Wendlinger hat „belegt“ beantragt; eine zweite Person bestätigt).
 */
function wirkungLage(lage: MassnahmeLage, abruf: string): Massnahme[] {
  const basis = m1Umgesetzt(abruf);
  const beantwortet: VorgangAnstoss = {
    ...ANSTOSS_R12, zustand: 'beantwortet', antwort: 'bleibt', antwort_begruendung: BEGRUENDUNG_R12, beantwortet_am: '2028-04-05T11:00:00+02:00', beantwortet_von: 'Ines Kaltenbach',
  };
  const stand1: MassnahmeBewertung = {
    stand_nr: 1, status: 'bewertet', ergebnis: 'belegt', begruendung: BEGRUENDUNG_R6, vieraugen: false, person: IK, am: '2028-11-15T10:00:00+01:00',
    entscheidung: null, entschieden_am: null, entscheidungs_begruendung: null, kopie: KOPIE_R6, pruefsumme: PRUEFSUMME_R6, satz: SATZ_BELEGT_R6,
  };
  const m1x: Massnahme = {
    ...basis,
    anstoesse: [lage === 'r12' ? ANSTOSS_R12 : beantwortet],
    ...(lage === 'r6' ? { zustand: 'bewertet' as const, bewertung: stand1 } : {}),
    ...(lage === 'antrag'
      ? { bewertung_antrag: { ...stand1, status: 'beantragt' as const, vieraugen: true, person: { sub: 'JW', name: 'Jonas Wendlinger' }, satz: null } }
      : {}),
  };
  const m2x: Massnahme = {
    ...m2(abruf),
    zustand: 'umgesetzt',
    umgesetzt_am: '2028-03-20',
    umgesetzt_begruendung: 'Leckagen an 14 Stellen geortet und abgedichtet.',
    frist: keineFrist(abruf, '2028-02-29'),
    kopf_satz: 'M-2028-0002 · Druckluft-Leckagen orten und beseitigen · Verantwortlich Ines Kaltenbach · Termin 29.02.2028 · umgesetzt am 20.03.2028.',
  };
  return [m1x, m2x];
}
