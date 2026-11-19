import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bereitZumAufspielen, bestaetigung, brauchtDichFernlauf, FERNLAUF_ERGEBNISSE, FERNLAUF_GRUPPEN, FERNLAUF_SCHRITTE,
  fassungKurz, fragtSatz, fragtText, haken, ohneKundenkontoKopf, schrittleiste, standZeilen, tunnelKarte,
  verlaufZeile, type Fernlauf, type FernlaufStand,
} from './werkstattFernlauf';

const vektor = JSON.parse(readFileSync(resolve(__dirname, '../../../docs/contracts/werkstatt-fernlauf.json'), 'utf8')) as {
  schritte: { id: string; gruppe: string; titel: string }[];
  gruppen: { id: string; titel: string }[];
  ergebnisse: string[];
};

const JETZT = new Date('2026-11-18T16:58:00Z');

function stand(teil: Partial<FernlaufStand> = {}): FernlaufStand {
  return {
    edgeRef: 'edge-k7m2xq3', laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: '2026-11-18T15:55:00Z',
    fragtZuletztAm: '2026-11-18T16:57:40Z', neueste: 'edge-light-2026.11.15', werkstattFassung: 'edge-light-2026.11.5',
    werkstattAm: '2026-11-09T15:06:00Z', moeglich: true, gruende: [],
    haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true }, verlauf: [],
    stand: JETZT.toISOString(), ...teil,
  };
}

function auftrag(teil: Partial<Fernlauf> = {}): Fernlauf {
  return {
    id: 'a1', art: 'aufspielen', zustand: 'laeuft', fassungVorher: 'edge-light-2026.11.5',
    fassungZiel: 'edge-light-2026.11.15', akteurName: 'admin', erteiltAm: '2026-11-18T16:55:00Z',
    begonnenAm: '2026-11-18T16:55:05Z', schritt: 'aufspielen', schrittSeit: '2026-11-18T16:57:00Z',
    schritte: [
      { schritt: 'anmelden', zustand: 'belegt', zeit: null, zeile: 'angemeldet' },
      { schritt: 'bestand', zustand: 'belegt', zeit: null, zeile: 'läuft 2026.11.5' },
      { schritt: 'fassungen', zustand: 'belegt', zeit: null, zeile: 'signiert' },
      { schritt: 'sichern', zustand: 'belegt', zeit: null, zeile: 'gesichert' },
    ],
    fensterEnde: '2026-11-18T17:25:00Z', ergebnis: null, ...teil,
  };
}

