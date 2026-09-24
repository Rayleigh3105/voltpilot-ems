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
  type Overview,
  type SchedulePlan,
  type Site,
} from '../api';
import { fleetTonalitaet } from '../fleet';
import { ortsHinweis } from '../cockpitLayout';
import { anlageRoute, hashForRoute, type Route } from '../nav';
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
import { useCockpitLayout } from '../useCockpitLayout';
import {
  anlagenKarten,
  heuteKarte,
  jetztBlock,
  statusZeile,
  tagesKurve,
  uebersichtBloecke,
} from '../kundenUebersicht';
import { speicherAussage } from '../speicherAussage';
import { usePortfolioHistorie } from '../usePortfolioHistorie';
import { berlinDay } from '../fleet';
import { KundenUebersicht } from './portfolio/KundenUebersicht';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { AnlagenTabelle } from './AnlagenTabelle';
import { AnpassenLeiste, AnpassenListe } from './CockpitAnpassen';
import { AddDeviceDrawer } from './DeviceDrawers';
import { KennzahlLeiste } from './KennzahlLeiste';
import { RowMenu } from './RowMenu';
import { ErrorState, Skeleton } from './States';
import './PortfolioCockpit.css';
// LIVE: die Kennzahlen-Leiste zeigt gemessene Ist-Werte (PV jetzt, Netz).
import { LIVE_POLL_MS } from '../pollCadence';

/** Re-render cadence of the freshness/liveness derivations. */
const TICK_MS = 5_000;

/** Bis zu so vielen Anlagen zeigt die Kunden-Übersicht Tageskurven. */
const KURVEN_BIS_ANLAGEN = 12;

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
}: PortfolioCockpitProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const isPhone = useIsPhone();

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
  const kennzahlen = useMemo(
    () => portfolioKennzahlen(overview, earnings, now),
    [overview, earnings, now],
  );
  const anwendungen = useMemo(
    () => portfolioAnwendungen(overview, configById),
    [overview, configById],
  );
  const verfuegbar = useMemo(
    () =>
      verfuegbareBausteine({
        anwendungen,
        kennzahlen,
        anlagen: overview?.sites.length ?? 0,
      }),
    [anwendungen, kennzahlen, overview],
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

  // DIE KUNDEN-ÜBERSICHT (Konzept „Meine Anlagen neu", Ü1–Ü5 = A): der
  // Endkunde bekommt vier Blöcke statt Leiste und Tabelle. Die Tageskurven
  // lesen dieselbe Tages-Historie wie der Reiter Energie (geteilter Cache);
  // bei sehr vielen Anlagen entfallen sie, statt die Seite zu bremsen.
  const kundenAnsicht = betriebsart === 'endkunde';
  const liste = useMemo(() => sites.map((s) => ({ id: s.id, name: s.name })), [sites]);
  const tagesHistorie = usePortfolioHistorie(
    liste,
    'day',
    berlinDay(now),
    kundenAnsicht && sites.length > 0 && sites.length <= KURVEN_BIS_ANLAGEN,
  );

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

  const aussage = overview ? flottenAussage(overview.sites, now) : null;

  const head = (
    <div className="vp-portfolio-kopf">
      <div className="vp-portfolio-titel">
        <h1 className={titelBereitsGenannt ? 'vp-sr-only' : undefined}>{titel}</h1>
        {aussage && (
          <p className={`vp-portfolio-satz is-${aussage.tone}`}>
            <span className="vp-portfolio-punkt" aria-hidden="true" />
            {aussage.text}
          </p>
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

  if (kundenAnsicht) {
    const bloecke = uebersichtBloecke(layout.resolved.order, verfuegbar, CANONICAL_PORTFOLIO);
    const heute = heuteKarte({
      earnings,
      sites: liste,
      overview,
      now,
      speicher: (agg) =>
        speicherAussage(
          {
            savedEur: agg.steuerungEur,
            savedSteuerungEur: agg.steuerungEur,
            range: 'day',
            to: earnings?.to ?? null,
          },
          { now, laeuft: true },
        ),
    });
    const historien = tagesHistorie.daten;
    return (
      <>
        <KundenUebersicht
          titel={titel}
          titelVersteckt={titelBereitsGenannt}
          status={statusZeile(overview.sites, now)}
          aktionen={[
            { label: 'Anpassen', icon: 'sliders', onClick: layout.start },
            ...aktionen,
          ]}
          bloecke={bloecke}
          heute={heute}
          kurve={historien ? tagesKurve(historien, now) : null}
          jetzt={jetztBlock(overview, now)}
          anlagen={anlagenKarten({ overview, aggregat: heute.aggregat, historien, now })}
          hrefFor={(id) => hashForRoute(anlageRoute(id))}
          anpassen={
            layout.anpassen ? (
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
                  mitStern={false}
                />
                <AnpassenListe
                  zeilen={layout.zeilen}
                  onVerschieben={layout.verschieben}
                  onSichtbar={layout.setSichtbar}
                  onLead={() => {}}
                  note={(z) => ortsHinweis(z.id)}
                />
              </>
            ) : null
          }
        />
        {drawers}
      </>
    );
  }

  const tonalitaet = fleetTonalitaet(
    overview.sites.map((s) => ({
      profil: configById.get(s.id)?.profil ?? null,
      plantKind: s.plantKind,
    })),
  );
  const zellen = leistenZellen({
    order: layout.resolved.order,
    kennzahlen,
    anlagen: overview.sites.length,
    tonalitaet,
  });
  const zeilen = anlagenZeilen({ overview, earnings, configById, dichte, now });
  const spalten = tabellenSpalten(zeilen, layout.resolved.order);
  const ruhe = ruheSatz(layout.resolved.order);

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

      <section className="vp-portfolio-anlagen" aria-label="Meine Anlagen">
        <AnlagenTabelle
          zeilen={zeilen}
          spalten={spalten}
          dichte={dichte}
          offen={offen}
          onToggle={(id) => setOffen((cur) => (cur === id ? null : id))}
          onOeffnen={(id) => onNavigate(anlageRoute(id))}
          vorschau={vorschau}
        />
      </section>

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
