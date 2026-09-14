import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  type Betriebsart,
  type ControlStatus,
  type Earnings,
  type Funktionen,
  type Overview,
  type SchedulePlan,
  type Site,
} from '../api';
import { fleetTonalitaet } from '../fleet';
import { ortsHinweis } from '../cockpitLayout';
import { anlageRoute, pageRoute, standortRoute, type Route } from '../nav';
import {
  CANONICAL_PORTFOLIO,
  anlagenZeilen,
  flottenAussage,
  leistenZellen,
  portfolioAnwendungen,
  portfolioDichte,
  portfolioKennzahlen,
  ruheSatz,
  tabellenSpalten,
  verfuegbareBausteine,
  type PortfolioBausteinId,
} from '../portfolioCockpit';
import { vorschauZeilen, type VorschauZeile } from '../portfolioVorschau';
import {
  anlagenDerEbene,
  funktionenDesStandorts,
  funktionenKarte,
  geldAnlagen,
  kopfzeile,
  standortGruppen,
  standortLeerzustand,
  type UebersichtEbene,
} from '../uebersicht';
import { useCockpitLayout } from '../useCockpitLayout';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { AnlagenTabelle } from './AnlagenTabelle';
import { AnpassenLeiste, AnpassenListe } from './CockpitAnpassen';
import { AddDeviceDrawer } from './DeviceDrawers';
import { KennzahlLeiste } from './KennzahlLeiste';
import { RowMenu } from './RowMenu';
import { FunktionenKarte } from './FunktionenKarte';
import { FunktionsZustaende, StandortGruppeKopf } from './StandortGruppeKopf';
import { EmptyState, ErrorState, Skeleton } from './States';
import './PortfolioCockpit.css';
// LIVE: die Kennzahlen-Leiste zeigt gemessene Ist-Werte (PV jetzt, Netz).
import { LIVE_POLL_MS } from '../pollCadence';

/** Re-render cadence of the freshness/liveness derivations. */
const TICK_MS = 5_000;

/**
 * DAS PORTFOLIO-COCKPIT — EINE Kunden-Fläche für jeden Mehr-Anlagen-Kunden
 * (Anwendungs-Programm Stufe 4 / Captain-Entscheid E5), **Revision 2** nach
 * den Anmerkungen vom 25.08.2026 (Scout `data/vp-portfolio-konzept-r2`
 * §5.2/§5.4, `…-b3` §6a).
 *
 * Sie liest von oben nach unten: **Kopf** (Titel + die EINE Flotten-Aussage
 * als Unterzeile, Aktionen im „···"-Menü) → **Kennzahlen-Leiste** → **EINE
 * Anlagen-Tabelle** in zwei Dichten, mit aufklappbarer Vorschau je Zeile.
 *
 * ## Was Revision 2 ENTFERNT hat, und warum
 *
 * - **Der Geld-Held ist weg.** Der Marken-Verlauf gehört Login und Marketing;
 *   im Betriebs-Portal ist Geld eine Zelle der Leiste wie jede andere Zahl —
 *   die TONALITÄT trägt weiterhin das Wort („Mehrerlös" vs. „Vorteil").
 * - **Die neun Icon-Kacheln sind eine Leiste.** Dieselben Katalog-Bausteine,
 *   nur als Zellen (§5.4) — das 235-px-`auto-fit`-Gitter liess seine letzte
 *   Kachel bei fast jeder Breite als Waise stehen.
 * - **Karten und Tabelle sind EINE Tabelle.** `dichte` entscheidet nur noch
 *   über Zeilenhöhe und Unterzeile, nicht mehr über den INHALT; Karten
 *   rendert erst das Telefon (dort können acht Spalten nie nebeneinander
 *   stehen).
 *
 * **Render-only.** Jede Zahl, jedes Wort, jede Auslassung und jede Sortierung
 * entsteht im reinen `portfolioCockpit.ts` / `portfolioVorschau.ts`, die
 * Anordnung im ebenso reinen `cockpitLayout.ts`.
 */
