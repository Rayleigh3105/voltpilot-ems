import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { zeitraumAus } from '../anlageEnergiebilanz';
import { api, type Kostenstelle, type KostenstelleEnergiePeriode, type MessstellenRegister, type Prozess } from '../api';
import '../components/BereichTabs.css';
import { MessstelleDialog } from '../components/MessstelleDialog';
import { RowMenu } from '../components/RowMenu';
import { StandAm } from '../components/StandAm';
import { VpPicker } from '../components/VpPicker';
import { UEMS_WERTE } from '../glossar';
import { heuteIn } from '../kennzahlKarte';
import { REITER_LABEL, REITER_WORT, hervorAus, reiterAus, reiterDa, reiterHash, type MessstellenReiter } from '../kostenstellenUebersicht';
import {
  ERNEUT,
  FILTER,
  LADEFEHLER,
  LADEN,
  OHNE_ANGABE,
  OHNE_FILTER,
  SPALTEN,
  TITEL,
  ZUR_UEBERSICHT,
  ZUSTAND_HEUTE,
  filterAktiv,
  filterOptionen,
  kopfZeile,
  leerzustand,
  registerAnfrage,
  registerEintraege,
  type FilterOption,
  type FilterOptionen,
  type Leerzustand,
  type Lebenszyklus,
  type MessstellenEbene,
  type RegisterEintrag,
  type RegisterFilter,
  type ZeileWoerter,
} from '../messstellen';
import { DIALOG_TITEL } from '../messstelleDialog';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { verschiebe } from '../picker/datum';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { useIsPhone } from '../useIsPhone';
import { KostenstellenReiter, ProzesseReiter } from './KostenstellenSection';
import { MessstelleSeite } from './MessstelleSeite';
import './MessstellenPage.css';

/**
 * „Unternehmen › Messstellen“ und „Standort › Messstellen“ (UEMS AP-04 IP-5):
 * das Register als Tabelle am Rechner und als Karten am Telefon, Filter,
 * Leerzustände und „Stand am …“.
 *
 * Die Fläche liest EINE Abfrage (`GET /api/v1/messstellen`, IP-4/IP-15) — die
 * Filter gehen als Parameter an sie, jede Ableitung steht im reinen Modul
 * `messstellen.ts`. Die Optionen der Filter kommen aus der ungefilterten Antwort
 * desselben Tags (sie wird je Tag gemerkt, nicht neu gefragt).
 *
 * ⚠ Mit Stichtag gibt es keinen Schreibweg. „Messstelle anlegen“ öffnet seit AP-04 IP-6 den
 * `MessstelleDialog` — im Kopf, im Leerzustand „noch keine Messstelle“ am Satz (§5.11); nie mit
 * Stichtag, nie ohne „Messen & Auswerten“ (E6). Hat ein Schritt gespeichert, liest die Fläche nach
 * dem Schließen neu. „Vorschläge aus Komponenten“ kommt mit der Vorschlagsliste (AP-01 IP-9b), vorher
 * kein Knopf ohne Ziel.
 */
export function MessstellenPage({
  messstelleId = null,
  werte = null,
  onOeffnen,
  onWerteZeitraum,
  onWerteVergleich,
  onListe,
  organisation = false,
  ...register
}: RegisterProps & {
  /** Die Messstelle der Adresse (AP-04 IP-8) — dann steht ihre Seite statt des Registers. */
  messstelleId?: string | null;
  /** Periode und Version der Adresse für den Abschnitt „Werte“ der Seite (AP-13 IP-3). */
  werte?: { periode: string | null; version: number | null; vergleich: string | null } | null;
  /** Die neu gewählte Periode im Abschnitt „Werte“ — der Wirt schreibt die Adresse nach. */
  onWerteZeitraum?: (periode: string) => void;
  /** AP-13 IP-5: eine neue Wahl des Vergleichs-Umschalters (`v=` der Adresse). */
  onWerteVergleich?: (v: string | null) => void;
  /** Der Weg zurück ins Register der Ebene. */
  onListe?: () => void;
  /**
   * AP-13 IP-9 (E8 = A): die Reiter „Kostenstellen“ und „Prozesse“ — nur in der Welt Messstellen am Unternehmen (der Wirt
   * entscheidet), und erst, wenn es eine Kostenstelle oder einen Prozess gibt. Ohne diese Angabe fragt die Fläche die
   * Kataloge gar nicht.
   */
  organisation?: boolean;
}) {
  if (messstelleId && onListe) {
    return (
      <MessstelleSeite
        key={messstelleId}
        id={messstelleId}
        zone={register.zone}
        werte={werte}
        onWerteZeitraum={onWerteZeitraum}
        onWerteVergleich={onWerteVergleich}
        onListe={onListe}
      />
    );
  }
  if (organisation) return <MessstellenWelt {...register} onOeffnen={onOeffnen} />;
  return <RegisterFlaeche {...register} onOeffnen={onOeffnen} />;
}

