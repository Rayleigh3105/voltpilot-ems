import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type OrtsbaumAmStichtag, type StandortAmStichtag } from '../api';
import {
  FLAECHE_FEHLT,
  KNOPF_BEREICH_ANLEGEN,
  KNOPF_BEREICH_DIREKT,
  KNOPF_FLAECHE_EINTRAGEN,
  KNOPF_GEBAEUDE_ANLEGEN,
  LEER_SATZ,
  ortsbaumSicht,
  TITEL_GEBAEUDE,
  type Knoten,
  type OrtDialogArt,
  type OrtFeld,
} from '../ortsbaum';
import { OrtDialog } from './OrtDialog';
import './StandortKopf.css';
import './Ortsbaum.css';

interface DialogZustand {
  art: OrtDialogArt;
  knoten: Knoten | null;
  vorwahl: string | null;
  startFeld: OrtFeld | null;
  schluessel: number;
}

const ICON: Record<Knoten['art'], 'building' | 'layers' | 'map-pin'> = {
  gebaeude: 'building',
  bereich: 'layers',
  direkt: 'map-pin',
};

/**
 * Der Ortsbaum „Standort › Gebäude“ (UEMS AP-02 IP-7, Mockup T3): die Gebäude
 * mit ihren Bereichen und der Zweig „Direkt am Standort“, jede Zeile mit
 * Nutzung, Fläche, Baujahr und der Messstellen-Zahl an der Stelle der Datenlage;
 * „Gebäude anlegen“ und „Bereich anlegen“; ohne Gebäude und Bereiche der
 * Leerzustand L1. Gebäude und Bereiche öffnen ihren Dialog (T4/T5).
 *
 * Alles, was entschieden wird, steht in `ortsbaum.ts`. Der Baum liest seinen
 * Standort selbst (`GET /api/v1/standorte/{id}/orte`), damit die
 * Standort-Übersicht aus AP-01 ihn später unverändert tragen kann; bis dahin
 * steht er in jeder Karte der Liste „Standorte“ unter dem Standort-Kopf.
 *
 * Nicht hier: Verschieben (IP-12), „Stand am …“ (IP-13), Archivieren (IP-15),
 * die Fläche ÄNDERN mit Verlauf (IP-8, T7) und die Datenlage je Knoten.
 */
