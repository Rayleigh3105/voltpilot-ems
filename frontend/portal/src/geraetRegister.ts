/**
 * D · GELESENE REGISTER (Anlagen-Zentrale Stufe 1 PR 1d, Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` §7.3).
 *
 * <p>„Was liest die Box von diesem Gerät - roh und dekodiert, jeder Wert mit
 * seiner Frische." Diese Stufe baut die Sicht **aus dem Bestand**: kein
 * Backend, kein Edge-Release, keine zweite Lesung. Sie fügt zusammen, was drei
 * schon vorhandene Lesepfade je Gerät hergeben.
 *
 * <p><b>⚠ DIE EHRLICHKEITSREGELN SIND DER GRUND, WARUM DIE TABELLE SO
 * LÜCKENHAFT AUSSIEHT - und sie dürfen nicht „aufgefüllt" werden:</b>
 *
 * <ul>
 *   <li><b>Roh wird NIE zurückgerechnet.</b> Aus „33,0 kW" liesse sich zwar
 *       `3300` errechnen, sobald man die Skala kennt - aber das wäre eine
 *       Behauptung über ein Wort, das nie über die Leitung kam. „—" ist hier
 *       ein gültiger Wert.</li>
 *   <li><b>Ein Wort ohne bekannte Skala bleibt roh, ohne Einheit.</b> Ein
 *       erfundenes „kW" hinter einer Zahl aus einem unbekannten Register ist die
 *       gefährlichste Beschriftung dieses Pfades.</li>
 *   <li><b>Ein Gerät, das schweigt, behält seinen letzten Wert MIT dem alten
 *       Datum</b> - nie eine Null und nie eine frische Zeit.</li>
 *   <li><b>Ohne bekannte Familie gibt es keinen NAMEN</b>, nur die Adresse:
 *       dieselbe Adresse heisst auf einer anderen Baureihe etwas anderes
 *       (`hybrid_3p` 0x00E7 gegen `hybrid_1p` 0x00F5).</li>
 * </ul>
 *
 * <p><b>Die GRENZE, die jede Oberfläche kennen muss:</b> heute reisen die
 * ROHWÖRTER ausschliesslich mit einem Schreibvorgang (`before_raw`/`after_raw`
 * im Journal). Die Telemetrie-Register liefern nur dekodierte Werte, weil der
 * Uplink dafür noch nicht existiert (PR 1e) - die Sektion SAGT das, statt eine
 * leere Spalte unerklärt zu lassen.
 */
import type {
  DeviceExportLimit,
  RegisterKnowledgeFamily,
  RegisterWriteEvent,
  SiteSource,
} from './api';
import { fmtNum, fmtRelative } from './format';
import { NO_DATA } from './nodata';

/** Woher eine Zeile kommt - das Wort steht an der Zeile, nie nur die Farbe. */
export type RegisterQuelle = 'taeglich' | 'schreibvorgang' | 'telemetrie';

export const QUELLE_WORT: Record<RegisterQuelle, string> = {
  taeglich: 'Täglich gelesen',
  schreibvorgang: 'Beim Schreibvorgang gelesen',
  telemetrie: 'Laufende Messung',
};

export interface RegisterZeile {
  key: string;
  /** Die Adresse („0x00E7"), oder null - dann ist sie schlicht nicht bekannt. */
  register: string | null;
  /** Der Name aus dem Register-Wissen bzw. der Messwert-Name. */
  bedeutung: string;
  /** Die Warnklasse des Register-Wissens (nur wo bekannt). */
  klasse: string | null;
  /** Das Rohwort - „—", wo keines vorliegt (nie zurückgerechnet). */
  roh: string;
  /** Der dekodierte Wert mit Einheit - „—", wo keiner vorliegt. */
  dekodiert: string;
  /** Wann gelesen wurde, relativ. */
  gelesen: string;
  quelle: RegisterQuelle;
}

