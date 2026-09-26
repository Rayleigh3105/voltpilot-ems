/**
 * Die feste Uhr der Harness `erloese-minus` — VOR allen Portal-Modulen
 * geladen, damit jedes `new Date()` der Seite denselben Stichtag sieht
 * (`?jetzt=2026-09-24T19:58:00+02:00`). Zeitabhängige Beweise laufen nie
 * gegen die echte Uhr.
 */
const jetzt = new URLSearchParams(window.location.search).get('jetzt');
if (jetzt) {
  const fest = Date.parse(jetzt);
  const Echt = Date;
  class FesteUhr extends Echt {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fest);
      else super(...(args as [string]));
    }
    static now() {
      return fest;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = FesteUhr as unknown as DateConstructor;
}
export {};
