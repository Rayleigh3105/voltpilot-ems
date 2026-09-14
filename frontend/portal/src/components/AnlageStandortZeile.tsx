import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StandorteAmStichtag, type Unternehmen } from '../api';
import {
  KNOPF_ADRESSE_NACHTRAGEN,
  STANDORT_OBJEKT_LABEL,
  standortDerAnlage,
  standortZeile,
  type AnlageStandort,
} from '../anlageStandort';
import { StandortDialog } from './StandortDialog';
import './AnlageStandortZeile.css';

/**
 * Liest, zu welchem Standort die Anlage heute gehört (`GET /api/v1/standorte`).
 * Scheitert das Lesen oder hat die Anlage keinen, ist `anlageStandort` `null` —
 * und „Meine Anlage“ bleibt, wie sie war.
 */
export function useAnlageStandort(anlageId: string): {
  anlageStandort: AnlageStandort | null;
  antwort: StandorteAmStichtag | null;
  neuLaden: () => void;
} {
  const [antwort, setAntwort] = useState<StandorteAmStichtag | null>(null);
  const [runde, setRunde] = useState(0);
  useEffect(() => {
    let aktiv = true;
    api
      .standorte()
      .then((a) => {
        if (aktiv) setAntwort(a);
      })
      .catch(() => {
        if (aktiv) setAntwort(null);
      });
    return () => {
      aktiv = false;
    };
  }, [anlageId, runde]);
  const neuLaden = useCallback(() => setRunde((r) => r + 1), []);
  return { anlageStandort: standortDerAnlage(antwort, anlageId), antwort, neuLaden };
}

/**
 * Die Zeile „Standort“ in Anlage › Einstellungen › „Meine Anlage“ (UEMS AP-02
 * IP-8, Mockup T6a): das OBJEKT mit Kurzzeichen, Adresse und „seit“. Fehlt die
 * Adresse (automatisch angelegter Standort, E10), sagt die Zeile es und bietet
 * „Adresse nachtragen“ an — der Standort-Dialog aus IP-6 in der Fassung
 * „vervollständigen“. Für Einzel-Anlagen-Kunden ist das der einzige Weg zu ihrem
 * Standort (die Liste „Standorte“ erreichen sie nicht).
 *
 * ⚠ Nur rendern, wenn es ein Objekt gibt; die Koordinaten-Zeile darunter heißt
 * dann „Standort auf der Karte“ (W4, `koordinatenLabel`).
 */
export function AnlageStandortZeile({
  anlageStandort,
  antwort,
  onGeaendert,
}: {
  anlageStandort: AnlageStandort;
  antwort: StandorteAmStichtag;
  onGeaendert: () => void;
}) {
  const [dialog, setDialog] = useState<{ unternehmen: Unternehmen | null } | null>(null);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const z = standortZeile(anlageStandort);
  const { standort } = anlageStandort;

  async function oeffne() {
    const unternehmen = await api.unternehmen().catch(() => null);
    setDialog({ unternehmen });
  }

  function schliesse() {
    setDialog(null);
    requestAnimationFrame(() => {
      if (ausloeser.current?.isConnected) ausloeser.current.focus();
    });
  }

  return (
    <div className="vp-kv-row">
      <dt className="vp-kv-k">{STANDORT_OBJEKT_LABEL}</dt>
      <dd className="vp-kv-v vp-as">
        <span className="vp-as-name">{z.name}</span>
        {z.zeile && <span className="vp-as-zeile">{z.zeile}</span>}
        {z.fehlt && (
          <span className="vp-as-zeile">
            {z.fehlt}
            {standort.zustand !== 'archiviert' && (
              <>
                {' — '}
                <button
                  ref={ausloeser}
                  type="button"
                  className="vp-as-verweis"
                  aria-label={`${KNOPF_ADRESSE_NACHTRAGEN}: ${standort.name}`}
                  onClick={() => void oeffne()}
                >
                  {KNOPF_ADRESSE_NACHTRAGEN}
                </button>
              </>
            )}
          </span>
        )}
        {dialog && (
          <StandortDialog
            open
            standort={standort}
            unternehmen={dialog.unternehmen}
            standorte={antwort.standorte}
            heute={antwort.stichtag}
            onClose={schliesse}
            onGespeichert={() => {
              schliesse();
              onGeaendert();
            }}
          />
        )}
      </dd>
    </div>
  );
}
