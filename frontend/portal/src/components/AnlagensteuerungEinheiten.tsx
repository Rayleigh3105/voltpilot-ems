/**
 * Die Steuerung als Gerät (UEMS EZ-10, EW-3 A): an der Karte „Gerät“ einer Anlagensteuerung die
 * Erzeugungseinheiten - so wie die Energiekarten an einer WAGO-Steuerung - mit Art, Typname, Nennleistung und
 * Zustand, dazu Netzpunkt (berechnet bzw. „—“ ohne Messung, EW-16 C) und Datenstand; den Programmstand zeigt EZ-16
 * an derselben Karte. Die Werte liest die Route `…/anlagensteuerungen/{geraetId}/werte` (EZ-6); ohne sie stehen
 * die Stammdaten allein. Seit GE-3 führt jede Einheit auf ihre eigene Seite `as-<Entität>~te-<n>` — die Box-Referenz
 * und die Entität stehen schon in der Adresse dieser Seite.
 */
import { Icon } from '../../designsystem/components/core/Icon';
import type { Erzeugungseinheit } from '../api';
import { datenstandZeile, einheitenZeilen, netzpunktZeile, sortiert } from '../anlagensteuerung';
import { einheitHref } from '../erzeugungseinheit';
import { anlagensteuerungIdOf } from '../geraetAdresse';
import type { Zeile } from '../geraetEinstellungen';
import { parseRoute } from '../nav';
import { useAnlagensteuerungWerte } from '../useAnlagensteuerung';

export function AnlagensteuerungEinheiten({
  siteId,
  geraetId,
  einheiten,
  jetzt,
}: {
  siteId: string;
  geraetId: string;
  einheiten: readonly Erzeugungseinheit[];
  /** Die Uhr der Seite (Tests); ohne sie „jetzt“. */
  jetzt?: string;
}) {
  const werte = useAnlagensteuerungWerte(siteId, geraetId);
  const now = jetzt ? new Date(jetzt) : new Date();
  const anlage: Zeile[] = [netzpunktZeile(werte), datenstandZeile(werte, now)];
  const hier = hierAufDerSteuerung();
  const hrefs = sortiert(einheiten).map((e) => (hier ? einheitHref(siteId, hier.ref, hier.entityId, e.te_nr) : null));
  return (
    <>
      <h4 className="vp-gh-unter">Erzeugungseinheiten</h4>
      <Zeilen zeilen={einheitenZeilen(einheiten, werte)} hrefs={hrefs} testId="geraet-einheiten" />
      <h4 className="vp-gh-unter">Anlage</h4>
      <Zeilen zeilen={anlage} testId="geraet-anlagensteuerung" />
    </>
  );
}

/** Box-Referenz und Entität der Steuerung aus der Adresse dieser Seite (`…/geraet/{ref}/as-<Entität>`); sonst null. */
function hierAufDerSteuerung(): { ref: string; entityId: string } | null {
  if (typeof window === 'undefined') return null;
  const r = parseRoute(window.location.hash);
  const g = 'geraet' in r ? r.geraet : undefined;
  const entityId = anlagensteuerungIdOf(g?.geraetId ?? null);
  return g?.ref && entityId ? { ref: g.ref, entityId } : null;
}

function Zeilen({ zeilen, hrefs = [], testId }: { zeilen: Zeile[]; hrefs?: (string | null)[]; testId: string }) {
  return (
    <dl className="vp-geraet-kv" data-testid={testId}>
      {zeilen.map((z, i) => (
        <div key={`${z.label}|${z.wert}`}>
          <dt>
            {hrefs[i] ? (
              <a href={hrefs[i] as string} data-testid="geraet-einheit-link">
                {z.label} <Icon name="chevron-right" size={13} />
              </a>
            ) : (
              z.label
            )}
          </dt>
          <dd>
            <span>{z.wert}</span>
            {z.detail && <small>{z.detail}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
