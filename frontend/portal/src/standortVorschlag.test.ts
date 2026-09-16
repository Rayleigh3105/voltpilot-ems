import { describe, expect, it } from 'vitest';
import type { StandortZuordnungVorschau } from './api';
import { alleZusammenlegen, anfrage, formular, pruefen } from './standortVorschlag';

const VORSCHAU = {
  anlagenZahl: 2,
  gruppen: [
    { name: 'Halle 1', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'v1', anlageId: 'a1', anlageName: 'Halle 1', gueltigAb: '2025-01-01' }] },
    { name: 'Halle 2', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'v2', anlageId: 'a2', anlageName: 'Halle 2', gueltigAb: '2025-06-01' }] },
  ],
} satisfies StandortZuordnungVorschau;

describe('Standort-Vorschau', () => {
  it('legt nur im Formular zusammen und baut die bestätigte Anfrage', () => {
    const gruppen = alleZusammenlegen(formular(VORSCHAU));
    gruppen[0] = { ...gruppen[0], name: 'Werk Ahrenberg', strasse: 'Gewerbering 7', plz: '84123', ort: 'Ahrenberg' };
    expect(pruefen(gruppen)).toBeNull();
    expect(anfrage(gruppen)).toEqual({ gruppen: [{
      name: 'Werk Ahrenberg', zeitzone: 'Europe/Berlin',
      adresse: { strasse: 'Gewerbering 7', plz: '84123', ort: 'Ahrenberg', land: 'DE' },
      vorschlagIds: ['v1', 'v2'],
    }] });
    expect(VORSCHAU.gruppen).toHaveLength(2);
  });
});
