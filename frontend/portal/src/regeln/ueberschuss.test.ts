import { describe, expect, it } from 'vitest';
import {
  UEBERSCHUSS_BLOCKIERT,
  UEBERSCHUSS_HINWEIS,
  UEBERSCHUSS_LABEL,
  UEBERSCHUSS_WEITER,
  bietetUeberschuss,
  hatUeberschuss,
} from './ueberschuss';

describe('Solar-Überschuss als Bedingung des Baukastens (Stufe 2)', () => {
  it('heißt in Kundenworten und nennt keine Maschine', () => {
    const alles = [UEBERSCHUSS_LABEL, UEBERSCHUSS_HINWEIS, UEBERSCHUSS_WEITER, UEBERSCHUSS_BLOCKIERT]
      .join(' ');
    expect(UEBERSCHUSS_LABEL).toBe('Solar-Überschuss');
    // Kein internes Vokabular in einem Satz, den ein Kunde liest.
    expect(alles).not.toMatch(/pv_surplus|consumer_policy|Flow|Signal|Compiler/i);
  });

  it('sagt den NUTZEN, nicht die Einschränkung', () => {
    expect(UEBERSCHUSS_HINWEIS).toContain('sofort');
    expect(UEBERSCHUSS_HINWEIS).toContain('Verbindung');
  });

  it('nennt den Einwand VOR dem Klick und den Weg daneben', () => {
    expect(UEBERSCHUSS_BLOCKIERT).toContain('Solar-Überschuss');
    expect(UEBERSCHUSS_BLOCKIERT).toMatch(/Knopf/);
  });

  it('wird nur angeboten, wenn es einen Weg gibt', () => {
    expect(bietetUeberschuss(true)).toBe(true);
    expect(bietetUeberschuss(false)).toBe(false);
  });

  it('erkennt eine gewählte Überschuss-Bedingung', () => {
    expect(hatUeberschuss(['entity', 'surplus'])).toBe(true);
    expect(hatUeberschuss(['entity', 'price'])).toBe(false);
    expect(hatUeberschuss([])).toBe(false);
  });
});
