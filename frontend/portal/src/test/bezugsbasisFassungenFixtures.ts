import type { api, Bezugsbasis, BezugsbasisAnstoss, BezugsbasisFaktor, BezugsbasisFassung, BezugsbasisFrist } from '../api';
import type { BezugsbasisZustand } from '../bezugsbasisUebersicht';
import { bb1, bb1Fassung, bezugsbasisBuehne, BB_IDS } from './bezugsbasisFixtures';

/**
 * UEMS AP-17 IP-18 — Fassungen, Anstoß, Frist und Faktoren an BB-0001 (R1 → R5 → R13, Kunststoffwerk Ahrenberg):
 * Fassung 1 (Oktober 2026, freigegeben 12.11.2026) trägt die Fläche G-2 (3 100 m²) und einen Wortlaut-Faktor; der Anbau
 * der Halle 2 stößt sie an (`struktur_geaendert`, Pfad 2). Die Felder `anstoesse`/`frist` haben die Form des
 * API-Nachtrags (Nachlese 3, Entscheid firstmate 23.09.2026). API-förmige Antworten für vitest und die Bühne
 * `e2e/bezugsbasis.tsx` (`lage=anstoss|frist`); kein Dev-Seed.
 */
export const ANSTOSS_SATZ_R5 = 'Bezugsbasis BB-0001: die Fläche der Halle 2 hat sich geändert (3 100 → 3 400 m² ab 01.01.2027) — Fassung 1 prüfen.';
export const FRIST_SATZ_R13 = 'Bezugsbasis BB-0001, Fassung 1 vom 12.11.2026 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.';

export const faktorenR1: BezugsbasisFaktor[] = [
  {
    position: 1, art: 'flaeche', objekt_id: 'g2000000-0000-4000-8000-000000000002', kennung: 'G-2', bezeichnung: 'Halle 2', wortlaut: null,
    wert: '3100', einheit: 'm²', gueltig_ab: '2026-10-01', stichtag: '2026-11-12', ohne_anstoss: false,
    satz: 'Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)',
  },
  {
    position: 2, art: 'wortlaut', objekt_id: null, kennung: null, bezeichnung: null, wortlaut: 'Zweischichtbetrieb, Halle 2',
    wert: null, einheit: null, gueltig_ab: null, stichtag: '2026-11-12', ohne_anstoss: true,
    satz: 'Statischer Faktor: Zweischichtbetrieb, Halle 2 (Wortlaut, ohne Anstoß)',
  },
];

export const anstossR5 = (over: Partial<BezugsbasisAnstoss> = {}): BezugsbasisAnstoss => ({
  art: 'struktur_geaendert', pfad: 2, anlass_kennung: 'ort_aenderung:4711', anlass_satz: ANSTOSS_SATZ_R5, zeitpunkt: '2027-01-05T03:00:00+01:00', fassung: 1, offen: true, antwort: null, ...over,
});

export const fristR13 = (faellig = true): BezugsbasisFrist =>
  faellig
    ? { ueberpruefung_faellig: true, faellig_am: '2027-11-12', faellig_seit_tagen: 1, wiedervorlage_monate: 12, bestaetigt_am: null }
    : { ueberpruefung_faellig: false, faellig_am: '2027-11-12', faellig_seit_tagen: null, wiedervorlage_monate: 12, bestaetigt_am: null };

/** Fassung 1 freigegeben mit Faktoren (R1 + IP-16b). */
export const fassung1 = (over: Partial<BezugsbasisFassung> = {}): BezugsbasisFassung => bb1Fassung('freigegeben', { faktoren: faktorenR1, ...over });

