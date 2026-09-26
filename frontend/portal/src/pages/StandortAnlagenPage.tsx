import type { Betriebsart, Site, StandortAmStichtag } from '../api';
import { EbenenCockpit } from '../components/EbenenCockpit';
import type { Route } from '../nav';

/** Der Titel von „Standort › Anlagen“ — dasselbe Wort wie die Kachel des Bereichs. */
export const TITEL_ANLAGEN = 'Anlagen';

/**
 * „Standort › Anlagen“ (UEMS AP-13 IP-2, Ü7): `#/standort/{id}/anlagen` — die heutige Anlagen-Tabelle der
 * Standort-Übersicht, gefiltert auf den Standort, ohne die Bausteine der Übersicht (`EbenenCockpit` mit
 * `nurAnlagen`). Kein neuer Baustein und keine zweite Tabelle: Zeilen, Spalten und Vorschau sind dieselben.
 *
 * ⚠ Der Weg „Energiebilanz“ je Zeile steht seit IP-8 — nur an einer Anlage mit Hauptzähler in der Stellung (dieselbe Frage
 *   wie der Reiter Verlauf › Energiebilanz, `uems-bilanz-flaeche.md`); ohne ihn kein Knopf ohne Ziel.
 * ⚠ Mit weniger als zwei Anlagen hat der Standort keinen Bereich „Anlagen“ (AP-01 §4.6, Z4): keine Kachel, kein
 *   Reiter. Die Adresse gilt trotzdem und zeigt die eine Zeile — ein Lesezeichen führt nie ins Leere.
 */
export function StandortAnlagenPage({
  standort,
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  betriebsart?: Betriebsart | null;
}) {
  return (
    <div className="vp-standort-anlagen" data-testid="standort-anlagen">
      <EbenenCockpit
        sites={sites}
        onNavigate={onNavigate}
        onReload={onReload}
        isAdmin={isAdmin}
        betriebsart={betriebsart}
        titel={TITEL_ANLAGEN}
        ebene={{ art: 'standort', standort }}
        nurAnlagen
      />
    </div>
  );
}
