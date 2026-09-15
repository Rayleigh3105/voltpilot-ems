import type { FunktionAnlage, FunktionMessen, FunktionStandort, Funktionen } from '../api';
import { messen as messenRegel } from '../uemsFunktion';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/funktionen` für die Unternehmens- und die
 * Standort-Übersicht (UEMS AP-01 IP-6) — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json`, Momentaufnahme 20.10.2026:
 *
 * - Halle 1 (AN-1) steuert: Lastspitzenkappung seit 02.05.2024, beim Umstieg
 *   übernommen. Halle 2 (AN-2) und Werk Lindach (AN-3) messen nur — der
 *   Ladepunkt von Halle 2 wird erst ab 01.12.2026 gesteuert (Referenzfall 5).
 * - `messen: 'eingerichtet'` — Abnahme A7: „Messen & Auswerten" läuft an beiden
 *   Standorten (Werk Ahrenberg 13, Werk Lindach 3 Messstellen liefern Daten).
 * - `messen: 'bestand'` — Abnahme A11: nach dem Umstieg hat Messen noch kein
 *   Objekt („noch nicht eingerichtet").
 *
 * Die Sätze sind Zeichen für Zeichen die der Regel `uemsFunktion` (Server-Zwilling
 * `FunktionZustandAbleitung`). Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

const HALLE1: FunktionAnlage = {
  id: FIXTURE_IDS.an1,
  name: 'Werk Ahrenberg – Halle 1',
  teilnahme: {
    zustand: 'aktiv',
    seit: '2024-05-02T00:00:00+02:00',
    text: 'Gestartet am 02.05.2024 (übernommen)',
    uebernommen: true,
    pruefliste: [],
    fehlt: [],
    wege: [],
    aktionen: ['anhalten', 'beenden'],
  },
};

function misstNur(id: string, name: string): FunktionAnlage {
  return {
    id,
    name,
    teilnahme: {
      zustand: 'kein_objekt',
      seit: null,
      text: 'Diese Anlage misst nur',
      uebernommen: false,
      pruefliste: [],
      fehlt: [],
      wege: [],
      aktionen: ['aufnehmen'],
    },
  };
}

function messen(art: 'eingerichtet' | 'bestand', seit: string, text: string, messstellen: number): FunktionMessen {
  if (art === 'bestand') {
    return {
      zustand: 'kein_objekt',
      seit: null,
      text: 'Messen & Auswerten — noch nicht eingerichtet',
      fehlt: [],
      datenlage: null,
    };
  }
  return {
    zustand: 'aktiv',
    seit,
    text,
    fehlt: [],
    datenlage: `${messstellen} von ${messstellen} Messstellen liefern Daten`,
  };
}

export function funktionWerkAhrenberg(art: 'eingerichtet' | 'bestand' = 'eingerichtet'): FunktionStandort {
  return {
    id: FIXTURE_IDS.st1,
    kurzzeichen: 'ST-1',
    name: 'Werk Ahrenberg',
    zeitzone: 'Europe/Berlin',
    messen: messen(art, '2026-10-01T00:00:00+02:00', 'Eingerichtet am 01.10.2026', 13),
    steuern: {
      zustand: 'aktiv',
      seit: '2024-05-02T00:00:00+02:00',
      text: 'Läuft mit Werk Ahrenberg – Halle 1',
      fehlt: [],
      aktionen: ['anhalten', 'beenden'],
      anlagen: [HALLE1, misstNur(FIXTURE_IDS.an2, 'Werk Ahrenberg – Halle 2')],
    },
  };
}

export function funktionWerkLindach(art: 'eingerichtet' | 'bestand' = 'eingerichtet'): FunktionStandort {
  return {
    id: FIXTURE_IDS.st2,
    kurzzeichen: 'ST-2',
    name: 'Werk Lindach',
    zeitzone: 'Europe/Berlin',
    messen: messen(art, '2026-10-15T00:00:00+02:00', 'Eingerichtet am 15.10.2026', 3),
    steuern: {
      zustand: 'kein_objekt',
      seit: null,
      text: 'Steuern & Optimieren — noch nicht eingerichtet',
      fehlt: [],
      aktionen: ['einrichten'],
      anlagen: [misstNur(FIXTURE_IDS.an3, 'Werk Lindach')],
    },
  };
}

/**
 * „Messen & Auswerten" im Entwurf — der Standort nach Schritt 1 des Assistenten
 * (AP-01 IP-9a): die Funktion ist angelegt, Box und Messstellen fehlen noch.
 * Zustand und Satz aus der Regel `messen()`, nie abgeschrieben.
 */
export function funktionMessenEntwurf(fs: FunktionStandort): FunktionStandort {
  const m = messenRegel({
    standort: fs.name,
    angelegt: true,
    standortEingerichtet: true,
    standortArchiviertAm: null,
    eingerichtetAm: null,
    boxen: [],
    messstellen: [],
    anlagen: [],
    jetzt: '2026-10-20T08:15:30Z',
    zeitzone: fs.zeitzone,
  });
  return { ...fs, messen: { zustand: m.zustand, seit: m.seit, text: m.text, fehlt: m.fehlt, datenlage: m.datenlage } };
}

/** Die Antwort für die gewählten Standorte (Vorgabe: beide, Messen eingerichtet). */
export function ahrenbergFunktionen(
  opts: { standorte?: FunktionStandort[]; messen?: 'eingerichtet' | 'bestand' } = {},
): Funktionen {
  const art = opts.messen ?? 'eingerichtet';
  const standorte = opts.standorte ?? [funktionWerkAhrenberg(art), funktionWerkLindach(art)];
  const n = standorte.length;
  const messenAn = standorte.filter((s) => s.messen.zustand === 'aktiv').length;
  const steuernAn = standorte.filter((s) => s.steuern.zustand === 'aktiv').length;
  return {
    unternehmen: {
      messen: { laeuft_an: messenAn, standorte: n, text: `Messen & Auswerten läuft an ${messenAn} von ${n} Standorten` },
      steuern: { laeuft_an: steuernAn, standorte: n, text: `Steuern & Optimieren läuft an ${steuernAn} von ${n} Standorten` },
    },
    standorte,
  };
}
