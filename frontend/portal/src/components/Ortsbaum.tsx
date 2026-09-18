import { RechteStandort } from '../rollen';
import { Recht } from './Recht';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type OrtAktionen, type OrtsbaumAmStichtag, type StandortAmStichtag } from '../api';
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
import { archiviertAmText, menueEintraege, mitAenderungen, type MenueEintrag } from '../ortArchiv';
import { danachAbzeichen } from '../ortVerschieben';
import { ArchivierenDialog, type ArchivAktion } from './ArchivierenDialog';
import { OrtAenderungen } from './OrtAenderungen';
import { OrtDialog } from './OrtDialog';
import { OrtMenue } from './OrtMenue';
import { VerschiebenDialog } from './VerschiebenDialog';
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
 * Nutzung, Fläche, Baujahr und Datenlage („n von m Messstellen liefern Daten“);
 * „Gebäude anlegen“ und „Bereich anlegen“; ohne Gebäude und Bereiche der
 * Leerzustand L1. Gebäude und Bereiche öffnen ihren Dialog (T4/T5).
 *
 * Alles, was entschieden wird, steht in `ortsbaum.ts`. Der Baum liest seinen
 * Standort selbst (`GET /api/v1/standorte/{id}/orte`), damit die
 * Standort-Übersicht aus AP-01 ihn später unverändert tragen kann; bis dahin
 * steht er in jeder Karte der Liste „Standorte“ unter dem Standort-Kopf.
 *
 * „Stand am …“ (IP-13): mit `stichtag` liest der Baum den Stand dieses Tages
 * (`?stichtag=`) und bietet keinen Schreibweg an — kein Anlegen, kein Stift,
 * kein „Fläche eintragen“. Datumsfeld und Banner trägt der Wirt (`StandAm`).
 *
 * Nicht hier: Verschieben (IP-12), Archivieren (IP-15) und die Fläche ÄNDERN mit
 * Verlauf (IP-8, T7).
 *
 * UEMS AP-13 IP-2 (E4 = A): „Standort › Gebäude“ trägt den Baum als eigene Seite
 * (`StandortGebaeudePage`) und nennt seine Überschrift schon selbst
 * (`titelVersteckt`). `gebaeudeKarte` ist die Hülle der Karte je Gebäude: gibt
 * sie für ein Gebäude Inhalt zurück, klappt die Zeile ihn auf — IP-10 reicht die
 * Blöcke Energie · Messstellen · Kennzahlen herein. Ohne Inhalt kein Aufklapper.
 */
