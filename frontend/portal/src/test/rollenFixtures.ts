import vektoren from '../../../../docs/contracts/v2/rechte-vectors.json' with { type: 'json' };
import matrixDatei from '../../../../docs/contracts/v2/rechte-matrix.json' with { type: 'json' };
import type { Selbstauskunft } from '../api';
import { darf, matrixAus, ocppStufe, sichtbareStandorte, type Aktion, type Benutzer, type Kundenbereich } from '../rechte';
import { FIXTURE_IDS } from './standorteFixtures';

/** API-förmige Momentaufnahmen aus den Ahrenberg-Vertragsfällen, kein Dev-Seed. */
export const RECHTE_MATRIX = matrixAus(matrixDatei as { aktionen: Aktion[] });
export const STANDORT_IDS: Record<string, string> = {
  'ST-1': FIXTURE_IDS.st1, 'ST-2': FIXTURE_IDS.st2,
  'ST-3': '5a1d0000-0000-4000-8000-000000000003',
};

/** Der Vertragsfall der Plattform-Administration im Mandantensprung (Zugang „umschalter“, Fälle `sprung-*`). */
export const SPRUNG_FALL = 'sprung-lena-sieht-alle-standorte';

/**
 * `/me` der Person `kennung` aus ihrem ersten Vertragsfall — oder aus dem Fall `fallName`. Ein Plattform-Konto ohne
 * Unterstützung (die gedachte Zuweisung des Sprungs) kommt über den Umschalter, sonst über eine Unterstützung.
 */
export function rechteSeed(kennung = 'JW', fallName?: string): { me: Selbstauskunft; benutzer: Benutzer; kundenbereich: Kundenbereich; jetzt: string } {
  // Die Rohform ist durch rechte.test.ts gegen das gemeinsame Schema geprüft.
  const fall = vektoren.cases.find((c) => {
    const i = c.input as { benutzer?: { kennung?: string }; kundenbereich?: unknown };
    return fallName ? c.name === fallName : i.benutzer?.kennung === kennung && i.kundenbereich;
  });
  if (!fall) throw new Error(`Rechte-Seed fehlt: ${fallName ?? kennung}`);
  const i = fall.input as any;
  const benutzer: Benutzer = { ...i.benutzer, zuweisungen: i.benutzer.zuweisungen.map((z: any) => ({
    rolle: z.rolle, standorte: z.standorte, umfang: z.umfang, art: z.art,
    gueltigAb: z.gueltig_ab, gueltigBis: z.gueltig_bis, beendetAm: z.beendet_am,
  })) };
  const kundenbereich: Kundenbereich = i.kundenbereich;
  const jetzt = i.jetzt;
  const sicht = sichtbareStandorte(benutzer, kundenbereich, jetzt);
  const rechte = (standort: string | null) => [...RECHTE_MATRIX.keys()].filter((aktion) =>
    darf(RECHTE_MATRIX, benutzer, kundenbereich, aktion, { standort, anlage: null, stichtag: null }, jetzt).darf);
  const t = sicht.teilansicht;
  return { benutzer, kundenbereich, jetzt, me: {
    kennung: benutzer.kennung, name: benutzer.name, konto: benutzer.konto, zustand: benutzer.zustand,
    kundenbereich: { id: FIXTURE_IDS.u, name: kundenbereich.name },
    zugang: benutzer.konto === 'benutzer' ? 'konto'
      : benutzer.konto === 'plattform' && benutzer.zuweisungen.every((z) => z.rolle !== 'unterstuetzer') ? 'umschalter' : 'unterstuetzung',
    rollen: [...new Set(sicht.standorte.flatMap((s) => s.rollen))],
    unternehmensweit: sicht.unternehmensweit,
    standorte: sicht.standorte.map((s) => ({
      ...s, id: STANDORT_IDS[s.kennzeichen], rechte: rechte(s.kennzeichen),
      ocpp_stufe: ocppStufe(benutzer, kundenbereich, s.kennzeichen, jetzt).stufe,
    })),
    unternehmen_rechte: rechte(null), kuenftig: sicht.kuenftig, text: sicht.text,
    teilansicht: {
      sichtbar: t.sichtbar, gesamt: t.gesamt, unternehmensebene: t.unternehmensebene,
      teilansicht: t.teilansicht, kopfzeile: t.kopfzeile, export_kopfzeile: t.exportKopfzeile,
      unternehmensweite_objekte: t.unternehmensweiteObjekte,
    },
    unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: kundenbereich.kundenadministratoren,
  } };
}

export function sichtbareListe<T>(eintraege: T[]) {
  return { eintraege, teilansicht: rechteSeed().me.teilansicht! };
}
