import { act } from '@testing-library/react';
import type { Device, Site, SiteEntities } from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Gemeinsame Bausteine der Tests am Anlege-Fluss (`AnlageFlow`) für den Modus
 * „nur messen" und seinen Bestandsschutz. Namen und Kennungen aus dem
 * Referenzunternehmen Ahrenberg; nur für Tests, nie ins Produktionsbündel.
 */

/** Die neue Anlage, wie `POST /api/v1/sites` sie zurückgibt. */
export const neueAnlage: Site = {
  id: 's-neu',
  name: 'Halle 3',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

/** Werk Lindach (AN-3) als bestehende Anlage — der Wiedereinstieg des Assistenten. */
export const anlageLindach: Site = { ...neueAnlage, id: FIXTURE_IDS.an3, name: 'Werk Lindach' };

/** Die verbundene Box. */
export const neueBox: Device = {
  id: 'd-neu',
  siteId: 's-neu',
  externalRef: 'VP-DEMO-0001',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: null,
  createdAt: '2026-10-20T08:15:30Z',
};

export const leereKomponenten: SiteEntities = {
  registry: null,
  entities: [],
  localSetup: [],
  staleOnDevice: [],
};

/**
 * React zählt `useId` über ALLE Tests einer Datei — die Nummer sagt etwas über die
 * Reihenfolge, nicht über die Fläche. In der Reihenfolge des Auftretens ersetzt.
 */
export function ohneReactIds(html: string): string {
  const ids = new Map<string, string>();
  return html.replace(/:r[0-9a-z]+:/g, (id) => {
    if (!ids.has(id)) ids.set(id, `:id${ids.size + 1}:`);
    return ids.get(id)!;
  });
}

/** Lässt ausstehende Abrufe (Standorte, Funktionen) sich setzen. */
export async function ruhe() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Die ganze Fläche des Flusses — Schrittleiste, Hilfe und Schritt. */
export function flussHtml(): string {
  return ohneReactIds(document.querySelector('.vp-anlage-flow')!.outerHTML);
}