export interface PortfolioCockpitProps {
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0-Rahmen (effektiv, aus /tenant-context); null = unbekannt → komfortabel. */
  betriebsart?: Betriebsart | null;
  /** Der Titel der Fläche — er kommt von der Route (Portfolio / Meine Anlagen). */
  titel: string;
  /**
   * ⚠ Steht der Name der Ebene SCHON über dieser Fläche? Seit der
   * Navigations-Runde „zwei Ebenen" (#503) trägt die Betreiber-Ebene die
   * Reiter `Übersicht · Messwerte · Erlöse` ÜBER dem Seitenkopf, und die
   * Kopfzeile nennt die Ebene als Krume — der Titel stünde dann ZWEIMAL auf
   * einem Bildschirm, während der aktive Reiter „Übersicht" sagt und die
   * Überschrift „Portfolio". Die Überschrift BLEIBT dann als Sprungziel
   * (`vp-sr-only`, das `AnlageSeite`-Muster des Mobil-Umbaus) und die
   * Flotten-Aussage führt sichtbar.
   *
   * Der Endkunden-Wirt (`UebersichtPage`, ohne Reiter) setzt es NICHT — dort
   * ist die Überschrift die einzige Stelle, die die Fläche benennt.
   */
  titelBereitsGenannt?: boolean;
  /** Der Kundenname für das Admin-Band des Anpassen-Modus. */
  kunde?: string | null;
  /**
   * UEMS AP-01 IP-6 — die Ebene, wenn diese Fläche die Unternehmens- oder die
   * Standort-Übersicht ist (E2: die Übersicht IST dieses Cockpit). Sie bringt
   * die Kopfzeile, die Standort-Gruppen, den Standort-Filter, die zwei
   * Übersichts-Bausteine und die Geld-Regel mit. `null` = die Flotte wie bisher,
   * zeichengleich.
   */
  ebene?: UebersichtEbene | null;
}

