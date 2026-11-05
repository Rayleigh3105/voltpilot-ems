// Die Gesundheits-Abbildung der Kundenflächen als eigenes, winziges Modul: `livePuls.ts` (im
// Einstieg) braucht nur sie. Läge sie im Fach-Modul `komponenten.ts`, zöge dieser eine Aufruf
// das ganze Modul (5,6 kB gz) ins erste Bild (Bündel-Wächter `test/bundle-smoke.sh`).
// `komponenten.ts` reicht beides unverändert weiter.

/**
 * Live health of a device / component. `ok` / `stale` / `never` are the v2
 * entity states; **`unknown` is the H2 fix**: before it, `toHealth(undefined)`
 * returned `ok`, so on deploy day — when NO edge sends the E1b heartbeat and
 * `observed` is null for every component — every device reported a green
 * „verbunden" while the cockpit on the same plant said „Ihr Gerät meldet sich
 * nicht". A green dot on a dead device is worse than no dot, so an absent
 * report is now its own honest, grey state ("noch keine Rückmeldung").
 */
export type ComponentHealth = 'ok' | 'stale' | 'never' | 'unknown';

/**
 * The ONE health mapping of the customer surfaces (H2) — shared with the
 * Komponenten-Board (`livePuls.ts`) and the Verlauf rail (`verlauf.ts`) so a
 * dot can never mean two different things.
 *
 * **Only a literal `ok` is green.** Anything the backend does not (yet) report
 * — `undefined`, `null`, the honest `syncStatus: "unreported"`, an unknown
 * future word — becomes `unknown`, NOT `ok`. Fail-open on health is a lie.
 */
export function toComponentHealth(raw: string | null | undefined): ComponentHealth {
  if (raw === 'stale' || raw === 'never' || raw === 'ok') return raw;
  return 'unknown';
}
