import { useEffect, useState } from 'react';
import { api } from '../api';
import { wechselMarken } from '../zaehlerwechsel';
import { VORGABE_ZEITZONE } from '../uemsZustand';

/** Liest die bereits gespeicherte Komponenten-Marke; niemals ein aus Bindungen geratener Wechsel. */
export function ZaehlerwechselVerlauf({ anlageId, komponenten, stand = 0 }: {
  anlageId: string; komponenten: string[]; stand?: number;
}) {
  const [offen, setOffen] = useState(false);
  const [saetze, setSaetze] = useState<string[] | null>(null);
  const [fehler, setFehler] = useState(false);
  const [zone, setZone] = useState<string | null>(null);
  const schluessel = komponenten.join(',');
  useEffect(() => {
    if (!offen) return;
    let aktiv = true;
    setSaetze(null); setFehler(false);
    void Promise.all([api.standorte(), ...komponenten.map(id => api.komponentenEreignisse(anlageId, id))])
      .then(([orte, ...listen]) => {
        if (!aktiv) return;
        const z = orte.standorte.find(s => s.anlagen.some(a => a.id === anlageId))?.zeitzone ?? VORGABE_ZEITZONE;
        setZone(z); setSaetze(wechselMarken(listen.flat(), z));
      }).catch(() => { if (aktiv) setFehler(true); });
    return () => { aktiv = false; };
    // Die Kennungen beschreiben dieselbe Menge auch bei neuem Array des Wirts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen, anlageId, schluessel, stand]);
  return <details className="vp-zw-verlauf" onToggle={e => setOffen(e.currentTarget.open)}>
    <summary>Zählerwechsel im Verlauf</summary>
    {offen && <>
      {zone && <p>Zeitzone: {zone}</p>}
      {fehler ? <p role="alert">Der Verlauf konnte nicht geladen werden. Schließen und öffnen Sie ihn erneut.</p>
        : saetze === null ? <p role="status">Verlauf wird geladen …</p>
        : saetze.length ? <ul>{saetze.map(s => <li key={s}>{s}</li>)}</ul>
        : <p>Kein Zählerwechsel im Verlauf eingetragen.</p>}
    </>}
  </details>;
}
