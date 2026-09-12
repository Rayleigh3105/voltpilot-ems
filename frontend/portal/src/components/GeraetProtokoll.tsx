/**
 * Das ÄNDERUNGSPROTOKOLL auf der GERÄTESEITE (UEMS AP-04 IP-21).
 *
 * Die Geräteseite kennt ihre KOMPONENTEN, das Protokoll hängt am GERÄT — diese
 * Hülle geht den Weg dazwischen (`geraetZuKomponenten`) und rendert dann
 * dieselbe `ProtokollListe` wie die Messstelle. Zwei Protokoll-Formen wären
 * zwei Wahrheiten.
 *
 * ⚠ Ohne auflösbares Gerät rendert sie GAR NICHTS — lieber kein Kasten als ein
 * Kasten, der erklärt, dass er nichts weiß.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type UemsGeraet } from '../api';
import { geraetZuKomponenten } from '../uemsProtokoll';
import { PROTOKOLL_LABEL } from './ProtokollDialog';
import { ProtokollListe, useProtokoll } from './ProtokollListe';

export function GeraetProtokoll({
  siteId,
  entityIds,
}: {
  siteId: string;
  /** Die Komponenten dieser Geräteseite — über sie wird das Gerät gefunden. */
  entityIds: readonly string[];
}) {
  const [geraete, setGeraete] = useState<UemsGeraet[] | null>(null);
  const schluessel = entityIds.join(',');

  useEffect(() => {
    let aktiv = true;
    setGeraete(null);
    if (!siteId || !schluessel) return () => undefined;
    api
      .uemsGeraete(siteId)
      .then((a) => aktiv && setGeraete(a.geraete))
      .catch(() => aktiv && setGeraete([]));
    return () => {
      aktiv = false;
    };
  }, [siteId, schluessel]);

  const geraet = geraetZuKomponenten(geraete, entityIds);
  const state = useProtokoll(geraet ? { art: 'geraet', id: geraet.id } : null);
  if (!geraet) return null;
  return (
    <section className="vp-rahmen-block">
      <h3>
        <Icon name="history" size={14} />
        {PROTOKOLL_LABEL}
      </h3>
      <p className="vp-note">
        Was sich an {geraet.einbau_kennzeichen} geändert hat: seine Quellen, seine Einstellungen
        und sein Ein- und Ausbau.
      </p>
      <ProtokollListe state={state} />
    </section>
  );
}
