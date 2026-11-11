import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { VpPicker } from '../../components/VpPicker';
import {
  BOX_ART_LABELS, releaseBoxArt, type BoxArt, type EdgeEignung, type EdgeUpdatesRelease, type FleetRow,
} from '../../adminEdgeUpdates';
import { anzufragen, ersteBox, verteilGruppen, vorauswahl, wann, type VerteilGruppe } from '../../geraeteUpdates';
import { UpdateActionError } from './UpdateActionError';

/** Womit der Dialog aufgeht: die Linie, ggf. ein Release und - für „An die übrigen" - die Boxen. */
export interface VerteilStart {
  art: BoxArt;
  releaseSeq?: number | null;
  /** Nur diese Boxen vorauswählen (E1 A „An die übrigen"). */
  nur?: string[] | null;
  reihenfolge?: 'eine' | 'alle';
}

const boxen = (n: number) => `${n} ${n === 1 ? 'Box' : 'Boxen'}`;

/**
 * „Update verteilen" (Geräte & Updates G6, Board Abschnitt 4): EIN Dialog,
 * drei Teile - Release, Boxen, Reihenfolge. Das Portal fragt an, die Box
 * entscheidet und meldet „angenommen" und „bestätigt" zurück.
 *
 * - Nur SIGNIERTE Releases DIESER Linie.
 * - Jede Box steht in genau einer Gruppe (Eignung des Servers, G1): bereit,
 *   wartet bis sie online ist, schon angefragt, schon aktuell, kann nicht - mit
 *   Grund. Stufe-1-Boxen sind nie wählbar; ihr Weg ist das Nachrüsten.
 * - „Erst eine Box" ist ein VORSCHLAG, keine Sperre (Entscheid E1 A): die
 *   übrigen fragt man später als neuen Ein-Schritt-Lauf an; im Server wartet
 *   nichts. Der Knopf sagt, was passiert: „1 Box anfragen".
 */
