import { request, type Anlagensteuerung, type AnlagensteuerungAnlegen, type NetzVermarktung } from './api';

/**
 * Die schreibenden Routen des Anlege-Schritts „Steuerung verbinden“ (UEMS EZ-15) an den EZ-6-Routen der
 * Anlagensteuerung - ein eigenes Modul wie `ueberwachungApi.ts`, damit es mit dem Assistenten nachgeladen wird und
 * nicht im Einstieg liegt. Lesen geht über `api.anlagensteuerungen` und `api.netzVermarktung` (EZ-10).
 */
export const anlagensteuerungApi = {
  /** Recht `geraet.einrichten`; 409, solange die zuständige Box das Erzeuger-Bild nicht lesen kann. */
  anlegen: (siteId: string, body: AnlagensteuerungAnlegen) =>
    request<Anlagensteuerung>(`/api/v1/sites/${siteId}/anlagensteuerungen`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  /** Die Namen aus dem Bild als Vorbelegung (Konzept §3.10); nie ein Überschreiben, eine Abweichung kommt als Hinweis. */
  namen: (geraetId: string, body: {
    netzbetreiber: string | null; direktvermarkter: string | null; einheiten: { te_nr: number; typ: string | null }[];
  }) => request<NetzVermarktung>(`/api/v1/geraete/${geraetId}/anlagensteuerung/namen`, {
    method: 'POST', body: JSON.stringify(body),
  }),
};
