import type { UemsBetreiberblatt, UemsBoxStand, UemsGemeinsameSteuerungZustand, UemsSprungprobeProtokoll } from '../api';
import { GS_IDS, gsZustand } from './gemeinsameSteuerungFixtures';

/**
 * UEMS AP-15 IP-24 — `GET /api/v1/admin/…/gemeinsame-steuerung` für die Bühne und die Tests: AN-1 mit Box Halle 1
 * (E-1, führt) und Box Verwaltung (E-4, steuert mit), Zahlen aus der Referenzdatei 1.5 (Einspeisung 40/60 kW, Bezug
 * 0/77 kW). E-4 ist in S1 eine „alte“ Box ohne Herzschlag-Block: Wächter, wirksame Anteile und Messpunkt sind
 * „nicht gemeldet“ — nie eine Null.
 */
export type BlattLage = 's1' | 'uebergang' | 'aktiv' | 'angehalten';

export const PLAN_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
export const PLAN_B = 'b2c3d4e5-0000-4000-8000-00000000000b';

function box(id: string, rolle: 'fuehrt' | 'steuert_mit', teil: Partial<UemsBoxStand>, jetzt: Date): UemsBoxStand {
  const vor = (s: number) => new Date(jetzt.getTime() - s * 1000).toISOString();
  return {
    box_id: id,
    rolle,
    zuletzt_gesehen: vor(20),
    faehigkeit: { steuerungsverbund_anteil: 'gemeldet', sprungprobe: 'gemeldet' },
    messpunkt: { data_source_id: rolle === 'fuehrt' ? GS_IDS.dq2 : GS_IDS.dq10, zustand: 'ok', gelesen_am: vor(8) },
    waechter: { einspeisung: 'ueberwacht', bezug: 'ueberwacht' },
    plan: { veroeffentlicht: null, angenommen: null },
    anteile: { gesendet: null, quittiert: null, wirksam_kw: null },
    ...teil,
  };
}

export function gsProbe(box: string, jetzt: Date, urteil: 'bestanden' | 'ausgeloest' | 'nicht_bestanden' = 'bestanden'): UemsSprungprobeProtokoll {
  const am = new Date(jetzt.getTime() - 3600_000).toISOString();
  return {
    probe: {
      probe_id: `f0000000-0000-4000-8000-0000000000${box === GS_IDS.e1 ? '01' : '04'}`,
      box_id: box, art: 'erzeugung_senken', sprung_kw: 30, dauer_s: 60, wiederholungen: 2, ausgeloest_am: am,
      urteil, grund: urteil === 'nicht_bestanden' ? 'nicht_gesehen' : null,
      ausgewertet_am: urteil === 'ausgeloest' ? null : am, entwertet_am: null, gilt: urteil === 'bestanden',
    },
    spruenge: urteil === 'ausgeloest' ? [] : [
      { eigene_kw: -30, erwartet_kw: 30, gesehen_kw: 29.2, toleranz_kw: 3, abweichung_kw: -0.8, urteil: 'bestanden', grund: null },
      { eigene_kw: -30, erwartet_kw: 30, gesehen_kw: 30.4, toleranz_kw: 3, abweichung_kw: 0.4, urteil: 'bestanden', grund: null },
    ],
  };
}

