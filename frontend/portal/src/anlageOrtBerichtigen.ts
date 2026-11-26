import type { AnlageOrtAnfrage, StandortAdresse, StandortAmStichtag, StandorteAmStichtag, StandortLage } from './api';
import { adresseText, ZEITZONE_DES_LANDES, type Adresse } from './anlageOrt';
import { zoneForCountry } from './anlageFlow';
import { adresseKurz } from './standorte';

/**
 * „Standort berichtigen" (vp-standort-konzept §6.1/§6.6, B1/B3/B6): die reine Hälfte der neuen
 * Zeile und ihres Blattes — ein Schreibweg (`api.anlageOrtBerichtigen`) statt der getrennten
 * Standort-Adresse und des Karten-Punkts der Anlage. Nie ein Datum: eine Berichtigung gilt
 * rückwirkend für die Stammdaten, wie jede Korrektur der Ortsstruktur.
 */

/** §6.6: „weit gezogen" — über etwa 150 m bietet das Blatt „Adresse übernehmen?" an. */
export const WEIT_GEZOGEN_METER = 150;
/** §6.6: „weit weg" — mehr als 2 km löst Box-Neubau und Wetter-Nachholung aus (reine Information hier). */
export const WEIT_WEG_METER = 2000;

/** Haversine in Metern — reicht für die beiden Schwellen des Konzepts. */
export function distanzMeter(a: { breitengrad: number; laengengrad: number }, b: { breitengrad: number; laengengrad: number }): number {
  const erdradiusM = 6371000;
  const phi1 = (a.breitengrad * Math.PI) / 180;
  const phi2 = (b.breitengrad * Math.PI) / 180;
  const dPhi = ((b.breitengrad - a.breitengrad) * Math.PI) / 180;
  const dLambda = ((b.laengengrad - a.laengengrad) * Math.PI) / 180;
  const x = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return erdradiusM * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

export interface OrtPunkt {
  breitengrad: number;
  laengengrad: number;
}

export interface OrtForm {
  adresse: Adresse;
  punkt: OrtPunkt;
}

/** Der Ausgangsstand aus dem Lesemodell — `null`, solange der Standort keine Lage hat (Rand-Fall). */
export function ortFormAus(standort: StandortAmStichtag): OrtForm | null {
  const a = standort.adresse;
  if (!a?.strasse || !a.ort || !a.land || !standort.lage) return null;
  return {
    adresse: { strasse: a.strasse, plz: a.plz, ort: a.ort, land: a.land },
    punkt: { breitengrad: standort.lage.breitengrad, laengengrad: standort.lage.laengengrad },
  };
}

/** Nur der Pin bewegt sich — die Adresse bleibt (Regel 3: ein gezogener Pin ändert nie die Adresse). */
export function pinZiehen(form: OrtForm, punkt: OrtPunkt): OrtForm {
  return { ...form, punkt };
}

/** Eine gewählte Adresssuche setzt Adresse UND Pin (Regel 3: die Adresse setzt den Pin). */
export function adresseWaehlen(form: OrtForm, adresse: Adresse, punkt: OrtPunkt | null): OrtForm {
  return { adresse, punkt: punkt ?? form.punkt };
}

/** Nichts geändert heißt: „Speichern" bleibt aus (Regel 2). */
export function geaendert(aktuell: OrtForm, ursprung: OrtForm): boolean {
  return (
    aktuell.adresse.strasse !== ursprung.adresse.strasse ||
    aktuell.adresse.plz !== ursprung.adresse.plz ||
    aktuell.adresse.ort !== ursprung.adresse.ort ||
    aktuell.adresse.land !== ursprung.adresse.land ||
    aktuell.punkt.breitengrad !== ursprung.punkt.breitengrad ||
    aktuell.punkt.laengengrad !== ursprung.punkt.laengengrad
  );
}

/** Der Rumpf von `PUT …/ort`. */
export function ortAnfrage(form: OrtForm): AnlageOrtAnfrage {
  const adresse: StandortAdresse = { strasse: form.adresse.strasse, plz: form.adresse.plz, ort: form.adresse.ort, land: form.adresse.land };
  const lage: StandortLage = { breitengrad: form.punkt.breitengrad, laengengrad: form.punkt.laengengrad };
  return { adresse, lage };
}

/**
 * §6.6: der Pin wurde weit genug gezogen, dass das Blatt die aufgelöste Adresse als Übernahme
 * anbietet — nur, wenn sie sich von der aktuell eingetragenen unterscheidet (sonst gäbe es nichts
 * zu übernehmen).
 */
export function uebernahmeAnbieten(vorPinZug: OrtPunkt, nachPinZug: OrtPunkt, aufgeloest: Adresse | null, aktuell: Adresse): boolean {
  if (!aufgeloest) return false;
  if (distanzMeter(vorPinZug, nachPinZug) < WEIT_GEZOGEN_METER) return false;
  return adresseText(aufgeloest) !== adresseText(aktuell);
}

/** T6a, §6.2: ob der Kundenbereich „Gehört zu" braucht — ab zwei Standorten. */
export function mehrereStandorte(antwort: StandorteAmStichtag | null): boolean {
  return (antwort?.standorte ?? []).filter((s) => s.bestand === 'vorhanden').length > 1;
}

/**
 * Die Zeile „Standort" (§6.2, E3): bei einem Standort nur die Adresse, bei mehreren zuerst der
 * Standortname. Ohne Adresse (Entwurf, B1) ein Satz statt einer leeren Zeile.
 */
export function ortZeileText(standort: StandortAmStichtag, mehrere: boolean): string {
  const adresse = adresseKurz(standort) ?? 'Adresse noch nicht hinterlegt';
  return mehrere ? `${standort.name} · ${adresse}` : adresse;
}

/** §6.1 Regel 4: Gebotszone und Zeitzone folgen dem Land — nur zur Anzeige unter „Details". */
export function landFolgen(land: Adresse['land']): { gebotszone: string; zeitzone: string } {
  return { gebotszone: zoneForCountry(land), zeitzone: ZEITZONE_DES_LANDES[land] };
}
