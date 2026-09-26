/**
 * Die Relais-Ausgänge der I/O-Module einer Anlage als Schaltweg-Angebot für
 * einen neuen Verbraucher (Ebyte M31: EIN Gerät, N Ausgänge, jeder Ausgang
 * schaltet genau EINEN Verbraucher).
 *
 * Rein: die Fläche rendert nur, was hier abgeleitet wird.
 *
 * ⚠ Angeboten wird nur, was das Modul GEMELDET hat. Solange es keine Ausgänge
 * gemeldet hat (`outputs === null`), wird keine geratene „8" angeboten - die
 * Box liest den Modul-Stapel erst nach dem Anlegen, und Erweiterungsmodule
 * ändern die Zahl.
 */
import type { IoModuleOption } from './types';

/** Der Picker-Wert eines Ausgangs: `io:<Modul-Entität>:<Ausgang>`. */
export function ioAusgangWert(entityId: string, channel: number): string {
  return `io:${entityId}:${channel}`;
}

/** Liest einen Picker-Wert zurück; `null`, wenn er keinen Ausgang meint. */
export function ioAusgangAus(wert: string): { ioEntityId: string; ioChannel: number } | null {
  const m = /^io:([^:]+):(\d+)$/.exec(wert);
  if (!m) return null;
  const channel = Number(m[2]);
  return channel >= 1 ? { ioEntityId: m[1], ioChannel: channel } : null;
}

export interface IoAusgangOption {
  value: string;
  label: string;
  sub?: string;
}

/** Die FREIEN Ausgänge aller gemeldeten I/O-Module, je Modul in Ausgangs-Reihenfolge. */
export function ioAusgangOptionen(modules: IoModuleOption[] | undefined): IoAusgangOption[] {
  const out: IoAusgangOption[] = [];
  for (const m of modules ?? []) {
    if (m.outputs == null || m.outputs < 1) continue;
    const belegt = new Set(m.used.map((u) => u.channel));
    const name = m.label?.trim() || 'I/O-Modul';
    for (let ch = 1; ch <= m.outputs; ch++) {
      if (belegt.has(ch)) continue;
      out.push({
        value: ioAusgangWert(m.entityId, ch),
        label: `${name} · Ausgang DO${ch}`,
        sub: 'Relais-Ausgang · ohne Leistungsmessung (Energie wird angenommen)',
      });
    }
  }
  return out;
}

/**
 * Der ehrliche Satz zu Modulen, die (noch) keine Ausgänge gemeldet haben -
 * `null`, wenn es keine solchen gibt.
 */
export function ioOhneMeldungHinweis(modules: IoModuleOption[] | undefined): string | null {
  const stumm = (modules ?? []).filter((m) => m.outputs == null);
  if (stumm.length === 0) return null;
  const namen = stumm.map((m) => m.label?.trim() || 'I/O-Modul').join(', ');
  return `${namen}: noch keine Ausgänge gemeldet. Sobald die Box das Modul liest, `
    + 'lassen sich seine Ausgänge hier zuordnen.';
}
