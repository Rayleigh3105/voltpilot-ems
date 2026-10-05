import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
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
  UEMS_JAHRESPLAN,
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
  AUFGABE_FESTLEGEN,
  aufgabeFestlegenSprung,
  bereichBild,
  ERNEUT_VERSUCHEN,
  gefiltert,
  JAHRESPLAN_ANZEIGEN,
  JAHRESPLAN_ZUKLAPPEN,
  jahresplanGruppen,
  jahresplanSatz,
  KALENDER_ABZUG,
  KALENDER_ABZUG_FEHLER,
  KALENDER_ABZUG_HINWEIS,
  kopfSatz,
  LADEFEHLER,
  LADEFEHLER_TITEL,
  lautAufgabe,
  markeBald,
  markeJahresplan,
  markeUeberfaellig,
  MEINE,
  naechsteFrist,
  NIEMAND_ZUSTAENDIG,
  NOCH_KEINE_FRISTEN,
  nichtsBald,
  NUR_EINSICHT,
  OEFFNEN,
  OHNE_FILTER,
  OHNE_ZUSTAENDIGE,
  standTag,
  UEBERFAELLIG_ORDNUNG,
  WOHER_SATZ,
  ZULETZT_FEHLER,
  zuletztErledigt,
  type Arbeitsliste,
  type Eintrag,
  type Filter,
  type WerFilter,
  type Wiedervorlage,
  type WiedervorlageZuletzt,
} from '../wiedervorlage';
import { Bereichsmarke, FristDatum, Kennzeichentext } from './FristDatum';
import { GrenzSatz } from './GrenzSatz';
import { RowMenu } from './RowMenu';
import './kacheln/Kacheln.css';
import './Wiedervorlage.css';

/** Das Wort, wenn ein Filter einen Abschnitt leert: die Fristen gibt es, nur nicht in dieser Auswahl. */
const NICHTS_IM_FILTER = 'In dieser Auswahl steht hier keine Frist.';
const JAHRESPLAN_ID = 'vp-wv-jahresplan';
const MONATE_ID = 'vp-wv-jahresplan-monate';

/** Wie ein Eintrag in seinem Abschnitt steht: abgelaufen, in den nächsten Tagen, im Jahresplan. */
type Ton = 'ueber' | 'bald' | 'plan';

/**
 * Die Wiedervorlage als Arbeitsliste (`#/portfolio/energiemanagement/wiedervorlage`; Konzept Wiedervorlage w1,
 * Captain-Freigabe 05.10.2026): oben, was die Seite ist; darunter die Fristen nach Dringlichkeit: Überfällig, In den
 * nächsten 30 Tagen, Jahresplan (nach Monaten; im Normalfall offen), Zuletzt erledigt. Jeder Eintrag nennt Aufgabe,
 * Grund, Bereich, Zuständig (am Objekt oder laut Aufgabe; ohne Person mit dem Weg „Aufgabe festlegen“) und genau einen
 * Schritt; die ganze Karte ist das Tippziel und öffnet das Objekt mit offenem Entscheid (`?entscheid=`). Abgehakt wird
 * nichts. Lage, Reihenfolge, Fristen und Herleitung kommen von der Route (WV2, Vertrag 1.1); `wiedervorlage.ts` bildet
 * nur Einträge und Wörter. Der Kalender-Abzug ist ein Abruf (WV4, E10), am Telefon im Menü. Am Fuß „Woher kommen diese
 * Fristen?“, Verantwortungs- und Grenz-Satz (SP4).
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
  const festlegen = rollen.darf(E.RECHT_VERWALTEN, null);
  const [versuch, setVersuch] = useState(0);
  const [w, setW] = useState<Wiedervorlage | null>(null);
  const [fehler, setFehler] = useState(false);
  const [zuletzt, setZuletzt] = useState<WiedervorlageZuletzt | 'fehler' | null>(null);
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
    // Ein eigener Abruf: er liest das Verzeichnis, die Liste der Fristen wartet nicht auf ihn.
    api.energiemanagementWiedervorlageZuletzt().then(
      (r) => aktiv && setZuletzt(r),
      () => aktiv && setZuletzt('fehler'),
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
        <Liste w={w} filter={filter} onFilter={waehle} einsicht={einsicht} festlegen={festlegen} springe={springe} />
      )}
      <ZuletztErledigt zuletzt={zuletzt} springe={springe} />
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

/**
 * Die klebenden Leisten oben (Kopfzeile, am Telefon die Reiter) verdecken den Anfang eines Abschnitts: ihre Höhe wird
 * beim Sprung gemessen, nicht geschätzt (eine Leiste klebt bei ihrem `top` und ist so hoch, wie sie ist).
 */
