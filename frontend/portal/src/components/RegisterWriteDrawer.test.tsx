import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterWriteDrawer } from './RegisterWriteDrawer';
import type { RegisterWriteOutcome, RegisterWriteTarget } from '../api';

const registerWritePreview = vi.fn();
const registerWrite = vi.fn();
const registerWriteHistory = vi.fn();
const registerWriteTargets = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      registerWritePreview: (...a: unknown[]) => registerWritePreview(...a),
      registerWrite: (...a: unknown[]) => registerWrite(...a),
      registerWriteHistory: (...a: unknown[]) => registerWriteHistory(...a),
      registerWriteTargets: (...a: unknown[]) => registerWriteTargets(...a),
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
    scaleNote: null, registerNote: null, scaleUnit: 'kW', noteRequired: true,
    confirm: null, writesToday: 0, lane: 'primary', at: '2026-08-19T14:02:00Z',
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

/** Der primäre Wechselrichter, wie der Picker ihn liefert. */
function target(patch: Partial<RegisterWriteTarget> = {}): RegisterWriteTarget {
  return {
    lane: 'primary', deviceId: 'd-1', entityId: null, label: 'Deye SUN-30K',
    brand: 'deye', model: 'sun-30k', family: 'hybrid_3p', communication: 'solarman_v5',
    host: '192.168.0.28', port: 8899, unitId: 1, writable: true, reason: null,
    ...patch,
  };
}

/** Erst das Ziel wählen - seit Stufe 2 der erste Schritt. */
async function zielWaehlen(label = 'Deye SUN-30K') {
  await waitFor(() => expect(screen.getByTestId('regwrite-ziele')).toBeTruthy());
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  const treffer = radios.find((r) => r.closest('label')?.textContent?.includes(label));
  fireEvent.click(treffer!);
}

async function lesen() {
  await zielWaehlen();
  fireEvent.click(screen.getByText('Ist-Wert lesen'));
  await waitFor(() => expect(screen.getByTestId('regwrite-ist')).toBeTruthy());
}

describe('der Register-Drawer fährt die Zwei-Schritt-Strecke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWriteHistory.mockResolvedValue([]);
    registerWriteTargets.mockResolvedValue([target()]);
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

  it('verlangt eine Ziel-Wahl, bevor überhaupt gelesen werden kann', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('regwrite-ziele')).toBeTruthy());

    expect((screen.getByTestId('regwrite-lesen') as HTMLButtonElement).disabled).toBe(true);
    await zielWaehlen();
    expect((screen.getByTestId('regwrite-lesen') as HTMLButtonElement).disabled).toBe(false);
  });

  it('zeigt ein Gerät OHNE Schreibweg MIT seinem Grund - und lässt es nicht wählen',
    async () => {
      registerWriteTargets.mockResolvedValue([
        target(),
        target({
          lane: 'entity', entityId: 'e-1', label: 'Wallbox Hof', communication: 'goe_http_api',
          family: null, writable: false, reason: 'Dieses Gerät spricht kein Modbus.',
        }),
      ]);
      mount();
      await waitFor(() => expect(screen.getByTestId('regwrite-ziele')).toBeTruthy());

      expect(screen.getByText('Wallbox Hof')).toBeTruthy();
      expect(screen.getByTestId('regwrite-ziel-grund').textContent)
        .toContain('spricht kein Modbus');
      const radios = screen.getAllByRole('radio') as HTMLInputElement[];
      const wallbox = radios.find((r) => r.closest('label')?.textContent?.includes('Wallbox'));
      expect(wallbox!.disabled).toBe(true);
    });

  it('schickt bei einer Komponente NUR die Kennung - nie einen Host', async () => {
    registerWriteTargets.mockResolvedValue([
      target({ lane: 'entity', entityId: 'e-9', label: 'Lüftung Keller', family: null,
        communication: 'modbus_baukasten', host: '192.168.0.44', port: 1502, unitId: 3 }),
    ]);
    registerWritePreview.mockResolvedValue(outcome({ registerClass: 'unbekannt',
      registerLabel: null, beforeScaled: null, noteRequired: false }));
    mount();
    await zielWaehlen('Lüftung Keller');
    fireEvent.click(screen.getByText('Ist-Wert lesen'));
    await waitFor(() => expect(registerWritePreview).toHaveBeenCalled());

    const body = registerWritePreview.mock.calls[0][1] as Record<string, unknown>;
    expect(body.lane).toBe('entity');
    expect(body.entityId).toBe('e-9');
    expect(body.host).toBeUndefined();
  });

  it('die freie Adresse ist eine eigene Wahl - und sie sagt, dass sie nichts kennt',
    async () => {
      registerWritePreview.mockResolvedValue(outcome({ registerClass: 'unbekannt',
        registerLabel: null, beforeScaled: null, noteRequired: false }));
      mount();
      await waitFor(() => expect(screen.getByTestId('regwrite-ziele')).toBeTruthy());
      const radios = screen.getAllByRole('radio') as HTMLInputElement[];
      fireEvent.click(radios[radios.length - 1]);

      expect(screen.getByTestId('regwrite-frei')).toBeTruthy();
      // Ohne Adresse kann nichts gelesen werden.
      expect((screen.getByTestId('regwrite-lesen') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('IP-Adresse im Kunden-Netz'),
        { target: { value: '192.168.0.44' } });
      expect(screen.getByTestId('regwrite-kenntnis').textContent)
        .toContain('kennt die Register dieses Geräts nicht');

      fireEvent.click(screen.getByText('Ist-Wert lesen'));
      await waitFor(() => expect(registerWritePreview).toHaveBeenCalled());
      const body = registerWritePreview.mock.calls[0][1] as Record<string, unknown>;
      expect(body.lane).toBe('lan');
      expect(body.host).toBe('192.168.0.44');
      expect(body.port).toBe(502);
      expect(body.unitId).toBe(1);
    });

  it('zeigt den Schreibzähler und den Hinweis des Register-Wissens', async () => {
    registerWritePreview.mockResolvedValue(outcome({
      writesToday: 2, registerNote: 'Gehört zur laufenden Batteriesteuerung.',
      scaleUnit: 'kW',
    }));
    mount();
    await lesen();

    expect(screen.getByTestId('regwrite-zaehler').textContent).toContain('bereits 2×');
    expect(screen.getByTestId('regwrite-hinweis').textContent)
      .toContain('laufenden Batteriesteuerung');
    // Roh UND skaliert nebeneinander - der Moment, in dem ein Skalenfehler auffällt.
    expect(screen.getByTestId('regwrite-ist').textContent).toContain('3300 (33,0 kW)');
  });

  it('behauptet ohne bekannte Skala KEINE Einheit', async () => {
    registerWritePreview.mockResolvedValue(outcome({
      registerClass: 'unbekannt', registerLabel: null, beforeScaled: null,
      scaleUnit: null, noteRequired: false,
    }));
    mount();
    await lesen();

    const text = screen.getByTestId('regwrite-ist').textContent ?? '';
    expect(text).toContain('3300');
    expect(text).not.toContain('kW');
  });
});

