import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SteuerartDialog } from './SteuerartDialog';
import type { SteuerartOptionen } from '../steuerartDialog';
import type { VerbraucherEintrag } from '../verbraucherZone';

const VORGABEN = {
  schwelleKw: 3,
  preisgrenzeCtKwh: 12,
  mindestlaufzeitMinuten: 10,
  fenster: { tage: 'daily', von: '13:00', bis: '14:00' },
  zielUhrzeit: '06:00',
  zielTage: 'daily',
  zielEnergieKwh: 20,
  zielLaufzeitMinuten: 60,
  zielFensterStunden: 12,
};

function optionen(over: Partial<SteuerartOptionen> = {}): SteuerartOptionen {
  return {
    schreibbar: true,
    quellen: [
      { id: 'ueberschuss', gesperrt: false },
      { id: 'feste_zeiten', gesperrt: false },
      { id: 'guenstig', gesperrt: true, grund: 'Ihr Stromtarif hat keine stündlichen Preise.' },
      { id: 'sofort', gesperrt: false },
    ],
    ziele: [{ id: 'laufzeit_bis', gesperrt: false }],
    vorgaben: VORGABEN,
    ...over,
  };
}

function heizstab(over: Partial<VerbraucherEintrag> = {}): VerbraucherEintrag {
  return {
    entityId: 'e1',
    name: 'Heizstab Keller',
    typ: 'heating-rod',
    typLabel: 'Heizstab',
    ladepunkt: false,
    steuerart: { quelle: 'eigene_regel', herkunft: 'policy' },
    regeln: 1,
    optionen: optionen(),
    ...over,
  };
}

describe('Der Steuerart-Dialog', () => {
  it('führt vom Bestand „Eigene Regel" zur gespeicherten Überschuss-Steuerart', () => {
    const onSpeichern = vi.fn();
    render(<SteuerartDialog eintrag={heizstab()} onSpeichern={onSpeichern} onClose={() => {}} />);

    // Schritt 1: die Quelle. Sie startet OHNE Wahl — eine „Eigene Regel" wird
    // nicht umgedeutet.
    expect(screen.getByText('Womit soll dieses Gerät laufen?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Solar-Überschuss/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: /Solar-Überschuss/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Schritt 2: die Folgefragen dieser Quelle, mit den Server-Vorgaben.
    expect(screen.getByLabelText(/Ab wie viel Überschuss/)).toHaveValue(3);
    expect(screen.getByLabelText(/Mindestlaufzeit/)).toHaveValue(10);
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Schritt 3: das Ziel — „Kein Ziel" steht vorn.
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Schritt 4: die Folgen-Karte, DANN erst speichern.
    expect(screen.getByText(/sobald Ihre PV mehr als 3 kW übrig hat/)).toBeInTheDocument();
    expect(screen.getByText(/Ihre Regel geht weiterhin vor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSpeichern).toHaveBeenCalledWith({
      quelle: 'ueberschuss', schwelleKw: 3, mindestlaufzeitMinuten: 10,
    });
  });

  it('zeigt eine gesperrte Karte MIT Grund und lässt sie nicht wählen', () => {
    render(<SteuerartDialog eintrag={heizstab()} onSpeichern={() => {}} onClose={() => {}} />);
    const karte = screen.getByRole('radio', { name: /Günstige Stunden/ });
    expect(karte).toBeDisabled();
    expect(screen.getByText('Ihr Stromtarif hat keine stündlichen Preise.')).toBeInTheDocument();
  });

  it('überspringt den Ziel-Schritt, wo der Typ keines kennt', () => {
    render(
      <SteuerartDialog
        eintrag={heizstab({ optionen: optionen({ ziele: [] }) })}
        onSpeichern={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Solar-Überschuss/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    // Direkt auf der Folgen-Karte — keine leere Ziel-Seite dazwischen.
    expect(screen.getByRole('heading', { name: 'Das passiert jetzt' })).toBeInTheDocument();
  });

  it('überspringt auch den Folgefragen-Schritt, wo die Quelle nichts fragt', () => {
    render(
      <SteuerartDialog
        eintrag={heizstab({ optionen: optionen({ ziele: [] }) })}
        onSpeichern={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Ohne Steuerung durch VoltPilot/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByRole('heading', { name: 'Das passiert jetzt' })).toBeInTheDocument();
    expect(screen.getByText(/VoltPilot schaltet es nicht/)).toBeInTheDocument();
  });

  it('nennt „Sofort" am Ladepunkt anders als am Heizstab', () => {
    render(
      <SteuerartDialog
        eintrag={heizstab({
          typ: 'wallbox', ladepunkt: true, name: 'Wallbox Garage',
          optionen: optionen({ ziele: [{ id: 'bis_uhrzeit', gesperrt: false }] }),
        })}
        onSpeichern={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Womit soll geladen werden?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Sofort laden/ })).toBeInTheDocument();
  });

  it('öffnet mit dem Wunsch eines Vorschlags auf der Folgen-Karte', () => {
    // §6.1: „Übernehmen" zeigt zuerst, was passiert — die Folgen-Karte steht
    // IMMER vor der Aktivierung.
    render(
      <SteuerartDialog
        eintrag={heizstab()}
        vorbelegung={{ quelle: 'ueberschuss', schwelleKw: 2.5 }}
        onSpeichern={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Das passiert jetzt' })).toBeInTheDocument();
    expect(screen.getByText(/mehr als 2,5 kW/)).toBeInTheDocument();
  });

  it('zeigt den Server-Satz einer abgelehnten Speicherung', () => {
    render(
      <SteuerartDialog
        eintrag={heizstab()}
        fehler="Diese Anlage hat keine PV — ohne Erzeugung gibt es keinen Überschuss."
        onSpeichern={() => {}}
        onClose={() => {}}
      />,
    );
    expect(within(screen.getByRole('alert')).getByText(/keine PV/)).toBeInTheDocument();
  });
});