export interface RegisterSicht {
  zeilen: RegisterZeile[];
  /** Der Satz über die leere Roh-Spalte - nur, wo sie wirklich leer ist. */
  hinweis: string | null;
  /** Warum nichts dasteht; null = es steht etwas da. */
  leer: string | null;
}

/** Der Satz für ein Gerät, das per Konstruktion keine Register hat. */
export const KEINE_REGISTER: Record<string, string> = {
  box: 'Ihre VoltPilot-Box ist ein Rechner, kein Modbus-Gerät - sie hat selbst '
    + 'keine Register. Was sie von Ihren Geräten liest, steht auf deren Seiten.',
  ladepunkt: 'Ladesäulen sprechen OCPP, nicht Modbus - hier gibt es keine '
    + 'Register, sondern Ladevorgänge.',
};

/**
 * Der Satz zur leeren Roh-Spalte. Er erscheint NUR, wenn wirklich keine Zeile
 * ein Rohwort trägt - sonst wäre er eine Behauptung über Werte, die dastehen.
 */
export const ROH_HINWEIS =
  'Rohwörter zeigt VoltPilot heute nur zu einem Schreibvorgang an - die '
  + 'laufenden Messungen kommen bereits umgerechnet an.';

export interface RegisterSichtInput {
  /** `box` · `hauptgeraet` · `quelle` · `ladepunkt`. */
  art: string;
  /** Die vom Gerät gelesene Einspeisegrenze (nur am Wechselrichter). */
  exportLimit?: DeviceExportLimit | null;
  /** Die Schreibvorgänge DIESES Geräts (schon gefiltert). */
  writes?: RegisterWriteEvent[] | null;
  /** Der Messwert-Eintrag dieses Geräts aus `/sources`. */
  source?: SiteSource | null;
  /** Die Register-Familie dieses Geräts - ohne sie gibt es keinen Namen. */
  familie?: string | null;
  knowledge?: RegisterKnowledgeFamily[] | null;
  now: number;
}

export function registerSicht(input: RegisterSichtInput): RegisterSicht {
  const feste = KEINE_REGISTER[input.art];
  if (feste) {
    return { zeilen: [], hinweis: null, leer: feste };
  }
  const zeilen: RegisterZeile[] = [];
  const wissen = familienWissen(input.familie, input.knowledge);

  // 1 · Die täglich gelesene Einspeisegrenze - der EINE dekodierte Wert, der
  //     seine Adresse UND seine eigene Lesezeit mitbringt.
  if (input.exportLimit) {
    const k = registerWissen(wissen, input.exportLimit.register);
    zeilen.push({
      key: `limit:${input.exportLimit.register}`,
      register: hexOben(input.exportLimit.register),
      bedeutung: k?.label ?? 'Einspeisegrenze im Gerät',
      klasse: k?.clazz ?? null,
      // ⚠ NICHT aus kW × Skala zurückgerechnet - das Wort kam nie an.
      roh: NO_DATA,
      dekodiert: fmtNum(input.exportLimit.limitKw, 'kW'),
      gelesen: fmtRelative(input.exportLimit.readAt, new Date(input.now)),
      quelle: 'taeglich',
    });
  }

  // 2 · Die Rohwörter der Schreibvorgänge - heute die EINZIGEN, die es gibt.
  for (const w of input.writes ?? []) {
    const roh = w.afterRaw ?? w.beforeRaw;
    if (roh == null) continue;
    zeilen.push({
      key: `write:${w.id}`,
      register: w.addressHex ? hexOben(w.addressHex) : null,
      bedeutung: w.registerLabel ?? 'Register ohne bekannten Namen',
      klasse: w.registerClass ?? null,
      roh: String(roh),
      // Ohne bekannte Skala bleibt es beim Rohwort - nie eine erfundene Einheit.
      dekodiert: w.scaleNote ? ausVermerk(w.scaleNote) : NO_DATA,
      gelesen: fmtRelative(w.answeredAt ?? w.requestedAt, new Date(input.now)),
      quelle: 'schreibvorgang',
    });
  }

  // 3 · Die laufenden Messungen - dekodiert, ohne Adresse (welches Register
  //     dahinter steckt, weiss heute nur die Box).
  for (const m of messwerte(input.source)) {
    zeilen.push({
      key: `mess:${m.key}`,
      register: null,
      bedeutung: m.label,
      klasse: null,
      roh: NO_DATA,
      dekodiert: m.wert,
      gelesen: fmtRelative(input.source?.readAt ?? null, new Date(input.now)),
      quelle: 'telemetrie',
    });
  }

  const hatRoh = zeilen.some((z) => z.roh !== NO_DATA);
  return {
    zeilen,
    hinweis: zeilen.length > 0 && !hatRoh ? ROH_HINWEIS : null,
    leer: zeilen.length === 0
      ? 'Für dieses Gerät liegen VoltPilot noch keine gelesenen Register vor.'
      : null,
  };
}