export function Ortsbaum({
  standort,
  stichtag = null,
  onGeaendert,
  onAktionen,
  titelVersteckt = false,
  gebaeudeKarte,
  onAntwort,
}: {
  standort: StandortAmStichtag;
  /** „Stand am …“ (IP-13): `null` = heute, mit Schreibwegen. */
  stichtag?: string | null;
  /** Nach jedem Speichern — die Zahlen im Standort-Kopf („3 Gebäude“) ändern sich mit. */
  onGeaendert?: () => void;
  /** IP-15: was man heute mit dem Standort selbst tun kann — sein Menü sitzt im Standort-Kopf. */
  onAktionen?: (aktionen: OrtAktionen | null) => void;
  /** AP-13 IP-2: die Seite trägt „Gebäude“ schon als Überschrift — hier bleibt sie nur für Screenreader. */
  titelVersteckt?: boolean;
  /** AP-13 IP-2: der Inhalt der Karte eines Gebäudes; `null`/`undefined` = keine Karte, kein Aufklapper. */
  gebaeudeKarte?: (gebaeude: Knoten) => ReactNode;
  /**
   * AP-13 IP-10: die gelesene Antwort des Tages — der Wirt braucht die Gebäude (Kurzzeichen), um EINMAL für die
   * Seite zu laden, statt je Karte. Wie `onAktionen`: nach dem Laden, nie während des Renderns.
   */
  onAntwort?: (antwort: OrtsbaumAmStichtag | null) => void;
}) {
  const titelId = `vp-ob-${useId().replace(/:/g, '')}`;
  const [offen, setOffen] = useState<ReadonlySet<string>>(new Set());
  // Die Antwort merkt sich, für welchen Tag sie gilt: nach einem Wechsel des Stichtags steht
  // nie der Baum des vorigen Tages unter dem Banner des neuen (veraltet ist nicht aktuell).
  const [geladen, setGeladen] = useState<{ fuer: string | null; daten: OrtsbaumAmStichtag } | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [dialog, setDialog] = useState<DialogZustand | null>(null);
  const [aktion, setAktion] = useState<{ art: ArchivAktion; knoten: Knoten; schluessel: number } | null>(null);
  const [verschieben, setVerschieben] = useState<{ knoten: Knoten; schluessel: number } | null>(null);
  // IP-14 (H2): das Änderungsprotokoll eines Gebäudes oder Bereichs.
  const [protokoll, setProtokoll] = useState<Knoten | null>(null);
  // iOS/Safari fokussiert einen angeklickten Knopf nicht zwingend — der Auslöser
  // wird ausdrücklich gemerkt (frontend/portal/AGENTS.md, Mobil und Overlays).
  const ausloeser = useRef<HTMLElement | null>(null);
  const anfrage = useRef(0);

  const laden = useCallback(async () => {
    const nummer = ++anfrage.current;
    setLaedt(true);
    setLadeFehler(null);
    try {
      const daten = await (stichtag ? api.standortOrte(standort.id, stichtag) : api.standortOrte(standort.id));
      if (nummer === anfrage.current) setGeladen({ fuer: stichtag, daten });
    } catch (e) {
      if (nummer === anfrage.current)
        setLadeFehler(e instanceof Error ? e.message : 'Die Gebäude konnten nicht geladen werden.');
    } finally {
      if (nummer === anfrage.current) setLaedt(false);
    }
  }, [standort.id, stichtag]);
  const antwort = geladen && geladen.fuer === stichtag ? geladen.daten : null;

  useEffect(() => {
    if (antwort) onAktionen?.(antwort.aktionen ?? null);
  }, [antwort, onAktionen]);

  useEffect(() => {
    onAntwort?.(antwort);
  }, [antwort, onAntwort]);

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

  function waehle(eintrag: MenueEintrag, knoten: Knoten, von: HTMLElement) {
    // IP-14 (H2): „Änderungsprotokoll“ liest nur — ein Dialog, kein Schreibweg.
    if (eintrag.art === 'aenderungen') {
      ausloeser.current = von;
      setProtokoll(knoten);
      return;
    }
    // IP-12 (V1 → V2): „Verschieben …“ öffnet den eigenen Dialog.
    if (eintrag.art === 'verschieben') {
      ausloeser.current = von;
      setVerschieben((v) => ({ knoten, schluessel: (v?.schluessel ?? 0) + 1 }));
      return;
    }
    const art: ArchivAktion | null =
      eintrag.art === 'archivieren_gesperrt' ? 'gesperrt' : eintrag.knopf ? eintrag.art : null;
    if (!art) return;
    ausloeser.current = von;
    setAktion((a) => ({ art, knoten, schluessel: (a?.schluessel ?? 0) + 1 }));
  }

  function schliesseVerschieben() {
    setVerschieben(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  function schliesseProtokoll() {
    setProtokoll(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  function schliesseAktion() {
    setAktion(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  const sicht = antwort ? ortsbaumSicht(antwort) : null;
  // Ein archivierter Standort nimmt nichts Neues an — ein Knopf, der nichts bewirken kann, wird nicht angeboten (§5.3).
  // „Stand am …“ zeigt die Vergangenheit, man ändert sie dort nicht (IP-13, H1).
  const kannSchreiben = standort.zustand !== 'archiviert' && !stichtag;
  const alleKnoten = sicht ? sicht.knoten.flatMap((k) => [k, ...k.kinder]) : [];
  const mitMenue = kannSchreiben && alleKnoten.some((k) => k.aktionen);

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
          {/* IP-12 (V4): bis zum Stichtag steht der Knoten noch hier — und sagt, wohin er dann zieht. */}
          {k.danach && !k.archiviert && (
            <p className="vp-ob-danach" data-testid="danach">
              {danachAbzeichen(k.danach)}
            </p>
          )}
          {k.archiviertAm && (
            <p className="vp-ob-archiviert-am" data-testid="archiviert-am">
              {archiviertAmText(k.archiviertAm)}
            </p>
          )}
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
                  <Recht aktion="gebaeude.pflegen"><button
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
                  </button></Recht>
                </>
              )}
            </p>
          )}
        </div>
        {bearbeiten && (
          <Recht aktion="gebaeude.pflegen"><button
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
          </button></Recht>
        )}
        {/* „Direkt am Standort“ hat keinen Stift — der Platz bleibt, damit die Spalte der Datenlage bündig steht. */}
        {/* Ein archivierter Knoten hat weder Stift noch Datenlage-Spalte — sein Platz ginge dem Archivtag verloren. */}
        {kannSchreiben && !bearbeiten && !k.archiviertAm && (
          <span className="vp-ob-bearbeiten-platz" aria-hidden="true" />
        )}
        {/* IP-15: das Menü je Knoten; wo keins ist („Direkt am Standort“), hält der Platz die Spalte bündig. */}
        {mitMenue &&
          (k.aktionen ? (
            <OrtMenue recht="gebaeude.pflegen" name={k.name} eintraege={mitAenderungen(menueEintraege(k.aktionen))} onWahl={(e, von) => waehle(e, k, von)} />
          ) : (
            <span className="vp-ob-bearbeiten-platz" aria-hidden="true" />
          ))}
      </div>
    );
  }

  return (
    <RechteStandort.Provider value={standort.id}>
    <section className="vp-ob" aria-labelledby={titelId} data-testid="ortsbaum">
      <div className="vp-ob-kopf">
        <h3 id={titelId} className={titelVersteckt ? 'vp-ob-titel vp-sr-only' : 'vp-ob-titel'}>
          {TITEL_GEBAEUDE}
        </h3>
        {sicht && !sicht.leer && kannSchreiben && (
          <div className="vp-ob-knoepfe">
            <Recht aktion="gebaeude.pflegen"><Button
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
            </Button></Recht>
            <Recht aktion="gebaeude.pflegen"><Button
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
            </Button></Recht>
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
              <Recht aktion="gebaeude.pflegen"><Button
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
              </Button></Recht>
              <Recht aktion="gebaeude.pflegen"><Button
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
              </Button></Recht>
            </div>
          )}
        </div>
      )}

      {sicht && sicht.knoten.length > 0 && (
        <ul className="vp-ob-baum" aria-labelledby={titelId}>
          {sicht.knoten.map((k) => {
            const karte = k.art === 'gebaeude' && gebaeudeKarte ? gebaeudeKarte(k) : null;
            const hatKarte = karte !== null && karte !== undefined && karte !== false;
            const aufgeklappt = hatKarte && offen.has(k.schluessel);
            const karteId = `${titelId}-karte-${k.schluessel}`;
            return (
              <li key={k.schluessel} className="vp-ob-knoten" data-art={k.art}>
                {zeile(k)}
                {hatKarte && (
                  <button
                    type="button"
                    className="vp-ob-aufklapper"
                    aria-expanded={aufgeklappt}
                    aria-controls={karteId}
                    aria-label={`${k.name}: Karte ${aufgeklappt ? 'zuklappen' : 'aufklappen'}`}
                    onClick={() =>
                      setOffen((alt) => {
                        const neu = new Set(alt);
                        if (neu.has(k.schluessel)) neu.delete(k.schluessel);
                        else neu.add(k.schluessel);
                        return neu;
                      })
                    }
                  >
                    <Icon name={aufgeklappt ? 'chevron-down' : 'chevron-right'} size={18} />
                  </button>
                )}
                {aufgeklappt && (
                  <div id={karteId} className="vp-ob-karte" data-testid="gebaeude-karte">
                    {karte}
                  </div>
                )}
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
            );
          })}
        </ul>
      )}

      {protokoll?.id && (
        <OrtAenderungen
          open
          objekt={{ art: protokoll.art === 'gebaeude' ? 'gebaeude' : 'bereich', id: protokoll.id, name: protokoll.name }}
          onClose={schliesseProtokoll}
        />
      )}

      {aktion && aktion.knoten.id && (
        <ArchivierenDialog
          key={aktion.schluessel}
          open
          aktion={aktion.art}
          objekt={{
            art: aktion.knoten.art === 'gebaeude' ? 'gebaeude' : 'bereich',
            id: aktion.knoten.id,
            name: aktion.knoten.name,
            kurzzeichen: aktion.knoten.kurzzeichen ?? '',
            eltern: aktion.knoten.eltern?.name ?? null,
            archiviertAm: aktion.knoten.archiviertAm,
            aktionen: aktion.knoten.aktionen,
          }}
          onClose={schliesseAktion}
          onFertig={() => {
            schliesseAktion();
            void laden();
            onGeaendert?.();
          }}
        />
      )}

      {verschieben && verschieben.knoten.id && verschieben.knoten.aktionen?.verschieben && antwort && (
        <VerschiebenDialog
          key={verschieben.schluessel}
          open
          ort={{
            id: verschieben.knoten.id,
            art: verschieben.knoten.art === 'gebaeude' ? 'gebaeude' : 'bereich',
            name: verschieben.knoten.name,
            kurzzeichen: verschieben.knoten.kurzzeichen ?? '',
            eltern: verschieben.knoten.eltern?.name ?? standort.name,
          }}
          ziele={verschieben.knoten.aktionen.verschieben.ziele}
          heute={antwort.stichtag}
          onClose={schliesseVerschieben}
          onFertig={() => {
            schliesseVerschieben();
            void laden();
            onGeaendert?.();
          }}
        />
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
    </RechteStandort.Provider>
  );
}
