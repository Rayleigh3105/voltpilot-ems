import { useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { EmptyState } from '../../components/States';
import { NICHT_GEFUNDEN, type GeraetView } from '../../adminGeraet';
import { registerZugang } from '../../registerWrite';
import { RegisterWriteDrawer } from '../../components/RegisterWriteDrawer';
import { AdminGeraetKarten, badgeVariant, Sektion } from '../../components/AdminGeraetKarten';

/**
 * Die GERÄTE-DETAILSEITE - der Anker des Admin-Umbaus (Stufe 2, Konzept
 * `data/vp-admin-neu-konzept-a9` §4, Captain-Entscheid F2).
 *
 * Sie RENDERT nur: jedes Urteil, jeder Satz und jede Ehrlichkeitsregel liegt
 * in der reinen `adminGeraet.ts`, die ihrerseits die bestehenden Ableitungen
 * wiederverwendet - die Seite erfindet keine zweite Wahrheit über ein Gerät.
 *
 * Der Drawer bleibt der SCHNELLBLICK am Wellen-Board (mitten im Rollout will
 * niemand die Fläche verlieren); diese Seite ist die Vollansicht und über
 * `?geraet=<referenz>` adressierbar.
 */
export function GeraetSeite({
  view,
  busy,
  onZurueck,
  onJumpToTenant,
  onNavigateSteuerung,
  onAssign,
  onRevert,
  onApply,
}: {
  /** `null` = die Referenz kommt in keinem Inventar vor. */
  view: GeraetView | null;
  busy: boolean;
  onZurueck: () => void;
  /** Sprung in die Mandanten-Ansicht dieser Anlage (bzw. auf ihre Befehle-Seite). */
  onJumpToTenant: (tenantId: string, siteId: string, sub?: 'befehle') => void;
  onNavigateSteuerung: () => void;
  onAssign?: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert?: () => Promise<void>;
  onApply?: () => void;
}) {
  if (!view) {
    return (
      <>
        <Zurueck onZurueck={onZurueck} />
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="search"
            category="primary"
            title="Gerät nicht gefunden"
            description={NICHT_GEFUNDEN}
            action={
              <Button variant="outline" onClick={onZurueck}>
                Zur Geräte-Liste
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const { kopf } = view;

  return (
    <>
      <Zurueck onZurueck={onZurueck} />

      {/* ── Kopf ────────────────────────────────────────────────────────── */}
      <Card padding="lg" radius="lg" className="vp-geraet-kopf">
        <div className="vp-geraet-ident">
          <h1>{kopf.name}</h1>
          <p className="vp-muted">
            <span className="vp-mono">{kopf.ref}</span>
            {kopf.typ ? ` · ${kopf.typ}` : ''}
            {kopf.kontext ? ` · ${kopf.kontext}` : ''}
          </p>
          <p className="vp-geraet-live">
            <Badge variant={badgeVariant(kopf.lebendigkeit.tone)} dot>
              {kopf.lebendigkeit.label}
            </Badge>{' '}
            <span className="vp-muted vp-text-sm">{kopf.lebendigkeit.detail}</span>
          </p>
        </div>
        {/* Ein Sprung, der strukturell nirgends hinführt, wird nicht
            angeboten - eine gedruckte, unverbundene ID hat keine Anlage. */}
        {kopf.sprungAnlage && (
          <div className="vp-row-gap vp-geraet-aktionen">
            <Button
              variant="outline"
              iconLeft={<Icon name="sun" size={18} />}
              onClick={() =>
                onJumpToTenant(kopf.sprungAnlage!.tenantId, kopf.sprungAnlage!.siteId)
              }
            >
              Zur Anlage (Mandanten-Ansicht)
            </Button>
            {kopf.sprungBefehle && (
              <Button
                variant="ghost"
                iconLeft={<Icon name="file-text" size={18} />}
                onClick={() =>
                  onJumpToTenant(
                    kopf.sprungBefehle!.tenantId,
                    kopf.sprungBefehle!.siteId,
                    'befehle',
                  )
                }
              >
                Befehle ansehen
              </Button>
            )}
          </div>
        )}
      </Card>

      <AdminGeraetKarten
        view={view}
        busy={busy}
        onNavigateSteuerung={onNavigateSteuerung}
        onAssign={onAssign}
        onRevert={onRevert}
        onApply={onApply}
      />

      {/* Die Register-Strecke bleibt beim WIRT: die Geräteseite der Anlage hat
          seit PR 1c ihre eigene Sektion E mit vorgewähltem Ziel. */}
      <div className="vp-geraet-grid">
        <Sektion titel="Register (Experte)" icon="pencil">
          <RegisterSektion device={view.device} />
        </Sektion>
      </div>
    </>
  );
}

/**
 * Die Register-Strecke der Plattform-Geräteseite (Konzept
 * `vp-reg-schreib-konzept-p8` §2.7).
 *
 * Sie ist bewusst ein ruhiger EXPERTEN-Aufklapper, kein prominenter Knopf: die
 * Freiheit ist da, die Fläche bleibt es auch. Der eigentliche Weg (Ist lesen →
 * Vorschau → bestätigen → Beleg) wohnt im geteilten Drawer, damit die Kunden-
 * Fläche der Stufe 3 exakt denselben benutzt.
 */
function RegisterSektion({ device }: { device: GeraetView['device'] }) {
  const [offen, setOffen] = useState(false);
  const zugang = registerZugang(device);

  return (
    <>
      <p className="vp-text-sm">
        Ein einzelnes Geräte-Register aus der Ferne lesen und - nach einer
        Vorschau - genau einmal beschreiben. Jeder Schreibvorgang wird dauerhaft
        protokolliert und erscheint im Befehle-Verlauf der Anlage.
      </p>
      {zugang.moeglich ? (
        <Button variant="outline" onClick={() => setOffen(true)} data-testid="geraet-regwrite">
          Register schreiben
        </Button>
      ) : (
        <p className="vp-muted vp-text-sm" data-testid="geraet-regwrite-grund">{zugang.grund}</p>
      )}
      {offen && zugang.moeglich && (
        <RegisterWriteDrawer
          open
          siteId={zugang.siteId as string}
          deviceId={zugang.deviceId as string}
          tenantId={zugang.tenantId ?? undefined}
          geraetName={device.label ?? device.externalRef}
          onClose={() => setOffen(false)}
        />
      )}
    </>
  );
}

function Zurueck({ onZurueck }: { onZurueck: () => void }) {
  return (
    <button type="button" className="vp-linklike vp-geraet-back" onClick={onZurueck}>
      ‹ Alle Geräte
    </button>
  );
}

