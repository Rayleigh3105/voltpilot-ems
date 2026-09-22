import { describe, expect, it } from 'vitest';
import {
  ablehnungSaetze,
  auslegungSaetze,
  boxSpalten,
  fehltSaetze,
  i1Liste,
  kopfZeile,
  NICHT_GEMELDET,
  protokollZeilen,
  scharfschaltenMoeglich,
  sprungEingabe,
  sprungprobeGrund,
  verlustGesternZelle,
  WOERTER,
  zweischrittLage,
} from './adminGemeinsameSteuerung';
import { gsBetreiberZustand, gsBlatt, gsProbe, PLAN_A, PLAN_B } from './test/betreiberblattFixtures';
import { GS_IDS, gsEingerichtet } from './test/gemeinsameSteuerungFixtures';

const JETZT = new Date('2027-06-15T11:40:00Z');
const NAMEN = new Map([[GS_IDS.e1, 'Halle 1'], [GS_IDS.e4, 'Verwaltung']]);

describe('AP-15 IP-24 · Betreiber-Blatt — Spalten je Box', () => {
  it('eine alte Box ohne Herzschlag-Block zeigt „nicht gemeldet“ — nie eine Null, nie grün', () => {
    const [e1, e4] = boxSpalten(gsBlatt('s1', JETZT), gsEingerichtet(), NAMEN, JETZT);
    expect(e1.name).toBe('Halle 1');
    expect(e1.rolle).toBe('führt');
    expect(e1.waechter.einspeisung).toEqual({ text: 'überwacht', warnung: false });
    expect(e4.waechter.einspeisung).toEqual({ text: NICHT_GEMELDET, unbekannt: true });
    expect(e4.waechter.bezug.unbekannt).toBe(true);
    expect(e4.messpunkt).toEqual({ text: NICHT_GEMELDET, unbekannt: true });
    expect(e4.wirksam.einspeisung).toEqual({ text: NICHT_GEMELDET, unbekannt: true });
    expect(e4.wirksam.bezug.text).not.toMatch(/0/);
    expect(e4.faehigkeit).toEqual({ text: 'fehlt', warnung: true });
    expect(e1.faehigkeit).toEqual({ text: 'gemeldet', warnung: false });
    expect(e1.messpunkt.text).toBe('ok · vor 8 s');
    expect(e4.revision.quittiert).toMatchObject({ text: NICHT_GEMELDET, unbekannt: true });
  });

  it('die führende Box steht links, auch wenn die api sie später nennt', () => {
    const b = gsBlatt('s1', JETZT);
    const spalten = boxSpalten({ ...b, boxen: [...b.boxen].reverse() }, null, NAMEN, JETZT);
    expect(spalten.map((s) => s.boxId)).toEqual([GS_IDS.e1, GS_IDS.e4]);
  });

  it('Geräte mit Rückfall und seiner Herkunft', () => {
    const [e1, e4] = boxSpalten(gsBlatt('s1', JETZT), gsEingerichtet(), NAMEN, JETZT);
    expect(e1.geraete[0].text).toMatch(/Einspeisung 100 kW · Rückfall 40 kW \(am Gerät hinterlegt\)/);
    expect(e4.geraete[0].text).toMatch(/Rückfall 60 kW \(laut Katalog\)/);
    expect(e4.geraete).toHaveLength(7);
  });

  it('plan_id veröffentlicht ≠ angenommen ist sichtbar markiert (R11)', () => {
    const b = gsBlatt('aktiv', JETZT);
    const ungleich = { ...b, boxen: b.boxen.map((x) => x.box_id === GS_IDS.e4
      ? { ...x, plan: { veroeffentlicht: { plan_id: PLAN_B }, angenommen: { plan_id: PLAN_A } } } : x) };
    const [e1, e4] = boxSpalten(ungleich, null, NAMEN, JETZT);
    expect(e1.plan.ungleich).toBe(false);
    expect(e4.plan.ungleich).toBe(true);
    expect(e4.plan.angenommen).toMatchObject({ text: PLAN_A.slice(0, 8), warnung: true });
    expect(e4.plan.veroeffentlicht.text).toBe(PLAN_B.slice(0, 8));
  });

  it('ohne Quittung zum veröffentlichten Plan: „nicht gemeldet“, markiert', () => {
    const b = gsBlatt('aktiv', JETZT);
    const ohne = { ...b, boxen: b.boxen.map((x) => ({ ...x, plan: { veroeffentlicht: x.plan.veroeffentlicht, angenommen: null } })) };
    expect(boxSpalten(ohne, null, NAMEN, JETZT)[1].plan).toMatchObject({ ungleich: true, angenommen: { text: NICHT_GEMELDET, warnung: true } });
  });

  it('Anteils-Revision gesendet ≠ quittiert ist sichtbar markiert', () => {
    const [e1, e4] = boxSpalten(gsBlatt('uebergang', JETZT), null, NAMEN, JETZT);
    expect(e1.revision).toMatchObject({ ungleich: false, gesendet: { text: 'E1 · R1' }, quittiert: { text: 'E1 · R1' } });
    expect(e4.revision).toMatchObject({ ungleich: true, gesendet: { text: 'E1 · R1' }, quittiert: { text: NICHT_GEMELDET, warnung: true } });
    const b = gsBlatt('aktiv', JETZT);
    const alt = { ...b, boxen: b.boxen.map((x) => ({ ...x, anteile: { ...x.anteile, quittiert: { epoche: 1, revision: 1 } } })) };
    expect(boxSpalten(alt, null, NAMEN, JETZT)[0].revision.ungleich).toBe(true);
  });

  it('wirksame Anteile je Richtung in kW, wie die Box sie meldet', () => {
    const [e1, e4] = boxSpalten(gsBlatt('aktiv', JETZT), null, NAMEN, JETZT);
    expect(e1.wirksam.einspeisung.text).toBe('40 kW');
    expect(e4.wirksam.bezug.text).toBe('77 kW');
    expect(e4.wirksam.reserve).toEqual({ text: 'keine', unbekannt: true });
  });

  it('die Reserve der anderen steuerbaren Verbraucher, nur wenn die Box sie meldet (AP-15 Folge von IP-19)', () => {
    const b = gsBlatt('aktiv', JETZT);
    b.boxen[1] = { ...b.boxen[1], anteile: { ...b.boxen[1].anteile, reserve_verbraucher_kw: 10 } };
    const [e1, e4] = boxSpalten(b, null, NAMEN, JETZT);
    expect(e4.wirksam.reserve.text).toBe('10 kW');
    expect(e1.wirksam.reserve).toEqual({ text: 'keine', unbekannt: true });
  });

  it('das erklärte Ungeregelte hinter dem Abgang, nur über 0 (AP-15 Folge von IP-19, B3)', () => {
    const [ohneE1, ohneE4] = boxSpalten(gsBlatt('aktiv', JETZT), null, NAMEN, JETZT);
    expect([ohneE1.ungeregelt, ohneE4.ungeregelt]).toEqual([null, null]);
    const b = gsBlatt('aktiv', JETZT);
    b.boxen[1] = { ...b.boxen[1], anteile: { ...b.boxen[1].anteile, ungeregelt_hinter_abgang_kw: 50 } };
    b.boxen[0] = { ...b.boxen[0], anteile: { ...b.boxen[0].anteile, ungeregelt_hinter_abgang_kw: 0 } };
    const [e1, e4] = boxSpalten(b, null, NAMEN, JETZT);
    expect(e4.ungeregelt?.text).toBe('50 kW');
    expect(e1.ungeregelt).toBeNull();
  });

  it('Verlust gestern: Untergrenze der Box und Schätzung der Cloud nebeneinander, nie verrechnet (Folgepaket IP-22, R2)', () => {
    const b = gsBlatt('aktiv', JETZT);
    b.boxen[1].verlust_gestern = { tag: '2027-06-14', verlust_kwh: 0, gebunden_s: 32_400, schaetzung_kwh: 160.211, schaetzung_grundlage: 'prognose' };
    const [e1, e4] = boxSpalten(b, null, NAMEN, JETZT);
    expect(e4.verlustGestern).toEqual({ text: 'mindestens 0 kWh (gemessen) · geschätzt 160,2 kWh (Prognose)' });
    expect(e1.verlustGestern).toEqual({ text: NICHT_GEMELDET, unbekannt: true });
  });

  it('Verlust gestern ohne Prognose oder noch nicht gerechnet: keine Null als Schätzung', () => {
    const tag = { tag: '2027-06-14', verlust_kwh: 1.5, gebunden_s: 3600 };
    expect(verlustGesternZelle({ ...tag, schaetzung_kwh: null, schaetzung_grundlage: 'keine' }))
      .toEqual({ text: 'mindestens 1,5 kWh (gemessen) · keine Schätzung (keine Prognose)', unbekannt: true });
    expect(verlustGesternZelle({ ...tag, schaetzung_grundlage: null }))
      .toEqual({ text: 'mindestens 1,5 kWh (gemessen) · Schätzung noch nicht gerechnet', unbekannt: true });
  });

  it('eine stumme Box (Herzschlag älter als 90 s) ist markiert', () => {
    const b = gsBlatt('aktiv', JETZT);
    b.boxen[1].zuletzt_gesehen = new Date(JETZT.getTime() - 30 * 60_000).toISOString();
    expect(boxSpalten(b, null, NAMEN, JETZT)[1].erreichbar).toEqual({ text: 'Herzschlag vor 30 min', warnung: true });
  });
});

