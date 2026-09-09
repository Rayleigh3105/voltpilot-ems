import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatterieAssistent } from './BatterieAssistent';

const socCurveTemplates = vi.fn();
const previewBattery = vi.fn();
const createBattery = vi.fn();
const updateBattery = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      socCurveTemplates: () => socCurveTemplates(),
      previewBattery: (...a: unknown[]) => previewBattery(...a),
      createBattery: (...a: unknown[]) => createBattery(...a),
      updateBattery: (...a: unknown[]) => updateBattery(...a),
    },
  };
});

const VORLAGE = {
  id: 'diybms-176s-nmc',
  label: 'DIYBMS 176s NMC (Kundenkurven, 25 °C)',
  description: 'Die gemessenen OCV→SoC-Tabellen eines 176s-Selbstbau-Packs.',
  chemistry: 'nmc',
  cellsInSeries: 176,
  refTempC: 25,
  cellMinV: 3.26,
  cellMaxV: 4.18,
  curveCharge: [
    [3.26, 0],
    [3.71, 50],
    [4.18, 100],
  ],
  curveDischarge: [
    [3.26, 0],
    [3.71, 50],
    [4.18, 100],
  ],
};

function knopf(name: string | RegExp) {
  return screen.getByRole('button', { name });
}

/**
 * Zeichnet den Assistenten und LÄSST DIE VORLAGEN ANKOMMEN.
 *
 * Der Assistent holt die Kurven-Vorlagen beim Erscheinen - jeder Test muss
 * diesen Lauf abwarten, sonst landet sein `setState` außerhalb von `act`.
 */
async function zeichne(
  schritt: 1 | 2 | 3 | 4 = 1,
  bearbeiten?: Parameters<typeof BatterieAssistent>[0]['bearbeiten'],
) {
  const onSchritt = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <BatterieAssistent
      siteId="s1"
      schritt={schritt}
      onSchritt={onSchritt}
      navPortal={null}
      onBack={() => {}}
      onSaved={onSaved}
      bearbeiten={bearbeiten}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { onSchritt, onSaved, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  socCurveTemplates.mockResolvedValue([VORLAGE]);
});

describe('Schritt 1 · Wie ist die Batterie erreichbar?', () => {
  /**
   * HTTP und Modbus stehen SICHTBAR da: sonst ließe die Fläche den Kunden
   * raten, ob VoltPilot seinen Fall grundsätzlich nicht kann oder nur noch
   * nicht.
   */
  it('bietet MQTT an und zeigt die kommenden Arten gesperrt, aber erklärt', async () => {
    await zeichne(1);
    expect(screen.getByTestId('anschlussart-mqtt')).not.toBeDisabled();
    expect(screen.getByTestId('anschlussart-http')).toBeDisabled();
    expect(screen.getByTestId('anschlussart-http').textContent).toContain('Kommt als Nächstes');
    // Modbus verweist auf die Tür, die es längst gibt - keine Ankündigung.
    expect(screen.getByTestId('anschlussart-modbus').textContent).toContain('Eigenbau (Modbus)');
  });

  it('lässt erst weiter, wenn der Broker im eigenen Netz steht', async () => {
    const { onSchritt } = await zeichne(1);
    expect(knopf('Weiter')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Adresse des Brokers'), {
      target: { value: '8.8.8.8' },
    });
    expect(screen.getByRole('status').textContent).toContain('eigenen Netzwerk');
    expect(knopf('Weiter')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Adresse des Brokers'), {
      target: { value: '192.168.0.44' },
    });
    fireEvent.click(knopf('Weiter'));
    expect(onSchritt).toHaveBeenCalledWith(2);
  });
});

