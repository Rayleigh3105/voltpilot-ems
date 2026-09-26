import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { balkenliste, ctWert, type BalkenZeile } from '../../balkenliste';
import { Balkenliste } from './Balkenliste';

/**
 * Der DÜNNE Renderer über `balkenliste.ts`: Namen und Zahlen stehen als Text,
 * der Balken ist nur Bild — und er bekommt seine Länge aus der Skala, nie eine
 * eigene Rechnung.
 */
function zeilen(): BalkenZeile[] {
  return [
    {
      id: 'eigenverbrauch',
      name: 'Eigenverbrauch',
      rolle: 'eigenverbrauch',
      wert: ctWert(25),
      vorhanden: true,
      segmente: [{ rolle: 'eigenverbrauch', von: 0, bis: 25 }],
      unter: { text: 'gespart: vermiedener Netzbezug' },
    },
    {
      id: 'erloes',
      name: 'Ihr Erlös je kWh',
      rolle: null,
      wert: ctWert(10),
      vorhanden: true,
      summe: true,
      segmente: [
        { rolle: 'einspeisung', von: 0, bis: 7.5 },
        { rolle: 'praemie', von: 7.5, bis: 10, danach: true },
      ],
      unter: { text: '+ 2,5 ct Marktprämie', schluessel: 'praemie' },
      info: { titel: 'Bei 0,0 ct Börsenpreis', text: 'Prämie gilt noch.' },
    },
    {
      id: 'netzbezug',
      name: 'Netzbezug',
      rolle: 'netzbezug',
      wert: ctWert(null),
      vorhanden: false,
      segmente: [],
      unter: { text: 'kein Stromtarif hinterlegt', link: { text: 'Stromtarif hinterlegen ›', ziel: 'tarif' } },
    },
  ];
}

function zeige(z: BalkenZeile[] = zeilen()) {
  return render(
    <Balkenliste liste={balkenliste('Preise je Kilowattstunde', z)} hrefFor={(ziel) => `#/einstellungen/${ziel}`} />,
  );
}

describe('Balkenliste · Text zuerst, Balken als Bild', () => {
  it('ist eine benannte Liste, deren Zeilen Name, Wert und Grundlage LESEN lassen', () => {
    zeige();
    const liste = screen.getByRole('list', { name: 'Preise je Kilowattstunde' });
    const eintraege = within(liste).getAllByRole('listitem');
    expect(eintraege).toHaveLength(3);
    expect(eintraege[0]).toHaveTextContent('Eigenverbrauch');
    expect(eintraege[0]).toHaveTextContent('25,0 ct');
    expect(eintraege[0]).toHaveTextContent('gespart: vermiedener Netzbezug');
  });

  it('versteckt die Spur vor Hilfsmitteln — sie wiederholt nur, was der Text sagt', () => {
    const { container } = zeige();
    for (const spur of container.querySelectorAll('.vp-bl-spur')) {
      expect(spur).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('setzt jede Länge aus der gemeinsamen Skala — 25 ct füllen, 10 ct nicht', () => {
    const { container } = zeige();
    const seg = (zeile: string, n = 0) =>
      container.querySelectorAll<HTMLElement>(`[data-zeile="${zeile}"] .vp-bl-seg`)[n];
    expect(seg('eigenverbrauch').style.width).toBe('100%');
    expect(seg('erloes', 0).style.width).toBe('30%');
    expect(seg('erloes', 1).style.left).toBe('30%');
    expect(seg('erloes', 1).style.width).toBe('10%');
  });

  it('trägt die Rolle als Farbe und markiert den Block, der „obendrauf" kommt', () => {
    const { container } = zeige();
    const segs = container.querySelectorAll('[data-zeile="erloes"] .vp-bl-seg');
    expect(segs[0]).toHaveAttribute('data-rolle', 'einspeisung');
    expect(segs[1]).toHaveAttribute('data-rolle', 'praemie');
    expect(segs[1]).toHaveClass('danach');
    expect(container.querySelector('[data-zeile="erloes"]')).toHaveClass('summe');
  });

  it('zeigt „—" mit leerer Spur und dem Weg dorthin — nie einen Null-Balken', () => {
    const { container } = zeige();
    const zeile = container.querySelector('[data-zeile="netzbezug"]') as HTMLElement;
    expect(within(zeile).getByText('—')).toHaveClass('leer');
    expect(zeile.querySelector('.vp-bl-spur')).toHaveClass('leer');
    expect(zeile.querySelectorAll('.vp-bl-seg')).toHaveLength(0);
    expect(within(zeile).getByRole('link', { name: 'Stromtarif hinterlegen ›' })).toHaveAttribute(
      'href',
      '#/einstellungen/tarif',
    );
  });

  it('bietet die Erklärung auf Abruf an (ⓘ am Namen)', () => {
    zeige();
    expect(screen.getByRole('button', { name: 'Erklärung: Bei 0,0 ct Börsenpreis' })).toBeInTheDocument();
  });

  it('zieht eine Nulllinie nur, wenn ein Wert unter null liegt', () => {
    const { container, unmount } = zeige();
    expect(container.querySelector('.vp-bl-null')).toBeNull();
    unmount();
    const minus: BalkenZeile = {
      ...zeilen()[0],
      id: 'minus',
      wert: ctWert(-2),
      minus: true,
      segmente: [{ rolle: 'einspeisung', von: 0, bis: -2 }],
    };
    const { container: c2 } = zeige([zeilen()[0], minus]);
    expect(c2.querySelector('.vp-bl-null')).not.toBeNull();
    expect(c2.querySelector('[data-zeile="minus"] .vp-bl-wert')).toHaveClass('minus');
  });

  it('deckt ohne Beobachter nichts auf — die Liste steht einfach (jsdom, Druck)', () => {
    const { container } = zeige();
    expect(container.querySelector('.vp-bl-rahmen')).not.toHaveAttribute('data-aufdecken');
  });
});
