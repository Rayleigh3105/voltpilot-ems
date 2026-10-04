import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../e2e/ladepunkt-ertraege-fixtures.json';
import { api, ApiError } from '../api';
import { einordnungAus, faehigkeitZeile, type LadepunktAnsicht } from '../ladepunktErtraege';
import { AUTO_PRUEFT_SATZ, LadepunktFaehigkeitDialog } from './LadepunktFaehigkeitDialog';

/**
 * **Was kann dieser Ladepunkt?** (MP-41a, BK-41 „in allen Varianten gleich“): der Installateur trägt die Fähigkeit als
 * Fassung ab einem Tag ein (Vertrag MP-31 § 2); die Einordnung nach Anlage 1 steht daneben, und ob ein Auto
 * zurückspeisen kann, prüft die Wallbox beim Anstecken — nie ein „nein“ vorab.
 */
const FX = FIXTURE as unknown as Record<string, LadepunktAnsicht>;
const V2X = FX['ladepunkt-v2h-v2g'];
const NUR_LADEN = FX['ladepunkt-nur-laden'];

afterEach(() => vi.restoreAllMocks());

function oeffnen(ladepunkt: LadepunktAnsicht, onGespeichert = vi.fn()) {
  render(
    <LadepunktFaehigkeitDialog siteId="s1" ladepunkt={ladepunkt} heute="2026-11-15" onClose={() => {}} onGespeichert={onGespeichert} />,
  );
  return onGespeichert;
}

describe('LadepunktFaehigkeitDialog', () => {
  it('ein Ladepunkt ohne Fassung steht auf „Nur laden“ und sagt, dass die Wallbox das Auto beim Anstecken prüft', () => {
    oeffnen(NUR_LADEN);
    expect(screen.getByRole('radio', { name: 'Nur laden' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Wohin?')).toBeNull();
    expect(screen.getByText('Nur laden: gewöhnlicher Verbrauch wie heute (A1 S. 26).')).toBeTruthy();
    expect(screen.getByText(AUTO_PRUEFT_SATZ)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/kann nicht zurückspeisen|\bnein\b/i);
  });

  it('schickt V2H, V2G, Leistung und „Gilt ab“ als neue Fassung', async () => {
    const setzen = vi.spyOn(api, 'ladepunktFaehigkeitSetzen').mockResolvedValue(V2X);
    const fertig = oeffnen(NUR_LADEN);
    fireEvent.click(screen.getByRole('radio', { name: 'Laden und zurückspeisen' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Ins Netz \(V2G\)/ }));
    fireEvent.change(screen.getByLabelText('Höchste Rückspeiseleistung (kW)'), { target: { value: '11' } });
    expect(screen.getByText(/Zählt wie ein Stromspeicher — Ladepunkt der Festlegung \(A1 S\. 26\)\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(fertig).toHaveBeenCalledWith(V2X));
    expect(setzen).toHaveBeenCalledWith('s1', NUR_LADEN.komponente, {
      nutzbarkeit: 'bidirektional',
      v2h: true,
      v2g: true,
      rueckspeisung_bei_einspeisung_unterbunden: false,
      rueckspeiseleistung_kw: 11,
      gueltig_ab: '2026-11-15',
    });
  });

  it('V2G schaltet die Sperre bei Netzeinspeisung ab (A1 S. 27, Fn. 22)', () => {
    oeffnen(V2X);
    const sperre = screen.getByRole('checkbox', { name: /Rückspeisen stoppen, sobald Strom ins Netz fließt/ }) as HTMLInputElement;
    expect(sperre.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Ins Netz \(V2G\)/ }));
    expect(sperre.disabled).toBe(false);
    fireEvent.click(sperre);
    expect(screen.getByText(/Zählt nicht wie ein Stromspeicher/)).toBeTruthy();
  });

  it('prüft vor dem Senden: ohne Richtung und mit 0 kW keine Anfrage', async () => {
    const setzen = vi.spyOn(api, 'ladepunktFaehigkeitSetzen');
    oeffnen(V2X);
    fireEvent.change(screen.getByLabelText('Höchste Rückspeiseleistung (kW)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('über 0 und höchstens bei 1.000 kW');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ins Haus \(V2H\)/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Ins Netz \(V2G\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('wohin der Ladepunkt zurückspeisen kann');
    expect(setzen).not.toHaveBeenCalled();
  });

  it('übersetzt die Ablehnung der Route', async () => {
    vi.spyOn(api, 'ladepunktFaehigkeitSetzen').mockRejectedValue(
      new ApiError(409, 'unverändert', { code: 'faehigkeit_unveraendert', am: '2026-11-15' }),
    );
    oeffnen(V2X);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toBe('An diesem Tag gilt schon genau diese Angabe.');
  });
});

describe('Fähigkeit in Worten', () => {
  it('Kurzblick-Zeile und Einordnung nach dem Vertrag MP-31 § 3', () => {
    expect(faehigkeitZeile(NUR_LADEN.faehigkeit)).toBe('Nur laden');
    expect(faehigkeitZeile(V2X.faehigkeit)).toBe('Laden und zurückspeisen · ins Haus (V2H) · ins Netz (V2G) · ab 01.11.2026');
    const b = { nutzbarkeit: 'bidirektional' as const, rueckspeisung_bei_einspeisung_unterbunden: false };
    expect(einordnungAus({ ...b, v2h: true, v2g: false })).toBe('ladepunkt_der_festlegung');
    expect(einordnungAus({ ...b, v2h: true, v2g: false, rueckspeisung_bei_einspeisung_unterbunden: true })).toBe(
      'alternative_zur_ausschliesslichkeit',
    );
    expect(einordnungAus({ ...b, nutzbarkeit: 'unidirektional', v2h: false, v2g: false })).toBe('sonstiger_verbrauch');
  });
});
