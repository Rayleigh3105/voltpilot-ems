import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type UemsDatenquelleBestaetigt, type UemsDatenquelleVorschlagsliste } from '../api';
import {
  DQ_FEHLER,
  DQ_GEAENDERT,
  DQ_LADEFEHLER,
  DQ_LAEDT,
  DQ_LEER,
  DQ_NEU_LADEN,
  DQ_OHNE,
  DQ_SATZ,
  DQ_TITEL,
  DQ_UEBERNEHMEN,
  dqAusgelassen,
  dqErgebnisSatz,
  dqHinzufuegenAnfrage,
  dqHinzufuegenWort,
  dqUebernehmenAnfrage,
  dqZeilen,
  istDqGeaendert,
} from '../datenquelleVorschlag';
import { Recht } from './Recht';
import './DatenquelleVorschlagListe.css';

/**
 * Die Datenquellen-Vorschlagsliste EINER Anlage (UEMS AP-06 IP-4): `GET …/data-sources/vorschlag`
 * zeigt, welche Adressen die Box schon liest und welche Geräte dahinter stehen; erst „Übernehmen“
 * (`POST …/vorschlag/uebernehmen`, genau die gezeigten Zeilen) legt Datenquellen an und ordnet die
 * Geräte zu (AP-06 E1 = A). Eine gesperrte Zeile, deren Adresse schon eine von Hand angelegte Quelle
 * trägt, hängt „Zu DQ-n hinzufügen“ an diese Quelle. Eine 409 lädt die Liste neu, wie Schritt 3.
 *
 * Selbsttragend (lädt selbst, nur `siteId`): Schritt 2 des Messen-Assistenten ist der erste
 * Aufrufer, der Übernahme-Assistent für Bestandskunden soll sie wiederverwenden.
 */
export function DatenquelleVorschlagListe({ siteId, anlageName }: { siteId: string; anlageName: string }) {
  const [liste, setListe] = useState<UemsDatenquelleVorschlagsliste | null>(null);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [runde, setRunde] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    setLadeFehler(false);
    api.datenquellenVorschlag(siteId).then(
      (l) => {
        if (aktiv) setListe(l);
      },
      () => {
        if (aktiv) setLadeFehler(true);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [siteId, runde]);

  async function sende(anfrage: UemsDatenquelleBestaetigt[]) {
    if (busy || anfrage.length === 0) return;
    setBusy(true);
    setFehler(null);
    setHinweis(null);
    try {
      const r = await api.datenquellenVorschlagUebernehmen(siteId, anfrage);
      setErgebnis(dqErgebnisSatz(r));
      setRunde((n) => n + 1);
    } catch (e) {
      if (istDqGeaendert(e)) {
        setHinweis(DQ_GEAENDERT);
        setRunde((n) => n + 1);
      } else {
        setFehler(e instanceof Error && e.message ? e.message : DQ_FEHLER);
      }
    } finally {
      setBusy(false);
    }
  }

  const zeilen = liste ? dqZeilen(liste) : [];
  const frei = liste ? dqUebernehmenAnfrage(liste) : [];
  const ausgelassen = liste ? dqAusgelassen(liste) : [];

  return (
    <div className="vp-dqv" data-testid="dq-vorschlag" data-anlage={siteId}>
      <p className="vp-dqv-titel">{DQ_TITEL}</p>
      {ergebnis && <p className="vp-dqv-ergebnis" role="status">{ergebnis}</p>}
      {hinweis && <p className="vp-dqv-hinweis" role="status">{hinweis}</p>}
      {ladeFehler ? (
        <div className="vp-dqv-fehler">
          <p>{DQ_LADEFEHLER}</p>
          <Button variant="outline" size="sm" onClick={() => setRunde((n) => n + 1)}>
            {DQ_NEU_LADEN}
          </Button>
        </div>
      ) : !liste ? (
        <p className="vp-dqv-satz" aria-busy="true">{DQ_LAEDT}</p>
      ) : zeilen.length === 0 ? (
        <p className="vp-dqv-satz" data-testid="dq-vorschlag-leer">{DQ_LEER}</p>
      ) : (
        <>
          <p className="vp-dqv-satz">{DQ_SATZ}</p>
          <ul className="vp-dqv-liste" aria-label={`Datenquellen-Vorschläge für ${anlageName}`}>
            {zeilen.map((z) => (
              <li key={z.schluessel} className="vp-dqv-zeile" data-art={z.art}>
                <span className="vp-dqv-kopf">{z.kopf}</span>
                <span className="vp-dqv-geraete">{`Dahinter: ${z.geraete}`}</span>
                <span className={z.art === 'frei' ? 'vp-dqv-folge' : 'vp-dqv-sperre'}>{z.satz}</span>
                {z.art === 'hinzufuegen' && z.ziel && (
                  <Recht aktion="datenquelle.bearbeiten">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void sende(dqHinzufuegenAnfrage(z.vorschlag))}
                    >
                      {dqHinzufuegenWort(z.ziel)}
                    </Button>
                  </Recht>
                )}
              </li>
            ))}
          </ul>
          {frei.length > 0 && (
            <div>
              <Recht aktion="datenquelle.bearbeiten">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  aria-label={`Datenquellen übernehmen für ${anlageName}`}
                  onClick={() => void sende(frei)}
                >
                  {DQ_UEBERNEHMEN}
                </Button>
              </Recht>
            </div>
          )}
        </>
      )}
      {fehler && <p className="vp-ma-fehler" role="alert">{fehler}</p>}
      {ausgelassen.length > 0 && (
        <details className="vp-ma-ausgelassen">
          <summary>{`${DQ_OHNE} (${ausgelassen.length.toLocaleString('de-DE')})`}</summary>
          <ul className="vp-ma-details">
            {ausgelassen.map((a) => (
              <li key={a.schluessel}>{a.satz}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
