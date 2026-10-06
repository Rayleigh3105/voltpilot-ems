import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { setSelbstauskunft } from '../../rollen';
import { EM_IDS, energiemanagementBuehne } from '../../test/energiemanagementFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { DokumenteListe } from './DokumenteListe';

const JETZT = '2029-02-12T09:00:00+01:00';
const klick = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('Reiter „Dokumente“ (Konzept Nachweisen n1, Runde 2, §6.5)', () => {
  const original = { ...api };
  let buehne: ReturnType<typeof energiemanagementBuehne>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    buehne = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => new Date().toISOString());
    Object.assign(api, buehne.routen);
    await buehne.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vi.useRealTimers();
  });

  it('Vorgaben nach der nächsten Prüfung mit Datumsblock, das Überfällige mit „seit“ und dem Verb „Prüfen“; die Antwort als Status-Zeile', async () => {
    const offen = vi.fn();
    render(<DokumenteListe onOeffnen={offen} />);
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dokumente');
    expect(screen.getByTestId('dokumente-status').textContent).toBe('3 Prüfungen überfällig· 3 gelten');
    const zeilen = within(screen.getByTestId('dokumente-vorgaben')).getAllByRole('button');
    expect(zeilen.map((z) => z.getAttribute('data-testid'))).toEqual(['dokument-zeile-D-0003', 'dokument-zeile-D-0002', 'dokument-zeile-D-0001']);
    expect(zeilen[0].textContent).toContain('Prüfen');
    expect(within(zeilen[0]).getByRole('img').getAttribute('aria-label')).toBe('seit 01.03.2028');
    await klick(zeilen[2]);
    expect(offen).toHaveBeenCalledWith(EM_IDS.d1);
  });

  it('„Dokument festhalten“ im Menü führt in drei Schritten zu Anlegen, Fassung 1 und Freigabe', async () => {
    const offen = vi.fn();
    render(<DokumenteListe onOeffnen={offen} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await klick(await screen.findByRole('menuitem', { name: 'Dokument festhalten' }));
    const blatt = await screen.findByTestId('festhalten-blatt');
    fireEvent.click(within(blatt).getByRole('combobox', { name: 'Was?' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Risiken und Chancen/ }));
    await klick(screen.getByTestId('festhalten-weiter'));
    fireEvent.change(screen.getByTestId('festhalten-ablage'), { target: { value: 'Risiko-Register der Geschäftsführung' } });
    fireEvent.change(screen.getByTestId('festhalten-kennung'), { target: { value: 'RR-2029' } });
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(screen.getByTestId('festhalten-pruefen').textContent).toContain('Risiko-Register der Geschäftsführung · RR-2029');
    await klick(screen.getByTestId('festhalten-weiter'));
    expect(buehne.gesendet.map((g) => g.route.replace(/[0-9a-f-]{36}/, '{id}'))).toEqual([
      'POST /api/v1/energiemanagement/dokumente',
      'POST /api/v1/energiemanagement/dokumente/{id}/fassungen',
      'POST /api/v1/energiemanagement/dokumente/{id}/fassungen/1/freigeben',
    ]);
    expect(buehne.gesendet[0].koerper).toEqual({ art: 'risiken_chancen', titel: 'Risiken und Chancen', bezug: { art: 'unternehmen' } });
    expect(buehne.gesendet[1].koerper).toMatchObject({ form: 'verweis', verweis: { ablage: 'Risiko-Register der Geschäftsführung', kennung: 'RR-2029' } });
    expect(buehne.gesendet[2].koerper).toEqual({ entschieden_von: EM_IDS.IK, entschieden_am: null, begruendung: 'Erste Fassung festgehalten.' });
    expect(offen).toHaveBeenCalled();
  });

  it('wer nur liest, sieht kein Menü zum Festhalten', async () => {
    setSelbstauskunft(rechteSeed('CB').me);
    render(<DokumenteListe onOeffnen={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Weitere Aktionen' })).toBeNull();
  });
});
