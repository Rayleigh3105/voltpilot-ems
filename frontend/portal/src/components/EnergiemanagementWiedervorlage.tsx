import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type EnergiemanagementVerzeichnis } from '../api';
import {
  artFilterAus,
  ART_PARAMETER,
  seitenSprung,
  springeUeberHash,
  sprungKlick,
  type Sprung,
} from '../entscheid';
import * as E from '../energiemanagementPortal';
import {
  UEMS_KEINE_FRIST_UEBERFAELLIG,
  UEMS_UEBERFAELLIG,
  UEMS_VERANTWORTLICH,
  UEMS_VERZEICHNIS,
  UEMS_WIEDERVORLAGE,
  UEMS_WIEDERVORLAGE_SATZ,
  UEMS_WOHER_FRISTEN,
  UEMS_ZULETZT_ERLEDIGT,
} from '../glossar';
import { energiemanagementRoute } from '../nav';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { useRollen } from '../rollen';
import {
  abschnittBald,
  ALLE,
  ANSEHEN,
  arbeitsliste,
  artAusAdresse,
  artFilterWort,
  bereichBild,
  danachSatz,
  ERNEUT_VERSUCHEN,
  gefiltert,
  KALENDER_ABZUG,
  KALENDER_ABZUG_FEHLER,
  KALENDER_ABZUG_HINWEIS,
  kopfSatz,
  LADEFEHLER,
  LADEFEHLER_TITEL,
  markeBald,
  markeUeberfaellig,
  NOCH_KEINE_FRISTEN,
  nichtsBald,
  NUR_EINSICHT,
  OHNE_FILTER,
  OHNE_PERSON,
  standTag,
  UEBERFAELLIG_ORDNUNG,
  WOHER_SATZ,
  ZULETZT_FEHLER,
  zuletztErledigt,
  type Arbeitsliste,
  type Eintrag,
  type Filter,
  type Wiedervorlage,
} from '../wiedervorlage';
import { Bereichsmarke, FristDatum, Kennzeichentext } from './FristDatum';
import { GrenzSatz } from './GrenzSatz';
import { RowMenu } from './RowMenu';
import './kacheln/Kacheln.css';
import './Wiedervorlage.css';

/** Das Wort, wenn ein Filter einen Abschnitt leert: die Fristen gibt es, nur nicht in dieser Auswahl. */
const NICHTS_IM_FILTER = 'In dieser Auswahl steht hier keine Frist.';

/**
 * Die Wiedervorlage als Arbeitsliste (`#/portfolio/energiemanagement/wiedervorlage`; Konzept Wiedervorlage w1,
 * Captain-Freigabe 05.10.2026): oben, was die Seite ist; darunter die Fristen nach Dringlichkeit: Überfällig, In den
 * nächsten 30 Tagen, Zuletzt erledigt. Jeder Eintrag nennt Aufgabe, Grund, Bereich, Zuständig und genau einen Schritt;
 * die ganze Karte ist das Tippziel und öffnet das Objekt mit offenem Entscheid (`?entscheid=`). Abgehakt wird nichts.
 * Lage, Reihenfolge und Fristen kommen von der Route (WV2); `wiedervorlage.ts` bildet nur Einträge und Wörter. Der
 * Kalender-Abzug ist ein Abruf (WV4, E10), am Telefon im Menü. Am Fuß „Woher kommen diese Fristen?“, Verantwortungs-
 * und Grenz-Satz (SP4).
 */
