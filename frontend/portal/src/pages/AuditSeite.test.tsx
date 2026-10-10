import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { routenHeute, vergissAbruf } from '../routenUhr';
import { AF_IDS, auditFeststellungBuehne } from '../test/auditFeststellungFixtures';
import { energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { AuditSeite } from './AuditSeite';

/**
 * Seite eines internen Audits: „eine Uhr“ (Befund 3) auch, wenn sie über die UUID geöffnet wird (Neuladen, Link) - die
 * Dialoge rechnen mit dem Tag der Route, nie mit dem Tag des Browsers. In der Demo laufen beide Uhren Jahre auseinander.
 */
const ROUTE = '2029-04-15T10:00:00+02:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};

describe('AuditSeite', () => {
  const original = { ...api };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:00:00+02:00'));
    vergissAbruf();
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    const ich = { kennung: me.kennung!, name: me.name! };
    const em = energiemanagementBuehne('ahrenberg', ich, () => ROUTE);
    const af = auditFeststellungBuehne('r11', ich, () => ROUTE, async () => []);
    Object.assign(api, em.routen, af.routen, { massnahmen: async () => ({ massnahmen: [] }) });
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

  it('Review P4-3: über die UUID geöffnet merkt sich die Seite den Tag der Route', async () => {
    render(<AuditSeite id={AF_IDS.au1} onListe={vi.fn()} onFeststellung={vi.fn()} />);
    await laden();
    expect(screen.getByTestId('audit-seite')).toBeTruthy();
    expect(routenHeute()).toBe('2029-04-15');
  });
});
