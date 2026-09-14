import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type StandortAmStichtag, type StandorteAmStichtag, type Unternehmen } from '../api';
import { Ortsbaum } from '../components/Ortsbaum';
import { StandortDialog } from '../components/StandortDialog';
import { StandortKopf } from '../components/StandortKopf';
import { archiviertText, standortListe } from '../standorte';
import './StandortePage.css';

/**
 * „Unternehmen › Standorte“ (UEMS AP-02 IP-6, Mockup T1, E6): die Standorte
 * heute mit Kurzzeichen, Adresse, Gebäuden, Anlagen und Fläche; „Standort
 * anlegen“; darunter die archivierten und am Ende die Gruppe „Noch nicht
 * zugeordnet“ — die es nur gibt, solange sie etwas enthält (A15).
 *
 * ⚠ Wo sie wohnt: die Ebenen-Navigation aus AP-01 (IP-5/IP-7) gibt es noch
 * nicht. Bis dahin ist sie ein Reiter der Übersicht (`#/portfolio/standorte`)
 * — der Report nennt genau diesen Weg („erreichbar über die Standort-Übersicht“).
 * Keine eigene Navigationsebene; `#/standorte` bleibt die Alt-Adresse der Technik.
 *
 * Seit IP-7 trägt jede Karte unter dem Kopf den Ortsbaum „Standort › Gebäude“
 * (`Ortsbaum`, T3) mit den Dialogen für Gebäude und Bereich.
 *
 * Nicht hier: „Stand am …“ (IP-13), Archivieren/Wiederherstellen (IP-15),
 * Anlage zuordnen (IP-11), die Datenlage je Standort und die Eingabe der
 * Bezugsfläche (keine Schreibroute für den Standort).
 */
export function StandortePage() {
  const [liste, setListe] = useState<StandorteAmStichtag | null>(null);
  const [unternehmen, setUnternehmen] = useState<Unternehmen | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [dialog, setDialog] = useState<{ standort: StandortAmStichtag | null; schluessel: number } | null>(
    null,
  );
  // iOS/Safari fokussiert einen angeklickten Knopf nicht zwingend — der Auslöser
  // wird ausdrücklich gemerkt (frontend/portal/AGENTS.md, Mobil und Overlays).
  const ausloeser = useRef<HTMLElement | null>(null);

  const laden = useCallback(async () => {
    setLaedt(true);
    setLadeFehler(null);
    try {
      const [l, u] = await Promise.all([api.standorte(), api.unternehmen().catch(() => null)]);
      setListe(l);
      setUnternehmen(u);
    } catch (e) {
      setLadeFehler(e instanceof Error ? e.message : 'Die Standorte konnten nicht geladen werden.');
    } finally {
      setLaedt(false);
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  function oeffne(standort: StandortAmStichtag | null, von: HTMLElement | null) {
    if (von) ausloeser.current = von;
    setDialog((d) => ({ standort, schluessel: (d?.schluessel ?? 0) + 1 }));
  }

  function schliesse() {
    setDialog(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  const sicht = liste ? standortListe(liste) : null;
  // Ohne Unternehmen lehnt der Server das Anlegen ab — ein Knopf, der nichts
  // bewirken kann, wird nicht angeboten (§5.3).
  const kannAnlegen = unternehmen?.zustand === 'angelegt';

  return (
    <section className="vp-st" aria-labelledby="vp-st-titel">
      <div className="vp-st-seitenkopf">
        <div className="vp-st-titel">
          <h1 id="vp-st-titel">Standorte</h1>
          <p>Ihre Orte mit Adresse, Gebäuden und Anlagen.</p>
        </div>
        {kannAnlegen && (
          <Button
            iconLeft={<Icon name="plus" size={18} />}
            onClick={(e) => oeffne(null, e.currentTarget)}
          >
            Standort anlegen
          </Button>
        )}
      </div>

      {laedt && !liste && (
        <div className="vp-st-karte vp-st-hinweis" aria-busy="true">
          Standorte werden geladen …
        </div>
      )}
      {ladeFehler && (
        <div className="vp-st-karte" role="alert">
          <p className="vp-st-hinweis">{ladeFehler}</p>
          <Button variant="outline" size="sm" onClick={() => void laden()}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {sicht && (
        <>
          {sicht.standorte.length === 0 ? (
            <div className="vp-st-karte vp-st-hinweis">Noch kein Standort angelegt.</div>
          ) : (
            <ul className="vp-st-liste" aria-label="Standorte">
              {sicht.standorte.map((s) => (
                <li key={s.id} className="vp-st-karte">
                  <StandortKopf standort={s} onBearbeiten={(st, von) => oeffne(st, von)} />
                  {/* AP-02 IP-7: der Ortsbaum „Standort › Gebäude“ — bis die Standort-Übersicht
                      aus AP-01 steht, unter dem Kopf jeder Karte. */}
                  <Ortsbaum standort={s} onGeaendert={() => void laden()} />
                </li>
              ))}
            </ul>
          )}

          {sicht.archiviert.length > 0 && (
            <section className="vp-st-gruppe" aria-labelledby="vp-st-archiviert">
              <h2 id="vp-st-archiviert" className="vp-st-gruppe-titel">
                Archiviert
              </h2>
              <ul className="vp-st-liste">
                {sicht.archiviert.map((s) => (
                  <li key={s.id} className="vp-st-karte vp-st-karte-still">
                    <p className="vp-st-name">
                      <span className="vp-st-name-text">{s.name}</span>
                      <span className="vp-st-kz">{s.kurzzeichen}</span>
                    </p>
                    <p className="vp-st-zeile">{archiviertText(s)}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sicht.nochNichtZugeordnet && (
            <section className="vp-st-gruppe" aria-labelledby="vp-st-offen" data-testid="noch-nicht-zugeordnet">
              <h2 id="vp-st-offen" className="vp-st-gruppe-titel">
                Noch nicht zugeordnet
              </h2>
              <ul className="vp-st-liste">
                {sicht.nochNichtZugeordnet.map((a) => (
                  <li key={a.id} className="vp-st-karte vp-st-anlage">
                    <a className="vp-st-anlage-link" href={`#/anlage/${encodeURIComponent(a.id)}`}>
                      <Icon name="building" size={18} aria-hidden="true" />
                      <span>{a.name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {dialog && liste && (
        <StandortDialog
          key={dialog.schluessel}
          open
          standort={dialog.standort}
          unternehmen={unternehmen}
          standorte={liste.standorte}
          heute={liste.stichtag}
          onClose={schliesse}
          onOeffnen={(s) => oeffne(s, null)}
          onGespeichert={() => {
            schliesse();
            void laden();
          }}
        />
      )}
    </section>
  );
}
