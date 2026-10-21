import type { ReactElement } from 'react';
import type { EreignisArt } from '../../historieEreignisse';

/**
 * **Das Symbol einer Ereignis-Art** (Konzept `data/vp-verlauf-ereignisse-k1`):
 * die Farbe sagt den BEREICH (Markt, Netz, PV, Daten), das Symbol die ART
 * darin. Strichzeichnungen im 24er-Raster, Farbe über `currentColor` aus der
 * Bereichsklasse (`is-markt` …, `EnergieSeite.css`).
 */
const PFADE: Record<EreignisArt, ReactElement> = {
  // Kurve nach unten: der Preis fällt unter null.
  negativpreis: (
    <>
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
      <polyline points="16 17 22 17 22 11" />
    </>
  ),
  // Sonne unter einem Deckel: die Einspeisung wird begrenzt.
  abregelung: (
    <>
      <path d="M3 4h18" />
      <circle cx="12" cy="14" r="4" />
      <path d="M12 8v1M12 20v1M6.3 8.3l.7.7M17 19l.7.7M4 14h1M19 14h1M6.3 19.7l.7-.7M17 9l.7-.7" />
    </>
  ),
  // Messuhr: der Netzbetreiber gibt eine Grenze vor.
  netzgrenze: (
    <>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </>
  ),
  // Akku mit Blitz: der Speicher lädt aus dem Netz.
  netzladen: (
    <>
      <path d="M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" />
      <path d="M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1" />
      <path d="m11 7-3 5h4l-3 5" />
      <path d="M22 11v2" />
    </>
  ),
  // Sonnenuntergang: der Verkauf am Abend.
  abendverkauf: (
    <>
      <path d="M12 10V2" />
      <path d="m16 6-4 4-4-4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
      <path d="M2 18h2M20 18h2M22 22H2M4.93 10.93l1.41 1.41M19.07 10.93l-1.41 1.41" />
    </>
  ),
  // Unterbrochene Messkurve: hier fehlen Werte.
  datenluecke: (
    <>
      <path d="M2 12h4l2-5" />
      <path d="m11 17 1.5-4" />
      <path d="M16 12h2l1.5 4L22 12" />
    </>
  ),
  // Ein/Aus: das Gerät meldet sich nicht.
  'geraet-still': (
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </>
  ),
  // Strommast: der Netzbetreiber gibt eine Vorgabe (EZ-9).
  netzbetreiber: (
    <>
      <path d="M12 2v20" />
      <path d="M2 5h20" />
      <path d="M3 3v2M7 3v2M17 3v2M21 3v2" />
      <path d="m19 5-7 7-7-7" />
    </>
  ),
  // Funk: der Direktvermarkter ruft aus der Ferne ab.
  direktvermarkter: (
    <>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </>
  ),
  // Durchgestrichener Kreis: die Einheit ist nicht bereit.
  'nicht-bereit': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
};

export function EreignisSymbol({ art, className }: { art: EreignisArt; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PFADE[art]}
    </svg>
  );
}
