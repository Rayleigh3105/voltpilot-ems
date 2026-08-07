import { lazy, useEffect, useRef, useState } from 'react';
import { LazyBoundary } from './Lazy';
import type { Site } from '../api';

const AnlageAnlegenDrawer = lazy(() =>
  import('./AnlageAnlegenDrawer').then((m) => ({ default: m.AnlageAnlegenDrawer })),
);

/**
 * Der Anlege-Assistent, nachgeladen statt mitgeliefert.
 *
 * Er hängt an `AnlageFlow` → `LocationMap` → **Leaflet** und ist damit einer der
 * schwersten Bäume der Anwendung - dabei öffnet ihn ein Kunde höchstens einmal.
 * Statisch importiert lag er trotzdem in jedem Cockpit-Aufruf.
 *
 * **Warum ein Wrapper und kein blosses `lazy`:** die Aufrufer halten den Drawer
 * DAUERHAFT montiert und steuern ihn nur über `open` (so läuft seine
 * Schliess-Animation zu Ende). Ein direktes `lazy` würde deshalb sofort beim
 * Rendern nachladen - also genau nichts sparen. Der Wrapper merkt sich, ob er
 * je geöffnet WURDE (`everOpened`): davor rendert er nichts und lädt nichts,
 * danach bleibt er montiert wie zuvor.
 */
export function AnlageAnlegenDrawerLazy(props: {
  open: boolean;
  onClose: () => void;
  onChanged: (createdSiteId: string) => void;
  existingSites?: Site[];
}) {
  const [everOpened, setEverOpened] = useState(props.open);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  useEffect(() => {
    if (props.open) setEverOpened(true);
  }, [props.open]);

  if (!everOpened) return null;
  return (
    <LazyBoundary fallback={null}>
      <AnlageAnlegenDrawer {...props} />
    </LazyBoundary>
  );
}
