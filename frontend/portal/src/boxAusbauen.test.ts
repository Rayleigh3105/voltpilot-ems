import { describe, expect, it } from 'vitest';
import { ausbaubar, ausbauenFolgen, nichtAusbaubarFolgen } from './boxAusbauen';

describe('boxAusbauen', () => {
  it('eine Box mit Daten (Herzschlag, Messwerte) ist ausbaubar - genau der vorgesehene Fall', () => {
    expect(ausbaubar(['herzschlag', 'messwerte', 'meldungen'])).toBe(true);
  });

  it('eine Box, die ihren Schlüssel schon abgeholt hat, ist weiter ausbaubar (anders als Lösen)', () => {
    expect(ausbaubar(['herzschlag', 'messwerte', 'angemeldet'])).toBe(true);
  });

  it('eine offene Zuständigkeit (Datenquelle) blockiert den Ausbau - derselbe Server-Wächter', () => {
    expect(ausbaubar(['messwerte', 'zustaendigkeit'])).toBe(false);
  });

  it('eine nicht mehr verbundene Box (Rennen, schon ausgebaut) ist nicht ausbaubar', () => {
    expect(ausbaubar(['verbund'])).toBe(false);
  });

  it('keine Gründe (lösbar) wäre ohnehin nie der Ausbau-Zweig, aber die Funktion sagt wahr', () => {
    expect(ausbaubar([])).toBe(true);
  });

  it('die Folgenliste des Ausbau-Dialogs nennt die Kennung und dass Daten bleiben', () => {
    const folgen = ausbauenFolgen('edge-4qw2j8n');
    expect(folgen.join(' ')).toContain('edge-4qw2j8n');
    expect(folgen.join(' ')).toContain('bleiben beim Kunden');
    expect(folgen.join(' ')).toContain('Einrichtung');
  });

  it('eine offene Zuständigkeit nennt den Weg dorthin statt eines toten Knopfs', () => {
    const folgen = nichtAusbaubarFolgen(['messwerte', 'zustaendigkeit']);
    expect(folgen.join(' ')).toContain('Zuständigkeit');
    expect(folgen.join(' ')).toContain('Wie der Kunde es sieht');
  });

  it('jeder andere blockierte Fall bleibt beim bisherigen Umweg-Satz', () => {
    const folgen = nichtAusbaubarFolgen(['verbund']);
    expect(folgen.join(' ')).toContain('Gerät entfernen');
  });
});
