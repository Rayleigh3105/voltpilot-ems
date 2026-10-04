import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError } from '../api';
import { mispelApi, type FoerderwegAnsicht, type ZaehlerrolleAnsicht } from '../mispelFoerderwegApi';
import { FoerderwegDialog } from './FoerderwegDialog';

/** Bestand einer Direktvermarktungs-Anlage ohne Netzladen = Marktprämie mit Ausschließlichkeitsoption (Vertrag § 2). */
const heute: FoerderwegAnsicht = {
  site_id: 's-1',
  am: '2026-10-20',
  quelle: 'bestand',
  foerderweg: 'marktpraemie_ausschliesslichkeit',
  begriff: 'Marktprämie mit Ausschließlichkeitsoption',
  rechtsgrundlage: '§ 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG; A1 S. 11',
  formelsatz: null,
  formelsatz_gebunden_bis: null,
  einverstaendnis: null,
  gueltig_ab: null,
  netzladen: { moeglich: false, heute: false },
  fassungen: [],
  aw_regel: null,
  vormerkung: null,
  direktvermarkter: null,
  bilanzkreis_gesondert: null,
};

const ZP1 = 'DE000337400000000000000001234567';
const register = [
  { id: 'm1', kennzeichen: 'MS-01', name: 'Hauptzähler Bezug', richtung: 'Bezug', rolle: 'Z1' },
  { id: 'm2', kennzeichen: 'MS-02', name: 'Hauptzähler Einspeisung', richtung: 'Abgabe', rolle: 'Z1' },
  { id: 'm3', kennzeichen: 'MS-14', name: 'Speicher Laden', richtung: 'Laden', rolle: 'Z2' },
  { id: 'm4', kennzeichen: 'MS-15', name: 'Speicher Entladen', richtung: 'Entladen', rolle: 'Z2' },
] as const;

function rolle(m: (typeof register)[number]): ZaehlerrolleAnsicht {
  return {
    messstelle_id: m.id,
    messstelle: m.kennzeichen,
    am: '2026-10-20',
    anlage: 's-1',
    rolle: {
      rolle: m.rolle,
      zaehlpunkt: `${ZP1}8`,
      messstellenbetreiber: 'Stadtwerke Ahrenberg',
      eichstatus: 'eichrechtskonform',
      eichfrist_bis: null,
      wertequelle: 'messstellenbetreiber',
      gueltig_ab: '2026-10-01',
    },
    festlegungsgroesse: null,
    urteil: 'tauglich',
    befunde: [],
  };
}

function mitRegister() {
  vi.spyOn(api, 'messstellenRegister').mockResolvedValue({
    register: register.map((m) => ({
      id: m.id,
      kennzeichen: m.kennzeichen,
      name: m.name,
      art: 'gemessen',
      medium: 'Strom',
      lebenszyklus: 'aktiv',
      hauptgroesse: { groesse: 'Wirkenergie', richtung: m.richtung, einheit: 'kWh', wertart: 'Zählerstand' },
    })),
  } as never);
  vi.spyOn(mispelApi, 'zaehlerrolle').mockImplementation(async (id) => rolle(register.find((m) => m.id === id)!));
}

function oeffne(ansicht: FoerderwegAnsicht = heute) {
  const onGespeichert = vi.fn();
  const onClose = vi.fn();
  render(<FoerderwegDialog siteId="s-1" ansicht={ansicht} onClose={onClose} onGespeichert={onGespeichert} />);
  return { onGespeichert, onClose };
}

