import { ApiError, api, request, type Selbstauskunft, type SelbstauskunftUnterstuetzung, type Unterstuetzung, type UnterstuetzungAnfrage, type UnterstuetzungGewaehren, type UnterstuetzungHinweis } from './api';
import { selbstauskunft, setSelbstauskunft } from './rollen';
import { iso, tagPlus } from './bezugsPeriode';
import { datumZeit } from './rechte';
import { VORGABE_ZEITZONE } from './uemsZustand';

export const UMFANG = { ansehen: 'Ansehen', einrichten: 'Einrichten', einrichten_und_bedienen: 'Einrichten und Bedienen' };
export const heute = () => iso(Date.now(), VORGABE_ZEITZONE).slice(0, 10);
export const vorgabeEnde = () => tagPlus(heute(), 30);
export function hoechstesEnde(ab = heute()): string {
  const [j, m, t] = ab.split('-').map(Number);
  return `${j + 1}-${String(m).padStart(2, '0')}-${String(Math.min(t, new Date(Date.UTC(j + 1, m, 0)).getUTCDate())).padStart(2, '0')}`;
}
export function pruefeUnterstuetzung(standorte: string[], bis: string, ab = heute()): string | null {
  if (!standorte.length) return 'Wählen Sie mindestens einen Standort.';
  if (!bis || bis > hoechstesEnde(ab)) return 'Wählen Sie ein Enddatum innerhalb von höchstens 12 Monaten.';
  if (bis < ab) return 'Das Enddatum darf nicht vor dem Beginn liegen.';
  return null;
}
export const enddatum = (u: Pick<Unterstuetzung, 'gueltig_bis' | 'endet'>) => u.gueltig_bis
  ? u.gueltig_bis.split('-').reverse().join('.') : u.endet ? datumZeit(u.endet, VORGABE_ZEITZONE) : 'unbekannt';
export function bannerTexte(me: Selbstauskunft | null, standort: string | null, jetzt = Date.now()): string[] {
  if (!me) return [];
  const sichtbar = (u: SelbstauskunftUnterstuetzung) => u.zustand === 'aktiv' && (!u.endet || Date.parse(u.endet) > jetzt)
    && (!standort || u.standorte.includes(standort));
  if (me.zugang === 'unterstuetzung') return me.unterstuetzungen.eigene.filter(sichtbar).map(u =>
    `Sie arbeiten im Kundenbereich ${me.kundenbereich?.name ?? ''} · ${me.standorte.filter(s => u.standorte.includes(s.id)).map(s => s.name).join(', ')} · ${u.umfang ? UMFANG[u.umfang] : 'Umfang unbekannt'} · bis ${enddatum(u)}${u.art === 'notfall' && u.banner ? ` · ${u.banner}` : ''}`);
  return me.unterstuetzungen.gewaehrte.filter(sichtbar).flatMap(u => u.banner ? [u.banner] : []);
}
const pfad = '/api/v1/unterstuetzung';
const schreiben = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const unterstuetzungApi = {
  standorte: () => api.standorte().then(a => a.standorte.filter(s => s.zustand !== 'archiviert').map(s => ({ id: s.id, name: s.name }))),
  liste: () => request<Unterstuetzung[]>(pfad),
  anfragen: () => request<UnterstuetzungAnfrage[]>(`${pfad}/anfragen`),
  hinweise: () => request<UnterstuetzungHinweis[]>(`${pfad}/hinweise`),
  gewaehren: (body: UnterstuetzungGewaehren) => request<Unterstuetzung>(pfad, schreiben('POST', body)),
  verlaengern: (id: string, bis: string) => request<Unterstuetzung>(`${pfad}/${id}`, schreiben('PUT', { gueltig_bis: bis })),
  beenden: (id: string, grund: string) => request<void>(`${pfad}/${id}`, schreiben('DELETE', { grund: grund.trim() || null })),
  ablehnen: (id: string) => request<void>(`${pfad}/anfragen/${id}/ablehnen`, schreiben('POST')),
  gelesen: (id: string) => request<void>(`${pfad}/hinweise/${id}/gelesen`, schreiben('POST')),
  aktualisieren: async () => {
    const vorher = selbstauskunft(); const neu = await api.selbstauskunft(); const aktuell = selbstauskunft();
    if (vorher?.kennung !== aktuell?.kennung || vorher?.kundenbereich?.id !== aktuell?.kundenbereich?.id) return;
    setSelbstauskunft(neu); window.dispatchEvent(new Event('vp-unterstuetzung-geaendert'));
  },
};
export function unterstuetzungFehler(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { code?: string })?.code;
    if (code === 'standort_fehlt') return 'Wählen Sie mindestens einen Standort.';
    if (code === 'hoechstens_12_monate') return 'Wählen Sie ein Enddatum innerhalb von höchstens 12 Monaten.';
    if (code === 'grund_fehlt') return 'Bitte geben Sie einen Grund für den Notfall-Zugriff an.';
    if (code === 'ende_nicht_spaeter') return 'Wählen Sie ein späteres Enddatum.';
    if (code === 'notfall_nicht_verlaengerbar') return 'Ein Notfall-Zugriff gilt 24 Stunden und kann nicht verlängert werden.';
    if (e.status === 404) return 'Dieser Zugriff oder Standort ist nicht mehr verfügbar.';
    if (e.status === 409) return 'Der Zugriff oder die Anfrage wurde inzwischen geändert. Bitte laden Sie die Seite neu.';
    if (e.status === 403) return 'Nur der Kundenadministrator kann Unterstützung verwalten.';
  }
  return 'Die Unterstützung konnte nicht gespeichert werden. Bitte prüfen Sie die Angaben und versuchen Sie es erneut.';
}
