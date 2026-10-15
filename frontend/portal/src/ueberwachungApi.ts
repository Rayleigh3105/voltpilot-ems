import { request } from './api';
import type { Schwere, UeberwachungsRegel } from './meldungenApi';
import type { Bedingungsart } from './werteKatalog';

/**
 * Die beiden API-Aufrufe für „Überwachen" am Wert (Alerting Scheibe 2, Konzept §6.3/§6.8) - bewusst
 * NICHT in `meldungenApi.ts` (das Modul ist entry-gebündelt, `test/bundle-smoke.sh` Grenze 256 kB
 * gz). Nur `UeberwachenBlatt.tsx` importiert dieses Modul, und das wiederum nur das lazy
 * `EnergieBuehne`-Stück - keine der beiden Funktionen ist also je im Einstieg.
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

/** Der Bezug im Anfragekörper von `ueberwachungAnlegen` - `anlage` ODER `komponente`+`kanal` (§6.3), nie beide. */
export interface UeberwachungBezugEingabe {
  anlage?: string;
  komponente?: string;
  kanal?: string;
}

/** `person` ODER `rolle` (§6.4 "Mehrere Empfänger") - nie beide. */
export interface UeberwachungEmpfaengerEingabe {
  person?: string;
  rolle?: string;
}

/** Die rohe Bedingung im Anfragekörper - Form je Bedingungsart (§6.4); der Server ergänzt `dauer_s`/`erholen_s`/`rueckkehr`, falls sie fehlen (§9). */
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
}

/** "Vom Wert zur fertigen Regel: drei Taps" (§6.8) - der Anfragekörper von `POST /api/v1/meldungen/regeln`. */
export interface UeberwachungAnlegenEingabe {
  wertart: string;
  bezug: UeberwachungBezugEingabe;
  bedingung: UeberwachungBedingungEingabe;
  schwere: Schwere;
  empfaenger?: UeberwachungEmpfaengerEingabe[];
  name?: string;
}

export const ueberwachungApi = {
  /** "Was lässt sich hier überwachen?" (§6.3) - bislang nur `bezug=anlage:<id>` (`WerteController`). */
  werte: (bezug: string) =>
    request<{ werte: Wertverweis[] }>(`/api/v1/werte?bezug=${encodeURIComponent(bezug)}`).then((r) => r.werte),
  anlegen: (anfrage: UeberwachungAnlegenEingabe) =>
    request<UeberwachungsRegel>('/api/v1/meldungen/regeln', { method: 'POST', body: JSON.stringify(anfrage) }),
};