export function gsBlatt(lage: BlattLage, jetzt: Date, proben: UemsSprungprobeProtokoll[] = []): UemsBetreiberblatt {
  const vor = (s: number) => new Date(jetzt.getTime() - s * 1000).toISOString();
  const r = (revision: number, s: number) => ({ epoche: 1, revision, am: vor(s) });
  if (lage === 's1') {
    return {
      boxen: [
        box(GS_IDS.e1, 'fuehrt', { waechter: { einspeisung: 'ueberwacht', bezug: 'ueberwacht' } }, jetzt),
        box(GS_IDS.e4, 'steuert_mit', {
          faehigkeit: { steuerungsverbund_anteil: 'fehlt', sprungprobe: 'fehlt' },
          messpunkt: { data_source_id: GS_IDS.dq10, zustand: 'nicht_gemeldet', gelesen_am: null },
          waechter: null,
        }, jetzt),
      ],
      zweischritt: null,
      sprungproben: proben,
    };
  }
  if (lage === 'uebergang') {
    // R12, erste Hälfte: die führende Box hat den Übergang quittiert, die mitsteuernde nicht — kein Plan je Box.
    return {
      boxen: [
        box(GS_IDS.e1, 'fuehrt', { anteile: { gesendet: r(1, 30), quittiert: r(1, 25), wirksam_kw: { einspeisung: 40, bezug: 550 } } }, jetzt),
        box(GS_IDS.e4, 'steuert_mit', { anteile: { gesendet: r(1, 30), quittiert: null, wirksam_kw: null } }, jetzt),
      ],
      zweischritt: { schritt: 'uebergang', epoche: 1, revision: 1, am: vor(30), bestaetigt: [GS_IDS.e1], wartet_auf: [GS_IDS.e4] },
      sprungproben: proben,
    };
  }
  const plan = (id: string) => ({ plan_id: id, erzeugt_am: vor(300), am: vor(290) });
  return {
    boxen: [
      box(GS_IDS.e1, 'fuehrt', {
        plan: { veroeffentlicht: plan(PLAN_A), angenommen: { ...plan(PLAN_A), urteil: 'angenommen' } },
        anteile: { gesendet: r(2, 20), quittiert: r(2, 18), wirksam_kw: { einspeisung: 40, bezug: 0 } },
      }, jetzt),
      box(GS_IDS.e4, 'steuert_mit', {
        plan: { veroeffentlicht: plan(PLAN_A), angenommen: { ...plan(PLAN_A), urteil: 'angenommen' } },
        anteile: { gesendet: r(2, 20), quittiert: r(2, 15), wirksam_kw: { einspeisung: 60, bezug: 77 } },
        // R2 (Folgepaket zu IP-22): die Box kennt die verfügbare PV nicht und meldet ≈ 0 kWh bei 9 h gebunden;
        // die Cloud schätzt aus der Prognose 160,2 kWh.
        verlust_gestern: { tag: '2027-06-14', verlust_kwh: 0, gebunden_s: 32_400, schaetzung_kwh: 160.211, schaetzung_grundlage: 'prognose' },
      }, jetzt),
    ],
    zweischritt: { schritt: 'ziel', epoche: 1, revision: 2, am: vor(20), bestaetigt: [GS_IDS.e1, GS_IDS.e4], wartet_auf: [] },
    sprungproben: proben,
  };
}

/** `GET …/gemeinsame-steuerung` passend zum Blatt: S1 mit offenem I1, S2 ohne Befund, aktiv, angehalten. */
export function gsBetreiberZustand(l: 'beobachtet' | 'geprueft' | 'anteile_aktiv' | 'angehalten' | 'angehalten_betreiber'): UemsGemeinsameSteuerungZustand {
  const bilanz = { zustand: 'plausibel' as const, tag: '2027-06-14', seit: '2027-05-31' };
  const vorbehalt = {
    einspeisung: { kw: 0, herkunft: 'erklaert' as const },
    bezug: { kw: 473, herkunft: 'gemessen' as const },
  };
  if (l === 'geprueft') return { ...gsZustand('beobachtet'), zustand: 'geprueft', stufe: 'S2', fehlt: [], epoche: 0, bilanz, vorbehalt };
  const z = gsZustand(l);
  const epoche = l === 'beobachtet' ? 0 : 1;
  const bestaetigt = epoche > 0 ? '2027-06-15T09:00:00Z' : null;
  return { ...z, epoche, bilanz, vorbehalt, mitglieder: (z.mitglieder ?? []).map((m) => ({ ...m, bestaetigt_am: bestaetigt })) };
}
