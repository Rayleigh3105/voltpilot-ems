import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { EM_IDS, energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { DokumentSeite } from './DokumentSeite';

const JETZT = '2029-02-12T09:00:00+01:00';

async function waehle(label: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
const klick = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('Seite eines Dokuments (Konzept Nachweisen n1, Runde 2, §6.5)', () => {
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

  const zeige = async (id: string) => {
    render(<DokumentSeite id={id} onListe={() => {}} />);
    await act(async () => {});
  };

  it('Kopf mit Titel des Kunden, Kurzzeile und Status-Zeile; Stufen mit Tag; das Kennzeichen nur leise hinter dem Titel', async () => {
    await zeige(EM_IDS.d3);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rechtskataster EnergieD-0003');
    expect(screen.getByTestId('dokument-kopf').textContent).toContain('Fassung 1 · Verweis');
    expect(screen.getByTestId('dokument-status').textContent).toBe('Prüfung seit 01.03.2028· gilt');
    expect(within(screen.getByTestId('dokument-stufen')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'Freigegeben: 01.03.2027',
      'Prüfen: seit 01.03.2028',
    ]);
    // Ein Verweis IST das Original: die Karte nennt, wo es geführt wird, mit „Original prüfen“.
    expect(screen.getByTestId('dokument-original').textContent).toContain('Rechtskataster-Dienst, Mandant Ahrenberg');
    expect(screen.getByTestId('original-pruefen')).toBeTruthy();
  });

  it('die Prüfung ist überfällig: „Prüfen“ ist der erste Knopf im Entscheid der Wiedervorlage; „Ja, bleibt“ hält „geprüft, bleibt“ fest', async () => {
    await zeige(EM_IDS.d1);
    expect(screen.getByTestId('dokument-status').textContent).toBe('Prüfung seit 10.12.2028· gilt');
    const aktionen = screen.getByTestId('dokument-aktionen');
    expect(aktionen.getAttribute('data-entscheid')).toBe('dokument_ueberpruefung');
    expect(aktionen.querySelector('button')?.textContent).toBe('Prüfen');

    await klick(screen.getByTestId('dokument-pruefen'));
    const blatt = await screen.findByTestId('ueberpruefung-blatt');
    expect(within(blatt).getByRole('group', { name: 'Gilt Fassung 1 noch?' })).toBeTruthy();
    await klick(screen.getByTestId('ueberpruefung-senden'));
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/geprueft'))).toEqual([]);

    await waehle('Wer hat entschieden?', /^Robert Falk/);
    fireEvent.change(screen.getByTestId('ueberpruefung-begruendung'), { target: { value: 'Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.' } });
    await klick(screen.getByTestId('ueberpruefung-senden'));
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/geprueft'))).toEqual([
      {
        route: `POST /api/v1/energiemanagement/dokumente/${EM_IDS.d1}/geprueft`,
        koerper: { entschieden_von: EM_IDS.RF, am: null, begruendung: 'Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.' },
      },
    ]);
    expect(screen.queryByTestId('ueberpruefung-blatt')).toBeNull();
    expect(screen.getByTestId('dokument-status').textContent).toBe('gilt· Robert Falk');
    expect(screen.getByTestId('dokument-stufen').textContent).toContain('bis 12.02.2030');
  });

  it('Neu fassen und gleich freigeben: das Neue steht hinterlegt, „Eine Person gibt frei“ steht VORAB da, danach fragt VoltPilot nach der Bekanntmachung', async () => {
    await zeige(EM_IDS.d1);
    await klick(screen.getByTestId('dokument-neu-fassen'));
    const alt = (screen.getByTestId('neu-fassen-wortlaut') as HTMLTextAreaElement).value;
    fireEvent.change(screen.getByTestId('neu-fassen-wortlaut'), { target: { value: `${alt} Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.` } });
    await klick(screen.getByRole('radio', { name: 'Eigener Grund' }));
    fireEvent.change(screen.getByTestId('neu-fassen-begruendung'), { target: { value: 'Hinweis aus dem internen Audit 2029 zur Einarbeitung.' } });
    await klick(screen.getByTestId('neu-fassen-weiter'));
    expect(screen.getByTestId('neu-fassen-neu').textContent).toBe('Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.');
    await klick(screen.getByRole('radio', { name: 'Gleich freigeben' }));
    await klick(screen.getByTestId('neu-fassen-speichern'));

    const blatt = await screen.findByTestId('freigeben-blatt');
    expect(within(blatt).getByTestId('freigeben-personen').textContent).toContain('Eine Person gibt frei');
    expect((within(blatt).getByTestId('freigeben-begruendung') as HTMLTextAreaElement).value).toBe('Hinweis aus dem internen Audit 2029 zur Einarbeitung.');
    await klick(screen.getByTestId('freigeben-senden'));
    // Bei der Energiepolitik entscheidet die Leitung - sie ist die einzige Person zur Wahl und schon gewählt.
    expect(buehne.gesendet.find((g) => g.route.endsWith('/fassungen/2/freigeben'))?.koerper).toEqual({
      entschieden_von: EM_IDS.RF,
      entschieden_am: '2029-02-12',
      begruendung: 'Hinweis aus dem internen Audit 2029 zur Einarbeitung.',
    });
    expect(buehne.gesendet.some((g) => g.route.endsWith('/beantragen'))).toBe(false);

    const bekannt = await screen.findByTestId('bekanntmachen-blatt');
    await klick(within(bekannt).getByRole('checkbox', { name: 'Aushang' }));
    await klick(within(bekannt).getByRole('checkbox', { name: 'Intranet' }));
    await klick(screen.getByTestId('bekanntmachen-senden'));
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/bekanntmachungen')).map((g) => g.koerper)).toEqual([
      { kreis: 'alle Mitarbeitenden beider Werke', weg: 'aushang', am: '2029-02-12' },
      { kreis: 'alle Mitarbeitenden beider Werke', weg: 'intranet', am: '2029-02-12' },
    ]);
    expect(screen.getByTestId('dokument-stufen').textContent).toContain('Bekannt12.02.2029');
    expect(screen.getByTestId('dokument-wortlaut').querySelector('mark')?.textContent).toBe('Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.');
  });

  it('Vier-Augen steht VORAB im Blatt: „Freigabe beantragen“ mit „Zwei Personen prüfen“ - ohne roten Fehlversuch (Befund 6)', async () => {
    buehne.setzeVierAugen(true);
    const d = await api.energiemanagementDokumentAnlegen({ art: 'verfahren', titel: 'Vorgehen Messplanung', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, { form: 'wortlaut', wortlaut: 'Fassung 1.' });
    await zeige(d.id);
    expect(screen.getByTestId('dokument-status').textContent).toBe('Fassung 1 wartet auf Freigabe');
    await klick(screen.getByTestId('dokument-freigeben'));
    const blatt = await screen.findByTestId('freigeben-blatt');
    expect(within(blatt).getByTestId('freigeben-personen').textContent).toContain('Zwei Personen prüfen');
    expect(within(blatt).queryByRole('alert')).toBeNull();
    await waehle('Wer hat entschieden?', /^Ines Kaltenbach/);
    fireEvent.change(within(blatt).getByTestId('freigeben-begruendung'), { target: { value: 'Abgestimmt im Energieteam am 10.02.2029.' } });
    await klick(screen.getByTestId('freigeben-senden'));
    expect(buehne.gesendet.filter((g) => g.route.includes('/fassungen/1/')).map((g) => g.route.split('/').pop())).toEqual(['beantragen']);
    // Wer beantragt hat, sieht keinen Knopf; die Seite wartet auf die zweite Person.
    expect(screen.getByTestId('dokument-status').textContent).toBe('Fassung 1 wartet auf Bestätigung');
    expect(screen.queryByTestId('dokument-bestaetigen')).toBeNull();
  });

  it('die zweite Person lehnt eine beantragte Fassung ab - mit Grund; danach ist ein neuer Entwurf möglich (Entscheid 11)', async () => {
    buehne.setzeVierAugen(true);
    const d = await api.energiemanagementDokumentAnlegen({ art: 'verfahren', titel: 'Vorgehen Messplanung', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, { form: 'wortlaut', wortlaut: 'Fassung 1.' });
    await api.energiemanagementFassungBeantragen(d.id, 1, { entschieden_von: EM_IDS.IK, begruendung: 'Abgestimmt im Energieteam.' });
    setSelbstauskunft(rechteSeed('JW').me);
    await zeige(d.id);
    await klick(screen.getByTestId('dokument-bestaetigen'));
    const blatt = await screen.findByTestId('bestaetigen-blatt');
    await klick(within(blatt).getByRole('radio', { name: /Ablehnen/ }));
    await klick(screen.getByTestId('bestaetigen-senden'));
    expect(within(blatt).getByRole('alert').textContent).toContain('10 bis 500 Zeichen');
    fireEvent.change(within(blatt).getByTestId('bestaetigen-begruendung'), { target: { value: 'Halle 2 ist noch nicht in Betrieb.' } });
    await klick(screen.getByTestId('bestaetigen-senden'));
    expect(buehne.gesendet.at(-1)).toEqual({ route: `POST /api/v1/energiemanagement/dokumente/${d.id}/fassungen/1/ablehnen`, koerper: { begruendung: 'Halle 2 ist noch nicht in Betrieb.' } });
    expect(screen.getByTestId('dokument-status').textContent).toBe('noch keine Fassung');
  });

  it('Aufheben: wer, wann, warum - danach grau „aufgehoben seit …“, ohne Knöpfe, alle Fassungen lesbar (Entscheid 12)', async () => {
    await zeige(EM_IDS.d3);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await klick(await screen.findByRole('menuitem', { name: 'Aufheben' }));
    const blatt = await screen.findByTestId('aufheben-blatt');
    await waehle('Wer hat entschieden?', /^Ines Kaltenbach/);
    fireEvent.change(within(blatt).getByTestId('aufheben-begruendung'), { target: { value: 'Ersetzt durch das Rechtskataster der Gruppe.' } });
    await klick(screen.getByTestId('aufheben-senden'));
    expect(buehne.gesendet.at(-1)?.koerper).toEqual({ entschieden_von: EM_IDS.IK, am: '2029-02-12', begruendung: 'Ersetzt durch das Rechtskataster der Gruppe.' });
    expect(screen.getByTestId('dokument-status').textContent).toBe('aufgehoben seit 12.02.2029');
    expect(screen.queryByTestId('dokument-stufen')).toBeNull();
    expect(screen.queryByTestId('dokument-neu-fassen')).toBeNull();
    expect(screen.getByTestId('zeile-fassungen')).toBeTruthy();
  });

  it('ein Nachweis hat keine Prüfung: kein „Prüfen“, kein Entscheid der Wiedervorlage', async () => {
    const d = await api.energiemanagementDokumentAnlegen({ art: 'kompetenz', titel: 'Unterweisung Zeitschaltung', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, { form: 'wortlaut', wortlaut: 'Unterweisung vom 01.02.2029, Teilnehmende siehe Liste.' });
    await api.energiemanagementFassungFreigeben(d.id, 1, { entschieden_von: EM_IDS.IK, entschieden_am: '2029-02-01', begruendung: 'Unterweisung durchgeführt und festgehalten.' });
    await zeige(d.id);
    expect(screen.getByTestId('dokument-status').textContent).toBe('festgehalten· Ines Kaltenbach');
    expect(screen.queryByTestId('dokument-pruefen')).toBeNull();
    expect(screen.queryByTestId('dokument-aktionen')).toBeNull();
  });
});
