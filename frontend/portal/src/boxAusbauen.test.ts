import { describe, expect, it } from 'vitest';
import { ausbaubar, ausbauenFolgen, befundSatz, nichtAusbaubarFolgen } from './boxAusbauen';

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

describe('befundSatz (Admin-Durchgang F17)', () => {
  const jetzt = new Date('2026-11-13T13:00:00Z');
  const fakten = {
    verbundenAm: '2026-01-01T00:00:00Z', herzschlagAm: null, messwertAm: '2026-11-13T10:00:00Z', meldungAm: null,
    anmeldung: { zuletztAngefragtAm: null, schluesselAbgeholtAm: null },
  };

  it('nennt die LETZTE Messung „letzter Messwert vor …" statt „Messwerte seit vor …", ohne doppelten Punkt', () => {
    const satz = befundSatz({ loesbar: false, gruende: ['messwerte'], fakten }, jetzt);
    expect(satz).toBe('Hat Daten gespeichert · letzter Messwert vor 3\u00a0Std.');
    expect(satz).not.toContain('seit vor');
    expect(satz).not.toContain('..');
  });

  it('setzt den Schlusspunkt, wenn der letzte Teil keinen trägt', () => {
    expect(befundSatz({ loesbar: false, gruende: ['zustaendigkeit'], fakten }, jetzt))
      .toBe('Hat Daten gespeichert · liest noch eine Datenquelle.');
  });
});
