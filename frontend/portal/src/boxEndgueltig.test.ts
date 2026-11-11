import { describe, expect, it } from 'vitest';
import type { BoxEndgueltigBefund } from './admin/adminApi';
import {
  ausgebautZeile, bleibtSatz, DATENART_LABEL, datenListe, loeschenFolgen, NIE_DATEN_SATZ,
} from './boxEndgueltig';

/** Die Server-Datenarten des Befunds (BoxDatenBestand + die beiden Beleg-Regeln + der DB-Fallback). */
const SERVER_DATENARTEN = [
  'herzschlag', 'messwerte', 'messauswahl', 'meldungen', 'befehle', 'ocpp', 'rueckmeldungen',
  'freigaben', 'komponenten', 'messstellen_belege', 'berichtsstaende', 'weitere_aufzeichnungen',
];

function befund(daten: string[]): BoxEndgueltigBefund {
  return {
    deviceId: '6b4a0d50-0000-0000-0000-000000000001',
    loeschbar: daten.length === 0,
    daten,
    fakten: {
      verbundenAm: '2026-10-01T08:00:00Z',
      ausgebautAm: '2026-10-23T09:43:00Z',
      tenantName: 'Kunststoffwerk Ahrenberg GmbH',
      siteName: 'Werk Nord',
    },
  };
}

describe('boxEndgueltig', () => {
  it('kennt jede Datenart des Servers in Kundenworten', () => {
    for (const d of SERVER_DATENARTEN) {
      expect(DATENART_LABEL[d], `Datenart ${d} braucht ein Kundenwort`).toBeTruthy();
    }
  });

  it('eine unbekannte Datenart fällt auf ihren Server-Namen zurück statt zu verschwinden', () => {
    expect(datenListe(['messwerte', 'neu_erfunden'])).toBe('Messwerte · neu_erfunden');
  });

  it('die Kopfzeile nennt Kunde, Anlage und den Ausbau', () => {
    const zeile = ausgebautZeile(befund([]), new Date('2026-11-11T10:00:00Z'));
    expect(zeile).toContain('Kunststoffwerk Ahrenberg GmbH › Werk Nord');
    expect(zeile).toContain('Ausgebaut');
  });

  it('der Lösch-Satz der Spezifikation steht wörtlich fest', () => {
    expect(NIE_DATEN_SATZ).toBe(
      'Die Box hat nie Daten geliefert; Werkstatt- und Fernwartungs-Protokolle bleiben.');
  });

  it('die Erklärung einer bleibenden Box nennt, WAS sie trägt', () => {
    expect(bleibtSatz(['messwerte', 'messstellen_belege']))
      .toBe('Diese Box bleibt als Historie: sie trägt Messwerte · Belege an Messstellen.');
  });

  it('die Folgenliste nennt auch, was GLEICH bleibt', () => {
    const folgen = loeschenFolgen('edge-4qw2j8n');
    expect(folgen[0]).toContain('edge-4qw2j8n');
    expect(folgen.join(' ')).toContain('bleiben erhalten');
    expect(folgen.join(' ')).toContain('wieder anmeldbar');
  });
});
