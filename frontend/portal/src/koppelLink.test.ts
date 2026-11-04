import { afterEach, describe, expect, it } from 'vitest';
import {
  KOPPEL_SPEICHER,
  KOPPEL_VORMERKER,
  kennungWieGedruckt,
  koppelEmpfang,
  koppelHash,
  koppelLink,
  koppelLinkAnnehmen,
  merkeKoppelRef,
  offeneKoppelRef,
  parseKoppelHash,
  vergissKoppelRef,
  VORMERK_DAUER_MS,
} from './koppelLink';
import { koppelZiel } from './koppelZiel';

afterEach(() => {
  vergissKoppelRef();
  sessionStorage.clear();
  localStorage.clear();
});

describe('Direktlink vom Gehäuse', () => {
  it('ist die Portal-Adresse mit /k/ und der Referenz', () => {
    expect(koppelLink('edge-wrk7abg')).toBe('https://portal.voltpilot.de/k/edge-wrk7abg');
    expect(koppelLink('edge-wrk7abg', 'http://localhost:5173/')).toBe('http://localhost:5173/k/edge-wrk7abg');
    expect(koppelHash('edge-wrk7abg')).toBe('#/k/edge-wrk7abg');
  });

  it('liest die Referenz kanonisch und nur mit gültigem Prüfzeichen', () => {
    expect(parseKoppelHash('#/k/edge-wrk7abg')).toBe('edge-wrk7abg');
    expect(parseKoppelHash('#/K/EDGE-WRK7ABG/')).toBe('edge-wrk7abg');
    expect(parseKoppelHash('#k/edge-wrk7abg?utm=x')).toBe('edge-wrk7abg');
    expect(parseKoppelHash('#/k/edge%2Dwrk7abg')).toBe('edge-wrk7abg');
    expect(parseKoppelHash('#/k/edge-wrk7abh')).toBeNull();
    expect(parseKoppelHash('#/k/VP-123')).toBeNull();
    expect(parseKoppelHash('#/k/%E0%A4%A')).toBeNull();
    expect(parseKoppelHash('#/anlage/edge-wrk7abg')).toBeNull();
    expect(parseKoppelHash('')).toBeNull();
  });

  it('zeigt die Kennung wie gedruckt (Großbuchstaben des Gehäuses)', () => {
    expect(kennungWieGedruckt('edge-wrk7abg')).toBe('EDGE-WRK7ABG');
  });

  it('merkt sich die Referenz beim Start und nimmt den Link aus der Adresse', () => {
    const ersetzt: string[] = [];
    const annahme = koppelLinkAnnehmen({ hash: '#/k/edge-wrk7abg', pathname: '/', search: '' }, (u) => ersetzt.push(u));
    expect(annahme).toEqual({ art: 'gueltig', ref: 'edge-wrk7abg' });
    expect(ersetzt).toEqual(['/#/']);
    expect(offeneKoppelRef()).toBe('edge-wrk7abg');

    // Ein verstümmelter Code merkt nichts, verschwindet aber auch aus der Adresse - und sagt „unlesbar“ (M2).
    vergissKoppelRef();
    expect(koppelLinkAnnehmen({ hash: '#/k/kaputt', pathname: '/', search: '?x=1' }, (u) => ersetzt.push(u))).toEqual({ art: 'unlesbar' });
    expect(koppelLinkAnnehmen({ hash: '#/k/edge-wrk7abh', pathname: '/', search: '' }, (u) => ersetzt.push(u))).toEqual({ art: 'unlesbar' });
    expect(ersetzt[1]).toBe('/?x=1#/');
    expect(offeneKoppelRef()).toBeNull();

    // Jede andere Adresse bleibt, wie sie ist.
    expect(koppelLinkAnnehmen({ hash: '#/anlage/1', pathname: '/', search: '' }, (u) => ersetzt.push(u))).toBeNull();
    expect(ersetzt).toHaveLength(3);
  });

  it('prüft den Speicher noch einmal (er ist Eingabe)', () => {
    merkeKoppelRef('edge-wrk7abh');
    expect(offeneKoppelRef()).toBeNull();
    merkeKoppelRef('edge-wrk7abg');
    expect(offeneKoppelRef()).toBe('edge-wrk7abg');
    localStorage.setItem(KOPPEL_VORMERKER, '{kein json');
    sessionStorage.clear();
    expect(offeneKoppelRef()).toBeNull();
    expect(localStorage.getItem(KOPPEL_VORMERKER)).toBeNull();
  });

  it('QE-3 B: der Browser merkt sich nur die Referenz, 24 Stunden lang - über einen geschlossenen Tab hinweg', () => {
    const jetzt = Date.UTC(2026, 10, 4, 12, 0);
    merkeKoppelRef('edge-wrk7abg', jetzt);
    expect(sessionStorage.getItem(KOPPEL_SPEICHER)).toBe('edge-wrk7abg');
    expect(JSON.parse(localStorage.getItem(KOPPEL_VORMERKER)!)).toEqual({ ref: 'edge-wrk7abg', bis: jetzt + VORMERK_DAUER_MS });

    // Ein neuer Tab: der Tab-Speicher ist leer, der Vormerker trägt.
    sessionStorage.clear();
    expect(offeneKoppelRef(jetzt + VORMERK_DAUER_MS - 1)).toBe('edge-wrk7abg');
    // Nach der Frist gilt er nicht mehr und verschwindet.
    expect(offeneKoppelRef(jetzt + VORMERK_DAUER_MS)).toBeNull();
    expect(localStorage.getItem(KOPPEL_VORMERKER)).toBeNull();
  });

  it('vergisst Tab und Browser zugleich (Verbinden, Abbruch, Abmelden)', () => {
    merkeKoppelRef('edge-wrk7abg');
    vergissKoppelRef();
    expect(sessionStorage.getItem(KOPPEL_SPEICHER)).toBeNull();
    expect(localStorage.getItem(KOPPEL_VORMERKER)).toBeNull();
    expect(offeneKoppelRef()).toBeNull();
  });

  it('die Empfangsseite zeigt den Link dieses Starts, sonst eine vorgemerkte Referenz', () => {
    expect(koppelEmpfang(null)).toBeNull();
    expect(koppelEmpfang({ art: 'unlesbar' })).toEqual({ art: 'unlesbar' });
    merkeKoppelRef('edge-wrk7abg');
    expect(koppelEmpfang(null)).toEqual({ art: 'gueltig', ref: 'edge-wrk7abg' });
    // Der Link dieses Starts geht vor, auch wenn er nicht lesbar war.
    expect(koppelEmpfang({ art: 'unlesbar' })).toEqual({ art: 'unlesbar' });
  });

  it('führt den Admin in die Werkstatt, ohne Anlage in den Assistenten, mit einer in den Aufbau, mit mehreren zur Wahl', () => {
    const wege = {
      aufbau: (site: string, ref: string) => `#/anlage/${site}/modell?neu=box&ref=${ref}`,
      werkstatt: (ref: string) => `#/werkstatt?box=${ref}`,
      boxen: [] as { id: string; externalRef: string; siteId: string }[],
      darfAnlegen: true,
      darfVerbinden: true,
    };
    const ref = 'edge-wrk7abg';
    expect(koppelZiel(ref, { ...wege, admin: true, siteIds: ['s1'] })).toEqual({
      art: 'adresse',
      hash: '#/werkstatt?box=edge-wrk7abg',
    });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: [] })).toEqual({ art: 'assistent' });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: ['s1'] })).toEqual({
      art: 'adresse',
      hash: '#/anlage/s1/modell?neu=box&ref=edge-wrk7abg',
    });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: ['s1', 's2'] })).toEqual({ art: 'wahl' });
  });

  it('F-2: gehört die Box schon zum Konto, sagt das eine eigene Seite - vor jeder anderen Weiche', () => {
    const lage = {
      admin: false,
      siteIds: ['s1', 's2'],
      boxen: [{ id: 'd-9', externalRef: 'EDGE-WRK7ABG', siteId: 's2' }],
      darfAnlegen: false,
      darfVerbinden: false,
      aufbau: () => '#/x',
      werkstatt: () => '#/y',
    };
    expect(koppelZiel('edge-wrk7abg', lage)).toEqual({ art: 'schonDeins', deviceId: 'd-9', siteId: 's2' });
    expect(koppelZiel('edge-wrk7abg', { ...lage, admin: true })).toEqual({ art: 'adresse', hash: '#/y' });
  });

  it('F-9: ohne Recht zum Verbinden verwirft das Portal die Box nicht still, es nennt den Weg', () => {
    const lage = {
      admin: false,
      boxen: [],
      aufbau: () => '#/x',
      werkstatt: () => '#/y',
    };
    expect(koppelZiel('edge-wrk7abg', { ...lage, siteIds: ['s1'], darfAnlegen: true, darfVerbinden: false })).toEqual({ art: 'ohneRecht' });
    expect(koppelZiel('edge-wrk7abg', { ...lage, siteIds: [], darfAnlegen: false, darfVerbinden: true })).toEqual({ art: 'ohneRecht' });
  });
});