describe('Stufe 3: der Verantwortungs-Satz steht in der Rückfrage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWriteHistory.mockResolvedValue([]);
    registerWriteTargets.mockResolvedValue([target()]);
  });

  it('⚠ nennt die Eigenverantwortung IM Bestätigungsschritt, nicht nur im Formular', async () => {
    registerWritePreview.mockResolvedValue(outcome());
    mount();
    await lesen();

    fireEvent.change(screen.getByLabelText(/Neuer Rohwert/), { target: { value: '7000' } });
    fireEvent.change(screen.getByLabelText(/Grund \(Pflicht\)/),
      { target: { value: 'Freigabe des Netzbetreibers' } });
    fireEvent.click(screen.getByTestId('regwrite-schreiben'));

    // Die Rückfrage ist der Moment, in dem ein Mensch die Folgen abwägt - eine
    // Eigenverantwortungs-Erklärung, die er beim Scrollen überliest, ist keine.
    const folgen = await screen.findByTestId('confirm-consequences');
    expect(folgen.textContent).toContain('auf eigene Verantwortung');
    expect(folgen.textContent).toContain('VoltPilot prüft diesen Wert nicht');
    // Und sie nennt weiter, was GLEICH bleibt.
    expect(folgen.textContent).toContain('protokolliert');
    // Ohne Klick ist NICHTS geschrieben.
    expect(registerWrite).not.toHaveBeenCalled();
  });

  it('schickt die Geräte-Kennung des GEWÄHLTEN Ziels mit', async () => {
    registerWriteTargets.mockResolvedValue([
      target(),
      target({ lane: 'lan', deviceId: 'd-2', entityId: null, label: 'Zähler Halle',
        family: null, communication: 'modbus_tcp', host: '192.168.0.44', port: 502,
        unitId: 3 }),
    ]);
    registerWritePreview.mockResolvedValue(outcome());
    mount();
    await zielWaehlen('Zähler Halle');
    fireEvent.click(screen.getByText('Ist-Wert lesen'));
    await waitFor(() => expect(registerWritePreview).toHaveBeenCalled());

    // Auf einer Anlage mit mehreren Boxen darf nicht die zufällig erste den
    // Auftrag ausführen.
    expect(registerWritePreview.mock.calls[0][1]).toMatchObject({
      deviceId: 'd-2', lane: 'lan', host: '192.168.0.44', port: 502, unitId: 3,
    });
  });
});
