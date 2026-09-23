import type { Bericht, BerichtAnstoss, BerichtDetail, BerichtEntwurf, BerichtStand, BerichtStandKurz, BerichtUeberpruefung } from '../api';
import * as B from '../uemsBericht';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * UEMS AP-16 IP-25: die Bericht-Routen der energetischen Bewertung für die Bühne `e2e/bewertung.html` und die Tests —
 * entlang R7/R10 (Referenzunternehmen Ahrenberg): Stand Nr. 1 am 09.11.2026 10:12, Korrektur K-2026-0007 am 12.11.2026
 * 10:05, Stand Nr. 2 am 17.11.2026 09:30 (ersetzt Nr. 1), Frist 17.11.2027, am 18.11.2027 „fällig seit 1 Tag“.
 *
 * Lage (`?bewertungsstand=`): `keine` (kein Bericht) · `entwurf` (angelegt, noch kein Stand) · `nr1` · `revision` (Nr. 1
 * mit offenem Anstoß K-2026-0007) · `nr2` · `faellig` (Nr. 2, Überprüfung seit 1 Tag fällig). Freigeben, Anlegen und
 * die Dateien schreiben den Zustand fort; `window.__bewertungAbrufe` zählt jeden Datei-Abruf.
 */
export type BewertungsLage = 'keine' | 'entwurf' | 'nr1' | 'revision' | 'nr2' | 'faellig';

export const BW_KENNUNG = 'BR-2026-0009';
const ZONE = 'Europe/Berlin';
const IK = { name: 'Ines Kaltenbach', rolle: 'energiemanager' };
const ANSTOSS_ID = 'a7000000-0000-4000-8000-000000000007';
const PRUEFSUMME_1 = '3b1f7c0e5d2a4b6c8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d9a2e';
const PRUEFSUMME_2 = '8c41d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a97f10';
const PRUEFSUMME_ENTWURF = '51aa00000000000000000000000000000000000000000000000000000000e0e0';

const abzug = (datenstand: string) => ({
  kopf: {
    bericht: BW_KENNUNG,
    vorlage: 'energetische_bewertung',
    vorlage_fassung: 1,
    zeitraum: { art: 'datengrundlage', schluessel: '2025-11/2026-10', zone: ZONE },
    datenstand,
    darstellung: { zeitzone: ZONE, zahlenformat: 'de-DE' },
  },
});

const stand1 = (ersetzt: boolean): BerichtStandKurz => ({
  nr: 1,
  datenstand: '2026-11-09T10:05:00+01:00',
  freigegeben_am: '2026-11-09T10:12:00+01:00',
  freigegeben_von: IK,
  pruefsumme: PRUEFSUMME_1,
  ersetzt_durch_nr: ersetzt ? 2 : null,
  anlass_anstoss_id: null,
});

const stand2 = (): BerichtStandKurz => ({
  nr: 2,
  datenstand: '2026-11-17T09:25:00+01:00',
  freigegeben_am: '2026-11-17T09:30:00+01:00',
  freigegeben_von: IK,
  pruefsumme: PRUEFSUMME_2,
  ersetzt_durch_nr: null,
  anlass_anstoss_id: ANSTOSS_ID,
});

const anstoss = (erledigt: boolean): BerichtAnstoss => ({
  id: ANSTOSS_ID,
  nr: 1,
  art: 'korrektur_freigegeben',
  anlass_kennung: 'K-2026-0007',
  anlass_fassung: null,
  anlass_text: B.anlass('K-2026-0007'),
  erkannt_am: '2026-11-12T10:05:33+01:00',
  zustand: erledigt ? 'erledigt' : 'offen',
  erledigt_durch_nr: erledigt ? 2 : null,
  verworfen_begruendung: null,
  verworfen_von: null,
  verworfen_am: null,
});

const ueberpruefung = (s: BerichtStandKurz, faellig: boolean): BerichtUeberpruefung => {
  const jahr = Number(s.freigegeben_am.slice(0, 4)) + 1;
  return {
    stand_nr: s.nr,
    stand_vom: s.freigegeben_am.slice(0, 10),
    wiedervorlage_monate: 12,
    faellig_am: `${jahr}${s.freigegeben_am.slice(4, 10)}`,
    ueberpruefung_faellig: faellig,
    faellig_seit_tagen: faellig ? 1 : null,
    abgeloest_durch: null,
    wesentliche_einsaetze: 6,
    offene_bedarfe: 1,
    verantwortliche: [
      { name: 'Markus Dorn', einsaetze: ['EE-1'] },
      { name: 'Ines Kaltenbach', einsaetze: ['EE-3'] },
      { name: 'Paul Hartmann', einsaetze: ['EE-2', 'EE-5'] },
      { name: 'Jana Wolff', einsaetze: ['EE-6', 'EE-7'] },
    ],
    ohne_verantwortliche: [],
  };
};

