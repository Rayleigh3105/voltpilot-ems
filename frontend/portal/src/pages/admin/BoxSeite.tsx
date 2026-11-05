import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import {
  BOX_ART_LABELS, BOX_ART_UNBEKANNT, blockerLever, crossoverState, geraetZeile, loaderLabel, stateLabel,
  type BoxVerlauf, type EdgeUpdatesRelease, type FleetRow, type VerlaufEintrag,
} from '../../adminEdgeUpdates';
import {
  boxFakten, linieDerBox, stufe1Hinweis, verbindungSicht, verlaufSicht, type VerlaufZeile,
} from '../../geraeteUpdates';
import { SatzText } from './GeraeteUpdates';
import { UpdateActionError } from './UpdateActionError';

/** Ein Verlauf als Zeitleiste (Box-Seite und Release-Seite). */
export function Zeitleiste({ zeilen, testId }: { zeilen: VerlaufZeile[]; testId?: string }) {
  return (
    <ol className="vp-gu-verlauf" data-testid={testId}>
      {zeilen.map((z, i) => (
        <li key={i} className="vp-gu-ereignis">
          <span className="wann">{z.wann}</span>
          <span className="linie" aria-hidden="true"><i className={z.ton} /></span>
          <span className="was">
            <b><SatzText satz={z.titel} /></b>
            {z.text && <small>{z.text}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Die Box-Seite (Geräte & Updates G7, Board Abschnitt 5): drei Kästen - läuft
 * (meldet die Box) · angefragt (Portal) · zuletzt bestätigt (Box) - und der
 * ganze Verlauf dieser Box. Eine Box mit Stufe 1 bekommt oben den Grund in
 * einem Satz und die Schritte zum Nachrüsten (E3 A): das bleibt Handarbeit
 * über den Wartungstunnel, das Portal erkennt das Ergebnis selbst.
 */
export function BoxSeite({
  row, neuesterDerLinie, ladeVerlauf, busy, error, onClose, onAnfragen, onZurueckziehen, onFernwartung,
  onGeraeteseite,
}: {
  row: FleetRow;
  /** Das neueste Release der Linie dieser Box - die Fassung zum Nachrüsten. */
  neuesterDerLinie: EdgeUpdatesRelease | null;
  ladeVerlauf: (deviceId: string) => Promise<BoxVerlauf>;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** „Update anfragen …" - fehlt bei Stufe 1 und bei unbekannter Linie. */
  onAnfragen?: () => void;
  /** „Anfrage zurückziehen" - nur, wenn die Box eine Anfrage trägt. */
  onZurueckziehen?: () => void;
  onFernwartung?: () => void;
  onGeraeteseite?: () => void;
}) {
  const [eintraege, setEintraege] = useState<VerlaufEintrag[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [jetzt] = useState(() => new Date());

  useEffect(() => {
    let aktiv = true;
    setLadeFehler(null);
    ladeVerlauf(row.deviceId)
      .then((v) => { if (aktiv) setEintraege(v.eintraege); })
      .catch((err) => {
        if (aktiv) setLadeFehler(err instanceof ApiError ? err.message : 'Der Verlauf dieser Box ließ sich nicht laden.');
      });
    return () => { aktiv = false; };
  }, [row.deviceId, versuch]);

  const linie = linieDerBox(row);
  const stufe1 = row.stand === 'hand' || row.stufe1 === true;
  const verbindung = verbindungSicht(row, jetzt);
  const fakten = useMemo(() => boxFakten(row, eintraege, jetzt), [row, eintraege, jetzt]);
  const zeilen = useMemo(() => (eintraege ? verlaufSicht(eintraege, jetzt) : []), [eintraege, jetzt]);
  const hinweis = stufe1 ? stufe1Hinweis(row) : null;
  const vertrauen = crossoverState(row.trust, row.boxArt, row.loader);
  const zustand = stateLabel(row.state);
  const lever = blockerLever(row.blocker);
  const name = row.siteName?.trim() || row.label || row.externalRef;

  return (
    <Modal open breit title={name} onClose={onClose}>
      <div className="vp-gu-blatt" data-testid="box-seite">
        <div className="vp-gu-blatt-kopf">
          <span className="vp-gu-leise vp-gu-klein">Box · {linie ? BOX_ART_LABELS[linie] : BOX_ART_UNBEKANNT}</span>
          <div className="vp-gu-plattformen">
            <span className={`vp-gu-chip ${linie ?? 'unbekannt'}`}>{linie ? BOX_ART_LABELS[linie] : BOX_ART_UNBEKANNT}</span>
            <span className="vp-gu-chip hw" data-testid="box-seite-geraet">{geraetZeile(row)}</span>
            <span className={`vp-gu-badge ${verbindung.zustand === 'online' ? 'ok' : verbindung.zustand === 'offline' ? 'warn' : 'off'}`}>
              <i className="p" aria-hidden="true" />{verbindung.text}{verbindung.gesehen ? ` · ${verbindung.gesehen}` : ''}
            </span>
            <span className="vp-gu-chip hw vp-gu-mono">{row.externalRef}</span>
          </div>
        </div>
        <UpdateActionError error={error} />

        {hinweis && (
          <>
            <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-box-updates">
              <h3 id="vp-gu-box-updates">Updates</h3>
              <div className="vp-gu-hinweis" data-testid="box-seite-stufe1">
                <b>Nimmt keine Updates aus dem Portal an (Stufe 1).</b>
                <span>{hinweis.grund}</span>
                <span>Einmal nachrüsten, danach kommt jede Fassung über das Portal. Box-Daten bleiben.</span>
              </div>
            </section>
            <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-box-nachruesten">
              <h3 id="vp-gu-box-nachruesten">Nachrüsten · einmal, ca. 1 Min. Unterbrechung</h3>
              <ol className="vp-gu-schritte" data-testid="box-seite-schritte">
                <li>
                  Fernwartungsfenster für diese Box öffnen (60 Min.).
                  {onFernwartung && (
                    <div>
                      <Button variant="outline" size="sm" iconLeft={<Icon name="shield" size={16} />} onClick={onFernwartung}>
                        Fenster öffnen
                      </Button>
                    </div>
                  )}
                </li>
                <li>
                  Fassung zum Nachrüsten:{' '}
                  {neuesterDerLinie
                    ? <><span className="vp-gu-mono">{neuesterDerLinie.version}</span>{neuesterDerLinie.signed ? ', signiert' : ' (nicht signiert – erst ein signiertes Release nehmen)'}</>
                    : 'das neueste signierte Release dieser Linie'}
                  .
                </li>
                <li>
                  Am eigenen Rechner: sichern, <span className="vp-gu-mono">install.sh</span>, neu starten (Runbook
                  „Nachrüsten“, Schritte 3–5).
                </li>
                <li>{hinweis.fertig}</li>
              </ol>
            </section>
          </>
        )}

        <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-box-software">
          <h3 id="vp-gu-box-software">Software</h3>
          <div className="vp-gu-fakten" data-testid="box-seite-fakten">
            {fakten.map((f) => (
              <div key={f.wer} className="vp-gu-fakt">
                <small>{f.wer}</small>
                <b className="vp-gu-mono">{f.wert}</b>
                <span>{f.satz}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-box-verlauf">
          <h3 id="vp-gu-box-verlauf">Verlauf</h3>
          {ladeFehler ? (
            <div className="vp-alert vp-alert-warn" role="alert">
              {ladeFehler}{' '}
              <Button variant="ghost" size="sm" onClick={() => setVersuch((v) => v + 1)}>Erneut versuchen</Button>
            </div>
          ) : eintraege == null ? (
            <p className="vp-gu-leise vp-gu-klein">Der Verlauf wird geladen …</p>
          ) : zeilen.length === 0 ? (
            <p className="vp-gu-leise vp-gu-klein">Für diese Box ist noch nichts verzeichnet.</p>
          ) : (
            <Zeitleiste zeilen={zeilen} testId="box-seite-verlauf" />
          )}
          <div className="vp-gu-aktionen">
            {onAnfragen && (
              <Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} disabled={busy} onClick={onAnfragen}>
                Update anfragen …
              </Button>
            )}
            {onZurueckziehen && (
              <Button variant={stufe1 ? 'outline' : 'ghost'} size="sm" disabled={busy} onClick={onZurueckziehen}>
                Anfrage zurückziehen
              </Button>
            )}
            {onFernwartung && !stufe1 && (
              <Button variant="ghost" size="sm" iconLeft={<Icon name="shield" size={16} />} onClick={onFernwartung}>
                Fernwartung
              </Button>
            )}
            {onGeraeteseite && (
              <Button variant="ghost" size="sm" onClick={onGeraeteseite}>Geräteseite öffnen</Button>
            )}
          </div>
        </section>

        <details className="vp-gu-blatt-teil vp-gu-technik">
          <summary>Technik</summary>
          <dl>
            <dt>Update-Zustand</dt>
            <dd data-testid="box-seite-zustand">
              {zustand.label}{row.reason ? ` – ${row.reason}` : ''}{lever ? ` Hebel: ${lever}` : ''}
            </dd>
            <dt>Vertrauen</dt>
            <dd data-testid="box-seite-vertrauen">{vertrauen.label}{vertrauen.detail ? ` – ${vertrauen.detail}` : ''}</dd>
            {loaderLabel(row.loader) && (
              <>
                <dt>Loader</dt>
                <dd data-testid="box-seite-loader">{loaderLabel(row.loader)}</dd>
              </>
            )}
            <dt>Kunde · Anlage</dt>
            <dd>{row.tenantName} · {row.siteName}</dd>
            <dt>Geräte-ID</dt>
            <dd className="vp-gu-mono">{row.deviceId}</dd>
          </dl>
        </details>
      </div>
    </Modal>
  );
}
