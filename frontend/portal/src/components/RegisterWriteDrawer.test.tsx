import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterWriteDrawer } from './RegisterWriteDrawer';
import type { RegisterWriteOutcome } from '../api';

const registerWritePreview = vi.fn();
const registerWrite = vi.fn();
const registerWriteHistory = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      registerWritePreview: (...a: unknown[]) => registerWritePreview(...a),
      registerWrite: (...a: unknown[]) => registerWrite(...a),
      registerWriteHistory: (...a: unknown[]) => registerWriteHistory(...a),
    },
  };
});

function outcome(patch: Partial<RegisterWriteOutcome> = {}): RegisterWriteOutcome {
  return {
    requestId: 'abc', mode: 'lesen', ok: true, outcome: 'gelesen',
    beforeRaw: 3300, afterRaw: null, beforeScaled: 33, afterScaled: null,
    adopted: null, errorCode: null, message: null, targetLabel: null,
    address: 231, addressHex: '0x00e7',
    registerLabel: 'Einspeisegrenze am Netzanschluss', registerClass: 'netz_compliance',
    scaleNote: null, noteRequired: true, confirm: null, at: '2026-08-19T14:02:00Z',
    ...patch,
  };
}

function mount(props: Partial<Parameters<typeof RegisterWriteDrawer>[0]> = {}) {
  return render(
    <RegisterWriteDrawer
      open
      siteId="s-1"
      deviceId="d-1"
      tenantId="t-1"
      geraetName="Deye SUN-30K"
      onClose={vi.fn()}
      {...props}
    />,
  );
}

async function lesen() {
  fireEvent.click(screen.getByText('Ist-Wert lesen'));
  await waitFor(() => expect(screen.getByTestId('regwrite-ist')).toBeTruthy());
}

