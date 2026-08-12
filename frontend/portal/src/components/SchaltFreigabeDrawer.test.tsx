import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchaltFreigabeDrawer } from './SchaltFreigabeDrawer';
import { TOTMANN_HINWEIS } from '../schaltFreigabe';

const switchTest = vi.fn();
const switchTestCancel = vi.fn();
const releaseSwitch = vi.fn();
const revokeSwitch = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      switchTest: (...a: unknown[]) => switchTest(...a),
      switchTestCancel: (...a: unknown[]) => switchTestCancel(...a),
      releaseSwitch: (...a: unknown[]) => releaseSwitch(...a),
      revokeSwitch: (...a: unknown[]) => revokeSwitch(...a),
    },
  };
});

function mount(props: Partial<Parameters<typeof SchaltFreigabeDrawer>[0]> = {}) {
  return render(
    <SchaltFreigabeDrawer
      open
      siteId="s-1"
      entityId="e-1"
      komponentenName="Heizstab Keller"
      onClose={vi.fn()}
      onChanged={vi.fn()}
      {...props}
    />,
  );
}

/** Schritt 1 + 2 mit gültigen Angaben durchlaufen. */
function bisZumTest(art: 'on_off' | 'setpoint' = 'on_off') {
  if (art === 'setpoint') {
    fireEvent.click(screen.getByRole('radio', { name: /Sollwert/ }));
  }
  fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '3' } });
  if (art === 'setpoint') {
    fireEvent.change(screen.getByLabelText('Kleinster Sollwert'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Größter Sollwert'), { target: { value: '10' } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  fireEvent.change(screen.getByLabelText('Nennleistung (kW)'), { target: { value: '3,5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
}

beforeEach(() => {
  switchTest.mockReset();
  switchTestCancel.mockReset();
  releaseSwitch.mockReset();
  revokeSwitch.mockReset();
});

describe('der Freigabe-Assistent', () => {
  it('lässt ohne vollständige Angaben nicht weiter', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled();
  });

  it('nennt die FOLGEN und die Totmann-Grenze, bevor irgendetwas geschaltet wird', () => {
    mount();
    bisZumTest();
    const folgen = screen.getByTestId('freigabe-folgen').textContent ?? '';
    expect(folgen).toContain('nur die Werte 1 (ein) und 0 (aus)');
    // Ein generisches Modbus-Gerät hat KEINEN eingebauten Totmann - das steht
    // wörtlich da, sonst verspricht die Fläche eine Sicherheit, die es nicht gibt.
    expect(folgen).toContain(TOTMANN_HINWEIS);
  });

  it('gibt erst nach bestandenem Test UND bestätigter Wirkung frei', async () => {
    mount();
    bisZumTest();
    const freigeben = () => screen.getByRole('button', { name: 'Steuern freigeben' });
    expect(freigeben()).toBeDisabled();

    switchTest.mockResolvedValue({ passed: true, switched: { written: 1, offAfterS: 30 } });
    fireEvent.click(screen.getByRole('button', { name: /Jetzt für 30 Sekunden einschalten/ }));
    await waitFor(() => expect(screen.getByText(/fällt in 30 Sekunden/)).toBeInTheDocument());

    // Der Test allein reicht NICHT: er beweist, dass das Register erreichbar
    // ist, nicht dass das richtige Gerät reagiert hat.
    expect(freigeben()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(freigeben()).toBeEnabled();
  });

  it('schaltet auf Wunsch SOFORT wieder aus', async () => {
    mount();
    bisZumTest();
    switchTest.mockResolvedValue({ passed: true, switched: { written: 1, offAfterS: 30 } });
    fireEvent.click(screen.getByRole('button', { name: /Jetzt für 30 Sekunden/ }));
    await waitFor(() => screen.getByRole('button', { name: 'Sofort ausschalten' }));

    switchTestCancel.mockResolvedValue({ passed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Sofort ausschalten' }));
    await waitFor(() => expect(switchTestCancel).toHaveBeenCalled());
    expect(await screen.findByText(/Abgebrochen/)).toBeInTheDocument();
  });

  it('verlangt beim Sollwert einen Testwert INNERHALB der Klemme', () => {
    mount();
    bisZumTest('setpoint');
    const feld = screen.getByLabelText(/Testwert/);
    fireEvent.change(feld, { target: { value: '30' } });
    // Die Klemme steht auch in der Folgenliste - hier zählt der FEHLER am Feld.
    expect(document.querySelector('.vp-assist-error')?.textContent)
      .toContain('zwischen 1 und 10');
    expect(screen.getByRole('button', { name: /Testwert für 30 Sekunden schreiben/ }))
      .toBeDisabled();
    fireEvent.change(feld, { target: { value: '5' } });
    expect(screen.getByRole('button', { name: /Testwert für 30 Sekunden schreiben/ }))
      .toBeEnabled();
  });

  it('entwertet einen bestandenen Test, sobald sich eine Angabe ändert', async () => {
    mount();
    bisZumTest();
    switchTest.mockResolvedValue({ passed: true, switched: { written: 1, offAfterS: 30 } });
    fireEvent.click(screen.getByRole('button', { name: /Jetzt für 30 Sekunden/ }));
    await waitFor(() => screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('checkbox'));

    // Ein anderes Register ist ein anderer Test - die Bestätigung darf nicht
    // auf eine Schaltung übertragen werden, die so nie stattgefunden hat.
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByRole('button', { name: 'Steuern freigeben' })).toBeDisabled();
  });

  it('fragt vor der Freigabe im Haus-Muster nach - mit derselben Folgenliste', async () => {
    const onChanged = vi.fn();
    mount({ onChanged });
    bisZumTest();
    switchTest.mockResolvedValue({ passed: true, switched: { written: 1, offAfterS: 30 } });
    fireEvent.click(screen.getByRole('button', { name: /Jetzt für 30 Sekunden/ }));
    await waitFor(() => screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Steuern freigeben' }));

    expect(screen.getByTestId('confirm-consequences').textContent).toContain(TOTMANN_HINWEIS);
    expect(releaseSwitch).not.toHaveBeenCalled();

    releaseSwitch.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(releaseSwitch).toHaveBeenCalled());
    expect(releaseSwitch.mock.calls[0][2]).toMatchObject({ physicallyConfirmed: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it('zeigt die gemessene Leistungsänderung als Beleg, wenn es eine gibt', async () => {
    const { rerender } = mount({ leistungJetztKw: 0.1 });
    bisZumTest();
    switchTest.mockResolvedValue({ passed: true, switched: { written: 1, offAfterS: 30 } });
    fireEvent.click(screen.getByRole('button', { name: /Jetzt für 30 Sekunden/ }));
    await waitFor(() => screen.getByRole('checkbox'));
    // Der Messwert steigt, während der Test läuft.
    rerender(
      <SchaltFreigabeDrawer
        open
        siteId="s-1"
        entityId="e-1"
        komponentenName="Heizstab Keller"
        leistungJetztKw={3.4}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/gestiegen/)).toBeInTheDocument();
  });
});

describe('die Rücknahme', () => {
  it('nennt die Folgen und nimmt erst nach der Bestätigung zurück', async () => {
    const onChanged = vi.fn();
    mount({ bereitsFreigegeben: true, onChanged });
    // Kein Assistent auf einer freigegebenen Komponente - nur der Rückweg.
    expect(screen.queryByLabelText('Adresse')).toBeNull();
    expect(screen.getByText(new RegExp(TOTMANN_HINWEIS.slice(0, 30)))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Freigabe zurücknehmen' }));
    expect(screen.getByTestId('confirm-consequences').textContent)
      .toContain('Regeln für dieses Gerät stoppen');
    expect(revokeSwitch).not.toHaveBeenCalled();

    revokeSwitch.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Zurücknehmen' }));
    await waitFor(() => expect(revokeSwitch).toHaveBeenCalledWith('s-1', 'e-1'));
    expect(onChanged).toHaveBeenCalled();
  });
});
