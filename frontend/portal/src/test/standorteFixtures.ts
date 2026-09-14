import type { StandortAmStichtag, StandorteAmStichtag, Unternehmen } from '../api';

/**
 * Antworten von `GET /api/v1/standorte` und `GET /api/v1/unternehmen` für den
 * Standort-Dialog und die Liste „Standorte“ (UEMS AP-02 IP-6) — NUR aus dem
 * Referenzunternehmen `docs/contracts/v2/uems-referenzunternehmen.json`:
 *
 * - `ahrenbergHeute` — Momentaufnahme 20.10.2026: ST-1 Werk Ahrenberg (G-1…G-3,
 *   B-1…B-5, AN-1 + AN-2, 8 450 m² eigene Fläche) und ST-2 Werk Lindach (G-4, G-5,
 *   B-6, B-7, AN-3, keine eigene Fläche → 2 600 m² aus Gebäuden summiert).
 * - `bestandEineAnlage` — Abnahme A5: die Bestandsanlage AN-1 bekommt ihren
 *   Standort automatisch, Name = Anlagenname, Entwurf „es fehlt: Adresse“.
 * - `bestandZweiAnlagen` — Abnahme A6 (Bestandsvariante des Konzepts): Halle 1
 *   und Halle 2 als zwei Anlagen, noch kein Standort → „Noch nicht zugeordnet“.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

const ID = {
  st1: '5a1d0000-0000-4000-8000-000000000001',
  st2: '5a1d0000-0000-4000-8000-000000000002',
  an1: 'a0000000-0000-4000-8000-000000000001',
  an2: 'a0000000-0000-4000-8000-000000000002',
  an3: 'a0000000-0000-4000-8000-000000000003',
  u: '00000000-0000-4000-8000-00000000000a',
} as const;

export const FIXTURE_IDS = ID;

export function ahrenbergUnternehmen(over: Partial<Unternehmen> = {}): Unternehmen {
  return {
    zustand: 'angelegt',
    id: ID.u,
    name: 'Kunststoffwerk Ahrenberg GmbH',
    kurzname: 'Ahrenberg',
    zeitzone: 'Europe/Berlin',
    standortZahl: 2,
    anlagenZahl: 3,
    nochNichtZugeordnetZahl: 0,
    sitz: { strasse: 'Gewerbering 7', plz: null, ort: 'Ahrenberg', land: 'DE' },
    rechtsform: 'GmbH',
    ...over,
  };
}

export function werkAhrenberg(over: Partial<StandortAmStichtag> = {}): StandortAmStichtag {
  return {
    id: ID.st1,
    kurzzeichen: 'ST-1',
    name: 'Werk Ahrenberg',
    adresse: { strasse: 'Gewerbering 7', plz: null, ort: 'Ahrenberg', land: 'DE' },
    zeitzone: 'Europe/Berlin',
    zustand: 'aktiv',
    esFehlt: [],
    bestand: 'vorhanden',
    bestandText: null,
    anlagen: [
      { id: ID.an1, name: 'Werk Ahrenberg – Halle 1', gueltigAb: '2024-03-12', gueltigBis: null },
      { id: ID.an2, name: 'Werk Ahrenberg – Halle 2', gueltigAb: '2026-10-01', gueltigBis: null },
    ],
    anlagenZahl: 2,
    gebaeudeZahl: 3,
    bereichZahl: 5,
    flaecheM2: 8450,
    flaecheQuelle: 'eigen',
    nutzung: ['produktion', 'buero'],
    notiz: 'Zwei Netzanschlüsse (NA-1, NA-2)',
    lage: { breitengrad: 48.25, laengengrad: 11.43 },
    archiviertAm: null,
    ...over,
  };
}

export function werkLindach(over: Partial<StandortAmStichtag> = {}): StandortAmStichtag {
  return {
    id: ID.st2,
    kurzzeichen: 'ST-2',
    name: 'Werk Lindach',
    adresse: { strasse: 'Am Bahndamm 12', plz: null, ort: 'Lindach', land: 'DE' },
    zeitzone: 'Europe/Berlin',
    zustand: 'aktiv',
    esFehlt: [],
    bestand: 'vorhanden',
    bestandText: null,
    anlagen: [{ id: ID.an3, name: 'Werk Lindach', gueltigAb: '2026-10-15', gueltigBis: null }],
    anlagenZahl: 1,
    gebaeudeZahl: 2,
    bereichZahl: 2,
    flaecheM2: 2600,
    flaecheQuelle: 'aus_gebaeuden_summiert',
    nutzung: ['lager', 'logistik', 'montage'],
    notiz: null,
    lage: null,
    archiviertAm: null,
    ...over,
  };
}

export function ahrenbergHeute(): StandorteAmStichtag {
  return {
    stichtag: '2026-10-20',
    standorte: [werkAhrenberg(), werkLindach()],
    nichtGezeigt: [],
    nochNichtZugeordnet: null,
  };
}

/** A5: der automatisch angelegte Standort der Bestandsanlage AN-1 — Entwurf ohne Adresse. */
export function halle1Entwurf(): StandortAmStichtag {
  return werkAhrenberg({
    name: 'Werk Ahrenberg – Halle 1',
    adresse: null,
    zustand: 'entwurf',
    esFehlt: ['adresse'],
    anlagen: [{ id: ID.an1, name: 'Werk Ahrenberg – Halle 1', gueltigAb: '2024-03-12', gueltigBis: null }],
    anlagenZahl: 1,
    gebaeudeZahl: 0,
    bereichZahl: 0,
    flaecheM2: null,
    flaecheQuelle: null,
    nutzung: null,
    notiz: null,
    lage: null,
  });
}

export function bestandEineAnlage(): StandorteAmStichtag {
  return { stichtag: '2026-09-20', standorte: [halle1Entwurf()], nichtGezeigt: [], nochNichtZugeordnet: null };
}

export function bestandZweiAnlagen(): StandorteAmStichtag {
  return {
    stichtag: '2026-09-20',
    standorte: [],
    nichtGezeigt: [],
    nochNichtZugeordnet: {
      anlagenZahl: 2,
      anlagen: [
        { id: ID.an2, name: 'Werk Ahrenberg – Halle 2' },
        { id: ID.an1, name: 'Werk Ahrenberg – Halle 1' },
      ],
    },
  };
}