/** Fassung 2 nach dem Anstoß (R5): Grund „Struktur geändert“, gilt ab 01.01.2027 — als Entwurf oder freigegeben. */
export const fassung2 = (status: BezugsbasisFassung['freigabe_status'] = 'entwurf', over: Partial<BezugsbasisFassung> = {}): BezugsbasisFassung =>
  bb1Fassung(status, {
    fassung: 2,
    gilt_ab: '2027-01-01',
    basiswert: '0.2811',
    faktoren: [{ ...faktorenR1[0], wert: '3400', gueltig_ab: '2027-01-01', stichtag: '2027-01-05', satz: 'Statischer Faktor: Fläche G-2 3 400 m² (Stand 05.01.2027)' }, faktorenR1[1]],
    anpassungsgruende: ['struktur_geaendert'],
    anpassung_wortlaut: null,
    begruendung: 'Anbau Halle 2: die Fläche wächst von 3 100 auf 3 400 m².',
    pruefsumme: 'sha256:9a1c0000000000000000000000000000000000000000000000000000000000ff',
    freigabe: status === 'entwurf' ? null : { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2027-01-05T10:00:00+01:00' },
    freigegeben_am: status === 'freigegeben' ? '2027-01-05T10:00:00+01:00' : null,
    ...over,
  });

const kurz = (f: BezugsbasisFassung) => ({
  fassung: f.fassung, referenzperiode: f.referenzperiode, methode: f.methode, datenlage: f.datenlage,
  freigabe_status: f.freigabe_status, basiswert: f.basiswert, gilt_ab: f.gilt_ab, gilt_bis: f.gilt_bis ?? null, pruefsumme: f.pruefsumme,
});

/** BB-0001 mit den gegebenen Fassungen und den Feldern des Nachtrags. */
export function basisMit(fassungen: BezugsbasisFassung[], extra: Partial<Bezugsbasis> = {}): Bezugsbasis {
  return { ...bb1(null), fassungen: fassungen.map(kurz), ...extra };
}

export const zustandNachBleibt = (): BezugsbasisZustand => ({
  bezugsbasis_id: BB_IDS.bb1, kennzeichen: 'BB-0001', kennzahl_id: BB_IDS.kz4, kennzahl_kennzeichen: 'KZ-0004', kennzahl_name: 'Spritzguss je kg',
  fassung: 1, freigegeben_am: '2026-11-12', datenlage: 'vorlaeufig', zustand: 'freigegeben', faellig_am: '2028-11-13', faellig_seit_tagen: null,
  anstoss_liegt_vor: false, beendet_zum: null, beendet_grund: null,
});

/**
 * Die Routen der Bühne für IP-18 als kleiner Zustand im Speicher — `anstoss` (R5: Fassung 1 angestoßen) oder `frist`
 * (R13: Überprüfung fällig seit 1 Tag). Neue Fassung, Freigabe, „bleibt“ und „beenden“ ändern ihn wie die Routen.
 */
export function fassungenBuehne(lage: 'anstoss' | 'frist'): Partial<typeof api> {
  const basis0 = bezugsbasisBuehne('freigegeben');
  const fassungen: BezugsbasisFassung[] = [fassung1()];
  let anstoesse: BezugsbasisAnstoss[] = lage === 'anstoss' ? [anstossR5()] : [];
  let frist: BezugsbasisFrist = fristR13(lage === 'frist');
  let beendet: { zum: string; grund: string } | null = null;
  const basis = () => basisMit(fassungen, { anstoesse, frist, beendet_zum: beendet?.zum ?? null, beendet_grund: beendet?.grund ?? null });
  const zustand = (): BezugsbasisZustand => ({ ...zustandNachBleibt(), beendet_zum: beendet?.zum ?? null, beendet_grund: beendet?.grund ?? null, zustand: beendet ? 'beendet' : 'freigegeben' });
  return {
    ...basis0,
    kennzahlBezugsbasen: async () => ({ bezugsbasen: [basis()] }),
    bezugsbasisFassung: async (_k, _b, n) => fassungen.find((f) => f.fassung === n)!,
    bezugsbasisEntwurf: async (_k, _b, body) => {
      const neu = fassung2('entwurf', {
        referenzperiode: body.referenzperiode,
        methode: body.methode,
        anpassungsgruende: body.anpassungsgruende ?? [],
        anpassung_wortlaut: body.anpassung_wortlaut ?? null,
        begruendung: body.begruendung ?? null,
        gilt_ab: body.gilt_ab ?? '2027-01-01',
      });
      const i = fassungen.findIndex((f) => f.fassung === 2);
      if (i >= 0) fassungen[i] = neu;
      else fassungen.push(neu);
      return neu;
    },
    bezugsbasisFreigabe: async (_k, _b, n) => {
      const i = fassungen.findIndex((f) => f.fassung === n);
      const f = { ...fassungen[i], freigabe_status: 'freigegeben' as const, freigabe: { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2026-11-12T10:00:00+01:00' }, freigegeben_am: '2026-11-12T10:00:00+01:00' };
      fassungen[i] = f;
      // F4: die Vorgängerin endet am Vortag; offene Anstöße gelten als mit der neuen Fassung beantwortet.
      if (n > 1) {
        fassungen[0] = { ...fassungen[0], gilt_bis: '2026-12-31' };
        anstoesse = anstoesse.map((a) => ({ ...a, offen: false, antwort: { art: 'neue_fassung', person: 'Ines Kaltenbach', am: f.freigegeben_am, begruendung: f.begruendung ?? null } }));
      }
      return f;
    },
    bezugsbasisBleibt: async () => {
      anstoesse = anstoesse.map((a) => ({ ...a, offen: false, antwort: { art: 'bleibt', person: 'Ines Kaltenbach', am: '2027-11-13T10:00:00+01:00', begruendung: null } }));
      frist = { ueberpruefung_faellig: false, faellig_am: '2028-11-13', faellig_seit_tagen: null, wiedervorlage_monate: 12, bestaetigt_am: '2027-11-13' };
      return zustandNachBleibt();
    },
    bezugsbasisBeenden: async (_k, _b, body) => {
      beendet = { zum: body.tag, grund: body.grund };
      return zustand();
    },
    bezugsbasisUebersicht: async () => ({ stichtag: '2026-11-12', laufend: 1, freigegeben: 1, vorlaeufig: 1, mit_anstoss: anstoesse.filter((a) => a.offen).length, ueberpruefung_faellig: 0, faellig: [] }),
  };
}
