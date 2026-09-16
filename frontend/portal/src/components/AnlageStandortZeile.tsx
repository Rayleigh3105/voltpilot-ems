import { Recht } from './Recht';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StandorteAmStichtag, type Unternehmen } from '../api';
import {
  KNOPF_ADRESSE_NACHTRAGEN,
  STANDORT_OBJEKT_LABEL,
  standortDerAnlage,
  standortZeile,
  type AnlageStandort,
} from '../anlageStandort';
import { KNOPF_ANDEREM_STANDORT, geplantZeile, tagPlus } from '../anlageUmziehen';
import { AnlageStandortDialog } from './AnlageStandortDialog';
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
 * Wohin die Anlage nach dem Ende ihrer heutigen Zuordnung gehört (`GET /api/v1/standorte?stichtag=`
 * am Tag danach) — gelesen NUR, wenn die heutige ein Ende hat; sonst kein Aufruf.
 */
function useDanach(a: AnlageStandort): AnlageStandort | null {
  const bis = a.zuordnung.gueltigBis;
  const anlageId = a.zuordnung.id;
  const [danach, setDanach] = useState<AnlageStandort | null>(null);
  useEffect(() => {
    if (!bis) {
      setDanach(null);
      return;
    }
    let aktiv = true;
    api
      .standorte(tagPlus(bis, 1))
      .then((antwort) => {
        if (aktiv) setDanach(standortDerAnlage(antwort, anlageId));
      })
      .catch(() => {
        if (aktiv) setDanach(null);
      });
    return () => {
      aktiv = false;
    };
  }, [anlageId, bis]);
  return danach;
}

/**
 * Die Zeile „Standort“ in Anlage › Einstellungen › „Meine Anlage“ (UEMS AP-02
 * IP-8, Mockup T6a): das OBJEKT mit Kurzzeichen, Adresse und „seit“. Fehlt die
 * Adresse (automatisch angelegter Standort, E10), sagt die Zeile es und bietet
 * „Adresse nachtragen“ an — der Standort-Dialog aus IP-6 in der Fassung
 * „vervollständigen“. Für Einzel-Anlagen-Kunden ist das der einzige Weg zu ihrem
 * Standort (die Liste „Standorte“ erreichen sie nicht).
 *
 * Seit IP-11 (T6b) führt „Anderem Standort zuordnen“ in den Dialog mit Folgen-Karte;
 * endet die heutige Zuordnung (ein geplanter Wechsel), sagt die Zeile, wann und wohin.
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
  const [umzug, setUmzug] = useState(false);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const umzugAusloeser = useRef<HTMLButtonElement>(null);
  const z = standortZeile(anlageStandort);
  const { standort, zuordnung } = anlageStandort;
  const geplant = geplantZeile(anlageStandort, useDanach(anlageStandort));

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

  function schliesseUmzug() {
    setUmzug(false);
    requestAnimationFrame(() => {
      if (umzugAusloeser.current?.isConnected) umzugAusloeser.current.focus();
    });
  }

  return (
    <div className="vp-kv-row">
      <dt className="vp-kv-k">{STANDORT_OBJEKT_LABEL}</dt>
      <dd className="vp-kv-v vp-as">
        <span className="vp-as-name">{z.name}</span>
        {z.zeile && <span className="vp-as-zeile">{z.zeile}</span>}
        {geplant && <span className="vp-as-zeile vp-as-geplant">{geplant}</span>}
        {z.fehlt && <span className="vp-as-zeile">{z.fehlt}</span>}
        {z.fehlt && standort.zustand !== 'archiviert' && (
          <Recht aktion="anlage.zuordnen"><button
            ref={ausloeser}
            type="button"
            className="vp-as-verweis"
            aria-label={`${KNOPF_ADRESSE_NACHTRAGEN}: ${standort.name}`}
            onClick={() => void oeffne()}
          >
            {KNOPF_ADRESSE_NACHTRAGEN}
          </button></Recht>
        )}
        <Recht aktion="anlage.zuordnen"><button
          ref={umzugAusloeser}
          type="button"
          className="vp-as-verweis"
          aria-label={`${KNOPF_ANDEREM_STANDORT}: ${zuordnung.name}`}
          onClick={() => setUmzug(true)}
        >
          {KNOPF_ANDEREM_STANDORT}
        </button></Recht>
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
        {umzug && (
          <AnlageStandortDialog
            open
            anlageId={zuordnung.id}
            anlageName={zuordnung.name}
            standorte={antwort}
            onClose={schliesseUmzug}
            onGespeichert={() => {
              schliesseUmzug();
              onGeaendert();
            }}
          />
        )}
      </dd>
    </div>
  );
}
