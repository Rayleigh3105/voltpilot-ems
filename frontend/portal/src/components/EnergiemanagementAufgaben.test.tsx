import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { setSelbstauskunft } from '../rollen';
import { vergissAbruf } from '../routenUhr';
import { energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { EnergiemanagementAufgaben } from './EnergiemanagementAufgaben';

/**
 * Reiter „Aufgaben“ (Konzept Nachweisen n1 Runde 2, §6.8): die Antwort im Kopf („● jede Aufgabe hat eine Person“) nur aus
 * einem geladenen, sichtbaren Stand - leer ist nie „alle besetzt“, und ein alter Stand steht nie unter einem neuen Tag.
 */
const JETZT = '2029-02-12T09:00:00+01:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};

describe('Reiter Aufgaben', () => {
  const original = { ...api };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    vergissAbruf();
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vergissAbruf();
    vi.useRealTimers();
  });

  async function buehne(kennung: string) {
    const me = rechteSeed(kennung).me;
    setSelbstauskunft(me);
    const em = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => JETZT);
    Object.assign(api, em.routen);
    await em.bereit;
  }

  it('Review P5-1: wer das Unternehmen nicht sieht, bekommt keine Aufgaben - und nie „jede Aufgabe hat eine Person“', async () => {
    await buehne('CB');
    // So antwortet die Route ohne unternehmensweites Lesen (EnergiemanagementPersonenService#aufgaben).
    Object.assign(api, { energiemanagementAufgaben: async () => ({ tag: '2029-02-12', aufgaben: [], leitung: [], zuordnungen: [] }) });
    render(<EnergiemanagementAufgaben onPerson={vi.fn()} onVerantwortung={vi.fn()} />);
    await laden();
    expect(screen.queryByTestId('aufgaben-status')).toBeNull();
    expect(document.body.textContent).not.toContain('jede Aufgabe hat eine Person');
    expect(screen.queryByTestId('aufgaben-liste')).toBeNull();
    expect(screen.getByTestId('aufgaben-nicht-sichtbar').textContent).toBe('Die Aufgaben sieht, wer das ganze Unternehmen sieht.');
  });

  it('Review P5-2: scheitert der Stand an einem anderen Tag, steht der alte nicht unter dem neuen Tag', async () => {
    await buehne('IK');
    render(<EnergiemanagementAufgaben onPerson={vi.fn()} onVerantwortung={vi.fn()} />);
    await laden();
    expect(screen.getByTestId('aufgaben-status')).toBeTruthy();
    expect(screen.getByTestId('aufgaben-kopf').textContent).toContain('Stand 12.02.2029');

    Object.assign(api, {
      energiemanagementAufgaben: async () => {
        throw new ApiError(503, 'Die Aufgaben ließen sich gerade nicht lesen.', { code: 'fehler', message: 'Die Aufgaben ließen sich gerade nicht lesen.' });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stand an einem anderen Tag' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Tag' }));
    fireEvent.click(screen.getByRole('gridcell', { name: '20' }));
    await laden();

    expect(screen.getByRole('alert').textContent).toBe('Die Aufgaben ließen sich gerade nicht lesen.');
    expect(screen.queryByTestId('aufgaben-status')).toBeNull();
    const kopf = screen.getByTestId('aufgaben-kopf').textContent ?? '';
    expect(kopf).not.toContain('Stand 20.02.2029');
    expect(kopf).not.toContain('jede Aufgabe hat eine Person');
  });
});