export function EnergiemanagementWiedervorlage({
  springe = springeUeberHash,
  reiter,
}: {
  /** Der Sprung eines Eintrags; ohne Angabe über die Adresse (`entscheid.ts`). */
  springe?: (s: Sprung) => void;
  /** Die Reiter des Bereichs, wo sie nicht schon über der Seite stehen. */
  reiter?: ReactNode;
}) {
  const rollen = useRollen();
  const einsicht = E.mitEinsicht(rollen.selbst);
  const [versuch, setVersuch] = useState(0);
  const [w, setW] = useState<Wiedervorlage | null>(null);
  const [fehler, setFehler] = useState(false);
  const [verzeichnis, setVerzeichnis] = useState<EnergiemanagementVerzeichnis | 'fehler' | null>(null);
  const [filter, setFilter] = useState<Filter>(() => ({ ...OHNE_FILTER, art: artAusAdresse(artFilterAus(window.location.hash)) }));
  const [kalenderLaeuft, setKalenderLaeuft] = useState(false);
  const [kalenderFehler, setKalenderFehler] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setW(null);
    setFehler(false);
    api.energiemanagementWiedervorlage().then(
      (r) => aktiv && setW(r),
      () => aktiv && setFehler(true),
    );
    api.energiemanagementVerzeichnis().then(
      (r) => aktiv && setVerzeichnis(r),
      () => aktiv && setVerzeichnis('fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  // Vor und zurück zwischen `…/wiedervorlage?art=…` und `…/wiedervorlage` bleibt die Seite stehen; der Filter folgt.
  useEffect(() => {
    const folgen = () => setFilter((f) => ({ ...f, art: artAusAdresse(artFilterAus(window.location.hash)) }));
    window.addEventListener('hashchange', folgen);
    return () => window.removeEventListener('hashchange', folgen);
  }, []);

  const waehle = (neu: Filter) => {
    if (!neu.art && artFilterAus(window.location.hash)) {
      const [pfad, ...rest] = window.location.hash.split('?');
      const p = new URLSearchParams(rest.join('?'));
      p.delete(ART_PARAMETER);
      replaceCurrentNavigation(`${pfad}${p.toString() ? `?${p}` : ''}`);
    }
    setFilter(neu);
  };

  async function kalender() {
    setKalenderLaeuft(true);
    setKalenderFehler(false);
    try {
      const datei = await api.energiemanagementWiedervorlageIcs();
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wiedervorlage-energiemanagement.ics';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setKalenderFehler(true);
    } finally {
      setKalenderLaeuft(false);
    }
  }

  return (
    <div className="vp-wv" data-testid="wiedervorlage">
      {reiter}
      <header className="vp-wv-kopf">
        <div className="vp-wv-kopf-text">
          <h1>{UEMS_WIEDERVORLAGE}</h1>
          <p className="vp-wv-meta" data-testid="wiedervorlage-kopf">
            {w ? kopfSatz(standTag(w.stichtag)) : `${UEMS_WIEDERVORLAGE_SATZ}.`}
          </p>
        </div>
        <button
          type="button"
          className="vp-wv-kalender"
          onClick={() => void kalender()}
          disabled={kalenderLaeuft}
          data-testid="wiedervorlage-kalender"
        >
          <Icon name="calendar" size={16} />
          {KALENDER_ABZUG}
        </button>
        <span className="vp-wv-menue" data-testid="wiedervorlage-menue">
          <RowMenu
            label="Weitere Aktionen"
            buttonClassName="vp-wv-menue-knopf"
            items={[{ label: KALENDER_ABZUG, icon: 'calendar', onClick: () => void kalender() }]}
          />
        </span>
      </header>
      {kalenderFehler && (
        <p className="vp-wv-hinweis is-warn" role="alert" data-testid="wiedervorlage-kalender-fehler">
          {KALENDER_ABZUG_FEHLER}
        </p>
      )}
      {einsicht && (
        <p className="vp-wv-hinweis" data-testid="wiedervorlage-einsicht">
          {NUR_EINSICHT}
        </p>
      )}
      {fehler ? (
        <section className="vp-wv-karte is-fehler" role="alert" data-testid="wiedervorlage-fehler">
          <div className="vp-wv-blockkopf">
            <h2>{LADEFEHLER_TITEL}</h2>
          </div>
          <p className="vp-wv-leise">{LADEFEHLER}</p>
          <button type="button" className="vp-wv-link" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT_VERSUCHEN}
          </button>
        </section>
      ) : w === null ? (
        <div className="vp-wv-skelett" aria-busy="true" aria-label="Wird geladen" data-testid="wiedervorlage-laedt">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-karte" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : (
        <Liste w={w} filter={filter} onFilter={waehle} einsicht={einsicht} springe={springe} />
      )}
      <ZuletztErledigt verzeichnis={verzeichnis} springe={springe} />
      <footer className="vp-wv-saetze" data-testid="wiedervorlage-fuss">
        <p>
          <b>{UEMS_WOHER_FRISTEN}</b> {WOHER_SATZ}
        </p>
        <p>
          {KALENDER_ABZUG}: {KALENDER_ABZUG_HINWEIS}
        </p>
        <GrenzSatz verantwortung />
      </footer>
    </div>
  );
}

/** Marken, Filter und die Abschnitte nach Dringlichkeit. */
function Liste({
  w,
  filter,
  onFilter,
  einsicht,
  springe,
}: {
  w: Wiedervorlage;
  filter: Filter;
  onFilter: (f: Filter) => void;
  einsicht: boolean;
  springe: (s: Sprung) => void;
}) {
  const l = arbeitsliste(w);
  if (l.ueberfaellig.length === 0 && l.bald.length === 0 && l.spaeter === 0) {
    return (
      <section className="vp-wv-karte" data-testid="wiedervorlage-leer">
        <p className="vp-wv-leer">{NOCH_KEINE_FRISTEN}</p>
      </section>
    );
  }
  const ueber = gefiltert(l.ueberfaellig, filter);
  const bald = gefiltert(l.bald, filter);
  const zu = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  return (
    <>
      <div className="vp-wv-leiste">
        <Marken l={l} onZu={zu} />
        <FilterLeiste l={l} filter={filter} onFilter={onFilter} />
      </div>
      {l.ueberfaellig.length > 0 && (
        <section className="vp-wv-abschnitt" id="vp-wv-ueberfaellig" aria-labelledby="vp-wv-ueberfaellig-titel">
          <div className="vp-wv-abschnitt-kopf">
            <h2 id="vp-wv-ueberfaellig-titel">{`${UEMS_UEBERFAELLIG} · ${ueber.length}`}</h2>
            <span className="vp-wv-abschnitt-m">{UEBERFAELLIG_ORDNUNG}</span>
          </div>
          {ueber.length > 0 ? (
            <Eintraege eintraege={ueber} testid="wiedervorlage-ueberfaellig" einsicht={einsicht} springe={springe} />
          ) : (
            <p className="vp-wv-leise">{NICHTS_IM_FILTER}</p>
          )}
        </section>
      )}
      <section className="vp-wv-abschnitt" id="vp-wv-bald" aria-labelledby="vp-wv-bald-titel">
        <div className="vp-wv-abschnitt-kopf">
          <h2 id="vp-wv-bald-titel">{bald.length > 0 ? `${abschnittBald(l.vorschauTage)} · ${bald.length}` : abschnittBald(l.vorschauTage)}</h2>
          <span className="vp-wv-abschnitt-m">bis {l.fensterBis}</span>
        </div>
        {bald.length > 0 ? (
          <Eintraege eintraege={bald} testid="wiedervorlage-bald" einsicht={einsicht} springe={springe} />
        ) : (
          <p className="vp-wv-leer" data-testid="wiedervorlage-nichts-bald">
            {l.bald.length > 0 ? NICHTS_IM_FILTER : nichtsBald(l.fensterBis)}
          </p>
        )}
        {l.spaeter > 0 && (
          <p className="vp-wv-leise" data-testid="wiedervorlage-danach">
            {danachSatz(l.spaeter)}
          </p>
        )}
      </section>
    </>
  );
}

/** Die Marken zählen Einträge (Entscheid 4) und springen zu ihrem Abschnitt; Warnton nur für Überfälliges. */
function Marken({ l, onZu }: { l: Arbeitsliste; onZu: (id: string) => void }) {
  return (
    <div className="vp-wv-marken vp-k-farben" data-testid="wiedervorlage-marken">
      {l.ueberfaellig.length > 0 ? (
        <button type="button" className="vp-k-marke is-warn vp-wv-marke" onClick={() => onZu('vp-wv-ueberfaellig')}>
          {markeUeberfaellig(l.ueberfaellig.length)}
        </button>
      ) : (
        <span className="vp-k-marke is-ok">
          <span className="vp-wv-punkt" aria-hidden="true" />
          {UEMS_KEINE_FRIST_UEBERFAELLIG}
        </span>
      )}
      {l.bald.length > 0 && (
        <button type="button" className="vp-k-marke vp-wv-marke" onClick={() => onZu('vp-wv-bald')}>
          {markeBald(l.bald.length, l.vorschauTage)}
        </button>
      )}
    </div>
  );
}

/** Filter für die Arbeitsteilung: Alle, die Art aus der Übersicht (aufhebbar), je Bereich. */
function FilterLeiste({ l, filter, onFilter }: { l: Arbeitsliste; filter: Filter; onFilter: (f: Filter) => void }) {
  const bereiche = l.bereiche.length > 1 ? l.bereiche : [];
  if (bereiche.length === 0 && !filter.art) return null;
  return (
    <div className="vp-wv-filter" role="group" aria-label="Filter" data-testid="wiedervorlage-filter">
      <button type="button" className="vp-wv-chip" aria-pressed={!filter.art && !filter.bereich} onClick={() => onFilter(OHNE_FILTER)}>
        {ALLE}
      </button>
      {filter.art && (
        <button
          type="button"
          className="vp-wv-chip"
          aria-pressed="true"
          aria-label={`${artFilterWort(filter.art)}: Filter aufheben`}
          onClick={() => onFilter({ ...filter, art: null })}
          data-testid="wiedervorlage-filter-art"
        >
          {artFilterWort(filter.art)}
          <Icon name="x" size={12} />
        </button>
      )}
      {bereiche.map((b) => (
        <button
          key={b}
          type="button"
          className="vp-wv-chip"
          aria-pressed={filter.bereich === b}
          onClick={() => onFilter({ ...filter, bereich: filter.bereich === b ? null : b })}
          data-testid={`wiedervorlage-filter-${b}`}
        >
          {bereichBild(b).wort}
        </button>
      ))}
    </div>
  );
}

function Eintraege({
  eintraege,
  testid,
  einsicht,
  springe,
}: {
  eintraege: Eintrag[];
  testid: string;
  einsicht: boolean;
  springe: (s: Sprung) => void;
}) {
  return (
    <ul className="vp-wv-eintraege" data-testid={testid}>
      {eintraege.map((e) => (
        <li key={e.key}>
          <EintragKarte e={e} einsicht={einsicht} springe={springe} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Ein Eintrag: ① Datum, ② Aufgabe, ③ Grund, ④ Bereich, ⑤ Zuständig, ⑥ der eine Schritt. Wer nur Einsicht hat, öffnet
 * das Objekt zum Ansehen, ohne Entscheid.
 */
function EintragKarte({ e, einsicht, springe }: { e: Eintrag; einsicht: boolean; springe: (s: Sprung) => void }) {
  const ziel = e.sprung ? (einsicht ? seitenSprung(e.sprung.route) : e.sprung) : null;
  const schritt = einsicht ? ANSEHEN : e.schritt;
  const inhalt = (
    <>
      <FristDatum {...e.frist} ton={e.frist.ueberfaellig ? 'ueber' : 'bald'} />
      <span className="vp-wv-text">
        <span className="vp-wv-aufgabe">
          <Kennzeichentext text={e.aufgabe} />
        </span>
        <span className="vp-wv-grund">
          <Kennzeichentext text={e.frist.relativ ? `${e.grund} · ${e.frist.relativ}` : e.grund} />
        </span>
      </span>
      {ziel && (
        <span className="vp-wv-chev" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      )}
      <span className="vp-wv-fuss">
        <Bereichsmarke bereich={e.bereich} />
        {e.verantwortlich ? (
          <span className="vp-wv-wer">
            {e.verantwortlich}
            <small>{UEMS_VERANTWORTLICH.toLowerCase()}</small>
          </span>
        ) : (
          <span className="vp-wv-wer is-leer">{OHNE_PERSON}</span>
        )}
        {ziel && (
          <span className="vp-wv-schritt">
            {schritt}
            <span aria-hidden="true"> ›</span>
          </span>
        )}
      </span>
    </>
  );
  return ziel ? (
    <a className="vp-wv-eintrag" href={ziel.hash} onClick={sprungKlick(ziel, springe)} data-testid={`wiedervorlage-eintrag-${e.kennzeichen}`}>
      {inhalt}
    </a>
  ) : (
    <div className="vp-wv-eintrag" data-testid={`wiedervorlage-eintrag-${e.kennzeichen}`}>
      {inhalt}
    </div>
  );
}

/** Zuletzt erledigt: Rückmeldung mit Tag und Person; der volle Nachweis steht im Verzeichnis. */
function ZuletztErledigt({ verzeichnis, springe }: { verzeichnis: EnergiemanagementVerzeichnis | 'fehler' | null; springe: (s: Sprung) => void }) {
  if (verzeichnis === null) return null;
  const liste = verzeichnis === 'fehler' ? [] : zuletztErledigt(verzeichnis);
  if (verzeichnis !== 'fehler' && liste.length === 0) return null;
  const zumVerzeichnis = seitenSprung(energiemanagementRoute('verzeichnis'));
  return (
    <section className="vp-wv-karte" aria-labelledby="vp-wv-zuletzt-titel" data-testid="wiedervorlage-zuletzt">
      <div className="vp-wv-blockkopf">
        <h2 id="vp-wv-zuletzt-titel">{UEMS_ZULETZT_ERLEDIGT}</h2>
        <a className="vp-wv-link" href={zumVerzeichnis.hash} onClick={sprungKlick(zumVerzeichnis, springe)}>
          {UEMS_VERZEICHNIS}
          <span aria-hidden="true"> ›</span>
        </a>
      </div>
      {verzeichnis === 'fehler' ? (
        <p className="vp-wv-leise">{ZULETZT_FEHLER}</p>
      ) : (
        <ul className="vp-fzl">
          {liste.map((x) => (
            <li key={x.key}>
              <div className="vp-fz">
                <FristDatum wort="am" tag={x.tag} jahr={x.jahr} satz={`erledigt am ${x.tag}${x.jahr}`} ton="erledigt" />
                <span className="vp-fz-text">
                  <span className="vp-fz-titel">
                    <Kennzeichentext text={x.titel} />
                  </span>
                  {x.wer && <span className="vp-fz-grund">{x.wer}</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