/** Die dekodierten Messwerte eines Geräts - ein fehlender fehlt, nie eine 0. */
function messwerte(s: SiteSource | null | undefined): {
  key: string; label: string; wert: string;
}[] {
  if (!s) return [];
  const out: { key: string; label: string; wert: string }[] = [];
  if (s.pvKw != null) {
    out.push({ key: 'pv', label: 'Solarleistung', wert: fmtNum(s.pvKw, 'kW') });
  }
  if (s.powerKw != null) {
    // Die Richtung ist ein WORT, nie ein Vorzeichen (die `live.ts`-Konvention).
    const wort = s.powerKw < 0 ? 'Einspeisung' : 'Bezug';
    out.push({
      key: 'grid',
      label: 'Netzleistung',
      wert: `${fmtNum(Math.abs(s.powerKw), 'kW')} ${wort}`,
    });
  }
  if (s.loadKw != null) {
    out.push({ key: 'load', label: 'Hausverbrauch', wert: fmtNum(s.loadKw, 'kW') });
  }
  return out;
}

/** Das Wissen ZU DIESER Familie - ohne sie gibt es keines (nie ein fremdes). */
function familienWissen(
  familie: string | null | undefined,
  knowledge: RegisterKnowledgeFamily[] | null | undefined,
): RegisterKnowledgeFamily | null {
  if (!familie) return null;
  return (knowledge ?? []).find((f) => f.family === familie) ?? null;
}

function registerWissen(f: RegisterKnowledgeFamily | null, hex: string) {
  if (!f) return null;
  const norm = hex.trim().toLowerCase();
  return f.registers.find((r) => r.addressHex.trim().toLowerCase() === norm) ?? null;
}

/** „0x00e7" → „0x00E7": die Zahl bleibt, nur die Schreibweise wird die des Hauses. */
function hexOben(hex: string): string {
  const t = hex.trim();
  return t.toLowerCase().startsWith('0x') ? `0x${t.slice(2).toUpperCase()}` : t.toUpperCase();
}

/**
 * Der dekodierte Wert eines Rohworts - **aus dem Vermerk des SERVERS gelesen,
 * nie selbst gerechnet**.
 *
 * <p>⚠ Das ist die Lehre eines echten Fehlgriffs (im Browser-Beweis gefunden):
 * die erste Fassung parste den Faktor aus dem Vermerk und DIVIDIERTE - der
 * Server MULTIPLIZIERT aber (`Rohwert × scale = Wert`, `RegisterKnowledge`),
 * und die Skala von `0x00E7` ist 0,01. Aus 7000 wurden so „700,0 kW" statt
 * „70,0 kW": eine zweite Decodier-Wahrheit, die schon beim ersten Blick von der
 * ersten abwich. Der Vermerk trägt den fertigen Wert; er wird nur noch
 * ABGELESEN, und wenn seine Form je abweicht, steht der ganze Vermerk da statt
 * einer erfundenen Zahl.
 */
function ausVermerk(scaleNote: string): string {
  const i = scaleNote.lastIndexOf('= ');
  const wert = i >= 0 ? scaleNote.slice(i + 2).trim() : '';
  return wert || scaleNote.trim();
}
