import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { api, type Earnings, type Overview, type Site } from '../api';
import { ortsHinweis } from '../cockpitLayout';
import { anlageRoute, hashForRoute } from '../nav';
import {
  CANONICAL_PORTFOLIO,
  flottenAussage,
  portfolioAnwendungen,
  portfolioKennzahlen,
  verfuegbareBausteine,
  type PortfolioBausteinId,
} from '../portfolioCockpit';
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
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { AnpassenLeiste, AnpassenListe } from './CockpitAnpassen';
import { AddDeviceDrawer } from './DeviceDrawers';
import { RowMenu } from './RowMenu';
import { ErrorState, Skeleton } from './States';
import './PortfolioCockpit.css';
// LIVE: „Jetzt" und die Statuszeile zeigen gemessene Ist-Werte.
import { LIVE_POLL_MS } from '../pollCadence';

/** Re-render cadence of the freshness/liveness derivations. */
const TICK_MS = 5_000;

/** Bis zu so vielen Anlagen zeigt die Übersicht Tageskurven. */
const KURVEN_BIS_ANLAGEN = 12;

/**
 * DIE ÜBERSICHT DER FLOTTEN-EBENE („Meine Anlagen" / „Portfolio") — EINE
 * Fläche für jedes Konto mit mehreren Anlagen (Anwendungs-Programm Stufe 4 /
 * Captain-Entscheid E5).
 *
 * Seit dem Konzept „Meine Anlagen neu" (Ü1–Ü5 = A) sind es vier Blöcke:
 * Statuszeile mit ⋯-Menü → „Heute" → „Jetzt" → „Ihre Anlagen". Seit dem
 * Entscheid vom 25.09.2026 gilt das für JEDE Betriebsart: Endkunde,
 * Automatisch und Betreiber sehen dieselbe Übersicht. Die Betriebsart wählt
 * nur noch die Navigation (`betriebsart.ts`); Kennzahlen-Leiste und
 * Anlagen-Tabelle sind aus dieser Fläche entfallen.
 *
 * Solange die Übersicht nicht steht (Laden, Fehler, keine Anlage), trägt ein
 * schmaler Kopf Titel, Flotten-Aussage und das ⋯-Menü.
 *
 * **Render-only.** Jede Zahl, jedes Wort und jede Auslassung entsteht in den
 * reinen Modulen `kundenUebersicht.ts` / `portfolioCockpit.ts`, die Anordnung
 * der Blöcke im ebenso reinen `cockpitLayout.ts`.
 */
export interface PortfolioCockpitProps {
  sites: Site[];
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** Der Titel der Fläche — er kommt von der Route (Portfolio / Meine Anlagen). */
  titel: string;
  /**
   * ⚠ Steht der Name der Ebene SCHON über dieser Fläche? Seit der
   * Navigations-Runde „zwei Ebenen" (#503) trägt die Flotten-Ebene die
   * Reiter `Übersicht · Energie · Erlöse` ÜBER dem Seitenkopf, und die
   * Kopfzeile nennt die Ebene als Krume — der Titel stünde dann ZWEIMAL auf
   * einem Bildschirm, während der aktive Reiter „Übersicht" sagt. Die
   * Überschrift BLEIBT dann als Sprungziel (`vp-sr-only`, das
   * `AnlageSeite`-Muster des Mobil-Umbaus) und die Statuszeile führt sichtbar.
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
  onReload,
  isAdmin = false,
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
   * „Heute" braucht nur den HEUTIGEN Tag — der frühere Zeitraum-Umschalter
   * gehörte zum Geld-Helden und ist mit ihm entfallen. Der Abruf ist
   * fail-soft: ohne ihn fehlt das Ergebnis, die Fläche bleibt.
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

  // Die Tageskurven lesen dieselbe Tages-Historie wie der Reiter Energie
  // (geteilter Cache); bei sehr vielen Anlagen entfallen sie, statt die Seite
  // zu bremsen.
  const liste = useMemo(() => sites.map((s) => ({ id: s.id, name: s.name })), [sites]);
  const tagesHistorie = usePortfolioHistorie(
    liste,
    'day',
    berlinDay(now),
    sites.length > 0 && sites.length <= KURVEN_BIS_ANLAGEN,
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
                // Das Portfolio hat keine Bühne, also auch keinen Stern.
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