type Organisation = { kostenstellen: Kostenstelle[]; prozesse: Prozess[] };

/**
 * Die Welt Messstellen am Unternehmen mit ihren Reitern Liste · Kostenstellen · Prozesse (AP-13 IP-9). Reiter und
 * Zeitraum stehen in der Adresse (`#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01`) und werden
 * ersetzt, nicht gestapelt — wie die Zeit-Leiste der Energiebilanz. Ohne Kostenstelle und ohne Prozess ist die Fläche das
 * Register von heute, ohne Leiste.
 */
function MessstellenWelt(register: RegisterProps) {
  const [katalog, setKatalog] = useState<Organisation | null>(null);
  const [reiter, setReiter] = useState<MessstellenReiter>(() => reiterAus(window.location.hash));
  const [heute] = useState(() => heuteIn(VORGABE_ZEITZONE, Date.now()));
  const [wahl, setWahl] = useState(() => zeitraumAus(window.location.hash, heute));
  const [hervor] = useState(() => hervorAus(window.location.hash));

  useEffect(() => {
    let aktiv = true;
    // Ein Katalog, der nicht antwortet, bringt keinen Reiter — das Register bleibt, wie es war.
    Promise.all([
      api.kostenstellen().then(
        (k) => k.kostenstellen,
        () => [] as Kostenstelle[],
      ),
      api.prozesse().then(
        (p) => p.prozesse,
        () => [] as Prozess[],
      ),
    ]).then(([kostenstellen, prozesse]) => {
      if (aktiv) setKatalog({ kostenstellen, prozesse });
    });
    return () => {
      aktiv = false;
    };
  }, []);

  const da = katalog ? reiterDa(katalog.kostenstellen.length, katalog.prozesse.length) : [];
  // Solange die Kataloge unterwegs sind, gilt der Reiter der Adresse; danach nur einer, den es gibt.
  const offen: MessstellenReiter = katalog === null || da.includes(reiter) ? reiter : 'liste';

  const waehleReiter = (r: MessstellenReiter) => {
    setReiter(r);
    replaceCurrentNavigation(reiterHash(r, wahl));
  };
  const waehleZeitraum = (periode: KostenstelleEnergiePeriode, am: string) => {
    setWahl({ periode, am });
    replaceCurrentNavigation(reiterHash(offen, { periode, am }));
  };

  const leiste = da.length > 0 ? <ReiterLeiste reiter={da} aktiv={offen} onWahl={waehleReiter} /> : null;
  if (offen === 'liste') return <RegisterFlaeche {...register} leiste={leiste} />;
  return (
    <div className="vp-ms" data-testid="messstellen-organisation">
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1>{TITEL}</h1>
        </div>
      </header>
      {leiste}
      {katalog === null ? (
        <p className="vp-ms-laedt" role="status">
          {LADEN}
        </p>
      ) : offen === 'kostenstellen' ? (
        <KostenstellenReiter katalog={katalog.kostenstellen} hervor={hervor} wahl={wahl} heute={heute} onWahl={waehleZeitraum} />
      ) : (
        <ProzesseReiter katalog={katalog.prozesse} wahl={wahl} heute={heute} onWahl={waehleZeitraum} />
      )}
    </div>
  );
}