describe('Fernlauf durch den Tunnel (vp-update-vor-zuordnung S1)', () => {
  it('Vokabulare wie im Vertragsvektor', () => {
    expect(FERNLAUF_SCHRITTE).toEqual(vektor.schritte);
    expect(FERNLAUF_GRUPPEN).toEqual(vektor.gruppen);
    expect([...FERNLAUF_ERGEBNISSE]).toEqual(vektor.ergebnisse);
  });

  it('Linie und Stand nennt die laufende Fassung aus der Zertifikatsanfrage (N2) und ob sie gerade fragt (N5)', () => {
    const z = standZeilen(stand(), JETZT);
    expect(z.map((x) => [x.wer, x.wert])).toEqual([
      ['Läuft', '2026.11.5'], ['Fragt', 'gerade nach ihrem Zertifikat (vor 20\u00a0Sek.)'], ['Neueste', '2026.11.15'],
      ['Werkstatt', '2026.11.5'],
    ]);
    expect(z[0].satz).toBe('gemeldet beim Start 16:55');
    expect(z[3].satz).toBe('abgenommen 09.11., 16:06');
    expect(standZeilen(stand({ laeuft: null, laeuftGemeldetAm: null }), JETZT)[0])
      .toEqual({ wer: 'Läuft', wert: 'unbekannt', satz: 'Die Box hat noch keine Fassung gemeldet.' });
  });

  it('fragt: gerade nur bis drei Minuten, unbekannt ist nie', () => {
    expect(fragtText(null, JETZT)).toBe('noch nie nach ihrem Zertifikat');
    expect(fragtText('2026-11-18T16:50:00Z', JETZT)).toBe('zuletzt vor 8\u00a0Min. nach ihrem Zertifikat');
    expect(fragtSatz({ csrUpdatedAt: '2026-11-18T15:55:00Z', zuletztAbgefragtAm: '2026-11-18T16:57:50Z',
      deviceInfo: 'vp-edge-core edge-light-2026.11.5' }, JETZT))
      .toBe('Fragt gerade nach ihrem Zertifikat (vor 10\u00a0Sek.) · zuletzt gestartet 16:55 · vp-edge-core edge-light-2026.11.5.');
  });

  it('ohne Auftrag: der Knopf mit Ziel, drei Haken; gesperrt mit dem ersten Grund', () => {
    expect(tunnelKarte(stand(), JETZT)).toEqual({ art: 'knopf', knopf: { label: 'Auf 2026.11.15 bringen', moeglich: true, grund: null } });
    expect(haken(stand()).every((h) => h.ok)).toBe(true);
    const zu = tunnelKarte(stand({ moeglich: false, gruende: [{ code: 'nicht_verbunden', text: 'Die Box ist gerade nicht im Tunnel.' }],
      haken: { tunnelVerbunden: false, fragtNachSchluesseln: false, keinKundenkonto: true } }), JETZT);
    expect(zu).toEqual({ art: 'knopf', knopf: { label: 'Auf 2026.11.15 bringen', moeglich: false, grund: 'Die Box ist gerade nicht im Tunnel.' } });
    // Nichts Neueres: kein Knopf, nur der Satz.
    const schon = tunnelKarte(stand({ moeglich: false, gruende: [{ code: 'schon_neueste', text: 'Die Box läuft schon edge-light-2026.11.15; neuer ist nichts.' }] }), JETZT);
    expect(schon.art === 'knopf' && schon.knopf.label).toBe(null);
  });

  it('läuft: Schrittleiste mit erledigten Gruppen und dem laufenden Schritt', () => {
    const k = tunnelKarte(stand({ verlauf: [auftrag()] }), JETZT);
    expect(k.art).toBe('laeuft');
    if (k.art !== 'laeuft') return;
    expect(k.schrittTitel).toBe('Neue Fassung aufspielen');
    expect(k.seit).toBe('Lauf seit 3 Min.');
    expect(schrittleiste(k.auftrag).map((p) => `${p.id}:${p.zustand}`)).toEqual([
      'anmelden:erledigt', 'sichern:erledigt', 'aufspielen:laeuft', 'neustart:offen', 'pruefen:offen',
    ]);
    const erteilt = tunnelKarte(stand({ verlauf: [auftrag({ zustand: 'erteilt', begonnenAm: null, schritt: null, schritte: [] })] }), JETZT);
    expect(erteilt.art === 'laeuft' && erteilt.schrittTitel).toBe('Wartet auf den Werkstatt-Dienst');
  });

  it('Ergebnisse: fertig, zurück mit Grund und „Noch einmal", offen', () => {
    const fertig = tunnelKarte(stand({ moeglich: false, gruende: [{ code: 'schon_neueste', text: 'x' }], laeuft: 'edge-light-2026.11.15',
      verlauf: [auftrag({ zustand: 'fertig', ergebnis: { ergebnis: 'fertig', grund: null, schritt: 'tunnel', fassungNachher: 'edge-light-2026.11.15',
        belege: {}, quelle: 'dienst', erfasstAm: '2026-11-18T16:09:00Z' } })] }), JETZT);
    expect(fertig).toMatchObject({ art: 'ergebnis', ton: 'ok', titel: '2026.11.15 läuft', satz: 'Meldet sich wieder · 17:09', knopf: { label: null } });
    const zurueck = tunnelKarte(stand({ verlauf: [auftrag({ zustand: 'zurueck', schritte: [
      ...auftrag().schritte, { schritt: 'neustart', zustand: 'gescheitert', zeit: null, zeile: '/health nennt edge-light-2026.11.9' }],
    ergebnis: { ergebnis: 'zurueck', grund: '/health nennt edge-light-2026.11.9', schritt: 'neustart', fassungNachher: 'edge-light-2026.11.5',
      belege: {}, quelle: 'dienst', erfasstAm: '2026-11-18T17:05:00Z' } })] }), JETZT);
    expect(zurueck).toMatchObject({ art: 'ergebnis', ton: 'warn', titel: 'Zurück auf 2026.11.5',
      satz: 'Schritt „Programm neu starten" · /health nennt edge-light-2026.11.9', knopf: { label: 'Noch einmal', moeglich: true } });
    if (zurueck.art === 'ergebnis') {
      expect(schrittleiste(zurueck.auftrag).find((p) => p.id === 'neustart')?.zustand).toBe('gescheitert');
    }
    const offen = tunnelKarte(stand({ verlauf: [auftrag({ zustand: 'offen', schritt: 'aufspielen' })] }), JETZT);
    expect(offen).toMatchObject({ art: 'ergebnis', ton: 'warn', titel: 'Offen' });
    expect(offen.art === 'ergebnis' && offen.satz).toContain('zeigt ihr nächster Start');
  });

  it('Bestätigung und Verlauf sprechen den Admin mit du an', () => {
    const b = bestaetigung('edge-k7m2xq3', stand());
    expect(b.titel).toBe('edge-k7m2xq3 von 2026.11.5 auf 2026.11.15 bringen?');
    expect(b.intro).toBe('Der Werkstatt-Dienst bekommt ein Fenster für 30 Min. Die Box startet einmal neu.');
    expect(b.folgen.join(' ')).toContain('deinem Namen');
    expect(verlaufZeile(auftrag({ zustand: 'zurueck' }), JETZT)).toEqual({ wann: '17:55', text: 'Über den Tunnel auf 2026.11.15 · zurückgenommen · admin', ton: 'warn' });
    expect(fassungKurz(null)).toBe('unbekannt');
  });

  describe('Karte „Ohne Kundenkonto" (S2)', () => {
    it('bereitZumAufspielen: nur, wo die Vorprüfung durchkommt', () => {
      const liste = [stand({ edgeRef: 'edge-a' }), stand({ edgeRef: 'edge-b', moeglich: false,
        gruende: [{ code: 'nicht_verbunden', text: 'x' }] })];
      expect(bereitZumAufspielen(liste).map((s) => s.edgeRef)).toEqual(['edge-a']);
    });

    it('ohneKundenkontoKopf: zählt die Boxen und, wenn welche bereit sind, wie viele älter laufen', () => {
      expect(ohneKundenkontoKopf([])).toBe('Keine Box wartet gerade auf ihr Kundenkonto.');
      const einzeln = [stand({ edgeRef: 'edge-a' })];
      expect(ohneKundenkontoKopf(einzeln)).toBe('1 Box wartet auf ihr Kundenkonto · 1 läuft älter als 2026.11.15');
      const zwei = [stand({ edgeRef: 'edge-a' }), stand({ edgeRef: 'edge-b' })];
      expect(ohneKundenkontoKopf(zwei)).toBe('2 Boxen warten auf ihr Kundenkonto · 2 laufen älter als 2026.11.15');
      // Schon aktuell: zählt nicht mehr als „älter".
      const aktuell = [stand({ edgeRef: 'edge-c', moeglich: false,
        gruende: [{ code: 'schon_neueste', text: 'x' }] })];
      expect(ohneKundenkontoKopf(aktuell)).toBe('1 Box wartet auf ihr Kundenkonto');
    });

    it('brauchtDichFernlauf: nur zurückgenommene oder offen gebliebene Fernläufe, mit Grund', () => {
      const liste = [
        stand({ edgeRef: 'edge-fertig', verlauf: [auftrag({ zustand: 'fertig',
          ergebnis: { ergebnis: 'fertig', grund: null, schritt: 'tunnel', fassungNachher: 'edge-light-2026.11.15',
            belege: {}, quelle: 'dienst', erfasstAm: '2026-11-18T16:09:00Z' } })] }),
        stand({ edgeRef: 'edge-zurueck', verlauf: [auftrag({ zustand: 'zurueck',
          ergebnis: { ergebnis: 'zurueck', grund: '/health nennt edge-light-2026.11.9', schritt: 'neustart',
            fassungNachher: 'edge-light-2026.11.5', belege: {}, quelle: 'dienst',
            erfasstAm: '2026-11-18T17:05:00Z' } })] }),
        stand({ edgeRef: 'edge-offen', verlauf: [auftrag({ zustand: 'offen', schritt: 'aufspielen' })] }),
        stand({ edgeRef: 'edge-ohne-lauf', verlauf: [] }),
      ];
      const eintraege = brauchtDichFernlauf(liste, JETZT);
      expect(eintraege.map((e) => e.edgeRef)).toEqual(['edge-zurueck', 'edge-offen']);
      expect(eintraege[0]).toMatchObject({ ton: 'warn' });
      expect(eintraege[0].text).toContain('zurückgenommen');
      expect(eintraege[1].text).toContain('offen');
    });
  });
});
