import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Koppelbild } from '../api';
import { NBSP } from '../format';
import { JETZT, koppelbildBuettner, koppelStand } from '../test/anlagensteuerungFixtures';
import { KoppelStellplaetze, KoppelStellplaetzeAnzeige } from './KoppelStellplaetze';

/**
 * Abschnitt „Stellplätze“ und der Dialog „Schalt-Test und Freigabe“ (PFC200 Stufe 4): drei getrennte Zeilen je
 * Stellplatz; der Test zeigt die Quittung der Steuerung und trennt sie von der Wirkung an der Anlage; freigegeben
 * wird erst nach dem Haken.
 */
const koppelTest = vi.fn();
const koppelFreigeben = vi.fn();
const koppelFreigabeZuruecknehmen = vi.fn();
const anlagensteuerungKoppelbild = vi.fn();

vi.mock('../anlagensteuerungApi', () => ({
  anlagensteuerungApi: {
    koppelTest: (...a: unknown[]) => koppelTest(...a),
    koppelFreigeben: (...a: unknown[]) => koppelFreigeben(...a),
    koppelFreigabeZuruecknehmen: (...a: unknown[]) => koppelFreigabeZuruecknehmen(...a),
  },
}));

vi.mock('../apiVoll', () => ({
  api: { anlagensteuerungKoppelbild: (...a: unknown[]) => anlagensteuerungKoppelbild(...a) },
}));

const now = new Date(JETZT);
const GERAET = 'g-1';

beforeEach(() => {
  koppelTest.mockReset();
  koppelFreigeben.mockReset();
  koppelFreigabeZuruecknehmen.mockReset();
  anlagensteuerungKoppelbild.mockReset();
});

function zeige(bild: Koppelbild = koppelbildBuettner(), onChanged = vi.fn(), einheitHref?: (n: number) => string | null) {
  return render(
    <KoppelStellplaetzeAnzeige bild={bild} geraetId={GERAET} ebene="karte" jetzt={now} onChanged={onChanged} einheitHref={einheitHref} />,
  );
}

async function oeffne(platz: number) {
  const knopf = within(screen.getAllByTestId('koppel-stellplatz')[platz - 1]).getByRole('button', {
    name: 'Schalt-Test und Freigabe',
  });
  knopf.focus();
  fireEvent.click(knopf);
  return { knopf, dialog: await screen.findByRole('dialog', { name: `Stellplatz ${platz}` }) };
}

describe('Abschnitt Stellplätze', () => {
  it('Kopf mit Lage, Frist und Bibliothek; je Stellplatz Angebot und drei getrennte Zeilen', () => {
    zeige();
    expect(screen.getByRole('heading', { name: 'Stellplätze' })).toBeInTheDocument();
    expect(screen.getByTestId('koppel-kopf')).toHaveTextContent('Die Steuerung nimmt Wünsche der Box an.');
    expect(screen.getByText('Frist: gilt noch 58 s')).toBeInTheDocument();
    expect(screen.getByText('Bibliothek 1.0')).toBeInTheDocument();

    const [p1, p2, p3] = screen.getAllByTestId('koppel-stellplatz');
    expect(within(p1).getByText('Stellplatz 1')).toBeInTheDocument();
    expect(within(p1).getByText('freigegeben')).toBeInTheDocument();
    expect(p1.textContent).toContain(`Obergrenze der Leistung${NBSP}· ganze Erzeugung${NBSP}· 0,0 bis 265,0${NBSP}kW`);
    expect(p1.textContent).toContain(`Wunsch der Box159,0${NBSP}kW · Fahrplan`);
    expect(p1.textContent).toContain('Quittung der Steuerungangenommen');
    expect(p1.textContent).toContain(`Wirksam laut Steuerung159,0${NBSP}kW`);

    expect(p2.textContent).toContain(`Ein und Aus${NBSP}· Lampe am Gerät${NBSP}· aus oder ein`);
    expect(p2.textContent).toContain('Wunsch der Boxkein Wunsch');
    expect(p2.textContent).not.toMatch(/0,0/);
    expect(within(p3).getByText('nicht bereit: Wartung')).toBeInTheDocument();
  });

  it('ein alter Stand trägt seine Uhrzeit und keine Frist', () => {
    zeige({ ...koppelbildBuettner(), stand: koppelStand({ aktuell: false, empfangen_at: '2026-10-21T11:30:00Z' }) });
    expect(screen.getByText('Stand von 13:30')).toBeInTheDocument();
    expect(screen.queryByText(/Frist:/)).not.toBeInTheDocument();
  });

  it('eine Box ohne Koppelbild: ein Satz, keine Stellplätze', () => {
    zeige({ unterstuetzt: false, stand: null, stellplaetze: [] });
    expect(screen.getByTestId('koppel-kopf')).toHaveTextContent(
      'Die Box dieser Anlage kann der Steuerung noch keine Wünsche schicken.',
    );
    expect(screen.queryByTestId('koppel-stellplatz')).not.toBeInTheDocument();
  });

  it('das Ziel „Einheit n“ führt auf die Seite der Einheit', () => {
    const bild = koppelbildBuettner();
    bild.stellplaetze[0] = {
      ...bild.stellplaetze[0],
      angebot: { ...bild.stellplaetze[0].angebot!, ziel: 'erzeugungseinheit', nr: 2 },
    };
    zeige(bild, vi.fn(), (n) => `#/einheit/${n}`);
    expect(screen.getByTestId('koppel-ziel-link')).toHaveAttribute('href', '#/einheit/2');
    expect(screen.getByTestId('koppel-ziel-link')).toHaveTextContent('Einheit 2');
  });

  it('lädt über die Route und zeigt bei einem älteren Backend nichts', async () => {
    anlagensteuerungKoppelbild.mockResolvedValueOnce(koppelbildBuettner());
    const { unmount } = render(<KoppelStellplaetze siteId="s-1" geraetId={GERAET} ebene="geraet" jetzt={now} />);
    expect(await screen.findByRole('heading', { name: 'Stellplätze', level: 4 })).toBeInTheDocument();
    expect(anlagensteuerungKoppelbild).toHaveBeenCalledWith('s-1', GERAET);
    unmount();

    anlagensteuerungKoppelbild.mockResolvedValueOnce(null);
    render(<KoppelStellplaetze siteId="s-1" geraetId={GERAET} ebene="geraet" jetzt={now} />);
    await waitFor(() => expect(anlagensteuerungKoppelbild).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('koppel-stellplaetze')).not.toBeInTheDocument();
  });
});