/** Die Reiter der Welt — dieselbe Leiste wie die Bereichs-Reiter (`BereichTabs.css`); es gibt sie erst ab zwei. */
function ReiterLeiste({
  reiter,
  aktiv,
  onWahl,
}: {
  reiter: MessstellenReiter[];
  aktiv: MessstellenReiter;
  onWahl: (r: MessstellenReiter) => void;
}) {
  return (
    <div className="vp-bereich-tabs vp-ms-reiter" role="tablist" aria-label={REITER_LABEL}>
      {reiter.map((r) => {
        const ist = r === aktiv;
        return (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={ist}
            className={`vp-bereich-tab${ist ? ' active' : ''}`}
            onClick={() => onWahl(r)}
          >
            {REITER_WORT[r]}
            {ist && <span className="vp-tab-strich" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

interface RegisterProps {
  ebene: MessstellenEbene;
  /** Hat die Ebene den Bereich (ein Standort misst)? `null` = unbekannt. */
  bereichDa?: boolean | null;
  /** Zeitzone des Standorts; im Unternehmen die Vorgabe. */
  zone?: string;
  /** Der Weg aus dem Leerzustand „gibt es erst mit Messen & Auswerten“: die Übersicht der Ebene. */
  onUebersicht?: () => void;
  /** Öffnet die Messstellen-Seite (AP-04 IP-8) — der Name jeder Zeile ist der Einstieg. */
  onOeffnen?: (id: string) => void;
  /**
   * Öffnet die Seite im Abschnitt „Werte“ mit einer Periode (AP-13 IP-3, E9): am Rechner der letzte Wert und
   * das Zeilenmenü „Werte“, am Telefon die ganze Karte. Ohne Wirt gibt es keinen dieser Einstiege.
   */
  onWerte?: (id: string, periode: string) => void;
}

/** Die Beschriftung der Spalte mit dem Zeilenmenü — nur für Vorleser, die Spalte hat keinen sichtbaren Kopf. */
const AKTIONEN = 'Aktionen';

function RegisterFlaeche({
  ebene,
  bereichDa = null,
  zone = VORGABE_ZEITZONE,
  onUebersicht,
  onOeffnen,
  onWerte,
  leiste = null,
}: RegisterProps & { /** Die Reiter der Welt (AP-13 IP-9) — unter dem Kopf; ohne sie steht die Fläche wie zuvor. */ leiste?: ReactNode }) {
  const isPhone = useIsPhone();
  const [stichtag, setStichtag] = useState<string | null>(null);
  const [heute, setHeute] = useState<string | null>(null);
  const [filter, setFilter] = useState<RegisterFilter>(OHNE_FILTER);
  const [stand, setStand] = useState<{ schluessel: string; basis: MessstellenRegister; liste: MessstellenRegister } | null>(
    null,
  );
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [anlegen, setAnlegen] = useState(false);
  const angelegt = useRef(false);
  const anfrage = useRef(0);
  const basisMerker = useRef<{ tag: string; antwort: MessstellenRegister } | null>(null);

  const ebeneId = ebene.art === 'standort' ? ebene.id : null;
  const tagSchluessel = `${ebeneId ?? 'unternehmen'}|${stichtag ?? 'heute'}`;
  const schluessel = [tagSchluessel, filter.standort, filter.ort, filter.anlage, filter.zustand, filter.ohneQuelle].join('|');

  useEffect(() => {
    const hier: MessstellenEbene = ebeneId
      ? { art: 'standort', id: ebeneId, name: '' }
      : { art: 'unternehmen', name: '' };
    const nummer = ++anfrage.current;
    setFehler(false);
    const gemerkt = basisMerker.current?.tag === tagSchluessel ? basisMerker.current.antwort : null;
    const basis = gemerkt ? Promise.resolve(gemerkt) : api.messstellenRegister(registerAnfrage(hier, OHNE_FILTER, stichtag));
    const liste = filterAktiv(filter) ? api.messstellenRegister(registerAnfrage(hier, filter, stichtag)) : basis;
    Promise.all([basis, liste]).then(
      ([b, l]) => {
        // Eine überholte Antwort (Tag oder Filter gewechselt) zeigt nichts mehr.
        if (nummer !== anfrage.current) return;
        basisMerker.current = { tag: tagSchluessel, antwort: b };
        if (!stichtag) setHeute(b.stichtag);
        setStand({ schluessel, basis: b, liste: l });
      },
      () => {
        if (nummer === anfrage.current) setFehler(true);
      },
    );
  }, [ebeneId, stichtag, filter, tagSchluessel, schluessel, versuch]);

  // Jede Antwort gilt nur für ihren Tag und ihre Filter — bis die neue da ist, steht „… werden geladen“.
  const aktuell = stand?.schluessel === schluessel ? stand : null;
  const optionen = stand ? filterOptionen(stand.basis, ebene) : null;
  const leer = aktuell ? leerzustand({ antwort: aktuell.liste, basis: aktuell.basis, filter, ebene, bereichDa }) : null;
  const ohneRegister = leer?.art === 'bereich_fehlt' || leer?.art === 'keine_messstelle';
  // Anlegen gibt es heute (kein Stichtag) und nur mit „Messen & Auswerten“ — erst, wenn die Antwort da ist.
  const anlegbar = aktuell !== null && !stichtag && bereichDa !== false && leer?.art !== 'bereich_fehlt';
  const eintraege =
    aktuell && !leer ? registerEintraege(aktuell.liste, stichtag, { ebene, zone, zeitpunkt: aktuell.liste.zeitpunkt }) : [];
  const unterzeile = [ebene.art === 'standort' ? ebene.name : null, kopfZeile(aktuell?.liste ?? null, stichtag)]
    .filter(Boolean)
    .join(' · ');
  // Die Periode des Einstiegs in die Werte: mit Stichtag dieser Tag, heute der Vortag — der letzte ganze Tag, wie im Dialog.
  const wertePeriode = heute ? (stichtag && stichtag < heute ? stichtag : verschiebe(heute, -1)) : null;
  const werteOeffnen = onWerte && wertePeriode ? (id: string) => onWerte(id, wertePeriode) : undefined;

  return (
    <div className="vp-ms" data-testid="messstellen">
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1>{TITEL}</h1>
          {unterzeile && <p>{unterzeile}</p>}
        </div>
        {anlegbar && leer?.art !== 'keine_messstelle' && (
          <Button onClick={() => setAnlegen(true)}>{DIALOG_TITEL.anlegen}</Button>
        )}
      </header>
      {leiste}
      {fehler ? (
        <div className="vp-ms-leer" role="alert">
          <p>{LADEFEHLER}</p>
          <Button variant="outline" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT}
          </Button>
        </div>
      ) : (
        <>
          {heute && (stichtag || !ohneRegister) && <StandAm heute={heute} stichtag={stichtag} onStichtag={setStichtag} />}
          {optionen && (filterAktiv(filter) || !ohneRegister) && (
            <Filterleiste ebene={ebene} optionen={optionen} filter={filter} onFilter={setFilter} />
          )}
          {!aktuell ? (
            <p className="vp-ms-laedt" role="status">
              {LADEN}
            </p>
          ) : leer ? (
            <Leer leer={leer} onUebersicht={onUebersicht} onAnlegen={anlegbar ? () => setAnlegen(true) : undefined} />
          ) : isPhone ? (
            <Karten eintraege={eintraege} stichtag={stichtag} onOeffnen={onOeffnen} onWerte={werteOeffnen} />
          ) : (
            <Tabelle eintraege={eintraege} stichtag={stichtag} onOeffnen={onOeffnen} onWerte={werteOeffnen} />
          )}
        </>
      )}
      <MessstelleDialog
        open={anlegen}
        standortId={ebeneId}
        onClose={() => {
          setAnlegen(false);
          if (!angelegt.current) return;
          // Ein Schritt hat gespeichert: der gemerkte Stand des Tags ist überholt — neu lesen.
          angelegt.current = false;
          basisMerker.current = null;
          setVersuch((v) => v + 1);
        }}
        onGespeichert={() => {
          angelegt.current = true;
        }}
      />
    </div>
  );
}

function Filterleiste({
  ebene,
  optionen,
  filter,
  onFilter,
}: {
  ebene: MessstellenEbene;
  optionen: FilterOptionen;
  filter: RegisterFilter;
  onFilter: (f: RegisterFilter) => void;
}) {
  // Eine Liste mit einer einzigen Wahl ist keine Wahl — außer, sie ist gerade gesetzt.
  const feld = (label: string, wert: string | null, liste: FilterOption[], setze: (v: string | null) => void) =>
    liste.length >= 2 || wert !== null ? (
      <VpPicker
        className="vp-ms-feld"
        label={label}
        options={[{ value: '', label: FILTER.alle }, ...liste]}
        value={wert ?? ''}
        onChange={(v) => setze(v || null)}
      />
    ) : null;
  return (
    <div className="vp-ms-filter" role="group" aria-label="Filter">
      {ebene.art === 'unternehmen' &&
        feld(FILTER.standort, filter.standort, optionen.standorte, (standort) => onFilter({ ...filter, standort }))}
      {feld(FILTER.ort, filter.ort, optionen.orte, (ort) => onFilter({ ...filter, ort }))}
      {feld(FILTER.anlage, filter.anlage, optionen.anlagen, (anlage) => onFilter({ ...filter, anlage }))}
      {feld(FILTER.zustand, filter.zustand, optionen.zustaende, (zustand) =>
        onFilter({ ...filter, zustand: zustand as Lebenszyklus | null }),
      )}
      {optionen.gemessen > 0 && (
        <button
          type="button"
          className="vp-ms-schalter"
          aria-pressed={filter.ohneQuelle}
          onClick={() => onFilter({ ...filter, ohneQuelle: !filter.ohneQuelle })}
        >
          {FILTER.ohneQuelle} ({optionen.ohneQuelle})
        </button>
      )}
      {filterAktiv(filter) && (
        <Button variant="outline" onClick={() => onFilter(OHNE_FILTER)}>
          {FILTER.zuruecksetzen}
        </Button>
      )}
    </div>
  );
}

function Leer({
  leer,
  onUebersicht,
  onAnlegen,
}: {
  leer: Leerzustand;
  onUebersicht?: () => void;
  /** §5.11: „noch keine Messstelle“ trägt den Knopf „Messstelle anlegen“ — nur, wenn angelegt werden darf. */
  onAnlegen?: () => void;
}) {
  return (
    <div className="vp-ms-leer" role="status">
      <p>{leer.satz}</p>
      {leer.art === 'bereich_fehlt' && onUebersicht && (
        <Button variant="outline" onClick={onUebersicht}>
          {ZUR_UEBERSICHT}
        </Button>
      )}
      {leer.art === 'keine_messstelle' && onAnlegen && <Button onClick={onAnlegen}>{DIALOG_TITEL.anlegen}</Button>}
    </div>
  );
}

interface RegisterListeProps {
  eintraege: RegisterEintrag[];
  stichtag: string | null;
  onOeffnen?: (id: string) => void;
  /** Öffnet die Seite im Abschnitt „Werte“ (AP-13 IP-3) — die Periode hat der Wirt schon gewählt. */
  onWerte?: (id: string) => void;
}

/** Der Name öffnet die Messstellen-Seite (AP-04 IP-8); ohne Wirt bleibt er Text. */
function Name({ w, onOeffnen }: { w: ZeileWoerter; onOeffnen?: (id: string) => void }) {
  if (!onOeffnen) return <>{w.name}</>;
  return (
    <button type="button" className="vp-ms-oeffnen" onClick={() => onOeffnen(w.id)}>
      {w.name}
    </button>
  );
}

function spalten(stichtag: string | null): string[] {
  return [
    SPALTEN.kennzeichen,
    SPALTEN.name,
    SPALTEN.ort,
    SPALTEN.stellung,
    SPALTEN.quelle,
    stichtag ? ZUSTAND_HEUTE : SPALTEN.zustand,
    SPALTEN.wert,
  ];
}

/** 1440 px: eine Zeile je Messstelle; die Tabelle scrollt lokal, nie die Seite. */
function Tabelle({ eintraege, stichtag, onOeffnen, onWerte }: RegisterListeProps) {
  return (
    <div className="vp-ms-rahmen">
      <table className="vp-ms-tabelle">
        <thead>
          <tr>
            {spalten(stichtag).map((t) => (
              <th key={t} scope="col">
                {t}
              </th>
            ))}
            {onWerte && (
              <th scope="col">
                <span className="vp-sr-only">{AKTIONEN}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {eintraege.map((e) =>
            e.art === 'gab_es_noch_nicht' ? (
              <tr key={e.id} className="vp-ms-still">
                <td>
                  <span className="vp-ms-kz">{e.kennzeichen}</span>
                </td>
                <td className="vp-ms-name">{e.name}</td>
                <td colSpan={onWerte ? 6 : 5} className="vp-ms-satz">
                  {e.satz}
                </td>
              </tr>
            ) : (
              <tr key={e.woerter.id}>
                <td>
                  <span className="vp-ms-kz">{e.woerter.kennzeichen}</span>
                </td>
                <td className="vp-ms-name">
                  <Name w={e.woerter} onOeffnen={onOeffnen} />
                </td>
                <td>
                  <Ort w={e.woerter} />
                </td>
                <td>{e.woerter.stellung ?? OHNE_ANGABE}</td>
                <td>
                  <Quelle w={e.woerter} />
                </td>
                <td>
                  <Zustand w={e.woerter} />
                </td>
                <td className="vp-ms-wertzelle">
                  <Wert w={e.woerter} onWerte={onWerte && (() => onWerte(e.woerter.id))} />
                </td>
                {onWerte && (
                  <td className="vp-ms-menue">
                    <RowMenu items={[{ label: UEMS_WERTE, icon: 'calendar', onClick: () => onWerte(e.woerter.id) }]} />
                  </td>
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 375 px: eine Karte je Messstelle mit denselben Wörtern wie die Spalten. */
function Karten({ eintraege, stichtag, onOeffnen, onWerte }: RegisterListeProps) {
  const [, , ort, stellung, quelle, zustand, wert] = spalten(stichtag);
  return (
    <ul className="vp-ms-karten">
      {eintraege.map((e) =>
        e.art === 'gab_es_noch_nicht' ? (
          <li key={e.id} className="vp-ms-karte vp-ms-still">
            <div className="vp-ms-karte-kopf">
              <span className="vp-ms-kz">{e.kennzeichen}</span>
              <h2 className="vp-ms-karte-name">{e.name}</h2>
            </div>
            <p className="vp-ms-satz">{e.satz}</p>
          </li>
        ) : (
          <li key={e.woerter.id} className={onWerte ? 'vp-ms-karte is-werte' : 'vp-ms-karte'}>
            <div className="vp-ms-karte-kopf">
              <span className="vp-ms-kz">{e.woerter.kennzeichen}</span>
              <h2 className="vp-ms-karte-name">
                {onWerte ? (
                  // Am Telefon ist die ganze Karte der Einstieg in die Werte (AP-13 IP-3): der Knopf deckt sie ab.
                  <button type="button" className="vp-ms-oeffnen vp-ms-karte-werte" onClick={() => onWerte(e.woerter.id)}>
                    {e.woerter.name}
                  </button>
                ) : (
                  <Name w={e.woerter} onOeffnen={onOeffnen} />
                )}
              </h2>
            </div>
            <dl className="vp-ms-fakten">
              <dt>{zustand}</dt>
              <dd>
                <Zustand w={e.woerter} />
              </dd>
              <dt>{wert}</dt>
              <dd>
                <Wert w={e.woerter} />
              </dd>
              <dt>{quelle}</dt>
              <dd>
                <Quelle w={e.woerter} />
              </dd>
              <dt>{ort}</dt>
              <dd>
                <Ort w={e.woerter} />
              </dd>
              <dt>{stellung}</dt>
              <dd>{e.woerter.stellung ?? OHNE_ANGABE}</dd>
            </dl>
          </li>
        ),
      )}
    </ul>
  );
}

function Ort({ w }: { w: ZeileWoerter }) {
  return (
    <>
      <span className="vp-ms-block">{w.ort.text}</span>
      {w.ort.standort && <span className="vp-ms-neben">{w.ort.standort}</span>}
    </>
  );
}

function Quelle({ w }: { w: ZeileWoerter }) {
  const q = w.quelle;
  if (q.art !== 'gebunden') return <span className="vp-ms-block vp-ms-ohne">{q.text}</span>;
  return (
    <>
      <span className="vp-ms-block">{q.geraet}</span>
      <span className="vp-ms-neben">{q.messwert}</span>
      <span className="vp-ms-neben">{[q.seit, q.davor, q.vergleich].filter(Boolean).join(' · ')}</span>
    </>
  );
}

function Zustand({ w }: { w: ZeileWoerter }) {
  return (
    <>
      <span className="vp-ms-block">{w.zustand}</span>
      {w.beobachtung && (
        <span className={`vp-ms-beob is-${w.beobachtung.ton}`}>
          <span className="vp-ms-punkt" aria-hidden="true" />
          {w.beobachtung.text}
        </span>
      )}
    </>
  );
}

/** Der letzte Wert; mit Wirt führt er in den Abschnitt „Werte“ der Seite (AP-13 IP-3). */
function Wert({ w, onWerte }: { w: ZeileWoerter; onWerte?: () => void }) {
  if (!w.wert && w.nebenwerte.length === 0) return <>{OHNE_ANGABE}</>;
  const inhalt = (
    <>
      {w.wert && (
        <span className="vp-ms-block">
          <span className="vp-ms-zahl">{w.wert.text}</span> <span className="vp-ms-zeit">{w.wert.zeit}</span>
        </span>
      )}
      {w.nebenwerte.map((n) => (
        <span key={n.groesse} className="vp-ms-block">
          <span className="vp-ms-groesse">{n.groesse}</span> <span className="vp-ms-zahl">{n.text}</span>{' '}
          <span className="vp-ms-zeit">{n.zeit}</span>
        </span>
      ))}
    </>
  );
  if (!onWerte) return inhalt;
  return (
    <button type="button" className="vp-ms-werte" onClick={onWerte}>
      <span className="vp-sr-only">{`${UEMS_WERTE} ${w.kennzeichen}: `}</span>
      {inhalt}
    </button>
  );
}
