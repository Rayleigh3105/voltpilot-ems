/**
 * Exakte Dezimalzahlen für das Portal (UEMS AP-09 IP-3).
 *
 * Der Java-Zwilling rechnet mit `BigDecimal` — einer Klasse des JDK, die kein
 * Modul stellt. Diese Datei ist ihr TypeScript-Gegenstück: ein Betrag ist eine
 * ganzzahlige Mantisse mit einer Zehnerstelle, damit keine Rechnung einen
 * Binärbruch-Fehler erbt. `0.1 + 0.2` ist hier nicht `0.30000000000000004`, und
 * `312,4 t` sind genau `312400 kg`, nicht `312399.99999999994`.
 *
 * Sie steht neben `bezugsEinheit.ts` und `bezugsdaten.ts` statt in einer von
 * beiden, damit es die Rechnung nur EINMAL gibt und keine der beiden Dateien
 * die andere anrufen muss.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

/** Ein Betrag als ganzzahlige Mantisse: der Wert ist `z / 10^e`. */
export type Dez = { z: bigint; e: number };

const zehn = (n: number): bigint => 10n ** BigInt(n);

/** Dezimaltext (mit Punkt) → Betrag. Alles andere ist ein Programmfehler, kein Befund. */
export const dez = (text: string): Dez => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`kein Dezimaltext: ${text}`);
  const bruch = m[3] ?? '';
  return { z: BigInt(`${m[1]}${m[2]}${bruch}`), e: bruch.length };
};

export const dezVon = (n: number): Dez => dez(String(n));

/** Kaufmännische Rundung einer Division — die Rundung, die `BigDecimal.HALF_UP` macht. */
export const halbAuf = (zaehler: bigint, nenner: bigint): bigint => {
  const negativ = zaehler < 0n !== nenner < 0n;
  const a = zaehler < 0n ? -zaehler : zaehler;
  const b = nenner < 0n ? -nenner : nenner;
  const ganz = a / b;
  const rest = a % b;
  const auf = rest * 2n >= b ? ganz + 1n : ganz;
  return negativ ? -auf : auf;
};

/** Auf `stellen` Nachkommastellen, kaufmännisch gerundet. */
export const dezRunde = (d: Dez, stellen: number): Dez =>
  stellen >= d.e ? { z: d.z * zehn(stellen - d.e), e: stellen } : { z: halbAuf(d.z, zehn(d.e - stellen)), e: stellen };

/** Mal `10^potenz` — exakt, ohne Rundung (t → kg ist potenz 3). */
export const dezSkaliere = (d: Dez, potenz: number): Dez =>
  potenz >= d.e ? { z: d.z * zehn(potenz - d.e), e: 0 } : { z: d.z, e: d.e - potenz };

/** Geteilt durch eine ganze Zahl, auf `stellen` gerundet. */
export const dezTeile = (d: Dez, teiler: number, stellen: number): Dez => ({
  z: halbAuf(d.z * zehn(stellen), BigInt(teiler) * zehn(d.e)),
  e: stellen,
});

export const dezVergleich = (a: Dez, b: Dez): number => {
  const e = Math.max(a.e, b.e);
  const x = a.z * zehn(e - a.e);
  const y = b.z * zehn(e - b.e);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Gleich heißt: gleich auf `stellen` Nachkommastellen. Die Stellenzahl steht im
 * Vertrag (`vergleich_nachkommastellen`) und wird deshalb ÜBERGEBEN, nie hier
 * festgelegt — diese Datei kennt keinen Vertrag.
 */
export const dezGleich = (a: Dez, b: Dez, stellen: number): boolean =>
  dezVergleich(dezRunde(a, stellen), dezRunde(b, stellen)) === 0;

/** Der Betrag als Dezimaltext mit Punkt — die Form, in der er im Vertrag steht. */
export const dezText = (d: Dez): string => {
  const negativ = d.z < 0n;
  const ziffern = (negativ ? -d.z : d.z).toString().padStart(d.e + 1, '0');
  const ganz = ziffern.slice(0, ziffern.length - d.e);
  const bruch = d.e > 0 ? `.${ziffern.slice(ziffern.length - d.e)}` : '';
  return `${negativ ? '-' : ''}${ganz}${bruch}`;
};

/** Der Anteil `teil / ganz` in Prozent, auf `stellen` gerundet. */
export const dezProzent = (teil: number, ganz: number, stellen: number): Dez =>
  ganz === 0 ? { z: 0n, e: stellen } : { z: halbAuf(BigInt(teil) * 100n * zehn(stellen), BigInt(ganz)), e: stellen };
