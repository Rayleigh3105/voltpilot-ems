import { request } from './api';
import type { ComponentRole, Messwert } from './komponenten';
import type { Schwere, UeberwachungsRegel } from './meldungenApi';
import type { Bedingungsart, Periode } from './werteKatalog';

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
}

/** "Vom Wert zur fertigen Regel: drei Taps" (§6.8) - der Anfragekörper von `POST /api/v1/meldungen/regeln`. */
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
  /** "Was lässt sich hier überwachen?" (§6.3) - bislang nur `bezug=anlage:<id>` (`WerteController`). */
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
};

/**
 * Der Bezug einer `geraet.messwert`-Regel aus ihrem rohen `bezugJson` (§6.3) - die einzige Art,
 * "schon überwacht" an einem KONKRETEN Komponenten-Kanal zu erkennen (die Wertart allein
 * identifiziert in dieser Familie keinen Wert). `null`, wenn die Zeichenkette fehlt oder nicht
 * dem erwarteten `{"komponente":"…","kanal":"…"}` entspricht - nie geraten.
 */
export function geraetMesswertBezug(bezugJson: string | null): { komponente: string; kanal: string } | null {
  if (!bezugJson) return null;
  try {
    const roh = JSON.parse(bezugJson) as { komponente?: unknown; kanal?: unknown };
    return typeof roh.komponente === 'string' && typeof roh.kanal === 'string'
      ? { komponente: roh.komponente, kanal: roh.kanal }
      : null;
  } catch {
    return null;
  }
}

/** Der Schlüssel, unter dem eine Fläche "schon überwacht" für einen Komponenten-Kanal nachschlägt. */
export function geraetMesswertSchluessel(komponente: string, kanal: string): string {
  return `${komponente}::${kanal}`;
}

/**
 * Die aktiven `geraet.messwert`-Regeln als Nachschlage-Karte (Schlüssel → `probelaufBis`) - derselbe
 * Aufbau, den `AufbauTabelle.tsx` und `GeraetBuehne.tsx` sonst je einmal selbst bauen müssten.
 * Einmal hier (zero-cost, siehe Modulkopf) statt dreimal (auch `EnergieBuehne.tsx` baut ihre EIGENE,
 * nach Wertart statt nach Komponente+Kanal geschlüsselte Karte - andere Familie, anderer Schlüssel).
 */
export function geraetMesswertKarte(regeln: readonly UeberwachungsRegel[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const r of regeln) {
    if (!r.aktiv || r.wertart !== 'geraet.messwert') continue;
    const bezug = geraetMesswertBezug(r.bezugJson);
    if (bezug) m.set(geraetMesswertSchluessel(bezug.komponente, bezug.kanal), r.probelaufBis);
  }
  return m;
}

/**
 * Die ONE channel backing a component's displayed reading (Alerting Scheibe 2, §6.3) - die
 * SELBE Priorität wie `komponenten.ts` `readingFor` (Ladestand vor Speicher-Leistung), damit ein
 * überwachter Kanal nie dem widerspricht, was die Zeile zeigt. `null`, wenn die Komponente keinen
 * Kanal meldet, oder mehr als einen ohne rollenspezifischen Tiebreaker (mehrdeutig - nie geraten).
 *
 * Bewusst HIER statt in `komponenten.ts`: dessen `plantModel()` ist vom Einstiegs-Bündel aus
 * erreichbar (`test/bundle-smoke.sh`, 256 kB gz, schon ohne Luft) - ein neuer, von dort
 * referenzierter Export zog sein ganzes Modul mit in den Einstieg. Diese Datei ist dagegen
 * ausschließlich von den lazy Flächen der Überwachung erreichbar (`UeberwachenBlatt.tsx`,
 * `AufbauTabelle.tsx`), die beide ohnehin schon `role`/`channels` einer Komponente in Händen
 * halten. `SOC_CHANNEL`/`BATTERY_CHANNEL` sind bewusst noch einmal als Zeichenketten hier (nicht
 * aus `komponenten.ts` importiert) - derselbe Grund wie bei `ueberwachungSatz.ts`/`meldungen.ts`:
 * ein Wert-Import würde diese Datei an jenes Modul ketten.
 */
export function primaryChannelFor(role: ComponentRole, channels: readonly Messwert[]): string | null {
  if (role === 'storage') {
    const soc = channels.find((m) => m.raw === 'soc_pct');
    if (soc) return soc.raw;
    const batt = channels.find((m) => m.raw === 'battery_power_kw');
    if (batt) return batt.raw;
    return null;
  }
  return channels.length === 1 ? channels[0].raw : null;
}

/** Der Bezug + Vorbelegung eines Aufbau-Werts, der ein Blatt "Überwachen" öffnen kann (§6.3). */
export interface UeberwachbarZiel {
  komponente: string;
  kanal: string;
  label: string;
  einheit: string;
  wert: number | null;
}

/**
 * `null`, wenn die Komponente keinen eindeutigen Kanal hat ({@link primaryChannelFor}) - sonst
 * der fertige Bezug für `UeberwachenBlatt`/`WertZeile`. Einmal hier statt zweimal inline in
 * `AufbauTabelle.tsx` (Geräte- UND Komponenten-Zeile) - derselbe Bündel-Grund wie bei
 * `primaryChannelFor`.
 */
export function ueberwachbarZiel(
  c: { entityId: string; role: ComponentRole; channels: readonly Messwert[]; reading: { value: number; unit: string } | null },
  label: string,
): UeberwachbarZiel | null {
  const kanal = primaryChannelFor(c.role, c.channels);
  if (kanal == null) return null;
  return { komponente: c.entityId, kanal, label, einheit: c.reading?.unit ?? 'kW', wert: c.reading?.value ?? null };
}
