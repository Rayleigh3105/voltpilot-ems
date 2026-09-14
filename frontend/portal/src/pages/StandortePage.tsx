import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type OrtAktionen, type StandortAmStichtag, type StandorteAmStichtag, type Unternehmen } from '../api';
import { ArchivierenDialog, type ArchivAktion } from '../components/ArchivierenDialog';
import { Ortsbaum } from '../components/Ortsbaum';
import { StandAm } from '../components/StandAm';
import { StandortDialog } from '../components/StandortDialog';
import { StandortKopf } from '../components/StandortKopf';
import { standAmListe } from '../standAm';
import { lokalerTag } from '../uemsOrtsbaum';
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
 * Seit IP-13 steht über der Liste „Stand am …“ (H1, A12): ist ein Stichtag
 * gesetzt, liest die Seite ihn (`?stichtag=`), ihre Karten und Ortsbäume zeigen
 * den Stand dieses Tages, ein Standort, den es da noch nicht gab, steht mit
 * seinem Satz an seinem Platz — und kein Schreibweg ist angeboten. EIN Datumsfeld
 * für die ganze Seite: die Ortsbäume der Karten folgen ihm (Vorschau IP-13).
 *
 * Nicht hier: Archivieren/Wiederherstellen (IP-15), Anlage zuordnen (IP-11),
 * die Datenlage je Standort und die Eingabe der Bezugsfläche (keine
 * Schreibroute für den Standort).
 */
