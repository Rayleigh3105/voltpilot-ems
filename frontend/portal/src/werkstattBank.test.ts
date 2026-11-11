import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bildschirm,
  fortschritt,
  freigabeZeile,
  heute,
  phasen,
  uebersicht,
  type LaufStand,
  type WerkstattAnsicht,
  type WerkstattDienst,
  type WerkstattLauf,
} from './werkstattBank';
import type { WerkstattBox } from './werkstatt';

/** Die Ansicht, wie Go sie schreibt (TestAnsichtVektor), Vertrag werkstatt-ansicht-v1. */
const vektor: WerkstattAnsicht = JSON.parse(
  readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-ansicht-v1.example.json'), 'utf8'),
);

const dienst = (ansicht: WerkstattAnsicht | null, aktuell = true, laeufe: WerkstattLauf[] = []): WerkstattDienst => ({
  ansicht, gemeldetAm: ansicht ? ansicht.zeit : null, dienstZeit: ansicht ? ansicht.zeit : null,
  alterSekunden: ansicht ? 3 : null, aktuell, laeufe,
});

const mit = (lauf: Partial<LaufStand> | null, kabel = true): WerkstattAnsicht => ({
  ...vektor,
  werkbank: { ...vektor.werkbank, status: { ...vektor.werkbank.status, werkstatt: { kabel } } },
  lauf: lauf === null ? null : { ...(vektor.lauf as LaufStand), ...lauf },
});

