/**
 * Ladestand aus der Batteriespannung SCHÄTZEN - die reine Fläche-Schicht.
 *
 * <b>Der Anlass</b> (Live-Fall Mühlfeldweg 2): ein Deye-Hybrid, dessen Batterie
 * im Modus „User defined" (spannungsbasiert, ohne BMS-Kopplung) läuft, meldet
 * im SoC-Register dauerhaft exakt 0. Der Kunde konnte die Anlage seit dem
 * Ausweg „Trotzdem fortfahren (nur Lesen)" zwar anlegen - aber ganz OHNE
 * Ladestand. Trägt er die zwei Eckpunkte seines Speichers ein, schätzt die Box
 * ihn aus der GEMESSENEN Klemmenspannung.
 *
 * <b>⚠ Es ist eine SCHÄTZUNG, und die Fläche sagt das.</b> Bei LiFePO4 ist die
 * Zellkennlinie zwischen etwa 20 % und 90 % nahezu flach, und unter Last
 * verschiebt der Innenwiderstand die Klemmenspannung zusätzlich - der Wert ist
 * ein Anhaltspunkt, keine Messung. Deshalb bleibt die Steuerung des Speichers
 * auch mit Schätzung AUS: der Verbindungstest weist den fehlenden Kanal
 * unverändert aus, die Komponente behält ihren Beleg, und der Server verweigert
 * die Scharfschaltung. Beides steht in `folgen` und wird dem Kunden gezeigt.
 *
 * <b>⚠ Die Grenzen sind ein ZWILLING</b> von `SocFromVoltageBounds` (api) und
 * `inverter.SocFromVoltage.validate` (Box) - dieselben Zahlen, drei Laufzeiten.
 * Wer sie hier ändert, ändert sie dort mit.
 */

/** Der Schlüssel in der Verbindung - Vertrag mit Box und Decoder. */
export const SOC_VOLTAGE_KEY = 'soc_from_voltage';

/**
 * Das Band, in dem eine Batterie-Klemmenspannung liegen kann. Bewusst WEIT: es
 * muss einen 48-V-Speicher (~40..60 V) und einen Hochvolt-Strang (~100..1000 V)
 * mit DERSELBEN Regel tragen - das Portal kennt die Bauart nicht besser als der
 * Kunde. Gefangen wird nur, was gar keine Batterie sein kann (Millivolt statt
 * Volt, ein Prozentwert, eine Ziffer zu viel).
 */
export const SOC_VOLTAGE_MIN = 10;
export const SOC_VOLTAGE_MAX = 1000;

/**
 * Der kleinste brauchbare Abstand. Darunter wird die Interpolation zur
 * Stufenfunktion (und bei 0 zur Division durch null).
 */
export const SOC_VOLTAGE_MIN_SPAN = 0.5;

export type SocVoltageEingabe = { leer: string; voll: string };

/** Die zwei Felder, generisch gerendert wie jedes andere Formularfeld. */
export const SOC_VOLTAGE_FELDER = [
  {
    id: 'soc-v-empty' as const,
    key: 'leer' as const,
    label: 'Spannung bei 0 % (leer)',
    hilfe: 'Die Entladeschlussspannung aus dem Datenblatt Ihres Speichers.',
    platzhalter: 'z. B. 48,0',
  },
  {
    id: 'soc-v-full' as const,
    key: 'voll' as const,
    label: 'Spannung bei 100 % (voll)',
    hilfe: 'Die Ladeschlussspannung aus dem Datenblatt Ihres Speichers.',
    platzhalter: 'z. B. 56,4',
  },
];

/** Die Überschrift + der eine erklärende Satz der Fläche. */
export const SOC_VOLTAGE_TITEL = 'Ladestand aus der Batteriespannung schätzen';
export const SOC_VOLTAGE_INTRO =
  'Ihr Wechselrichter misst die Spannung Ihres Speichers - daraus können wir den '
  + 'Ladestand schätzen. Tragen Sie dafür die zwei Eckpunkte aus dem Datenblatt ein.';

/**
 * Was die Schätzung bewirkt - und was sie ausdrücklich NICHT bewirkt. Sie steht
 * direkt an den Feldern, damit niemand sie für eine Messung hält.
 */
export const SOC_VOLTAGE_FOLGEN = [
  'Der Ladestand wird als Schätzung angezeigt und aufgezeichnet.',
  'Bei LiFePO4 ist die Kennlinie im mittleren Bereich sehr flach - dort ist die '
    + 'Schätzung grob; unter Last verfälscht sie zusätzlich.',
  // ⚠ Bewusst ANDERS formuliert als die Folgenliste der Rückfrage daneben: sie
  // sagen dieselbe Sache, aber wortgleich nebeneinander wäre es Rauschen - und
  // hier ist der GRUND der interessante Teil (eine Schätzung reicht dafür nicht).
  'Gesteuert wird Ihr Speicher dadurch nicht: dafür braucht VoltPilot einen '
    + 'echten Wert vom BMS - eine Schätzung genügt zum Schützen nicht.',
  'Sobald das BMS gekoppelt ist, gewinnt sein Wert automatisch - die Schätzung '
    + 'überschreibt ihn nie.',
];

