import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TariffFields } from './TariffFields';
import type { TarifArt } from '../api';
import { supplyPriceFormValues, type SupplyPriceFormValues } from '../supplyPrice';
import type { PriceMode } from '../tariffInput';

/**
 * Der Wirt, den die echten Flächen stellen: Tarifart + die EINE Zahl der
 * aktuellen Tarifart liegen beim Elternteil (er speichert), die verworfenen
 * Entwürfe der anderen Art bei der Komponente.
 */
function Host({
  art = 'dynamisch',
  param = '18',
  withSupply = false,
  storedPriceMode = 'schnell',
}: {
  art?: TarifArt;
  param?: string;
  withSupply?: boolean;
  storedPriceMode?: PriceMode;
}) {
  const [tarifArt, setTarifArt] = useState<TarifArt>(art);
  const [value, setValue] = useState(param);
  const [supply, setSupply] = useState<SupplyPriceFormValues>(() => supplyPriceFormValues(null));
  const [mode, setMode] = useState<PriceMode>(storedPriceMode);
  return (
    <TariffFields
      tarifArt={tarifArt}
      onTarifArt={setTarifArt}
      param={value}
      onParam={setValue}
      idPrefix="t"
      {...(withSupply
        ? {
            supplyValues: supply,
            onSupplyChange: (f: keyof SupplyPriceFormValues, v: string) =>
              setSupply((s) => ({ ...s, [f]: v })),
            priceMode: mode,
            onPriceMode: setMode,
            storedPriceMode,
          }
        : {})}
    />
  );
}

const AUFSCHLAG = 'Aufschlag auf den Börsenpreis (gesamt, ct/kWh)';
const FESTPREIS = 'Arbeitspreis (all-in, brutto) (ct/kWh)';

/**
 * Seit dem Picker-System ist der Stromtarif der Haus-{@link VpPicker}, kein
 * `<select>`: geöffnet wird der Auslöser, gewählt wird die Zeile.
 */
function waehleTarif(label: string): void {
  fireEvent.click(screen.getByRole('combobox', { name: 'Stromtarif' }));
  fireEvent.click(screen.getByRole('option', { name: label }));
}

