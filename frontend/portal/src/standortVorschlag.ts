import type { StandortZuordnungBestaetigen, StandortZuordnungVorschau } from './api';

export interface VorschlagGruppeForm {
  id: string;
  name: string;
  zeitzone: string;
  strasse: string;
  plz: string;
  ort: string;
  land: 'DE' | 'AT' | 'CH';
  anlagen: StandortZuordnungVorschau['gruppen'][number]['anlagen'];
}

export const NICHT_ZUGEORDNET = 'noch nicht zugeordnet';

export function formular(v: StandortZuordnungVorschau): VorschlagGruppeForm[] {
  return v.gruppen.map((g, i) => ({
    id: g.anlagen[0]?.vorschlagId ?? `gruppe-${i}`,
    name: g.name,
    zeitzone: g.zeitzone,
    strasse: g.adresse?.strasse ?? '',
    plz: g.adresse?.plz ?? '',
    ort: g.adresse?.ort ?? '',
    land: (g.adresse?.land as VorschlagGruppeForm['land']) ?? 'DE',
    anlagen: g.anlagen,
  }));
}

/** B1: alle Anlagen werden zu einer Gruppe; ihr erster Vorschlag liefert den Namen. */
export function alleZusammenlegen(gruppen: VorschlagGruppeForm[]): VorschlagGruppeForm[] {
  if (gruppen.length < 2) return gruppen;
  return [{ ...gruppen[0], anlagen: gruppen.flatMap((g) => g.anlagen) }];
}

export function pruefen(gruppen: VorschlagGruppeForm[]): string | null {
  if (!gruppen.length) return 'Es gibt keine Anlagen zum Zuordnen.';
  if (gruppen.some((g) => !g.name.trim())) return 'Bitte geben Sie jedem Standort einen Namen.';
  if (gruppen.some((g) => !g.strasse.trim() || !g.ort.trim())) return 'Bitte ergänzen Sie Straße und Ort für jeden Standort.';
  return null;
}

export function anfrage(gruppen: VorschlagGruppeForm[]): StandortZuordnungBestaetigen {
  return {
    gruppen: gruppen.map((g) => ({
      name: g.name.trim(),
      zeitzone: g.zeitzone,
      adresse: { strasse: g.strasse.trim(), plz: g.plz.trim() || null, ort: g.ort.trim(), land: g.land },
      vorschlagIds: g.anlagen.map((a) => a.vorschlagId),
    })),
  };
}