describe('Werkstatt-Bildschirme aus der Ansicht des Dienstes', () => {
  it('liest den Vektor des Dienstes', () => {
    expect(vektor.schema).toBe('vp-werkstatt-ansicht.v1');
    expect(vektor.lauf?.zustand).toBe('laeuft');
    expect(vektor.lauf?.box).toBe('edge-k7m2xq3');
    expect(vektor.werkbank.status?.werkstatt?.kabel).toBe(true);
  });

  it('sechs Phasen: was fertig ist, was läuft, was offen ist', () => {
    const p = phasen(vektor.lauf as LaufStand);
    expect(p.map((x) => x.titel)).toEqual(['Erkannt', 'Aufgespielt', 'Einrichten', 'Bei VoltPilot anmelden',
      'Probe über den Wartungstunnel', 'Abnahme']);
    expect(p.map((x) => x.zustand)).toEqual(['ok', 'ok', 'lauf', 'offen', 'offen', 'offen']);
    const halt = phasen({ ...(vektor.lauf as LaufStand), zustand: 'angehalten', schritt: 'probe' });
    expect(halt.map((x) => x.zustand)).toEqual(['ok', 'ok', 'ok', 'ok', 'warn', 'offen']);
    expect(phasen({ ...(vektor.lauf as LaufStand), zustand: 'fertig' }).every((x) => x.zustand === 'ok')).toBe(true);
  });

  it('Restzeit und Balken; mit Einlösen zählt der Weg von Hand nicht mit', () => {
    const f = fortschritt(vektor.lauf as LaufStand);
    expect(f.anteil).toBeGreaterThan(0.3);
    expect(f.anteil).toBeLessThan(0.7);
    expect(f.restMinuten).toBeGreaterThanOrEqual(5);
    const spaet = fortschritt({ ...(vektor.lauf as LaufStand), schritt: 'uebergabe' });
    expect(spaet.restMinuten).toBe(1);
    expect(fortschritt({ ...(vektor.lauf as LaufStand), zustand: 'fertig' })).toEqual({ restMinuten: 0, anteil: 1 });
  });

  it('welcher Bildschirm gilt', () => {
    const leer = new Set<string>();
    // Dienst meldet sich nicht: nie ein alter Stand als aktuell.
    expect(bildschirm({ dienst: dienst(vektor, false), gewaehlt: true, erledigt: leer }).art).toBe('kein-dienst');
    expect(bildschirm({ dienst: dienst(null, false), gewaehlt: true, erledigt: leer }).art).toBe('kein-dienst');
    expect(bildschirm({ dienst: dienst(vektor), gewaehlt: false, erledigt: leer }).art).toBe('start');
    expect(bildschirm({ dienst: dienst(vektor), gewaehlt: true, erledigt: leer }).art).toBe('laeuft');
    expect(bildschirm({ dienst: dienst(mit({ zustand: 'wartet', wartet_auf: 'probe' })), gewaehlt: true, erledigt: leer }).art).toBe('du');
    // Ein angehaltener Lauf: eine Fall-Seite je Code; ältere Stände ohne fall nach dem Anfang des Handgriffs.
    const fall = (l: Partial<LaufStand>) => {
      const x = bildschirm({ dienst: dienst(mit({ zustand: 'angehalten', ...l })), gewaehlt: true, erledigt: leer });
      return x.art === 'fall' ? { code: x.seite.code, art: x.seite.art, bild: x.seite.bild } : { code: x.art };
    };
    expect(fall({ handgriff: 'Startlader (Handgriff M4): …' })).toEqual({ code: 'ssh_zu', art: 'hand', bild: 'startlader' });
    expect(fall({ grund: 'kein Handshake' })).toEqual({ code: 'schritt_gescheitert', art: 'hand', bild: null });
    expect(fall({ handgriff: 'Zurücksetzen: Reset-Knopf …' })).toEqual({ code: 'gl_passwort', art: 'hand', bild: 'reset' });
    expect(fall({ fall: 'gl_passwort' })).toMatchObject({ code: 'gl_passwort', bild: 'reset' });
    expect(fall({ fall: 'halb_eigene' })).toMatchObject({ code: 'halb_eigene', bild: 'reset' });
    expect(fall({ fall: 'ssh_zu' })).toMatchObject({ code: 'ssh_zu', bild: 'startlader' });
    expect(fall({ fall: 'passwort_fremd', loesung: { titel: 'x', schritte: ['y'], selbst: false, zur_seite: true } }))
      .toEqual({ code: 'passwort_fremd', art: 'seite', bild: null });
    // Zur Seite gelegt (E2, aus der API): der Lauf steht an der Werkbank nicht mehr.
    const k = (vektor.lauf as LaufStand).kennung;
    const gelegt = bildschirm({ dienst: { ...dienst(mit({ zustand: 'angehalten', fall: 'box_weg' })), zurSeite: [{ id: 'z', lauf: k, box: null, fall: 'box_weg',
      loesungTitel: null, schritt: null, grund: null, gelegtAm: vektor.zeit, gelegtVon: 'a' }] }, gewaehlt: true, erledigt: leer });
    expect(gelegt.art).toBe('anschliessen');
    // Ein Fall am Anschluss, den „Mango anschließen“ nicht schon zeigt, hat seine eigene Seite.
    const startet = bildschirm({ dienst: dienst({ ...mit(null), anschluss_fall: 'startet', anschluss_loesung: { titel: 'Die Mango startet noch.', schritte: ['Nichts tun.'], selbst: true, zur_seite: false } }), gewaehlt: true, erledigt: leer });
    expect(startet).toMatchObject({ art: 'fall', seite: { code: 'startet', art: 'warten', wo: 'anschluss' } });
    expect(bildschirm({ dienst: dienst(mit({ zustand: 'fertig' })), gewaehlt: true, erledigt: leer }).art).toBe('fertig');
    // Abgezogen nach dem Ende, oder an der Werkbank weggeklickt: die nächste Box anschließen.
    expect(bildschirm({ dienst: dienst(mit({ zustand: 'fertig' }, false)), gewaehlt: true, erledigt: leer }).art).toBe('anschliessen');
    const kennung = (vektor.lauf as LaufStand).kennung;
    const s = bildschirm({ dienst: dienst(mit({ zustand: 'fertig' })), gewaehlt: true, erledigt: new Set([kennung]) });
    expect(s).toMatchObject({ art: 'anschliessen', kabel: true, meldetSich: true, freigegeben: true });
    const ohne = bildschirm({ dienst: dienst({ ...mit(null), freigabe: { laufend: false, grund: 'Die Werkstatt ist nicht freigegeben.', boxen: 0 } }), gewaehlt: true, erledigt: leer });
    expect(ohne).toMatchObject({ art: 'anschliessen', freigegeben: false, grund: 'Die Werkstatt ist nicht freigegeben.' });
  });

  it('Freigabe in einer Zeile, die Läufe von heute, die Zeilen der Übersicht', () => {
    expect(freigabeZeile({ edgeLight: { fassung: 'edge-light-2026.11.1' }, openwrt: { fassung: '25.12.5' }, gueltigBis: '2026-11-30T08:00:00Z' }))
      .toBe('Edge Light 2026.11.1 · OpenWrt 25.12.5 · bis 30.11.');
    const lauf = (kennung: string, stand: Partial<LaufStand>, beginn: string): WerkstattLauf => ({
      kennung, freigabe: '2026-11-mango-1', boxArt: 'mango', zustand: (stand.zustand ?? 'laeuft') as WerkstattLauf['zustand'],
      schritt: stand.schritt ?? null, titel: null, grund: stand.grund ?? null, beginn, ende: null, aktualisiertAm: beginn,
      stand: { ...(vektor.lauf as LaufStand), kennung, beginn, ...stand },
    });
    const laeufe = [
      lauf('l3', { zustand: 'laeuft', box: undefined }, '2026-11-02T11:10:00Z'),
      lauf('l2', { zustand: 'angehalten', schritt: 'probe', box: 'edge-zay5sdd', grund: 'kein Handshake' }, '2026-11-02T11:05:00Z'),
      lauf('l1', { zustand: 'fertig', box: 'edge-5t2dcy6' }, '2026-11-02T10:30:00Z'),
      lauf('l0', { zustand: 'fertig', box: 'edge-alt0001' }, '2026-11-01T10:30:00Z'),
    ];
    const h = heute(laeufe, new Date('2026-11-02T12:00:00Z'));
    expect(h.map((x) => x.kennung)).toEqual(['l3', 'l2', 'l1']);
    expect(h[0].prozent).not.toBeNull();
    const box = (edgeRef: string, abnahmen: WerkstattBox['abnahmen'] = []): WerkstattBox => ({
      id: edgeRef, edgeRef, boxArt: 'edge-light', lanNetz: null, schritte: {}, notiz: null,
      angelegtAm: '2026-11-02T09:00:00Z', angelegtVon: 'Dienst', geaendertAm: '2026-11-02T09:00:00Z', abnahmen,
    });
    const abnahme = { id: 'a1', edgeRef: 'edge-5t2dcy6', hostSchluessel: 'SHA256:x', fassung: 'edge-light-2026.11.1',
      tunnelAdresse: '10.10.16.5', lanNetz: '10.213.0.1/24', pruefungen: [], probe: {} as never, notiz: null,
      erfasstAm: '2026-11-02T10:42:00Z', erfasstVon: 'Dienst', quelle: 'dienst' as const, belege: { neustart: 'ok' } };
    const z = uebersicht([box('edge-zay5sdd'), box('edge-5t2dcy6', [abnahme])], laeufe);
    expect(z.map((x) => [x.box, x.stand])).toEqual([
      [null, 'laeuft'],
      ['edge-zay5sdd', 'problem'],
      ['edge-5t2dcy6', 'abgenommen'],
    ]);
    expect(z[1].text).toBe('Probe über den Wartungstunnel');
  });
});
