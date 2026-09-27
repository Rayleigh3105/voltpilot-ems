import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { Device, Site, StandortAmStichtag } from '../api';
import { AnlageAnlegenDrawerLazy } from '../components/AnlageAnlegenDrawerLazy';
import { Recht } from '../components/Recht';
import { EmptyState } from '../components/States';
import { ohneAufbauNeu, parseAufbauAnlage, parseAufbauNeu, standortAufbauHash } from '../nav';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { AufbauSection } from './AufbauSection';
import './StandortBereichPage.css';

/** Die Anlage des Standorts, die der Aufbau aufklappt: die verlangte (`?anlage=`), sonst die erste. */
export function aufbauAnlageDesStandorts(
  standort: StandortAmStichtag,
  sites: readonly Site[],
  verlangt: string | null,
): Site | null {
  const hier = standort.anlagen.map((a) => sites.find((s) => s.id === a.id)).filter((s): s is Site => s != null);
  return hier.find((s) => s.id === verlangt) ?? hier[0] ?? null;
}

/**
 * „Standort › Aufbau“ — der EINE Ort, an dem Anlagen, VoltPilot-Boxen und Geräte eines Standorts
 * entstehen und stehen. Es ist DERSELBE Baum wie „Anlage › Aufbau“ (`AufbauSection`): Standort →
 * Anlagen → Boxen → Geräte, mit einem „Hinzufügen“ für alles. Die früheren Seiten „Boxen“ und
 * „Anlagen“ des Standorts sind darin aufgegangen — sie zeigten dieselben Dinge ein zweites und drittes
 * Mal, und anlegen ließ sich dort nichts.
 *
 * Eine Anlage des Standorts ist aufgeklappt und bearbeitbar; „Öffnen ›“ an einer anderen wechselt,
 * ohne den Standort zu verlassen (`?anlage=`). Ohne Anlage gibt es noch keinen Baum — dann steht hier
 * der erste Schritt: „Anlage hinzufügen“.
 */
export function StandortAufbauPage({
  standort,
  sites,
  devices,
  devicesFetchedAt = null,
  onReload,
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  devices: Device[];
  devicesFetchedAt?: number | null;
  onReload: (selectSiteId?: string) => void;
}) {
  const [verlangt, setVerlangt] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseAufbauAnlage(window.location.hash),
  );
  useEffect(() => {
    const onHash = () => setVerlangt(parseAufbauAnlage(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const site = useMemo(() => aufbauAnlageDesStandorts(standort, sites, verlangt), [standort, sites, verlangt]);

  // Ohne Anlage öffnet `?neu=anlage` hier den ersten Schritt; mit Anlage macht es der Aufbau selbst.
  const [anlegen, setAnlegen] = useState(false);
  useEffect(() => {
    if (site || typeof window === 'undefined') return;
    if (parseAufbauNeu(window.location.hash) === 'anlage') setAnlegen(true);
    replaceCurrentNavigation(ohneAufbauNeu(window.location.hash));
  }, [site]);

  return (
    <div className="vp-sb vp-standort-aufbau" data-testid="standort-aufbau">
      <header className="vp-sb-kopf">
        <h1>Aufbau</h1>
        <p>{standort.name} · Anlagen, VoltPilot-Boxen und Geräte — hier kommen neue hinzu.</p>
      </header>
      {site ? (
        <AufbauSection
          key={site.id}
          site={site}
          sites={sites}
          devices={devices}
          devicesFetchedAt={devicesFetchedAt}
          onReload={onReload}
          standortSicht={{ wechselHref: (anlageId) => standortAufbauHash(standort.id, { anlage: anlageId }) }}
        />
      ) : (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="layers"
            category="primary"
            title="Noch keine Anlage an diesem Standort"
            description="Eine Anlage ist das, was hinter einem Netzanschluss hängt. Legen Sie sie an — danach verbinden Sie hier ihre VoltPilot-Box und die Geräte."
            action={
              <Recht aktion="anlage.verwalten">
                <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAnlegen(true)}>
                  Anlage hinzufügen
                </Button>
              </Recht>
            }
          />
        </Card>
      )}
      <AnlageAnlegenDrawerLazy
        open={anlegen}
        onClose={() => setAnlegen(false)}
        existingSites={sites}
        standortId={standort.id}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </div>
  );
}
