import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bezugsflaechen } from '../api';
import { useRollen } from '../rollen';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import { BezugsgroesseAnlegenDialog } from '../components/BezugsgroesseAnlegenDialog';
import { BezugsdatenImportDialog } from '../components/BezugsdatenImportDialog';
import { BezugsdatenImportProtokollDialog } from '../components/BezugsdatenImportProtokollDialog';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { useIsPhone } from '../useIsPhone';
import { normalisiereSuche } from '../picker/suche';
import { suchTerme } from '../messstellenListe';
import { ERNEUT, ohneUmbruchVorZahl } from '../kostenstellenUebersicht';
import { BezugsgroesseSeite } from './BezugsgroesseSeite';
import { bezugsLaden, type BezugsStand } from '../bezugsStand';
import * as B from '../bezugsgroesseListe';
import * as U from '../bezugsgroessenUebersicht';
import './MessstellenPage.css';
import './BezugsgroessenPage.css';

/**
 * „Unternehmen › Bezugsgrößen“ (UEMS AP-09 IP-9; Neubau nach dem Messen-Konzept m1 §6.8, Captain-Freigabe 05.10.2026):
 * die Werte, mit denen der Verbrauch verglichen wird - zuletzt eingetragen und was fehlt.
 *
 * Kopf mit Satz und Menü ⋯ (Werte importieren, Import-Protokoll, Bezugsgröße anlegen, Archivierte zeigen; am Rechner
 * „Werte importieren“ als Rahmen-Knopf), die Statuszeile, je Periode eine Karte mit Reihen (Name, Zustand, Woher, letzter
 * Wert) und die Flächen aus dem Gebäudeplan als Kacheln. Jede Reihe öffnet die Seite der Bezugsgröße
 * (`#/portfolio/bezugsgroessen/{id}`, Entscheid 9) - dort wird eingetragen, berichtigt und archiviert.
 */
export function BezugsgroessenPage({ bezugsgroesseId = null }: { bezugsgroesseId?: string | null } = {}) {
  if (bezugsgroesseId) return <BezugsgroesseSeite key={bezugsgroesseId} id={bezugsgroesseId} />;
  return <BezugsgroessenListe />;
}

