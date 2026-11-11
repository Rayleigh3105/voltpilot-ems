import { request } from './api';
import type { Schwere } from './meldungenApi';

/**
 * „So erreichen wir Sie" (Einstellungen Scheibe 1, Konzept `vp-einstellungen-konzept-e1`) -
 * Zustellwege (E-Mail, Web-Push, Team-Kanal, Telegram), Ruhezeit und Stummschaltung. Eigenes, lazy
 * Modul: nur die Einstellungs-Seite (`pages/EinstellungenPage.tsx`) importiert es, genau wie
 * `ueberwachungApi.ts` für "Überwachen".
 */

/** Der eigene E-Mail-Zustellweg - `undefined`, solange keiner angelegt wurde (die API antwortet 204). */
export interface EmailZustellweg {
  ziel: string;
  bestaetigt: boolean;
  aktiv: boolean;
  abSchwere: Schwere;
  zusammenfassungAktiv: boolean;
  zusammenfassungUhrzeit: string;
}

/**
 * Ein Geräte-Abo für Web-Push ("Abo je Gerät", §7 Scheibe 3 Punkt 1). `endpoint` (Scheibe 2, Befund
 * M4) lässt das Portal "dieses Gerät" selbst erkennen - der Vergleich mit der eigenen
 * `PushSubscription` des Browsers (`push.ts`), nie der Server.
 */
export interface PushAbo {
  id: string;
  geraet: string;
  aktiv: boolean;
  abSchwere: Schwere;
  erstelltAm: string | null;
  endpoint: string | null;
}

/** Das Ergebnis von "Probe senden" (Entscheid 10A) - kein Fehlschlag wirft, die Fläche zeigt ihn an. */
export interface ProbeErgebnis {
  erfolgreich: boolean;
  fehler: string | null;
}

/** Ein Webhook-Ziel (Alerting Scheibe 6, §7 Scheibe 6) - ein Teams-Workflow oder Slack-Incoming-Webhook. */
export interface WebhookZiel {
  id: string;
  url: string;
  name: string;
  aktiv: boolean;
  abSchwere: Schwere;
  erstelltAm: string | null;
}

/** Das Geheimnis wird NUR in dieser Antwort gezeigt - danach nie wieder lesbar. */
export interface NeuesWebhookZiel {
  id: string;
  geheimnis: string;
}

/** Eine Telegram-Verbindung (Alerting Scheibe 6, §7 Scheibe 6) - offen (nur Token) oder bestätigt. */
export interface TelegramZiel {
  id: string;
  bestaetigt: boolean;
  aktiv: boolean;
  abSchwere: Schwere;
  erstelltAm: string | null;
}

/**
 * `verfuegbar`: ob diese Installation einen Telegram-Bot eingerichtet hat - nur dann baut die api
 * einen funktionierenden `t.me`-Link; das Portal rät das nicht selbst (Go-Live-Prüfung).
 */
export interface TelegramStatus {
  verfuegbar: boolean;
  ziele: TelegramZiel[];
}

/** Die eigene Ruhezeit (§6.4) - `regeln` ist das rohe JSON-Fenster (siehe `ruhezeit.ts`). */
export interface RuhezeitZustand {
  regeln: string;
  zeitzone: string;
  dringendDurch: boolean;
}

export interface Stummschaltung {
  id: string;
  auswahl: string;
  von: string;
  bis: string;
  grund: string | null;
  vonWem: string;
}

