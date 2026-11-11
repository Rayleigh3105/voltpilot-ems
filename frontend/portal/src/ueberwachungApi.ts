import { request } from './api';
import type { Schwere, UeberwachungsRegel } from './meldungenApi';
import type { Bedingungsart, Periode } from './werteKatalog';

/**
 * Die API-Aufrufe zum Anlegen und Verwalten einer Überwachung (Alerting Konzept §6.3/§6.8) - bewusst
 * NICHT in `meldungenApi.ts` (das Modul ist entry-gebündelt, `test/bundle-smoke.sh`). Angelegt wird
 * seit Konzept b1 (20.10.2026, Entscheid E3) nur noch unter Meldungen › Überwachungen
 * („+ Überwachung“: Ort, Wert, dann `UeberwachenBlatt`) und beim Umwandeln einer Steuerungsregel -
 * nie mehr am Wert einer anderen Fläche.
 */

/** "Was lässt sich hier überwachen?" (§6.3) - ein Wertverweis mit letztem Wert, den der Fragende sehen darf. */
export interface Wertverweis {
  wertart: string;
  name: string;
  satzname: string;
  bedingungen: Bedingungsart[];
  bezugJson: string;
  bekannt: boolean | null;
  zahlenwert: number | null;
  zustandswort: string | null;
  einheit: string | null;
}

/**
 * Der Bezug im Anfragekörper von `ueberwachungAnlegen` - `anlage` ODER `komponente`+`kanal` (§6.3)
 * ODER `messstelle` ODER `kennzahl` ODER `energieziel` (Alerting Scheibe 5, §6.3 "Bezug": Messstelle,
 * Kennzahl, Energieziel haben keine Anlage) ODER eine AUSWAHL (Alerting Scheibe 4, §6.4 "Gilt für"):
 * `alle` ist `"anlage"` oder `"box"`, wahlweise auf einen `standort` eingeschränkt (sonst der ganze
 * Kundenbereich). Genau EINE der Formen ist gesetzt.
 */
export interface UeberwachungBezugEingabe {
  anlage?: string;
  komponente?: string;
  kanal?: string;
  standort?: string;
  alle?: 'anlage' | 'box';
  messstelle?: string;
  kennzahl?: string;
  energieziel?: string;
}

/** `person` ODER `rolle` (§6.4 "Mehrere Empfänger") - nie beide. */
export interface UeberwachungEmpfaengerEingabe {
  person?: string;
  rolle?: string;
}

/**
 * Die rohe Bedingung im Anfragekörper - Form je Bedingungsart (§6.4); der Server ergänzt
 * `dauer_s`/`erholen_s`/`rueckkehr`, falls sie fehlen (§9). Scheibe 4 fügt `periode` (Tag/Woche/
 * Monat/Abrechnungszeitraum, `richtung` ersetzt die Methodenwahl "über"/"unter", `endgueltig`
 * verlangt eine abgeschlossene Periode) und `aenderung` (Vergleich mit der Vorperiode in %,
 * `schwelle_prozent` + `richtung`) additiv hinzu - beide nur für die periodischen Leserarten
 * `menge`/`geld`.
 */
export interface UeberwachungBedingungEingabe {
  art: Bedingungsart;
  schwelle?: number;
  rueckkehr?: number;
  schwelle_unten?: number;
  schwelle_oben?: number;
  rueckkehr_unten?: number;
  rueckkehr_oben?: number;
  ziel?: string[];
  dauer_s?: number;
  erholen_s?: number;
  periode?: Periode;
  endgueltig?: boolean;
  richtung?: 'ueber' | 'unter' | 'hoeher' | 'niedriger' | 'beide';
  schwelle_prozent?: number;
  /** UEMS EZ-11, Vorlage „Anlage folgt nicht“: Toleranz in % der installierten Leistung und mindestens in kW. */
  toleranz_prozent?: number;
  toleranz_kw?: number;
}

/** Der Anfragekörper von `POST /api/v1/meldungen/regeln` (§6.8). */
export interface UeberwachungAnlegenEingabe {
  wertart: string;
  bezug: UeberwachungBezugEingabe;
  bedingung: UeberwachungBedingungEingabe;
  schwere: Schwere;
  empfaenger?: UeberwachungEmpfaengerEingabe[];
  name?: string;
  /** Vorgabe `'eigen'`; `'steuerung'` nur für "In Überwachung umwandeln" (Alerting Scheibe 6, Entscheid 10A). */
  herkunft?: 'eigen' | 'steuerung';
}

/** Derselbe Entwurf wie `UeberwachungAnlegenEingabe`, aber ohne `empfaenger`/`name` (§6.8 Probelauf). */
export type UeberwachungEntwurfEingabe = Omit<UeberwachungAnlegenEingabe, 'empfaenger' | 'name'>;

/**
 * "Was diese Regel in den letzten 30 Tagen gemeldet hätte" (§6.4, §6.8 Entwurf 1) - die Vorschau
 * im Blatt, BEVOR eine Person "Überwachung starten" tippt. `zuletzt` ist `null`, wenn die Regel in
 * diesem Fenster nie ausgelöst hätte.
 */
export interface ProbelaufVorschau {
  fensterTage: number;
  ausgeloest: number;
  zuletzt: string | null;
  gesamtdauerS: number;
}

export const ueberwachungApi = {
  /** "Was lässt sich an dieser Anlage überwachen?" (§6.3) - nur `bezug=anlage:<id>` (`WerteController`). */
  werte: (bezug: string) =>
    request<{ werte: Wertverweis[] }>(`/api/v1/werte?bezug=${encodeURIComponent(bezug)}`).then((r) => r.werte),
  anlegen: (anfrage: UeberwachungAnlegenEingabe) =>
    request<UeberwachungsRegel>('/api/v1/meldungen/regeln', { method: 'POST', body: JSON.stringify(anfrage) }),
  /** Die Probelauf-Vorschau (§6.8 Entwurf 1) - derselbe Entwurf, bevor er angelegt wird. */
  probelauf: (entwurf: UeberwachungEntwurfEingabe) =>
    request<ProbelaufVorschau>('/api/v1/meldungen/regeln/probelauf', { method: 'POST', body: JSON.stringify(entwurf) }),
  /** "Jetzt scharf schalten" (§6.8 Entwurf 1, Nachbesserung 3/3) - beendet den Probelauf einer eigenen Regel vorzeitig. */
  scharfSchalten: (id: string) =>
    request<UeberwachungsRegel>(`/api/v1/meldungen/regeln/${encodeURIComponent(id)}/scharf`, { method: 'POST' }),
  /**
   * Löschen (Abnahme-Befund aus Produktion: "wie kann ich diese denn wieder löschen?") - der
   * Verlauf bleibt erhalten (Entscheid 3B), nur die Regel verschwindet aus der Verwaltung.
   */
  loeschen: (id: string) =>
    request<void>(`/api/v1/meldungen/regeln/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