export function bewertungStandBuehne(lage: BewertungsLage) {
  let bericht: Bericht | null = null;
  let staende: BerichtStandKurz[] = [];
  let anstoesse: BerichtAnstoss[] = [];
  let entwurfDatenstand = '2026-11-09T10:05:00+01:00';
  const faellig = lage === 'faellig';

  const kopf = (): Bericht => ({
    kennung: BW_KENNUNG,
    vorlage: 'energetische_bewertung',
    vorlage_fassung: 1,
    geltung_art: 'unternehmen',
    geltung_id: FIXTURE_IDS.u,
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
    zeitraum_art: 'datengrundlage',
    zeitraum: '2025-11/2026-10',
    zeitraum_text: 'November 2025 bis Oktober 2026',
    zeitzone: ZONE,
    angelegt_von: IK,
    angelegt_am: '2026-11-09T09:40:00+01:00',
    archiviert_am: null,
    stand_zeichen: staende.length === 0 ? 'entwurf' : anstoesse.some((a) => a.zustand === 'offen') ? 'revision_noetig' : 'berichtsstand',
    stand_text: null,
    neueste_nr: staende.length === 0 ? null : Math.max(...staende.map((s) => s.nr)),
    entwurf_datenstand: entwurfDatenstand,
    wiedervorlage_monate: 12,
    ueberpruefung: (() => {
      const g = staende.find((s) => s.ersetzt_durch_nr === null);
      return g ? ueberpruefung(g, faellig) : null;
    })(),
  });

  if (lage !== 'keine') bericht = kopf();
  if (lage === 'nr1') staende = [stand1(false)];
  if (lage === 'revision') {
    staende = [stand1(false)];
    anstoesse = [anstoss(false)];
    entwurfDatenstand = '2026-11-12T10:06:00+01:00';
  }
  if (lage === 'nr2' || lage === 'faellig') {
    staende = [stand1(true), stand2()];
    anstoesse = [anstoss(true)];
    entwurfDatenstand = '2026-11-17T09:31:00+01:00';
  }

  const abrufe: string[] = [];
  (globalThis as { __bewertungAbrufe?: string[] }).__bewertungAbrufe = abrufe;
  const detail = (): BerichtDetail => ({ bericht: kopf(), staende: [...staende], anstoesse: [...anstoesse] });
  const nichtGefunden = () => Object.assign(new Error('Bericht nicht gefunden.'), { status: 404 });

  return {
    berichte: async () => ({ berichte: bericht ? [kopf()] : [] }),
    berichtAnlegen: async () => {
      bericht = kopf();
      return kopf();
    },
    bericht: async (kennung: string) => {
      if (!bericht || kennung !== BW_KENNUNG) throw nichtGefunden();
      return detail();
    },
    berichtEntwurf: async (kennung: string): Promise<BerichtEntwurf> => {
      if (!bericht || kennung !== BW_KENNUNG) throw nichtGefunden();
      return {
        kennung,
        datenstand: entwurfDatenstand,
        gebildet_von: anstoesse.some((a) => a.zustand === 'offen') ? 'kaskade' : 'anlegen',
        neu_gebildet: false,
        pruefsumme: PRUEFSUMME_ENTWURF,
        kopf: `Entwurf · Datenstand ${entwurfDatenstand}`,
        teilansicht: null,
        abzug: abzug(entwurfDatenstand),
      };
    },
    berichtFreigeben: async (kennung: string, datenstand: string): Promise<BerichtStand> => {
      const offen = anstoesse.find((a) => a.zustand === 'offen') ?? null;
      const nr = staende.length + 1;
      const neu: BerichtStandKurz = nr === 1
        ? { ...stand1(false), datenstand }
        : { ...stand2(), nr, datenstand, anlass_anstoss_id: offen?.id ?? null };
      staende = [...staende.map((s) => (s.ersetzt_durch_nr === null ? { ...s, ersetzt_durch_nr: nr } : s)), neu];
      anstoesse = anstoesse.map((a) => (a.zustand === 'offen' ? { ...a, zustand: 'erledigt', erledigt_durch_nr: nr } : a));
      entwurfDatenstand = neu.freigegeben_am.replace(/:\d\d\+/, ':30+');
      return {
        ...neu,
        kennung,
        pruefsumme_geprueft: true,
        vorlage_fassung: 1,
        kopf: `Stand Nr. ${nr}`,
        teilansicht: null,
        darstellung: { zeitzone: ZONE, zahlenformat: 'de-DE' },
        abzug: abzug(datenstand),
      } as unknown as BerichtStand;
    },
    berichtDatei: async (kennung: string, nr: number, format: 'pdf' | 'csv') => {
      abrufe.push(`${kennung}/${nr}/${format}`);
      return new Blob([format === 'pdf' ? '%PDF-1.7 Bewertung' : 'abschnitt;wert\r\n'], {
        type: format === 'pdf' ? 'application/pdf' : 'text/csv',
      });
    },
  };
}
