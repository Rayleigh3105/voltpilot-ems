import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import {
  c1,
  c1Einstellungen,
  gr4Einstellungen,
  gr4Z5a,
  gr4Z5b,
  JETZT_C1,
  JETZT_GR4,
  K5,
  K8,
  K8_NAMEN,
  k5Kanaele,
  k82Kanaele,
  SITE_HALLE_1,
  SITE_HALLE_2,
} from '../test/geraetHerkunftFixtures';
import { GeraetHerkunft } from './GeraetHerkunft';

/**
 * Die ergänzte Geräteseite (UEMS AP-04 IP-12) als Fläche: Karte „Gerät“,
 * Karte „Einstellungen“ mit „Ändern ab …“ und die Messkanäle mit
 * „speist MS-06 (führend)“ — gegen die Antworten des Referenzunternehmens.
 */

afterEach(() => vi.restoreAllMocks());

function gr4() {
  vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [gr4Z5a(), gr4Z5b()] });
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(k5Kanaele());
  vi.spyOn(api, 'geraetEinstellungen').mockResolvedValue(gr4Einstellungen());
  return render(
    <GeraetHerkunft siteId={SITE_HALLE_1} komponenten={[{ entityId: K5, label: 'Unterzähler Spritzguss SG01–SG06' }]} jetzt={JETZT_GR4} />,
  );
}

function ek2() {
  vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [c1()] });
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(k82Kanaele());
  const lesen = vi.spyOn(api, 'geraetEinstellungen').mockResolvedValue(c1Einstellungen());
  render(<GeraetHerkunft siteId={SITE_HALLE_2} komponenten={[{ entityId: K8[1], label: K8_NAMEN[K8[1]] }]} jetzt={JETZT_C1} />);
  return lesen;
}