export function PortfolioCockpit({
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
  titel,
  titelBereitsGenannt = false,
  kunde = null,
  ebene = null,
}: PortfolioCockpitProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  /** `undefined` = lädt noch, `null` = nicht abrufbar (fail-soft). */
  const [funktionen, setFunktionen] = useState<Funktionen | null | undefined>(undefined);
  const isPhone = useIsPhone();
  const mitEbene = ebene != null;

  useEffect(() => {
    let active = true;
    api.overview().then(
      (o) => {
        if (!active) return;
        setOverview(o);
        setFailed(false);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  /*
   * Das Geld ist seit Revision 2 EINE Zelle („Vorteil heute") und braucht
   * deshalb nur noch den HEUTIGEN Tag — der frühere Zeitraum-Umschalter gehörte
   * zum Geld-Helden und ist mit ihm entfallen. Der Abruf ist fail-soft: ohne
   * ihn fehlt die Zelle, die Fläche bleibt.
   */
  useEffect(() => {
    let active = true;
    api.earnings('day').then(
      (e) => {
        if (active) setEarnings(e);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // UEMS AP-01 IP-6: der Zustand beider Funktionen je Standort — nur auf einer
  // Ebene geholt, jede andere Flotte fragt nichts Neues ab.
  useEffect(() => {
    if (!mitEbene) return;
    let active = true;
    api.funktionen().then(
      (f) => {
        if (active) setFunktionen(f);
      },
      () => {
        if (active) setFunktionen(null);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey, mitEbene]);

  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
    api.earnings('day').then(
      (e) => setEarnings(e),
      () => {},
    );
  }, LIVE_POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const dichte = portfolioDichte(betriebsart);
  const configById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  // Die Standort-Übersicht ist DIESELBE Fläche, auf die Anlagen des Standorts
  // gefiltert: jede Zahl darunter geht nur über sie.
  const blick = useMemo<Overview | null>(
    () => (overview && ebene ? { ...overview, sites: anlagenDerEbene(overview.sites, ebene) } : overview),
    [overview, ebene],
  );
  // Die Geld-Regel (A13): auf einer Ebene zählt Geld nur über die Anlagen, die
  // steuern oder Erzeuger/Speicher haben; ohne Ebene gilt das heutige Verhalten.
  const geld = useMemo(
    () => (ebene && blick ? geldAnlagen(blick.sites, funktionen ?? null) : null),
    [ebene, blick, funktionen],
  );
  const kennzahlen = useMemo(
    () => portfolioKennzahlen(blick, earnings, now, geld),
    [blick, earnings, now, geld],
  );
  const anwendungen = useMemo(
    () => portfolioAnwendungen(blick, configById),
    [blick, configById],
  );
  const verfuegbar = useMemo(
    () =>
      verfuegbareBausteine({
        anwendungen,
        kennzahlen,
        anlagen: blick?.sites.length ?? 0,
        uebersicht: ebene ? { geld: (geld?.size ?? 0) > 0 } : null,
      }),
    [anwendungen, kennzahlen, blick, ebene, geld],
  );

  const layout = useCockpitLayout<PortfolioBausteinId>({
    schluessel: 'portfolio',
    flaeche: 'portfolio',
    canonical: CANONICAL_PORTFOLIO,
    verfuegbar,
    // Das Portfolio hat keine Bühne: es gibt dort keinen lead-fähigen
    // Baustein, also auch keinen Stern (der Server lehnt jeden Lead ab).
    blocks: [],
    kunde,
    quelle: {
      laden: () => api.tenantCockpitLayout('portfolio'),
      speichern: (layer, document) => api.saveTenantCockpitLayout(layer, document, 'portfolio'),
      zuruecksetzen: (layer) => api.resetTenantCockpitLayout(layer, 'portfolio'),
    },
  });

  const vorschau = useVorschau(offen, overview, now);

  const aktionen = [
    {
      label: 'Anlage anlegen',
      icon: 'plus' as const,
      onClick: () => setSiteDrawer(true),
    },
    {
      label: 'Gerät hinzufügen',
      icon: 'cpu' as const,
      onClick: () => setDeviceDrawer(true),
    },
  ];

  const aussage = blick ? flottenAussage(blick.sites, now) : null;
  const kopf =
    ebene && blick
      ? kopfzeile({
          ebene,
          sites: blick.sites,
          funktionen: funktionen ?? null,
          mitDatenlage: layout.resolved.order.includes('datenlage'),
          now,
        })
      : null;

  const head = (
    <div className="vp-portfolio-kopf">
      <div className="vp-portfolio-titel">
        <h1 className={titelBereitsGenannt && !kopf?.titel ? 'vp-sr-only' : undefined}>
          {kopf?.titel ?? titel}
        </h1>
        {kopf ? (
          <>
            {kopf.zahlen && <p className="vp-portfolio-zahlen">{kopf.zahlen}</p>}
            {kopf.datenlage && (
              <p className={`vp-portfolio-satz is-${kopf.datenlage.ton}`}>
                <span className="vp-portfolio-punkt" aria-hidden="true" />
                {kopf.datenlage.text}
              </p>
            )}
          </>
        ) : (
          aussage && (
            <p className={`vp-portfolio-satz is-${aussage.tone}`}>
              <span className="vp-portfolio-punkt" aria-hidden="true" />
              {aussage.text}
            </p>
          )
        )}
        {ebene?.art === 'standort' && (
          <div className="vp-portfolio-funktionen">
            <FunktionsZustaende
              zeilen={funktionenDesStandorts(ebene.standort.id, funktionen ?? null)}
              laedt={funktionen === undefined}
            />
          </div>
        )}
      </div>
      <div className="vp-portfolio-aktionen">
        {overview != null && !layout.anpassen && (
          <Button
            variant="ghost"
            iconLeft={<Icon name="sliders" size={18} />}
            onClick={layout.start}
          >
            Anpassen
          </Button>
        )}
        <RowMenu items={aktionen} label="Weitere Aktionen" />
      </div>
    </div>
  );

  const drawers = (
    <>
      <AnlageAnlegenDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        existingSites={sites}
        onChanged={(createdSiteId) => {
          onReload(createdSiteId);
          setReloadKey((k) => k + 1);
        }}
      />
      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => {
          onReload();
          setReloadKey((k) => k + 1);
        }}
      />
    </>
  );

  if (sites.length === 0) {
    return (
      <>
        {head}
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="solar" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="sun" size={24} />
            </IconTile>
            <h3>{isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage'}</h3>
            <p>
              {isAdmin
                ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheint sie hier.'
                : 'Legen Sie Ihre erste Anlage an — danach sehen Sie hier alle Ihre Anlagen mit ihren Kennzahlen und ihrem Zustand.'}
            </p>
            <Button
              variant="primary"
              iconLeft={<Icon name="plus" size={18} />}
              onClick={() => setSiteDrawer(true)}
            >
              {isAdmin ? 'Anlage anlegen' : 'Erste Anlage anlegen'}
            </Button>
          </div>
        </Card>
        {drawers}
      </>
    );
  }

  if (overview == null && failed) {
    return (
      <>
        {head}
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Ihr Portfolio konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
        {drawers}
      </>
    );
  }

  if (overview == null) {
    return (
      <>
        {head}
        <Skeleton height={96} radius="var(--vp-radius-md)" />
        <div style={{ marginTop: 'var(--vp-space-4)' }}>
          <Skeleton height={240} radius="var(--vp-radius-md)" />
        </div>
        {drawers}
      </>
    );
  }

  const sicht = blick ?? overview;
  const tonalitaet = fleetTonalitaet(
    sicht.sites.map((s) => ({
      profil: configById.get(s.id)?.profil ?? null,
      plantKind: s.plantKind,
    })),
  );
  const zellen = leistenZellen({
    order: layout.resolved.order,
    kennzahlen,
    anlagen: sicht.sites.length,
    tonalitaet,
  });
  const zeilen = anlagenZeilen({ overview: sicht, earnings, configById, dichte, now, geld });
  const gruppen =
    ebene?.art === 'unternehmen'
      ? standortGruppen({ ebene, zeilen, sites: sicht.sites, funktionen: funktionen ?? null, now }).map(
          (g) => ({
            key: g.key,
            zeilen: g.zeilen,
            leer: g.leer,
            kopf: (
              <StandortGruppeKopf
                gruppe={g}
                laedt={funktionen === undefined}
                onOeffnen={(id) => onNavigate(standortRoute(id))}
                onZuordnen={() => onNavigate(pageRoute('portfolio-standorte'))}
              />
            ),
          }),
        )
      : null;
  const spalten = tabellenSpalten(zeilen, layout.resolved.order);
  const ruhe = ruheSatz(layout.resolved.order);
  // AP-01 IP-8: ein Standort ohne Anlage zeigt Grund und nächsten Schritt statt
  // einer leeren Tabelle.
  const leerStandort = ebene?.art === 'standort' ? standortLeerzustand(ebene.standort) : null;

  return (
    <>
      {head}
      {layout.anpassen && (
        <>
          <AnpassenLeiste
            quelle={layout.resolved.quelle}
            resetSatz={layout.resetSatz}
            dirty={layout.dirty}
            saving={layout.saving}
            fehler={layout.fehler}
            band={layout.band}
            alsVorgabe={layout.alsVorgabe}
            onAlsVorgabe={layout.setAlsVorgabe}
            onFertig={layout.fertig}
            onAbbrechen={layout.abbrechen}
            onZuruecksetzen={layout.zuruecksetzen}
            // Das Portfolio hat keine Bühne, also auch keinen Stern.
            mitStern={false}
          />
          {/*
           * Auf BEIDEN Breiten dieselbe Liste: hier ordnet man Zellen einer
           * Leiste und Spalten einer Tabelle, nicht Kacheln — eine Hülle um
           * eine Tabellenspalte gibt es nicht.
           */}
          <AnpassenListe
            zeilen={layout.zeilen}
            onVerschieben={layout.verschieben}
            onSichtbar={layout.setSichtbar}
            onLead={() => {}}
            note={(z) => ortsHinweis(z.id)}
          />
        </>
      )}

      <KennzahlLeiste zellen={zellen} label="Kennzahlen Ihrer Anlagen" />
      {ruhe && <p className="vp-portfolio-ruhe">{ruhe}</p>}

      <section
        className="vp-portfolio-anlagen"
        aria-label={ebene?.art === 'unternehmen' ? 'Anlagen nach Standort' : 'Meine Anlagen'}
      >
        {leerStandort ? (
          <EmptyState
            icon="map-pin"
            category="primary"
            title={leerStandort.titel}
            description={
              <>
                {leerStandort.satz}{' '}
                <span className="vp-portfolio-schritt">
                  <strong>Nächster Schritt:</strong> {leerStandort.schritt}.
                </span>
              </>
            }
          />
        ) : (
          <AnlagenTabelle
            gruppen={gruppen}
            zeilen={zeilen}
            spalten={spalten}
            dichte={dichte}
            offen={offen}
            onToggle={(id) => setOffen((cur) => (cur === id ? null : id))}
            onOeffnen={(id) => onNavigate(anlageRoute(id))}
            vorschau={vorschau}
          />
        )}
      </section>

      {/* AP-01 IP-8: die Karte „Funktionen" — nur auf einer Ebene; das Portfolio
          eines Betreibers bleibt zeichengleich. */}
      {ebene && (
        <FunktionenKarte abschnitte={funktionenKarte(ebene, funktionen ?? null)} laedt={funktionen === undefined} />
      )}

      {isPhone && (
        <div className="vp-portfolio-fuss">
          <Button
            variant="outline"
            iconLeft={<Icon name="plus" size={18} />}
            onClick={() => setSiteDrawer(true)}
          >
            Anlage anlegen
          </Button>
          <Button
            variant="primary"
            iconLeft={<Icon name="plus" size={18} />}
            onClick={() => setDeviceDrawer(true)}
          >
            Gerät hinzufügen
          </Button>
        </div>
      )}
      {drawers}
    </>
  );
}

/**
 * Die Vorschau der aufgeklappten Zeile — LAZY, je Anlage genau einmal geholt.
 *
 * Das Portfolio lädt Plan und Rücklesen NICHT im Voraus: das wären zwei
 * Abrufe je Anlage bei jedem Seitenaufruf, für eine Fläche, die der Kunde
 * meistens gar nicht aufklappt. Beide Abrufe sind fail-soft — die Vorschau
 * sagt dann, was sie weiss, statt zu verschwinden.
 *
 * `null` heisst „lädt noch"; die Fläche sagt das, statt eine leere Vorschau zu
 * zeigen (Laden und „nichts da" sind zwei verschiedene Auskünfte).
 */
function useVorschau(
  siteId: string | null,
  overview: Overview | null,
  now: Date,
): VorschauZeile[] | null {
  const [daten, setDaten] = useState<
    Record<string, { plan: SchedulePlan | null; control: ControlStatus | null }>
  >({});
  const laufend = useRef(new Set<string>());

  const holen = useCallback((id: string) => {
    if (laufend.current.has(id)) return;
    laufend.current.add(id);
    Promise.all([
      api.schedule(id).catch(() => null),
      api.controlStatus(id).catch(() => null),
    ]).then(([plan, control]) => {
      setDaten((cur) => ({ ...cur, [id]: { plan, control } }));
    });
  }, []);

  useEffect(() => {
    if (siteId != null && daten[siteId] == null) holen(siteId);
  }, [siteId, daten, holen]);

  if (siteId == null) return null;
  const site = overview?.sites.find((s) => s.id === siteId) ?? null;
  const geladen = daten[siteId];
  if (site == null || geladen == null) return null;
  return vorschauZeilen({
    site,
    plan: geladen.plan,
    control: geladen.control,
    plantKind: site.plantKind,
    now,
  });
}
