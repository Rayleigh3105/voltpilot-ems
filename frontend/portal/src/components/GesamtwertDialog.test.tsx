import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { GesamtwertDialog } from './GesamtwertDialog';

/**
 * Der geführte Assistent „Gesamtwert" (Konzept `vp-helfer-konzept-h1`).
 *
 * Der Ankerfall ist der Deye SUN-30K: PV 1 + PV 2 + PV 3 + Mikrowechselrichter
 * ergeben einen Gesamt-PV-Wert. Der Assistent liest denselben Messwert-Baum wie
 * der Verlauf-Explorer, filtert auf zueinander passende Messgrößen und rechnet
 * die Vorschau live — fehlt ein Wert, bleibt sie ehrlich unvollständig.
 */

const KANAELE = [
  { kanal: 'pv1_power_kw', wert: 5.2 },
  { kanal: 'pv2_power_kw', wert: 4.1 },
  { kanal: 'pv3_power_kw', wert: 3.1 },
  { kanal: 'microinverter_power_kw', wert: 3.1 },
];

function entities(): unknown {
  return {
    registry: null,
    entities: [
      {
        id: 'inv',
        entityType: 'modbus-generic',
        typeLabel: 'Wechselrichter',
        role: 'grid',
        label: 'Deye SUN-30K',
        control: false,
        deviceId: 'd1',
        capabilities: { measure: KANAELE.map((k) => ({ channel: k.kanal, unit: 'kW' })) },
        guards: null,
        syncStatus: 'in_sync',
        observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
        edgeSourceId: null,
      },
    ],
    localSetup: [],
    staleOnDevice: [],
  };
}

function topology(): unknown {
  return {
    schemaVersion: '1.0',
    entities: [
      { id: 'inv', entityType: 'modbus-generic', typeLabel: 'Wechselrichter', label: 'Deye SUN-30K', category: 'meter', health: 'ok', capabilities: [] },
    ],
    topology: { schema_version: '1.0', nodes: [] },
  };
}

function messkanaele(): unknown {
  return {
    siteId: 's-1',
    komponente: 'inv',
    inhaltsstand: '2026.09.11.1',
    messkanaele: KANAELE.map((k) => ({
      kanal: k.kanal,
      anzeigename: null,
      einheit: 'kW',
      wertart: 'Momentanwert',
      groesse: 'Wirkleistung',
      richtung: 'Erzeugung',
      quantity: 'Power',
      direction: 'Generation',
      kadenzS: 5,
      aktiv: true,
    })),
  };
}

function history(): unknown {
  const buckets = (last: number) => [
    { start: '2026-09-12T09:45:00Z', avg: last, min: last, max: last, last, n: 1 },
  ];
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 5,
    channels: Object.fromEntries(KANAELE.map((k) => [k.kanal, buckets(k.wert)])),
  };
}

function stub(over: { history?: unknown } = {}) {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities() as never);
  vi.spyOn(api, 'topology').mockResolvedValue(topology() as never);
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(messkanaele() as never);
  vi.spyOn(api, 'entityHistory').mockResolvedValue((over.history ?? history()) as never);
  vi.spyOn(api, 'kennzeichenVorschlag').mockResolvedValue({ kennzeichen: 'MS-0007' } as never);
}

function mount(props: Partial<Parameters<typeof GesamtwertDialog>[0]> = {}) {
  return render(
    <GesamtwertDialog
      open
      siteId="s-1"
      onClose={props.onClose ?? (() => {})}
      onGespeichert={props.onGespeichert}
      {...props}
    />,
  );
}

/** Wählt die vier PV-Werte über den Mehrfach-Picker. */
async function waehleVier() {
  fireEvent.click(await screen.findByRole('combobox', { name: /Messwerte/ }));
  for (const name of [/PV 1/, /PV 2/, /PV 3/, /Mikrowechselrichter/]) {
    fireEvent.click(await screen.findByRole('option', { name }));
  }
}

afterEach(() => vi.restoreAllMocks());

