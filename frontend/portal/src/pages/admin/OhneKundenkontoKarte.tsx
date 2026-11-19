import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  bereitZumAufspielen, brauchtDichFernlauf, fassungKurz, heuteNacht, nachtlaufZeile, ohneKundenkontoKopf,
  type AlleAufspielenStand, type FernlaufStand, type NachtlaufSchalter,
} from '../../werkstattFernlauf';
import './GeraeteUpdates.css';
import './OhneKundenkontoKarte.css';

/**
 * Plattform › Geräte › Updates, Karte „Ohne Kundenkonto" (Konzept vp-update-vor-zuordnung, S2): alle
 * Edge-Light-Boxen mit Tunnel-Zugang, die noch kein Kundenkonto haben - Stand, Vorprüfung (Grund, wenn nicht
 * möglich), „Aufspielen" je Box und „Alle n aufspielen" für die Reihe. Reine Anzeige der Ableitung aus
 * `werkstattFernlauf.ts`; „Aufspielen" ist überall derselbe Auftrag wie in der Akte (S1).
 *
 * S4 (§11.2): oben der Schalter „Nachts von selbst" mit „Anhalten"/„Einschalten", je Box „heute Nacht", wenn die
 * Automatik sie in der nächsten Nacht nimmt; angehalten bleibt nur der Knopf.
 */
export interface OhneKundenkontoAktionen {
  busy: boolean;
  /** Die Akte der Box öffnen (Reiter „Software"). */
  onBox: (edgeRef: string) => void;
  /** „Auf … bringen" für genau diese Box. */
  onAufspielen: (stand: FernlaufStand) => void;
  /** „Alle n aufspielen": die Reihe anstoßen. */
  onAlleAufspielen: () => void;
  /** Eine Reihe läuft gerade - Knöpfe aus, bis sie fertig oder abgebrochen ist. */
  laeuft: boolean;
  /** Der Fortschritt der letzten (oder laufenden) Reihe; `null` vor der ersten oder nach einem glatten Ende. */
  reihe: AlleAufspielenStand | null;
  /** S4: der Schalter „Nachts von selbst"; `null` = nicht geladen (dann keine Zeile, keine Behauptung). */
  nachtlauf: NachtlaufSchalter | null;
  /** „Anhalten" (`false`) / „Einschalten" (`true`). */
  onNachtlauf: (an: boolean) => void;
}