describe('der Register-Drawer fährt die Zwei-Schritt-Strecke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWriteHistory.mockResolvedValue([]);
  });

  it('bietet den Schreib-Schritt erst NACH einer gelungenen Lesung an', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    mount();

    // Vor der Lesung gibt es keinen zweiten Schritt - das ist Reihenfolge, keine
    // Hürde: die Lesung IST der erste Schritt.
    expect(screen.queryByTestId('regwrite-schreiben')).toBeNull();

    await lesen();
    expect(screen.getByTestId('regwrite-ist').textContent).toMatch(/3300 \(33,0 kW\)/);
    expect(screen.getByTestId('regwrite-schreiben')).toBeTruthy();
  });

  it('nennt die Warnklasse und macht die Notiz zur PFLICHT (D5)', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    mount();
    await lesen();

    expect(screen.getByTestId('regwrite-warnung').textContent).toMatch(/Netzbetreiber/);
    fireEvent.change(screen.getByLabelText(/Neuer Rohwert/), { target: { value: '7000' } });
    // Ohne Grund bleibt der Knopf strukturell wirkungslos - und sagt es vorher.
    expect((screen.getByTestId('regwrite-schreiben') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Grund \(Pflicht\)/),
      { target: { value: 'Freigabe des Netzbetreibers' } });
    expect((screen.getByTestId('regwrite-schreiben') as HTMLButtonElement).disabled).toBe(false);
  });

  it('schreibt erst nach der Folgen-Rückfrage - und schickt den Wächter mit', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    registerWrite.mockResolvedValue(outcome({
      mode: 'schreiben', outcome: 'uebernommen', afterRaw: 7000, afterScaled: 70,
      adopted: true, targetLabel: 'Deye SUN-30K · 192.168.0.28',
    }));
    mount();
    await lesen();
    fireEvent.change(screen.getByLabelText(/Neuer Rohwert/), { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText(/Grund \(Pflicht\)/), { target: { value: 'EVU ok' } });

    fireEvent.click(screen.getByTestId('regwrite-schreiben'));
    // Der Klick öffnet die Rückfrage, er schreibt noch nicht.
    expect(registerWrite).not.toHaveBeenCalled();
    expect(screen.getByText(/GENAU EINMAL beschrieben/)).toBeTruthy();

    fireEvent.click(screen.getByText('Jetzt schreiben'));
    await waitFor(() => expect(registerWrite).toHaveBeenCalled());
    const [, body, tenant] = registerWrite.mock.calls[0];
    expect(body).toMatchObject({
      deviceId: 'd-1', address: '0x00E7', value: '7000',
      expectedBefore: 3300, note: 'EVU ok',
    });
    expect(tenant).toBe('t-1');

    await waitFor(() => expect(screen.getByTestId('regwrite-beleg')).toBeTruthy());
    expect(screen.getByTestId('regwrite-beleg').textContent).toMatch(/Übernommen/);
    expect(screen.getByTestId('regwrite-beleg').textContent).toMatch(/192\.168\.0\.28/);
  });

  it('sagt eine Ablehnung schon in der Vorschau, nie erst nach dem Klick', async () => {
    registerWritePreview.mockResolvedValue(outcome({
      ok: false, beforeRaw: null, beforeScaled: null,
      errorCode: 'refused_control_owned',
      message: 'Dieses Register gehört gerade der laufenden Steuerung.',
    }));
    mount();
    await lesen();

    expect(screen.getByTestId('regwrite-ist').textContent).toMatch(/laufenden Steuerung/);
    expect(screen.queryByTestId('regwrite-schreiben')).toBeNull();
  });

  it('entwertet die Vorschau, sobald die Adresse sich ändert', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    mount();
    await lesen();
    expect(screen.getByTestId('regwrite-schreiben')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Registeradresse/), { target: { value: '1234' } });
    // Eine andere Adresse ist ein ANDERES Register - die alte Lesung gilt nicht.
    expect(screen.queryByTestId('regwrite-schreiben')).toBeNull();
    expect(screen.queryByTestId('regwrite-ist')).toBeNull();
  });

  it('nennt eine unlesbare Adresse sofort, ohne das Gerät zu fragen', async () => {
    mount();
    // Der Verlauf laedt im Hintergrund - erst abwarten, dann tippen.
    await waitFor(() => expect(registerWriteHistory).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Registeradresse/), { target: { value: 'E7' } });
    fireEvent.click(screen.getByText('Ist-Wert lesen'));
    expect(registerWritePreview).not.toHaveBeenCalled();
    expect(screen.getByText(/hexadezimal/)).toBeTruthy();
  });

  it('verlangt nach ausgebliebener Quittung eine neue Lesung', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    registerWrite.mockResolvedValue(outcome({
      mode: 'schreiben', outcome: 'unbekannt', ok: false, errorCode: 'timeout',
      beforeRaw: null, beforeScaled: null,
      message: 'Es kam keine Rückmeldung.',
    }));
    mount();
    await lesen();
    fireEvent.change(screen.getByLabelText(/Neuer Rohwert/), { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText(/Grund \(Pflicht\)/), { target: { value: 'EVU ok' } });
    fireEvent.click(screen.getByTestId('regwrite-schreiben'));
    fireEvent.click(screen.getByText('Jetzt schreiben'));

    await waitFor(() => expect(screen.getByTestId('regwrite-beleg')).toBeTruthy());
    expect(screen.getByTestId('regwrite-beleg').textContent).toMatch(/Zustand unbekannt/);
    expect(screen.getByTestId('regwrite-beleg').textContent).not.toMatch(/nicht geschrieben/);
    // Der zweite Schritt ist wieder zu - erst neu lesen.
    expect(screen.queryByTestId('regwrite-schreiben')).toBeNull();
  });

  it('zeigt den Verlauf, ohne dass sein Fehlschlag die Strecke blockiert', async () => {
    registerWriteHistory.mockRejectedValue(new Error('weg'));
    registerWritePreview.mockResolvedValue(outcome());
    mount();
    await lesen();
    expect(screen.queryByTestId('regwrite-verlauf')).toBeNull();
    expect(screen.getByTestId('regwrite-schreiben')).toBeTruthy();
  });
});