describe('GesamtwertDialog', () => {
  it('führt in fünf Schritten und lädt den Messwert-Baum erst beim Öffnen', async () => {
    stub();
    mount();
    await waitFor(() => expect(document.body.textContent).toContain('Schritt 1 von 5'));
    for (const s of ['Werte', 'Rechnen', 'Name', 'Vorschau', 'Fertig']) {
      expect(document.body.textContent).toContain(s);
    }
  });

  it('spielt den Ankerfall SUN-30K durch: PV1+PV2+PV3+Mikro → Gesamt-PV = 15,5 kW', async () => {
    stub();
    const onGespeichert = vi.fn();
    const anlegen = vi
      .spyOn(api, 'berechneteMessstelleAnlegen')
      .mockResolvedValue({ id: 'gw-1', kennzeichen: 'MS-0007', name: 'Gesamt-PV', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [] } as never);
    mount({ onGespeichert });

    // Schritt 1: vier Werte
    await screen.findByRole('combobox', { name: /Messwerte/ });
    await waehleVier();
    fireEvent.click(await screen.findByRole('button', { name: /Weiter · 4 Werte/ }));

    // Schritt 2: Rechnen (Standard +)
    await waitFor(() => expect(document.body.textContent).toContain('Wie zählen wir sie?'));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Schritt 3: Name-Vorschlag „Gesamt-PV" + Kennzeichen
    await waitFor(() => {
      const feld = screen.getByLabelText('Name') as HTMLInputElement;
      expect(feld.value).toBe('Gesamt-PV');
    });
    expect(document.body.textContent).toContain('MS-0007');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Schritt 4: Vorschau 15,5 kW + Rechenzeile
    await waitFor(() => expect(document.body.textContent).toContain('15,5'));
    expect(document.body.textContent).toContain('Wirkleistung');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    // Der Server bekommt die vier Terme als gewichtete Summe (+/1).
    await waitFor(() => expect(anlegen).toHaveBeenCalled());
    expect(anlegen.mock.calls[0][0]).toEqual({
      name: 'Gesamt-PV',
      terme: [
        { eingang_art: 'messkanal', entity_id: 'inv', point_key: 'pv1_power_kw', vorzeichen: '+', faktor: 1 },
        { eingang_art: 'messkanal', entity_id: 'inv', point_key: 'pv2_power_kw', vorzeichen: '+', faktor: 1 },
        { eingang_art: 'messkanal', entity_id: 'inv', point_key: 'pv3_power_kw', vorzeichen: '+', faktor: 1 },
        { eingang_art: 'messkanal', entity_id: 'inv', point_key: 'microinverter_power_kw', vorzeichen: '+', faktor: 1 },
      ],
    });

    // Schritt 5: Fertig
    await waitFor(() => expect(document.body.textContent).toContain('ist angelegt'));
    expect(onGespeichert).toHaveBeenCalled();
  });

  it('EHRLICHKEIT: fehlt ein Wert, zeigt die Vorschau „unvollständig", nie eine Teilsumme', async () => {
    // Ein Kanal ohne aktuellen Wert (leere Reihe).
    const luecke = history() as { channels: Record<string, unknown[]> };
    luecke.channels['microinverter_power_kw'] = [];
    stub({ history: luecke });
    mount();

    await screen.findByRole('combobox', { name: /Messwerte/ });
    await waehleVier();
    fireEvent.click(await screen.findByRole('button', { name: /Weiter · 4 Werte/ }));
    await screen.findByText('Wie zählen wir sie?');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => expect(document.body.textContent).toContain('unvollständig'));
    // Die Summe wird NICHT als kleinere Zahl gezeigt.
    expect(document.body.textContent).not.toContain('12,4');
  });

  it('ohne summierbare Werte wird nichts angeboten, sondern gesagt', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue({ registry: null, entities: [], localSetup: [], staleOnDevice: [] } as never);
    vi.spyOn(api, 'topology').mockResolvedValue(null as never);
    vi.spyOn(api, 'kennzeichenVorschlag').mockResolvedValue({ kennzeichen: 'MS-0007' } as never);
    mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain('meldet noch keine Messwerte'),
    );
  });
});