describe('AP-15 IP-24 · Zweischritt (R12)', () => {
  it('Übergangsstand „1 von 2 Boxen hat bestätigt“ mit der Box, auf die gewartet wird — kein Zielstand', () => {
    const l = zweischrittLage(gsBlatt('uebergang', JETZT), NAMEN);
    expect(l.art).toBe('uebergang');
    expect(l.text).toContain('1 von 2 Boxen hat bestätigt');
    expect(l.text).toContain('wartet auf Box Verwaltung');
    expect(l.text).not.toMatch(/Zielstand steht/);
    expect(l.wartetAuf).toEqual(['Verwaltung']);
  });

  it('Zielstand gesendet, aber nicht quittiert: noch nicht „steht“', () => {
    const b = gsBlatt('aktiv', JETZT);
    const l = zweischrittLage({ ...b, zweischritt: { ...b.zweischritt!, bestaetigt: [GS_IDS.e1], wartet_auf: [GS_IDS.e4] } }, NAMEN);
    expect(l.art).toBe('ziel_gesendet');
    expect(l.text).not.toMatch(/steht/);
  });

  it('Zielstand steht erst, wenn die api ihn meldet und jede Box quittiert hat', () => {
    expect(zweischrittLage(gsBlatt('aktiv', JETZT), NAMEN)).toMatchObject({ art: 'ziel', wartetAuf: [] });
    expect(zweischrittLage(gsBlatt('s1', JETZT), NAMEN).art).toBe('kein_dokument');
  });
});

