import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import {
  api,
  ApiError,
  type Einspeiseverguetung,
  type Erzeugungsanlage,
  type Erzeugungsanlagen,
  type ErzeugungsanlageVorschlag,
} from '../api';
import * as E from '../erzeugungsanlagen';
import { ErzeugungsanlageDialog } from './ErzeugungsanlageDialog';
import { Recht } from './Recht';
import './Erzeugungsanlagen.css';

type Dialog = { ea: Erzeugungsanlage | null; vorschlag: ErzeugungsanlageVorschlag | null } | null;

/**
 * Die Erzeugungsanlagen einer Anlage (Messkonzepte S1, nur Anzeige): je EA ihr Satz mit Herkunft, Inbetriebnahme,
 * Leistung, Einspeiseart und Förderende; dazu Fassungen, die Komponenten, die sie speisen, und die Vorschläge
 * weiterer EA. Anlegen, bearbeiten und Vorschläge annehmen laufen über {@link ErzeugungsanlageDialog}.
 *
 * Steht am Netzanschluss (Standort › Netzanschlüsse) und - ab der zweiten EA - im Blatt „Einspeisevergütung“.
 * `anlage` ist die Karte der Anlage: mit ihr sagt die Liste, womit Fahrplan und Erlöse heute rechnen.
 */
export function ErzeugungsanlagenListe({
  siteId,
  liste,
  heute,
  anlage,
  standort,
  onGeaendert,
}: {
  siteId: string;
  liste: Erzeugungsanlagen;
  heute: string;
  /** Die Karte „Einspeisevergütung“ der Anlage; null = nicht geladen. */
  anlage?: Einspeiseverguetung | null;
  /** Der Standort der Seite für die Rechteprüfung (Standort-Seite); ohne Angabe der der Anlage. */
  standort?: string | null;
  onGeaendert: (neu: Erzeugungsanlagen) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eas = liste.erzeugungsanlagen;
  const folgt = eas.find((x) => x.folgtAnlage) ?? null;

  async function gehoertZu(ea: Erzeugungsanlage, v: ErzeugungsanlageVorschlag) {
    setBusy(true);
    setFehler(null);
    try {
      onGeaendert(await api.erzeugungsanlageVerweisen(siteId, ea.id, v.komponenteId, null));
    } catch (err) {
      setFehler(err instanceof ApiError ? err.message : 'Der Verweis wurde nicht gespeichert.');
    } finally {
      setBusy(false);
    }
  }

  async function loesen(ea: Erzeugungsanlage, verweisId: string) {
    setBusy(true);
    setFehler(null);
    try {
      onGeaendert(await api.erzeugungsanlageVerweisLoesen(siteId, ea.id, verweisId));
    } catch (err) {
      setFehler(err instanceof ApiError ? err.message : 'Der Verweis wurde nicht gelöst.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-ea" data-testid="erzeugungsanlagen">
      {eas.length === 0 ? (
        <p className="vp-note">
          Noch keine Erzeugungsanlage eingetragen. Verknüpfen Sie die Anlage mit dem Marktstammdatenregister, oder fügen
          Sie eine Erzeugungsanlage hinzu.
        </p>
      ) : (
        <ul className="vp-ea-liste">
          {eas.map((ea) => {
            const z = E.satzZeile(ea);
            const aeltere = ea.fassungen.filter((f) => f.id !== ea.fassung?.id);
            return (
              <li key={ea.id} className="vp-ea-karte" data-testid={`ea-${ea.nummer}`}>
                <div className="vp-ea-kopf">
                  <b>{ea.bezeichnung}</b>
                  {ea.art !== 'pv' && <span className="vp-note">{E.ART[ea.art]}</span>}
                  <Recht aktion={E.RECHT} standort={standort}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDialog({ ea, vorschlag: null })}
                    >
                      Bearbeiten
                    </Button>
                  </Recht>
                </div>
                <p className={`vp-ea-satz${z.warn ? ' is-warn' : ''}`}>
                  <span className="vp-ea-wert">{z.wert}</span>
                  <span className="vp-note">{z.sub}</span>
                </p>
                <p className="vp-note vp-ea-eckdaten">{E.eckdaten(ea)}</p>
                {E.hinweise(ea).map((h) => (
                  <p key={h} className="vp-note vp-ea-hinweis">
                    {h}
                  </p>
                ))}
                {ea.registryUnitId && <p className="vp-note vp-ea-eckdaten">MaStR {ea.registryUnitId}</p>}
                {ea.komponenten.length > 0 && (
                  <ul className="vp-ea-komponenten" aria-label={`Speist ${ea.bezeichnung}`}>
                    {ea.komponenten.map((k) => (
                      <li key={k.id}>
                        <span className="vp-note">gespeist von {E.komponenteText(k)}</span>
                        {(k.gueltigBis == null || k.gueltigBis >= heute) && (
                          <Recht aktion={E.RECHT} standort={standort}>
                            <button
                              type="button"
                              className="vp-linklike"
                              disabled={busy}
                              onClick={() => void loesen(ea, k.id)}
                            >
                              lösen
                            </button>
                          </Recht>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {aeltere.length > 0 && (
                  <details className="vp-ea-fassungen">
                    <summary>Frühere und spätere Fassungen ({aeltere.length})</summary>
                    <ul>
                      {aeltere.map((f) => (
                        <li key={f.id} className="vp-note">
                          {E.fassungText(f)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {liste.vorschlaege.length > 0 && (
        <div className="vp-ea-vorschlaege" data-testid="ea-vorschlaege">
          {liste.vorschlaege.map((v) => (
            <div key={v.komponenteId} className="vp-ea-vorschlag">
              <p className="vp-note">
                {E.vorschlagText(v)} Hat er eine eigene Inbetriebnahme, ist er eine eigene Erzeugungsanlage.
              </p>
              <Recht aktion={E.RECHT} standort={standort}>
                <div className="vp-ea-vorschlag-knoepfe">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({ ea: null, vorschlag: v })}>
                    Als Erzeugungsanlage anlegen
                  </Button>
                  {eas.map((ea) => (
                    <Button key={ea.id} variant="ghost" size="sm" disabled={busy} onClick={() => void gehoertZu(ea, v)}>
                      Gehört zu {ea.bezeichnung}
                    </Button>
                  ))}
                </div>
              </Recht>
            </div>
          ))}
        </div>
      )}
      {eas.length >= 2 && <p className="vp-note vp-ea-anzeige">{E.nurAnzeigeHinweis(anlage ?? null)}</p>}
      {fehler && (
        <div className="vp-alert vp-alert-err" role="alert">
          {fehler}
        </div>
      )}
      <Recht aktion={E.RECHT} standort={standort}>
        <div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({ ea: null, vorschlag: null })}>
            {E.HINZUFUEGEN}
          </Button>
        </div>
      </Recht>
      {dialog && (
        <ErzeugungsanlageDialog
          siteId={siteId}
          ea={dialog.ea}
          vorschlag={dialog.vorschlag}
          heute={heute}
          ersteFolgt={dialog.ea ? null : folgt}
          onClose={() => setDialog(null)}
          onGespeichert={(neu) => {
            setDialog(null);
            onGeaendert(neu);
          }}
        />
      )}
    </div>
  );
}