/** Eine leere Eingabe (der Normalfall: fast keine Anlage braucht das). */
export function leereEingabe(): SocVoltageEingabe {
  return { leer: '', voll: '' };
}

/** Ob überhaupt etwas eingegeben wurde. Leer = keine Schätzung, kein Fehler. */
export function istLeer(e: SocVoltageEingabe): boolean {
  return e.leer.trim() === '' && e.voll.trim() === '';
}

/**
 * Eine deutsche Zahl („48,0") oder eine englische („48.0") als Zahl, sonst
 * `null`. Ein Formularfeld liefert Text, und ein deutsches Komma darf keine
 * Ablehnung sein.
 */
export function zahl(v: string): number | null {
  const t = v.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Der deutsche Grund, warum diese Eingabe (noch) nicht taugt - oder `null`.
 *
 * DIESELBEN Urteile wie `SocFromVoltageBounds.refusal` (api) und
 * `inverter.SocFromVoltage.validate` (Box); sie ist die freundliche, sofortige
 * Hälfte, nicht die autoritative.
 */
export function fehler(e: SocVoltageEingabe): string | null {
  if (istLeer(e)) return null;
  const leer = zahl(e.leer);
  const voll = zahl(e.voll);
  if (leer === null || voll === null) {
    return 'Bitte geben Sie beide Spannungen an - aus einer allein lässt sich der '
      + 'Ladestand nicht schätzen.';
  }
  const ausserhalb = (v: number) => v < SOC_VOLTAGE_MIN || v > SOC_VOLTAGE_MAX;
  if (ausserhalb(leer) || ausserhalb(voll)) {
    return `Die Spannungen müssen zwischen ${SOC_VOLTAGE_MIN} und ${SOC_VOLTAGE_MAX} Volt `
      + 'liegen. Bitte prüfen Sie die Angaben aus dem Datenblatt Ihres Speichers.';
  }
  if (voll - leer < SOC_VOLTAGE_MIN_SPAN) {
    return 'Die Spannung bei 100 % muss über der bei 0 % liegen.';
  }
  return null;
}

/**
 * Was in die Verbindung geschrieben wird - oder `undefined`, wenn nichts (oder
 * nichts Brauchbares) eingegeben wurde. Es wird NIE ein halbes Paar gespeichert.
 */
export function verbindungsWert(
  e: SocVoltageEingabe,
): { v_empty: number; v_full: number } | undefined {
  if (istLeer(e) || fehler(e) !== null) return undefined;
  const leer = zahl(e.leer);
  const voll = zahl(e.voll);
  if (leer === null || voll === null) return undefined;
  return { v_empty: leer, v_full: voll };
}

/** Die gespeicherten Eckpunkte zurück ins Formular (Bearbeiten-Weg). */
export function ausVerbindung(verbindung: Record<string, unknown>): SocVoltageEingabe {
  const raw = verbindung?.[SOC_VOLTAGE_KEY];
  if (!raw || typeof raw !== 'object') return leereEingabe();
  const o = raw as Record<string, unknown>;
  const fmt = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? String(v).replace('.', ',') : '';
  return { leer: fmt(o.v_empty), voll: fmt(o.v_full) };
}

/**
 * Der Satz, den der Verbindungstest zeigt, sobald die Box eine Schätzung
 * ANBIETET - die Rückmeldung, an der der Kunde seine Eingabe kalibriert
 * („636,0 V → 36 %"). Ohne Beleg der Box steht hier NICHTS: eine Schätzung, die
 * das Gerät nicht gerechnet hat, würde die Fläche nie erfinden.
 */
export function schaetzungSatz(
  befund: { estimate?: { socPct?: number | null; voltageV?: number | null } | null } | null
    | undefined,
): string | null {
  const est = befund?.estimate;
  if (!est) return null;
  const soc = est.socPct;
  const volt = est.voltageV;
  if (typeof soc !== 'number' || !Number.isFinite(soc)) return null;
  if (typeof volt !== 'number' || !Number.isFinite(volt)) return null;
  const v = volt.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  const p = soc.toLocaleString('de-DE', { maximumFractionDigits: 0 });
  return `Aus der gemessenen Batteriespannung (${v} V) geschätzt: ${p} % Ladestand.`;
}

/**
 * Der Hinweis, wenn Eckpunkte eingetragen sind, die Box aber (noch) keine
 * Schätzung liefert - „testen Sie erneut" statt stiller Wirkungslosigkeit.
 */
export const SOC_VOLTAGE_ERNEUT_TESTEN =
  'Prüfen Sie die Verbindung erneut, damit wir die Schätzung mit Ihren Angaben zeigen können.';
