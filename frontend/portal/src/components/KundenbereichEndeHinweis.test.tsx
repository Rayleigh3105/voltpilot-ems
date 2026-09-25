import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { KundenbereichEndeHinweis } from './KundenbereichEndeHinweis';

it('AP-20 IP-16: ein aktiver Kundenbereich zeigt nichts — auch nicht mit einer älteren Selbstauskunft ohne das Feld', () => {
  expect(render(<KundenbereichEndeHinweis beendet={null} />).container).toBeEmptyDOMElement();
  expect(render(<KundenbereichEndeHinweis />).container).toBeEmptyDOMElement();
});

it('AP-20 IP-16: der beendete Kundenbereich zeigt den Satz der API über jeder Seite (RF-08), ohne Knopf', () => {
  const text = 'Ihr Vertrag ist am 30.06.2029 beendet. Ihre Daten können Sie nur noch lesen; gelöscht werden sie frühestens am 28.09.2029.';
  render(<KundenbereichEndeHinweis beendet={{ beendet_am: '2029-06-30', loeschung_fruehestens: '2029-09-28', liest: true, text }} />);
  const hinweis = screen.getByRole('status');
  expect(hinweis).toHaveTextContent('Vertrag beendet');
  expect(hinweis).toHaveTextContent(text);
  // Den Gesamtabzug bringt erst IP-17 — bis dahin kein Knopf.
  expect(screen.queryByRole('button')).toBeNull();
});