describe('Dialog Schalt-Test und Freigabe', () => {
  it('Escape schließt, der Fokus kehrt zum Auslöser zurück', async () => {
    zeige();
    const { knopf, dialog } = await oeffne(2);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(knopf));
  });

  it('ein Wert außerhalb des Bands: sichtbarer Fehler, Fokus im Feld, kein Test', async () => {
    const bild = koppelbildBuettner();
    bild.stellplaetze[0] = { ...bild.stellplaetze[0], freigabe: { ...bild.stellplaetze[0].freigabe, status: 'offen' } };
    zeige(bild);
    const { dialog } = await oeffne(1);
    const feld = within(dialog).getByLabelText('Testwert in kW (0,0 bis 265,0 kW)');
    fireEvent.change(feld, { target: { value: '300' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schalt-Test starten' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Der Testwert muss zwischen 0,0 und 265,0 kW liegen.');
    expect(document.activeElement).toBe(feld);
    expect(feld).toHaveAttribute('aria-invalid', 'true');
    expect(koppelTest).not.toHaveBeenCalled();
  });

  it('der Test zeigt die Quittung der Steuerung und trennt sie von der Wirkung an der Anlage', async () => {
    const onChanged = vi.fn();
    const bild = koppelbildBuettner();
    bild.stellplaetze[0] = { ...bild.stellplaetze[0], freigabe: { ...bild.stellplaetze[0].freigabe, status: 'offen' } };
    zeige(bild, onChanged);
    koppelTest.mockResolvedValueOnce({
      ok: true, satz: '', koppel_test: { lage: 'bereit', geschrieben: true, folge: 3, urteil: 'angenommen', wirksam: 200000 },
    });
    const { dialog } = await oeffne(1);
    fireEvent.change(within(dialog).getByLabelText(/^Testwert in kW/), { target: { value: '200' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schalt-Test starten' }));
    const ergebnis = await within(dialog).findByTestId('koppel-test-ergebnis');
    expect(koppelTest).toHaveBeenCalledWith(GERAET, 1, 200000);
    expect(ergebnis).toHaveTextContent('Die Steuerung hat den Testwunsch angenommen.');
    expect(ergebnis.textContent).toContain(`Wirksam laut Steuerung200,0${NBSP}kW`);
    expect(ergebnis).toHaveTextContent(/Ob die Anlage dem Testwert folgt, zeigt die Quittung nicht/);
    expect(onChanged).toHaveBeenCalled();
  });

  it('eine Ablehnung der Route (409) steht als Satz da', async () => {
    zeige();
    koppelTest.mockRejectedValueOnce(new ApiError(409, 'Die Box dieser Anlage antwortet gerade nicht.'));
    const { dialog } = await oeffne(2);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ein' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schalt-Test starten' }));
    expect(await within(dialog).findByTestId('koppel-test-ergebnis')).toHaveTextContent(
      'Die Box dieser Anlage antwortet gerade nicht.',
    );
    expect(koppelTest).toHaveBeenCalledWith(GERAET, 2, 1);
  });

  it('ohne Test ist die Freigabe gesperrt und sagt warum', async () => {
    zeige();
    const { dialog } = await oeffne(2);
    expect(within(dialog).getByRole('checkbox', { name: 'Ich habe die Wirkung an der Anlage gesehen.' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Freigeben' })).toBeDisabled();
    expect(within(dialog).getByTestId('koppel-freigabe-grund')).toHaveTextContent(/zuerst einen bestandenen Schalt-Test/);
  });

  it('ein anderer Stellplatz derselben Art: Grund in Klartext', async () => {
    const bild = koppelbildBuettner();
    bild.stellplaetze[1] = { ...bild.stellplaetze[1], freigabe_grund: 'kommando_belegt' };
    zeige(bild);
    const { dialog } = await oeffne(2);
    expect(within(dialog).getByTestId('koppel-freigabe-grund')).toHaveTextContent(
      'Für diese Art ist schon ein anderer Stellplatz freigegeben.',
    );
  });

  it('nach bestandenem Test: Haken, Freigeben, Rückfrage mit Folgen, dann die Route', async () => {
    const onChanged = vi.fn();
    const bild = koppelbildBuettner();
    bild.stellplaetze[1] = {
      ...bild.stellplaetze[1],
      freigabe: { ...bild.stellplaetze[1].freigabe, status: 'getestet', test: { wert: 1, urteil: 'angenommen', wirksam: 1, at: JETZT } },
      freigabe_moeglich: true,
      freigabe_grund: null,
    };
    zeige(bild, onChanged);
    const frisch = koppelbildBuettner();
    koppelFreigeben.mockResolvedValueOnce(frisch);
    const { dialog } = await oeffne(2);
    expect(within(dialog).getByTestId('koppel-letzter-test')).toHaveTextContent('Letzter Schalt-Test: ein · angenommen · wirksam ein · 14:00');
    const freigeben = within(dialog).getByRole('button', { name: 'Freigeben' });
    expect(freigeben).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Ich habe die Wirkung an der Anlage gesehen.' }));
    fireEvent.click(freigeben);
    const frage = await screen.findByRole('dialog', { name: 'Stellplatz 2 freigeben?' });
    expect(frage).toHaveTextContent('Die Steuerung entscheidet weiter selbst');
    fireEvent.click(within(frage).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(koppelFreigeben).toHaveBeenCalledWith(GERAET, 2));
    // Die Antwort IST das frische Koppelbild - kein zweiter Abruf.
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(frisch));
  });

  it('verfallen: Grund in Klartext, der alte Beleg zählt nicht mehr und steht nicht da', async () => {
    const bild = koppelbildBuettner();
    bild.stellplaetze[0] = {
      ...bild.stellplaetze[0],
      freigabe: { ...bild.stellplaetze[0].freigabe, status: 'verfallen', freigegeben_at: null, verfallen_grund: 'angebot_geaendert' },
      freigabe_grund: 'kein_test',
    };
    zeige(bild);
    const { dialog } = await oeffne(1);
    expect(dialog).toHaveTextContent('Die Freigabe ist verfallen, weil das Anlagenprogramm Art, Ziel oder Band');
    expect(within(dialog).queryByTestId('koppel-letzter-test')).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('angebot_geaendert');
  });

  it('freigegeben: Freigabe zurücknehmen mit Rückfrage', async () => {
    zeige();
    koppelFreigabeZuruecknehmen.mockResolvedValueOnce({});
    const { dialog } = await oeffne(1);
    expect(dialog).toHaveTextContent('Die Box darf diesem Stellplatz Wünsche schicken - freigegeben um 13:00.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Freigabe zurücknehmen' }));
    const frage = await screen.findByRole('dialog', { name: 'Freigabe zurücknehmen?' });
    fireEvent.click(within(frage).getByRole('button', { name: 'Zurücknehmen' }));
    await waitFor(() => expect(koppelFreigabeZuruecknehmen).toHaveBeenCalledWith(GERAET, 1));
  });
});
