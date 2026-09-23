import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { UEMS_GETEILT_HINWEIS, uemsGeteiltSatz } from '../glossar';
import { GeteiltesRegisterHinweis } from './GeteiltesRegisterHinweis';

it('AP-07 IP-18b: ohne Fund nichts, mit Fund eine Warnung neben den Zahlen in Kundensprache', () => {
  const { container } = render(<GeteiltesRegisterHinweis saetze={[]} />);
  expect(container).toBeEmptyDOMElement();

  render(<GeteiltesRegisterHinweis saetze={[uemsGeteiltSatz(['MS-12', 'MS-13'])]} />);
  const note = screen.getByRole('note');
  expect(note).toHaveTextContent(
    'Möglicherweise doppelt gezählt: MS-12 und MS-13 hängen am selben Register der VoltPilot-Box.',
  );
  expect(note).toHaveTextContent(UEMS_GETEILT_HINWEIS);
});

it('zählt drei Namen mit Komma und „und“ auf', () => {
  expect(uemsGeteiltSatz(['MS-12', 'MS-13', 'MS-14'])).toBe(
    'MS-12, MS-13 und MS-14 hängen am selben Register der VoltPilot-Box.',
  );
});
