import { Recht } from './Recht';
/**
 * Die REGEL-KARTE IM DETAIL als EINSCHUB (Einheitsmodell Stufe 5a, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.5) — keine eigene Seite: das Haus-Muster
 * für Details, am Telefon ein Vollbild-Sheet.
 *
 * Reiner Renderer über `regeln/detail.ts`. Zwei Dinge, die man hier sehen muss,
 * weil sie die Ehrlichkeit der Fläche tragen: der VERLAUF sagt in dieser Stufe
 * ausdrücklich, dass er noch nicht aufgezeichnet wird (der Verlaufsspeicher ist
 * Stufe 5b), und „Geprüft & durchgerechnet" behauptet keine Zahl, wenn es
 * keinen Probelauf gab.
 */
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Modal } from '../../designsystem/components/shell/Modal';
import { DangerZone } from './DangerZone';
import type { RegelDetailView, RegelAbschnitt } from '../regeln/detail';
import type { RegelKarte } from '../regeln/zustand';
import './Regeln.css';

function Abschnitt({ a }: { a: RegelAbschnitt }) {
  return (
    <section className="vp-regeld-sec">
      <h3>{a.titel}</h3>
      {a.zeilen.length > 0 && (
        <ul className="vp-regeld-list">
          {a.zeilen.map((z, i) => <li key={i}>{z}</li>)}
        </ul>
      )}
      {a.note && <p className="vp-regeld-note">{a.note}</p>}
    </section>
  );
}

export function RegelDrawer({
  karte,
  view,
  busy,
  loeschFolgen,
  onClose,
  onToggle,
  onBearbeiten,
  onLoeschen,
}: {
  karte: RegelKarte;
  view: RegelDetailView;
  busy: boolean;
  /** Die Folgenliste des Hauses (DangerZone) für das Löschen. */
  loeschFolgen: string[];
  onClose: () => void;
  onToggle: (an: boolean) => void;
  onBearbeiten: (() => void) | null;
  onLoeschen: () => void;
}) {
  const z = karte.zustand;
  return (
    <Modal open onClose={onClose} title={view.name}>
      <div className="vp-regeld">
        <p className={`vp-regeld-zustand ton-${z.ton}`}>{z.zeile}</p>
        {z.geraet && (
          <Badge variant={z.geraet.tone} dot>{z.geraet.label}</Badge>
        )}
        {karte.hinweis && <p className="vp-regeld-note">{karte.hinweis}</p>}
        {karte.nachteil && <p className="vp-regeld-nachteil">{karte.nachteil}</p>}

        <section className="vp-regeld-sec vp-regeld-regel">
          <h3>Ihre Regel</h3>
          {view.ersatz ? (
            <p className="vp-regeld-ersatz">{view.ersatz}</p>
          ) : (
            <>
              {view.wenn.map((zeile, i) => (
                <p key={i} className="vp-regeld-zeile">
                  {view.dann && <span className="vp-regeld-key">{i === 0 ? 'WENN' : ''}</span>}
                  {zeile}
                </p>
              ))}
              {view.dann && (
                <p className="vp-regeld-zeile">
                  <span className="vp-regeld-key">DANN</span>
                  {view.dann}
                </p>
              )}
            </>
          )}
          <p className="vp-regeld-immer">{view.immer}</p>
        </section>

        <Abschnitt a={view.verlauf} />
        <Abschnitt a={view.nachweis} />

        {view.versionen && (
          <section className="vp-regeld-sec">
            <h3>Versionen</h3>
            <p className="vp-regeld-zeile">{view.versionen}</p>
          </section>
        )}

        <div className="vp-regeld-aktionen">
          {onBearbeiten && view.bearbeiten && (
            <Recht aktion="betriebsweise.aendern"><Button size="sm" disabled={busy} onClick={onBearbeiten}>{view.bearbeiten}</Button></Recht>
          )}
          <Recht aktion="betriebsweise.aendern"><Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onToggle(!karte.an)}
          >
            {view.schalter}
          </Button></Recht>
        </div>

        <DangerZone recht="betriebsweise.aendern"
          actionLabel="Regel löschen"
          confirmLabel="Endgültig löschen"
          consequences={loeschFolgen}
          busy={busy}
          onConfirm={onLoeschen}
        />
      </div>
    </Modal>
  );
}