describe('AP-15 IP-24 · Kopf und I1-Liste', () => {
  it('Kopf: Stufe und Epoche; wer angehalten hat', () => {
    expect(kopfZeile(gsBetreiberZustand('beobachtet'))).toBe('S1 · beobachtet · Epoche 0');
    expect(kopfZeile(gsBetreiberZustand('anteile_aktiv'))).toBe('S3 · Anteile aktiv · Epoche 1');
    expect(kopfZeile(gsBetreiberZustand('angehalten_betreiber'))).toContain('vom Betreiber angehalten');
    expect(kopfZeile(gsBetreiberZustand('angehalten'))).toContain('vom Kunden angehalten');
  });

  it('jedes Wort aus `fehlt` — auch `nachweis_fehlt`, das der Kunde nicht sieht', () => {
    const s = fehltSaetze(gsBetreiberZustand('beobachtet'), NAMEN);
    expect(s).toContain('Sprungprobe fehlt an Box Halle 1 (T5) — ohne bestandene Probe kein Scharfschalten.');
    expect(s).toContain('Sprungprobe fehlt an Box Verwaltung (T5) — ohne bestandene Probe kein Scharfschalten.');
    expect(s).toContain('Box Verwaltung meldet die Fähigkeit steuerungsverbund_anteil nicht (Edge-Update nötig).');
    expect(s).toHaveLength(4);
  });

  it('I1 VOR dem Klick: erfüllt/offen je Bedingung, Fähigkeit und Sprungprobe je Box', () => {
    const l = i1Liste(gsBetreiberZustand('beobachtet'), NAMEN);
    const stand = Object.fromEntries(l.map((p) => [p.schluessel, p.stand]));
    expect(stand).toEqual({
      netzanschluss: 'erfuellt',
      mitglieder: 'erfuellt',
      netzzaehler: 'erfuellt',
      [`faehigkeit:${GS_IDS.e1}`]: 'erfuellt',
      [`faehigkeit:${GS_IDS.e4}`]: 'offen',
      auslegung: 'erfuellt',
      [`sprungprobe:${GS_IDS.e1}`]: 'offen',
      [`sprungprobe:${GS_IDS.e4}`]: 'offen',
      signal: 'offen',
    });
    expect(scharfschaltenMoeglich(gsBetreiberZustand('beobachtet'))).toBe(false);
    expect(i1Liste(gsBetreiberZustand('geprueft'), NAMEN).every((p) => p.stand === 'erfuellt')).toBe(true);
    expect(scharfschaltenMoeglich(gsBetreiberZustand('geprueft'))).toBe(true);
  });

  it('in S0 nennt die api nur die Struktur — der Rest ist nicht beurteilt und bleibt offen', () => {
    const z = { ...gsBetreiberZustand('beobachtet'), zustand: 'erklaert' as const, fehlt: [] };
    const l = i1Liste(z, NAMEN);
    expect(l.find((p) => p.schluessel === 'netzanschluss')!.stand).toBe('erfuellt');
    expect(l.find((p) => p.schluessel === 'auslegung')!.stand).toBe('offen');
  });

  it('jeder 409-Grund steht an seiner Stelle der Liste', () => {
    const z = gsBetreiberZustand('geprueft');
    const woerter = [
      ['kein_netzanschluss', 'netzanschluss', null],
      ['grenze_fehlt', 'netzanschluss', null],
      ['box_nicht_in_anlage', 'mitglieder', GS_IDS.e4],
      ['mitsteuernde_box_misst_nicht', 'mitglieder', GS_IDS.e4],
      ['fuehrende_box_misst_nicht', 'netzzaehler', GS_IDS.e1],
      ['faehigkeit_fehlt', `faehigkeit:${GS_IDS.e4}`, GS_IDS.e4],
      ['auslegung_passt_nicht', 'auslegung', null],
      ['nachweis_fehlt', `sprungprobe:${GS_IDS.e1}`, GS_IDS.e1],
      ['vorgabe_signal_nicht_an_jeder_box', 'signal', GS_IDS.e4],
    ] as const;
    for (const [wort, punkt, box] of woerter) {
      const l = i1Liste(z, NAMEN, [{ wort, box_id: box }]);
      const offen = l.filter((p) => p.stand === 'offen');
      expect(offen.map((p) => p.schluessel), wort).toEqual([punkt]);
      const satz = WOERTER[wort].replace('{box}', box ? NAMEN.get(box)! : 'ohne Namen').replace('{richtung}', 'beide Richtungen');
      expect(offen[0].woerter, wort).toEqual([satz]);
    }
    // ein unbekanntes Wort verschwindet nicht
    expect(i1Liste(z, NAMEN, [{ wort: 'neues_wort' as never }]).at(-1)).toMatchObject({ schluessel: 'weitere', stand: 'offen', woerter: ['neues_wort'] });
  });

  it('eine Ablehnung als Satz: erst der Code, dann jedes Wort aus `fehlt`', () => {
    expect(ablehnungSaetze({ code: 'nachweis_fehlt', message: 'x', fehlt: [{ wort: 'nachweis_fehlt', box_id: GS_IDS.e4 }] }, NAMEN))
      .toEqual(['Sprungprobe fehlt an Box ohne Namen (T5) — ohne bestandene Probe kein Scharfschalten.',
        'Sprungprobe fehlt an Box Verwaltung (T5) — ohne bestandene Probe kein Scharfschalten.']);
    for (const code of ['sprungprobe_laeuft', 'netzpunkt_nicht_frisch', 'nicht_zugestellt', 'nicht_beobachtet', 'bereits_aktiv', 'vom_betreiber_angehalten', 'bereits_bestaetigt']) {
      expect(ablehnungSaetze({ code }, NAMEN)[0], code).toBe(WOERTER[code]);
    }
    expect(ablehnungSaetze({ code: 'unbekannt_neu', message: 'Die api sagt nein.' }, NAMEN)).toEqual(['Die api sagt nein.']);
  });
});

