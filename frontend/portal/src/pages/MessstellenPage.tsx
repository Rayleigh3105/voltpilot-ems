import { KorrekturenDialog } from '../components/KorrekturenDialog';
import { useReiterRand } from '../reiterRand';
import { MESSEN_EINRICHTEN } from '../messenEinstieg';
import { Recht } from '../components/Recht';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { zeitraumAus } from '../anlageEnergiebilanz';
import { api, type KostenstelleEnergiePeriode, type MessstellenRegister, type StandortAusfall } from '../api';
import '../components/BereichTabs.css';
import '../components/kacheln/Kacheln.css';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import { MessstelleDialog } from '../components/MessstelleDialog';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { VpDatePicker } from '../components/VpDatePicker';
import { heuteIn } from '../kennzahlKarte';
import { REITER_LABEL, REITER_WORT, hervorAus, reiterAus, reiterHash, type MessstellenReiter } from '../kostenstellenUebersicht';
import { flaecheMelden, organisationReiter, useOrganisation } from '../messstellenOrganisation';
import {
  ERNEUT,
  LADEN,
  OHNE_ANGABE,
  OHNE_FILTER,
  TITEL,
  ZUR_UEBERSICHT,
  anlageAus,
  leerzustand,
  ortAus,
  ortSchluessel,
  registerAnfrage,
  registerEintraege,
  type Leerzustand,
  type MessstellenEbene,
  type RegisterFilter,
} from '../messstellen';
import {
  ARCHIVIERT,
  AUCH_IN_ALLEN,
  KOPF_SATZ,
  KORREKTUREN_AM_STANDORT,
  MARKEN_LABEL,
  MESSSTELLE_ANLEGEN,
  SPALTE,
  STAND_AN_EINEM_TAG,
  STAND_AN_EINEM_TAG_HINWEIS,
  SUCHE_LABEL,
  SUCHE_LEEREN,
  SUCHE_PLATZHALTER,
  SUCHE_WORIN,
  WEITERE_AKTIONEN,
  gruppenZahl,
  keineTreffer,
  liste as listeAus,
  marken as markenAus,
  markiert,
  messstelleBeispiel,
  markeAus,
  mitParameter,
  mitSuche,
  monatLang,
  ohneParameter,
  status as statusAus,
  suchTerme,
  standAus,
  sucheAus,
  trefferSatz,
  type Hinweis,
  type Liste,
  type Marke,
  type MarkeSchluessel,
  type OrtGruppe,
  type Reihe,
} from '../messstellenListe';
import { listeZurueck, merkeListe } from '../messstellenRueckweg';
import { DIALOG_TITEL } from '../messstelleDialog';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { springeUeberHash } from '../entscheid';
import { parseRoute } from '../nav';
import { ZURUECK_ZU_HEUTE, stichtagAus } from '../standAm';
import { VORGABE_ZEITZONE, datumText } from '../uemsOrtsbaum';
import { useIsPhone } from '../useIsPhone';
import { KostenstellenReiter, ProzesseReiter } from './KostenstellenSection';
import { MessstelleSeite } from './MessstelleSeite';
import './MessstellenPage.css';
import { ausfaelleJeMessstelle } from '../ausfallAnzeige';
import type { TextTeil } from '../picker/suche';

/**
 * „Unternehmen › Messstellen“ und „Standort › Messstellen“ (UEMS AP-04 IP-5; Konzept Messen m1, §6.2/§6.3,
 * Captain-Freigabe 05.10.2026): alle Zähler nach Ort, je mit Zustand und Wert - und in Sekunden gefunden.
 *
 * Oben der Kopf mit dem Satz, der das Wort erklärt, und dem Menü ⋯ für Seltenes („Stand an einem Tag ansehen“, am
 * Standort die Korrekturen; am Telefon auch „Messstelle anlegen“, am Rechner ein Knopf). Darunter die Statuszeile mit
 * dem Satz des Servers (bei Handlungsbedarf Hinweiskarten), die EINE Suche, die Marken (nur, was es gibt; sie
 * filtern) und je Ort eine Karte mit Reihen: was es ist, ob es aktuell ist, woher die Werte kommen, der Wert. „Summenwert
 * anlegen“ gibt es hier nicht mehr: ein Summenwert entsteht an der Anlage, an der seine Messwerte liegen (Konzept §6.10).
 *
 * Die Fläche liest EINE Abfrage (`GET /api/v1/messstellen`, IP-4/IP-15); Suche und Marken filtern die geladene Antwort
 * (`messstellenListe.ts`), die Filter der Adresse (`?ort=`, `?anlage=`) gehen als Parameter an dieselbe Route. Die Suche
 * steht in der Adresse (`?suche=`) und bleibt beim Zurückkommen von einer Messstelle stehen.
 *
 * ⚠ Mit Stichtag gibt es keinen Schreibweg: „Messstelle anlegen“ verschwindet, die Hinweiskarte nennt keinen Schritt.
 * ⚠ Die Marke des Schritts „Ablesungen eintragen“ der Wiedervorlage (`data-entscheid="zaehlerablesung"`) trägt jede
 * Reihe, deren Ablesung fehlt - die Wiedervorlage öffnet die gefilterte Liste eines Orts (`?ort=G-1`).
 */