export function VerteilDialog({
  start, releases, fleet, boxenDerLinie, ladeEignung, busy, error, onClose, onStart, onNachruesten,
}: {
  start: VerteilStart;
  releases: EdgeUpdatesRelease[];
  fleet: FleetRow[];
  boxenDerLinie: number;
  ladeEignung: (releaseSeq: number) => Promise<EdgeEignung>;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (releaseSeq: number, devices: string[]) => void;
  onNachruesten: (deviceId: string) => void;
}) {
  const liste = useMemo(
    () => releases.filter((r) => releaseBoxArt(r) === start.art && r.signed).sort((a, b) => b.releaseSeq - a.releaseSeq),
    [releases, start.art],
  );
  const [seq, setSeq] = useState<number | null>(start.releaseSeq ?? liste[0]?.releaseSeq ?? null);
  const [eignung, setEignung] = useState<EdgeEignung | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [reihenfolge, setReihenfolge] = useState<'eine' | 'alle'>(start.reihenfolge ?? 'eine');
  const [erste, setErste] = useState<string | null>(null);
  const [aendern, setAendern] = useState(false);
  // Eine Uhr für diesen Dialog: die Zeit, zu der die Eignung kam.
  const [jetzt, setJetzt] = useState(() => new Date());

  useEffect(() => {
    if (seq == null) return undefined;
    let aktiv = true;
    setEignung(null);
    setLadeFehler(null);
    ladeEignung(seq)
      .then((e) => {
        if (!aktiv) return;
        const nun = new Date();
        const g = verteilGruppen(e, fleet, nun);
        const a = vorauswahl(g, seq === start.releaseSeq ? start.nur ?? null : null);
        setJetzt(nun);
        setEignung(e);
        setAuswahl(a);
        setErste(ersteBox(g, a));
      })
      .catch((err) => {
        if (aktiv) setLadeFehler(err instanceof ApiError ? err.message : 'Wer dieses Release bekommen kann, ließ sich nicht laden.');
      });
    return () => { aktiv = false; };
    // `fleet` und `start` sind für einen geöffneten Dialog fest; neu geladen wird je Release.
  }, [seq, versuch]);

  const gruppen: VerteilGruppe[] = useMemo(() => (eignung ? verteilGruppen(eignung, fleet, jetzt) : []), [eignung, fleet, jetzt]);
  const waehlbar = gruppen.flatMap((g) => g.boxen).filter((b) => b.waehlbar);
  const gewaehlt = waehlbar.filter((b) => auswahl.includes(b.deviceId));
  const ersteBoxName = gewaehlt.find((b) => b.deviceId === erste)?.name ?? gewaehlt[0]?.name ?? '';
  const ziel = anzufragen(gruppen, auswahl, reihenfolge, erste);
  const kannNicht = gruppen.find((g) => g.id === 'kann_nicht')?.boxen.length ?? 0;
  const neuestes = liste[0]?.releaseSeq ?? null;

  const umschalten = (id: string) => {
    const neu = auswahl.includes(id) ? auswahl.filter((x) => x !== id) : [...auswahl, id];
    setAuswahl(neu);
    if (!neu.includes(erste ?? '')) setErste(ersteBox(gruppen, neu));
  };
  const alle = gewaehlt.length === waehlbar.length;

  const n = ziel.length;
  // Der Fuß als einzelne Teile: das Modal ordnet sie am Telefon (Hauptknopf oben, der Satz darüber).
  const fuss = (
    <>
      <p className="vp-gu-fuss-satz" data-testid="verteil-satz">
        {n === 0
          ? (waehlbar.length === 0 ? 'Keine Box dieser Linie kann dieses Release jetzt bekommen.' : 'Keine Box gewählt.')
          : <>Fragt jetzt <b>{boxen(n)}</b> an.</>}
        {n > 0 && (
          <span className="vp-gu-fuss-lang">
            {' '}
            {n === 1
              ? 'Ob und wann sie installiert, entscheidet die Box; sie meldet „angenommen“ und „bestätigt“ zurück.'
              : 'Ob und wann sie installieren, entscheiden die Boxen; sie melden „angenommen“ und „bestätigt“ zurück.'}
          </span>
        )}
        {kannNicht > 0 && ` ${boxen(kannNicht)} ${kannNicht === 1 ? 'kann' : 'können'} nicht und ${kannNicht === 1 ? 'bleibt, wie sie ist' : 'bleiben, wie sie sind'}.`}
      </p>
      <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
      <Button
        variant="primary"
        iconLeft={<Icon name="refresh-cw" size={16} />}
        disabled={busy || n === 0 || seq == null}
        onClick={() => seq != null && onStart(seq, ziel)}
      >
        {`${boxen(n)} anfragen`}
      </Button>
    </>
  );

  return (
    <Modal open breit title={`Update verteilen · ${BOX_ART_LABELS[start.art]}`}
      icon={<Icon name="refresh-cw" size={20} />} onClose={onClose} footer={fuss}>
      <div className="vp-gu-verteil" data-testid="verteil-dialog">
        <UpdateActionError error={error} />

        <fieldset className="vp-gu-teil">
          <legend><span className="n" aria-hidden="true">1</span>Release</legend>
          {liste.length === 0 ? (
            <p className="vp-gu-leise vp-gu-klein">Für diese Linie ist kein signiertes Release registriert.</p>
          ) : liste.map((r) => (
            <label key={r.releaseSeq} className={`vp-gu-wahl${seq === r.releaseSeq ? ' an' : ''}`}>
              <input type="radio" name="vp-gu-release" checked={seq === r.releaseSeq} onChange={() => setSeq(r.releaseSeq)} />
              <span>
                <b><span className="vp-gu-mono">{r.version}</span> · signiert{wann(r.createdAt, jetzt) ? ` · ${wann(r.createdAt, jetzt)}` : ''}</b>
                <small>
                  {r.notes ? `${r.notes} · ` : ''}läuft auf {r.runningOnDevices} von {boxen(boxenDerLinie)}
                </small>
              </span>
              {r.releaseSeq === neuestes ? <span className="vp-gu-badge ok">neuestes</span> : <span />}
            </label>
          ))}
          <p className="vp-gu-leise vp-gu-klein">
            Nur signierte Releases dieser Linie. Eine Box, die schon eine neuere Fassung fährt, lehnt eine ältere ab.
          </p>
        </fieldset>

        <fieldset className="vp-gu-teil" aria-busy={eignung == null && !ladeFehler}>
          <legend><span className="n" aria-hidden="true">2</span>Boxen</legend>
          {ladeFehler ? (
            <div className="vp-alert vp-alert-warn" role="alert">
              {ladeFehler}{' '}
              <Button variant="ghost" size="sm" onClick={() => setVersuch((v) => v + 1)}>Erneut versuchen</Button>
            </div>
          ) : eignung == null ? (
            <p className="vp-gu-leise vp-gu-klein" data-testid="verteil-laedt">Wer dieses Release bekommen kann, wird geprüft …</p>
          ) : (
            <>
              {waehlbar.length > 1 && (
                <button type="button" className="vp-gu-link" onClick={() => {
                  const neu = alle ? [] : waehlbar.map((b) => b.deviceId);
                  setAuswahl(neu);
                  setErste(ersteBox(gruppen, neu));
                }}>
                  {alle ? 'Keine wählen' : `Alle ${waehlbar.length} wählen`}
                </button>
              )}
              {gruppen.length === 0 && <p className="vp-gu-leise vp-gu-klein">Diese Linie hat keine Box.</p>}
              {gruppen.map((g) => (
                <div key={g.id} className="vp-gu-wahl-gruppe" data-testid={`verteil-${g.id}`}>
                  <div className="vp-gu-wahl-titel">{g.titel} · {g.boxen.length}</div>
                  {g.boxen.map((b) => (
                    <label key={b.deviceId}
                      className={`vp-gu-wahl${auswahl.includes(b.deviceId) && b.waehlbar ? ' an' : ''}${b.waehlbar ? '' : ' gesperrt'}`}>
                      <input type="checkbox" disabled={!b.waehlbar} checked={b.waehlbar && auswahl.includes(b.deviceId)}
                        onChange={() => umschalten(b.deviceId)} />
                      <span>
                        <b>{b.name}</b>
                        <small>{b.text}</small>
                      </span>
                      {b.nachruesten ? (
                        <button type="button" className="vp-gu-link" onClick={(e) => { e.preventDefault(); onNachruesten(b.deviceId); }}>
                          Nachrüsten
                        </button>
                      ) : <span />}
                    </label>
                  ))}
                </div>
              ))}
              {eignung.andereLinie > 0 && (
                <p className="vp-gu-leise vp-gu-klein">
                  {boxen(eignung.andereLinie)} der anderen Linie {eignung.andereLinie === 1 ? 'kommt' : 'kommen'} für dieses Release nicht in Frage.
                </p>
              )}
            </>
          )}
        </fieldset>

        {gewaehlt.length > 1 && (
          <fieldset className="vp-gu-teil">
            <legend><span className="n" aria-hidden="true">3</span>Reihenfolge</legend>
            <label className={`vp-gu-wahl${reihenfolge === 'eine' ? ' an' : ''}`}>
              <input type="radio" name="vp-gu-reihenfolge" checked={reihenfolge === 'eine'} onChange={() => setReihenfolge('eine')} />
              <span>
                <b>Erst eine Box: {ersteBoxName}</b>
                <small>
                  Die übrigen {gewaehlt.length - 1} fragst du an, wenn {ersteBoxName} bestätigt hat; die Linien-Karte bietet
                  dir dann „An die übrigen {gewaehlt.length - 1}“ an. Nichts wartet im Server.
                </small>
              </span>
              <span className="vp-gu-badge ok">Empfehlung</span>
            </label>
            {reihenfolge === 'eine' && (
              aendern ? (
                <div className="vp-gu-erste">
                  <VpPicker
                    label="Welche Box zuerst?"
                    options={gewaehlt.map((b) => ({ value: b.deviceId, label: b.name, sub: b.text }))}
                    value={erste}
                    onChange={(v) => { setErste(v); setAendern(false); }}
                  />
                </div>
              ) : (
                <button type="button" className="vp-gu-link vp-gu-erste" onClick={() => setAendern(true)}>
                  Erste Box ändern
                </button>
              )
            )}
            <label className={`vp-gu-wahl${reihenfolge === 'alle' ? ' an' : ''}`}>
              <input type="radio" name="vp-gu-reihenfolge" checked={reihenfolge === 'alle'} onChange={() => setReihenfolge('alle')} />
              <span>
                <b>Alle {gewaehlt.length} auf einmal</b>
                <small>Ein Schritt für alle gewählten Boxen.</small>
              </span>
              <span />
            </label>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
