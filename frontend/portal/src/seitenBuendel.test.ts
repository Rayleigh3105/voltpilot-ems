import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORTAL_ROOT, statischErreichbar } from './test/statischErreichbar';

/**
 * Was die KUNDENSEITEN beim Aufruf nicht mitladen (Performance-Runde vp-perf-portal-reaktiv, 13.11.2026).
 *
 * Jede Zeile hier ist ein Dialog oder Diagramm, das erst auf Klick aufgeht, aber über einen statischen Import im
 * Stück der Seite lag - also bei jedem Aufruf übers Netz kam und geparst wurde, bevor die Seite stand. Am Telefon
 * (gedrosselte CPU, 4G) ist das die Wartezeit, die der Kunde spürt. Der Bruder für das Einstiegs-Bündel ist
 * `einstiegLuft.test.ts`, die Gegenprobe am echten Artefakt `test/bundle-smoke.sh`.
 *
 * Nur STATISCHE Wertimporte zählen: `import()` (über die `…Lazy`-Hüllen) ist die Grenze, `import type` wird vom
 * Bauen gelöscht.
 */
const SEITEN: Record<string, Record<string, string>> = {
  // Übersicht / Kundenübersicht (Portfolio, Ebenen-Cockpit)
  'src/components/EbenenCockpit.tsx': {
    'src/components/AnlageAnlegenDrawer.tsx': 'Anlage anlegen öffnet auf Klick (`AnlageAnlegenDrawerLazy`); zog Leaflet mit',
    'src/components/LocationMap.tsx': 'die Karte gehört allein zum Anlege-Assistenten',
    'src/components/SteuernAssistent.tsx': '„Steuern einrichten“ öffnet auf Klick (`SteuernAssistentLazy`)',
  },
  'src/components/PortfolioCockpit.tsx': {
    'src/components/AnlageAnlegenDrawer.tsx': 'Anlage anlegen öffnet auf Klick (`AnlageAnlegenDrawerLazy`)',
  },
  'src/pages/UebersichtPage.tsx': {
    'src/components/AnlageAnlegenDrawer.tsx': 'Anlage anlegen öffnet auf Klick (`AnlageAnlegenDrawerLazy`)',
  },
  // Geräte-Detailseite
  'src/pages/GeraetSeiteSection.tsx': {
    'src/useEChart.ts': 'das einzige Diagramm ist der Verlauf eines beobachteten Messwerts (`MesswertVerlaufChart.tsx`)',
    'src/components/AnlegenFlow.tsx': 'Bearbeiten öffnet auf Klick (`AnlegenFlowLazy`)',
    'src/boxDialoge.ts': '„Zuständige Box wechseln“ öffnet auf Klick (`DatenquelleWechselDialogLazy`)',
  },
  'src/pages/GatewaySeiteSection.tsx': {
    'src/boxDialoge.ts': '„Zuständige Box wechseln“ öffnet auf Klick (`DatenquelleWechselDialogLazy`)',
  },
  // Anlage › Aufbau (Gerätebaum)
  'src/pages/AufbauSection.tsx': {
    'src/components/AnlegenFlow.tsx': 'Hinzufügen öffnet auf Klick (`AnlegenFlowLazy`, im Leerlauf vorgeladen)',
  },
  // Steuerung › Geräte
  'src/steuerung/SteuerungSeite.tsx': {
    'src/components/SteuernAssistent.tsx': '„Steuern einrichten“ öffnet auf Klick (`SteuernAssistentLazy`)',
  },
};

describe('Seiten-Bündel · was eine Kundenseite beim Aufruf nicht mitlädt', () => {
  for (const [seite, verboten] of Object.entries(SEITEN)) {
    const weg = statischErreichbar(seite);
    it(`${seite}: der Lauf hat die Seite wirklich gelesen (nicht vakuum)`, () => {
      expect(weg.size).toBeGreaterThan(20);
    });
    for (const [stueck, grund] of Object.entries(verboten)) {
      it(`${seite} lädt ${stueck} nicht statisch`, () => {
        const datei = resolve(PORTAL_ROOT, stueck);
        expect(
          weg.has(datei),
          `${stueck} liegt wieder im Stück von ${seite} (${grund}). Importiert von ${relative(PORTAL_ROOT, weg.get(datei) ?? '')}.`,
        ).toBe(false);
      });
    }
  }

  it('die Hüllen laden ihr Stück wirklich nach (die Gegenprobe des Wächters: ohne sie wäre jeder Fall oben grün)', () => {
    for (const [huelle, ziel] of [
      ['src/components/AnlageAnlegenDrawerLazy.tsx', 'src/components/AnlageAnlegenDrawer.tsx'],
      ['src/components/AnlegenFlowLazy.tsx', 'src/components/AnlegenFlow.tsx'],
      ['src/components/SteuernAssistentLazy.tsx', 'src/components/SteuernAssistent.tsx'],
      ['src/components/DatenquelleWechselDialogLazy.tsx', 'src/boxDialoge.ts'],
      ['src/components/BeobachteteRegister.tsx', 'src/useEChart.ts'],
    ]) {
      expect(statischErreichbar(huelle).has(resolve(PORTAL_ROOT, ziel)), `${huelle} → ${ziel}`).toBe(false);
    }
    // Ohne Hülle wäre das Stück da: das Diagramm-Modul selbst zieht die Bibliothek.
    expect(statischErreichbar('src/components/MesswertVerlaufChart.tsx').has(resolve(PORTAL_ROOT, 'src/useEChart.ts'))).toBe(true);
  });

  /**
   * Die Stile wandern NICHT mit. `KomponenteAssistent.css` (`vp-assist-*`) und `DatenquelleAnlegen.css` (`vp-dqa-*`)
   * brauchen auch Flächen, die auf der Seite bleiben (Fehlerzeilen, Schalt-Freigabe, Selbstbau, Box-Dialoge); bis zum
   * Nachladen kamen sie nur nebenbei mit dem Geräte-Assistenten bzw. „Zuständige Box wechseln“. Jede Seite, die sie vorher
   * hatte, trägt sie weiter selbst - sonst sähe die Seite anders aus, bis jemand den Dialog einmal öffnet.
   */
  for (const [seite, stile] of [
    ['src/pages/AufbauSection.tsx', ['src/components/KomponenteAssistent.css']],
    ['src/pages/StandortAufbauPage.tsx', ['src/components/KomponenteAssistent.css']],
    ['src/pages/GeraetSeiteSection.tsx', ['src/components/KomponenteAssistent.css', 'src/components/DatenquelleAnlegen.css']],
    ['src/pages/GatewaySeiteSection.tsx', ['src/components/DatenquelleAnlegen.css']],
  ] as const) {
    it(`${seite} lädt seine Stile weiter selbst: ${stile.join(', ')}`, () => {
      const weg = statischErreichbar(seite);
      for (const stil of stile) expect(weg.has(resolve(PORTAL_ROOT, stil)), `${seite} → ${stil}`).toBe(true);
    });
  }
});
