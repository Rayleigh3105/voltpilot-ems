import { api, ApiError, type Kennzahl } from './api';

/**
 * Eine Kennzahl für ihre Seite und die Ebene ihrer Bezugsbasis: mit Auswertung (`?mit=auswertung`). Scheitert nur die
 * Auswertung - jeder Fehler außer 404 -, steht die Kennzahl ohne sie da: Stammdaten, Menü und die Werte-Karte bleiben,
 * statt dass die ganze Seite auf den Ladefehler fällt (Review r3). 404 bleibt 404: die Kennzahl gibt es nicht (mehr).
 */
export function kennzahlMitAuswertung(id: string): Promise<Kennzahl> {
  return api.kennzahl(id, 'auswertung').catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) throw e;
    return api.kennzahl(id);
  });
}