export function StandortePage() {
  const [liste, setListe] = useState<StandorteAmStichtag | null>(null);
  const [unternehmen, setUnternehmen] = useState<Unternehmen | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  /** Heute nach dem Server (die Antwort ohne Stichtag) — die Vorgabe des Datumsfelds. */
  const [heute, setHeute] = useState<string | null>(null);
  /** „Stand am …“: `null` = heute, mit Schreibwegen. */
  const [stichtag, setStichtag] = useState<string | null>(null);
  const anfrage = useRef(0);
  const [dialog, setDialog] = useState<{ standort: StandortAmStichtag | null; schluessel: number } | null>(
    null,
  );
  // iOS/Safari fokussiert einen angeklickten Knopf nicht zwingend — der Auslöser
  // wird ausdrücklich gemerkt (frontend/portal/AGENTS.md, Mobil und Overlays).
  const ausloeser = useRef<HTMLElement | null>(null);
  // AP-02 IP-15: je Standort, was man heute mit ihm tun kann — sein Ortsbaum liest es mit.
  const [aktionen, setAktionen] = useState<Record<string, OrtAktionen | null>>({});
  const [archiv, setArchiv] = useState<{ art: ArchivAktion; standort: StandortAmStichtag; schluessel: number } | null>(
    null,
  );
  const merkeAktionen = useCallback(
    (id: string, a: OrtAktionen | null) => setAktionen((m) => (m[id] === a ? m : { ...m, [id]: a })),
    [],
  );

  const laden = useCallback(async () => {
    const nummer = ++anfrage.current;
    setLaedt(true);
    setLadeFehler(null);
    try {
      const [l, u] = await Promise.all([
        stichtag ? api.standorte(stichtag) : api.standorte(),
        api.unternehmen().catch(() => null),
      ]);
      // Eine überholte Antwort (der Tag wurde inzwischen gewechselt) zeigt nichts mehr.
      if (nummer !== anfrage.current) return;
      setListe(l);
      setUnternehmen(u);
      if (!stichtag) setHeute(l.stichtag);
    } catch (e) {
      if (nummer === anfrage.current)
        setLadeFehler(e instanceof Error ? e.message : 'Die Standorte konnten nicht geladen werden.');
    } finally {
      if (nummer === anfrage.current) setLaedt(false);
    }
  }, [stichtag]);

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

  function oeffneArchiv(art: ArchivAktion, standort: StandortAmStichtag, von: HTMLElement) {
    ausloeser.current = von;
    setArchiv((d) => ({ art, standort, schluessel: (d?.schluessel ?? 0) + 1 }));
  }

  function schliesseArchiv() {
    setArchiv(null);
    const ziel = ausloeser.current;
    requestAnimationFrame(() => {
      if (ziel?.isConnected) ziel.focus();
    });
  }

  // Die Liste gilt für den Tag, nach dem gefragt wurde — bis die Antwort da ist, steht keine vom vorigen Tag.
  const aktuell = liste && liste.stichtag === (stichtag ?? heute) ? liste : null;
  const sicht = aktuell ? standAmListe(aktuell, stichtag) : null;
  // Ohne Unternehmen lehnt der Server das Anlegen ab — ein Knopf, der nichts
  // bewirken kann, wird nicht angeboten (§5.3). „Stand am …“ ändert nichts (H1).
  const kannAnlegen = unternehmen?.zustand === 'angelegt' && !stichtag;

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

      {heute && <StandAm heute={heute} stichtag={stichtag} onStichtag={setStichtag} />}

      {laedt && !aktuell && (
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
          {sicht.eintraege.length === 0 ? (
            <div className="vp-st-karte vp-st-hinweis">Noch kein Standort angelegt.</div>
          ) : (
            <ul className="vp-st-liste" aria-label="Standorte">
              {sicht.eintraege.map((e) =>
                e.art === 'standort' ? (
                  <li key={e.standort.id} className="vp-st-karte">
                    <StandortKopf
                      standort={e.standort}
                      onBearbeiten={stichtag ? undefined : (st, von) => oeffne(st, von)}
                      aktionen={stichtag ? null : (aktionen[e.standort.id] ?? null)}
                      onAktion={(eintrag, von) => {
                        if (eintrag.art === 'archivieren') oeffneArchiv('archivieren', e.standort, von);
                        if (eintrag.art === 'archivieren_gesperrt') oeffneArchiv('gesperrt', e.standort, von);
                      }}
                    />
                    {/* AP-02 IP-7: der Ortsbaum „Standort › Gebäude“ — bis die Standort-Übersicht
                        aus AP-01 steht, unter dem Kopf jeder Karte; er folgt dem Stichtag der Seite. */}
                    <Ortsbaum
                      standort={e.standort}
                      stichtag={stichtag}
                      onGeaendert={() => void laden()}
                      onAktionen={(a) => merkeAktionen(e.standort.id, a)}
                    />
                  </li>
                ) : (
                  // „Stand am …“: gab es an dem Tag noch nicht — benannt an seinem Platz, nie weggelassen (A12).
                  <li key={e.standort.id} className="vp-st-karte vp-st-karte-still" data-testid="gab-es-noch-nicht">
                    <p className="vp-st-name">
                      <span className="vp-st-name-text">{e.standort.name}</span>
                      <span className="vp-st-kz">{e.standort.kurzzeichen}</span>
                    </p>
                    <p className="vp-st-zeile">{e.satz}</p>
                  </li>
                ),
              )}
            </ul>
          )}

          {sicht.archiviert.length > 0 && (
            <section className="vp-st-gruppe" aria-labelledby="vp-st-archiviert">
              <h2 id="vp-st-archiviert" className="vp-st-gruppe-titel">
                Archiviert
              </h2>
              <ul className="vp-st-liste">
                {sicht.archiviert.map(({ standort: s, satz }) => (
                  <li key={s.id} className="vp-st-karte vp-st-karte-still">
                    <p className="vp-st-name">
                      <span className="vp-st-name-text">{s.name}</span>
                      <span className="vp-st-kz">{s.kurzzeichen}</span>
                    </p>
                    <p className="vp-st-zeile">{satz}</p>
                    {/* IP-15 (Z3): ein archivierter Standort kommt zurück — ein neues Bestehen ab heute. */}
                    {!stichtag && (
                      <div className="vp-st-archiv-knoepfe">
                        <Button
                          variant="outline"
                          size="sm"
                          iconLeft={<Icon name="refresh-cw" size={16} />}
                          aria-label={`${s.name} wiederherstellen`}
                          onClick={(ev) => oeffneArchiv('wiederherstellen', s, ev.currentTarget)}
                        >
                          Wiederherstellen …
                        </Button>
                      </div>
                    )}
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

      {archiv && !stichtag && (
        <ArchivierenDialog
          key={archiv.schluessel}
          open
          aktion={archiv.art}
          heute={heute}
          objekt={{
            art: 'standort',
            id: archiv.standort.id,
            name: archiv.standort.name,
            kurzzeichen: archiv.standort.kurzzeichen,
            eltern: null,
            archiviertAm: archiv.standort.archiviertAm
              ? lokalerTag(archiv.standort.archiviertAm, archiv.standort.zeitzone)
              : null,
            aktionen: aktionen[archiv.standort.id] ?? null,
          }}
          onClose={schliesseArchiv}
          onFertig={() => {
            schliesseArchiv();
            void laden();
          }}
        />
      )}

      {dialog && liste && heute && !stichtag && (
        <StandortDialog
          key={dialog.schluessel}
          open
          standort={dialog.standort}
          unternehmen={unternehmen}
          standorte={liste.standorte}
          heute={heute}
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
