import { ApiError, request } from './api';
import { grundUndWeg } from './rollen';
import matrixDatei from './rechte-matrix.json';
import { darf, matrixAus, type Aktion, type Rolle } from './rechte';

export interface BenutzerAnlage {
  username: string;
  email: string;
  vorname?: string;
  nachname?: string;
  rolle: string;
  standorte: string[];
}
export interface BenutzerKonto {
  sub: string;
  anzeigename: string;
  email: string;
  zustand: 'angelegt' | 'aktiv' | 'gesperrt' | 'entfernt';
}
export interface BenutzerZuweisung { id: string; rolle: Rolle; standort_id: string | null; standort_name: string | null; gueltig_ab: string; gueltig_bis: string | null }
export interface BenutzerEintrag extends BenutzerKonto { zuweisungen: BenutzerZuweisung[] }
export interface ZugriffProtokoll { id: number; zeit: string; betroffener: string; aktion: string; rolle: Rolle | null; standort: string | null; urheber: string; grund: string | null }
export interface BenutzerAngelegt { benutzer: BenutzerKonto; startpasswort: string }

// Nur der aufrufende Dialog hält diese Antwort bis zum Schließen. Kein Cache und kein Speicher.
export const benutzerApi = {
  liste: () => request<BenutzerEintrag[]>('/api/v1/benutzer'),
  protokoll: (von: string, bis: string) => request<ZugriffProtokoll[]>(`/api/v1/benutzer/protokoll?von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`),
  wechseln: (sub: string, bisher: string[], rolle: string, standorte: string[]) => request<void>(`/api/v1/benutzer/${encodeURIComponent(sub)}/zugriff`, {
    method: 'PUT', body: JSON.stringify({ bisher, rolle, standorte }),
  }),
  entziehen: (id: string) => request<void>(`/api/v1/zugriff/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sperren: (sub: string) => request<void>(`/api/v1/benutzer/${encodeURIComponent(sub)}/sperren`, { method: 'POST' }),
  entfernen: (sub: string) => request<void>(`/api/v1/benutzer/${encodeURIComponent(sub)}`, { method: 'DELETE' }),
  anlegen: (anlage: BenutzerAnlage) => request<BenutzerAngelegt>('/api/v1/benutzer', {
    method: 'POST', body: JSON.stringify(anlage),
  }),
  startpasswort: (sub: string) => request<BenutzerAngelegt>(`/api/v1/benutzer/${encodeURIComponent(sub)}/startpasswort`, {
    method: 'POST',
  }),
};

export function benutzerFehler(fehler: unknown, fallback = 'Das Startpasswort konnte nicht vergeben werden. Bitte versuchen Sie es erneut.'): string {
  if (fehler instanceof ApiError) {
    const body = fehler.body as { code?: string; message?: string } | undefined;
    if (body?.code === 'letzter_kundenadministrator') return body.message ?? 'Das Unternehmen braucht mindestens einen Kundenadministrator. Ernennen Sie zuerst eine weitere Person.';
    if (body?.code === 'zuweisung_vorhanden') return 'Diese Rolle ist für den gewählten Geltungsbereich bereits zugewiesen. Ändern Sie den vorhandenen Eintrag.';
    if (body?.code === 'eigene_zuweisung') return 'Ihre eigenen Rechte kann nur ein weiterer Kundenadministrator ändern.';
    if (body?.code === 'email_fremder_kundenbereich') return 'Diese E-Mail-Adresse ist bereits einem anderen Kundenbereich zugeordnet. Als Unterstützung gewähren?';
    if (fehler.status === 422) return 'Bitte wählen Sie mindestens einen Standort.';
    if (fehler.status === 409) return 'Benutzername oder E-Mail-Adresse ist bereits vergeben.';
    if (fehler.status === 403) return grundUndWeg();
    if (fehler.status === 404) return 'Dieser Benutzer oder Standort ist nicht mehr verfügbar.';
    if (fehler.status === 400) return 'Die Angaben oder Passwortregeln erlauben die Anlage nicht. Bitte prüfen Sie die Angaben oder wenden Sie sich an VoltPilot.';
  }
  return fallback;
}

export const KUNDENROLLEN = matrixDatei.rollen.filter(r => r.zuweisbar).map(r => ({
  value: r.kennung, label: r.kundenwort, unternehmensweit: r.geltungsbereich === 'unternehmen',
}));
export function unternehmensrolle(rolle: string) { return KUNDENROLLEN.some(r => r.value === rolle && r.unternehmensweit); }
const matrix = matrixAus(matrixDatei as { aktionen: Aktion[] });
/** Nur Vorschau: die Entscheidung fällt im Vertragszwilling, nie in einer Rollenrechnung der Oberfläche. */
export function rechteVorschau(rolle: Rolle, standorte: string[]) {
  const jetzt = '2026-01-01T00:00:00Z';
  const uw = unternehmensrolle(rolle);
  const ids = uw ? ['vorschau'] : standorte;
  const benutzer = { kennung: 'vorschau', name: '', konto: 'benutzer' as const, zustand: 'aktiv' as const,
    zuweisungen: [{ rolle, standorte: uw ? null : ids, umfang: null, art: null, gueltigAb: jetzt, gueltigBis: null, beendetAm: null }] };
  const k = { name: '', standorte: ids.map(id => ({ kennzeichen: id, name: id })), kundenadministratoren: [] };
  return [...matrix.values()].filter(a => !['konto.eigenes'].includes(a.kennung) && KUNDENROLLEN.some(r => a.zellen[r.value as Rolle] !== '-')).map(a => ({
    text: a.kundenwort, erlaubt: darf(matrix, benutzer, k, a.kennung,
      { standort: uw ? null : ids[0] ?? null, anlage: null, stichtag: null }, jetzt).darf,
  }));
}
