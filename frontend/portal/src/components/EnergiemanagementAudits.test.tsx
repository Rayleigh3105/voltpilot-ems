import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { setSelbstauskunft } from '../rollen';
import { vergissAbruf } from '../routenUhr';
import { auditFeststellungBuehne } from '../test/auditFeststellungFixtures';
import { energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { EnergiemanagementAudits } from './EnergiemanagementAudits';

/**
 * Reiter „Audits“ (Konzept Nachweisen n1 Runde 2, §6.6) auf der Bühne R11 am 15.04.2029: Auditprogramm und
 * Feststellungen sind zwei Routen - scheitert eine, darf die andere weder verschwinden noch „alles in Ordnung“ sagen.
 */
const JETZT = '2029-04-15T10:00:00+02:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};

describe('Reiter Audits', () => {
  const original = { ...api };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    vergissAbruf();
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    const ich = { kennung: me.kennung!, name: me.name! };
    const em = energiemanagementBuehne('ahrenberg', ich, () => JETZT);
    const af = auditFeststellungBuehne('r11', ich, () => JETZT, async () => []);
    Object.assign(api, em.routen, af.routen);
    await em.bereit;
    await af.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vergissAbruf();
    vi.useRealTimers();
  });

  it('Review P4-1: scheitert die Liste der Feststellungen, steht ihr Fehlersatz da - nie „keine Feststellung offen“', async () => {
    Object.assign(api, {
      energiemanagementFeststellungen: async () => {
        throw new ApiError(503, 'Der Dienst ist gerade nicht erreichbar.', { code: 'nicht_erreichbar', message: 'Der Dienst ist gerade nicht erreichbar.' });
      },
    });
    render(<EnergiemanagementAudits onAudit={vi.fn()} onFeststellung={vi.fn()} />);
    await laden();
    const abschnitt = screen.getByTestId('feststellungen-register');
    expect(within(abschnitt).getByTestId('feststellungen-fehler').textContent).toBe('Der Dienst ist gerade nicht erreichbar.');
    expect(within(abschnitt).queryByTestId('feststellungen-leer')).toBeNull();
    // Keine Antwort im Kopf aus einer Liste, die es nicht gibt.
    expect(screen.queryByTestId('audits-status')).toBeNull();
    expect(document.body.textContent).not.toContain('keine Feststellung offen');
    // Das Auditprogramm steht trotzdem.
    expect(screen.getByTestId('audit-zeile-AU-2029-0001')).toBeTruthy();
  });

  it('Review P4-1: scheitert das Auditprogramm, stehen die Feststellungen trotzdem da', async () => {
    Object.assign(api, {
      energiemanagementAudits: async () => {
        throw new ApiError(500, 'Das Auditprogramm ließ sich nicht lesen.', { code: 'fehler', message: 'Das Auditprogramm ließ sich nicht lesen.' });
      },
    });
    render(<EnergiemanagementAudits onAudit={vi.fn()} onFeststellung={vi.fn()} />);
    await laden();
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('Das Auditprogramm ließ sich nicht lesen.');
    expect(within(screen.getByTestId('feststellungen-register')).getByTestId('feststellung-zeile-F-2029-0001')).toBeTruthy();
    expect(screen.getByTestId('audits-status')).toBeTruthy();
  });
});
