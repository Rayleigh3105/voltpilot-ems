/**
 * Die Seite „Steuerung" einer Anlage - seit dem Konzept „Steuerung neu"
 * (`docs/konzepte/steuerung`, E1–E9 = A) mit drei Reitern: Geräte · Laden ·
 * Regeln. Die Fläche selbst wohnt in `src/steuerung/`; diese Datei ist der
 * Einstieg, den die Anlagen-Seite lazy lädt (`pageChunks.ts`).
 *
 * Was hier früher untereinander stand, hat seinen Ort gefunden:
 *  - „Jetzt" und die Verbraucher-Zone → Reiter Geräte (Jetzt-Kopf, Tagesbild,
 *    die Geräte als Reihenfolge),
 *  - die Betriebsmodelle → das Blatt „Speicher" unter „Was immer gilt"
 *    (Betriebsmodelle wählen, mit Folgen vor dem Wechsel),
 *  - der Ladepark-Rahmen → Reiter Laden,
 *  - die Regel-Kapsel → Reiter Regeln (Satzbaukasten mit Probelauf).
 * Geräte legt die Steuerung nicht an; das geschieht in der Anlage.
 */
import type { Site } from '../api';
import type { BereichTab } from '../ebenenNav';
import type { AnlagenSub } from '../nav';
import { SteuerungSeite, type SteuerungReiter } from '../steuerung/SteuerungSeite';

export function SteuerungSection({
  site,
  reiter = 'steuerung',
  tabs = [],
  onOpenSub,
}: {
  site: Site;
  reiter?: SteuerungReiter;
  tabs?: BereichTab[];
  onOpenSub?: (sub: AnlagenSub) => void;
}) {
  const reiterListe: BereichTab[] = tabs.length
    ? tabs
    : [
        { key: 'steuerung', label: 'Geräte', sub: 'steuerung' },
        { key: 'regeln', label: 'Regeln', sub: 'regeln' },
      ];
  return (
    <SteuerungSeite
      site={site}
      reiter={reiter}
      tabs={reiterListe}
      onOpenSub={(sub) => (onOpenSub ? onOpenSub(sub) : (window.location.hash = `#/anlage/${site.id}/${sub}`))}
    />
  );
}
