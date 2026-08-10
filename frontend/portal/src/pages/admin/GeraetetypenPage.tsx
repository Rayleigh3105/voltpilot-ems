/**
 * Plattform → **Gerätetypen** (Inkrement 5 / D11): die read-only Freigabe-Liste
 * der steuerbaren Gerätetypen. Wahrheitsquelle ist der entitytypes-Katalog
 * (`GET /api/v1/admin/consumer-device-types`) - eine Zertifizierung gilt
 * plattformweit je Typ (das CERTIFIED-FAMILIES-Muster), nicht je Mandant, und
 * wird als PR gesetzt, der das Katalog-Flag umlegt. **Kein Schalter auf dieser
 * Fläche.** Ehrlich zum heutigen Anfangszustand: nur der Simulator, kein realer
 * Typ.
 *
 * ALLE Ableitung/Copy ist das reine `src/adminDeviceTypes.ts` (unit-getestet);
 * diese Seite lädt und rendert nur.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Card } from '../../../designsystem/components/core/Card';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { adminApi, type ConsumerDeviceType } from '../../admin/adminApi';
import { certDetail, certSummary, certView, deviceTypeRows } from '../../adminDeviceTypes';
import { AdminPageHead } from './AdminPageHead';

export function GeraetetypenPage(): JSX.Element {
  const [types, setTypes] = useState<ConsumerDeviceType[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    adminApi.consumerDeviceTypes().then(
      (t) => active && setTypes(t ?? []),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const rows = types ? deviceTypeRows(types) : [];

  return (
    <div className="vp-admin-page">
      <AdminPageHead
        icon="cpu"
        title="Steuerbare Gerätetypen"
        description="Der plattformweite Freigabe-Stand je Gerätetyp. Zertifizierung gilt für alle Kunden und wird einmalig per Bench-Session freigegeben - hier gibt es nichts umzuschalten."
      />

      {failed && (
        <ErrorState
          message="Die Gerätetypen konnten nicht geladen werden."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}
      {!failed && !types && <TableSkeleton rows={4} />}
      {!failed && types && types.length === 0 && (
        <EmptyState
          title="Noch keine steuerbaren Gerätetypen"
          description="Sobald ein Typ im Katalog steht, erscheint hier sein Freigabe-Stand."
        />
      )}
      {!failed && types && types.length > 0 && (
        <Card radius="lg" style={{ padding: 0, overflow: 'hidden' }}>
          <p className="vp-gt-summary">{certSummary(types)}</p>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Gerätetyp</th>
                <th>Freigabe-Stand</th>
                <th>Verbundene Geräte</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const cert = certView(t.certificationStatus);
                const detail = certDetail(t);
                return (
                  <tr key={t.type}>
                    <td data-label="Gerätetyp">
                      <div className="vp-cell-main">{t.label}</div>
                      <div className="vp-cell-sub">{t.type}</div>
                    </td>
                    <td data-label="Freigabe-Stand">
                      <Badge variant={cert.tone} dot>{cert.label}</Badge>
                      {detail && <div className="vp-cell-sub">{detail}</div>}
                    </td>
                    <td data-label="Verbundene Geräte">
                      {t.connectedCount.toLocaleString('de-DE')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
