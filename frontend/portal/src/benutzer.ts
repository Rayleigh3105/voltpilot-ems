import { ApiError, request } from './api';

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
export interface BenutzerAngelegt { benutzer: BenutzerKonto; startpasswort: string }

// Nur der aufrufende Dialog hält diese Antwort bis zum Schließen. Kein Cache und kein Speicher.
export const benutzerApi = {
  anlegen: (anlage: BenutzerAnlage) => request<BenutzerAngelegt>('/api/v1/benutzer', {
    method: 'POST', body: JSON.stringify(anlage),
  }),
  startpasswort: (sub: string) => request<BenutzerAngelegt>(`/api/v1/benutzer/${encodeURIComponent(sub)}/startpasswort`, {
    method: 'POST',
  }),
};

export function benutzerFehler(fehler: unknown): string {
  if (fehler instanceof ApiError) {
    if (fehler.status === 409) return 'Benutzername oder E-Mail-Adresse ist bereits vergeben.';
    if (fehler.status === 403) return 'Nur der Kundenadministrator kann ein Startpasswort vergeben.';
    if (fehler.status === 404) return 'Dieser Benutzer oder Standort ist nicht mehr verfügbar.';
    if (fehler.status === 400) return 'Die Angaben oder Passwortregeln erlauben die Anlage nicht. Bitte prüfen Sie die Angaben oder wenden Sie sich an VoltPilot.';
  }
  return 'Das Startpasswort konnte nicht vergeben werden. Bitte versuchen Sie es erneut.';
}
