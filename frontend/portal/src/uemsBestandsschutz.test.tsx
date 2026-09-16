import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import diagramme from './test/bestandsschutz/diagramme.json';
import { EbenenTabs } from './components/EbenenTabs';
import { PortfolioTabs } from './components/PortfolioTabs';
import { anlageSurface } from './surface';
import { anlageBereiche } from './ebenenNav';
import { orteAus, startEbene } from './betriebsart';
import { ebenenLeiste, ebenenReiter, type EbenenLesemodell } from './ebenenNav';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { FIXTURE_IDS, werkAhrenberg, ahrenbergHeute, ahrenbergUnternehmen, bestandEineAnlage, bestandZweiAnlagen } from './test/standorteFixtures';

/**
 * AP-13 IP-14, Q2 / O18: unveränderter Betrieb ohne Messfunktion.
 * Bezugsstand: 84f8307ffbd668cf5dcd0cbb1f4ebfedf84062a3 (AP-13 §8.4).
 * Die leeren Snapshots werden auf diesem Stand mit demselben Test bestätigt;
 * sie dürfen nicht aus dem aktuellen Produkt neu aufgezeichnet werden.
 */
describe('AP-13 Bestandsschutz · Betriebskunde ohne Messfunktion', () => {
  const ort = { art: 'standort', standortId: FIXTURE_IDS.st1 } as const;

  for (const gebaeudeZahl of [0, 3]) {
    const modell: EbenenLesemodell = {
      standorte: [werkAhrenberg({ gebaeudeZahl })],
      funktionen: ahrenbergFunktionen({ messen: 'bestand' }),
      kennzahlen: [],
    };

    it(`O18 · zwei Anlagen, ${gebaeudeZahl} Gebäude: keine Telefon-Kachel`, () => {
      expect(modell.funktionen?.standorte[0].messen.zustand).toBe('kein_objekt');
      expect(ebenenLeiste(ort, modell)).toMatchSnapshot();
    });

    it(`Q2 · zwei Anlagen, ${gebaeudeZahl} Gebäude: Standort-Reiter zeichengleich`, () => {
      const html = renderToStaticMarkup(
        <EbenenTabs
          reiter={ebenenReiter(ort, modell)}
          aktiv="uebersicht"
          label="Reiter des Standorts Werk Ahrenberg"
          onOpen={() => undefined}
        />,
      );
      expect(html).toMatchSnapshot();
    });
  }
});

describe('AP-13 Bestandsschutz · Navigation und Start-Ebene', () => {
  it('die in jsdom gestubbten Diagramme bleiben im Quelltext bytegleich zum Bezugsstand', () => {
    for (const [datei, hash] of Object.entries(diagramme.dateien)) {
      expect(createHash('sha256').update(readFileSync(resolve('src', datei))).digest('hex'), datei).toBe(hash);
    }
  });
  it('sechs Verlauf-Reiter ohne neue Energiebilanz', () => {
    const surface = anlageSurface({
      signals: { hasStorage: true, hasPv: true, hasControllableConsumer: true, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: true },
      config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: 95 },
      entities: [{ id: 'speicher', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } }],
    });
    const verlauf = anlageBereiche(surface).find((b) => b.key === 'verlauf');
    expect(verlauf?.tabs).toHaveLength(6);
    expect(verlauf).toMatchSnapshot();
  });

  it.each(['portfolio', 'portfolio-messwerte', 'portfolio-erloese'] as const)('Portfolio-Reiter %s ohne Messfunktion', (page) => {
    expect(renderToStaticMarkup(<PortfolioTabs page={page} showErloese fleetLabel="Meine Anlagen" onNavigate={() => {}} />)).toMatchSnapshot();
  });

  it('startEbene bleibt für Bestand, Einzelanlage, Standort, Unternehmen, Betreiber und Admin unverändert', () => {
    const daten = [null, bestandEineAnlage(), bestandZweiAnlagen(), ahrenbergHeute()];
    const bilder = daten.flatMap((liste) => {
      const orte = liste ? orteAus(liste, ahrenbergUnternehmen()) : null;
      return [[], [FIXTURE_IDS.an1], [FIXTURE_IDS.an1, FIXTURE_IDS.an2], [FIXTURE_IDS.an1, FIXTURE_IDS.an2, FIXTURE_IDS.an3]].flatMap((siteIds) =>
        (['endkunde', 'betreiber'] as const).flatMap((betriebsart) => [false, true].map((isAdmin) => ({
          siteIds, betriebsart, isAdmin, ebene: startEbene({ siteIds, betriebsart, isAdmin, orte }),
        }))),
      );
    });
    expect(bilder).toMatchSnapshot();
  });
});
