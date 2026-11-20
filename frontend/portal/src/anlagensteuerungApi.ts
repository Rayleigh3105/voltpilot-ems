import {
  request, type Anlagensteuerung, type AnlagensteuerungAnlegen, type Koppelbild, type KoppelTestAntwort, type NetzVermarktung,
} from './api';

/**
 * Die schreibenden Routen des Anlege-Schritts „Steuerung verbinden“ (UEMS EZ-15) an den EZ-6-Routen der
 * Anlagensteuerung - ein eigenes Modul wie `ueberwachungApi.ts`, damit es mit dem Assistenten nachgeladen wird und
 * nicht im Einstieg liegt. Lesen geht über `api.anlagensteuerungen` und `api.netzVermarktung` (EZ-10).
 *
 * Dazu Schalt-Test und Freigabe je Stellplatz des Koppelbilds (PFC200 Stufe 4); sie lädt der Dialog
 * `KoppelStellplatzDialog` nach. Gelesen wird das Koppelbild über `api.anlagensteuerungKoppelbild`.
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
  /**
   * Schalt-Test eines Stellplatzes: 30 s ein Testwert in den Einheiten des Bilds (W, 0,1 %, 0/1, 1..8, 0,1 °C); die
   * Antwort ist die Quittung der Steuerung, nie die Wirkung. Recht `schalttest.durchfuehren`; 400 außerhalb des Bands,
   * 409 ohne Angebot oder Steuerungskennung, jeweils mit `message`.
   */
  koppelTest: (geraetId: string, platz: number, wert: number) =>
    request<KoppelTestAntwort>(`/api/v1/geraete/${geraetId}/koppelbild/stellplaetze/${platz}/test`, {
      method: 'POST', body: JSON.stringify({ wert }),
    }),
  /**
   * Freigabe nach bestandenem Test und gesehener Wirkung (Recht `freigabe.erteilen`); 409 z. B., wenn das Kommando
   * schon belegt ist. Antwortet mit dem frischen Koppelbild.
   */
  koppelFreigeben: (geraetId: string, platz: number) =>
    request<Koppelbild>(`/api/v1/geraete/${geraetId}/koppelbild/stellplaetze/${platz}/freigabe`, {
      method: 'POST', body: JSON.stringify({ physicallyConfirmed: true }),
    }),
  /** Nimmt die Freigabe zurück; antwortet mit dem frischen Koppelbild. */
  koppelFreigabeZuruecknehmen: (geraetId: string, platz: number) =>
    request<Koppelbild>(`/api/v1/geraete/${geraetId}/koppelbild/stellplaetze/${platz}/freigabe`, { method: 'DELETE' }),
};