describe('Schritt 2 · die Feld-Zuordnung mit Live-Vorschau', () => {
  function fuelleZeile() {
    fireEvent.change(screen.getByLabelText('Topic'), {
      target: { value: 'diybms/bank/+/cell/+' },
    });
    fireEvent.change(screen.getByLabelText('Wert im JSON'), { target: { value: 'voltage' } });
  }

  it('stellt Roh- und umgerechneten Wert nebeneinander', async () => {
    previewBattery.mockResolvedValue({
      results: [
        {
          id: 'batterie',
          ok: true,
          samples: [
            {
              channel: 'soc_pct',
              topic: 'diybms/status',
              raw: 41.5,
              value: 41.5,
              count: 12,
            },
          ],
        },
      ],
    });
    await zeichne(2);
    fuelleZeile();
    fireEvent.click(knopf('Werte ansehen'));
    await waitFor(() => expect(previewBattery).toHaveBeenCalled());
    await screen.findByText('41,5');
    expect(screen.getByText('41,5 %')).toBeTruthy();
    expect(screen.getByTestId('vorschau-hinweis').textContent).toContain('Alle Zuordnungen');
    // Die Vorschau schreibt nichts - sie fragt nur, was ankommt.
    const [, body] = previewBattery.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.socDerivation).toBeUndefined();
    expect(body.mappings).toHaveLength(1);
  });

  /** „nicht gemessen" ist nie „gemessen 0". */
  it('sagt bei einer Zuordnung ohne Empfang „Nichts empfangen" statt 0', async () => {
    previewBattery.mockResolvedValue({
      results: [{ id: 'batterie', ok: true, samples: [{ channel: 'soc_pct', count: 0 }] }],
    });
    await zeichne(2);
    fuelleZeile();
    fireEvent.click(knopf('Werte ansehen'));
    await screen.findByText(/Nichts empfangen/);
    expect(screen.queryByText('0')).toBeNull();
  });

  /**
   * Ein fehlender `samples`-Block ist eine Aussage über die BOX - und kein
   * Fehlschlag: die Vorschau ist ein Angebot, keine Pflicht. Der Weiter-Knopf
   * bleibt offen.
   */
  it('nennt eine Box, die noch nicht lauschen kann, beim Namen - und blockiert nicht', async () => {
    previewBattery.mockResolvedValue({ results: [{ id: 'batterie', ok: true }] });
    const { onSchritt } = await zeichne(2);
    fuelleZeile();
    fireEvent.click(knopf('Werte ansehen'));
    const hinweis = await screen.findByTestId('vorschau-hinweis');
    expect(hinweis.textContent).toContain('noch nicht mithören');
    expect(hinweis.textContent).toContain('trotzdem speichern');
    fireEvent.click(knopf('Weiter'));
    expect(onSchritt).toHaveBeenCalledWith(3);
  });

  /**
   * Eine geänderte Zuordnung entwertet ihre Vorschau: eine stehengebliebene
   * Zahl neben geänderten Angaben wäre eine Behauptung über einen Empfang,
   * den es so nie gab.
   */
  it('wirft die Vorschau weg, sobald die Zeile sich ändert', async () => {
    previewBattery.mockResolvedValue({
      results: [
        { id: 'batterie', ok: true, samples: [{ channel: 'soc_pct', raw: 41, value: 41, count: 3 }] },
      ],
    });
    await zeichne(2);
    fuelleZeile();
    fireEvent.click(knopf('Werte ansehen'));
    await screen.findByText('41');
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'anderes/topic' } });
    expect(screen.queryByText('41')).toBeNull();
  });

  it('bietet die Zusammenfassungen eines Ja/Nein-Werts nur konservativ an', async () => {
    await zeichne(2);
    fireEvent.click(screen.getByRole('combobox', { name: 'Welcher Messwert ist das?' }));
    fireEvent.click(screen.getByRole('option', { name: /Laden erlaubt/ }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Zusammenfassung' }));
    const optionen = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionen).toEqual(['Letzter Wert', 'Kleinster Wert', 'Größter Wert']);
  });
});

