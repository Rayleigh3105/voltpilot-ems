import { fmtNum } from './format';
import {
  componentActions,
  type ComponentRole,
  type PlantComponent,
} from './komponenten';
import type { SiteEntity } from './api';

/**
 * Die REINE Ableitung der Geräteseiten-Gefahrenzone (Konzept
 * `vp-loeschen-konzept-l3`, Captain-Entscheide E1-E4). Sie sagt der Fläche NUR,
 * was sie anbieten darf und welche Folgen die Löschung wirklich hat - das
 * Rendern (Karte, Rückfrage, Bottom-Sheet) macht {@code GeraetGefahrenzone.tsx}.
 *
 * Warum ein eigenes Modul neben {@link deleteConsequences} (der „Ihre
 * Geräte"-Liste): jene Rückfrage zählt auf, was VERSCHWINDET; die Geräteseite
 * trägt die EHRLICHE Trennung „was bleibt / was geht" (E4). Ein aufgezeichneter
 * Messwert bleibt (E3 - „Ehrlichkeit der Zahlen"), nur die Live-Sicht endet.
 */

/**
 * Eine Folge der Löschung, nach ihrer Richtung sortiert:
 *  - {@code keep}: bleibt erhalten (grün, ✓) - die Wahrheit der Zahlen,
 *  - {@code gone}: endet (rot, ✕) - Live-Messung, Steuerung, der Lese-Pin,
 *  - {@code info}: eine sachliche Folge (blau, i) - der Fahrplan rechnet neu.
 */
export type FolgeArt = 'keep' | 'gone' | 'info';

export interface EntfernenFolge {
  art: FolgeArt;
  text: string;
}

/** Das Kundenwort für die Rolle, wie es im „plant ohne …"-Satz erscheint. */
const ROLLE_WORT: Record<ComponentRole, string> = {
  pv: 'diesen Erzeuger',
  storage: 'diesen Speicher',
  grid: 'diesen Zähler',
  house: 'diesen Verbrauch',
  consumer: 'diesen Verbraucher',
};

/**
 * Die Folgen, wenn eine KUNDEN-Komponente (Erzeuger, Zähler, Verbraucher) von
 * der Geräteseite entfernt wird. Aufgezeichnete Werte bleiben (E3); die
 * Live-Messung endet; der Pin wird frei, sofern es einen gab; der Fahrplan
 * rechnet ohne sie; und eine hinterlegte kWp-Nennleistung verlässt die
 * Gesamtleistung der Anlage (der `deleteConsequences`-kWp-Hinweis, hier als
 * eigene Zeile).
 */
export function komponenteEntfernenFolgen(
  component: PlantComponent,
  entity: SiteEntity | undefined,
  /**
   * Trägt dieses Gerät die PV-Produktion der Anlage (eine Rollen-Zuordnung,
   * Konzept vp-agg-konzept3-r8)? Dann verschwindet sein Beitrag zur Gesamt-PV -
   * eine ehrliche Folge, die genannt gehört, nie stillschweigend.
   */
  pvZugeordnet = false,
): EntfernenFolge[] {
  const folgen: EntfernenFolge[] = [
    {
      art: 'keep',
      text: 'Aufgezeichnete Messwerte bleiben - Ihre Historie und Erlöse dieses Geräts '
        + 'bleiben im Verlauf sichtbar.',
    },
    {
      art: 'gone',
      text: 'Live-Messung endet - im Cockpit und im Energiefluss erscheint kein aktueller '
        + 'Wert mehr.',
    },
  ];
  if (entity?.edgeSourceId != null) {
    folgen.push({
      art: 'gone',
      text: 'Die Box vergisst dieses Gerät - die Datenquelle wird aus dem Leseplan genommen '
        + 'und erscheint danach wieder als „Neues Gerät gefunden“.',
    });
  }
  if (pvZugeordnet) {
    folgen.push({
      art: 'gone',
      text: 'Dieses Gerät zählt nicht mehr zur PV-Produktion Ihrer Anlage - der ihm '
        + 'zugeordnete Summenwert entfällt aus der Gesamt-PV.',
    });
  }
  folgen.push({
    art: 'info',
    text: `Der Fahrplan rechnet neu - der nächste 15-Minuten-Lauf plant ohne `
      + `${ROLLE_WORT[component.role]}.`,
  });
  const kwp = entity?.capacityKwp;
  if (kwp != null && kwp !== 0) {
    folgen.push({
      art: 'info',
      text: `Die hinterlegten ${fmtNum(kwp, 'kWp')} werden von der Gesamtleistung Ihrer `
        + 'Anlage abgezogen.',
    });
  }
  return folgen;
}

