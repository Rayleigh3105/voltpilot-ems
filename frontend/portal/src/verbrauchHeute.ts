/**
 * Heute-kWh je Verbraucher (Konzept `vp-verbraucher-cockpit-k1` §8, Phase 0
 * Schritt 5).
 *
 * Die Aufschlüsselung hinter der Haus-Zeile zeigt je Teil eine Tagessumme.
 * Sie kommt aus ZWEI Quellen, weil ein Ladepunkt und eine gemessene Komponente
 * in dieser Plattform verschiedene Dinge sind:
 *
 * - **gemessene Komponente** → `GET /sites/{id}/entities/{id}/history?range=day`
 *   (die Viertelstunden-Reihe, die auch der Messwerte-Explorer zeichnet):
 *   Energie = Σ Mittelwert × Eimer-Dauer.
 * - **Ladepunkt** → `GET /sites/{id}/ocpp/meter-values?from=…&pointKey=…`:
 *   der Zählerstand `Energy.Active.Import.Register` ist ein REGISTER, die
 *   Tagesenergie also sein ZUWACHS (`max − min`), nie die Summe der Messwerte.
 *
 * ⚠ Das ist die Hausregel aus `ConsumerRequirementStateRepository.energyOverPeriod`
 * („die Energie einer Periode ist `max − min`, der ZUWACHS") und die
 * Ehrlichkeitsregel der Stufe 5 von „Eigene Auswertung": **eine Reihe, die
 * irgendwo FÄLLT, ergibt gar keine Zahl** — ein Zähler, der mittags von 950 auf
 * 5 springt (Tausch, Reset, Überlauf), lieferte sonst 945 kWh statt der
 * wirklichen ~57. Ein Vorzeichen-Test wäre wirkungslos: `max − min` ist per
 * Konstruktion nie negativ.
 *
 * Rein + rahmenfrei (getestet in `verbrauchHeute.test.ts`); der Abruf selbst
 * wohnt in `useVerbrauchHeute` (`components/KomponentenSection.tsx`).
 */
import type { EntityHistory, OcppMeterSample } from './api';
import type { ChargePoint } from './ladepunkte';
import type { VerbrauchKomposition } from './verbrauchKomposition';

/** Der Zählerstand, aus dem die Tagesenergie eines Ladepunkts entsteht. */
export const REGISTER_POINT_KEY = 'Energy.Active.Import.Register';

/** Der Kanal, aus dem die Tagesenergie einer gemessenen Komponente entsteht. */
const LEISTUNGS_KANAL = 'power_kw';

/** Auf drei Nachkommastellen — dieselbe Rundung wie `verbrauchKomposition`. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Der Beginn des laufenden Tages in der Zeitzone der ANZEIGE, als ISO-Zeitpunkt
 * für den `from`-Parameter.
 *
 * ⚠ Bewusst die Zone des Browsers und nicht `Europe/Berlin` fest verdrahtet:
 * die Haus-Tagessumme daneben (`/history?range=day`) ist ein Berliner Tag, und
 * dieselbe Uhrzeit zweimal verschieden auszulegen wäre die schlimmere Lüge —
 * aber die Zone hier stammt aus derselben Quelle wie jede andere Datumsanzeige
 * des Portals, und ein Kunde in Berlin (der Normalfall) bekommt exakt denselben
 * Schnitt. Wer die Zone je pro Mandant führt, ändert sie an dieser einen Stelle.
 */
