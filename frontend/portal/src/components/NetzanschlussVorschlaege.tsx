import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Netzanschluss, type NetzanschlussVorschlag, type StandortAmStichtag } from '../api';
import { NetzanschlussDialog } from './NetzanschlussDialog';
import * as N from '../netzanschlussListe';

/** Wird nur innerhalb des Rechts netzanschluss.verwalten am messenden Standort eingebunden. */
export function NetzanschlussVorschlaege({
  standort,
  liste,
  heute,
  onGespeichert,
}: {
  standort: StandortAmStichtag;
  liste: Netzanschluss[];
  heute: string;
  onGespeichert: (n: Netzanschluss) => void;
}) {
  const [vorschlaege, setVorschlaege] = useState<NetzanschlussVorschlag[]>([]);
  const [dialog, setDialog] = useState<NetzanschlussVorschlag | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [lauf, setLauf] = useState(0);
  const [meldung, setMeldung] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const ausloeser = useRef<HTMLElement | null>(null);
  const titel = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.netzanschlussVorschlaege(standort.id).then(
      (v) => {
        if (aktiv) setVorschlaege(v);
      },
      () => {
        if (aktiv) setFehler('Die Vorschläge konnten nicht geladen werden.');
      },
    );
    return () => {
      aktiv = false;
    };
  }, [standort.id, lauf]);
  const schliessen = () => {
    setDialog(null);
    requestAnimationFrame(() => ausloeser.current?.focus());
  };
  const verwerfen = async (v: NetzanschlussVorschlag) => {
    if (busy) return;
    setBusy(true);
    setFehler(null);
    try {
      await api.netzanschlussVerwerfen(standort.id, v.anlage_id);
      setVorschlaege((vs) => vs.filter((x) => x.anlage_id !== v.anlage_id));
      setMeldung('Vorschlag verworfen.');
      requestAnimationFrame(() => (titel.current ?? status.current)?.focus());
    } catch (e) {
      setFehler(N.fehlerSatz(e));
    } finally {
      setBusy(false);
    }
  };
  if (!vorschlaege.length && !fehler)
    return meldung ? (
      <p ref={status} tabIndex={-1} role="status">
        {meldung}
      </p>
    ) : null;
  return (
    <div className="vp-sb-karte vp-na-vorschlaege">
      <h2 ref={titel} tabIndex={-1}>
        Netzanschluss für vorhandene Anlagen
      </h2>
      <p>Anlage und Bindungsbeginn sind vorausgewählt. Angaben zum Netzanschluss bitte ergänzen.</p>
      {fehler && (
        <div role="alert">
          <p>{fehler}</p>
          <Button variant="outline" onClick={() => setLauf((n) => n + 1)}>
            Erneut versuchen
          </Button>
        </div>
      )}
      <ul className="vp-na-liste">
        {vorschlaege.map((v) => (
          <li key={v.anlage_id} data-testid={`vorschlag-${v.anlage_id}`}>
            <h3>
              {v.kennzeichen} · {v.name}
            </h3>
            <p>
              {v.anlage_name} · Bindung ab {N.tagText(v.bindung_ab)}
            </p>
            <p>Netzbetreiber, Marktlokation, Leistung und Messung: bitte ergänzen.</p>
            <div className="vp-na-kopf">
              <Button
                disabled={busy}
                onClick={(e) => {
                  ausloeser.current = e.currentTarget;
                  setDialog(v);
                }}
              >
                Übernehmen
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void verwerfen(v)}>
                Verwerfen
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {dialog && (
        <NetzanschlussDialog
          standort={standort}
          liste={liste}
          vorschlag={dialog.kennzeichen}
          bestand={dialog}
          ziel={null}
          heute={heute}
          onClose={schliessen}
          onGespeichert={(n) => {
            setDialog(null);
            onGespeichert(n);
          }}
        />
      )}
    </div>
  );
}
