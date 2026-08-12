/**
 * Plattform → **Komponenten** (Einheitsmodell Stufe 6, Betriebs-/Support-Sicht).
 *
 * <p>Die Frage, die diese Seite beantwortet und die bis hierher nur je Anlage
 * beantwortbar war: <b>wo werden die Geräte gepflegt, woher stammen sie, und
 * wo steht Soll ≠ Ist?</b> Read-only — es gibt hier keinen Schalter; gepflegt
 * wird je Anlage, verwaltet wird je Vorlage.
 *
 * <p>ALLE Ableitung/Copy ist das reine `src/adminKomponentenFlotte.ts`
 * (unit-getestet); diese Seite lädt und rendert.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Card } from '../../../designsystem/components/core/Card';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import {
  ablehnung,
  braucheAufmerksamkeit,
  freigabe,
  kopfSatz,
  pflegeOrt,
  quellenText,
  selbstbauZeilen,
  sollIst,
  type FlottenAnlage,
} from '../../adminKomponentenFlotte';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';

export function KomponentenFlottePage(): JSX.Element {
  const [sites, setSites] = useState<FlottenAnlage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    adminApi.componentFleet().then(
      (s) => active && setSites(s ?? []),
      (e) =>
        active &&
        setLoadError(
          e instanceof ApiError ? e.message : 'Die Komponenten-Sicht ließ sich nicht laden.',
        ),
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const auffaellig = sites ? braucheAufmerksamkeit(sites) : [];
  const selbstbau = sites ? selbstbauZeilen(sites) : [];

  return (
    <div className="vp-admin-page">
      <AdminPageHead
        icon="cpu"
        title="Komponenten"
        description="Die Geräte-Welt der ganzen Flotte: wo sie gepflegt wird, woher die Anbindungen stammen und wo eine Box eine Fassung noch nicht angewandt hat. Diese Seite zeigt nur — geändert wird je Anlage."
      />

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : sites == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={5} />
        </Card>
      ) : sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="cpu"
            title="Noch keine Anlage"
            description="Sobald ein Kunde eine Anlage anlegt, erscheint sie hier."
          />
        </Card>
      ) : (
        <>
          <p className="vp-muted" data-testid="kopf">
            {kopfSatz(sites)}
          </p>

          {auffaellig.length > 0 && (
            <Card padding="lg" radius="lg" data-testid="aufmerksamkeit">
              <div className="vp-admin-sec-head">
                <h2>Das braucht einen Blick</h2>
                <p>
                  Eine abgelehnte Fassung ist ein echter Befund; eine ausstehende ist unterwegs.
                  Anlagen, die sich nie gemeldet haben, stehen hier bewusst NICHT — daraus folgt
                  keine Aufgabe.
                </p>
              </div>
              <ul className="vp-komp-hinweise">
                {auffaellig.map((a) => (
                  <li key={a.siteId}>
                    <strong>{a.siteName}</strong> <span className="vp-muted">{a.tenantName}</span>
                    <div>{ablehnung(a) ?? 'Eine neue Fassung liegt an und ist noch nicht angewandt.'}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div className="vp-admin-sec-head">
              <h2>Alle Anlagen</h2>
              <p>Eine Zeile je Anlage, über alle Mandanten.</p>
            </div>
            <div className="vp-table-scroll">
              <table className="vp-table responsive" data-testid="komponenten-flotte">
                <thead>
                  <tr>
                    <th>Anlage</th>
                    <th>Gepflegt</th>
                    <th>Komponenten</th>
                    <th>Herkunft</th>
                    <th>Soll/Ist</th>
                    <th>Schreiben</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((s) => {
                    const ort = pflegeOrt(s.componentAuthority);
                    const si = sollIst(s.syncStatus);
                    const w = freigabe(s.write);
                    return (
                      <tr key={s.siteId}>
                        <td data-label="Anlage">
                          <span className="vp-cell-main">
                            <span>{s.siteName}</span>
                            <span className="vp-cell-sub">{s.tenantName}</span>
                          </span>
                        </td>
                        <td data-label="Gepflegt">
                          <Badge variant={ort.ton} dot>
                            {ort.label}
                          </Badge>
                        </td>
                        <td data-label="Komponenten">{s.componentCount}</td>
                        <td data-label="Herkunft">
                          <span className="vp-muted">{quellenText(s.sources)}</span>
                        </td>
                        <td data-label="Soll/Ist">
                          <Badge variant={si.ton}>{si.label}</Badge>
                          {ablehnung(s) && (
                            <div className="vp-cell-sub vp-komp-ablehnung">{ablehnung(s)}</div>
                          )}
                        </td>
                        <td data-label="Schreiben">
                          {w.text ? (
                            <span className="vp-cell-main">
                              <span>{w.text}</span>
                              <span className="vp-cell-sub">{w.belege.join(' · ')}</span>
                            </span>
                          ) : (
                            <span className="vp-muted">Nur lesend</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {selbstbau.length > 0 && (
            <Card padding="lg" radius="lg" data-testid="selbstbau">
              <div className="vp-admin-sec-head">
                <h2>Selbst gebaute Geräte</h2>
                <p>
                  Der Long Tail: Anlagen mit eigenen Modbus-Geräten oder eigenen Vorlagen. Ihre
                  Definitionen kommen vom Kunden, nicht aus dem Katalog — wenn ein Support-Fall
                  von „mein Messwert stimmt nicht" handelt, fängt er meistens hier an.
                </p>
              </div>
              <ul className="vp-komp-hinweise">
                {selbstbau.map((s) => (
                  <li key={s.siteId}>
                    <strong>{s.siteName}</strong> <span className="vp-muted">{s.tenantName}</span>
                    <div className="vp-muted">
                      {s.sources?.custom ?? 0} eigene Geräte · {s.privateTemplates} eigene Vorlagen
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
