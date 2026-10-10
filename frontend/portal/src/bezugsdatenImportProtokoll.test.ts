import { describe, expect, it } from 'vitest';
import type { BezugsdatenVorschau } from './api';
import { doppelimportBanner, konfliktAbleitung, ruecknahmeSaetze } from './bezugsdatenImportProtokoll';

const vorschau = {
  datei: { befund: { befund: 'datei_bekannt', satz: 'Diese Datei wurde bereits übernommen.', hinweis: true } },
  frueherer_import: { kennung: 'I-2026-0001', status: 'uebernommen', am: '' },
  import: { aenderungen: 1, befunde: [] },
  zeilen: [{ nr: 2, urteil: 'konflikt' }, { nr: 3, urteil: 'konflikt' }],
} as unknown as BezugsdatenVorschau;

describe('Import-Protokoll-Ableitungen', () => {
  it('spricht den Doppelimport mit dem unveränderten Serversatz', () => {
    expect(doppelimportBanner(vorschau)).toEqual({ satz: 'Diese Datei wurde bereits übernommen.', kennung: 'I-2026-0001' });
  });

  it('nimmt behalten als Vorgabe und zählt den Sammelhebel', () => {
    expect(konfliktAbleitung(vorschau, { 2: 'ersetzen' })).toEqual({ konflikte: 2, ersetzen: 1, behalten: 1, aenderungen: 2, begruendungNoetig: true });
  });

  it('beschreibt B14 ohne einen Wert zu erfinden', () => {
    expect(ruecknahmeSaetze({ kennung: 'I-2026-0001', aenderungen: 1, vieraugen: false, werte: [{
      bezugsgroesse_id: '1', kennzeichen: 'BZ-1', name: 'Produktionsmenge', periode_von: '2026-10-01', periode_bis: '2026-10-31',
      zeitpunkt: null, bisheriger_betrag: '312400', neuer_betrag: null, einheit: 'kg', vorgang: 'zurueckgenommen',
    }] })).toEqual(['BZ-1 · Oktober 2026: 312.400 kg wird zurückgenommen.']);
  });
});
