import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Device, type Site } from '../api';
import { erzeugerVorgabenApi } from '../erzeugerVorgabenApi';
import { einheitGeraetId } from '../geraetAdresse';
import { meldungenApi } from '../meldungenApi';
import {
  ENTITY_GORE,
  GERAET_GORE,
  gore,
  goreNv,
  goreVerlauf,
  goreWerte,
  SITE_GORE,
} from '../test/anlagensteuerungFixtures';
import { GeraetSeiteSection } from './GeraetSeiteSection';

/**
 * Die Seite eines Wechselrichters hinter der Anlagensteuerung (GE-3, d1): `…/geraet/{ref}/as-<Entität>~te-<n>` öffnet
 * im Geräteseiten-Rahmen Kopf, Jetzt, Heute, Aktivität und Gerät & Verbindung — alles über die Routen der Steuerung.
 */
const site = { id: SITE_GORE, name: 'Neue Halle' } as unknown as Site;
const box: Device = {
  id: 'box-gore', siteId: SITE_GORE, externalRef: 'edge-5mz8bdd', kind: 'inverter', name: null, status: 'active',
  lastSeenAt: null, createdAt: null,
} as Device;
const liste = () => ({ einrichtung: { moeglich: true, grund: null, boxen: [] }, steuerungen: [gore()] });

beforeEach(() => {
  vi.spyOn(api, 'anlagensteuerungen').mockResolvedValue(liste());
  vi.spyOn(api, 'netzVermarktung').mockResolvedValue(goreNv());
  // Die Seite rechnet mit der echten Uhr: die Lesungen der Fixture stehen auf „vor 5 s“.
  const w = goreWerte();
  vi.spyOn(api, 'anlagensteuerungWerte').mockResolvedValue({
    ...w,
    werte: w.werte.map((x) => ({ ...x, gemessen_am: x.gemessen_am ? new Date(Date.now() - 5_000).toISOString() : null })),
  });
  vi.spyOn(api, 'anlagensteuerungVerlauf').mockResolvedValue(goreVerlauf());
  vi.spyOn(erzeugerVorgabenApi, 'chronik').mockResolvedValue({
    site_id: SITE_GORE, von: '', bis: '', verarbeitet_bis: null, luecken: [],
    vorgaben: [
      {
        id: 'v-1', geraet_id: GERAET_GORE, te_nr: null, einheit_name: null, urheber: 'netzbetreiber', art: 'p_begrenzung',
        beginn: '2026-10-21T08:58:00Z', beginn_genau: true, ende: null, ende_genau: false, gesehen_bis: '2026-10-21T12:00:00Z',
        dauer_s: 3600, vorgabe_prozent: 60, vorgabe_w: null, ist_mittel_w: null, verfuegbar_mittel_w: null,
        energie_kwh: null, methode: null, wert_eur: null, kanal: null, bindung: null, unvollstaendig: false,
        neustart: false, zaehler_beginn: null, zaehler_ende: null, gruende: [],
      },
    ],
  });
  vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([]);
  vi.spyOn(meldungenApi, 'verlauf').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

function oeffne(teNr: number) {
  render(
    <GeraetSeiteSection site={site} boxRef="edge-5mz8bdd" geraetId={einheitGeraetId(ENTITY_GORE, teNr)} devices={[box]} />,
  );
}

describe('Seite einer Erzeugungseinheit (GE-3)', () => {
  it('Kopf, Jetzt, Heute, Aktivität und Gerät & Verbindung — gelesen über die Anlagensteuerung', async () => {
    oeffne(2);
    const rahmen = await screen.findByTestId('geraet-rahmen');
    expect(within(rahmen).getByRole('heading', { level: 1, name: 'Wechselrichter 2' })).toBeInTheDocument();
    expect(rahmen.textContent).toContain('PV-Wechselrichter');
    expect(rahmen.textContent).toMatch(/Growatt MAX 125KTL3-X · 125.kW/);
    // Jetzt: die große Zahl ist das Ist, darunter Soll, „folgt“ und die Begrenzung der ganzen Anlage.
    const held = await within(rahmen).findByTestId('geraet-held');
    await waitFor(() => expect(held.textContent).toContain('53,1'));
    expect(held.textContent).toMatch(/Soll 53,0.kW · folgt/);
    expect(held.textContent).toContain('Begrenzung der Anlage');
    // Heute: der Streifen aus der Verlaufsroute, Energie aus dem Zählerstand (die Kurve fehlt in diesem Bestand).
    expect(await within(rahmen).findByTestId('einheit-energie-heute')).toHaveTextContent('Energie heute');
    // Aktivität: die Vorgabe der ganzen Anlage gilt auch für diesen Wechselrichter.
    const aktivitaet = await within(rahmen).findByTestId('einheit-aktivitaet');
    expect(aktivitaet.textContent).toMatch(/Netzbetreiber · begrenzt auf 60.%/);
    expect(aktivitaet.textContent).toContain('gilt für die ganze Anlage');
    // Gerät & Verbindung: Block im Bild und der Weg zur Steuerung.
    const details = within(rahmen).getByTestId('einheit-details');
    expect(details.textContent).toContain('Einheit 2 · Register 48–57');
    const weg = within(details).getByRole('link', { name: /Anlagensteuerung Gore/ });
    expect(weg).toHaveAttribute('href', `#/anlage/${SITE_GORE}/geraet/edge-5mz8bdd/as-${ENTITY_GORE}`);
    expect(within(rahmen).getByTestId('einheit-ueber-steuerung')).toHaveAttribute('href', weg.getAttribute('href'));
    expect(api.anlagensteuerungWerte).toHaveBeenCalledWith(SITE_GORE, GERAET_GORE);
    expect(api.anlagensteuerungVerlauf).toHaveBeenCalledWith(SITE_GORE, GERAET_GORE, 'day');
    // Keine Steuerung, kein Register: die Bausteine fallen still weg.
    expect(within(rahmen).queryByText('Steuerung')).not.toBeInTheDocument();
  });

  it('ohne gültige Werte: keine große Zahl, der Satz sagt warum', async () => {
    oeffne(3);
    const held = await screen.findByTestId('geraet-held');
    await waitFor(() => expect(held.textContent).toContain('als ungültig'));
    expect(held.textContent).not.toContain('0,0');
  });

  it('Bearbeiten: Bezeichnung und MaStR über die vorhandene Route der Einheit', async () => {
    const speichern = vi.spyOn(api, 'erzeugungseinheitAendern').mockImplementation(async (_g, teNr, body) => ({
      ...gore().einheiten.find((e) => e.te_nr === teNr)!,
      ...body,
    }));
    oeffne(2);
    await screen.findByTestId('geraet-rahmen');
    fireEvent.click(screen.getAllByRole('button', { name: /Bearbeiten/ })[0]);
    fireEvent.change(screen.getByLabelText('Bezeichnung'), { target: { value: 'WR Süd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(speichern).toHaveBeenCalledWith(GERAET_GORE, 2, expect.objectContaining({ bezeichnung: 'WR Süd' })));
    expect(await screen.findByRole('heading', { level: 1, name: 'WR Süd' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Nummer und Messreihe der Einheit bleiben dieselben');
  });

  it('eine nicht eingetragene Nummer: „nicht (mehr) zu finden“, nie eine erfundene Seite', async () => {
    oeffne(7);
    expect(await screen.findByText('Diese Einheit ist hier nicht (mehr) zu finden')).toBeInTheDocument();
    expect(screen.getByText('An dieser Anlagensteuerung ist keine Einheit 7 eingetragen.')).toBeInTheDocument();
  });
});
