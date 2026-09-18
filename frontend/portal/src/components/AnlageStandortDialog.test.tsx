import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError, type AnlageUmzug, type BerichteBetroffen, type StandorteAmStichtag } from '../api';
import { standortDerAnlage } from '../anlageStandort';
import { FOLGEN_WAEHLEN } from '../anlageUmziehen';
import { ahrenbergHeute, FIXTURE_IDS, werkAhrenberg } from '../test/standorteFixtures';
import { AnlageStandortDialog } from './AnlageStandortDialog';
import { AnlageStandortZeile } from './AnlageStandortZeile';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';

/**
 * UEMS AP-02 IP-11 — Dialog T6b „Anlage zuordnen“ und sein Einstieg an der Zeile „Standort“
 * (T6a). Halle 2 (AN-2) zieht von Werk Ahrenberg (ST-1) nach Werk Ahrenberg Nord (ST-3); die
 * Folgen kommen aus der Vorschau des Servers, der Dialog setzt sie nur in Sätze.
 */

const NORD = '5a1d0000-0000-4000-8000-000000000003';
const ST1 = { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' };
const ST3 = { id: NORD, kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord' };
const HALLE_2 = 'Werk Ahrenberg – Halle 2';

function mitNord(): StandorteAmStichtag {
  const a = ahrenbergHeute();
  return {
    ...a,
    stichtag: '2027-02-20',
    standorte: [...a.standorte, werkAhrenberg({ id: NORD, kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord', anlagen: [] })],
  };
}

function umzug(over: Partial<AnlageUmzug> = {}): AnlageUmzug {
  return {
    anlageId: FIXTURE_IDS.an2,
    anlageName: HALLE_2,
    bisher: ST1,
    neu: ST3,
    gueltigAb: '2027-02-20',
    gueltigBis: null,
    danach: null,
    rueckwirkung: { art: 'ab_heute', tage: 0, abzeichen: null },
    zuordnungen: [
      { standort: ST1, gueltigAb: '2026-10-01', gueltigBis: '2027-02-19', zustand: 'beendet' },
      { standort: ST3, gueltigAb: '2027-02-20', gueltigBis: null, zustand: 'gueltig' },
    ],
    bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'ladepark_rahmen', 'fahrplaene', 'messstellen'],
    boxen: 1,
    netzanschluss: { id: 'na-2', kennzeichen: 'NA-2' },
    steuern: null,
    befehle: 0,
    begruendung: null,
    protokoll: [],
    ...over,
  };
}

function oeffne(onClose = vi.fn(), onGespeichert = vi.fn()) {
  render(
    <AnlageStandortDialog
      open
      anlageId={FIXTURE_IDS.an2}
      anlageName={HALLE_2}
      standorte={mitNord()}
      onClose={onClose}
      onGespeichert={onGespeichert}
    />,
  );
  return { onClose, onGespeichert };
}

function waehleNord() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Neuer Standort *' }));
  fireEvent.click(screen.getByRole('option', { name: /Werk Ahrenberg Nord \(ST-3\)/ }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dialog „Anlage zuordnen“ (T6b)', () => {
  it('Korrektur: erster Tag ist vorbelegt und der verbindliche Satz steht im bestehenden Dialog', () => {
    render(
      <AnlageStandortDialog
        open
        anlageId={FIXTURE_IDS.an2}
        anlageName={HALLE_2}
        standorte={mitNord()}
        modus="korrektur"
        gueltigAbVorgabe="2026-10-01"
        onClose={vi.fn()}
        onGespeichert={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Gültig ab *' })).toHaveTextContent('01.10.2026');
    expect(screen.getByText('Die Anlage gehört seit ihrem ersten Tag zu einem anderen Standort? Hier ändern Sie das rückwirkend. Steuerung und Messwerte bleiben unberührt.')).toBeInTheDocument();
  });

  it('normaler Umzug bleibt auf heute und behält seinen bisherigen Einleitungssatz', () => {
    oeffne();
    expect(screen.getByRole('combobox', { name: 'Gültig ab *' })).toHaveTextContent('20.02.2027');
    expect(screen.getByText(/Die Anlage gehört ab dem gewählten Tag zu einem anderen Standort/)).toBeInTheDocument();
    expect(screen.queryByText(/seit ihrem ersten Tag/)).toBeNull();
  });

  it('T6: die Folgen-Karte nennt, was sich ändert, die vier Dinge, die bleiben, und dass nichts gesendet wird', async () => {
    const vorschau = vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    oeffne();
    expect(screen.getByText('Anlage zuordnen')).toBeInTheDocument();
    expect(screen.getByText(FOLGEN_WAEHLEN)).toBeInTheDocument();
    expect(vorschau).not.toHaveBeenCalled();

    waehleNord();
    const karte = await screen.findByTestId('umzug-folgen');
    expect(vorschau).toHaveBeenCalledWith(FIXTURE_IDS.an2, NORD, '2027-02-20');
    expect(within(karte).getByRole('heading', { name: 'Das ändert sich' })).toBeInTheDocument();
    expect(within(karte).getByText('Ab 20.02.2027 gehört die Anlage zu Werk Ahrenberg Nord (ST-3).')).toBeInTheDocument();
    expect(within(karte).getByText('Bis 19.02.2027 gehört sie weiter zu Werk Ahrenberg (ST-1).')).toBeInTheDocument();

    const bleibt = within(karte).getByRole('heading', { name: 'Das bleibt, wie es ist' }).parentElement!;
    for (const ding of [/VoltPilot-Box/, /Datenwege/, /Freigaben/, /Betriebsmodell/]) {
      expect(within(bleibt).getByText(ding)).toBeInTheDocument();
    }
    expect(within(bleibt).getByText('Messstellen bleiben an ihrem Ort.')).toBeInTheDocument();
    expect(within(bleibt).getByText('Die Anlage bleibt an ihrem Netzanschluss NA-2.')).toBeInTheDocument();
    expect(within(karte).getByText('Es wird kein Befehl an die Anlage gesendet.')).toBeInTheDocument();
  });

  it('speichert mit Begründung, zeigt die Zuordnungen des Servers und meldet sich mit „Fertig“', async () => {
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    const put = vi.spyOn(api, 'anlageStandortSetzen').mockResolvedValue(
      umzug({ begruendung: 'Halle 2 gehört ab jetzt zu Nord.', protokoll: [{ id: 7, objektArt: 'anlage', objektId: FIXTURE_IDS.an2 }] }),
    );
    const { onGespeichert } = oeffne();
    waehleNord();
    await screen.findByTestId('umzug-folgen');
    fireEvent.change(screen.getByLabelText('Begründung (freiwillig)'), { target: { value: '  Halle 2 gehört ab jetzt zu Nord. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));

    expect(await screen.findByText('Zuordnung gespeichert')).toBeInTheDocument();
    expect(put).toHaveBeenCalledWith(FIXTURE_IDS.an2, {
      standortId: NORD,
      gueltigAb: '2027-02-20',
      begruendung: 'Halle 2 gehört ab jetzt zu Nord.',
    });
    expect(screen.getByText('Werk Ahrenberg – Halle 2 gehört ab 20.02.2027 zu Werk Ahrenberg Nord (ST-3).')).toBeInTheDocument();
    const verlauf = screen.getByRole('heading', { name: 'Zuordnungen der Anlage' }).parentElement!;
    expect(within(verlauf).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Werk Ahrenberg (ST-1)01.10.2026 – 19.02.2027beendet',
      'Werk Ahrenberg Nord (ST-3)ab 20.02.2027gilt',
    ]);
    expect(screen.getByText('Es wird kein Befehl an die Anlage gesendet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onGespeichert).toHaveBeenCalledWith(expect.objectContaining({ anlageId: FIXTURE_IDS.an2 }));
  });

  it('eine Ablehnung der Vorschau steht mit dem Satz des Servers am Feld — und keine Folgen-Karte', async () => {
    const satz = 'Für den 20.02.2027 gibt es schon eine Zuordnung (Werk Ahrenberg Nord). Ändern Sie diese, statt eine zweite anzulegen.';
    vi.spyOn(api, 'anlageStandortVorschau').mockRejectedValue(
      new ApiError(409, satz, { code: 'gleicher_tag', message: satz, feld: 'gueltigAb' }),
    );
    oeffne();
    waehleNord();
    expect(await screen.findByText(satz)).toBeInTheDocument();
    expect(screen.queryByTestId('umzug-folgen')).toBeNull();
  });

  it('lehnt der Eintrag ab, bleibt der Dialog offen und der Satz steht am Standort', async () => {
    const satz = 'Werk Ahrenberg – Halle 2 ist bereits Werk Ahrenberg Nord zugeordnet.';
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    vi.spyOn(api, 'anlageStandortSetzen').mockRejectedValue(
      new ApiError(400, satz, { code: 'ziel_ist_bisheriger_eltern', message: satz, feld: 'standortId' }),
    );
    oeffne();
    waehleNord();
    await screen.findByTestId('umzug-folgen');
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(await screen.findByText(satz)).toBeInTheDocument();
    expect(screen.queryByText('Zuordnung gespeichert')).toBeNull();
  });

  it('ohne Wahl: der Satz am Feld, keine Vorschau, kein Eintrag; „Abbrechen“ schließt', () => {
    const vorschau = vi.spyOn(api, 'anlageStandortVorschau');
    const put = vi.spyOn(api, 'anlageStandortSetzen');
    const { onClose } = oeffne();
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    expect(screen.getByText('Bitte wählen Sie den Standort, zu dem die Anlage gehören soll.')).toBeInTheDocument();
    expect(vorschau).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('bietet nach der Korrektur nur den laut bestehendem Ortsbaum-Weg leeren Standort zum Archivieren an', async () => {
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug({ gueltigAb: '2026-10-01' }));
    vi.spyOn(api, 'anlageStandortSetzen').mockResolvedValue(umzug({ gueltigAb: '2026-10-01' }));
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg({
      aktionen: { archivieren: { erlaubt: true, text: null, gruende: [], letzterTag: '2026-11-19', mitarchiviert: [] }, wiederherstellen: null, loeschen: null },
    }));
    render(<AnlageStandortDialog open anlageId={FIXTURE_IDS.an2} anlageName={HALLE_2} standorte={mitNord()}
      modus="korrektur" gueltigAbVorgabe="2026-10-01" onClose={vi.fn()} onGespeichert={vi.fn()} />);
    waehleNord();
    await screen.findByTestId('umzug-folgen');
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    const angebot = await screen.findByTestId('standort-archiv-angebot');
    expect(angebot).toHaveTextContent('ist jetzt leer');
    expect(within(angebot).getByRole('button', { name: 'Standort archivieren' })).toBeInTheDocument();
  });

  it('zeigt bei einem nicht leeren bisherigen Standort kein Archivier-Angebot', async () => {
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug({ gueltigAb: '2026-10-01' }));
    vi.spyOn(api, 'anlageStandortSetzen').mockResolvedValue(umzug({ gueltigAb: '2026-10-01' }));
    vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg({
      aktionen: { archivieren: { erlaubt: false, text: 'Am Standort ist noch etwas aktiv.', gruende: [], letzterTag: null, mitarchiviert: [] }, wiederherstellen: null, loeschen: null },
    }));
    render(<AnlageStandortDialog open anlageId={FIXTURE_IDS.an2} anlageName={HALLE_2} standorte={mitNord()}
      modus="korrektur" gueltigAbVorgabe="2026-10-01" onClose={vi.fn()} onGespeichert={vi.fn()} />);
    waehleNord();
    await screen.findByTestId('umzug-folgen');
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    await waitFor(() => expect(api.standortOrte).toHaveBeenCalledWith(ST1.id));
    expect(screen.queryByTestId('standort-archiv-angebot')).toBeNull();
  });
});

describe('„Freigegebene Berichte: …“ in der Folgen-Karte (AP-12 IP-9)', () => {
  const antwort = (over: Partial<BerichteBetroffen> = {}): BerichteBetroffen => ({
    anlass: 'anlage_umzug_rueckwirkend',
    gilt_ab: '2027-02-20',
    berichte_vorhanden: true,
    betroffen: [],
    zitieren: [{ kennung: 'BR-2026-0001', nr: 1 }],
    ...over,
  });

  it('die Karte nennt die Berichte — gefragt mit Anlage, „gültig ab“ und Anlass, erst mit gewähltem Standort', async () => {
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    const betroffen = vi.spyOn(api, 'berichteBetroffen').mockResolvedValue(antwort());
    oeffne();
    const karte = await (async () => {
      await new Promise<void>((fertig) => setTimeout(fertig, 250));
      expect(betroffen).not.toHaveBeenCalled();
      waehleNord();
      return screen.findByTestId('umzug-folgen');
    })();
    expect(await within(karte).findByTestId('berichte-folgen')).toHaveTextContent('Freigegebene Berichte: keine betroffen');
    expect(betroffen).toHaveBeenCalledTimes(1);
    expect(betroffen).toHaveBeenCalledWith(FIXTURE_IDS.an2, '2027-02-20', 'anlage_umzug_rueckwirkend');
  });

  it('mehrere betroffene Stände bekommen den Vermerk — in der Reihenfolge der Antwort', async () => {
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    vi.spyOn(api, 'berichteBetroffen').mockResolvedValue(
      antwort({
        betroffen: [
          { kennung: 'BR-2026-0001', nr: 2 },
          { kennung: 'BR-2026-0002', nr: 1 },
        ],
      }),
    );
    oeffne();
    waehleNord();
    expect(await screen.findByTestId('berichte-folgen')).toHaveTextContent(
      'Freigegebene Berichte: BR-2026-0001 Nr. 2, BR-2026-0002 Nr. 1 bekommen den Vermerk „Revision nötig“',
    );
  });

  for (const fall of ['ohne lesbaren Bericht', 'bei einer Ablehnung (403)'] as const) {
    it(`${fall} bleibt die Zeile weg — die Karte steht, ohne Meldung`, async () => {
      vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
      const betroffen = vi.spyOn(api, 'berichteBetroffen');
      if (fall === 'ohne lesbaren Bericht') betroffen.mockResolvedValue(antwort({ berichte_vorhanden: false }));
      else betroffen.mockRejectedValue(new ApiError(403, 'Dafür ist Ihr Konto nicht freigeschaltet.', {}));
      const fehler = vi.spyOn(console, 'error');
      oeffne();
      waehleNord();
      const karte = await screen.findByTestId('umzug-folgen');
      await waitFor(() => expect(betroffen).toHaveBeenCalled());
      await act(() => new Promise<void>((fertig) => setTimeout(fertig, 0)));
      expect(within(karte).queryByTestId('berichte-folgen')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(fehler).not.toHaveBeenCalled();
    });
  }
});

describe('Zeile „Standort“ in „Meine Anlage“ (T6a → T6b)', () => {
  function zeile(antwort: StandorteAmStichtag, onGeaendert = vi.fn()) {
    const a = standortDerAnlage(antwort, FIXTURE_IDS.an2)!;
    render(
      <dl>
        <AnlageStandortZeile anlageStandort={a} antwort={antwort} onGeaendert={onGeaendert} />
      </dl>,
    );
    return onGeaendert;
  }

  it('„Anderem Standort zuordnen“ öffnet den Dialog; nach „Fertig“ lädt „Meine Anlage“ neu', async () => {
    const standorte = vi.spyOn(api, 'standorte');
    vi.spyOn(api, 'anlageStandortVorschau').mockResolvedValue(umzug());
    vi.spyOn(api, 'anlageStandortSetzen').mockResolvedValue(umzug());
    const onGeaendert = zeile(mitNord());
    expect(standorte).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: `Anderem Standort zuordnen: ${HALLE_2}` }));
    expect(screen.getByText('Anlage zuordnen')).toBeInTheDocument();
    waehleNord();
    await screen.findByTestId('umzug-folgen');
    fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fertig' }));
    expect(onGeaendert).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Zuordnung gespeichert')).toBeNull());
  });

  it('zeigt „Zuordnung korrigieren“ nur mit dem Recht anlage.zuordnen', () => {
    zeile(mitNord());
    expect(screen.getByRole('button', { name: `Zuordnung korrigieren: ${HALLE_2}` })).toBeInTheDocument();

    const me = rechteSeed().me;
    act(() => setSelbstauskunft({
      ...me,
      unternehmen_rechte: me.unternehmen_rechte.filter((r) => r !== 'anlage.zuordnen'),
      standorte: me.standorte.map((s) => ({ ...s, rechte: s.rechte.filter((r) => r !== 'anlage.zuordnen') })),
    }));
    expect(screen.queryByRole('button', { name: `Zuordnung korrigieren: ${HALLE_2}` })).toBeNull();
  });

  it('eine geplante Zuordnung steht in der Zeile: „bis 28.02.2027 · ab 01.03.2027: Werk Ahrenberg Nord (ST-3)“', async () => {
    const heute = mitNord();
    const ahrenberg = heute.standorte[0];
    heute.standorte[0] = {
      ...ahrenberg,
      anlagen: ahrenberg.anlagen.map((x) => (x.id === FIXTURE_IDS.an2 ? { ...x, gueltigBis: '2027-02-28' } : x)),
    };
    const maerz = mitNord();
    maerz.stichtag = '2027-03-01';
    maerz.standorte[0] = { ...maerz.standorte[0], anlagen: maerz.standorte[0].anlagen.filter((x) => x.id !== FIXTURE_IDS.an2) };
    maerz.standorte[2] = {
      ...maerz.standorte[2],
      anlagen: [{ id: FIXTURE_IDS.an2, name: HALLE_2, gueltigAb: '2027-03-01', gueltigBis: null }],
    };
    const standorte = vi.spyOn(api, 'standorte').mockResolvedValue(maerz);
    zeile(heute);
    expect(await screen.findByText('bis 28.02.2027 · ab 01.03.2027: Werk Ahrenberg Nord (ST-3)')).toBeInTheDocument();
    expect(standorte).toHaveBeenCalledWith('2027-03-01');
  });
});
