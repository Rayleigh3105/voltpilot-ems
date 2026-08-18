import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Card } from '../../../designsystem/components/core/Card';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { adminApi, type ConsumerDeviceType } from '../../admin/adminApi';
import { certDetail, certSummary, certView, deviceTypeRows } from '../../adminDeviceTypes';

/**
 * Steuerungs-Freigabe → Sektion **„Steuerbare Gerätetypen"** (Admin-Umbau
 * Stufe 3, Konzept `vp-admin-neu-konzept-a9` §3.3, Captain-Entscheid F4).
 *
 * Sie war bis Stufe 3 ein eigener Nav-Punkt, beantwortet aber DIESELBE
 * Betreiber-Frage wie die Seite, auf der sie jetzt steht - „was darf die
 * Plattform steuern?" -, nur für die andere Geräteklasse: Wechselrichter-
 * Modelle oben (Register + Scharfschaltung, schreibbar), Verbraucher-Typen
 * hier (Katalog-Stand, read-only). Zwei fast gleich klingende Nav-Punkte für
 * eine Frage waren der Befund; ein Ort ist die Antwort.
 *
 * **Sie lädt SELBST und fail-soft.** Der Katalog ist ein eigener Endpunkt -
 * hinge er im `Promise.all` der Seite, risse sein Ausfall die beiden
 * Wechselrichter-Abschnitte mit, die davon gar nicht abhängen.
 *
 * ALLE Ableitung/Copy ist das reine `src/adminDeviceTypes.ts`
 * (unit-getestet); diese Sektion rendert nur.
 */
export function GeraetetypenSektion(): JSX.Element {
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
    <section className="vp-admin-sec" id="sektion-geraetetypen">
      <h2 className="vp-admin-sec-head">Steuerbare Gerätetypen</h2>
      <p className="vp-cert-summary">
        Der plattformweite Freigabe-Stand je Gerätetyp. Zertifizierung gilt für alle Kunden und
        wird einmalig per Bench-Session freigegeben - hier gibt es nichts umzuschalten.
      </p>

      {failed && (
        <ErrorState
          message="Die Gerätetypen konnten nicht geladen werden."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}
      {!failed && !types && <TableSkeleton rows={3} />}
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
    </section>
  );
}