function BezugsgroessenListe() {
  const isPhone = useIsPhone();
  const [stand, setStand] = useState<BezugsStand | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [werte, setWerte] = useState<ReadonlyMap<string, U.WerteStand>>(() => new Map());
  const [stamm, setStamm] = useState<ReadonlyMap<string, U.StammStand>>(() => new Map());
  const [flaechen, setFlaechen] = useState<Bezugsflaechen | null>(null);
  const [archivierte, setArchivierte] = useState(false);
  const [suche, setSuche] = useState('');
  const [anlegen, setAnlegen] = useState(false);
  const [importOffen, setImportOffen] = useState(false);
  const [protokoll, setProtokoll] = useState<string | null | undefined>(undefined);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const kopf = useRef<HTMLHeadingElement>(null);
  const { darf } = useRollen();

  useEffect(() => {
    let aktiv = true;
    setLadefehler(false);
    bezugsLaden().then(
      (x) => {
        if (!aktiv) return;
        setStand(x);
        // Je Bezugsgröße ihre Werte (bzw. das Stammdatum) - die Reihen füllen sich, sobald eine Antwort da ist.
        for (const b of x.liste.bezugsgroessen) {
          if (b.wertart === 'stammdatum') {
            api.bezugsgroesseStammdatum(b.id).then(
              (s) => aktiv && setStamm((m) => new Map(m).set(b.id, s)),
              () => aktiv && setStamm((m) => new Map(m).set(b.id, 'fehler')),
            );
          } else {
            api.bezugsgroesseWerte(b.id).then(
              (w) => aktiv && setWerte((m) => new Map(m).set(b.id, w)),
              () => aktiv && setWerte((m) => new Map(m).set(b.id, 'fehler')),
            );
          }
        }
        api.bezugsflaechen('tag', x.heute, x.heute).then(
          (f) => aktiv && setFlaechen(f),
          () => aktiv && setFlaechen(null),
        );
      },
      () => aktiv && setLadefehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [neu]);

  const verwalten = (standort: string | null) => darf('bezugsgroesse.verwalten', standort);
  const darfImportieren = stand ? darf('bezugsgroesse.importieren', null) || stand.daten.standorte.some((s) => darf('bezugsgroesse.importieren', s.id)) : false;
  const darfAnlegen = stand ? stand.orte.some((o) => o.waehlbar && verwalten(o.standort)) : false;
  const schliessen = () => {
    setAnlegen(false);
    requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : kopf.current)?.focus());
  };

  const alle = stand ? stand.liste.bezugsgroessen.map((b) => U.bzReihe(b, werte.get(b.id) ?? null, stamm.get(b.id) ?? null, stand.heute)) : [];
  const terme = suchTerme(suche);
  const passt = (r: U.BzReihe) => {
    if (terme.length === 0) return true;
    const text = normalisiereSuche([r.name, r.kennzeichen, r.unter].join(' '));
    return terme.every((t) => text.includes(t));
  };
  const aktiv = alle.filter((r) => !r.archiviert && passt(r));
  const archiv = alle.filter((r) => r.archiviert && passt(r));
  const gruppen = U.bzGruppen(aktiv);
  const eigene = U.bzEigeneFlaechen(aktiv);
  const weitere = U.bzWeitere(aktiv);
  const status = U.bzStatus(alle);
  // Kam eine Werte-Abfrage nicht an, sagt die Lage es - statt „eingetragen“ - und bietet den Weg zurück.
  const nichtAbrufbar = alle.some((r) => !r.archiviert && r.abruf === 'fehler');
  const kacheln = stand ? U.flaechenKacheln(flaechen, stand.orte) : [];
  const standorteDerFlaechen = [...new Set(kacheln.map((k) => k.standort).filter((s): s is string => s !== null))];
  const beispiel = aktiv.find((r) => r.wert && r.wann);

  const menue: RowMenuItem[] = [];
  if (darfImportieren && isPhone) menue.push({ label: U.WERTE_IMPORTIEREN, hinweis: U.WERTE_IMPORTIEREN_HINWEIS, icon: 'upload', onClick: () => { setImportOffen(true); setErfolg(null); } });
  if (darfImportieren) menue.push({ label: U.IMPORT_PROTOKOLL, icon: 'history', onClick: () => { setProtokoll(null); setErfolg(null); } });
  if (darfAnlegen) menue.push({ label: B.ANLEGEN, icon: 'plus', onClick: () => { setAnlegen(true); setErfolg(null); } });
  if (alle.some((r) => r.archiviert)) {
    const n = alle.filter((r) => r.archiviert).length;
    menue.push({
      label: archivierte ? U.ARCHIVIERTE_AUSBLENDEN : U.ARCHIVIERTE_ZEIGEN,
      hinweis: archivierte ? undefined : `${n} archivierte`,
      icon: 'archive',
      onClick: () => setArchivierte((x) => !x),
    });
  }

  return (
    <div className="vp-ms vp-bz" data-testid="bezugsgroessen">
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1 tabIndex={-1} ref={kopf}>
            {B.TITEL}
          </h1>
          <p className="vp-ms-meta">{U.KOPF_SATZ}</p>
        </div>
        {stand && ((darfImportieren && !isPhone) || menue.length > 0) && (
          <span
            className="vp-ms-aktionen"

          >
            {darfImportieren && !isPhone && (
              <Button variant="outline" size="sm" iconLeft={<Icon name="upload" size={15} />} onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { ausloeser.current = e.currentTarget; setImportOffen(true); setErfolg(null); }}>
                {U.WERTE_IMPORTIEREN}
              </Button>
            )}
            {menue.length > 0 && (
              <span
                className="vp-ms-menue"
                data-testid="bezugsgroessen-menue"
                onClickCapture={(e) => {
                  // Der Auslöser ⋯ selbst (die Einträge stehen in einem Portal und verschwinden mit dem Menü).
                  ausloeser.current = e.currentTarget.querySelector('button');
                }}
              >
                <RowMenu label="Weitere Aktionen" buttonClassName="vp-ms-menue-knopf" items={menue} />
              </span>
            )}
          </span>
        )}
      </header>
      {erfolg && (
        <p role="status" className="vp-ms-status is-ok">
          <span className="vp-ms-status-punkt" aria-hidden="true" />
          {erfolg}
        </p>
      )}
      {!ladefehler && (
        <div className={`vp-ms-lage${status?.ton === 'hinweis' ? ' has-hinweise' : ''}`}>
          <BegriffAufklapper
            begriff="bezugsgroesse"
            beispiel={
              beispiel?.wert ? (
                <>
                  Bei Ihnen zum Beispiel{' '}
                  <b>
                    {beispiel.wert.zahl} {beispiel.wert.einheit}
                  </b>{' '}
                  {beispiel.name} ({beispiel.kennzeichen}) im {beispiel.wann}.
                </>
              ) : undefined
            }
          />
          {status && status.ton === 'ok' && (
            <p className="vp-ms-status is-ok" data-testid="bezugsgroessen-status">
              <span className="vp-ms-status-punkt" aria-hidden="true" />
              {status.text}
            </p>
          )}
          {nichtAbrufbar && (
            <p className="vp-ms-status" data-testid="bezugsgroessen-nicht-abrufbar">
              <span className="vp-ms-status-punkt" aria-hidden="true" />
              {U.NICHT_ALLE_ABRUFBAR}{' '}
              <button type="button" className="vp-ms-link vp-bz-erneut" onClick={() => setNeu((n) => n + 1)}>
                {ERNEUT}
              </button>
            </p>
          )}
          {status && status.ton === 'hinweis' && status.ziel && (
            <a className="vp-ms-hinweis is-warn vp-bz-hinweis" href={`#/portfolio/bezugsgroessen/${encodeURIComponent(status.ziel.id)}`} data-testid="bezugsgroessen-hinweis">
              <span className="vp-ms-hinweis-icon" aria-hidden="true">
                <Icon name="alert-triangle" size={20} />
              </span>
              <span className="vp-ms-hinweis-text">
                <b>{status.text}</b>
                {status.satz && <span>{status.satz}</span>}
              </span>
              <span className="vp-ms-hinweis-schritt">
                {U.EINTRAGEN}
                <Icon name="chevron-right" size={16} />
              </span>
            </a>
          )}
        </div>
      )}
      {ladefehler ? (
        <section className="vp-ms-karte is-fehler" role="alert">
          <h2>{U.LADEFEHLER.titel}</h2>
          <p className="vp-ms-leise">{U.LADEFEHLER.satz}</p>
          <button type="button" className="vp-ms-link" onClick={() => setNeu((n) => n + 1)}>
            Erneut versuchen
          </button>
        </section>
      ) : !stand ? (
        <div className="vp-ms-skelett" aria-busy="true" aria-label="Bezugsgrößen werden geladen">
          <span className="vp-skeleton is-karte" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : (
        <>
          {alle.filter((r) => !r.archiviert).length >= U.SUCHE_AB && (
            <label className="vp-ms-suche vp-bz-suche" role="search">
              <Icon name="search" size={17} aria-hidden="true" />
              <input
                type="text"
                role="searchbox"
                aria-label="Bezugsgrößen suchen"
                placeholder="Name, Kennzeichen oder Ort …"
                value={suche}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSuche(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && suche) {
                    e.stopPropagation();
                    setSuche('');
                  }
                }}
              />
            </label>
          )}
          {alle.length === 0 && kacheln.length === 0 ? (
            <section className="vp-ms-karte" role="status">
              <p className="vp-ms-leer-satz">{B.LEER}</p>
              <p className="vp-ms-leise">{B.LEER_SATZ}</p>
              {darfAnlegen && (
                <div className="vp-ms-knoepfe">
                  <Button iconLeft={<Icon name="plus" size={15} />} onClick={(e: ReactMouseEvent<HTMLButtonElement>) => { ausloeser.current = e.currentTarget; setAnlegen(true); }}>
                    {B.ANLEGEN}
                  </Button>
                </div>
              )}
            </section>
          ) : null}
          {gruppen.map((g) => (
            <section key={g.art} className="vp-ms-ort" aria-labelledby={`vp-bz-${g.art}`} data-testid="bezugsgroessen-gruppe">
              <div className="vp-ms-ort-kopf">
                <h2 id={`vp-bz-${g.art}`}>{g.titel}</h2>
                <span className="vp-ms-ort-zahl">{g.reihen.length === 1 ? '1 Bezugsgröße' : `${g.reihen.length} Bezugsgrößen`}</span>
              </div>
              <Spalten wert={spaltenWert(g.reihen)} />
              <ul className="vp-ms-reihen">
                {g.reihen.map((r) => (
                  <li key={r.id}>
                    <BzReiheLink r={r} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {(kacheln.length > 0 || eigene.length > 0) && (
            <section className="vp-ms-ort vp-bz-flaechen" aria-labelledby="vp-bz-flaechen" data-testid="bezugsgroessen-flaechen">
              <div className="vp-ms-ort-kopf">
                <h2 id="vp-bz-flaechen">{U.FLAECHEN.titel}</h2>
                <span className="vp-bz-flaechen-unter">{U.FLAECHEN.unter}</span>
                {standorteDerFlaechen.length > 0 && (
                  <a
                    className="vp-ks-verweis vp-bz-aendern"
                    href={standorteDerFlaechen.length === 1 ? `#/standort/${encodeURIComponent(standorteDerFlaechen[0])}/gebaeude` : '#/portfolio/standorte'}
                  >
                    {U.FLAECHEN.aendern}
                    <Icon name="chevron-right" size={14} />
                  </a>
                )}
              </div>
              {kacheln.length > 0 && (
                <ul className="vp-bz-kacheln">
                  {kacheln.map((k) => (
                    <li key={k.key}>
                      <a
                        className="vp-bz-kachel"
                        href={k.standort ? `#/standort/${encodeURIComponent(k.standort)}/gebaeude` : undefined}
                        aria-label={`${k.name}: ${k.wert ? `${k.wert} ${k.einheit}` : U.FLAECHEN.keine} – ${U.FLAECHEN.aendern}`}
                      >
                        <span>{k.name}</span>
                        {k.wert ? (
                          <b>
                            {k.wert}
                            {' '}
                            {k.einheit}
                          </b>
                        ) : (
                          <b className="is-leer">{U.FLAECHEN.keine}</b>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {eigene.length > 0 && (
                <ul className="vp-ms-reihen vp-bz-eigene">
                  {eigene.map((r) => (
                    <li key={r.id}>
                      <BzReiheLink r={r} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {weitere.length > 0 && (
            <section className="vp-ms-ort" aria-labelledby="vp-bz-weitere" data-testid="bezugsgroessen-weitere">
              <div className="vp-ms-ort-kopf">
                <h2 id="vp-bz-weitere">{U.WEITERE.titel}</h2>
                <span className="vp-ms-ort-zahl">{weitere.length === 1 ? '1 Bezugsgröße' : `${weitere.length} Bezugsgrößen`}</span>
              </div>
              <ul className="vp-ms-reihen">
                {weitere.map((r) => (
                  <li key={r.id}>
                    <BzReiheLink r={r} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {archivierte && archiv.length > 0 && (
            <section className="vp-ms-ort is-still" aria-labelledby="vp-bz-archiv" data-testid="bezugsgroessen-archiv">
              <div className="vp-ms-ort-kopf">
                <h2 id="vp-bz-archiv">{`Archiviert · ${archiv.length}`}</h2>
              </div>
              <ul className="vp-ms-reihen">
                {archiv.map((r) => (
                  <li key={r.id}>
                    <BzReiheLink r={r} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {terme.length > 0 && aktiv.length === 0 && (
            <section className="vp-ms-karte" role="status">
              <p className="vp-ms-leer-satz">{`Keine Bezugsgröße passt zu „${suche.trim()}“.`}</p>
              <div className="vp-ms-knoepfe">
                <button type="button" className="vp-ms-link" onClick={() => setSuche('')}>
                  Suche leeren
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {anlegen && stand && (
        <BezugsgroesseAnlegenDialog
          orte={stand.orte}
          onClose={schliessen}
          onGespeichert={(b) => {
            setStand((s) => (s ? { ...s, liste: { ...s.liste, bezugsgroessen: [...s.liste.bezugsgroessen, b] } } : s));
            setWerte((m) => new Map(m).set(b.id, { bezugsgroesse_id: b.id, kennzeichen: b.kennzeichen, wertart: b.wertart, einheit: b.einheit, periode_art: b.periode_art, von: null, bis: null, fassungen: 'wirksam', werte: [] }));
            setErfolg(`${b.kennzeichen} · ${b.name} ist angelegt.`);
            schliessen();
          }}
        />
      )}
      {importOffen && stand && (
        <BezugsdatenImportDialog
          bezugsgroessen={stand.liste.bezugsgroessen}
          onImportAnsehen={(kennung) => {
            setImportOffen(false);
            setProtokoll(kennung);
          }}
          onClose={() => {
            setImportOffen(false);
            setNeu((n) => n + 1);
            requestAnimationFrame(() => ausloeser.current?.focus());
          }}
        />
      )}
      {protokoll !== undefined && (
        <BezugsdatenImportProtokollDialog
          startKennung={protokoll}
          onClose={() => {
            setProtokoll(undefined);
            requestAnimationFrame(() => ausloeser.current?.focus());
          }}
        />
      )}
    </div>
  );
}

/** Die Spalte des Werts: die fällige Periode, wenn jede Reihe ihren letzten Wert dort hat - sonst „Letzter Wert“. */
function spaltenWert(reihen: readonly U.BzReihe[]): string {
  const r = reihen[0];
  if (!r?.faellig || !r.periodeArt) return 'Letzter Wert';
  const kurz = U.periodeText(r.faellig, r.periodeArt, true);
  return reihen.every((x) => x.faellig === r.faellig && x.wann === kurz) ? U.periodeText(r.faellig, r.periodeArt) : 'Letzter Wert';
}

function Spalten({ wert }: { wert: string }) {
  return (
    <div className="vp-ms-spalten" aria-hidden="true">
      <span>{U.SPALTEN.bezugsgroesse}</span>
      <span>{U.SPALTEN.zustand}</span>
      <span>{U.SPALTEN.woher}</span>
      <span className="is-wert">{wert}</span>
      <span />
    </div>
  );
}

/** Eine Bezugsgröße als Reihe: die ganze Reihe öffnet ihre Seite. */
function BzReiheLink({ r }: { r: U.BzReihe }) {
  return (
    <a
      className={`vp-ms-reihe is-${r.ton} vp-bz-reihe`}
      href={`#/portfolio/bezugsgroessen/${encodeURIComponent(r.id)}`}
      data-testid="bezugsgroesse-reihe"
      data-kennzeichen={r.kennzeichen}
      data-abruf={r.abruf}
      aria-busy={r.abruf === 'unterwegs' ? true : undefined}
    >
      <span className="vp-ms-reihe-name">
        <span className="vp-ms-punkt is-name" aria-hidden="true" />
        <span className="vp-ms-reihe-titel">
          {ohneUmbruchVorZahl(r.name)} <span className="vp-ms-kz">{r.kennzeichen}</span>
        </span>
      </span>
      <span className="vp-ms-reihe-unter">{r.unter}</span>
      <span className="vp-ms-reihe-satz">
        <span className="vp-ms-punkt is-satz" aria-hidden="true" />
        {r.abruf === 'unterwegs' && !r.archiviert ? <span className="vp-skeleton is-zeile vp-bz-skelett" aria-hidden="true" /> : <span>{r.zustand}</span>}
      </span>
      <span className="vp-ms-reihe-woher">{r.woher}</span>
      <span className="vp-ms-reihe-wert">
        {r.abruf === 'unterwegs' ? (
          <span className="vp-skeleton is-zeile vp-bz-skelett is-wert" aria-hidden="true" />
        ) : r.abruf === 'fehler' ? (
          <>
            {/* Am Telefon fehlt die Zustand-Spalte: dort sagt die Wert-Spalte es, statt eines Strichs, der „kein Wert“ hieße. */}
            <b className="is-leer vp-bz-strich" aria-hidden="true">—</b>
            <span className="vp-bz-nicht-abrufbar">{U.ZUSTAND.nichtAbrufbar}</span>
          </>
        ) : r.wert ? (
          <>
            <b>
              {r.wert.zahl}
              <small>{r.wert.einheit}</small>
            </b>
            {r.wann && <span>{r.wann}</span>}
          </>
        ) : (
          <>
            <b className="is-leer">—</b>
            {r.eintragen && <span className="vp-bz-eintragen">{U.EINTRAGEN}</span>}
          </>
        )}
      </span>
      <span className="vp-ms-reihe-chev" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
    </a>
  );
}
