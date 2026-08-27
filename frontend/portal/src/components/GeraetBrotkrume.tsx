import { Icon } from '../../designsystem/components/core/Icon';
import './GeraetBrotkrume.css';

/**
 * Der EINE Rückweg einer Geräteseite: `Anlage › Komponenten › {Gerät}`.
 *
 * **Der behobene Befund** (Konzept `data/vp-geraeteseite-rahmen-r2` §2.1,
 * Captain-Entscheid D1a): über einer Geräteseite standen DREI Elemente
 * übereinander, die alle „zurück" bedeuten - der Knopf „Anlage {Name}"
 * (`vp-fleet-back`), eine Reiter-Leiste ihres Bereichs, in der die Seite gar
 * nicht vorkommt (also war kein Reiter aktiv), und der Link „Zurück zu den
 * Komponenten". Keines davon war die Aussage der Seite.
 *
 * ⚠ **Die Brotkrume ist keine neue Form, sondern die der Ladesäulen-Seite**
 * (`OcppWallboxPage`, PR 530) - sie ist hierher gezogen, damit alle
 * Geräteseiten dieselbe zeigen und nicht jede ihre eigene erfindet.
 *
 * ⚠ Die mittlere Stufe heisst **„Komponenten"**, weil die Seite, auf die sie
 * zeigt (`#/anlage/{id}/modell`), seit Steuerung Stufe 8 so heisst. Zwei Wörter
 * für dasselbe Ziel wären eine zweite Wahrheit.
 */
export function GeraetBrotkrume({ anlageHref, komponentenHref, titel }: {
  /** Das Cockpit der Anlage. */
  anlageHref: string;
  /** Die Komponenten-Seite - der Wirt, aus dem diese Geräteseite geöffnet wird. */
  komponentenHref: string;
  /** Der Name DIESES Geräts; er ist die aktuelle Stufe, kein Link. */
  titel: string;
}) {
  return (
    <nav className="vp-geraet-brotkrume" aria-label="Pfad zur Geräteseite">
      <a href={anlageHref}>Anlage</a>
      <Icon name="chevron-right" size={13} />
      <a href={komponentenHref}>Komponenten</a>
      <Icon name="chevron-right" size={13} />
      <span aria-current="page">{titel}</span>
    </nav>
  );
}