export const benachrichtigungenApi = {
  // ----------------------------------------------------------------- E-Mail (Scheibe 0, Einstellungen Scheibe 3)
  emailZustand: () => request<EmailZustellweg | undefined>('/api/v1/zustellwege/email'),
  emailAnfordern: (ziel: string) =>
    request<void>('/api/v1/zustellwege/email', { method: 'POST', body: JSON.stringify({ ziel }) }),
  emailEinstellungenSetzen: (abSchwere: Schwere, zusammenfassungAktiv: boolean, zusammenfassungUhrzeit: string) =>
    request<void>('/api/v1/zustellwege/email/einstellungen', {
      method: 'PUT',
      body: JSON.stringify({ abSchwere, zusammenfassungAktiv, zusammenfassungUhrzeit }),
    }),
  /** "E-Mail-Weg abschalten"/wieder einschalten (Scheibe 2, B12) - die Adresse bleibt erhalten. */
  emailAktivSetzen: (aktiv: boolean) =>
    request<void>('/api/v1/zustellwege/email/aktiv', { method: 'PUT', body: JSON.stringify({ aktiv }) }),
  /** "E-Mail-Weg entfernen" (Scheibe 2, B12). */
  emailEntfernen: () => request<void>('/api/v1/zustellwege/email', { method: 'DELETE' }),
  /** "Probe-Mail senden" (Entscheid 10A) - die Ruhezeit gilt dafür nicht. */
  emailProbe: () => request<ProbeErgebnis>('/api/v1/zustellwege/email/probe', { method: 'POST' }),

  // ----------------------------------------------------------------- Web-Push (Scheibe 3, §6.7, §7)
  pushOeffentlicherSchluessel: () =>
    request<{ schluessel: string }>('/api/v1/push/oeffentlicher-schluessel').then((r) => r.schluessel),
  pushAbos: () => request<PushAbo[]>('/api/v1/zustellwege/push'),
  pushAbonnieren: (endpoint: string, p256dh: string, auth: string, geraet: string, userAgent: string) =>
    request<PushAbo>('/api/v1/zustellwege/push', {
      method: 'POST',
      body: JSON.stringify({ endpoint, p256dh, auth, geraet, userAgent }),
    }),
  pushEinstellungenSetzen: (id: string, aktiv: boolean, abSchwere: Schwere) =>
    request<void>(`/api/v1/zustellwege/push/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ aktiv, abSchwere }),
    }),
  pushEntfernen: (id: string) =>
    request<void>(`/api/v1/zustellwege/push/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Beim Abmelden (B8): DIESES Geräts Abo beenden, erkannt über seinen Endpunkt (die eigene ID ist hier nie bekannt). */
  pushAbmelden: (endpoint: string) =>
    request<void>(`/api/v1/zustellwege/push?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' }),
  /** "Gerät umbenennen" (Scheibe 2, §4.12). */
  pushNameSetzen: (id: string, geraet: string) =>
    request<void>(`/api/v1/zustellwege/push/${encodeURIComponent(id)}/name`, {
      method: 'PUT',
      body: JSON.stringify({ geraet }),
    }),
  /** "Probe-Mitteilung senden" (Entscheid 10A). */
  pushProbe: (id: string) =>
    request<ProbeErgebnis>(`/api/v1/zustellwege/push/${encodeURIComponent(id)}/probe`, { method: 'POST' }),

  // ----------------------------------------------------------------- Webhook (Scheibe 6, §7 Scheibe 6)
  webhookZiele: () => request<WebhookZiel[]>('/api/v1/zustellwege/webhook'),
  webhookZielAnlegen: (url: string, name: string) =>
    request<NeuesWebhookZiel>('/api/v1/zustellwege/webhook', { method: 'POST', body: JSON.stringify({ url, name }) }),
  webhookZielEinstellungenSetzen: (id: string, aktiv: boolean, abSchwere: Schwere) =>
    request<void>(`/api/v1/zustellwege/webhook/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ aktiv, abSchwere }),
    }),
  webhookZielEntfernen: (id: string) =>
    request<void>(`/api/v1/zustellwege/webhook/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** "Team-Kanal bearbeiten" (Scheibe 2, §4.12) - Adresse/Name ändern, dieselbe SSRF-Prüfung wie beim Anlegen. */
  webhookZielBearbeiten: (id: string, url: string, name: string) =>
    request<void>(`/api/v1/zustellwege/webhook/${encodeURIComponent(id)}/adresse`, {
      method: 'PUT',
      body: JSON.stringify({ url, name }),
    }),
  /** "Probe senden" VOR dem Anlegen (Entscheid 10A) - nichts wird gespeichert. */
  webhookProbeVorAnlegen: (url: string) =>
    request<ProbeErgebnis>('/api/v1/zustellwege/webhook/probe', { method: 'POST', body: JSON.stringify({ url }) }),
  /** "Probe senden" für ein bereits verbundenes Ziel (Entscheid 10A). */
  webhookProbe: (id: string) =>
    request<ProbeErgebnis>(`/api/v1/zustellwege/webhook/${encodeURIComponent(id)}/probe`, { method: 'POST' }),

  // ----------------------------------------------------------------- Telegram (Scheibe 6, §7 Scheibe 6)
  telegramStatus: () => request<TelegramStatus>('/api/v1/zustellwege/telegram'),
  telegramVerbinden: () =>
    request<{ link: string }>('/api/v1/zustellwege/telegram/verbinden', { method: 'POST' }).then((r) => r.link),
  telegramZielEinstellungenSetzen: (id: string, aktiv: boolean, abSchwere: Schwere) =>
    request<void>(`/api/v1/zustellwege/telegram/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ aktiv, abSchwere }),
    }),
  telegramZielEntfernen: (id: string) =>
    request<void>(`/api/v1/zustellwege/telegram/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** "Probe senden" (Entscheid 10A) - nur für eine bereits bestätigte Verbindung. */
  telegramProbe: (id: string) =>
    request<ProbeErgebnis>(`/api/v1/zustellwege/telegram/${encodeURIComponent(id)}/probe`, { method: 'POST' }),

  // ----------------------------------------------------------------- Ruhezeit (Scheibe 3, §6.4)
  ruhezeit: () => request<RuhezeitZustand>('/api/v1/ruhezeit'),
  ruhezeitSetzen: (regeln: string, zeitzone: string, dringendDurch: boolean) =>
    request<void>('/api/v1/ruhezeit', { method: 'PUT', body: JSON.stringify({ regeln, zeitzone, dringendDurch }) }),
  ruhezeitProbe: (regeln: string, zeitzone: string) =>
    request<{ aktivBis: string | null }>('/api/v1/ruhezeit/probe', {
      method: 'POST',
      body: JSON.stringify({ regeln, zeitzone }),
    }).then((r) => r.aktivBis),

  // ----------------------------------------------------------------- Stummschaltung (Scheibe 3, §6.4)
  stummschaltungenAktive: () => request<Stummschaltung[]>('/api/v1/stummschaltungen'),
  stummschalten: (art: 'regel' | 'anlage' | 'standort', id: string, bis: string, grund: string | null) =>
    request<Stummschaltung>('/api/v1/stummschaltungen', {
      method: 'POST',
      body: JSON.stringify({ art, id, bis, grund }),
    }),
};