export function OhneKundenkontoKarte({ liste, jetzt, ...a }: {
  liste: FernlaufStand[];
  jetzt: Date;
} & OhneKundenkontoAktionen) {
  if (liste.length === 0) return null;
  const bereit = bereitZumAufspielen(liste);
  const braucht = brauchtDichFernlauf(liste, jetzt);

  return (
    <section className="vp-gu-block vp-gu-ok" aria-labelledby="vp-gu-ok-titel" data-testid="ohne-kundenkonto">
      <div className="vp-gu-block-titel vp-gu-ok-kopf">
        <h2 id="vp-gu-ok-titel">Ohne Kundenkonto</h2>
        {a.nachtlauf && (() => {
          const z = nachtlaufZeile(a.nachtlauf);
          return (
            <div className="vp-gu-ok-kopf-rechts vp-gu-ok-nacht" data-testid="ohne-kundenkonto-nachtlauf">
              <span className="vp-text-sm vp-gu-ok-nacht-text">
                <span>Nachts von selbst: <b data-testid="ohne-kundenkonto-nachtlauf-stellung">{z.stellung}</b></span>
                <span className="vp-muted vp-gu-ok-nacht-satz"><span className="vp-gu-ok-nacht-trenner"> · </span>{z.satz}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={a.busy}
                onClick={() => a.onNachtlauf(!a.nachtlauf!.an)}
                data-testid="ohne-kundenkonto-nachtlauf-knopf"
              >
                {z.knopf}
              </Button>
            </div>
          );
        })()}
      </div>
      <p className="vp-muted" data-testid="ohne-kundenkonto-satz">{ohneKundenkontoKopf(liste)}</p>

      {bereit.length > 1 && (
        <div className="vp-gu-aktionen">
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="refresh-cw" size={16} />}
            disabled={a.busy || a.laeuft}
            onClick={a.onAlleAufspielen}
            data-testid="ohne-kundenkonto-alle"
          >
            {`Alle ${bereit.length} aufspielen`}
          </Button>
        </div>
      )}

      {a.reihe && (
        <div className="vp-gu-ok-reihe" data-testid="ohne-kundenkonto-reihe" role="status">
          <span>
            {`Lauf ${Math.min(a.reihe.erledigt + 1, a.reihe.gesamt)} von ${a.reihe.gesamt}`}
            {a.reihe.aktuellRef ? ` · ${a.reihe.aktuellRef}` : ''}
          </span>
          {a.reihe.abgebrochen && (
            <p className="vp-alert vp-alert-warn" role="alert" data-testid="ohne-kundenkonto-abgebrochen">
              {`${a.reihe.abgebrochen.edgeRef}: ${a.reihe.abgebrochen.grund} Die restlichen Aufträge dieser Reihe `
                + 'wurden nicht gestartet.'}
            </p>
          )}
        </div>
      )}

      <ul className="vp-plain-list vp-gu-ok-liste" data-testid="ohne-kundenkonto-liste">
        {liste.map((s) => (
          <li key={s.edgeRef} className="vp-gu-ok-zeile" data-testid="ohne-kundenkonto-zeile">
            <span className="vp-gu-ok-box">
              <button type="button" className="vp-gu-link vp-gu-ok-ref" onClick={() => a.onBox(s.edgeRef)}>
                {s.edgeRef}
              </button>
              {heuteNacht(s, a.nachtlauf) && (
                <Badge variant="tint" data-testid="ohne-kundenkonto-heute-nacht">heute Nacht</Badge>
              )}
            </span>
            <span className="vp-gu-mono vp-gu-ok-fassung">{s.laeuft ? fassungKurz(s.laeuft) : 'unbekannt'}</span>
            <span className="vp-muted vp-text-sm vp-gu-ok-tunnel">
              {s.haken.tunnelVerbunden ? 'Tunnel verbunden' : 'Tunnel gerade nicht verbunden'}
            </span>
            {s.moeglich ? (
              <Button
                variant="outline"
                size="sm"
                className="vp-gu-ok-knopf"
                disabled={a.busy || a.laeuft}
                onClick={() => a.onAufspielen(s)}
                data-testid="ohne-kundenkonto-aufspielen"
              >
                {`Auf ${fassungKurz(s.neueste)} bringen`}
              </Button>
            ) : (
              <span className="vp-muted vp-text-sm vp-gu-ok-grund" data-testid="ohne-kundenkonto-grund">
                {s.gruende[0]?.text ?? ''}
              </span>
            )}
          </li>
        ))}
      </ul>

      {braucht.length > 0 && (
        <div className="vp-gu-aufgaben" data-testid="ohne-kundenkonto-braucht-dich">
          {braucht.map((e) => (
            <div key={e.edgeRef} className={`vp-gu-aufgabe ton-${e.ton === 'warn' ? 'fehler' : 'hand'}`}>
              <div className="vp-gu-kreis" aria-hidden="true"><Icon name="alert-triangle" size={18} /></div>
              <div>
                <h3>{e.titel}</h3>
                <p>{e.text}</p>
                {e.grund && <p data-testid="ohne-kundenkonto-braucht-grund">{e.grund}</p>}
                {e.halt && <p className="vp-gu-ok-halt" data-testid="ohne-kundenkonto-braucht-halt">{e.halt}</p>}
              </div>
              <div className="vp-gu-aktionen">
                <Button variant="outline" size="sm" onClick={() => a.onBox(e.edgeRef)}>Box ansehen</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