export function tagesBeginn(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Die Tagesenergie EINER gemessenen Komponente aus ihrer Viertelstunden-Reihe.
 *
 * `null`, wenn der Leistungs-Kanal fehlt oder kein einziger Eimer einen
 * Mittelwert trägt — nie eine 0 (eine Komponente ohne Messung hat nicht
 * nachweislich nichts verbraucht).
 */
export function heuteAusEntitaet(history: EntityHistory | null | undefined): number | null {
  if (!history) return null;
  const buckets = history.channels?.[LEISTUNGS_KANAL];
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const stunden = history.bucketMinutes / 60;
  if (!(stunden > 0)) return null;
  let sum = 0;
  let gesehen = false;
  for (const b of buckets) {
    if (b.avg == null || !Number.isFinite(b.avg)) continue;
    gesehen = true;
    // Ein negativer Mittelwert ist auf einem Verbrauchs-Kanal kein Verbrauch;
    // ihn abzuziehen machte die Tagessumme kleiner, als sie war.
    sum += Math.max(b.avg, 0) * stunden;
  }
  return gesehen ? round3(sum) : null;
}

/**
 * Der Register-ZUWACHS je Stecker aus den Zählerstands-Proben des Tages.
 *
 * Schlüssel sind die der Aufschlüsselung: `cp:{chargePointId}#{connectorId}`
 * je Stecker und `cp:{chargePointId}` als Summe der Säule (die Zeile, die eine
 * Säule ohne gemeldeten Stecker bekommt, und die Summenzeile der Kollaps-Regel).
 *
 * `null` je Schlüssel heißt „nicht belegbar" und ist ein vollwertiges Urteil:
 * weniger als zwei Proben, eine fallende Reihe (Zählertausch/Reset), oder eine
 * Einheit, die wir nicht kennen.
 */
export function heuteAusRegister(
  samples: OcppMeterSample[] | null | undefined,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!samples || samples.length === 0) return out;
  // Je Stecker: die Proben in Zeitreihenfolge, in kWh umgerechnet.
  const proSteckerKwh = new Map<string, { t: number; kwh: number }[]>();
  for (const s of samples) {
    if (!istRegister(s)) continue;
    const kwh = alsKwh(s);
    if (kwh == null) continue;
    const t = Date.parse(s.sampledAt);
    if (!Number.isFinite(t)) continue;
    const key = `cp:${s.chargePointId}#${s.connectorId}`;
    const liste = proSteckerKwh.get(key);
    if (liste) liste.push({ t, kwh });
    else proSteckerKwh.set(key, [{ t, kwh }]);
  }
  // Je Säule sammeln, damit die Summenzeile die Summe IHRER Stecker ist - und
  // nicht die Differenz eines zusammengewürfelten Registers.
  const proSaeule = new Map<string, { sum: number; ehrlich: boolean }>();
  for (const [key, roh] of proSteckerKwh) {
    const zuwachs = registerZuwachs(roh);
    out[key] = zuwachs;
    const saeule = key.slice(0, key.indexOf('#'));
    const bisher = proSaeule.get(saeule) ?? { sum: 0, ehrlich: true };
    if (zuwachs == null) bisher.ehrlich = false;
    else bisher.sum += zuwachs;
    proSaeule.set(saeule, bisher);
  }
  for (const [saeule, agg] of proSaeule) {
    // ⚠ Ein einziger unbelegbarer Stecker macht die SÄULEN-Summe unbelegbar -
    // eine Teilsumme, die sich „vollständig" liest, wäre die gefährlichere der
    // beiden Auskünfte (dieselbe Regel wie `restToday`).
    out[saeule] = agg.ehrlich ? round3(agg.sum) : null;
  }
  return out;
}

/** Ein Register-Sample? Der Kontrakt nennt es in `pointKey` ODER `measurand`. */
function istRegister(s: OcppMeterSample): boolean {
  return [s.pointKey, s.measurand].some(
    (v) => v?.toLowerCase() === REGISTER_POINT_KEY.toLowerCase(),
  );
}

/** Der Zählerstand in kWh; `null` bei unbekannter Einheit oder ohne Zahl. */
function alsKwh(s: OcppMeterSample): number | null {
  if (s.numericValue == null || !Number.isFinite(s.numericValue)) return null;
  const unit = (s.unit ?? '').toLowerCase();
  if (unit === 'kwh') return s.numericValue;
  // OCPP 1.6 lässt die Einheit weg, wenn sie Wh ist (die Vorgabe des Standards).
  if (unit === 'wh' || unit === '') return s.numericValue / 1000;
  return null;
}

/**
 * `max − min` über die Zeitreihe — aber NUR, wenn sie nirgends fällt.
 *
 * ⚠ Die Monotonie-Prüfung ist der ganze Punkt und ersetzt einen wirkungslosen
 * Vorzeichen-Test: bei einem zurückgesetzten Zähler ist die nackte Differenz
 * positiv und trotzdem falsch.
 */
function registerZuwachs(roh: { t: number; kwh: number }[]): number | null {
  if (roh.length < 2) return null;
  const reihe = [...roh].sort((a, b) => a.t - b.t);
  for (let i = 1; i < reihe.length; i += 1) {
    if (reihe[i].kwh < reihe[i - 1].kwh) return null;
  }
  const zuwachs = reihe[reihe.length - 1].kwh - reihe[0].kwh;
  return Number.isFinite(zuwachs) && zuwachs >= 0 ? round3(zuwachs) : null;
}

/**
 * Welche KOMPONENTEN (Entitäts-Ids) die Aufschlüsselung gerade zeigt und
 * deshalb eine Tagessumme brauchen.
 *
 * ⚠ Ausschliesslich Teile mit `entityId`, die KEIN Ladepunkt sind: die
 * Ladepunkt-Zeilen bekommen ihre Zahl aus dem Register (ein Abruf für alle),
 * eine Entitäts-Historie je Säule wäre ein zweiter Lesepfad auf dieselbe Frage.
 */
export function gemesseneEntitaeten(
  komposition: VerbrauchKomposition | null | undefined,
): string[] {
  if (!komposition) return [];
  const ids = new Set<string>();
  for (const g of komposition.gruppen) {
    for (const t of g.teile) {
      if (!t.entityId) continue;
      if (t.key.startsWith('cp:')) continue;
      ids.add(t.entityId);
    }
  }
  return [...ids];
}

/** Hat diese Anlage überhaupt einen Ladepunkt (⇒ lohnt der Register-Abruf)? */
export function hatLadepunkt(chargers: ChargePoint[] | null | undefined): boolean {
  return (chargers?.length ?? 0) > 0;
}
