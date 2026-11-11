import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import {
  BOX_ART_LABELS, releaseBoxArt, type BoxArt, type EdgeReleaseSeite, type EdgeUpdatesRelease, type FleetRow,
} from '../../adminEdgeUpdates';
import { boxName, linieDerBox, releaseInhalt, verteiltSicht, wann } from '../../geraeteUpdates';
import { Zeitleiste } from './Zeitleiste';
import { SatzText } from './GeraeteUpdates';

const linienBoxen = (art: BoxArt, n: number) =>
  `${n} ${art === 'light' ? (n === 1 ? 'Edge-Light-Box' : 'Edge-Light-Boxen') : (n === 1 ? 'Docker-Box' : 'Docker-Boxen')}`;

/**
 * Die Release-Seite (Geräte & Updates G7, Board Abschnitt 5): was drin ist
 * (je Gerät, mit Größe und ob es fertig im Portal liegt), was neu ist (nur
 * Änderungen an der Box seit dem letzten Release DERSELBEN Linie), wer signiert
 * hat, wo es läuft und wann es verteilt wurde. Quelle ist die Release-Seite der
 * API (G4); was sie nicht sagt, wird nicht ergänzt.
 */
export function ReleaseSeite({
  releaseSeq, releases, fleet, ladeSeite, onClose, onVerteilen, onBox,
}: {
  releaseSeq: number;
  releases: EdgeUpdatesRelease[];
  fleet: FleetRow[];
  ladeSeite: (releaseSeq: number) => Promise<EdgeReleaseSeite>;
  onClose: () => void;
  /** „Verteilen …" - nur für ein signiertes Release. */
  onVerteilen: (release: EdgeUpdatesRelease) => void;
  onBox: (deviceId: string) => void;
}) {
  const [seite, setSeite] = useState<EdgeReleaseSeite | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [jetzt] = useState(() => new Date());
  const release = releases.find((r) => r.releaseSeq === releaseSeq) ?? null;
  const art: BoxArt = release ? releaseBoxArt(release) : 'docker';
  // Der Vorgänger DERSELBEN Linie - „Was ist neu" zählt seit ihm.
  const vorgaenger = useMemo(() => releases
    .filter((r) => releaseBoxArt(r) === art && r.releaseSeq < releaseSeq)
    .sort((a, b) => b.releaseSeq - a.releaseSeq)[0] ?? null, [releases, art, releaseSeq]);

  useEffect(() => {
    let aktiv = true;
    setLadeFehler(null);
    ladeSeite(releaseSeq)
      .then((s) => { if (aktiv) setSeite(s); })
      .catch((err) => {
        if (aktiv) setLadeFehler(err instanceof ApiError ? err.message : 'Die Release-Seite ließ sich nicht laden.');
      });
    return () => { aktiv = false; };
  }, [releaseSeq, versuch]);

  const version = seite?.version ?? release?.version ?? `Release ${releaseSeq}`;
  const signiert = seite?.signed ?? release?.signed ?? false;
  const schluessel = seite?.signingKeyId ?? release?.signingKeyId ?? null;
  const entstanden = wann(seite?.createdAt ?? release?.createdAt, jetzt);
  const commit = seite?.targetCommit ?? release?.targetCommit ?? null;
  const notiz = seite?.notes ?? release?.notes ?? null;

  const byId = new Map(fleet.map((r) => [r.deviceId, r]));
  const laeuftAuf = (seite?.laeuftAuf ?? []).map((id) => byId.get(id)).filter((r): r is FleetRow => !!r);
  const stufe1 = fleet.filter((r) => linieDerBox(r) === art && (r.stand === 'hand' || r.stufe1 === true)).length;

  return (
    // Ein Text als Titel: nur so trägt der Dialog einen Namen (`aria-label` im Modal).
    <Modal open breit title={version} onClose={onClose}>
      <div className="vp-gu-blatt" data-testid="release-seite">
        <div className="vp-gu-blatt-kopf">
          <span className="vp-gu-leise vp-gu-klein">Release · {BOX_ART_LABELS[art]}</span>
          <div className="vp-gu-plattformen">
            {signiert
              ? <span className="vp-gu-badge ok"><i className="p" aria-hidden="true" />signiert{schluessel ? ` · Schlüssel ${schluessel}` : ''}</span>
              : <span className="vp-gu-badge warn"><i className="p" aria-hidden="true" />nicht signiert – nicht verteilbar</span>}
            {entstanden && <span className="vp-gu-chip hw">{entstanden}</span>}
            {commit && <span className="vp-gu-chip hw">Commit {commit}</span>}
            {seite?.erlaubtRueckschritt && <span className="vp-gu-chip hw">Rückschritt erlaubt</span>}
          </div>
        </div>

        {ladeFehler && (
          <div className="vp-alert vp-alert-warn" role="alert">
            {ladeFehler}{' '}
            <Button variant="ghost" size="sm" onClick={() => setVersuch((v) => v + 1)}>Erneut versuchen</Button>
          </div>
        )}

        <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-rel-neu">
          <h3 id="vp-gu-rel-neu">Was ist neu</h3>
          {notiz && <p className="vp-gu-notiz">„{notiz}“</p>}
          {seite == null ? (
            !ladeFehler && <p className="vp-gu-leise vp-gu-klein">Wird geladen …</p>
          ) : seite.aenderungen == null ? (
            <p className="vp-gu-leise vp-gu-klein" data-testid="release-aenderungen">
              Für dieses Release liegt keine Liste der Box-Änderungen vor.
            </p>
          ) : seite.aenderungen.length === 0 ? (
            <p className="vp-gu-leise vp-gu-klein" data-testid="release-aenderungen">
              Keine Änderung an der Box{vorgaenger ? <> seit <span className="vp-gu-mono">{vorgaenger.version}</span></> : ''}.
            </p>
          ) : (
            <>
              <p className="vp-gu-leise vp-gu-klein" data-testid="release-aenderungen">
                Änderungen an der Box{vorgaenger ? <> seit <span className="vp-gu-mono">{vorgaenger.version}</span></> : ''}: {seite.aenderungen.length}
              </p>
              <ul className="vp-gu-schritte">
                {seite.aenderungen.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </>
          )}
        </section>

        {seite && (
          <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-rel-inhalt">
            <h3 id="vp-gu-rel-inhalt">Inhalt</h3>
            <div className="vp-gu-tab-rahmen">
              <table className="vp-gu-tab" data-testid="release-inhalt">
                <thead>
                  <tr><th>Teil</th><th>Gerät</th><th>Größe</th><th>Im Portal</th></tr>
                </thead>
                <tbody>
                  {releaseInhalt(seite).map((z, i) => (
                    <tr key={i}>
                      <td><SatzText satz={z.teil} /></td>
                      <td>{z.geraet}</td>
                      <td>{z.groesse}</td>
                      <td><span className={`vp-gu-badge ${z.portal.ton}`}>{z.portal.text}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {seite && (
          <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-rel-laeuft">
            <h3 id="vp-gu-rel-laeuft">Läuft auf</h3>
            <p data-testid="release-laeuft-auf">
              {laeuftAuf.length} von {linienBoxen(art, seite.boxenDerLinie)}
              {laeuftAuf.length > 0 ? ': ' : '.'}
              {laeuftAuf.slice(0, 6).map((r, i) => (
                <span key={r.deviceId}>
                  {i > 0 ? ', ' : ''}
                  <button type="button" className="vp-gu-link" onClick={() => onBox(r.deviceId)}>{boxName(r)}</button>
                </span>
              ))}
              {laeuftAuf.length > 6 && ` und ${laeuftAuf.length - 6} weitere`}
              {laeuftAuf.length > 0 && '.'}
              {stufe1 > 0 && ` ${stufe1 === 1 ? '1 Box kann' : `${stufe1} Boxen können`} nicht (Stufe 1).`}
            </p>
          </section>
        )}

        {seite && (
          <section className="vp-gu-blatt-teil" aria-labelledby="vp-gu-rel-verteilt">
            <h3 id="vp-gu-rel-verteilt">Verteilt</h3>
            {seite.verteilt.length === 0
              ? <p className="vp-gu-leise vp-gu-klein">Noch nicht verteilt.</p>
              : <Zeitleiste zeilen={verteiltSicht(seite, jetzt)} testId="release-verteilt" />}
            {release && signiert && (
              <div className="vp-gu-aktionen">
                <Button variant="primary" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={() => onVerteilen(release)}>
                  Verteilen …
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
