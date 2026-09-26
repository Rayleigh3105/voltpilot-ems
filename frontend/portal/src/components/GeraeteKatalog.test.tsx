import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeraeteKatalog } from './GeraeteKatalog';
import type { KatalogFund } from '../geraeteKatalog';

const componentTemplates = vi.fn();
const siteComponentTemplates = vi.fn();
const siteComponents = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      componentTemplates: () => componentTemplates(),
      siteComponentTemplates: (...a: unknown[]) => siteComponentTemplates(...a),
      siteComponents: (...a: unknown[]) => siteComponents(...a),
    },
  };
});

const tpl = (o: Record<string, unknown>) => ({
  kind: 'builtin',
  version: 1,
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  deviceType: 'inverter',
  ...o,
});

const TEMPLATES = [
  tpl({ templateRef: 'builtin:deye:5k', brand: 'deye', brandLabel: 'Deye', model: 'sun-5k', modelLabel: 'SUN-5K-SG04LP3-EU' }),
  tpl({ templateRef: 'builtin:deye:12k', brand: 'deye', brandLabel: 'Deye', model: 'sun-12k', modelLabel: 'SUN-12K-SG04LP3-EU' }),
  tpl({
    templateRef: 'builtin:goe:charger',
    brand: 'go-e',
    brandLabel: 'go-e',
    model: 'charger',
    modelLabel: 'go-e Charger',
    deviceType: 'wallbox',
    communication: 'goe_http_api',
    communicationLabel: 'go-e HTTP API v2 (HTTP/JSON)',
  }),
];

const FUND: KatalogFund = {
  quelle: {
    id: 'src-7',
    role: 'pv-generation',
    brand: 'fronius',
    model: null,
    label: null,
    roleLabel: 'Erzeuger',
    summary: 'Erzeuger · 192.0.2.31',
    suggestedType: 'producer',
  },
  titel: 'Fronius gefunden',
  unterzeile: 'Erzeuger · 192.0.2.31',
  boxName: 'Box Scheune',
};

function oeffne(onWahl = vi.fn()) {
  render(<GeraeteKatalog open siteId="s1" funde={[FUND]} onClose={() => {}} onWahl={onWahl} />);
  return onWahl;
}

describe('GeraeteKatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    componentTemplates.mockResolvedValue(TEMPLATES);
    siteComponentTemplates.mockResolvedValue([]);
    siteComponents.mockResolvedValue({ componentAuthority: 'portal', components: [] });
  });

  it('beginnt mit der Suche und stellt obenan, was die Box meldet', async () => {
    const onWahl = oeffne();
    const dialog = await screen.findByRole('dialog', { name: 'Gerät hinzufügen' });
    expect(within(dialog).getByRole('searchbox', { name: 'Katalog durchsuchen' })).toBeInTheDocument();
    const gemeldet = await within(dialog).findByRole('region', { name: 'Von Ihrer Box gemeldet' });
    expect(gemeldet).toHaveTextContent('Box Scheune meldet es');
    fireEvent.click(within(gemeldet).getByRole('button', { name: /Fronius gefunden/ }));
    expect(onWahl).toHaveBeenCalledWith({ art: 'fund', quelle: FUND.quelle });
  });

  it('führt ohne Suche über Art und Marke zum Modell - mit Rückweg', async () => {
    const onWahl = oeffne();
    fireEvent.click(await screen.findByRole('button', { name: /Wechselrichter/, pressed: false }));
    expect(screen.getByRole('button', { name: /Wechselrichter/, pressed: true })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^Deye/ }));
    fireEvent.click(await screen.findByRole('button', { name: /SUN-12K-SG04LP3-EU/ }));
    expect(onWahl).toHaveBeenCalledWith(
      expect.objectContaining({ art: 'modell', rolle: null, template: expect.objectContaining({ templateRef: 'builtin:deye:12k' }) }),
    );

    // Der Rückweg aus der Marke führt zur Art zurück.
    fireEvent.click(screen.getByRole('button', { name: /Wechselrichter$/ }));
    expect(await screen.findByRole('region', { name: 'Wechselrichter nach Marke' })).toBeInTheDocument();
  });

  it('findet über die Suche - und bietet ohne Treffer die Wege an', async () => {
    const onWahl = oeffne();
    const suche = await screen.findByRole('searchbox', { name: 'Katalog durchsuchen' });
    await screen.findByRole('region', { name: 'Wechselrichter' });
    fireEvent.change(suche, { target: { value: 'go-e' } });
    expect(await screen.findByRole('region', { name: 'Laden' })).toHaveTextContent('go-e Charger');
    // Unter jedem Suchergebnis steht der Weg für ein Gerät, das nicht im Katalog ist.
    fireEvent.click(screen.getByRole('button', { name: 'Modbus-Gerät selbst beschreiben' }));
    expect(onWahl).toHaveBeenCalledWith({ art: 'weg', weg: 'modbus' });

    fireEvent.change(suche, { target: { value: 'gibtsnicht' } });
    expect(await screen.findByText(/Kein Eintrag passt zu „gibtsnicht"/)).toBeInTheDocument();
    const wege = screen.getByRole('region', { name: 'Passende Wege' });
    fireEvent.click(within(wege).getByRole('button', { name: /Ladesäule mit OCPP 1\.6/ }));
    expect(onWahl).toHaveBeenLastCalledWith({ art: 'weg', weg: 'ocpp' });
  });

  it('macht über „Zähler" aus dem gewählten Gerät den Netz-Zähler - und sagt ehrlich, warum', async () => {
    const onWahl = oeffne();
    fireEvent.click(await screen.findByRole('button', { name: /^Zähler/ }));
    expect(await screen.findByText(/Für Zähler gibt es noch keine eigene Vorlage/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^Deye/ }));
    fireEvent.click(await screen.findByRole('button', { name: /SUN-5K-SG04LP3-EU/ }));
    expect(onWahl).toHaveBeenCalledWith(expect.objectContaining({ art: 'modell', rolle: 'grid-meter' }));
  });

  it('bleibt bei einem Ladefehler nicht leer - „Erneut versuchen" lädt neu', async () => {
    componentTemplates.mockRejectedValueOnce(new Error('offline'));
    oeffne();
    expect(await screen.findByText('Der Gerätekatalog konnte nicht geladen werden.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Erneut/ }));
    await waitFor(() => expect(componentTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('region', { name: 'Wechselrichter' })).toBeInTheDocument();
  });
});
