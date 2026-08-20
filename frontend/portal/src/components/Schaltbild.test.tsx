import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Schaltbild } from './Schaltbild';
import type { Schaltbild as Bild } from '../schaltbild';

/**
 * Der Renderer ist bewusst DUMM - geprüft wird deshalb nur, dass er nichts
 * eigenes entscheidet: dass er die textLength-Disziplin einhält, dass ein
 * Klickziel wirklich anklickbar ist und dass eine Lücke sichtbar wird.
 */
const BASIS: Bild = {
  breite: 1376,
  hoehe: 400,
  spalten: [{ titel: 'GERÄTE', x: 680 }],
  knoten: [
    {
      id: 'g1',
      art: 'geraet',
      titel: 'Deye SUN-30K-SG01HP3-EU',
      titelKapp: 220,
      zeilen: [{ text: '192.168.254.210 : 8899', ton: null, kapp: 220 }],
      rolle: null,
      abzeichen: null,
      ton: 'ok',
      gestrichelt: false,
      href: '#/anlage/site-1/geraet/edge-1/inverter',
      komponenteId: null,
      x: 560,
      y: 48,
      w: 240,
      h: 60,
      einheiten: [],
    },
    {
      id: 'k1',
      art: 'komponente',
      titel: 'Dach Süd',
      zeilen: [{ text: 'Erzeugung · 21,2 kW', ton: null }],
      rolle: 'pv',
      abzeichen: 'maßgeblich',
      ton: 'ok',
      gestrichelt: false,
      href: null,
      komponenteId: 'ent-pv1',
      x: 900,
      y: 48,
      w: 260,
      h: 60,
      einheiten: [],
    },
  ],
  kanten: [
    {
      id: 'misst:g1:k1',
      art: 'misst',
      x1: 800,
      y1: 78,
      x2: 900,
      y2: 78,
      rolle: 'pv',
      label: null,
      labelX: 0,
      labelY: 0,
      pfeil: false,
    },
  ],
  legende: [{ art: 'misst', text: 'misst (Farbe = Rolle)' }],
  luecken: ['Die eigene LAN-Adresse Ihrer Box meldet sie noch nicht.'],
  leer: null,
};

describe('Schaltbild (Renderer)', () => {
  it('zeichnet Knoten, Legende und die Lücken-Zeilen', () => {
    render(<Schaltbild bild={BASIS} />);
    expect(screen.getByText('Deye SUN-30K-SG01HP3-EU')).toBeInTheDocument();
    expect(screen.getByText('misst (Farbe = Rolle)')).toBeInTheDocument();
    expect(screen.getByText(/LAN-Adresse/)).toBeInTheDocument();
  });

  it('setzt textLength NUR dort, wo die Ableitung eine Kappbreite nennt', () => {
    render(<Schaltbild bild={BASIS} />);
    const gekappt = screen.getByText('Deye SUN-30K-SG01HP3-EU');
    expect(gekappt).toHaveAttribute('textLength', '220');
    expect(gekappt).toHaveAttribute('lengthAdjust', 'spacingAndGlyphs');
    // Eine bequem passende Zeile wird NIE gestreckt.
    expect(screen.getByText('Dach Süd')).not.toHaveAttribute('textLength');
  });

  it('führt ein Gerät als echten Link auf seine Seite', () => {
    render(<Schaltbild bild={BASIS} />);
    const link = screen.getByText('Deye SUN-30K-SG01HP3-EU').closest('a');
    expect(link).toHaveAttribute('href', '#/anlage/site-1/geraet/edge-1/inverter');
  });

  it('meldet einen Komponenten-Klick mit IHRER Kennung', () => {
    const onKomponente = vi.fn();
    render(<Schaltbild bild={BASIS} onKomponente={onKomponente} />);
    fireEvent.click(screen.getByRole('button', { name: /Dach Süd/ }));
    expect(onKomponente).toHaveBeenCalledWith('ent-pv1');
  });

  it('rendert ohne Bild NUR den ehrlichen Satz', () => {
    render(<Schaltbild bild={{ ...BASIS, leer: 'Noch nichts zu zeichnen.' }} />);
    expect(screen.getByText('Noch nichts zu zeichnen.')).toBeInTheDocument();
    expect(screen.queryByText('Deye SUN-30K-SG01HP3-EU')).not.toBeInTheDocument();
  });
});
