import type { Unterstuetzung, UnterstuetzungAnfrage } from '../api';
import { STANDORT_IDS } from './rollenFixtures';
export function unterstuetzungFixture(): Unterstuetzung {
  return { id: '11111111-1111-4111-8111-111111111111', art: 'installateur', umfang: 'einrichten_und_bedienen',
    standorte: [STANDORT_IDS['ST-1']], standort_kennzeichen: ['ST-1'], unterstuetzer: { kennung: 'TB', name: 'Elektro Brunner' },
    gueltig_ab: '2026-10-20T08:00:00Z', gueltig_bis: '2026-12-15', endet: '2026-12-15T23:00:00Z', zustand: 'aktiv', erinnerung: false,
    grund: 'Ladepunkt Halle 2 einrichten', banner: 'Elektro Brunner (Installateur) hat Zugriff auf Werk Ahrenberg bis 15.12.2026 — Einrichten und Bedienen', text: null, startpasswort: null };
}
export function anfrageFixture(): UnterstuetzungAnfrage {
  return { id: '22222222-2222-4222-8222-222222222222', art: 'voltpilot', umfang: 'ansehen', standorte: [STANDORT_IDS['ST-1']],
    angefragt_von: { kennung: 'LV', name: 'Lena Voß' }, gueltig_ab: '2026-10-20T08:00:00Z', gueltig_bis: '2026-10-28', grund: 'Verbindung prüfen', zustand: 'offen', entschieden_am: null, unterstuetzung: null, angefragt_am: '2026-10-20T08:00:00Z' };
}
export function notfallFixture(): Unterstuetzung {
  return { ...unterstuetzungFixture(), id: '33333333-3333-4333-8333-333333333333', art: 'notfall',
    unterstuetzer: { kennung: 'LV', name: 'Lena Voß' }, gueltig_bis: null, endet: '2026-10-21T08:00:00Z',
    grund: 'Wechselrichter meldet Fehler F42', banner: 'VoltPilot-Support hat Notfall-Zugriff auf Werk Ahrenberg bis 21.10.2026 10:00 — Grund: Wechselrichter meldet Fehler F42' };
}