describe('AP-15 IP-24 · Darunter und Handgriffe', () => {
  it('Auslegung „passt“ oder warum nicht; unbekannt ist nicht „passt“', () => {
    const e = gsEingerichtet();
    expect(auslegungSaetze(e)[1]).toBe('Bezug: Grenze 550 kW − Vorbehalt 473 kW = 77 kW verteilbar, Rückfälle 24,6 kW — passt.');
    const nicht = { ...e, ergebnis: { einspeisung: { ...e.ergebnis!.einspeisung!, urteil: 'auslegung_passt_nicht' as const }, bezug: null } };
    expect(auslegungSaetze(nicht)[0]).toMatch(/passt nicht: die Rückfälle übersteigen/);
    expect(auslegungSaetze(nicht)[1]).toMatch(/nicht rechenbar/);
  });

  it('Sprungprobe-Protokoll: wann, Art, Sprung, Urteil, Abweichung je Sprung', () => {
    const [p] = protokollZeilen(gsBlatt('s1', JETZT, [gsProbe(GS_IDS.e1, JETZT)]), NAMEN);
    expect(p).toMatchObject({ box: 'Halle 1', art: 'Erzeugung senken', sprung: '30 kW · 2 × 60 s', urteil: 'bestanden', gilt: true });
    expect(p.abweichung).toBe('1: -0,8 kW (±3) · 2: +0,4 kW (±3)');
    const [a] = protokollZeilen(gsBlatt('s1', JETZT, [gsProbe(GS_IDS.e4, JETZT, 'ausgeloest')]), NAMEN);
    expect(a.urteil).toBe('ausgelöst — Bericht steht aus');
    expect(a.abweichung).toBe('—');
  });

  it('Sprungprobe nur in S1, und nur an einer Box, die die Fähigkeit meldet — sonst Grund statt Knopf', () => {
    const b = gsBlatt('s1', JETZT);
    expect(sprungprobeGrund(gsBetreiberZustand('beobachtet'), b.boxen[0], NAMEN)).toBeNull();
    expect(sprungprobeGrund(gsBetreiberZustand('beobachtet'), b.boxen[1], NAMEN)).toBe('Box Verwaltung meldet die Fähigkeit sprungprobe nicht.');
    expect(sprungprobeGrund(gsBetreiberZustand('geprueft'), b.boxen[0], NAMEN)).toBe('Nur in S1 (beobachtet).');
    expect(sprungprobeGrund(gsBetreiberZustand('anteile_aktiv'), b.boxen[0], NAMEN)).toBe('Nur in S1 (beobachtet).');
  });

  it('Sprung ≤ 50 kW, größer 0, deutsche Zahl', () => {
    expect(sprungEingabe('30')).toEqual({ kw: 30, fehler: null });
    expect(sprungEingabe('12,5')).toEqual({ kw: 12.5, fehler: null });
    expect(sprungEingabe('50')).toEqual({ kw: 50, fehler: null });
    expect(sprungEingabe('50,1').fehler).toBe('Höchstens 50 kW.');
    expect(sprungEingabe('0').fehler).toBe('Der Sprung liegt über 0 kW.');
    expect(sprungEingabe('').fehler).toBe('Bitte eine Zahl in kW eingeben.');
  });
});
