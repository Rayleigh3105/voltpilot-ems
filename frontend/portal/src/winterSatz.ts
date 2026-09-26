import { fmtNum } from './format';

/**
 * **Der Winter-Satz der Ergebnis-Karte** (Konzept `vp-erloese-minus-winter-k1`
 * §8, Captain 24.09.2026: E6 = A).
 *
 * An einem dunklen Tag ist die Anlage ein Stromkunde mit kleinem Solar-Anteil;
 * „Unterm Strich" bleibt dann rot, wenn es negativ ist — es sind echte
 * Stromkosten, und die Farbe darf nichts anderes sagen als das Zeichen. Der
 * Satz sagt, was die Sonne trotzdem gedeckt hat: „Wenig Sonne: 96 kWh erzeugt,
 * 91 kWh selbst genutzt." Kein „hätte", keine Hochrechnung.
 *
 * ⚠ **DIESELBE SCHWELLE WIE DER GRUND `wenig_sonne`**: PV unter 60 % des
 * Verbrauchs (`docs/contracts/steuerung-tag-vectors.json`, Block `grund`,
 * `wenig_sonne_unter_anteil`; `winterSatz.test.ts` liest sie dort). Zwei
 * Schwellen für „wenig Sonne" wären zwei Wahrheiten über denselben Tag.
 *
 * ⚠ **NUR ABGESCHLOSSENE ZEITRÄUME.** Morgens um neun liegt JEDER Tag unter
 * 60 % — der Satz würde an einem Sonnentag „wenig Sonne" behaupten. Der
 * laufende Tag bekommt deshalb keinen Satz; den Grund „wenig Sonne" unter der
 * Steuerungs-Zahl entscheidet ohnehin der Server.
 */
export const WENIG_SONNE_ANTEIL = 0.6;

export interface WinterSatzEingabe {
  /** Erzeugung des Zeitraums (`history.totals.pvGenerationKwh`). */
  pvKwh: number | null | undefined;
  /** Verbrauch des Zeitraums (`history.totals.consumptionKwh`). */
  verbrauchKwh: number | null | undefined;
  /** Davon selbst genutzt (`selbstverbrauchKwh` der Erlös-Antwort). */
  selbstGenutztKwh: number | null | undefined;
  /** true = der Zeitraum läuft noch — dann kein Satz. */
  laeuft: boolean;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Ganze kWh ab 10, darunter eine Nachkommastelle — „96 kWh", „4,2 kWh". */
function kwh(v: number): string {
  return fmtNum(v, 'kWh', Math.abs(v) >= 10 ? 0 : 1);
}

/** Der Satz, oder `null`, wenn die Sonne gereicht hat oder etwas fehlt. */
export function winterSatz(e: WinterSatzEingabe): string | null {
  if (e.laeuft) return null;
  const pv = num(e.pvKwh);
  const last = num(e.verbrauchKwh);
  if (pv == null || last == null || last <= 0) return null;
  if (pv >= WENIG_SONNE_ANTEIL * last) return null;
  if (pv < 0.05) return 'Wenig Sonne: kein Solarstrom erzeugt.';
  const selbst = num(e.selbstGenutztKwh);
  if (selbst == null) return `Wenig Sonne: ${kwh(pv)} erzeugt.`;
  // Gleich nach Rundung heißt: alles, was die Sonne gab, blieb im Haus.
  if (kwh(Math.min(selbst, pv)) === kwh(pv)) return `Wenig Sonne: ${kwh(pv)} erzeugt, alles selbst genutzt.`;
  return `Wenig Sonne: ${kwh(pv)} erzeugt, ${kwh(selbst)} selbst genutzt.`;
}
