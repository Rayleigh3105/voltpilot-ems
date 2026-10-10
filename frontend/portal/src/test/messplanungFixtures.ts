import type { Messstelle, MessstelleRegisterZeile } from '../api';
import { ahrenbergRegister } from './messstellenRegisterFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Messplanung des Referenzunternehmens (UEMS AP-16 IP-20, R5): EE-8 „Gebäudetechnik Halle 1“ (P-7, ab 27.11.2026),
 * der Bedarf MB-1 „Lüftung, Beleuchtung und Allgemeinstrom Halle 1“ am Ort G-1, Größe Wirkenergie · Bezug, Frist
 * 31.03.2027, und die Messstelle MS-23 „Halle 1 Allgemein“ — eingerichtet ohne Datenquelle seit 27.11.2026.
 *
 * Nur Daten, keine Wert-Importe aus `../api` — auch die Playwright-Specs lesen sie. `messplanungBuehne.ts` spielt die
 * Messbedarf-Routen (IP-19) und die Routen des Messstellen-Dialogs nach, damit Komponententests und die E2E-Bühne
 * `e2e/bewertung.tsx?messplanung=1` DENSELBEN Weg Bedarf → Messstelle gehen.
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const EE8_ID = 'ee000000-0000-4000-8000-000000000008';
export const MS23_ID = '3e000000-0000-4000-8000-000000000023';
export const MB1_WORTLAUT = 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1';

/** Die Registerzeile von MS-23: eingerichtet an G-1, keine Datenquelle seit 27.11.2026, kein letzter Wert (nie 0). */
export function ms23Zeile(geplantFuer = true): MessstelleRegisterZeile {
  return {
    ...ahrenbergRegister().register.find((z) => z.kennzeichen === 'MS-21')!,
    id: MS23_ID,
    kennzeichen: 'MS-23',
    name: 'Halle 1 Allgemein',
    medium: 'Strom',
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    ort: {
      id: '0e000000-0000-4000-8000-000000000101', kennzeichen: 'G-1', ort_art: 'gebaeude', name: 'Halle 1', gueltig_ab: '2026-11-27',
      gueltig_bis: null, pfad: ['G-1', 'ST-1'], standort: 'ST-1', standort_id: FIXTURE_IDS.st1, standort_name: 'Werk Ahrenberg', grund: 'verortet',
    },
    lebenszyklus: 'eingerichtet',
    beobachtung: { zustand: 'keine_datenquelle', text: 'Keine Datenquelle', seit: '2026-11-27T10:05:00+01:00', toleranz_s: null, kadenz_s: null, geraet: null },
    letzter_wert: null,
    geplant_fuer_einsaetze: geplantFuer ? [{ id: EE8_ID, kennzeichen: 'EE-8', name: 'Gebäudetechnik Halle 1' }] : [],
  };
}

/** MS-23 als Messstelle (`GET /api/v1/messstellen/{id}`), eingerichtet an G-1 ohne Quelle. */
export function ms23(over: Partial<Messstelle> = {}): Messstelle {
  return {
    id: MS23_ID,
    kennzeichen: 'MS-23',
    name: 'Halle 1 Allgemein',
    art: 'gemessen',
    medium: 'Strom',
    lebenszyklus: 'eingerichtet',
    fehlt: [],
    notiz: null,
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    nebengroessen: [],
    orte: [{ ort_art: 'gebaeude', kennzeichen: 'G-1', gueltig_ab: '2026-11-27', gueltig_bis: null }],
    elektrische_stellung: [],
    fuehrende_quelle: [],
    anschlussleistung_kw: null,
    ...over,
  };
}