export function Ortsbaum({
  standort,
  onGeaendert,
}: {
  standort: StandortAmStichtag;
  /** Nach jedem Speichern — die Zahlen im Standort-Kopf („3 Gebäude“) ändern sich mit. */
  onGeaendert?: () => void;
}) {
  const titelId = `vp-ob-${useId().replace(/:/g, '')}`;
  const [antwort, setAntwort] = useState<OrtsbaumAmStichtag | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [dialog, setDialog] = useState<DialogZustand | null>(null);
  // iOS/Safari fokussiert einen angeklickten Knopf nicht zwingend — der Auslöser
  // wird ausdrücklich gemerkt (frontend/portal/AGENTS.md, Mobil und Overlays).
  const ausloeser = useRef<HTMLElement | null>(null);

  const laden = useCallback(async () => {
    setLaedt(true);
    setLadeFehler(null);
    try {
      setAntwort(await api.standortOrte(standort.id));
    } catch (e) {
      setLadeFehler(e instanceof Error ? e.message : 'Die Gebäude konnten nicht geladen werden.');
    } finally {
      setLaedt(false);
    }
  }, [standort.id]);

  useEffect(() => {
    void laden();
  }, [laden]);

  function oeffne(neu: Omit<DialogZustand, 'schluessel'>, von: HTMLElement | null) {
    if (von) ausloeser.current = von;
    setDialog((d) => ({ ...neu, schluessel: (d?.schluessel ?? 0) + 1 }));
  }

  function schliesse() {
    setDialog(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  const sicht = antwort ? ortsbaumSicht(antwort) : null;
  // Ein archivierter Standort nimmt nichts Neues an — ein Knopf, der nichts bewirken kann, wird nicht angeboten (§5.3).
  const kannSchreiben = standort.zustand !== 'archiviert';
  const alleKnoten = sicht ? sicht.knoten.flatMap((k) => [k, ...k.kinder]) : [];

  function zeile(k: Knoten) {
    const bearbeiten = kannSchreiben && k.id !== null && !k.archiviert;
    return (
      <div className={k.archiviert ? 'vp-ob-zeile vp-ob-zeile-still' : 'vp-ob-zeile'}>
        <span className="vp-ob-icon" aria-hidden="true">
          <Icon name={ICON[k.art]} size={18} />
        </span>
        <div className="vp-ob-text">
          <p className="vp-ob-name">
            <span className="vp-st-name-text">{k.name}</span>
            {k.kurzzeichen && <span className="vp-st-kz">{k.kurzzeichen}</span>}
          </p>
          {k.zeile && <p className="vp-ob-beschreibung">{k.zeile}</p>}
          {k.datenlage && (
            <p className="vp-ob-datenlage" data-testid="datenlage">
              {k.datenlage}
            </p>
          )}
          {k.flaecheFehlt && (
            <p className="vp-ob-flaeche-fehlt">
              {FLAECHE_FEHLT}
              {bearbeiten && (
                <>
                  {' — '}
                  <button
                    type="button"
                    className="vp-ob-verweis"
                    aria-label={`${KNOPF_FLAECHE_EINTRAGEN}: ${k.name}`}
                    onClick={(e) =>
                      oeffne(
                        {
                          art: 'gebaeude',
                          knoten: k,
                          vorwahl: null,
                          startFeld: 'flaeche',
                        },
                        e.currentTarget,
                      )
                    }
                  >
                    {KNOPF_FLAECHE_EINTRAGEN}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        {bearbeiten && (
          <button
            type="button"
            className="vp-ob-bearbeiten"
            aria-label={`${k.name} bearbeiten`}
            onClick={(e) =>
              oeffne(
                {
                  art: k.art === 'gebaeude' ? 'gebaeude' : 'bereich',
                  knoten: k,
                  vorwahl: null,
                  startFeld: null,
                },
                e.currentTarget,
              )
            }
          >
            <Icon name="pencil" size={16} />
          </button>
        )}
        {/* „Direkt am Standort“ hat keinen Stift — der Platz bleibt, damit die Spalte der Datenlage bündig steht. */}
        {kannSchreiben && !bearbeiten && <span className="vp-ob-bearbeiten-platz" aria-hidden="true" />}
      </div>
    );
  }

  return (
    <section className="vp-ob" aria-labelledby={titelId} data-testid="ortsbaum">
      <div className="vp-ob-kopf">
        <h3 id={titelId} className="vp-ob-titel">
          {TITEL_GEBAEUDE}
        </h3>
        {sicht && !sicht.leer && kannSchreiben && (
          <div className="vp-ob-knoepfe">
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Icon name="plus" size={16} />}
              onClick={(e) =>
                oeffne(
                  {
                    art: 'gebaeude',
                    knoten: null,
                    vorwahl: null,
                    startFeld: null,
                  },
                  e.currentTarget,
                )
              }
            >
              {KNOPF_GEBAEUDE_ANLEGEN}
            </Button>
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Icon name="plus" size={16} />}
              onClick={(e) =>
                oeffne(
                  {
                    art: 'bereich',
                    knoten: null,
                    vorwahl: null,
                    startFeld: null,
                  },
                  e.currentTarget,
                )
              }
            >
              {KNOPF_BEREICH_ANLEGEN}
            </Button>
          </div>
        )}
      </div>

      {laedt && !antwort && (
        <p className="vp-ob-hinweis" aria-busy="true">
          Gebäude werden geladen …
        </p>
      )}
      {ladeFehler && (
        <div role="alert">
          <p className="vp-ob-hinweis">{ladeFehler}</p>
          <Button variant="outline" size="sm" onClick={() => void laden()}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {sicht && antwort && sicht.leer && (
        <div className="vp-ob-leer" data-testid="ortsbaum-leer">
          <p className="vp-ob-leer-satz">{LEER_SATZ}</p>
          {kannSchreiben && (
            <div className="vp-ob-knoepfe">
              <Button
                size="sm"
                iconLeft={<Icon name="plus" size={16} />}
                onClick={(e) =>
                  oeffne(
                    {
                      art: 'gebaeude',
                      knoten: null,
                      vorwahl: null,
                      startFeld: null,
                    },
                    e.currentTarget,
                  )
                }
              >
                {KNOPF_GEBAEUDE_ANLEGEN}
              </Button>
              <Button
                variant="outline"
                size="sm"
                iconLeft={<Icon name="plus" size={16} />}
                onClick={(e) =>
                  oeffne(
                    {
                      art: 'bereich',
                      knoten: null,
                      vorwahl: antwort.standort.id,
                      startFeld: null,
                    },
                    e.currentTarget,
                  )
                }
              >
                {KNOPF_BEREICH_DIREKT}
              </Button>
            </div>
          )}
        </div>
      )}

      {sicht && sicht.knoten.length > 0 && (
        <ul className="vp-ob-baum" aria-labelledby={titelId}>
          {sicht.knoten.map((k) => (
            <li key={k.schluessel} className="vp-ob-knoten" data-art={k.art}>
              {zeile(k)}
              {k.kinder.length > 0 && (
                <ul className="vp-ob-kinder">
                  {k.kinder.map((b) => (
                    <li key={b.schluessel} className="vp-ob-knoten" data-art={b.art}>
                      {zeile(b)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog && antwort && (
        <OrtDialog
          key={dialog.schluessel}
          open
          art={dialog.art}
          antwort={antwort}
          knoten={dialog.knoten}
          vorwahl={dialog.vorwahl}
          startFeld={dialog.startFeld}
          onClose={schliesse}
          onOeffnen={(id) => {
            const k = alleKnoten.find((x) => x.id === id);
            if (k)
              oeffne(
                {
                  art: k.art === 'gebaeude' ? 'gebaeude' : 'bereich',
                  knoten: k,
                  vorwahl: null,
                  startFeld: null,
                },
                null,
              );
          }}
          onGespeichert={() => {
            schliesse();
            void laden();
            onGeaendert?.();
          }}
        />
      )}
    </section>
  );
}