/**
 * Die Folgen von „Batterie am Standort abmelden" (E1). Der eine belegbare Satz
 * zur Batterie ist der letzte: die Optimierung plant ohne den Speicher - genau
 * das ist der eigentliche Fix, weil der Optimierer die Batterie aus den
 * Stammdaten liest und sonst eine Phantom-Batterie weiterplant.
 */
export function batterieAbmeldenFolgen(): EntfernenFolge[] {
  return [
    {
      art: 'keep',
      text: 'Aufgezeichnete Messwerte bleiben - Ihre Historie und Erlöse bleiben im Verlauf '
        + 'sichtbar.',
    },
    {
      art: 'gone',
      text: 'Live-Messung und Steuerung enden - im Cockpit erscheint kein aktueller '
        + 'Speicher-Wert mehr.',
    },
    {
      art: 'info',
      text: 'Die Optimierung plant ohne diesen Speicher.',
    },
  ];
}

/**
 * Der Zustand der Gefahrenzone einer Geräteseite - eine der vier Formen, nie
 * ein toter Knopf (E4, Hausregel „ein Knopf, der nichts bewirken kann, wird
 * nicht angeboten"):
 *  - {@code entfernen}: eine Kunden-Komponente, die wirklich löschbar ist,
 *  - {@code batterie}: der geschützte {@code battery-hybrid} - kein direktes
 *    Löschen, sondern der Weg „Batterie am Standort abmelden" (E1),
 *  - {@code geschuetzt}: eine plattform-eigene Grundausstattung ohne neuen Weg
 *    (Hausverbrauch, synthetisierter Zähler) - nur der Grund,
 *  - {@code null}: nichts anzubieten (mehrdeutiges oder leeres Gerät).
 */
export type GefahrenzoneZustand =
  | { kind: 'entfernen'; component: PlantComponent; entity: SiteEntity; folgen: EntfernenFolge[] }
  | { kind: 'batterie'; component: PlantComponent; folgen: EntfernenFolge[] }
  | { kind: 'geschuetzt'; grund: string }
  | null;

/** Der eine Satz, warum eine geschützte Grundausstattung hier nicht weggeht. */
const GRUND_GRUNDAUSSTATTUNG =
  'Diese Komponente richtet VoltPilot aus den Daten Ihrer Anlage ein - sie gehört '
  + 'zur Grundausstattung und lässt sich hier nicht einzeln entfernen.';

/**
 * Was die Gefahrenzone dieser Geräteseite anbietet. {@code komponenten} sind
 * die Komponenten DES Geräts (aus `plantModel`), {@code entityOf} löst ihre v2-
 * Entität auf.
 *
 * <p>Die Batterie hat kein eigenes Geräteblatt - sie ist der Speicher-Teil des
 * Hybrid-Wechselrichters. Trägt das Gerät also eine {@code battery-hybrid}-
 * Komponente, ist DAS der Fall (der Weg „am Standort abmelden"), selbst wenn das
 * Gateway daneben Netz und Haus misst. Sonst wird nur eine EINDEUTIGE
 * Haupt-Komponente behandelt: bei mehreren gäbe es keine klare eine Aktion.
 */
export function gefahrenzone(
  komponenten: PlantComponent[],
  entityOf: (entityId: string) => SiteEntity | undefined,
  /** Trägt dieses Gerät die PV-Produktion der Anlage? (vp-agg-konzept3-r8) */
  pvZugeordnet = false,
): GefahrenzoneZustand {
  const mains = komponenten.filter((c) => c.aspect === 'main');
  const battery = mains.find((c) => entityOf(c.entityId)?.entityType === 'battery-hybrid');
  if (battery) {
    return { kind: 'batterie', component: battery, folgen: batterieAbmeldenFolgen() };
  }
  if (mains.length !== 1) return null;
  const component = mains[0];
  const entity = entityOf(component.entityId);
  if (entity == null) return null;
  const { canDelete } = componentActions(component, entity);
  if (canDelete) {
    return {
      kind: 'entfernen',
      component,
      entity,
      folgen: komponenteEntfernenFolgen(component, entity, pvZugeordnet),
    };
  }
  // Not deletable and not the battery path (house-load / a synthesized meter):
  // show the reason, never a disabled button.
  return { kind: 'geschuetzt', grund: GRUND_GRUNDAUSSTATTUNG };
}
