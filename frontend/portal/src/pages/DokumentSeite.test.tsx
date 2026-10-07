import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { EM_IDS, energiemanagementBuehne } from '../test/energiemanagementFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { zumEntscheid } from '../useEntscheidFokus';
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
    // Der Grund der Fassung steht kurz als Prüfzeile vorbelegt - „Ändern“ öffnet das Feld mit dem ganzen Text.
    expect(within(blatt).getByTestId('freigeben-grund').textContent).toContain('Hinweis aus dem internen …');
    await klick(within(within(blatt).getByTestId('freigeben-grund')).getByRole('button', { name: 'Grund ändern' }));
    expect((screen.getByTestId('freigeben-begruendung') as HTMLTextAreaElement).value).toBe('Hinweis aus dem internen Audit 2029 zur Einarbeitung.');
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
    // Review r1, P2-5: wer bekannt gemacht hat, steht im Blatt - vorbelegt mit der Person des eigenen Kontos.
    expect(within(bekannt).getByRole('combobox', { name: 'Wer hat bekannt gemacht?' }).textContent).toContain('Ines Kaltenbach');
    await klick(screen.getByTestId('bekanntmachen-senden'));
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/bekanntmachungen')).map((g) => g.koerper)).toEqual([
      { kreis: 'alle Mitarbeitenden beider Werke', weg: 'aushang', am: '2029-02-12', person_id: EM_IDS.IK },
      { kreis: 'alle Mitarbeitenden beider Werke', weg: 'intranet', am: '2029-02-12', person_id: EM_IDS.IK },
    ]);
    expect(screen.getByTestId('dokument-stufen').textContent).toContain('Bekannt12.02.2029');
    expect(screen.getByTestId('dokument-wortlaut').querySelector('mark')?.textContent).toBe('Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.');
  });

  it('die Leitung kommt aus `…/leitung`, nicht aus den Aufgaben: wer sie nicht unternehmensweit liest, gibt trotzdem frei (Befund A4)', async () => {
    // So antwortet `GET …/aufgaben` Lesern ohne unternehmensweites Recht: ohne Zeile, ohne Leitung.
    const aufgaben = api.energiemanagementAufgaben;
    api.energiemanagementAufgaben = async (tag?: string) => ({ ...(await aufgaben(tag)), leitung: [], aufgaben: [], zuordnungen: [] });
    await zeige(EM_IDS.d1);
    await klick(screen.getByTestId('dokument-neu-fassen'));
    await klick(screen.getByRole('radio', { name: 'Eigener Grund' }));
    fireEvent.change(screen.getByTestId('neu-fassen-begruendung'), { target: { value: 'Hinweis aus dem internen Audit 2029 zur Einarbeitung.' } });
    await klick(screen.getByTestId('neu-fassen-weiter'));
    await klick(screen.getByRole('radio', { name: 'Gleich freigeben' }));
    await klick(screen.getByTestId('neu-fassen-speichern'));
    const blatt = await screen.findByTestId('freigeben-blatt');
    expect(within(blatt).queryByTestId('freigabe-ohne-leitung')).toBeNull();
    await klick(screen.getByTestId('freigeben-senden'));
    expect(buehne.gesendet.find((g) => g.route.endsWith('/fassungen/2/freigeben'))?.koerper).toMatchObject({ entschieden_von: EM_IDS.RF });
  });

  it('Geltung: was nur auf einer Seite steht, in beiden Richtungen als Zeile - ohne die langen Sätze der Route (Befund A21)', async () => {
    const vergleich = api.energiemanagementVergleich;
    api.energiemanagementVergleich = async (id: string) => {
      const v = await vergleich(id);
      return {
        ...v,
        vergleich: { ...v.vergleich!, deckungsgleich: false, traeger_nur_im_anwendungsbereich: ['Fernwärme'], standorte_nur_im_betrachtungsumfang: [{ id: 'st-3', kurzzeichen: 'ST-3', name: 'Werk Kaltenbrunn' }] },
        saetze: ['Werk Kaltenbrunn gehört zum Betrachtungsumfang der energetischen Bewertung (Fassung 1), aber nicht zum Anwendungsbereich.'],
      };
    };
    await zeige(EM_IDS.d2);
    await klick(screen.getByTestId('zeile-geltung'));
    const zeilen = await screen.findByTestId('geltung-zeilen');
    await act(async () => {});
    expect(zeilen.textContent).toContain('Betrachtungsumfangweicht ab');
    expect(zeilen.textContent).toContain('Nur im AnwendungsbereichFernwärme');
    expect(zeilen.textContent).toContain('Nur im BetrachtungsumfangWerk Kaltenbrunn');
    expect(screen.getByTestId('geltung-blatt').textContent).not.toContain('gehört zum');
  });

  it('wartet eine neue Fassung neben der gültigen, steht ihr Neues beim Entscheid - mit ihrem Grund', async () => {
    const d1 = await api.energiemanagementDokument(EM_IDS.d1);
    const alt = d1.fassungen.find((f) => f.nr === d1.gueltige_fassung)!.wortlaut!;
    await api.energiemanagementFassungEntwerfen(EM_IDS.d1, {
      form: 'wortlaut',
      wortlaut: `${alt} Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.`,
      begruendung: 'Hinweis aus dem internen Audit 2029 zur Einarbeitung.',
    });
    const nr = d1.fassungen.length + 1;
    await zeige(EM_IDS.d1);
    expect(screen.getByTestId('dokument-status').textContent).toBe(`Fassung ${nr} wartet auf Freigabe`);
    const karte = screen.getByTestId('dokument-wartet');
    expect(within(karte).getByRole('heading').textContent).toBe(`Neu in Fassung ${nr}`);
    expect(karte.querySelector('mark')?.textContent).toBe('Wer neu bei uns anfängt, lernt diese Energiepolitik in der Einarbeitung kennen.');
    // Der Kasten mit dem Entscheid steht davor, der Wortlaut der gültigen Fassung bleibt daneben.
    expect(screen.getByTestId('dokument-aktionen').compareDocumentPosition(karte) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('dokument-wortlaut').textContent).not.toContain('Einarbeitung');
    await klick(within(karte).getByTestId('dokument-wartet-grund'));
    expect((await screen.findByRole('dialog')).textContent).toContain('Hinweis aus dem internen Audit 2029 zur Einarbeitung.');
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

  // ------------------------------------------------------------------ Review r1 (Nachweisen PR 2)

  /** Ein Verweis mit festgehaltener Datei, freigegeben - wie ein Rechtskataster nach dem ersten Festhalten. */
  async function verweisMitDatei() {
    const d = await api.energiemanagementDokumentAnlegen({ art: 'rechtliche_anforderungen', titel: 'Rechtskataster Umwelt', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, {
      form: 'verweis',
      verweis: { ablage: 'Rechtskataster-Dienst', bezeichnung: 'kataster-2028.pdf', kennung: 'RK-UM-01', adresse: null, fassungsangabe: 'Stand 12/2028', datum: '2028-12-01', sha256: 'a'.repeat(64) },
    });
    await api.energiemanagementFassungFreigeben(d.id, 1, { entschieden_von: EM_IDS.IK, entschieden_am: '2029-01-10', begruendung: 'Kataster durchgesehen und übernommen.' });
    return d;
  }

  it('P2-3: „Neu fassen“ eines Verweises übernimmt nicht die Prüfsumme, Bezeichnung, Fassungsangabe und den Stand der alten Datei', async () => {
    const d = await verweisMitDatei();
    await zeige(d.id);
    await klick(screen.getByTestId('dokument-neu-fassen'));
    // Wo es liegt, bleibt; die Datei beginnt leer - „Datei prüfen“ statt „Prüfsumme festgehalten“.
    expect((screen.getByTestId(/-verweis-ablage$/) as HTMLInputElement).value).toBe('Rechtskataster-Dienst');
    expect(screen.getByTestId('datei-pruefen').textContent).toContain('Datei prüfen');
    await klick(screen.getByRole('radio', { name: 'Eigener Grund' }));
    fireEvent.change(screen.getByTestId('neu-fassen-begruendung'), { target: { value: 'Neuer Stand des Katasters vom Januar 2029.' } });
    await klick(screen.getByTestId('neu-fassen-weiter'));
    await klick(screen.getByTestId('neu-fassen-speichern'));
    const v = (buehne.gesendet.filter((g) => g.route.endsWith('/fassungen')).at(-1)?.koerper as { verweis: Record<string, unknown> }).verweis;
    expect(v.ablage).toBe('Rechtskataster-Dienst');
    expect(v.kennung).toBe('RK-UM-01');
    expect(v.sha256 ?? null).toBeNull();
    expect(v.bezeichnung ?? null).toBeNull();
    expect(v.fassungsangabe ?? null).toBeNull();
    expect(v.datum ?? null).toBeNull();
  });

  it('P2-4: ist die Vier-Augen-Einstellung nicht geladen, gibt die Seite nicht als „eine Person“ frei - „Erneut laden“ holt sie', async () => {
    const vierAugen = api.unternehmenVierAugen;
    let versuche = 0;
    api.unternehmenVierAugen = async () => {
      versuche += 1;
      if (versuche === 1) throw new Error('Netz');
      return vierAugen();
    };
    buehne.setzeVierAugen(true);
    const d = await api.energiemanagementDokumentAnlegen({ art: 'verfahren', titel: 'Vorgehen Messplanung', bezug: { art: 'unternehmen' } });
    await api.energiemanagementFassungEntwerfen(d.id, { form: 'wortlaut', wortlaut: 'Fassung 1.' });
    await zeige(d.id);
    expect(screen.queryByTestId('dokument-freigeben')).toBeNull();
    expect(screen.getByTestId('vieraugen-unbekannt').textContent).toContain('Freigabe-Regel nicht geladen');
    await klick(screen.getByTestId('vieraugen-erneut'));
    expect(screen.getByTestId('dokument-freigeben').textContent).toBe('Freigabe beantragen');
  });

  it('P2-5: ohne eigene Person fragt „Bekannt machen“ nach der Person, statt an `person_fehlt` zu enden', async () => {
    setSelbstauskunft({ ...rechteSeed('IK').me, kennung: 'konto-ohne-person' });
    await zeige(EM_IDS.d1);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await klick(await screen.findByRole('menuitem', { name: 'Bekannt machen' }));
    const blatt = await screen.findByTestId('bekanntmachen-blatt');
    await klick(within(blatt).getByRole('checkbox', { name: 'Aushang' }));
    await klick(screen.getByTestId('bekanntmachen-senden'));
    expect(buehne.gesendet.some((g) => g.route.endsWith('/bekanntmachungen'))).toBe(false);
    expect(blatt.textContent).toContain('Bitte wählen Sie, wer es bekannt gemacht hat.');
    await waehle('Wer hat bekannt gemacht?', /^Jonas Wendlinger/);
    await klick(screen.getByTestId('bekanntmachen-senden'));
    expect(buehne.gesendet.filter((g) => g.route.endsWith('/bekanntmachungen')).map((g) => (g.koerper as { person_id: string }).person_id)).toEqual([EM_IDS.JW]);
  });

  it('P2-6: „Verlauf“ zeigt Bekanntmachung, „geprüft, bleibt“ und Freigabe mit Person und Grund - auch an einem aufgehobenen Dokument', async () => {
    await zeige(EM_IDS.d1);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await klick(await screen.findByRole('menuitem', { name: 'Verlauf' }));
    const zeilen = within(await screen.findByTestId('dokument-verlauf')).getAllByRole('listitem').map((li) => li.textContent);
    expect(zeilen).toEqual([
      '10.12.2027Geprüft, bleibt · Robert Falk · Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert.',
      '18.12.2026Fassung 1 bekannt gemacht · alle Mitarbeitenden beider Werke · Aushang und Intranet · Ines Kaltenbach',
      '15.12.2026Fassung 1 freigegeben · Robert Falk',
    ]);
    cleanup();
    await api.energiemanagementDokumentAufheben(EM_IDS.d3, { entschieden_von: EM_IDS.IK, am: '2029-02-12', begruendung: 'Ersetzt durch das Rechtskataster der Gruppe.' });
    await zeige(EM_IDS.d3);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Verlauf', 'Kennzeichen D-0003 kopieren']);
    await klick(screen.getByRole('menuitem', { name: 'Verlauf' }));
    expect(screen.getByTestId('dokument-verlauf').textContent).toContain('Aufgehoben · Ines Kaltenbach · Ersetzt durch das Rechtskataster der Gruppe.');
  });

  it('P2-8: die an der Karte gewählte Datei wird gleich geprüft - nicht noch einmal gewählt; scheitert die Prüfsumme, sagt es das Blatt', async () => {
    await zeige(EM_IDS.d3);
    const datei = new File(['Kataster'], 'kataster.pdf', { type: 'application/pdf' });
    const feld = screen.getByTestId('dokument-original').querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(feld, { target: { files: [datei] } });
    });
    const blatt = await screen.findByTestId('original-blatt');
    expect((await within(blatt).findByTestId('original-ergebnis')).textContent).toContain('kataster.pdf');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => Promise.reject(new Error('kein sicherer Kontext')));
    try {
      await act(async () => {
        fireEvent.change(within(blatt).getByTestId('original-pruefen').querySelector('input') as HTMLInputElement, { target: { files: [datei] } });
      });
      expect((await within(blatt).findByTestId('original-fehler')).textContent).toBe('Diese Datei ließ sich hier nicht prüfen.');
      expect(within(blatt).queryByTestId('original-ergebnis')).toBeNull();
    } finally {
      digest.mockRestore();
    }
  });

  it('P2-9: wartet ein neuer Verweis, sieht wer bestätigt den NEUEN Verweis - nicht den alten', async () => {
    await api.energiemanagementFassungEntwerfen(EM_IDS.d3, {
      form: 'verweis',
      verweis: { ablage: 'Rechtskataster der Gruppe', bezeichnung: null, kennung: 'RK-GR-02', adresse: null, fassungsangabe: 'Stand 01/2029', datum: null, sha256: null },
      begruendung: 'Die Gruppe führt das Kataster seit Januar 2029.',
    });
    await zeige(EM_IDS.d3);
    const karte = screen.getByTestId('dokument-wartet');
    expect(within(karte).getByRole('heading').textContent).toBe('Neu in Fassung 2');
    expect(karte.textContent).toContain('Rechtskataster der Gruppe');
    expect(karte.textContent).toContain('RK-GR-02 · Stand 01/2029');
    expect(karte.textContent).not.toContain('Rechtskataster-Dienst');
    expect(within(karte).getByTestId('dokument-wartet-grund').textContent).toContain('Die Gruppe führt');
  });

  it('P2-10: aus der Wiedervorlage fokussiert der Sprung „Prüfen“, auch wenn „Freigeben“ davor steht', async () => {
    const d1 = await api.energiemanagementDokument(EM_IDS.d1);
    await api.energiemanagementFassungEntwerfen(EM_IDS.d1, { form: 'wortlaut', wortlaut: `${d1.fassungen[0].wortlaut} Ein neuer Satz.`, begruendung: 'Hinweis aus dem internen Audit 2029.' });
    window.location.hash = `#/portfolio/nachweisen/dokumente/${EM_IDS.d1}?entscheid=dokument_ueberpruefung`;
    try {
      await zeige(EM_IDS.d1);
      const aktionen = screen.getByTestId('dokument-aktionen');
      expect(aktionen.querySelector('button')?.textContent).toBe('Fassung 2 freigeben');
      zumEntscheid(aktionen);
      expect(document.activeElement).toBe(screen.getByTestId('dokument-pruefen'));
    } finally {
      window.location.hash = '';
    }
  });

  it('P2-11: die Geltung nennt einen ausgeschlossenen Standort mit Namen - auch wenn er nicht zu den Standorten gehört', async () => {
    const [ahrenberg, lindach] = (await api.standorte()).standorte;
    await api.energiemanagementFassungEntwerfen(EM_IDS.d2, {
      form: 'wortlaut',
      wortlaut: 'Das Energiemanagement umfasst das Werk Ahrenberg mit Strom und Gas.',
      anwendungsbereich: { standort_ids: [ahrenberg.id], traeger: ['Strom', 'Gas'], ausschluesse: [{ art: 'standort', verweis: lindach.id, begruendung: 'Das Werk Lindach wird 2029 verkauft.' }] },
      begruendung: 'Verkauf des Werks Lindach beschlossen.',
    });
    await api.energiemanagementFassungFreigeben(EM_IDS.d2, 2, { entschieden_von: EM_IDS.RF, entschieden_am: '2029-02-12', begruendung: 'Verkauf des Werks Lindach beschlossen.' });
    await zeige(EM_IDS.d2);
    await klick(screen.getByTestId('zeile-geltung'));
    const zeilen = await screen.findByTestId('geltung-zeilen');
    await act(async () => {});
    expect(zeilen.textContent).toContain(`Ausschlüsse${lindach.name}: Das Werk Lindach wird 2029 verkauft.`);
  });

  it('P2-12: konnten die Feststellungen nicht laden, sagt es eine Zeile - nicht „keine offen“', async () => {
    const feststellungen = api.energiemanagementFeststellungen;
    let versuche = 0;
    api.energiemanagementFeststellungen = async () => {
      versuche += 1;
      if (versuche === 1) throw new Error('Netz');
      return feststellungen();
    };
    await zeige(EM_IDS.d1);
    await klick(screen.getByTestId('zeile-feststellungen-fehler'));
    expect(versuche).toBe(2);
    expect(screen.queryByTestId('zeile-feststellungen-fehler')).toBeNull();
  });
});
