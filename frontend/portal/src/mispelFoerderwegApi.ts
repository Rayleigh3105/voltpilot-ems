import { request } from './api';
import type { FoerderwegWert } from './mispelFoerderweg';

/**
 * Die Routen der Einrichtung MiSpeL (MP-17): der Förderweg je Einspeisestelle (Vertrag `mispel-foerderweg.md` 1.2,
 * MP-5) und die Zählerrolle je Messstelle (Vertrag `mispel-zaehlerrolle.md`, MP-6). snake_case wie der Vertrag;
 * `null` heißt „nicht erhoben“, nie 0 oder „nein“.
 */

export interface FoerderwegFassung {
  id: string;
  foerderweg: FoerderwegWert;
  formelsatz: string | null;
  einverstaendnis: boolean;
  gueltig_ab: string;
  gueltig_bis: string | null;
  aufgehoben_am: string | null;
  eingetragen_am: string;
  eingetragen_von: string | null;
  aw_regel: string | null;
  direktvermarkter?: string | null;
  bilanzkreis_gesondert?: boolean | null;
}

export interface FoerderwegVormerkung {
  id: string;
  foerderweg: FoerderwegWert;
  begriff: string;
  rechtsgrundlage: string;
  formelsatz: string | null;
  einverstaendnis: boolean;
  gueltig_ab: string;
  aw_regel: string | null;
  direktvermarkter: string | null;
  bilanzkreis_gesondert: boolean | null;
}

/** `GET /api/v1/sites/{siteId}/foerderweg` — `quelle` `unbekannt` trägt keinen Weg. */
export interface FoerderwegAnsicht {
  site_id: string;
  am: string;
  quelle: 'fassung' | 'bestand' | 'unbekannt';
  foerderweg: FoerderwegWert | null;
  begriff: string | null;
  rechtsgrundlage: string | null;
  formelsatz: string | null;
  formelsatz_gebunden_bis: string | null;
  einverstaendnis: boolean | null;
  gueltig_ab: string | null;
  netzladen: { moeglich: boolean | null; heute: boolean };
  fassungen: FoerderwegFassung[];
  aw_regel: string | null;
  /** Vertrag 1.2: die Vormerkung zum nächsten Monatsersten, bezogen auf heute. Ältere Antworten ohne Feld = keine. */
  vormerkung?: FoerderwegVormerkung | null;
  direktvermarkter?: string | null;
  bilanzkreis_gesondert?: boolean | null;
}

/** `PUT /api/v1/sites/{siteId}/foerderweg` (streng: jedes unbekannte Feld ist 400). */
export interface FoerderwegAendern {
  foerderweg: FoerderwegWert;
  formelsatz: string | null;
  einverstaendnis: boolean;
  gueltig_ab: string;
  aw_regel: string | null;
  direktvermarkter: string | null;
  bilanzkreis_gesondert: boolean | null;
}

export type Zaehlerrolle = 'Z1' | 'Z2' | 'Z3';

export interface ZaehlerrolleAngaben {
  rolle: Zaehlerrolle;
  zaehlpunkt: string | null;
  messstellenbetreiber: string | null;
  eichstatus: 'eichrechtskonform' | 'nicht_eichrechtskonform' | null;
  eichfrist_bis: string | null;
  wertequelle: 'messstellenbetreiber' | 'geraet' | null;
  gueltig_ab: string;
}

export interface ZaehlerrolleBefund {
  code: string;
  schwere: 'fehler' | 'hinweis';
  messstelle: string | null;
  betroffen: string | null;
  fundstelle: string | null;
  satz: string;
}

/** `GET /api/v1/messstellen/{id}/zaehlerrolle` */
export interface ZaehlerrolleAnsicht {
  messstelle_id: string;
  messstelle: string;
  am: string;
  anlage: string | null;
  rolle: ZaehlerrolleAngaben | null;
  festlegungsgroesse: string | null;
  urteil: 'tauglich' | 'nicht_tauglich' | 'nicht_pruefbar' | 'keine_rolle';
  befunde: ZaehlerrolleBefund[];
}

/** `PUT /api/v1/messstellen/{id}/zaehlerrolle` */
export type ZaehlerrolleAendern = Omit<ZaehlerrolleAngaben, 'rolle'> & { rolle: Zaehlerrolle | null };

export const mispelApi = {
  foerderweg: (siteId: string) =>
    request<FoerderwegAnsicht>(`/api/v1/sites/${encodeURIComponent(siteId)}/foerderweg`),
  foerderwegSetzen: (siteId: string, antrag: FoerderwegAendern) =>
    request<FoerderwegAnsicht>(`/api/v1/sites/${encodeURIComponent(siteId)}/foerderweg`, {
      method: 'PUT',
      body: JSON.stringify(antrag),
    }),
  vormerkungZuruecknehmen: (siteId: string) =>
    request<FoerderwegAnsicht>(`/api/v1/sites/${encodeURIComponent(siteId)}/foerderweg/vormerkung`, {
      method: 'DELETE',
    }),
  zaehlerrolle: (messstelleId: string) =>
    request<ZaehlerrolleAnsicht>(`/api/v1/messstellen/${encodeURIComponent(messstelleId)}/zaehlerrolle`),
  zaehlerrolleSetzen: (messstelleId: string, angaben: ZaehlerrolleAendern) =>
    request<ZaehlerrolleAnsicht>(`/api/v1/messstellen/${encodeURIComponent(messstelleId)}/zaehlerrolle`, {
      method: 'PUT',
      body: JSON.stringify(angaben),
    }),
};
