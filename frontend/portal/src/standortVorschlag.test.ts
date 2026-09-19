import { describe, expect, it } from 'vitest';
import type { StandortZuordnungVorschau } from './api';
import { anfrage, formular, gruppierungAendern, pruefen, wasSichAendert } from './standortVorschlag';

const VORSCHAU = {
  anlagenZahl: 3,
  gruppen: [
    { name: 'Halle 1', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'v1', anlageId: 'a1', anlageName: 'Halle 1', gueltigAb: '2025-01-01' }] },
    { name: 'Halle 2', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'v2', anlageId: 'a2', anlageName: 'Halle 2', gueltigAb: '2025-06-01' }] },
    { name: 'Werk Lindach', zeitzone: 'Europe/Berlin', adresse: null,
      anlagen: [{ vorschlagId: 'v3', anlageId: 'a3', anlageName: 'Werk Lindach', gueltigAb: '2026-10-15' }] },
  ],
} satisfies StandortZuordnungVorschau;

describe('Standort-Vorschau', () => {
  it('bildet die Vektoren 1+1+1, 3 und jede Besetzung 2+1', () => {
    const ausgang = formular(VORSCHAU);
    expect(ausgang.map((g) => g.anlagen.map((a) => a.vorschlagId))).toEqual([['v1'], ['v2'], ['v3']]);
    expect(gruppierungAendern(ausgang, ausgang, { art: 'alle_zusammen' })[0].anlagen.map((a) => a.vorschlagId))
      .toEqual(['v1', 'v2', 'v3']);
    for (const [vorschlagId, zielGruppeId, erwartet] of [
      ['v1', 'v2', [['v2', 'v1'], ['v3']]],
      ['v1', 'v3', [['v2'], ['v3', 'v1']]],
      ['v2', 'v3', [['v1'], ['v3', 'v2']]],
    ] as const) {
      const gruppen = gruppierungAendern(ausgang, ausgang, { art: 'anlage_zuordnen', vorschlagId, zielGruppeId });
      expect(gruppen.map((g) => g.anlagen.map((a) => a.vorschlagId))).toEqual(erwartet);
    }
  });

  it('verschiebt, stellt wieder für sich und entfernt die leere Gruppe', () => {
    const ausgang = formular(VORSCHAU);
    const zweiUndEins = gruppierungAendern(ausgang, ausgang, { art: 'anlage_zuordnen', vorschlagId: 'v2', zielGruppeId: 'v1' });
    expect(zweiUndEins.map((g) => g.id)).toEqual(['v1', 'v3']);
    const wiederEigen = gruppierungAendern(zweiUndEins, ausgang, { art: 'anlage_zuordnen', vorschlagId: 'v2', zielGruppeId: null });
    expect(wiederEigen.map((g) => g.anlagen.map((a) => a.vorschlagId))).toEqual([['v1'], ['v2'], ['v3']]);
    expect(gruppierungAendern(zweiUndEins, ausgang, { art: 'alle_getrennt' })).toEqual(ausgang);
  });

  it('baut für 2+1 genau die bestätigte Anfrage und aktualisiert die Folgen', () => {
    const ausgang = formular(VORSCHAU);
    const gruppen = gruppierungAendern(ausgang, ausgang, { art: 'anlage_zuordnen', vorschlagId: 'v2', zielGruppeId: 'v1' });
    gruppen[0] = { ...gruppen[0], name: 'Werk Ahrenberg', strasse: 'Gewerbering 7', plz: '84123', ort: 'Ahrenberg' };
    gruppen[1] = { ...gruppen[1], name: 'Werk Lindach', strasse: 'Werkstraße 8', plz: '84123', ort: 'Lindach' };
    expect(pruefen(gruppen)).toBeNull();
    expect(anfrage(gruppen)).toEqual({ gruppen: [
      { name: 'Werk Ahrenberg', zeitzone: 'Europe/Berlin', adresse: { strasse: 'Gewerbering 7', plz: '84123', ort: 'Ahrenberg', land: 'DE' }, vorschlagIds: ['v1', 'v2'] },
      { name: 'Werk Lindach', zeitzone: 'Europe/Berlin', adresse: { strasse: 'Werkstraße 8', plz: '84123', ort: 'Lindach', land: 'DE' }, vorschlagIds: ['v3'] },
    ] });
    expect(wasSichAendert({ aktuelleEbene: 'heute', zielGruppen: gruppen.length, isAdmin: false, betriebsart: null, anlagen: [{ tarifArt: 'ohne' }], anwendungen: ['monitoring'] }))
      .toEqual(['Ihre Startseite wird die Unternehmens-Übersicht.']);
    const eineGruppe = gruppierungAendern(gruppen, ausgang, { art: 'alle_zusammen' });
    expect(wasSichAendert({ aktuelleEbene: 'heute', zielGruppen: eineGruppe.length, isAdmin: false, betriebsart: null, anlagen: [{ tarifArt: 'ohne' }], anwendungen: ['monitoring'] }))
      .toEqual([]);
    expect(VORSCHAU.gruppen).toHaveLength(3);
  });
});
