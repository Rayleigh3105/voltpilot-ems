/**
 * Das GESICHT einer Anlage, gemerkt fuer den naechsten Besuch - damit Welle 3
 * mit Welle 2 startet (Perf-Review `vp-cockpit-perf-p7` §3 B1).
 *
 * **Der behobene Befund ist eine ETAPPE, kein langsamer Endpunkt.** Der Boot des
 * Cockpits laeuft in drei seriellen Wellen; die dritte (`/history`,
 * `/telemetry`) haengt an `showStack` und damit daran, dass `/entities` und
 * `/topology` aus Welle 2 GEANTWORTET haben (`pages/AnlagenPage.tsx`). Gemessen
 * wurde der reine Wellenabstand mit **~0,5 s bei Prod-Latenz** (~250 ms je
 * Roundtrip, also zwei serielle Etappen) - Zeit, in der nichts rechnet und
 * nichts laedt, sondern gewartet wird.
 *
 * **Was hier passiert und was ausdruecklich NICHT:** gemerkt wird die zuletzt
 * GERENDERTE Projektion je Anlage; beim naechsten Besuch starten die
 * Welle-3-Abrufe damit OPTIMISTISCH sofort mit Welle 2. Faellt die Entscheidung
 * danach anders aus, wird das Ergebnis VERWORFEN (die Abrufe kosten dann ein
 * bis zwei unnuetze Anfragen - billig gegen eine halbe Sekunde auf jedem Boot).
 * **Es wandert nur der STARTZEITPUNKT.** Jede Ehrlichkeitsregel bleibt, wo sie
 * ist: gerendert wird weiterhin ausschliesslich nach `showStack`/`isPeakLead`,
 * `decision === 'pending'` zeigt weiterhin `AnlagePending`, und kein Wert
 * erreicht eine Flaeche, bevor die echte Entscheidung gefallen ist.
 *
 * **⚠ Das ist NICHT der dokumentierte, gemessene und wieder entfernte
 * Vorgriff** (`AGENTS.md`: „Ein Vorgriff auf die Anlagen-Abrufe wurde GEMESSEN
 * und wieder ENTFERNT"). Der scheiterte daran, dass er FERTIG war, bevor die
 * Haken der Seite montiert waren - die In-flight-Buendelung griff nicht mehr,
 * und es blieben drei zusaetzliche Anfragen. Hier feuert derselbe Effekt an
 * derselben Stelle wie bisher, nur ohne auf ein Gate zu warten: die Haken sind
 * montiert, das Ergebnis landet in ihrem eigenen Zustand, und es entsteht
 * KEIN Ergebnis-Zwischenspeicher (also auch keine stille Veraltung).
 *
 * **⚠ `sessionStorage`, nie `localStorage`** (Haus-Regel): die Erinnerung gilt
 * der TAB-Sitzung. Ein neuer Tab zahlt seinen ersten Boot voll und hat den
 * schnellen Weg danach selbst - dasselbe Versprechen wie beim Token-Speicher.
 * Ein nicht verfuegbarer Speicher (privater Modus, SSR) ist kein Fehler: dann
 * gibt es einfach keine Spekulation (`useChartDetail`-Muster).
 */

/** Die gemerkte Projektion einer Anlage - genau die zwei Welle-3-Gates. */
export type AnlageFace = {
  /** Hat die Anlage zuletzt den Modul-Stapel gezeigt? (`/history`) */
  stack: boolean;
  /** Fuehrte das Cockpit zuletzt mit dem Peak-Band? (`/telemetry`) */
  peak: boolean;
};

/** Der Speicherschluessel EINER Anlage. */
export function faceKey(siteId: string): string {
  return `vp.face.${siteId}`;
}

/**
 * Die reine Lesart des gespeicherten Werts.
 *
 * Bewusst STRENG: alles, was nicht die erwartete Form hat (fehlend, kaputtes
 * JSON, fremde Felder, ein aelterer Stand), ist `null` = „nichts gemerkt" - und
 * damit exakt das Verhalten von vor B1. Eine halb gelesene Erinnerung wuerde
 * spekulieren, ohne zu wissen worauf.
 */
export function parseFace(stored: string | null): AnlageFace | null {
  if (stored == null) return null;
  try {
    const raw: unknown = JSON.parse(stored);
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.stack !== 'boolean' || typeof o.peak !== 'boolean') return null;
    return { stack: o.stack, peak: o.peak };
  } catch {
    return null;
  }
}

/** Die Serialisierung - stabile Schluesselreihenfolge, damit ein Vergleich taugt. */
export function serializeFace(face: AnlageFace): string {
  return JSON.stringify({ stack: face.stack, peak: face.peak });
}

/** Liest das gemerkte Gesicht; ein gesperrter Speicher heisst „nichts gemerkt". */
export function readFace(siteId: string): AnlageFace | null {
  try {
    return parseFace(sessionStorage.getItem(faceKey(siteId)));
  } catch {
    return null;
  }
}

/**
 * Merkt das Gesicht - aber nur, wenn es sich WIRKLICH geaendert hat.
 *
 * Der Aufrufer ruft das aus einem Effekt, der bei jedem Render laufen kann; ein
 * bedingungsloses `setItem` schriebe dann bei jedem Takt in den Speicher.
 */
export function rememberFace(siteId: string, face: AnlageFace): void {
  try {
    const key = faceKey(siteId);
    const next = serializeFace(face);
    if (sessionStorage.getItem(key) === next) return;
    sessionStorage.setItem(key, next);
  } catch {
    /* Speicher nicht verfuegbar - dann gibt es beim naechsten Mal keine Spekulation. */
  }
}

/**
 * Das GATE eines Welle-3-Abrufs: die echte Entscheidung, sonst - solange noch
 * keine gefallen ist - die Erinnerung.
 *
 * `decided` ist der Punkt, ab dem die Wahrheit gilt. Danach kann diese Funktion
 * nur noch `real` zurueckgeben, also verwirft eine abweichende Entscheidung die
 * Spekulation von selbst (der Effekt raeumt seinen Zustand in seinem
 * bestehenden `else`-Zweig auf).
 *
 * **⚠ Der Rueckgabewert gehoert in die Abhaengigkeitsliste des Effekts, nicht
 * `real`.** Dann aendert sich beim Uebergang „spekuliert und richtig geraten"
 * gar nichts (true → true) und es gibt KEINEN zweiten Abruf; nur ein Fehlgriff
 * (true → false) oder eine nicht spekulierte Anlage (false → true) loest neu
 * aus - beides genau wie vor B1.
 */
export function fetchGate(real: boolean, decided: boolean, guess: boolean | undefined): boolean {
  if (decided) return real;
  return guess === true;
}
