import { BOX_SZENE_SVG } from './boxZeichnungSvg';
import './BoxZeichnung.css';

/** Wo das Netzwerkkabel bzw. das Netzteil an der Box steckt (Abschnitt 7.1 Prüf-Hilfe). */
const PORT_PUNKTE: Record<'wan' | '5v', { cx: number; cy: number }> = {
  wan: { cx: 211.8, cy: 139.3 },
  '5v': { cx: 316.8, cy: 197.0 },
};

/**
 * Die echte Box, isometrisch, mit Netzwerkkabel zum Router und Netzteil zur
 * Steckdose - dieselbe Zeichnung wie auf dem Konzept-Board (Abschnitt 6.1/7.1),
 * aus der echten Geometrie des Gehäuse-Programms. Das Logo leuchtet erst, wenn
 * die Box online ist (`online`); `hervorheben` zeigt an der Prüf-Hilfe ab 5:00
 * auf die betroffene Buchse (5V oder WAN) - nie auf mehr, als das Portal weiß.
 */
export function BoxZeichnung({
  online,
  hervorheben = null,
}: {
  online: boolean;
  hervorheben?: 'wan' | '5v' | null;
}) {
  const punkt = hervorheben ? PORT_PUNKTE[hervorheben] : null;
  return (
    <svg
      className={`vpb${online ? ' is-online' : ''}`}
      viewBox="0 0 480 345"
      role="img"
      aria-label="Ihre VoltPilot-Box, verkabelt mit Netzteil und Router"
    >
      <defs>
        <filter id="vpb-weich">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <radialGradient id="vpb-halo-verlauf">
          <stop offset="0%" stopColor="#95b9ff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#95b9ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* eslint-disable-next-line react/no-danger -- statische, selbst erzeugte Geometrie, keine Nutzereingabe */}
      <g dangerouslySetInnerHTML={{ __html: BOX_SZENE_SVG }} />
      {punkt && <circle className="vpb-hervorheben" cx={punkt.cx} cy={punkt.cy} r={22} />}
    </svg>
  );
}