function klebendeOberkante(): number {
  let unten = 0;
  for (const el of document.querySelectorAll<HTMLElement>('.vp-topbar, .vp-bereich-tabs')) {
    const stil = getComputedStyle(el);
    if (stil.position !== 'sticky' && stil.position !== 'fixed') continue;
    unten = Math.max(unten, (parseFloat(stil.top) || 0) + el.getBoundingClientRect().height);
  }
  return unten;
}

/** Eine Marke springt zu ihrem Abschnitt: sein Kopf steht unter den klebenden Leisten, nicht dahinter. */
function zuAbschnitt(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.scrollMarginTop = `${klebendeOberkante() + 12}px`;
  el.scrollIntoView({ block: 'start' });
}

/**
 * Was jeder Eintrag über die angemeldete Person wissen muss: nur Einsicht, darf Aufgaben festlegen, liest die Aufgaben
 * überhaupt (nur dann ist „ohne Person“ ein „Niemand zuständig“).
 */
type EintragRechte = { einsicht: boolean; festlegen: boolean; aufgabenLesbar: boolean; springe: (s: Sprung) => void };

/** Marken, Filter und die Abschnitte nach Dringlichkeit. */
function Liste({
  w,
  filter,
  onFilter,
  einsicht,
  festlegen,
  springe,
}: {
  w: Wiedervorlage;
  filter: Filter;
  onFilter: (f: Filter) => void;
} & Omit<EintragRechte, 'aufgabenLesbar'>) {
  const l = arbeitsliste(w);
  // Der Jahresplan steht im Normalfall offen; bei Überfälligem bleibt er zu, bis man ihn öffnet.
  const [planOffen, setPlanOffen] = useState(l.ueberfaellig.length === 0);
  if (l.ueberfaellig.length === 0 && l.bald.length === 0 && l.jahresplan.length === 0) {
    return (
      <section className="vp-wv-karte" data-testid="wiedervorlage-leer">
        <p className="vp-wv-leer">{NOCH_KEINE_FRISTEN}</p>
      </section>
    );
  }
  const ueber = gefiltert(l.ueberfaellig, filter);
  const bald = gefiltert(l.bald, filter);
  const plan = gefiltert(l.jahresplan, filter);
  const rechte = { einsicht, festlegen, aufgabenLesbar: l.aufgabenLesbar, springe };
  const zumPlan = () => {
    setPlanOffen(true);
    // Erst nach dem Aufklappen steht der Jahresplan in voller Höhe da.
    window.requestAnimationFrame(() => zuAbschnitt(JAHRESPLAN_ID));
  };
  const naechste = l.jahresplan[0];
  return (
    <>
      <div className="vp-wv-leiste">
        <Marken l={l} onZu={zuAbschnitt} onPlan={zumPlan} />
        <FilterLeiste l={l} filter={filter} onFilter={onFilter} />
      </div>
      {l.ueberfaellig.length > 0 && (
        <section className="vp-wv-abschnitt" id="vp-wv-ueberfaellig" aria-labelledby="vp-wv-ueberfaellig-titel">
          <div className="vp-wv-abschnitt-kopf">
            <h2 id="vp-wv-ueberfaellig-titel">{`${UEMS_UEBERFAELLIG} · ${ueber.length}`}</h2>
            <span className="vp-wv-abschnitt-m">{UEBERFAELLIG_ORDNUNG}</span>
          </div>
          {ueber.length > 0 ? (
            <Eintraege eintraege={ueber} ton="ueber" testid="wiedervorlage-ueberfaellig" {...rechte} />
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
          <Eintraege eintraege={bald} ton="bald" testid="wiedervorlage-bald" {...rechte} />
        ) : (
          <p className="vp-wv-leer is-karte" data-testid="wiedervorlage-nichts-bald">
            {l.bald.length > 0
              ? NICHTS_IM_FILTER
              : [nichtsBald(l.fensterBis), naechste ? naechsteFrist(standTag(naechste.faellig_am)) : null].filter(Boolean).join(' ')}
          </p>
        )}
      </section>
      {l.jahresplan.length > 0 && (
        <section
          className="vp-wv-abschnitt is-plan"
          id={JAHRESPLAN_ID}
          aria-labelledby="vp-wv-jahresplan-titel"
          data-testid="wiedervorlage-jahresplan"
        >
          <div className="vp-wv-abschnitt-kopf">
            <h2 id="vp-wv-jahresplan-titel">{planOffen ? `${UEMS_JAHRESPLAN} · ${plan.length}` : UEMS_JAHRESPLAN}</h2>
            <span className="vp-wv-abschnitt-m is-immer">bis {l.jahresplanBis}</span>
          </div>
          {!planOffen ? (
            <button
              type="button"
              className="vp-fz vp-wv-plan-knopf"
              aria-expanded="false"
              aria-controls={MONATE_ID}
              onClick={() => setPlanOffen(true)}
              data-testid="wiedervorlage-jahresplan-anzeigen"
            >
              <span className="vp-fd is-plan" aria-hidden="true">
                <Icon name="calendar" size={20} />
              </span>
              <span className="vp-fz-text">
                <span className="vp-fz-titel">{JAHRESPLAN_ANZEIGEN}</span>
                <span className="vp-fz-grund">{jahresplanSatz(l.vorschauTage)}</span>
              </span>
              <span className="vp-fz-chev" aria-hidden="true">
                <Icon name="chevron-down" size={18} />
              </span>
            </button>
          ) : (
            <div id={MONATE_ID} className="vp-wv-monate">
              {plan.length > 0 ? (
                jahresplanGruppen(plan).map((g) => (
                  <div key={g.key} className="vp-wv-monat">
                    <h3 className="vp-wv-monat-titel">{g.titel}</h3>
                    <Eintraege eintraege={g.eintraege} ton="plan" testid={`wiedervorlage-jahresplan-${g.key}`} {...rechte} />
                  </div>
                ))
              ) : (
                <p className="vp-wv-leise">{NICHTS_IM_FILTER}</p>
              )}
              <button
                type="button"
                className="vp-wv-link vp-wv-zuklappen"
                aria-expanded="true"
                aria-controls={MONATE_ID}
                onClick={() => setPlanOffen(false)}
                data-testid="wiedervorlage-jahresplan-zuklappen"
              >
                {JAHRESPLAN_ZUKLAPPEN}
                <Icon name="chevron-down" size={14} />
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Die Marken zählen Einträge (Entscheid 4) und springen zu ihrem Abschnitt; Warnton nur für Überfälliges, der
 * Jahresplan gestrichelt wie jede Plan-Marke der Familie.
 */
function Marken({ l, onZu, onPlan }: { l: Arbeitsliste; onZu: (id: string) => void; onPlan: () => void }) {
  const ueber = l.ueberfaellig.length > 0;
  return (
    <div className="vp-wv-marken vp-k-farben" data-testid="wiedervorlage-marken">
      {ueber ? (
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
      {l.jahresplan.length > 0 && (
        // Neben Überfälligem genügt das Wort; im Normalfall zählt die Marke, was im Jahr ansteht.
        <button type="button" className="vp-k-marke is-plan vp-wv-marke" onClick={onPlan} data-testid="wiedervorlage-marke-jahresplan">
          {ueber ? UEMS_JAHRESPLAN : markeJahresplan(l.jahresplan.length)}
        </button>
      )}
    </div>
  );
}

/**
 * Filter für die Arbeitsteilung: Alle, Meine (der angemeldeten Person zugeordnet), Ohne Zuständige, die Art aus der
 * Übersicht (aufhebbar), je Bereich. Ein Filter steht nur da, wo er etwas zeigt.
 */
function FilterLeiste({ l, filter, onFilter }: { l: Arbeitsliste; filter: Filter; onFilter: (f: Filter) => void }) {
  const alle = [...l.ueberfaellig, ...l.bald, ...l.jahresplan];
  const wer: { key: Exclude<WerFilter, 'alle'>; wort: string }[] = [
    ...(alle.some((e) => e.zustaendig?.ich) ? [{ key: 'meine' as const, wort: MEINE }] : []),
    ...(l.aufgabenLesbar && alle.some((e) => !e.zustaendig) ? [{ key: 'ohne' as const, wort: OHNE_ZUSTAENDIGE }] : []),
  ];
  const bereiche = l.bereiche.length > 1 ? l.bereiche : [];
  if (bereiche.length === 0 && wer.length === 0 && !filter.art) return null;
  return (
    <div className="vp-wv-filter" role="group" aria-label="Filter" data-testid="wiedervorlage-filter">
      <button
        type="button"
        className="vp-wv-chip"
        aria-pressed={!filter.art && !filter.bereich && filter.wer === 'alle'}
        onClick={() => onFilter(OHNE_FILTER)}
      >
        {ALLE}
      </button>
      {wer.map((x) => (
        <button
          key={x.key}
          type="button"
          className="vp-wv-chip"
          aria-pressed={filter.wer === x.key}
          onClick={() => onFilter({ ...filter, wer: filter.wer === x.key ? 'alle' : x.key })}
          data-testid={`wiedervorlage-filter-${x.key}`}
        >
          {x.wort}
        </button>
      ))}
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

function Eintraege({ eintraege, ton, testid, ...rechte }: { eintraege: Eintrag[]; ton: Ton; testid: string } & EintragRechte) {
  return (
    <ul className="vp-wv-eintraege" data-testid={testid}>
      {eintraege.map((e) => (
        <li key={e.key}>
          <EintragKarte e={e} ton={ton} {...rechte} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Ein Eintrag: ① Datum, ② Aufgabe, ③ Grund, ④ Bereich, ⑤ Zuständig, ⑥ der eine Schritt. Die ganze Karte ist das
 * Tippziel (der Link der Aufgabe deckt sie ab); nennt niemand eine Person, führt ein zweiter Link zur Aufgabe im
 * Energiemanagement. Im Jahresplan ist noch nichts zu entscheiden: der Schritt heißt „Öffnen“. Wer nur Einsicht hat,
 * öffnet das Objekt zum Ansehen, ohne Entscheid.
 */
function EintragKarte({ e, ton, einsicht, festlegen, aufgabenLesbar, springe }: { e: Eintrag; ton: Ton } & EintragRechte) {
  const ansehen = einsicht || ton === 'plan';
  const ziel = e.sprung ? (ansehen ? seitenSprung(e.sprung.route) : e.sprung) : null;
  const schritt = einsicht ? ANSEHEN : ton === 'plan' ? OEFFNEN : e.schritt;
  const zuordnen = !e.zustaendig && festlegen && !einsicht && e.aufgabeIm ? aufgabeFestlegenSprung(e.aufgabeIm) : null;
  return (
    <div
      className={`vp-wv-eintrag${ziel ? ' is-ziel' : ''}${ton === 'plan' ? ' is-plan' : ''}`}
      data-testid={`wiedervorlage-eintrag-${e.kennzeichen}`}
    >
      <FristDatum {...e.frist} ton={ton === 'plan' ? 'plan' : e.frist.ueberfaellig ? 'ueber' : 'bald'} />
      <span className="vp-wv-text">
        <span className="vp-wv-aufgabe">
          {ziel ? (
            // Der Name trägt den Schritt (der Text rechts ist nur Bild): „Energiepolitik überprüfen: Bestätigen oder neu fassen“.
            <a
              className="vp-wv-ziel"
              href={ziel.hash}
              onClick={sprungKlick(ziel, springe)}
              aria-label={`${e.aufgabe}: ${schritt}`}
              data-testid={`wiedervorlage-ziel-${e.kennzeichen}`}
            >
              <Kennzeichentext text={e.aufgabe} />
            </a>
          ) : (
            <Kennzeichentext text={e.aufgabe} />
          )}
        </span>
        <span className="vp-wv-grund">
          <Kennzeichentext text={e.frist.relativ && ton !== 'plan' ? `${e.grund} · ${e.frist.relativ}` : e.grund} />
        </span>
      </span>
      {ziel && (
        <span className="vp-wv-chev" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      )}
      <span className="vp-wv-fuss">
        <Bereichsmarke bereich={e.bereich} />
        {e.zustaendig ? (
          <span className="vp-wv-wer">
            {e.zustaendig.name}
            {e.zustaendig.herkunft === 'aufgabe' ? (
              // Am Telefon „· laut Aufgabe“ hinter dem Namen, in der Reihe darunter mit dem Wort der Aufgabe.
              <small className="is-aufgabe">
                <span className="vp-wv-wer-kurz">· {lautAufgabe(null)}</span>
                <span className="vp-wv-wer-lang">{lautAufgabe(e.aufgabeIm)}</span>
              </small>
            ) : (
              <small>{UEMS_VERANTWORTLICH.toLowerCase()}</small>
            )}
          </span>
        ) : aufgabenLesbar ? (
          <span className="vp-wv-wer is-leer">
            {NIEMAND_ZUSTAENDIG}
            {zuordnen && (
              <a
                className="vp-wv-festlegen"
                href={zuordnen.hash}
                onClick={sprungKlick(zuordnen, springe)}
                data-testid={`wiedervorlage-festlegen-${e.kennzeichen}`}
              >
                {AUFGABE_FESTLEGEN}
                <span aria-hidden="true"> ›</span>
              </a>
            )}
          </span>
        ) : null}
        {ziel && (
          <span className="vp-wv-schritt" aria-hidden="true">
            {schritt}
            <span> ›</span>
          </span>
        )}
      </span>
    </div>
  );
}

/** Zuletzt erledigt: Rückmeldung mit Tag und Person; der volle Nachweis steht im Verzeichnis. */
function ZuletztErledigt({ zuletzt, springe }: { zuletzt: WiedervorlageZuletzt | 'fehler' | null; springe: (s: Sprung) => void }) {
  if (zuletzt === null) return null;
  const liste = zuletzt === 'fehler' ? [] : zuletztErledigt(zuletzt);
  if (zuletzt !== 'fehler' && liste.length === 0) return null;
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
      {zuletzt === 'fehler' ? (
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