export function MessstellenPage({
  messstelleId = null,
  werte = null,
  onOeffnen,
  onWerteZeitraum,
  onWerteVergleich,
  onWerteHeute,
  onListe,
  organisation = false,
  reiterOben = false,
  ...register
}: RegisterProps & {
  /** Die Messstelle der Adresse (AP-04 IP-8) - dann steht ihre Seite statt des Registers. */
  messstelleId?: string | null;
  /** Periode und Version der Adresse für den Abschnitt „Werte“ der Seite (AP-13 IP-3). */
  werte?: { periode: string | null; version: number | null; vergleich: string | null; stand?: string | null } | null;
  /** Die neu gewählte Periode im Abschnitt „Werte“ - der Wirt schreibt die Adresse nach. */
  onWerteZeitraum?: (periode: string) => void;
  /** AP-13 IP-5: eine neue Wahl des Vergleichs-Umschalters (`v=` der Adresse). */
  onWerteVergleich?: (v: string | null) => void;
  /** „Zurück zu heute“ einer aus „Stand am …“ geöffneten Messstelle - der Wirt öffnet sie ohne Tag (Review r4 S4). */
  onWerteHeute?: () => void;
  /** Der Weg zurück ins Register der Ebene. */
  onListe?: () => void;
  /**
   * AP-13 IP-9 (E8 = A): die Reiter „Kostenstellen“ und „Prozesse“ - nur in der Welt Messstellen am Unternehmen (der Wirt
   * entscheidet), und erst, wenn es eine Kostenstelle oder einen Prozess gibt. Ohne diese Angabe fragt die Fläche die
   * Kataloge gar nicht.
   */
  organisation?: boolean;
  /**
   * N5 (Konzept „Navigation aus einem Guss“): stehen „Kostenstellen“ und „Prozesse“ in der Reihe der Gruppe „Messen“
   * über der Seite, zeigt die Fläche ihre eigene Reihe nicht - es gibt höchstens eine.
   */
  reiterOben?: boolean;
}) {
  if (messstelleId && onListe) {
    // „‹ Alle Messstellen“ führt in dieselbe Trefferliste zurück (Suche und Filter der Adresse), aus der sie geöffnet
    // wurde (Konzept §6.3); ohne gemerkte Liste in die Liste der Ebene.
    const zurueck = () => {
      const pfad = window.location.hash.split('?')[0].replace(/\/[^/]+$/, '');
      const hash = listeZurueck(pfad);
      if (hash) springeUeberHash({ route: parseRoute(hash), hash });
      else onListe();
    };
    return (
      <MessstelleSeite
        key={messstelleId}
        id={messstelleId}
        zone={register.zone}
        werte={werte}
        onWerteZeitraum={onWerteZeitraum}
        onWerteVergleich={onWerteVergleich}
        onListe={zurueck}
        onHeute={onWerteHeute}
      />
    );
  }
  if (organisation) return <MessstellenWelt {...register} onOeffnen={onOeffnen} reiterOben={reiterOben} />;
  return <RegisterFlaeche {...register} onOeffnen={onOeffnen} />;
}

/**
 * Die Welt Messstellen am Unternehmen mit ihren Reitern Liste · Kostenstellen · Prozesse (AP-13 IP-9). Reiter und
 * Zeitraum stehen in der Adresse (`#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01`) und werden
 * ersetzt, nicht gestapelt - wie die Zeit-Leiste der Energiebilanz. Ohne Kostenstelle und ohne Prozess ist die Fläche das
 * Register von heute, ohne Leiste.
 */