describe('Schritt 3 · wie der Ladestand entsteht', () => {
  it('bietet alle drei gebauten Methoden an', async () => {
    await zeichne(3);
    for (const id of ['direct', 'ocv_curve', 'coulomb']) {
      expect(screen.getByTestId(`soc-methode-${id}`)).toBeTruthy();
    }
  });

  /**
   * Dieselbe Spannung bedeutet an einer LiFePO₄-Zelle einen völlig anderen
   * Ladestand - die gewählte Vorlage muss ihre Chemie NENNEN.
   */
  it('füllt aus einer Vorlage die Stützpunkte und warnt vor der Zellchemie', async () => {
    await zeichne(3);
    fireEvent.click(screen.getByTestId('soc-methode-ocv_curve'));
    await screen.findByRole('combobox', { name: 'Kennlinien-Vorlage' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Kennlinien-Vorlage' }));
    fireEvent.click(screen.getByRole('option', { name: /DIYBMS 176s NMC/ }));
    expect(screen.getByRole('note').textContent).toContain('NMC');
    expect(
      (screen.getByLabelText('Ladekurve Punkt 1 Zellspannung in Volt') as HTMLInputElement).value,
    ).toBe('3,26');
    expect((screen.getByLabelText('Zellen in Reihe') as HTMLInputElement).value).toBe('176');
  });

  /**
   * Eine Kurve, die bei STEIGENDER Spannung fällt, beschreibt keine
   * Lithium-Zelle - der Editor sagt es sofort, statt still falsch zu rechnen.
   */
  it('meldet eine fallende Kennlinie im Editor', async () => {
    await zeichne(3);
    fireEvent.click(screen.getByTestId('soc-methode-ocv_curve'));
    await screen.findByRole('combobox', { name: 'Kennlinien-Vorlage' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Kennlinien-Vorlage' }));
    fireEvent.click(screen.getByRole('option', { name: /DIYBMS 176s NMC/ }));
    fireEvent.change(screen.getByLabelText('Ladekurve Punkt 3 Ladestand in Prozent'), {
      target: { value: '10' },
    });
    expect(screen.getAllByText(/eine Kennlinie steigt/).length).toBeGreaterThan(0);
  });

  /** Ein von Hand geänderter Punkt ist keine Vorlage mehr. */
  it('löst die Vorlagen-Bindung, sobald ein Punkt von Hand geändert wird', async () => {
    await zeichne(3);
    fireEvent.click(screen.getByTestId('soc-methode-ocv_curve'));
    await screen.findByRole('combobox', { name: 'Kennlinien-Vorlage' });
    const picker = screen.getByRole('combobox', { name: 'Kennlinien-Vorlage' });
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: /DIYBMS 176s NMC/ }));
    fireEvent.change(screen.getByLabelText('Ladekurve Punkt 2 Zellspannung in Volt'), {
      target: { value: '3,72' },
    });
    expect(within(picker).queryByText(/DIYBMS/)).toBeNull();
  });

  /** Ohne zugeordneten Ladestand kann „gemessen übernehmen" nicht rechnen. */
  it('sperrt „Weiter", solange die gewählte Methode keinen Eingang hat', async () => {
    await zeichne(3);
    fireEvent.click(screen.getByTestId('soc-methode-coulomb'));
    expect(knopf('Weiter')).toBeDisabled();
    expect(screen.getAllByRole('status')[0].textContent).toContain('Kapazität');
  });
});

describe('Schritt 4 · prüfen & anlegen', () => {
  it('fasst zusammen und sagt, dass gelesen und nicht gesteuert wird', async () => {
    createBattery.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    const { onSaved } = await zeichne(4);
    expect(screen.getByText(/liest diese Batterie/).textContent).toContain('berechnet');
    fireEvent.click(knopf('Batterie anlegen'));
    await waitFor(() => expect(createBattery).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('Bearbeiten', () => {
  const gespeichert = {
    entityId: 'e1',
    label: 'Selbstbau-Pack',
    connection: {
      schema_version: '1.0',
      transport: 'mqtt_local',
      broker: { host: '192.168.0.44', port: 1883 },
      publish_interval_s: 20,
      mappings: [
        {
          channel: 'cell_min_mv',
          unit: 'mV',
          topic: 'diybms/bank/+/cell/+',
          path: 'voltage',
          aggregate: 'min',
          value_type: 'number',
          scale: 1000,
          offset: 0,
          stale_s: 300,
        },
      ],
    },
  };

  it('füllt das Formular aus der GESPEICHERTEN Fassung vor', async () => {
    await zeichne(1, gespeichert);
    expect((screen.getByLabelText('Adresse des Brokers') as HTMLInputElement).value).toBe(
      '192.168.0.44',
    );
    expect((screen.getByLabelText('Sende-Abstand (s)') as HTMLInputElement).value).toBe('20');
  });

  /** Die Umrechnung 1000 darf beim Ansehen nicht zu 1 werden (Tausenderpunkt). */
  it('behält die Umrechnung beim Zurücklesen', async () => {
    await zeichne(2, gespeichert);
    expect((screen.getByLabelText('Umrechnung (×)') as HTMLInputElement).value).toBe('1000');
  });

  it('schickt beim Speichern PUT statt POST', async () => {
    updateBattery.mockResolvedValue({ componentAuthority: 'portal', components: [] });
    await zeichne(4, gespeichert);
    fireEvent.click(knopf('Änderungen speichern'));
    await waitFor(() => expect(updateBattery).toHaveBeenCalled());
    expect(createBattery).not.toHaveBeenCalled();
    const [, entityId] = updateBattery.mock.calls[0] as [string, string];
    expect(entityId).toBe('e1');
  });
});