describe('TariffFields · ein Wert je Tarifart (E2, Wunde 1)', () => {
  it('DIE Falle ist zu: der Aufschlag 18 steht nach dem Wechsel NICHT als Strompreis da', () => {
    render(<Host art="dynamisch" param="18" />);
    expect(screen.getByLabelText(AUFSCHLAG)).toHaveValue('18');

    waehleTarif('Fest (ct/kWh)');

    // Das Feld heißt jetzt anders UND ist leer - keine stille Umdeutung.
    const festpreis = screen.getByLabelText(FESTPREIS) as HTMLInputElement;
    expect(festpreis.value).toBe('');
    expect(screen.queryByLabelText(AUFSCHLAG)).toBeNull();
    // Und der Wechsel sagt an, was passiert ist.
    expect(screen.getByRole('status').textContent).toContain('Andere Bedeutung');
  });

  it('fest → dynamisch → fest: die Zahl kehrt zu IHRER Bedeutung zurück, nie zur fremden', () => {
    render(<Host art="fest" param="32,5" />);
    waehleTarif('Dynamisch (Börsenpreis-gekoppelt)');
    expect((screen.getByLabelText(AUFSCHLAG) as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText(AUFSCHLAG), { target: { value: '18' } });
    waehleTarif('Fest (ct/kWh)');
    expect((screen.getByLabelText(FESTPREIS) as HTMLInputElement).value).toBe('32,5');
    expect(screen.getByRole('status').textContent).toContain('wieder im Feld');

    waehleTarif('Dynamisch (Börsenpreis-gekoppelt)');
    expect((screen.getByLabelText(AUFSCHLAG) as HTMLInputElement).value).toBe('18');
  });

  it('warnt bei einem unplausiblen Wert, ohne irgendetwas zu sperren', () => {
    render(<Host art="fest" param="" />);
    const feld = screen.getByLabelText(FESTPREIS);
    fireEvent.change(feld, { target: { value: '18' } });
    const warn = screen.getByText(/Ungewöhnlich niedrig für einen Arbeitspreis/);
    expect(warn.textContent).toContain('Speichern können Sie den Wert trotzdem');
    // Das Feld bleibt bedienbar und behält den Wert - eine Warnung, keine Sperre.
    expect(feld).not.toBeDisabled();
    expect(feld).toHaveValue('18');

    fireEvent.change(feld, { target: { value: '32,5' } });
    expect(screen.queryByText(/Ungewöhnlich/)).toBeNull();
  });
});

describe('TariffFields · die ausdrückliche Wahl Schnell / Genau (D3)', () => {
  it('zeigt in „Schnell" nur die eine Zahl - nie Aufschlag UND Preisblatt zugleich', () => {
    render(<Host art="dynamisch" param="18" withSupply />);
    expect(screen.getByLabelText(AUFSCHLAG)).toBeInTheDocument();
    expect(screen.queryByText('Bezugspreis-Komponenten')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Genau/ }));
    expect(screen.getByText('Bezugspreis-Komponenten')).toBeInTheDocument();
    expect(screen.queryByLabelText(AUFSCHLAG)).toBeNull();
  });

  it('spiegelt den anderen Weg read-only, damit der Wechsel verlustfrei sichtbar ist', () => {
    render(<Host art="dynamisch" param="18" withSupply />);
    fireEvent.click(screen.getByRole('radio', { name: /Genau/ }));
    expect(screen.getByText(/Aufschlag 18 ct\/kWh.*nicht gerechnet/)).toBeInTheDocument();
  });

  it('die Wechsel-Ansage steht nie ohne das Feld, auf das sie zeigt', () => {
    render(<Host art="fest" param="32,5" withSupply />);
    // fest -> dynamisch: das Feld ist da, die Ansage auch.
    waehleTarif('Dynamisch (Börsenpreis-gekoppelt)');
    expect(screen.getByRole('status').textContent).toContain('Andere Bedeutung');
    // „Genau" blendet das Feld aus - dann darf „bitte neu eintragen" nicht
    // über einem Preisblatt stehen bleiben.
    fireEvent.click(screen.getByRole('radio', { name: /Genau/ }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('wer tippt, hat die Ansage gelesen - sie räumt sich weg', () => {
    render(<Host art="dynamisch" param="18" />);
    waehleTarif('Fest (ct/kWh)');
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(FESTPREIS), { target: { value: '32,5' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('kündigt VORHER an, dass „Schnell" ein gepflegtes Preisblatt entfernt', () => {
    render(<Host art="dynamisch" param="18" withSupply storedPriceMode="genau" />);
    // Gespeichert ist „Genau": das Preisblatt steht offen, keine Folgen-Ansage.
    expect(screen.getByText('Bezugspreis-Komponenten')).toBeInTheDocument();
    expect(screen.queryByText(/Komponenten entfernt/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Schnell/ }));
    expect(screen.getByText(/Bezugspreis-Komponenten entfernt/)).toBeInTheDocument();
    // Und was verloren ginge, steht zusammengefasst daneben.
    expect(screen.getByText(/gepflegtes Preisblatt/)).toBeInTheDocument();
  });

  it('bei „Fest" gibt es keine Wahl - der all-in Preis ist die eine Wahrheit', () => {
    render(<Host art="fest" param="32,5" withSupply />);
    expect(screen.queryByRole('radio', { name: /Genau/ })).toBeNull();
    expect(screen.getByLabelText(FESTPREIS)).toBeInTheDocument();
    expect(screen.getByText(/Bezugspreis-Komponenten werden dann nicht zusätzlich gezählt/))
      .toBeInTheDocument();
  });

  it('ohne Preisblatt-Daten (Admin-Drawer) bleibt das schlanke Formular', () => {
    render(<Host art="dynamisch" param="18" />);
    expect(screen.queryByRole('radio', { name: /Schnell/ })).toBeNull();
    expect(screen.getByLabelText(AUFSCHLAG)).toBeInTheDocument();
  });
});
