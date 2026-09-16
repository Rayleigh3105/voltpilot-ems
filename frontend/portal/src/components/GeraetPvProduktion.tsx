import { Recht } from './Recht';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type GeraetRolle } from '../api';
import { GESAMTWERT, wertText } from '../gesamtwert';
import { SummenwertAssistent } from './SummenwertAssistent';
import './SummenwertAssistent.css';

/**
 * Die kompakte Ergebnis-Karte „PV-Produktion dieses Geräts" der Geräteseite
 * (Konzept vp-agg-konzept3-r8 §2, Deliverable A): sie zeigt den maßgeblichen
 * PV-Wert dieses Geräts und öffnet den Summenwert-Assistenten. Trägt das Gerät
 * schon eine Zuordnung, heißt der Knopf „Bearbeiten"; sonst „Summenwert anlegen"
 * (nie ein toter Knopf - der Wirt rendert die Karte nur für Geräte mit
 * Erzeugungs-Registern oder vorhandener Zuordnung).
 */
export function GeraetPvProduktion({
  siteId,
  deviceId,
  entityId,
  geraetName,
  onZuordnungGeaendert,
}: {
  siteId: string;
  deviceId: string;
  entityId: string;
  geraetName: string;
  /** Nach einer neuen Zuordnung - damit der Wirt (Gefahrenzone) nachfrischen kann. */
  onZuordnungGeaendert?: () => void;
}) {
  const [rolle, setRolle] = useState<GeraetRolle | null | undefined>(undefined);
  const [wert, setWert] = useState<{ wert: number | null; einheit: string | null } | null>(null);
  const [offen, setOffen] = useState(false);

  const laden = useCallback(async () => {
    try {
      const r = await api.geraetRolle(siteId, entityId, 'pv');
      setRolle(r);
      if (r.zugeordnet?.art === 'gesamtwert' && r.zugeordnet.quell_messstelle_id) {
        const w = await api.messstelleWert(r.zugeordnet.quell_messstelle_id).catch(() => null);
        setWert(w ? { wert: w.wert, einheit: w.einheit } : null);
      } else {
        setWert(null);
      }
    } catch {
      setRolle(null);
    }
  }, [siteId, entityId]);

  useEffect(() => {
    void laden();
  }, [laden]);

  const zugeordnet = rolle?.zugeordnet ?? null;

  return (
    <Card padding="md" radius="md" className="vp-geraet-pvp-card">
      <div className="vp-pvp">
        <div className="vp-pvp-mid">
          <p className="vp-pvp-title">
            PV-Produktion dieses Geräts <span className="vp-pvp-neu">Neu</span>
          </p>
          <p className="vp-pvp-sub">
            {rolle === undefined
              ? 'Wird geladen …'
              : zugeordnet
                ? `${wert?.wert != null ? wertText(wert.wert, wert.einheit ?? '') : '—'} · ${GESAMTWERT} „${zugeordnet.name ?? ''}" zugeordnet`
                : 'Aus den Erzeugungs-Registern dieses Geräts einen Summenwert bilden.'}
          </p>
        </div>
        {rolle !== undefined && (
          <div className="vp-pvp-act">
            <Recht aktion="geraet.einrichten"><Button
              variant="outline"
              size="sm"
              iconLeft={zugeordnet ? undefined : <Icon name="plus" size={15} strokeWidth={2.6} />}
              onClick={() => setOffen(true)}
            >
              {zugeordnet ? 'Bearbeiten' : 'Summenwert anlegen'}
            </Button></Recht>
          </div>
        )}
      </div>

      <SummenwertAssistent
        open={offen}
        siteId={siteId}
        deviceId={deviceId}
        entityId={entityId}
        geraetName={geraetName}
        bestehend={rolle ?? null}
        onClose={() => setOffen(false)}
        onGespeichert={() => {
          setOffen(false);
          void laden();
          onZuordnungGeaendert?.();
        }}
      />
    </Card>
  );
}