const knopf = (name: string | RegExp) => screen.getByRole('button', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Förderweg ändern (MiSpeL MP-17, BK-17 A)', () => {
  it('Schritt 1: fünf Wege mit Begriff und Rechtsgrundlage, der heutige vorn, die Pauschaloption zum Vormerken (MP-27)', () => {
    oeffne();
    const dialog = screen.getByRole('dialog', { name: 'Förderweg ändern' });
    const wege = within(dialog).getAllByRole('radio');
    expect(wege).toHaveLength(5);
    expect(wege[0].closest('label')).toHaveTextContent('Marktprämie mit Ausschließlichkeitsoptionheute');
    const pauschal = within(dialog).getByRole('radio', { name: /Pauschaloption/ });
    expect(pauschal).not.toBeDisabled();
    expect(pauschal.closest('label')).toHaveTextContent('noch nicht anwendbar · vormerken möglich (Tenor Ziff. 9b)');
    expect(dialog).toHaveTextContent('§ 19 Abs. 3b EEG · Anlage 1');
  });

  it('Kurzweg: ungefördert führt von Schritt 1 direkt zu „Prüfen“ und merkt zum nächsten Monatsersten vor', async () => {
    const setzen = vi.spyOn(mispelApi, 'foerderwegSetzen').mockResolvedValue({ ...heute, am: '2026-11-01' });
    const { onGespeichert } = oeffne();
    fireEvent.click(screen.getByRole('radio', { name: /ungeförderte Direktvermarktung/ }));
    fireEvent.click(knopf('Weiter: Prüfen'));
    expect(screen.getByTestId('fw-gilt-ab')).toHaveTextContent('01.11.2026');
    expect(screen.getByRole('dialog')).toHaveTextContent('§ 21b Abs. 1 S. 2 EEG');
    fireEvent.click(knopf('Ab 01.11. eintragen'));
    await waitFor(() => expect(onGespeichert).toHaveBeenCalled());
    expect(setzen).toHaveBeenCalledWith('s-1', {
      foerderweg: 'ungefoerdert',
      formelsatz: null,
      einverstaendnis: false,
      gueltig_ab: '2026-11-01',
      aw_regel: null,
      direktvermarkter: null,
      bilanzkreis_gesondert: null,
    });
  });

  it('Abgrenzung: Zähler aus dem Register, Formelsatz A1 nach dem Gebot der Bestnutzung, Partner, Prüfen', async () => {
    mitRegister();
    const rolleSetzen = vi.spyOn(mispelApi, 'zaehlerrolleSetzen');
    const setzen = vi.spyOn(mispelApi, 'foerderwegSetzen').mockResolvedValue({ ...heute, am: '2026-11-01' });
    const { onGespeichert } = oeffne();
    fireEvent.click(screen.getByRole('radio', { name: /Abgrenzungsoption/ }));
    fireEvent.click(knopf('Weiter: Zähler'));

    // Z1 und Z2 stehen schon im Register (MP-6) — der Dialog führt nur.
    await screen.findByText('Z1 · Zweirichtungszähler am Netzanschluss');
    expect(screen.getByText('Z2 · Zähler für die Stromspeicher und/oder Ladepunkte')).toBeInTheDocument();
    expect(screen.getAllByText('tauglich')).toHaveLength(2);
    fireEvent.click(knopf('Weiter: Formelsatz'));

    expect(await screen.findByText(/Vorschlag: Formelsatz A1/)).toBeInTheDocument();
    expect(rolleSetzen).not.toHaveBeenCalled(); // unverändert: keine neue Fassung
    expect(screen.getByRole('dialog')).toHaveTextContent('Gebunden bis 31.12.2026');
    fireEvent.click(knopf('Weiter: Partner'));

    fireEvent.change(screen.getByLabelText('Name des Direktvermarkters'), { target: { value: 'Nordstrom Direkt GmbH' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Gesonderter Bilanzkreis/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /einverstanden/ }));
    expect(screen.getByRole('radio', { name: /VoltPilot-Partner/ })).toBeDisabled();
    fireEvent.click(knopf('Weiter: Prüfen'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('A1 · gebunden bis 31.12.2026');
    expect(dialog).toHaveTextContent('Z1 tauglich · Z2 tauglich');
    expect(dialog).toHaveTextContent('Jahresmarktwert');
    fireEvent.click(knopf('Ab 01.11. eintragen'));
    await waitFor(() => expect(onGespeichert).toHaveBeenCalled());
    expect(setzen).toHaveBeenCalledWith('s-1', {
      foerderweg: 'marktpraemie_abgrenzung',
      formelsatz: 'A1',
      einverstaendnis: true,
      gueltig_ab: '2026-11-01',
      aw_regel: null,
      direktvermarkter: 'Nordstrom Direkt GmbH',
      bilanzkreis_gesondert: true,
    });
  });

  it('eine Ablehnung erscheint als Satz in dem Schritt, in dem sie entsteht', async () => {
    mitRegister();
    vi.spyOn(mispelApi, 'foerderwegSetzen').mockRejectedValue(
      new ApiError(422, 'x', { code: 'einverstaendnis_fehlt', bis: '2027-09-30', fundstelle: 'Tenor S. 3 Ziff. 9a' }),
    );
    const { onGespeichert } = oeffne();
    fireEvent.click(screen.getByRole('radio', { name: /Abgrenzungsoption/ }));
    fireEvent.click(knopf('Weiter: Zähler'));
    await screen.findByText('Z1 · Zweirichtungszähler am Netzanschluss');
    fireEvent.click(knopf('Weiter: Formelsatz'));
    await screen.findByText(/Vorschlag: Formelsatz A1/);
    fireEvent.click(knopf('Weiter: Partner'));
    fireEvent.click(knopf('Weiter: Prüfen'));
    fireEvent.click(knopf('Ab 01.11. eintragen'));

    const satz = await screen.findByTestId('fw-fehler');
    expect(satz).toHaveTextContent('Bis 30.09.2027 gilt die Festlegung nur, wenn Netzbetreiber und Messstellenbetreiber einverstanden sind');
    expect(satz.closest('[data-schritt]')).toHaveAttribute('data-schritt', 'partner');
    expect(onGespeichert).not.toHaveBeenCalled();
  });

  it('ohne Z2 kein Formelsatz: der Satz steht im Schritt „Formelsatz“', async () => {
    mitRegister();
    vi.spyOn(mispelApi, 'zaehlerrolle').mockImplementation(async (id) => {
      const m = register.find((x) => x.id === id)!;
      return m.rolle === 'Z2' ? { ...rolle(m), rolle: null, urteil: 'keine_rolle' } : rolle(m);
    });
    vi.spyOn(mispelApi, 'zaehlerrolleSetzen').mockImplementation(async (id, a) => ({
      ...rolle(register.find((x) => x.id === id)!),
      urteil: a.rolle ? 'tauglich' : 'keine_rolle',
    }));
    oeffne();
    fireEvent.click(screen.getByRole('radio', { name: /Abgrenzungsoption/ }));
    fireEvent.click(knopf('Weiter: Zähler'));
    await screen.findByText('Z2 · Zähler für die Stromspeicher und/oder Ladepunkte');
    fireEvent.click(knopf('Weiter: Formelsatz'));
    expect(await screen.findByTestId('fw-fehler')).toHaveTextContent(/Bitte wählen Sie für Z2/);
  });

  it('eine Vormerkung wird an ihrem Tag berichtigt — nie davor eingeschoben', () => {
    oeffne({
      ...heute,
      vormerkung: {
        id: 'v1',
        foerderweg: 'ungefoerdert',
        begriff: 'ungeförderte Direktvermarktung',
        rechtsgrundlage: '§ 21a EEG',
        formelsatz: null,
        einverstaendnis: false,
        gueltig_ab: '2026-11-01',
        aw_regel: null,
        direktvermarkter: null,
        bilanzkreis_gesondert: null,
      },
    });
    expect(screen.getByRole('radio', { name: /ungeförderte Direktvermarktung/ })).toBeChecked();
    expect(screen.getByRole('dialog')).toHaveTextContent('ab 01.11.2026 vorgemerkt');
    fireEvent.click(knopf('Weiter: Prüfen'));
    expect(screen.getByTestId('fw-gilt-ab')).toHaveTextContent('01.11.2026');
  });
});

describe('Förderweg ändern · Pauschaloption (MiSpeL MP-27, BK-27)', () => {
  const aufbau = { pvKwp: 9.2, speicherKwh: 10, arten: ['pv', 'battery'] };
  function oeffnePauschal(a = aufbau, ansicht: FoerderwegAnsicht = { ...heute, foerderweg: 'einspeiseverguetung', begriff: 'Einspeisevergütung' }) {
    const onGespeichert = vi.fn();
    render(
      <FoerderwegDialog siteId="s-1" ansicht={ansicht} aufbau={a} onClose={vi.fn()} onGespeichert={onGespeichert} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Pauschaloption/ }));
    fireEvent.click(knopf('Weiter: Voraussetzungen'));
    return { onGespeichert };
  }

  it('Voraussetzungen → Pauschalgrenzen → Partner → Prüfen: vorgemerkt mit offenem Termin, Bestätigungen gehen mit', async () => {
    const vormerken = vi.spyOn(mispelApi, 'pauschalVormerken').mockResolvedValue({
      ...heute,
      pauschal_vormerkung: {
        id: 'v-1',
        foerderweg: 'marktpraemie_pauschal',
        begriff: 'Marktprämie mit Pauschaloption',
        rechtsgrundlage: '§ 19 Abs. 3c EEG; Tenor Ziff. 4, Anlage 2',
        termin: null,
        steckersolar_kwp: 0.8,
        ein_betreiber_bestaetigt_am: '2026-10-20T08:00:00Z',
        steckersolar_direktvermarktung_bestaetigt_am: '2026-10-20T08:00:00Z',
        direktvermarkter: 'Nordstrom Direkt',
        bilanzkreis_gesondert: true,
        vorgemerkt_am: '2026-10-20T08:00:00Z',
      },
    });
    const { onGespeichert } = oeffnePauschal();
    const liste = screen.getByTestId('fw-voraussetzungen');
    expect(liste).toHaveTextContent('Solarleistung 9,2 kWp — höchstens 30 kWp');
    expect(liste).toHaveTextContent('Voraussetzung 3 · Anlage 2 S. 19, Fn. 14');
    const weiter = screen.getByTestId('fw-weiter-voraussetzungen');
    expect(weiter).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Ja, zusätzlich' }));
    fireEvent.change(screen.getByLabelText('Installierte Leistung der Steckersolargeräte (kWp)'), { target: { value: '0,8' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /betreibe alle Anlagen/ }));
    expect(weiter).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /nimmt das Steckersolargerät mit auf/ }));
    expect(weiter).not.toBeDisabled();
    fireEvent.click(weiter);
    // (P1) zählt das Steckersolargerät mit: 10,0 kWp × 500 = 5.000; (P2)P1 = 0,1 × 10 / 10 = 0,1; (P3) 500; (P4) 5.500
    const grenzen = screen.getByTestId('fw-grenzen');
    expect(grenzen).toHaveTextContent('(P1)10,0 kWp × 5005.000');
    expect(grenzen).toHaveTextContent('(P3)0,100 × 5.000500');
    expect(grenzen).toHaveTextContent('(P4)5.000 + 5005.500');
    expect(screen.getByRole('dialog')).toHaveTextContent('Fallkonstellation P1 · Stromspeicher');
    fireEvent.click(knopf('Weiter: Partner'));
    fireEvent.change(screen.getByLabelText('Name des Direktvermarkters'), { target: { value: 'Nordstrom Direkt' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Gesonderter Bilanzkreis/ }));
    expect(screen.queryByText(/Netzbetreiber und Messstellenbetreiber sind einverstanden/)).toBeNull();
    fireEvent.click(knopf('Weiter: Prüfen'));
    expect(screen.getByTestId('fw-gilt-ab')).toHaveTextContent('Termin offen');
    expect(screen.getByTestId('fw-rumpfjahr')).toHaveTextContent('Ihr erstes Jahr ist ein Rumpfjahr');
    fireEvent.click(screen.getByTestId('fw-eintragen'));
    await waitFor(() => expect(onGespeichert).toHaveBeenCalled());
    expect(vormerken).toHaveBeenCalledWith('s-1', {
      ein_betreiber: true,
      steckersolar_kwp: 0.8,
      steckersolar_direktvermarktung: true,
      direktvermarkter: 'Nordstrom Direkt',
      bilanzkreis_gesondert: true,
    });
  });

  it('über 30 kWp: der Grund steht im Schritt „Voraussetzungen“, weiter geht es nicht', () => {
    oeffnePauschal({ pvKwp: 32.4, speicherKwh: 15, arten: ['pv', 'battery'] });
    expect(screen.getByTestId('fw-voraussetzungen')).toHaveTextContent('Solarleistung 32,4 kWp — mehr als 30 kWp');
    expect(screen.getByTestId('fw-ueber-30')).toHaveTextContent('Zurück zu Schritt 1');
    fireEvent.click(screen.getByRole('radio', { name: 'Keine' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /betreibe alle Anlagen/ }));
    expect(screen.getByTestId('fw-weiter-voraussetzungen')).toBeDisabled();
  });

  it('unbekannte Solarleistung ist keine Null: Frage statt Häkchen, weiter geht es nicht', () => {
    oeffnePauschal({ pvKwp: null, speicherKwh: 10, arten: ['pv', 'battery'] });
    expect(screen.getByTestId('fw-voraussetzungen')).toHaveTextContent('Solarleistung fehlt im Aufbau');
    fireEvent.click(screen.getByRole('radio', { name: 'Keine' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /betreibe alle Anlagen/ }));
    expect(screen.getByTestId('fw-weiter-voraussetzungen')).toBeDisabled();
  });

  it('eine Ablehnung des Servers erscheint als Satz im Schritt „Voraussetzungen“', async () => {
    vi.spyOn(mispelApi, 'pauschalVormerken').mockRejectedValue(
      new ApiError(422, 'x', { code: 'ueber_30_kwp', solarleistung_kwp: 31, fundstelle: 'Voraussetzung 3' } as never),
    );
    oeffnePauschal();
    fireEvent.click(screen.getByRole('radio', { name: 'Keine' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /betreibe alle Anlagen/ }));
    fireEvent.click(screen.getByTestId('fw-weiter-voraussetzungen'));
    fireEvent.click(knopf('Weiter: Partner'));
    fireEvent.click(knopf('Weiter: Prüfen'));
    fireEvent.click(screen.getByTestId('fw-eintragen'));
    expect(await screen.findByTestId('fw-fehler')).toHaveTextContent('nur bis 30 kWp Solarleistung');
    expect(screen.getByRole('dialog').querySelector('[data-schritt="voraussetzungen"]')).not.toBeNull();
  });
});
