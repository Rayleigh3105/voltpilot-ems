import { useEffect, useState } from 'react';
import { api, type ChargingConfig } from '../api';
import type { LadeparkRahmen } from '../verbraucherZone';
import { RahmenBlatt } from '../steuerung/LadenReiter';

/**
 * Die Anschlussgrenze in den Einstellungen (Konzept „Ein Ort fürs Laden"
 * §4/§5/§10, E5 = A): das bewährte Rahmen-Blatt der Steuerung, jetzt von hier
 * aus geöffnet statt von „Steuerung › Laden". Die Rechnung und die Prüfung
 * gegen den Netzanschluss bleiben Zeichen für Zeichen dieselben
 * (`RahmenBlatt`/`useAnschluss`) - nur der Ort, an dem man hinkommt, ist neu.
 *
 * Holt `rahmen` und `config` selbst (ein zweiter, kleiner Abruf) statt die
 * Haupt-Ladefolge der Einstellungen damit zu belasten - dieselbe Holschuld
 * wie das Blatt sie für den Netzanschluss selbst schon trägt.
 */
export function AnschlussgrenzeBlatt({ siteId, onClose, onSaved }: {
  siteId: string;
  onClose: () => void;
  onSaved?: (config: ChargingConfig) => void;
}) {
  const [rahmen, setRahmen] = useState<LadeparkRahmen | null>(null);
  const [config, setConfig] = useState<ChargingConfig | null>(null);
  const [geladen, setGeladen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [speicherFehler, setSpeicherFehler] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    setGeladen(false);
    setFehler(null);
    Promise.all([api.siteVerbraucher(siteId), api.chargingConfig(siteId)])
      .then(([v, c]) => {
        if (!aktiv) return;
        setRahmen(v.ladepunkte.rahmen);
        setConfig(c);
        setGeladen(true);
      })
      .catch(() => {
        if (aktiv) setFehler('Die Anschlussgrenze konnte nicht geladen werden.');
      });
    return () => { aktiv = false; };
  }, [siteId]);

  if (fehler) return <p className="leise" role="alert">{fehler}</p>;
  if (!geladen) return <p className="leise" aria-busy="true">Lädt …</p>;

  return (
    <RahmenBlatt
      k={{ zu: onClose, busy: busy ? 'rahmen' : null }}
      siteId={siteId}
      rahmen={rahmen}
      config={config}
      serverFehler={speicherFehler}
      onGrenze={async (kw, vereinbartKw) => {
        setBusy(true);
        setSpeicherFehler(null);
        try {
          const c = await api.saveCustomerChargingFrame(siteId, { gridLimitKw: kw, ...(vereinbartKw != null ? { vereinbartKw } : {}) });
          setConfig(c);
          onSaved?.(c);
          const v = await api.siteVerbraucher(siteId).catch(() => null);
          if (v) setRahmen(v.ladepunkte.rahmen);
          return true;
        } catch {
          setSpeicherFehler('Der Rahmen konnte nicht gespeichert werden.');
          return false;
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
