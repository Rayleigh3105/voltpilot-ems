import { afterEach, describe, expect, it } from 'vitest';
import {
  koppelHash,
  koppelLink,
  koppelLinkAnnehmen,
  koppelZiel,
  merkeKoppelRef,
  offeneKoppelRef,
  parseKoppelHash,
  vergissKoppelRef,
} from './koppelLink';

afterEach(() => vergissKoppelRef());

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

  it('merkt sich die Referenz beim Start und nimmt den Link aus der Adresse', () => {
    const ersetzt: string[] = [];
    const ref = koppelLinkAnnehmen({ hash: '#/k/edge-wrk7abg', pathname: '/', search: '' }, (u) => ersetzt.push(u));
    expect(ref).toBe('edge-wrk7abg');
    expect(ersetzt).toEqual(['/#/']);
    expect(offeneKoppelRef()).toBe('edge-wrk7abg');

    // Ein verstümmelter Code merkt nichts, verschwindet aber auch aus der Adresse.
    vergissKoppelRef();
    expect(koppelLinkAnnehmen({ hash: '#/k/kaputt', pathname: '/', search: '?x=1' }, (u) => ersetzt.push(u))).toBeNull();
    expect(ersetzt[1]).toBe('/?x=1#/');
    expect(offeneKoppelRef()).toBeNull();

    // Jede andere Adresse bleibt, wie sie ist.
    expect(koppelLinkAnnehmen({ hash: '#/anlage/1', pathname: '/', search: '' }, (u) => ersetzt.push(u))).toBeNull();
    expect(ersetzt).toHaveLength(2);
  });

  it('prüft den Speicher noch einmal (er ist Eingabe)', () => {
    merkeKoppelRef('edge-wrk7abh');
    expect(offeneKoppelRef()).toBeNull();
    merkeKoppelRef('edge-wrk7abg');
    expect(offeneKoppelRef()).toBe('edge-wrk7abg');
  });

  it('führt den Admin in die Werkstatt, ohne Anlage in den Assistenten, sonst in den Aufbau', () => {
    const wege = {
      aufbau: (site: string, ref: string) => `#/anlage/${site}/modell?neu=box&ref=${ref}`,
      werkstatt: (ref: string) => `#/werkstatt?box=${ref}`,
    };
    const ref = 'edge-wrk7abg';
    expect(koppelZiel(ref, { ...wege, admin: true, siteIds: ['s1'], darfAnlegen: true })).toEqual({
      art: 'adresse',
      hash: '#/werkstatt?box=edge-wrk7abg',
    });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: [], darfAnlegen: true })).toEqual({ art: 'assistent' });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: [], darfAnlegen: false })).toEqual({ art: 'keins' });
    expect(koppelZiel(ref, { ...wege, admin: false, siteIds: ['s1', 's2'], darfAnlegen: false })).toEqual({
      art: 'adresse',
      hash: '#/anlage/s1/modell?neu=box&ref=edge-wrk7abg',
    });
  });
});