function MessstellenWelt({ reiterOben = false, ...register }: RegisterProps & { reiterOben?: boolean }) {
  // Die Kataloge teilt die Fläche mit der Reihe der Gruppe „Messen“ (N5); beim Öffnen fragt sie sie neu.
  const katalog = useOrganisation(true, true);
  const [reiter, setReiter] = useState<MessstellenReiter>(() => reiterAus(window.location.hash));
  const [heute] = useState(() => heuteIn(VORGABE_ZEITZONE, Date.now()));
  const [wahl, setWahl] = useState(() => zeitraumAus(window.location.hash, heute));
  const [hervor] = useState(() => hervorAus(window.location.hash));

  // Ändert sich die Adresse von außen (Zurück, ein Verweis), folgt die Fläche ihr; die Reihe von „Messen“ wählt über
  // `flaecheMelden` wie früher die eigene Reihe.
  useEffect(() => {
    const folgen = () => {
      setReiter(reiterAus(window.location.hash));
      setWahl(zeitraumAus(window.location.hash, heute));
    };
    window.addEventListener('hashchange', folgen);
    return () => window.removeEventListener('hashchange', folgen);
  }, [heute]);

  const da = organisationReiter(katalog) ?? [];
  // Solange die Kataloge unterwegs sind, gilt der Reiter der Adresse; danach nur einer, den es gibt.
  const offen: MessstellenReiter = katalog === null || da.includes(reiter) ? reiter : 'liste';

  const waehleReiter = useCallback(
    (r: MessstellenReiter) => {
      setReiter(r);
      replaceCurrentNavigation(reiterHash(r, wahl));
    },
    [wahl],
  );
  // N5: die Reihe von „Messen“ zeigt den offenen Reiter der Fläche und wählt über sie - mit ihrem Zeitraum.
  useEffect(() => flaecheMelden({ offen, waehlen: waehleReiter }), [offen, waehleReiter]);
  const waehleZeitraum = (periode: KostenstelleEnergiePeriode, am: string) => {
    setWahl({ periode, am });
    replaceCurrentNavigation(reiterHash(offen, { periode, am }));
  };

  const leiste = da.length > 0 && !reiterOben ? <ReiterLeiste reiter={da} aktiv={offen} onWahl={waehleReiter} /> : null;
  if (offen === 'liste') return <RegisterFlaeche {...register} leiste={leiste} />;
  return (
    <div className="vp-ms" data-testid="messstellen-organisation">
      {leiste}
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1>{TITEL}</h1>
        </div>
      </header>
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

/** Die Reiter der Welt - dieselbe Leiste wie die Bereichs-Reiter (`BereichTabs.css`); es gibt sie erst ab zwei. */
function ReiterLeiste({
  reiter,
  aktiv,
  onWahl,
}: {
  reiter: MessstellenReiter[];
  aktiv: MessstellenReiter;
  onWahl: (r: MessstellenReiter) => void;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  return (
    <div ref={reiterRand} className="vp-bereich-tabs vp-ms-reiter" role="tablist" aria-label={REITER_LABEL}>
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
  /** AP-01 E5 = A: der Leerzustand führt in den Assistenten „Messen & Auswerten“ (nur mit Recht). */
  onMessenEinrichten?: () => void;
  /**
   * Öffnet die Messstellen-Seite (AP-04 IP-8) - jede Reihe ist der Einstieg. Mit „Stand am …“ öffnet sie die Werte an
   * genau diesem Tag (`periode`, AP-13 IP-3); sonst `null`, und die Seite wählt selbst.
   */
  onOeffnen?: (id: string, periode: string | null) => void;
}

/** Ein Wechsel der Adresse ohne Verlaufseintrag; nur, wenn sie sich ändert. */
/** Die Marke des Filters `?anlage=` einer Anlage, deren Namen die Liste nicht erfährt - nie die Kennung (D5). */
const GEWAEHLTE_ANLAGE = 'Gewählte Anlage';

function ersetzeAdresse(hash: string) {
  if (hash !== window.location.hash) replaceCurrentNavigation(hash);
}

function RegisterFlaeche({
  ebene,
  bereichDa = null,
  zone = VORGABE_ZEITZONE,
  onUebersicht,
  onMessenEinrichten,
  onOeffnen,
  leiste = null,
}: RegisterProps & { /** Die Reiter der Welt (AP-13 IP-9) - unter dem Kopf; ohne sie steht die Fläche wie zuvor. */ leiste?: ReactNode }) {
  const isPhone = useIsPhone();
  // Stichtag, Suche und Marke stehen in der Adresse: der Rückweg von einer Messstelle findet die Liste, wie sie war.
  const [stichtag, setStichtag] = useState<string | null>(() => standAus(window.location.hash));
  // Mit einem Stichtag aus der Adresse kennt die erste Antwort heute nicht - bis „Zurück zu heute“ gilt der Tag der Zone.
  const [heute, setHeute] = useState<string | null>(() => (stichtag ? heuteIn(zone, Date.now()) : null));
  const [standWahl, setStandWahl] = useState(false);
  // AP-13 IP-10/IP-11: die Adresse bringt den Filter mit - `?ort=` aus der Gebäude-Karte und der Wiedervorlage,
  // `?anlage=` aus dem EINEN Weg des Anlagen-Cockpits (O18). Beide sind Lesezeichen-fähig und Marken mit „×“.
  const [filter, setFilter] = useState<RegisterFilter>(() => ({
    ...OHNE_FILTER,
    ort: ortAus(window.location.hash),
    anlage: anlageAus(window.location.hash),
  }));
  const [suche, setSuche] = useState(() => sucheAus(window.location.hash));
  const [marke, setMarke] = useState<MarkeSchluessel | null>(() => markeAus(window.location.hash));
  const ortAufgeloest = useRef(false);
  const [stand, setStand] = useState<{ schluessel: string; basis: MessstellenRegister; liste: MessstellenRegister } | null>(
    null,
  );
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [ausfaelle, setAusfaelle] = useState<StandortAusfall[]>([]);
  const [anlegen, setAnlegen] = useState(false);
  const [korrekturen, setKorrekturen] = useState(false);
  const menueAusloeser = useRef<HTMLElement | null>(null);
  const angelegt = useRef(false);
  const anfrage = useRef(0);
  const basisMerker = useRef<{ tag: string; antwort: MessstellenRegister } | null>(null);

  const ebeneId = ebene.art === 'standort' ? ebene.id : null;
  const tagSchluessel = `${ebeneId ?? 'unternehmen'}|${stichtag ?? 'heute'}`;
  const schluessel = [tagSchluessel, filter.ort, filter.anlage].join('|');

  useEffect(() => {
    const hier: MessstellenEbene = ebeneId
      ? { art: 'standort', id: ebeneId, name: '' }
      : { art: 'unternehmen', name: '' };
    const nummer = ++anfrage.current;
    setFehler(false);
    const gemerkt = basisMerker.current?.tag === tagSchluessel ? basisMerker.current.antwort : null;
    // Messen PR5 (Entscheid 2 = A): die Reihen zeigen den Verbrauch des letzten vollständigen Monats - das Register
    // trägt ihn nur auf Verlangen (`letzterMonat`), so lesen nur die Flächen, die ihn zeigen.
    const basis = gemerkt
      ? Promise.resolve(gemerkt)
      : api.messstellenRegister({ ...registerAnfrage(hier, OHNE_FILTER, stichtag), letzterMonat: true });
    const gefiltert = filter.ort !== null || filter.anlage !== null;
    const liste = gefiltert ? api.messstellenRegister({ ...registerAnfrage(hier, filter, stichtag), letzterMonat: true }) : basis;
    Promise.all([basis, liste]).then(
      ([b, l]) => {
        // Eine überholte Antwort (Tag oder Filter gewechselt) zeigt nichts mehr.
        if (nummer !== anfrage.current) return;
        basisMerker.current = { tag: tagSchluessel, antwort: b };
        if (!stichtag) setHeute(b.stichtag);
        // Einmal: das Kurzzeichen der Adresse wird zum Schlüssel der Route (die ID des Orts). Die Antwort gilt dann
        // gleich unter dem neuen Schlüssel - die Reihen bleiben stehen, statt für dieselben Daten noch einmal als
        // Skelett zu blinken (und den Blick der Wiedervorlage auf der ersten Reihe zu verlieren).
        if (!ortAufgeloest.current && filter.ort) {
          ortAufgeloest.current = true;
          const schluesselOrt = ortSchluessel(b, filter.ort);
          if (schluesselOrt !== filter.ort) {
            setFilter((f) => ({ ...f, ort: schluesselOrt }));
            setStand({ schluessel: [tagSchluessel, schluesselOrt, filter.anlage].join('|'), basis: b, liste: l });
            return;
          }
        }
        setStand({ schluessel, basis: b, liste: l });
      },
      () => {
        if (nummer === anfrage.current) setFehler(true);
      },
    );
  }, [ebeneId, stichtag, filter, tagSchluessel, schluessel, versuch]);

  // Die Liste merkt sich ihre Adresse (Suche, Filter, Marke, Stichtag) - der Rückweg einer Messstelle führt genau
  // hierher zurück.
  useEffect(() => {
    merkeListe(window.location.hash);
  }, [suche, filter, marke, stichtag]);

  // Jede Antwort gilt nur für ihren Tag und ihre Filter - bis die neue da ist, stehen Skelette.
  const aktuell = stand?.schluessel === schluessel ? stand : null;
  const leer = aktuell ? leerzustand({ antwort: aktuell.liste, basis: aktuell.basis, filter, ebene, bereichDa }) : null;
  const ohneRegister = leer?.art === 'bereich_fehlt' || leer?.art === 'keine_messstelle';
  // Anlegen gibt es heute (kein Stichtag) und nur mit „Messen & Auswerten“ - erst, wenn die Antwort da ist.
  const anlegbar = aktuell !== null && !stichtag && bereichDa !== false && leer?.art !== 'bereich_fehlt';
  useEffect(() => {
    if (stichtag || !aktuell) {
      setAusfaelle([]);
      return;
    }
    const ids = [...new Set(aktuell.liste.register.map((z) => z.ort.standort_id).filter((id): id is string => Boolean(id)))];
    let aktiv = true;
    Promise.all(ids.map((id) => api.standortAusfall(id).catch(() => null))).then((antworten) => {
      if (aktiv) setAusfaelle(antworten.filter((a): a is StandortAusfall => a !== null));
    });
    return () => {
      aktiv = false;
    };
  }, [aktuell, stichtag]);
  const ausfallKarte = ausfaelleJeMessstelle(ausfaelle);
  const [anlageNachgefragt, setAnlageNachgefragt] = useState<{ id: string; name: string | null } | null>(null);
  const anlageFehlt =
    filter.anlage !== null && aktuell !== null && !aktuell.basis.register.some((z) => z.elektrische_stellung?.anlage === filter.anlage);
  useEffect(() => {
    const id = filter.anlage;
    if (!anlageFehlt || id === null) return;
    let aktiv = true;
    api.listSites().then(
      (antwort) => {
        if (aktiv) setAnlageNachgefragt({ id, name: antwort.eintraege.find((x) => x.id === id)?.name ?? null });
      },
      () => {
        if (aktiv) setAnlageNachgefragt({ id, name: null });
      },
    );
    return () => {
      aktiv = false;
    };
  }, [anlageFehlt, filter.anlage]);
  const eintraege =
    aktuell && !leer
      ? registerEintraege(aktuell.liste, stichtag, { ebene, zone, zeitpunkt: aktuell.liste.zeitpunkt, ausfaelle: ausfallKarte })
      : [];
  const listeMit = (k: MarkeSchluessel | null): Liste | null =>
    aktuell && !leer ? listeAus(eintraege, { ebene, zone, zeitpunkt: aktuell.liste.zeitpunkt, suche, marke: k }) : null;
  const l = listeMit(null);
  const m = l ? markenAus(l.reihen) : [];
  // Eine Marke, die es (am neuen Tag) nicht mehr gibt, filtert nicht still weiter.
  const markeDa = marke !== null && m.some((x) => x.schluessel === marke) ? marke : null;
  const sichtbar = markeDa ? listeMit(markeDa) : l;
  const st = aktuell && l ? statusAus(aktuell.liste, l.reihen, { ebene, zone, stichtag }) : null;
  // Am Rechner steht über den Werten der Monat der Reihen; ohne Monat (eine ältere Antwort) der letzte Stand.
  const reihenMonat = aktuell?.liste.register.find((z) => z.letzter_monat)?.letzter_monat?.monat ?? null;
  const wertKopf = reihenMonat ? monatLang(reihenMonat) : SPALTE.stand;

  const neueSuche = (wert: string) => {
    setSuche(wert);
    ersetzeAdresse(mitSuche(window.location.hash, wert));
  };
  const ohneAdressFilter = (name: 'ort' | 'anlage') => {
    setFilter((f) => ({ ...f, [name]: null }));
    ersetzeAdresse(ohneParameter(window.location.hash, name));
  };
  const waehleMarke = (k: MarkeSchluessel | null) => {
    setMarke(k);
    ersetzeAdresse(mitParameter(window.location.hash, 'marke', k));
  };
  const allesZeigen = () => {
    waehleMarke(null);
    if (filter.ort) ohneAdressFilter('ort');
    if (filter.anlage) ohneAdressFilter('anlage');
  };
  const neuerTag = (wahl: string | null) => {
    setStandWahl(false);
    setStichtag(wahl);
    ersetzeAdresse(mitParameter(window.location.hash, 'stand', wahl));
  };

  const menue: RowMenuItem[] = [];
  if (anlegbar && isPhone && leer?.art !== 'keine_messstelle') {
    menue.push({ label: MESSSTELLE_ANLEGEN, icon: 'plus', recht: 'messstelle.bearbeiten', onClick: () => setAnlegen(true) });
  }
  if (heute && !ohneRegister) {
    menue.push({ label: STAND_AN_EINEM_TAG, hinweis: STAND_AN_EINEM_TAG_HINWEIS, icon: 'calendar', onClick: () => setStandWahl(true) });
  }
  if (aktuell && !ohneRegister && ebene.art === 'standort' && bereichDa !== false) {
    menue.push({ label: KORREKTUREN_AM_STANDORT, icon: 'history', onClick: () => setKorrekturen(true) });
  }

  const ortName = (id: string | null) =>
    id ? (aktuell?.basis.register.find((z) => z.ort.id === id || z.ort.kennzeichen === id)?.ort.name ?? id) : null;
  // D5: nie eine Kennung - kennt das Register die Anlage nicht (keine Messstelle hängt an ihr), fragt die Liste ihren
  // Namen einmal nach; bis dahin und ohne Antwort heißt sie „diese Anlage“.
  const anlageImRegister = filter.anlage
    ? (aktuell?.basis.register.find((z) => z.elektrische_stellung?.anlage === filter.anlage)?.elektrische_stellung?.anlage_name ?? null)
    : null;
  const anlageName = anlageImRegister ?? (anlageNachgefragt?.id === filter.anlage ? anlageNachgefragt.name : null);
  const gefiltert = suchTerme(suche).length > 0 || markeDa !== null;

  return (
    <div className="vp-ms" data-testid="messstellen">
      {leiste}
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1>{TITEL}</h1>
          <p className="vp-ms-meta">{ebene.art === 'standort' ? `${ebene.name} · ${KOPF_SATZ}` : KOPF_SATZ}</p>
        </div>
        {((anlegbar && !isPhone && leer?.art !== 'keine_messstelle') || menue.length > 0) && (
          <span className="vp-ms-aktionen">
            {anlegbar && !isPhone && leer?.art !== 'keine_messstelle' && (
              <Recht aktion="messstelle.bearbeiten">
                <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={15} />} onClick={() => setAnlegen(true)}>
                  {MESSSTELLE_ANLEGEN}
                </Button>
              </Recht>
            )}
            {menue.length > 0 && (
              <span
                className="vp-ms-menue"
                data-testid="messstellen-menue"
                onClickCapture={(e) => {
                  // Der Auslöser ⋯ selbst - nicht der Eintrag, der mit dem Menü verschwindet (sonst landet der Fokus nach
                  // dem Dialog auf `body`).
                  menueAusloeser.current = e.currentTarget.querySelector<HTMLElement>('[aria-haspopup="menu"]');
                }}
              >
                <RowMenu label={WEITERE_AKTIONEN} buttonClassName="vp-ms-menue-knopf" items={menue} />
              </span>
            )}
          </span>
        )}
      </header>
      {heute && (stichtag || standWahl) && (
        <StandAmLeiste
          heute={heute}
          stichtag={stichtag}
          offen={standWahl}
          onOeffnen={() => setStandWahl(true)}
          onWahl={(wahl) => neuerTag(stichtagAus(wahl, heute))}
          onZurueck={() => neuerTag(null)}
          onAbbrechen={() => setStandWahl(false)}
        />
      )}
      {!ohneRegister && !fehler && (
        // Am Rechner stehen Statuszeile und „Was ist eine Messstelle?“ in einer Zeile (Konzept, Desktop); am Telefon
        // erst der Verweis, dann die Statuszeile.
        <div className={`vp-ms-lage${st && st.hinweise.length > 0 ? ' has-hinweise' : ''}`}>
          <BegriffAufklapper begriff="messstelle" beispiel={l ? <Beispiel reihen={l.reihen} /> : undefined} />
          {st && <Statuszeile status={st} onMarke={(k) => waehleMarke(markeDa === k ? null : k)} />}
        </div>
      )}
      {fehler ? (
        <section className="vp-ms-karte is-fehler" role="alert" data-testid="messstellen-fehler">
          <h2>Messstellen nicht geladen</h2>
          <p className="vp-ms-leise">Die Messstellen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.</p>
          <button type="button" className="vp-ms-link" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT}
          </button>
        </section>
      ) : !aktuell ? (
        <div className="vp-ms-skelett" aria-busy="true" aria-label={LADEN} data-testid="messstellen-laedt">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-suche" />
          <span className="vp-skeleton is-karte" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : leer ? (
        <Leer
          leer={leer}
          ebene={ebene}
          onUebersicht={onUebersicht}
          onMessenEinrichten={onMessenEinrichten}
          onAnlegen={anlegbar ? () => setAnlegen(true) : undefined}
          onAllesZeigen={allesZeigen}
          filterSatz={
            filter.ort
              ? `In ${ortName(filter.ort)} steht keine Messstelle.`
              : filter.anlage
                ? anlageName
                  ? `An der Anlage ${anlageName} hängt keine Messstelle.`
                  : 'An dieser Anlage hängt keine Messstelle.'
                : null
          }
        />
      ) : (
        l &&
        sichtbar && (
          <>
            <Suchzeile
              suche={suche}
              onSuche={neueSuche}
              treffer={trefferSatz(sichtbar, gefiltert)}
              gefiltert={suchTerme(suche).length > 0}
            />
            <MarkenLeiste
              marken={m}
              aktiv={markeDa}
              onMarke={(k) => waehleMarke(markeDa === k ? null : k)}
              ort={filter.ort ? ortName(filter.ort) : null}
              anlage={filter.anlage ? (anlageName ? `Anlage ${anlageName}` : GEWAEHLTE_ANLAGE) : null}
              onOhne={ohneAdressFilter}
            />
            {sichtbar.treffer === 0 && sichtbar.archiviert.length === 0 ? (
              <KeinTreffer
                suche={suche}
                weitere={markeDa !== null || filter.ort !== null || filter.anlage !== null}
                onLeeren={() => neueSuche('')}
                onAlle={allesZeigen}
              />
            ) : (
              <>
                {sichtbar.gruppen.map((g) => (
                  <OrtKarte
                    key={g.key}
                    gruppe={g}
                    gefiltert={gefiltert}
                    suche={suche}
                    periode={stichtag}
                    wertKopf={wertKopf}
                    onOeffnen={onOeffnen}
                  />
                ))}
                {sichtbar.archiviert.length > 0 && (
                  <ArchivKarte reihen={sichtbar.archiviert} suche={suche} periode={stichtag} onOeffnen={onOeffnen} />
                )}
              </>
            )}
            {sichtbar.nochNicht.length > 0 && stichtag && <NochNicht eintraege={sichtbar.nochNicht} stichtag={stichtag} />}
          </>
        )
      )}
      {korrekturen && ebene.art === 'standort' && (
        <KorrekturenDialog
          standort={ebene.id}
          zone={zone}
          onClose={() => {
            setKorrekturen(false);
            requestAnimationFrame(() => menueAusloeser.current?.focus());
          }}
        />
      )}
      <MessstelleDialog
        open={anlegen}
        standortId={ebeneId}
        onClose={() => {
          setAnlegen(false);
          if (!angelegt.current) return;
          // Ein Schritt hat gespeichert: der gemerkte Stand des Tags ist überholt - neu lesen.
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

/** „Bei Ihnen zum Beispiel Hauptzähler Halle 1 (HZ-1) und Zähler Druckluft (AZ-3).“ - aus den eigenen Messstellen. */
function Beispiel({ reihen }: { reihen: readonly Reihe[] }) {
  const b = messstelleBeispiel(reihen);
  if (b.length === 0) return null;
  return (
    <>
      Bei Ihnen zum Beispiel{' '}
      {b.map((r, i) => (
        <span key={r.id}>
          {i > 0 ? ' und ' : ''}
          <b>{r.name}</b> ({r.kennzeichen})
        </span>
      ))}
      .
    </>
  );
}

/**
 * „Stand an einem Tag ansehen“: aus dem Menü öffnet das Datumsfeld (sein Kalender klappt gleich auf); ist ein Tag
 * gewählt, steht unter dem Titel die gestrichelte Marke „Stand 30.04.2029“ mit „Zurück zu heute“ - die Plan-Marke der
 * Familie, kein Banner. Antippen der Marke wählt einen anderen Tag.
 */
function StandAmLeiste({
  heute,
  stichtag,
  offen,
  onOeffnen,
  onWahl,
  onZurueck,
  onAbbrechen,
}: {
  heute: string;
  stichtag: string | null;
  offen: boolean;
  onOeffnen: () => void;
  onWahl: (wahl: string) => void;
  onZurueck: () => void;
  onAbbrechen: () => void;
}) {
  const feldId = `vp-ms-stand-${useId().replace(/:/g, '')}`;
  const rahmen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offen) return;
    // Der Kalender klappt gleich auf: wer „Stand an einem Tag ansehen“ wählt, will einen Tag wählen.
    const knopf = rahmen.current?.querySelector<HTMLButtonElement>('button');
    knopf?.focus();
    knopf?.click();
  }, [offen]);
  if (offen) {
    return (
      <div className="vp-ms-standwahl" ref={rahmen} data-testid="messstellen-standwahl">
        <VpDatePicker id={feldId} label="Stand am" value={stichtag ?? heute} onChange={onWahl} />
        <button type="button" className="vp-ms-link" onClick={onAbbrechen}>
          Abbrechen
        </button>
      </div>
    );
  }
  if (!stichtag) return null;
  return (
    <div className="vp-ms-stand vp-k-farben" role="status" data-testid="stand-am">
      <button type="button" className="vp-k-marke is-plan vp-ms-stand-marke" onClick={onOeffnen} aria-label={`Stand ${datumText(stichtag)} – anderen Tag wählen`}>
        <Icon name="calendar" size={13} />
        Stand {datumText(stichtag)}
      </button>
      <button type="button" className="vp-ms-link" onClick={onZurueck}>
        {ZURUECK_ZU_HEUTE}
      </button>
    </div>
  );
}

/** Die ruhige Zeile mit dem Satz des Servers - oder die Hinweiskarten bei Handlungsbedarf (Status-Variante A). */
function Statuszeile({ status, onMarke }: { status: NonNullable<ReturnType<typeof statusAus>>; onMarke: (k: MarkeSchluessel) => void }) {
  if (status.zeile) {
    return (
      <p className={`vp-ms-status is-${status.zeile.ton}`} data-testid="messstellen-status">
        <span className="vp-ms-status-punkt" aria-hidden="true" />
        {status.zeile.text}
      </p>
    );
  }
  if (status.hinweise.length === 0) return null;
  return (
    <div className="vp-ms-hinweise" data-testid="messstellen-hinweise">
      {status.hinweise.map((h) => (
        <HinweisKarte key={h.titel} h={h} onMarke={onMarke} />
      ))}
    </div>
  );
}

function HinweisKarte({ h, onMarke }: { h: Hinweis; onMarke: (k: MarkeSchluessel) => void }) {
  const inhalt = (
    <>
      <span className="vp-ms-hinweis-icon" aria-hidden="true">
        <Icon name="alert-triangle" size={20} />
      </span>
      <span className="vp-ms-hinweis-text">
        <b>{h.titel}</b>
        {h.satz && <span>{h.satz}</span>}
      </span>
      {h.schritt && (
        <span className="vp-ms-hinweis-schritt">
          {h.schritt}
          <Icon name="chevron-right" size={16} />
        </span>
      )}
    </>
  );
  const marke = h.marke;
  return marke && h.schritt ? (
    <button type="button" className={`vp-ms-hinweis is-${h.ton}`} onClick={() => onMarke(marke)}>
      {inhalt}
    </button>
  ) : (
    <div className={`vp-ms-hinweis is-${h.ton}`} role="status">
      {inhalt}
    </div>
  );
}

/** Die EINE Suche: ein Feld, sofort, tolerant; Escape leert, „×“ auch; die Zahl der Treffer daneben. */
function Suchzeile({
  suche,
  onSuche,
  treffer,
  gefiltert,
}: {
  suche: string;
  onSuche: (wert: string) => void;
  treffer: string;
  gefiltert: boolean;
}) {
  const feld = useRef<HTMLInputElement>(null);
  return (
    <div className="vp-ms-suchzeile">
      <label className="vp-ms-suche" role="search">
        <Icon name="search" size={17} aria-hidden="true" />
        <input
          ref={feld}
          type="text"
          role="searchbox"
          aria-label={SUCHE_LABEL}
          placeholder={SUCHE_PLATZHALTER}
          value={suche}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => onSuche(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && suche) {
              e.stopPropagation();
              onSuche('');
            }
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        {suche && (
          <button
            type="button"
            className="vp-ms-suche-leeren"
            aria-label={SUCHE_LEEREN}
            onClick={() => {
              onSuche('');
              feld.current?.focus();
            }}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </label>
      <span className={`vp-ms-treffer${gefiltert ? ' is-gefiltert' : ''}`} role="status" aria-live="polite">
        {treffer}
        {gefiltert && (
          <button type="button" className="vp-ms-link" onClick={() => onSuche('')}>
            {SUCHE_LEEREN}
          </button>
        )}
      </span>
    </div>
  );
}

/** Die Marken: nur, was es gibt; sie filtern (eine zur Zeit). Dazu die Filter der Adresse als Marke mit „×“. */
function MarkenLeiste({
  marken,
  aktiv,
  onMarke,
  ort,
  anlage,
  onOhne,
}: {
  marken: Marke[];
  aktiv: MarkeSchluessel | null;
  onMarke: (k: MarkeSchluessel) => void;
  ort: string | null;
  anlage: string | null;
  onOhne: (name: 'ort' | 'anlage') => void;
}) {
  if (marken.length === 0 && !ort && !anlage) return null;
  return (
    <div className="vp-ms-marken" role="group" aria-label={MARKEN_LABEL} data-testid="messstellen-marken">
      {ort && (
        <button type="button" className="vp-ms-chip is-adresse" onClick={() => onOhne('ort')} aria-label={`${ort} – Filter entfernen`}>
          {ort}
          <Icon name="x" size={13} />
        </button>
      )}
      {anlage && (
        <button type="button" className="vp-ms-chip is-adresse" onClick={() => onOhne('anlage')} aria-label={`${anlage} – Filter entfernen`}>
          {anlage}
          <Icon name="x" size={13} />
        </button>
      )}
      {marken.map((k) => (
        <button
          key={k.schluessel}
          type="button"
          className={`vp-ms-chip is-${k.ton}`}
          aria-pressed={aktiv === k.schluessel}
          onClick={() => onMarke(k.schluessel)}
        >
          {k.text}
        </button>
      ))}
    </div>
  );
}

/** Ein Text mit seinen Fundstellen; ohne Suche der Text. */
function Markiert({ text, suche }: { text: string; suche: string }) {
  const terme = suchTerme(suche);
  if (terme.length === 0) return <>{text}</>;
  return (
    <>
      {markiert(text, terme).map((t: TextTeil, i) => (t.treffer ? <mark key={i}>{t.text}</mark> : <span key={i}>{t.text}</span>))}
    </>
  );
}

/** Der Kopf der Spalten ab 760 px - dieselben Wörter wie die Reihen am Telefon. */
/** Der Kopf der Spalten ab 760 px; rechts der Monat der Reihen („September 2026“), ohne Monat „Letzter Stand“. */
function Spalten({ wertKopf }: { wertKopf: string }) {
  return (
    <div className="vp-ms-spalten" aria-hidden="true">
      <span>{SPALTE.messstelle}</span>
      <span>{SPALTE.zustand}</span>
      <span>{SPALTE.woher}</span>
      <span className="is-wert">{wertKopf}</span>
      <span />
    </div>
  );
}

/** Je Ort eine Karte: der Ort mit Standort und Zahl, darunter die Reihen. */
function OrtKarte({
  gruppe,
  gefiltert,
  suche,
  periode,
  wertKopf,
  onOeffnen,
}: {
  gruppe: OrtGruppe;
  gefiltert: boolean;
  suche: string;
  periode: string | null;
  wertKopf: string;
  onOeffnen?: (id: string, periode: string | null) => void;
}) {
  const titelId = `vp-ms-ort-${useId().replace(/:/g, '')}`;
  return (
    <section className="vp-ms-ort" aria-labelledby={titelId} data-testid="messstellen-ort">
      <div className="vp-ms-ort-kopf">
        <h2 id={titelId}>{gruppe.titel}</h2>
        <span className="vp-ms-ort-zahl">{gruppenZahl(gruppe, gefiltert)}</span>
      </div>
      <Spalten wertKopf={wertKopf} />
      <ul className="vp-ms-reihen">
        {gruppe.reihen.map((r) => (
          <li key={r.id}>
            <ReiheLink r={r} suche={suche} periode={periode} onOeffnen={onOeffnen} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Eine Reihe: die ganze Fläche ist der Link auf die Messstelle (mindestens 56 px hoch). Mit „Stand am …“ trägt er den
 * Tag als Periode - die Seite öffnet die Werte dieses Tages, nicht die von heute.
 */
function ReiheLink({
  r,
  suche,
  periode,
  onOeffnen,
}: {
  r: Reihe;
  suche: string;
  periode: string | null;
  onOeffnen?: (id: string, periode: string | null) => void;
}) {
  const pfad = window.location.hash.split('?')[0] || '#/portfolio/messstellen';
  // Mit „Stand am …“ öffnet die Messstelle an diesem Tag - nur lesend wie die Liste (`stand=`).
  const href = `${pfad}/${encodeURIComponent(r.id)}${periode ? `?periode=${periode}&stand=${periode}` : ''}`;
  const klick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!onOeffnen || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOeffnen(r.id, periode);
  };
  return (
    <a
      className={`vp-ms-reihe is-${r.ton}`}
      href={href}
      onClick={klick}
      data-entscheid={r.ablesungsZiel ? 'zaehlerablesung' : undefined}
      data-testid="messstelle-reihe"
    >
      <span className="vp-ms-reihe-name">
        <span className="vp-ms-punkt is-name" aria-hidden="true" />
        <span className="vp-ms-reihe-titel">
          <Markiert text={r.name} suche={suche} />{' '}
          <span className="vp-ms-kz">
            <Markiert text={r.kennzeichen} suche={suche} />
          </span>
        </span>
      </span>
      {r.unter && <span className="vp-ms-reihe-unter">{r.unter}</span>}
      <span className="vp-ms-reihe-satz">
        <span className="vp-ms-punkt is-satz" aria-hidden="true" />
        <span>
          {r.satz ?? OHNE_ANGABE}
          {r.wegKurz && <span className="vp-ms-weg"> · {r.wegKurz}</span>}
          {r.fakten.map((f) => (
            <small key={f} className="vp-ms-reihe-fakt">
              {f}
            </small>
          ))}
        </span>
      </span>
      <span className="vp-ms-reihe-woher">
        {r.woher.zeile}
        {r.woher.neben && <small>{r.woher.neben}</small>}
      </span>
      <span className="vp-ms-reihe-wert">
        {r.wert ? (
          <>
            <b>
              {r.wert.zahl}
              {r.wert.einheit && <small>{r.wert.einheit}</small>}
            </b>
            {/* Der Monat steht am Rechner im Kopf der Spalte; in der Reihe bleibt er für Vorlesende. */}
            <span className={r.wert.monat ? 'is-monat' : undefined}>{r.wert.wann}</span>
          </>
        ) : (
          <b className="is-leer">{OHNE_ANGABE}</b>
        )}
      </span>
      <span className="vp-ms-reihe-chev" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
    </a>
  );
}

/** Archivierte Messstellen: zugeklappt am Ende („Archiviert · 2“), aufgeklappt als Reihen. */
function ArchivKarte({
  reihen,
  suche,
  periode,
  onOeffnen,
}: {
  reihen: Reihe[];
  suche: string;
  periode: string | null;
  onOeffnen?: (id: string, periode: string | null) => void;
}) {
  return (
    <details className="vp-ms-ort vp-ms-archiv" data-testid="messstellen-archiv">
      <summary className="vp-ms-ort-kopf">
        <h2>{`${ARCHIVIERT} · ${reihen.length}`}</h2>
        <Icon name="chevron-down" size={18} />
      </summary>
      <ul className="vp-ms-reihen">
        {reihen.map((r) => (
          <li key={r.id}>
            <ReiheLink r={r} suche={suche} periode={periode} onOeffnen={onOeffnen} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Am Stichtag noch nicht im Portal - benannt an einem eigenen Ort, nie weggelassen. */
function NochNicht({ eintraege, stichtag }: { eintraege: Liste['nochNicht']; stichtag: string }) {
  return (
    <section className="vp-ms-ort is-still" data-testid="messstellen-noch-nicht">
      <div className="vp-ms-ort-kopf">
        <h2>{`Am ${datumText(stichtag)} noch nicht im Portal`}</h2>
        <span className="vp-ms-ort-zahl">{eintraege.length}</span>
      </div>
      <ul className="vp-ms-reihen">
        {eintraege.map((e) => (
          <li key={e.id} className="vp-ms-reihe is-still is-ohne-link">
            <span className="vp-ms-reihe-name">
              <span className="vp-ms-punkt is-name" aria-hidden="true" />
              <span className="vp-ms-reihe-titel">
                {e.name} <span className="vp-ms-kz">{e.kennzeichen}</span>
              </span>
            </span>
            <span className="vp-ms-reihe-satz">
              <span className="vp-ms-punkt is-satz" aria-hidden="true" />
              <span>{e.satz}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Die Suche (oder Marke) findet nichts: der Begriff, worin gesucht wird, und der Weg zurück. */
function KeinTreffer({
  suche,
  weitere,
  onLeeren,
  onAlle,
}: {
  suche: string;
  weitere: boolean;
  onLeeren: () => void;
  onAlle: () => void;
}) {
  const mitSuche = suchTerme(suche).length > 0;
  return (
    <section className="vp-ms-karte" role="status" data-testid="messstellen-kein-treffer">
      <p className="vp-ms-leer-satz">{mitSuche ? keineTreffer(suche) : 'Keine Messstelle passt zu dieser Auswahl.'}</p>
      {mitSuche && <p className="vp-ms-leise">{SUCHE_WORIN}</p>}
      <div className="vp-ms-knoepfe">
        {mitSuche && (
          <Button variant="outline" size="sm" onClick={onLeeren}>
            {SUCHE_LEEREN}
          </Button>
        )}
        {weitere && (
          <button type="button" className="vp-ms-link" onClick={onAlle}>
            {AUCH_IN_ALLEN}
          </button>
        )}
      </div>
    </section>
  );
}

function Leer({
  leer,
  ebene,
  onUebersicht,
  onMessenEinrichten,
  onAnlegen,
  onAllesZeigen,
  filterSatz,
}: {
  leer: Leerzustand;
  ebene: MessstellenEbene;
  onUebersicht?: () => void;
  /**
   * AP-01 E5 = A: „Messen & Auswerten einrichten“ öffnet den Assistenten (am Standort mit Vorwahl, sonst am
   * Entwurf) - in beiden Leerzuständen der Messwelt, nur mit Recht; ohne Recht steht Grund und Weg.
   */
  onMessenEinrichten?: () => void;
  /** §5.11: „noch keine Messstelle“ trägt den Knopf „Messstelle anlegen“ - nur, wenn angelegt werden darf. */
  onAnlegen?: () => void;
  /** Ein Filter der Adresse (Ort, Anlage) ohne Treffer: zurück zu allen. */
  onAllesZeigen: () => void;
  /** Der Satz eines Filters der Adresse ohne Treffer („In Halle 1 steht keine Messstelle.“). */
  filterSatz: string | null;
}) {
  const messen = (leer.art === 'bereich_fehlt' || leer.art === 'keine_messstelle') && onMessenEinrichten;
  return (
    <section className="vp-ms-karte" role="status" data-testid="messstellen-leer">
      <p className="vp-ms-leer-satz">
        {leer.art === 'filter_ohne_treffer' && filterSatz ? filterSatz : leer.satz}
      </p>
      {leer.art === 'keine_messstelle' && (
        <p className="vp-ms-leise">
          Eine Messstelle ist jeder Zähler, den Sie auswerten wollen – automatisch von einem Gerät oder zum Ablesen von Hand.
        </p>
      )}
      <div className="vp-ms-knoepfe">
        {leer.art === 'keine_messstelle' && onAnlegen && (
          <Recht aktion="messstelle.bearbeiten">
            <Button iconLeft={<Icon name="plus" size={15} />} onClick={onAnlegen}>
              {DIALOG_TITEL.anlegen}
            </Button>
          </Recht>
        )}
        {messen && (
          <Recht aktion="funktion.messen_einrichten">
            <Button variant={leer.art === 'bereich_fehlt' ? 'primary' : 'outline'} onClick={onMessenEinrichten}>
              {MESSEN_EINRICHTEN}
            </Button>
          </Recht>
        )}
        {leer.art === 'bereich_fehlt' && onUebersicht && (
          <Button variant="outline" onClick={onUebersicht}>
            {ZUR_UEBERSICHT}
          </Button>
        )}
        {(leer.art === 'filter_ohne_treffer' || leer.art === 'alle_mit_quelle') && (
          <button type="button" className="vp-ms-link" onClick={onAllesZeigen}>
            {`Alle ${TITEL}${ebene.art === 'standort' ? ` in ${ebene.name}` : ''} zeigen`}
          </button>
        )}
      </div>
    </section>
  );
}
