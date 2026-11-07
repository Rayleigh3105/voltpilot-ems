import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Funktionen } from '../api';
import type { ChargePoint, SiteCharging } from '../ladepunkte';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { SchnellLadenZeile } from './SchnellLadenZeile';

/**
 * Die Zeile „Auto steckt · Jetzt schnell laden“ im Cockpit (Kapitän
 * 07.11.2026, F3 b, F4 a): sie sendet denselben Auftrag wie der Reiter Laden,
 * mit der Vorwahl „bis Abstecken“, und erscheint ohne Recht oder in Ruhe nicht.
 */
const SITE = FIXTURE_IDS.an1;
const NOW = Date.parse('2026-11-07T11:10:00Z');

const garage = (con: Record<string, unknown> = {}): ChargePoint => ({
  deviceId: 'box-1', chargePointId: 'CP-GARAGE', label: 'Wallbox Garage', priority: false,
  connected: true, ready: true, lastSeen: '2026-11-07T11:09:50Z',
  quelle: { source: 'nur_sonne', minKw: null, storageRelease: false },
  connectors: [{
    connectorId: 1, status: 'SuspendedEVSE', charging: true, powerKw: 0, allocatedKw: 0,
    sessionSince: '2026-11-07T10:53:00Z', reason: 'kein_ueberschuss', ...con,
  }],
});
// Die Box im Feld vor dem Fix: sie meldet die Bahn der Anlage nicht.
const charging = (cp: ChargePoint = garage()): SiteCharging => ({
  budget: { deviceId: 'box-1', enabled: true, controlEnabled: true, connectorCount: 1, gridLimitKw: 22, surplusActive: false },
  chargers: [cp],
} as SiteCharging);

const mitRecht = (ja: boolean) => {
  const me = rechteSeed('JW').me;
  const ohne = (l: string[]) => l.filter((a) => a !== 'handeingriff.setzen');
  setSelbstauskunft({
    ...me,
    unternehmen_rechte: ja ? [...ohne(me.unternehmen_rechte), 'handeingriff.setzen'] : ohne(me.unternehmen_rechte),
    standorte: me.standorte.map((s) => ({ ...s, rechte: ja ? [...ohne(s.rechte), 'handeingriff.setzen'] : ohne(s.rechte) })),
  });
};

function zeige(c: SiteCharging = charging(), onGesendet = vi.fn()) {
  render(
    <SchnellLadenZeile siteId={SITE} charging={c} betriebsart={null} ladepunktAnzahl={1} nowMs={NOW} onGesendet={onGesendet} />,
  );
  return onGesendet;
}

beforeEach(() => {
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

describe('SchnellLadenZeile', () => {
  it('sendet „Schnell bis zum Abstecken“ für genau diese Ladung', async () => {
    mitRecht(true);
    const boost = vi.spyOn(api, 'chargingBoost').mockResolvedValue({} as never);
    const onGesendet = zeige();
    expect(screen.getByText('Wallbox Garage')).toBeTruthy();
    expect(screen.getByText('Auto steckt · wartet auf Sonne')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Jetzt schnell laden/ }));
    // Der bestehende Handeingriff-Dialog, vorgewählt „bis Abstecken“ (F4 a).
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('bis Abstecken, höchstens 14 Std');
    expect(dialog.textContent).toContain('Endet beim Abstecken, spätestens nach 14 Stunden');
    fireEvent.click(screen.getByRole('button', { name: 'Schnell laden bis zum Abstecken' }));
    await waitFor(() => expect(boost).toHaveBeenCalledTimes(1));
    expect(boost).toHaveBeenCalledWith(SITE, { chargePointId: 'CP-GARAGE', connectorId: 1, action: 'voll', untilUnplug: true });
    await waitFor(() => expect(onGesendet).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Wallbox Garage: Schnell gesendet. Ob die Box übernimmt, steht gleich hier.');
  });

  it('nimmt „Schnell“ mit „Zurück zu Smart“ zurück', async () => {
    mitRecht(true);
    const boost = vi.spyOn(api, 'chargingBoost').mockResolvedValue({} as never);
    zeige(charging(garage({ status: 'Charging', powerKw: 11, boost: true, reason: 'laedt' })));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu Smart' }));
    await waitFor(() => expect(boost).toHaveBeenCalledWith(SITE, { chargePointId: 'CP-GARAGE', connectorId: 1, cancel: true }));
  });

  it('erscheint ohne das Recht „Handeingriff“ nicht', () => {
    mitRecht(false);
    const { container } = render(
      <SchnellLadenZeile siteId={SITE} charging={charging()} betriebsart={null} ladepunktAnzahl={1} nowMs={NOW} onGesendet={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });

  it('erscheint nicht, solange die Steuerung ruht', async () => {
    mitRecht(true);
    const f: Funktionen = structuredClone(ahrenbergFunktionen());
    Object.assign(f.standorte[0].steuern.anlagen[0].teilnahme, { zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00' });
    vi.mocked(api.funktionen).mockResolvedValue(f);
    zeige();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Jetzt schnell laden/ })).toBeNull());
  });

  it('zeigt bei einem Auto ohne Ladevorgang den Ausweg statt eines Knopfs', () => {
    // Pilotanlage 07.11.2026: SuspendedEVSE, aber die Box kennt keinen Ladevorgang -
    // „Schnell“ endete beim Server in „An diesem Stecker läuft gerade kein Ladevorgang.“
    mitRecht(true);
    const boost = vi.spyOn(api, 'chargingBoost');
    zeige(charging(garage({ charging: false, sessionSince: null, allocatedKw: null, reason: null, powerKw: null })));
    expect(screen.getByText('Auto steckt · kein Ladevorgang')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(
      'Die Wallbox hat für dieses Auto keinen Ladevorgang begonnen. Stecker kurz ziehen und wieder einstecken.',
    );
    expect(screen.queryByRole('button', { name: /Jetzt schnell laden/ })).toBeNull();
    expect(boost).not.toHaveBeenCalled();
  });

  it('erscheint für Betreiber nicht (F5 a)', () => {
    mitRecht(true);
    const { container } = render(
      <SchnellLadenZeile siteId={SITE} charging={charging()} betriebsart="betreiber" ladepunktAnzahl={1} nowMs={NOW} onGesendet={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });
});
