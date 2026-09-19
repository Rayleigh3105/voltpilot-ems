import type { Betriebsart, Site, StandortZuordnungBestaetigen, StandortZuordnungVorschau } from './api';

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

export type GruppierungAenderung =
  | { art: 'alle_zusammen' }
  | { art: 'alle_getrennt' }
  | { art: 'anlage_zuordnen'; vorschlagId: string; zielGruppeId: string | null };

export const NICHT_ZUGEORDNET = 'noch nicht zugeordnet';

export const STARTSEITE_UNTERNEHMEN = 'Ihre Startseite wird die Unternehmens-Übersicht.';
export const GELD_BLEIBT = 'Erlöse und Kosten finden Sie weiter im Cockpit jeder Anlage, im Portfolio und unter Erlöse.';
export const STEUERUNG_BLEIBT = 'An Steuerung, Fahrplänen und Freigaben ändert sich nichts.';

const STEUERUNGS_ANWENDUNGEN = new Set([
  'speicher-fahrplan',
  'ueberschuss',
  'verbraucher',
  'marktvermarktung',
  'lastspitzenkappung',
  'atypische-netznutzung',
  'lastmanagement',
]);

/**
 * AP-14 IP-14: genau die Aussagen, die für diesen Kunden nach dem Bestätigen
 * wahr sind. Die Komponente rendert nur dieses Urteil; die Bedingungen stehen
 * bewusst an EINER reinen Stelle und sind als Vektoren geprüft.
 */
export function wasSichAendert(input: {
  aktuelleEbene: 'heute' | 'standort' | 'unternehmen';
  zielGruppen: number;
  isAdmin: boolean;
  betriebsart: Betriebsart | null;
  anlagen: readonly Pick<Site, 'tarifArt'>[];
  anwendungen: readonly string[];
}): string[] {
  const saetze: string[] = [];
  const wechseltZurUnternehmensUebersicht = !input.isAdmin
    && input.betriebsart !== 'betreiber'
    && input.aktuelleEbene !== 'unternehmen'
    && input.zielGruppen >= 2;
  if (wechseltZurUnternehmensUebersicht) saetze.push(STARTSEITE_UNTERNEHMEN);

  const geldHeuteSichtbar = input.anlagen.some((a) => a.tarifArt === 'fest' || a.tarifArt === 'dynamisch')
    || input.anwendungen.some((a) => a === 'marktvermarktung' || a === 'lastspitzenkappung');
  if (geldHeuteSichtbar) saetze.push(GELD_BLEIBT);

  if (input.anwendungen.some((a) => STEUERUNGS_ANWENDUNGEN.has(a))) saetze.push(STEUERUNG_BLEIBT);
  return saetze;
}

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

/**
 * Jede Gruppierungsänderung läuft durch diese eine reine Funktion. Die Kennung
 * einer Gruppe folgt ihrer ersten Anlage; dadurch bleibt sie auch nach dem
 * Entfernen der bisherigen ersten Anlage eindeutig.
 */
export function gruppierungAendern(
  gruppen: VorschlagGruppeForm[],
  ausgang: VorschlagGruppeForm[],
  aenderung: GruppierungAenderung,
): VorschlagGruppeForm[] {
  const normalisiert = (liste: VorschlagGruppeForm[]) => liste.map((g) => ({
    ...g,
    id: g.anlagen[0]?.vorschlagId ?? g.id,
    anlagen: [...g.anlagen],
  }));
  if (aenderung.art === 'alle_getrennt') return normalisiert(ausgang);
  if (aenderung.art === 'alle_zusammen') {
    if (gruppen.length < 2) return normalisiert(gruppen);
    return normalisiert([{ ...gruppen[0], anlagen: gruppen.flatMap((g) => g.anlagen) }]);
  }

  const quelle = gruppen.find((g) => g.anlagen.some((a) => a.vorschlagId === aenderung.vorschlagId));
  const anlage = quelle?.anlagen.find((a) => a.vorschlagId === aenderung.vorschlagId);
  if (!quelle || !anlage || aenderung.zielGruppeId === quelle.id) return normalisiert(gruppen);

  const ohneAnlage = gruppen
    .map((g) => ({ ...g, anlagen: g.anlagen.filter((a) => a.vorschlagId !== aenderung.vorschlagId) }))
    .filter((g) => g.anlagen.length > 0);
  if (aenderung.zielGruppeId !== null) {
    if (!ohneAnlage.some((g) => g.id === aenderung.zielGruppeId)) return normalisiert(gruppen);
    return normalisiert(ohneAnlage.map((g) => g.id === aenderung.zielGruppeId
      ? { ...g, anlagen: [...g.anlagen, anlage] }
      : g));
  }

  const eigeneVorlage = ausgang.find((g) => g.anlagen.some((a) => a.vorschlagId === aenderung.vorschlagId));
  if (!eigeneVorlage || quelle.anlagen.length === 1) return normalisiert(gruppen);
  const eigeneGruppe = { ...eigeneVorlage, anlagen: [anlage] };
  const quellIndex = gruppen.indexOf(quelle);
  const einfuegeIndex = Math.min(quellIndex + 1, ohneAnlage.length);
  return normalisiert([
    ...ohneAnlage.slice(0, einfuegeIndex),
    eigeneGruppe,
    ...ohneAnlage.slice(einfuegeIndex),
  ]);
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