describe('GeraetHerkunft', () => {
  it('Karte „Gerät“: Z-5b mit Seriennummer und Einbau — der Vorgänger Z-5a „ausgebaut am …“, nie Z-5a selbst', async () => {
    gr4();
    const karte = await screen.findByTestId('geraet-karte');
    expect(within(karte).getByText('Zähler Z-5b')).toBeInTheDocument();
    expect(within(karte).getByText('GR-4')).toBeInTheDocument();
    expect(within(karte).getByText('88231')).toBeInTheDocument();
    expect(within(karte).getByText('18.11.2026, 10:40 Uhr')).toBeInTheDocument();
    const vorgaenger = within(karte).getByTestId('geraet-vorgaenger');
    expect(within(vorgaenger).getByText('Z-5a')).toBeInTheDocument();
    expect(within(vorgaenger).getByText('ausgebaut am 18.11.2026, 10:40 Uhr')).toBeInTheDocument();
    expect(within(vorgaenger).getByText('Seriennr. 4471023 · eingebaut am 12.03.2024')).toBeInTheDocument();
    await waitFor(() => expect(within(karte).getByText('MS-06')).toBeInTheDocument());
  });

  it('Kanal-Liste: jede Zeile nennt die gespeiste Messstelle und kennzeichnet die führende Bindung', async () => {
    gr4();
    const kanaele = await screen.findByTestId('geraet-messkanaele');
    const zeilen = within(kanaele).getAllByTestId('geraet-kanal');
    expect(zeilen).toHaveLength(3);
    expect(within(zeilen[0]).getByText('Wirkenergie Bezug')).toBeInTheDocument();
    expect(within(zeilen[0]).getByText('Zählerstand · kWh · alle 1 min')).toBeInTheDocument();
    const marke = within(zeilen[0]).getByText('speist MS-06 (führend)');
    expect(marke).toHaveClass('is-fuehrend');
    expect(within(zeilen[1]).getByText('speist MS-06 (führend)')).toBeInTheDocument();
    expect(within(zeilen[2]).getByText('speist keine Messstelle')).toBeInTheDocument();
  });

  it('ohne erfasste Einstellung: ein Satz und der Weg, eine einzutragen', async () => {
    gr4();
    const einst = await screen.findByTestId('geraet-einstellungen');
    expect(await within(einst).findByText(/Für dieses Gerät ist keine Einstellung erfasst/)).toBeInTheDocument();
    expect(within(einst).getByRole('button', { name: 'Einstellung eintragen' })).toBeInTheDocument();
  });

  it('Karte „Einstellungen“ an EK-2: gilt 250/5 A, angekündigt 400/5 A — nur die Fassungen DIESER Komponente', async () => {
    ek2();
    const einst = await screen.findByTestId('geraet-einstellungen');
    const zeilen = await within(einst).findAllByTestId('geraet-einstellung');
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].querySelector('.val')).toHaveTextContent('250/5 A');
    expect(within(zeilen[0]).getByText('Ab 01.02.2027: 400/5 A')).toBeInTheDocument();
    expect(within(zeilen[0]).getByText('Historie (2 Fassungen)')).toBeInTheDocument();
    expect(within(zeilen[0]).getByText('geplant')).toBeInTheDocument();
    expect(within(zeilen[0]).getByText('eingetragen am 25.01.2027, 09:00 Uhr von Ines Kaltenbach')).toBeInTheDocument();
  });

  it('„Ändern ab …“: Folgen-Karte vor dem Eintragen, dann EINE Anfrage mit dem Zeitpunkt in Europe/Berlin', async () => {
    const lesen = ek2();
    const eintragen = vi.spyOn(api, 'geraetEinstellungEintragen').mockResolvedValue({
      fassung: { ...c1Einstellungen().historie[2], wert: { primaer_a: 500, sekundaer_a: 5 }, wert_text: '500/5 A', gueltig_ab: '2027-03-01T08:00:00+01:00' },
      beendet: null,
      folgen: [],
      messstellen: ['MS-11'],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ändern ab …' }));
    const dialog = await screen.findByTestId('einstellung-aendern');
    // Vorbelegt mit dem Wert, der JETZT gilt — und „bisher“ zu „gilt ab“.
    expect(within(dialog).getByText('bisher 250/5 A')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Primär (A)'), { target: { value: '500' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Datum' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }));
    // Der erste „1“ im Raster ist der Monatserste (danach folgt der des Folgemonats).
    fireEvent.click(screen.getAllByRole('gridcell', { name: '1' })[0]);
    const uhr = within(dialog).getByRole('combobox', { name: 'Uhrzeit' });
    fireEvent.change(uhr, { target: { value: '08:00' } });
    fireEvent.blur(uhr);

    const folgen = await within(dialog).findByTestId('einstellung-folgen');
    // Ab 01.03.2027 gilt davor die angekündigte 400/5 A — „bisher“ folgt dem Zeitpunkt.
    expect(within(dialog).getByText('bisher 400/5 A')).toBeInTheDocument();
    expect(within(folgen).getByText('Werte vor dem 01.03.2027, 08:00 Uhr bleiben unverändert.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ab 01.03.2027, 08:00 Uhr eintragen' }));
    await waitFor(() => expect(eintragen).toHaveBeenCalledTimes(1));
    expect(eintragen).toHaveBeenCalledWith('g-c1', {
      entity_id: K8[1],
      kanal: null,
      art: 'wandler_strom',
      wert: { primaer_a: 500, sekundaer_a: 5 },
      anwendung: 'angewendet',
      gueltig_ab: '2027-03-01T08:00:00+01:00',
      tatsaechlich_ab: null,
      begruendung: null,
    });
    expect(await screen.findByText('Eingetragen: Wandlerverhältnis Strom 500/5 A ab 01.03.2027, 08:00 Uhr. Im Protokoll von MS-11 vermerkt.')).toBeInTheDocument();
    expect(screen.queryByTestId('einstellung-aendern')).toBeNull();
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(2));
  });

  it('ein ungültiger Wert wird nicht geschickt: der Grund steht da, der Fokus springt ins erste Feld', async () => {
    ek2();
    const eintragen = vi.spyOn(api, 'geraetEinstellungEintragen');
    fireEvent.click(await screen.findByRole('button', { name: 'Ändern ab …' }));
    const dialog = await screen.findByTestId('einstellung-aendern');
    const primaer = within(dialog).getByLabelText('Primär (A)');
    fireEvent.change(primaer, { target: { value: '' } });
    fireEvent.click(within(dialog.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /eintragen$/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Bitte geben Sie einen gültigen Wert an');
    expect(document.activeElement).toBe(primaer);
    expect(eintragen).not.toHaveBeenCalled();
  });

  it('eine Ablehnung des Servers steht im Dialog, der Dialog bleibt offen', async () => {
    ek2();
    vi.spyOn(api, 'geraetEinstellungEintragen').mockRejectedValue(
      new ApiError(403, 'Dafür fehlt Ihnen das Recht „Führende Quelle binden“.'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ändern ab …' }));
    const dialog = await screen.findByTestId('einstellung-aendern');
    fireEvent.change(within(dialog).getByLabelText('Primär (A)'), { target: { value: '300' } });
    fireEvent.click(within(dialog.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /eintragen$/ }));
    expect(await within(dialog).findByText('Dafür fehlt Ihnen das Recht „Führende Quelle binden“.')).toBeInTheDocument();
    expect(screen.getByTestId('einstellung-aendern')).toBeInTheDocument();
  });

  it('ohne auflösbares Gerät entsteht GAR NICHTS — kein Kasten, der erklärt, dass er nichts weiß', async () => {
    const geraete = vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [gr4Z5a()] });
    vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(k5Kanaele());
    const { container } = render(<GeraetHerkunft siteId={SITE_HALLE_1} komponenten={[{ entityId: K5, label: 'K-5' }]} />);
    await waitFor(() => expect(geraete).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
