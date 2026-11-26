import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';

const direktvermarktungAkte = vi.fn();
const direktvermarktungProtokoll = vi.fn(() => Promise.resolve([]));

vi.mock('../admin/adminApi', () => ({
  adminApi: {
    direktvermarktungAkte: (siteId: string) => direktvermarktungAkte(siteId),
    direktvermarktungProtokoll: (siteId: string) => direktvermarktungProtokoll(siteId),
  },
}));

const { DirektvermarkterKarte } = await import('./DirektvermarkterKarte');

/**
 * Konzept vp-direktvermarktung-konzept d2 §7.7: die Karte „Direktvermarkter" auf Geräteakte ›
 * Verbindung - unsichtbar ohne Anschluss (keine leere Karte auf jeder Akte), nie Chiffrat/Nonce/
 * Passwort, sobald einer besteht.
 */
describe('DirektvermarkterKarte', () => {
  it('ohne siteId ruft sie keine Route auf und zeigt nichts', () => {
    const { container } = render(<DirektvermarkterKarte siteId={null} />);
    expect(direktvermarktungAkte).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('eine Anlage ohne jeden Anschluss (404) zeigt keine leere Karte', async () => {
    direktvermarktungAkte.mockRejectedValue(new ApiError(404, 'kein Anschluss für diese Anlage'));
    const { container } = render(<DirektvermarkterKarte siteId="s1" />);
    await waitFor(() => expect(direktvermarktungAkte).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('ein echter Fehler (nicht 404) wird genannt, nicht verschluckt', async () => {
    direktvermarktungAkte.mockRejectedValue(new Error('Netzwerk tot'));
    render(<DirektvermarkterKarte siteId="s1" />);
    expect(await screen.findByText(/ließ sich nicht laden/)).toBeInTheDocument();
  });

  it('zeigt Partner, Zustand, Register und Zugang - nie Chiffrat oder Nonce', async () => {
    direktvermarktungAkte.mockResolvedValue({
      siteId: 's1', tenantId: 't1', partner: 'luox', zustand: 'verbunden', zustimmungAm: null,
      startdatum: null, ende: null, aktualisiertAm: new Date().toISOString(), tunnelObenSeit: null,
      handshakeAm: null, gegenstelle: '10.44.0.1', abfragenJeMinute: 4, letzteSchreibungAm: null,
      lebenszeichenAm: new Date().toISOString(), vorgabePct: 100, einspeisungW: 12000, erzeugungW: 14000,
      netzbetreiberPct: 100, referenzW: 85000, zugangHochgeladenVon: 'kunde@example.test',
      zugangGueltigBis: new Date(Date.now() + 10 * 86400000).toISOString(), zugangFingerabdruck: 'ab:cd:ef',
      zugangZurueckgezogenAm: null, ez8Direktvermarkter: null,
    });
    render(<DirektvermarkterKarte siteId="s1" />);
    const karte = await screen.findByTestId('akte-direktvermarkter');
    expect(karte).toHaveTextContent('luox');
    expect(karte).toHaveTextContent('verbunden');
    expect(karte).toHaveTextContent('10.44.0.1');
    expect(karte).toHaveTextContent('ab:cd:ef');
    expect(karte).toHaveTextContent('kunde@example.test');
    expect(karte.textContent).not.toMatch(/chiffrat|nonce/i);
  });

  it('EZ-8-Abgleich: nennt den Namen des älteren Anlagensteuerung-Felds, wenn gesetzt', async () => {
    direktvermarktungAkte.mockResolvedValue({
      siteId: 's1', tenantId: 't1', partner: 'luox', zustand: 'verbunden', zustimmungAm: null,
      startdatum: null, ende: null, aktualisiertAm: new Date().toISOString(), tunnelObenSeit: null,
      handshakeAm: null, gegenstelle: null, abfragenJeMinute: null, letzteSchreibungAm: null,
      lebenszeichenAm: null, vorgabePct: null, einspeisungW: null, erzeugungW: null, netzbetreiberPct: null,
      referenzW: null, zugangHochgeladenVon: null, zugangGueltigBis: null, zugangFingerabdruck: null,
      zugangZurueckgezogenAm: null, ez8Direktvermarkter: 'Stadtwerke Nord',
    });
    render(<DirektvermarkterKarte siteId="s1" />);
    const karte = await screen.findByTestId('akte-direktvermarkter');
    expect(karte).toHaveTextContent('Stadtwerke Nord');
  });

  it('EZ-8-Abgleich: ohne das Feld steht auch kein Hinweis darauf in der Karte', async () => {
    direktvermarktungAkte.mockResolvedValue({
      siteId: 's1', tenantId: 't1', partner: 'luox', zustand: 'verbunden', zustimmungAm: null,
      startdatum: null, ende: null, aktualisiertAm: new Date().toISOString(), tunnelObenSeit: null,
      handshakeAm: null, gegenstelle: null, abfragenJeMinute: null, letzteSchreibungAm: null,
      lebenszeichenAm: null, vorgabePct: null, einspeisungW: null, erzeugungW: null, netzbetreiberPct: null,
      referenzW: null, zugangHochgeladenVon: null, zugangGueltigBis: null, zugangFingerabdruck: null,
      zugangZurueckgezogenAm: null, ez8Direktvermarkter: null,
    });
    render(<DirektvermarkterKarte siteId="s1" />);
    const karte = await screen.findByTestId('akte-direktvermarkter');
    expect(karte.textContent).not.toMatch(/EZ-8/);
  });

  it('getrennt (gestoert) zeigt den Warn-Ton, nicht den grünen', async () => {
    direktvermarktungAkte.mockResolvedValue({
      siteId: 's1', tenantId: 't1', partner: 'luox', zustand: 'gestoert', zustimmungAm: null,
      startdatum: null, ende: null, aktualisiertAm: new Date().toISOString(), tunnelObenSeit: null,
      handshakeAm: null, gegenstelle: null, abfragenJeMinute: null, letzteSchreibungAm: null,
      lebenszeichenAm: null, vorgabePct: null, einspeisungW: null, erzeugungW: null, netzbetreiberPct: null,
      referenzW: null, zugangHochgeladenVon: null, zugangGueltigBis: null, zugangFingerabdruck: null,
      zugangZurueckgezogenAm: null, ez8Direktvermarkter: null,
    });
    render(<DirektvermarkterKarte siteId="s1" />);
    const karte = await screen.findByTestId('akte-direktvermarkter');
    expect(karte).toHaveTextContent('gestoert');
    expect(karte).toHaveTextContent('unbekannt');
  });
});
