/**
 * Eine Liste nur, wenn es wirklich eine ist. Eine Antwort in anderer Form
 * (älteres Backend, leeres Objekt statt Liste) gilt als leer - sie darf die
 * Seite nie zum Absturz bringen.
 */
export function liste<T>(x: readonly T[] | null | undefined): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}
