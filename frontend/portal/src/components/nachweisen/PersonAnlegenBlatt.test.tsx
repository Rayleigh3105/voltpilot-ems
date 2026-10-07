import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api';
import { setSelbstauskunft } from '../../rollen';
import { energiemanagementBuehne } from '../../test/energiemanagementFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { PersonAnlegenBlatt } from './DokumentBlaetter';

const klick = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('Blatt „Person anlegen“ (Konzept Nachweisen n1, Befund A12)', () => {
  const original = { ...api };
  let buehne: ReturnType<typeof energiemanagementBuehne>;

  beforeEach(async () => {
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    buehne = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => '2029-02-12T09:00:00+01:00');
    Object.assign(api, buehne.routen);
    await buehne.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
  });

  it('nach halbem Erfolg fragt das Blatt nur noch die Aufgabe ab, der Knopf heißt „Aufgabe zuordnen“ und legt die Person nicht zweimal an', async () => {
    const zuordnen = buehne.routen.energiemanagementAufgabeZuordnen;
    let versuche = 0;
    api.energiemanagementAufgabeZuordnen = async (b) => {
      versuche += 1;
      if (versuche === 1) {
        throw new ApiError(503, 'nicht erreichbar', { code: 'nicht_erreichbar', message: 'nicht erreichbar' });
      }
      return zuordnen(b);
    };
    const angelegt = vi.fn();
    render(<PersonAnlegenBlatt leitung ab="2029-02-12" onClose={() => {}} onAngelegt={angelegt} />);
    // Wo nur die Leitung entscheidet, steht die Aufgabe fest - keine Wahl.
    expect(screen.queryByTestId('person-leitung-nein')).toBeNull();
    fireEvent.change(screen.getByTestId('person-name'), { target: { value: 'Robert Falk' } });
    fireEvent.change(screen.getByTestId('person-funktion'), { target: { value: 'Geschäftsführer' } });
    fireEvent.change(screen.getByTestId('person-begruendung'), { target: { value: 'Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.' } });
    await klick(screen.getByTestId('person-senden'));

    expect(screen.getByTestId('person-angelegt').textContent).toContain('Robert Falk ist angelegt');
    expect(screen.queryByTestId('person-name')).toBeNull();
    expect(screen.getByTestId('person-senden').textContent).toBe('Aufgabe zuordnen');
    expect(angelegt).not.toHaveBeenCalled();

    await klick(screen.getByTestId('person-senden'));
    // Der erste Versuch der Aufgabe scheiterte vor der Bühne; der zweite ordnet zu - die Person entstand nur einmal.
    expect(versuche).toBe(2);
    expect(buehne.gesendet.map((g) => g.route)).toEqual(['POST /api/v1/energiemanagement/personen', 'POST /api/v1/energiemanagement/aufgaben']);
    expect(angelegt).toHaveBeenCalledWith(expect.objectContaining({ name: 'Robert Falk' }));
  });

  it('Review r1, P2-1: das Absenden bleibt im Blatt - das Formular darunter (Freigeben, Aufheben) wird nicht mit abgesendet', async () => {
    const aussen = vi.fn();
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          aussen();
        }}
      >
        <PersonAnlegenBlatt leitung ab="2029-02-12" onClose={() => {}} onAngelegt={() => {}} />
      </form>,
    );
    fireEvent.change(screen.getByTestId('person-name'), { target: { value: 'Robert Falk' } });
    fireEvent.change(screen.getByTestId('person-funktion'), { target: { value: 'Geschäftsführer' } });
    fireEvent.change(screen.getByTestId('person-begruendung'), { target: { value: 'Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.' } });
    await klick(screen.getByTestId('person-senden'));
    expect(buehne.gesendet.map((g) => g.route)).toContain('POST /api/v1/energiemanagement/personen');
    expect(aussen).not.toHaveBeenCalled();
  });
});
