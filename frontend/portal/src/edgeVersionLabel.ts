/**
 * Der gemeldete Software-Stempel einer Box als **Tag + Build** - die EINE
 * Aufbereitung, die Betreiber- UND Kundenflächen teilen.
 *
 * Sie lebte bis zur BOX-Seite (Geräteseiten Stufe 1) in `onboardingFunnel.ts`,
 * also in einer reinen ADMIN-Schicht. Seit die Kunden-Box-Seite denselben
 * Stempel zeigt, wohnt sie neutral: eine Kundenfläche darf eine Admin-Schicht
 * nicht importieren (Copy-Wächter), und zwei Aufbereitungen desselben Stempels
 * wären zwei Schreibweisen für denselben Stand.
 */

/**
 * Der gemeldete Stempel als **Tag + Build** statt als Rohstring.
 *
 * `edge-2026.08.0-3bf8c038e1d2` neben `edge-2026.08.0` sind zwei verschieden
 * AUSSEHENDE Zeichenketten für „läuft das Soll" (UX-Konzept §3 Befund F). Die
 * Daten sind richtig - es fehlte die Aufbereitung.
 *
 * Getrennt wird nach der PRÄFIX-Regel des Hauses (`releaseIsRunning`, der
 * Zwilling von `otaverify.ReleaseIsRunning` und `RolloutStates`): nur was
 * wirklich `<release>-<sha>` ist, wird zerlegt. Ein Bestandsbau mit nackter
 * SHA bleibt VERBATIM - ihn zu zerlegen erfände ein Release-Tag, mit dem er
 * nie gebaut wurde.
 */
export function versionDisplay(
  stamp: string | null | undefined,
  releases: { version: string }[] = [],
): { tag: string; build: string | null } | null {
  if (!stamp || !stamp.trim()) return null;
  const s = stamp.trim();
  for (const r of releases) {
    if (r.version && s.startsWith(`${r.version}-`)) {
      return { tag: r.version, build: s.slice(r.version.length + 1) };
    }
    if (r.version === s) return { tag: s, build: null };
  }
  return { tag: s, build: null };
}

/** „edge-2026.08.0 (Build 3bf8c038)" - der Stempel in EINEM Wort. */
export function versionLabel(
  stamp: string | null | undefined,
  releases: { version: string }[] = [],
): string {
  const v = versionDisplay(stamp, releases);
  if (!v) return '–';
  // Der Build wird gekürzt: die ersten acht Zeichen identifizieren ihn
  // eindeutig genug, und die vollen zwölf verdrängen in einer schmalen Spalte
  // das Tag, das die eigentliche Aussage ist.
  return v.build ? `${v.tag} (Build ${v.build.slice(0, 8)})` : v.tag;
}
