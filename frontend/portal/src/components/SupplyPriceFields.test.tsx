import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SupplyPriceFields } from './SupplyPriceFields';
import { supplyPriceFormValues } from '../supplyPrice';

describe('SupplyPriceFields', () => {
  it('renders the component inputs prefilled with the suggestions for dynamisch/ohne', () => {
    render(
      <SupplyPriceFields
        tarifArt="dynamisch"
        values={supplyPriceFormValues(null)}
        onChange={() => {}}
        idPrefix="t"
      />,
    );
    // The Netzentgelt field is prefilled with the researched 7.6 suggestion.
    const netz = screen.getByLabelText(/Netzentgelt-Arbeitspreis/) as HTMLInputElement;
    expect(netz.value).toBe('7.6');
    // The visible source/Stand note is present.
    expect(screen.getByText(/Vorschlagswerte Stand 2026/)).toBeInTheDocument();
    // The USt field defaults to 19.
    expect((screen.getByLabelText(/Umsatzsteuer/) as HTMLInputElement).value).toBe('19');
  });

  it('shows only the fest hint for a fixed tariff (no component inputs)', () => {
    render(
      <SupplyPriceFields
        tarifArt="fest"
        values={supplyPriceFormValues(null)}
        onChange={() => {}}
        idPrefix="t"
      />,
    );
    expect(screen.queryByLabelText(/Netzentgelt-Arbeitspreis/)).toBeNull();
    expect(screen.getByText(/all-in-Preis/)).toBeInTheDocument();
  });

  it('reports edits by field key', () => {
    const onChange = vi.fn();
    render(
      <SupplyPriceFields
        tarifArt="ohne"
        values={supplyPriceFormValues(null)}
        onChange={onChange}
        idPrefix="t"
      />,
    );
    fireEvent.change(screen.getByLabelText(/Stromsteuer/), { target: { value: '2,10' } });
    expect(onChange).toHaveBeenCalledWith('stromsteuerCt', '2,10');
  });
});
