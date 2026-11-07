import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  adminApi,
  type AdminBrauchtDichErledigt,
  type AdminPlattformDienste,
  type PendingEnrollment,
} from '../../admin/adminApi';
import { fleetApi, type AdminFleetRelease, type AdminFleetSite } from '../../admin/fleetApi';
import type {
  EdgeUpdatesKpi,
  EdgeUpdatesLine,
  FleetRow as EdgeFleetRow,
  Rollout as EdgeRollout,
} from '../../adminEdgeUpdates';
import { fleetBoxGroups } from '../../adminFleet';
import type { FernwartungBox, FernwartungUebersicht } from '../../adminFernwartung';
import type { WerkstattDienst } from '../../werkstattBank';
import { relAge } from '../../adminFleet';
import {
  brauchtDichMitErledigt,
  uebersichtAuffaellig,
  uebersichtBrauchtDich,
  uebersichtDienste,
  uebersichtFlottenbild,
  uebersichtKacheln,
  BRAUCHT_DICH_ART_LABEL,
  type BrauchtDichArt,
  type BrauchtDichErledigtZeile,
  type BrauchtDichZeile,
  type FlottenbildTon,
  type UebersichtKachel,
} from '../../plattformUebersicht';
import { EmptyState, ErrorState } from '../../components/States';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { useIsPhone } from '../../useIsPhone';
import { freshnessLabel } from '../../adminEdgeUpdates';
import { geraeteAkteRoute, PLATFORM_TAB_PAGES, pageRoute, type PageId, type Route } from '../../nav';
import { AdminPageHead } from './AdminPageHead';
import './PlattformUebersicht.css';
import { LIST_POLL_MS } from '../../pollCadence';

/**
 * Plattform › Übersicht (Konzept `vp-adminview-konzept-k1` §4.3, Scheibe S4):
 * die neue Landung von `#/plattform`. Antwort zuerst, Ausnahmen zählen statt
 * Ganzheiten - vier Kacheln, „Braucht dich", Flottenbild, Dienste, Auffällig.
 *
 * Ersetzt die frühere Seite (Kacheln, Puls-Tabelle, Steuerungs-Matrix): die
 * Anlagen-Fakten wohnen jetzt in Akte › Anlage (S3), die Puls-Tabelle entfällt
 * ersatzlos zugunsten von Kacheln, „Braucht dich" und Flottenbild.
 *
 * **Keine neuen Endpunkte.** Diese Seite lädt nur Antworten, die andere
 * Plattform-Seiten ohnehin laden (`/admin/fleet`, `/admin/edge-updates`,
 * `/admin/fernwartung[/boxen]`, `/admin/werkstatt/dienst`,
 * `/admin/enrollments/pending`) und reicht sie an das reine Modul
 * `plattformUebersicht.ts` weiter - jede Zahl bleibt EIN Ort, EIN Fakt.
 */
export function PlattformUebersichtPage({
  onNavigate,
  tabs,
}: {
  onNavigate?: (target: Route) => void;
  /** Die Reiter-Leiste des Raums „Plattform" (Scheibe S1), vom Wirt `PlattformBereich`. */
  tabs?: ReactNode;
}) {
  const [sites, setSites] = useState<AdminFleetSite[] | null>(null);
  const [releases, setReleases] = useState<AdminFleetRelease[]>([]);
  const [edgeFleet, setEdgeFleet] = useState<EdgeFleetRow[]>([]);
  const [edgeLines, setEdgeLines] = useState<EdgeUpdatesLine[]>([]);
  const [edgeKpi, setEdgeKpi] = useState<EdgeUpdatesKpi | null>(null);
  const [edgeRollouts, setEdgeRollouts] = useState<EdgeRollout[]>([]);
  const [fernwartung, setFernwartung] = useState<FernwartungUebersicht | null>(null);
  const [fernwartungBoxen, setFernwartungBoxen] = useState<FernwartungBox[]>([]);
  const [werkstatt, setWerkstatt] = useState<WerkstattDienst | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[]>([]);
  const [plattformDienste, setPlattformDienste] = useState<AdminPlattformDienste | null>(null);
  const [erledigt, setErledigt] = useState<AdminBrauchtDichErledigt[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  // Treibt nur die ANZEIGE des Alters weiter - die Bezugszeit der Daten
  // bleibt `fetchedAt` (die Lebendigkeits-Lehre, `liveness.ts`).
  const [tick, setTick] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    const [fleetR, edgeR, fwR, fwBoxenR, wsR, pendR, diensteR, erledigtR] = await Promise.allSettled([
      fleetApi.fleet(),
      adminApi.edgeUpdates(),
      adminApi.fernwartung(),
      adminApi.fernwartungBoxen(),
      adminApi.werkstattDienst(),
      adminApi.listPendingEnrollments(),
      adminApi.plattformDienste(),
      adminApi.brauchtDichErledigt(),
    ]);
    // Ein Fehlschlag ist keine Datenlage (§5.2/`liveness.ts`): ein Block, den
    // dieser Abruf nicht lieferte, bleibt mit seinem alten Stand stehen -
    // nie still auf „nichts" zurückgesetzt, solange schon etwas gezeigt wird.
    if (fleetR.status === 'fulfilled') {
      setSites(fleetR.value.sites);
      setReleases(fleetR.value.releases ?? []);
    }
    if (edgeR.status === 'fulfilled') {
      setEdgeFleet(edgeR.value.fleet);
      setEdgeLines(edgeR.value.lines ?? []);
      setEdgeKpi(edgeR.value.kpi);
      setEdgeRollouts(edgeR.value.rollouts ?? []);
    }
    if (fwR.status === 'fulfilled') setFernwartung(fwR.value);
    if (fwBoxenR.status === 'fulfilled') setFernwartungBoxen(fwBoxenR.value);
    if (wsR.status === 'fulfilled') setWerkstatt(wsR.value);
    if (pendR.status === 'fulfilled') setPending(pendR.value);
    if (diensteR.status === 'fulfilled') setPlattformDienste(diensteR.value);
    if (erledigtR.status === 'fulfilled') setErledigt(erledigtR.value.erledigt);
    if (fleetR.status === 'fulfilled') {
      setLoadError(null);
      setFetchedAt(Date.now());
    } else {
      setLoadError('Die Plattform-Übersicht konnte nicht geladen werden.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useFreshnessPoll(() => void load(), LIST_POLL_MS, true);
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  const jetzt = useMemo(() => new Date(fetchedAt), [fetchedAt]);

  const kacheln = useMemo(
    () => (sites && edgeKpi
      ? uebersichtKacheln({ sites, releases, edgeLines, edgeKpi, edgeRollouts }, jetzt)
      : null),
    [sites, releases, edgeLines, edgeKpi, edgeRollouts, jetzt],
  );
  const brauchtDichAlle = useMemo(
    () => uebersichtBrauchtDich({ edgeFleet, fernwartungBoxen, werkstatt, pending }, jetzt),
    [edgeFleet, fernwartungBoxen, werkstatt, pending, jetzt],
  );
  const { aktiv: brauchtDich, erledigt: brauchtDichErledigt } = useMemo(
    () => brauchtDichMitErledigt(brauchtDichAlle, erledigt),
    [brauchtDichAlle, erledigt],
  );
  const groups = useMemo(() => (sites ? fleetBoxGroups(sites, jetzt, releases) : []), [sites, jetzt, releases]);
  const flotte = useMemo(() => uebersichtFlottenbild(groups, edgeFleet), [groups, edgeFleet]);
  const dienste = useMemo(
    () => uebersichtDienste(fernwartung, werkstatt, jetzt, plattformDienste),
    [fernwartung, werkstatt, jetzt, plattformDienste],
  );
  const auffaellig = useMemo(
    () => (sites ? uebersichtAuffaellig(sites, edgeFleet, jetzt) : []),
    [sites, edgeFleet, jetzt],
  );
  const gesamtBoxen = useMemo(() => groups.reduce((n, g) => n + g.boxes.length, 0), [groups]);

  const openRoute = (route: Route) => onNavigate?.(route);

  // Optimistisch: die Ablage antwortet asynchron, aber die Zeile soll
  // SOFORT verschwinden bzw. zurückkommen - ein erneutes `load()` holt den
  // serverseitigen Stand danach ohnehin nach (Poll, 30 s).
  const erledigen = useCallback(async (eintraege: { schluessel: string; stand: string }[]) => {
    if (eintraege.length === 0) return;
    setErledigt((prev) => {
      const next = new Map(prev.map((e) => [e.schluessel, e]));
      const jetztIso = new Date().toISOString();
      // Platzhalter bis `load()` den echten Namen aus der Ablage nachträgt.
      for (const e of eintraege) next.set(e.schluessel, { ...e, erledigtAm: jetztIso, erledigtVon: '…' });
      return [...next.values()];
    });
    try {
      await adminApi.brauchtDichErledigen(eintraege);
    } finally {
      void load();
    }
  }, [load]);

  const wiederherstellen = useCallback(async (schluessel: string) => {
    setErledigt((prev) => prev.filter((e) => e.schluessel !== schluessel));
    try {
      await adminApi.brauchtDichWiederherstellen(schluessel);
    } finally {
      void load();
    }
  }, [load]);

  return (
    <div className="vp-plattform-uebersicht">
      {tabs}
      <AdminPageHead
        icon="dashboard"
        category="primary"
        title="Plattform"
        actions={
          <span className="vp-muted vp-text-sm" data-testid="ueb-stand">
            {!sites ? 'Wird geladen …'
              : loadError ? freshnessLabel(fetchedAt, tick, true)
                : `${freshnessLabel(fetchedAt, tick)} · alle 30 s`}
          </span>
        }
      />

      <DiensteLeiste dienste={dienste} />

      {loadError && sites != null && <div className="vp-alert vp-alert-warn">{loadError}</div>}

      {loadError && sites == null ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : kacheln == null ? (
        <div className="vp-ueb-kacheln" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <Card key={i} style={{ height: 110 }} />)}
        </div>
      ) : sites && sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="sun"
            category="primary"
            title="Noch keine Anlage auf der Plattform"
            description="Sobald ein Mandant seine erste Anlage angelegt hat, steht sie hier."
          />
        </Card>
      ) : (
        <>
          <Kacheln kacheln={kacheln} onNavigate={onNavigate} />

          <div className="vp-ueb-spalten">
            <div className="vp-ueb-spalte">
              <BrauchtDichKarte
                zeilen={brauchtDich}
                erledigte={brauchtDichErledigt}
                onOpen={openRoute}
                onErledigen={(schluessel, stand) => void erledigen([{ schluessel, stand }])}
                onErledigenArt={(art) => void erledigen(
                  brauchtDich.filter((z) => z.art === art).map((z) => ({ schluessel: z.key, stand: z.grund })),
                )}
                onWiederherstellen={(schluessel) => void wiederherstellen(schluessel)}
              />
              <AuffaelligKarte zeilen={auffaellig} />
            </div>
            <div className="vp-ueb-spalte">
              <FlottenbildKarte gruppen={flotte} gesamt={gesamtBoxen} onOpen={openRoute} />
            </div>
          </div>

          <ReiterZeilen onNavigate={onNavigate} fernwartung={fernwartung} werkstatt={werkstatt} software={kacheln.find((k) => k.id === 'software') ?? null} />
        </>
      )}
    </div>
  );
}

// ── Kacheln ─────────────────────────────────────────────────────────────────

function Kacheln({
  kacheln,
  onNavigate,
}: {
  kacheln: UebersichtKachel[];
  onNavigate?: (target: Route) => void;
}) {
  return (
    <div className="vp-ueb-kacheln" data-testid="ueb-kacheln">
      {kacheln.map((k) => (
        <Kachel key={k.id} kachel={k} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/**
 * Nur die Software-Kachel führt irgendwohin (zur Software-Seite, die diese
 * Zahl selbst führt). Verbindung, Steuerung und Plan wohnen (noch) in keiner
 * eigenen gefilterten Fläche - Steuerung und Plan ziehen mit S3 in die Akte ›
 * Anlage, eine eigene Zählung hier vorzugreifen widerspräche „Ein Ort je
 * Fakt".
 */
function Kachel({ kachel, onNavigate }: { kachel: UebersichtKachel; onNavigate?: (target: Route) => void }) {
  const klickbar = kachel.id === 'software' && onNavigate != null;
  const inhalt = (
    <>
      <span className="vp-ueb-kachel-kopf"><Icon name={kachel.icon} size={15} />{kachel.label}</span>
      {klickbar && <span className="vp-ueb-kachel-pfeil"><Icon name="chevron-right" size={16} /></span>}
      <span className={`vp-ueb-kachel-zahl ${kachel.ton}`}>{kachel.zahl}</span>
      <span className="vp-ueb-kachel-wort">{kachel.wort}</span>
      {kachel.kontext && <span className="vp-ueb-kachel-kontext">{kachel.kontext}</span>}
    </>
  );
  return klickbar ? (
    <Card
      className="vp-ueb-kachel vp-ueb-kachel--klick"
      role="button"
      tabIndex={0}
      onClick={() => onNavigate?.(pageRoute('edge-updates'))}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate?.(pageRoute('edge-updates')); }
      }}
    >
      {inhalt}
    </Card>
  ) : (
    <Card className="vp-ueb-kachel">{inhalt}</Card>
  );
}

// ── Braucht dich ────────────────────────────────────────────────────────────

function BrauchtDichKarte({
  zeilen,
  erledigte,
  onOpen,
  onErledigen,
  onErledigenArt,
  onWiederherstellen,
}: {
  zeilen: BrauchtDichZeile[];
  erledigte: BrauchtDichErledigtZeile[];
  onOpen: (route: Route) => void;
  onErledigen: (schluessel: string, stand: string) => void;
  onErledigenArt: (art: BrauchtDichArt) => void;
  onWiederherstellen: (schluessel: string) => void;
}) {
  const [erledigteOffen, setErledigteOffen] = useState(false);

  // Eine Sammel-Handlung nur, wo sie unmissverständlich ist: mindestens zwei
  // Zeilen derselben Art.
  const artenMitMehreren = useMemo(() => {
    const anzahl = new Map<BrauchtDichArt, number>();
    for (const z of zeilen) anzahl.set(z.art, (anzahl.get(z.art) ?? 0) + 1);
    return [...anzahl.entries()].filter(([, n]) => n >= 2);
  }, [zeilen]);

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div className="vp-admin-sec-head">
        <h2>Braucht dich{zeilen.length > 0 ? ` (${zeilen.length})` : ''}</h2>
      </div>
      {artenMitMehreren.length > 0 && (
        <div className="vp-ueb-braucht-sammel">
          {artenMitMehreren.map(([art, n]) => (
            <button key={art} type="button" onClick={() => onErledigenArt(art)}>
              alle {n} „{BRAUCHT_DICH_ART_LABEL[art]}" erledigen
            </button>
          ))}
        </div>
      )}
      {zeilen.length === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <span className="vp-muted">Keine Box braucht dich gerade.</span>
        </div>
      ) : (
        <div className="vp-ueb-braucht-liste" data-testid="ueb-braucht-dich">
          {zeilen.map((z) => (
            <div key={z.key} className="vp-ueb-braucht-zeile" data-testid="ueb-braucht-zeile">
              <button type="button" className="vp-ueb-braucht-zeile-knopf" onClick={() => onOpen(z.route)}>
                <span className="vp-ueb-braucht-kreis"><Icon name={z.icon} size={16} /></span>
                <span className="vp-ueb-braucht-haupt">
                  <b>{z.box}{z.kunde && <span className="vp-ueb-braucht-kunde">{z.kunde}</span>}</b>
                  <small>{z.grund}</small>
                </span>
                <span className="vp-ueb-braucht-schritt">{z.schrittLabel}</span>
                <Icon name="chevron-right" size={16} />
              </button>
              <button
                type="button"
                className="vp-ueb-braucht-erledigt-knopf"
                title="Als erledigt markieren"
                aria-label={`${z.box} als erledigt markieren`}
                onClick={(e) => { e.stopPropagation(); onErledigen(z.key, z.grund); }}
              >
                <Icon name="check" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {erledigte.length > 0 && (
        <div className="vp-ueb-braucht-erledigte">
          <button
            type="button"
            className="vp-ueb-braucht-erledigte-knopf"
            onClick={() => setErledigteOffen((v) => !v)}
            aria-expanded={erledigteOffen}
          >
            <Icon name={erledigteOffen ? 'chevron-down' : 'chevron-right'} size={14} />
            Erledigte anzeigen ({erledigte.length})
          </button>
          {erledigteOffen && (
            <div className="vp-ueb-braucht-erledigte-liste">
              {erledigte.map((z) => (
                <div key={z.key} className="vp-ueb-braucht-erledigte-zeile">
                  <span className="vp-ueb-braucht-erledigte-haupt">
                    <b>{z.box}</b>
                    <small>{z.grund} · erledigt {relAge(Date.now() - Date.parse(z.erledigtAm))} von {z.erledigtVon}</small>
                  </span>
                  <button type="button" onClick={() => onWiederherstellen(z.key)}>zurückholen</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Flottenbild ─────────────────────────────────────────────────────────────

function FlottenbildKarte({
  gruppen,
  gesamt,
  onOpen,
}: {
  gruppen: ReturnType<typeof uebersichtFlottenbild>;
  gesamt: number;
  onOpen: (route: Route) => void;
}) {
  return (
    <Card>
      <div className="vp-admin-sec-head" style={{ padding: 0, marginBottom: 12 }}>
        <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>Flotte</span>
          <span className="vp-muted vp-text-sm">{gesamt} {gesamt === 1 ? 'Box' : 'Boxen'}</span>
        </h2>
      </div>
      {gruppen.length === 0 ? (
        <span className="vp-muted">Noch keine Box verbunden.</span>
      ) : (
        <>
          <div className="vp-ueb-flotte" data-testid="ueb-flotte">
            {gruppen.map((g) => {
              const auffaellig = g.felder.filter((f) => f.ton !== 'ok');
              const ok = g.felder.filter((f) => f.ton === 'ok');
              return (
                <div className={`vp-ueb-flotte-gruppe${auffaellig.length > 0 ? ' vp-ueb-flotte-gruppe--stoerung' : ''}`} key={g.kunde}>
                  <small>
                    {g.kunde} · {g.felder.length}
                    {auffaellig.length > 0 && <span className="vp-ueb-flotte-gruppe-warn"> · {auffaellig.length} auffällig</span>}
                  </small>
                  <div className="vp-ueb-flotte-felder">
                    {auffaellig.map((f) => (
                      <button
                        key={f.ref}
                        type="button"
                        className={`vp-ueb-flotte-chip ${f.ton}`}
                        title={`${f.name}: ${f.title}`}
                        onClick={() => onOpen(geraeteAkteRoute(f.ref))}
                      >
                        <i className={`vp-ueb-flotte-chip-punkt ${f.ton}`} />
                        {f.name}
                      </button>
                    ))}
                    {ok.map((f) => (
                      <button
                        key={f.ref}
                        type="button"
                        className={`vp-ueb-flotte-feld ${f.ton}`}
                        title={`${f.name}: ${f.title}`}
                        onClick={() => onOpen(geraeteAkteRoute(f.ref))}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <Legende />
        </>
      )}
    </Card>
  );
}

function Legende() {
  const EINTRAEGE: { ton: FlottenbildTon; label: string }[] = [
    { ton: 'ok', label: 'verbunden' },
    { ton: 'verzoegert', label: 'verzögert' },
    { ton: 'aus', label: 'meldet sich nicht' },
    { ton: 'nie', label: 'nie gemeldet' },
    { ton: 'lauf', label: 'Update läuft' },
    { ton: 'hand', label: 'nur von Hand' },
  ];
  return (
    <div className="vp-ueb-flotte-legende">
      {EINTRAEGE.map((e) => (
        <span key={e.ton}><i className={e.ton} />{e.label}</span>
      ))}
    </div>
  );
}

// ── Dienste ─────────────────────────────────────────────────────────────────

/**
 * Keine Karte mehr, keine Überschrift „Dienste": eine schmale, ruhige Leiste
 * am Seitenkopf (Punkt + Name + Alter, einzeilig). Nur ein auffälliger Dienst
 * darf hier Ton zeigen - sonst bleibt die Leiste leise. Am Telefon bündelt
 * sie sich auf eine kurze Zeile statt alle Dienste auszuschreiben (echte
 * Verzweigung in JS, nicht nur CSS-`display:none` - die Struktur ändert sich,
 * {@link useIsPhone}).
 */
function DiensteLeiste({ dienste }: { dienste: ReturnType<typeof uebersichtDienste> }) {
  const istTelefon = useIsPhone();
  if (dienste.length === 0) return null;
  const auffaellig = dienste.filter((d) => d.ton === 'warn');

  if (istTelefon) {
    return (
      <div className="vp-ueb-dienste-leiste vp-ueb-dienste-leiste--kurz" data-testid="ueb-dienste">
        <i className={`vp-ueb-dienst-punkt ${auffaellig.length > 0 ? 'warn' : 'ok'}`} />
        {auffaellig.length === 0
          ? <span>alle Dienste ok</span>
          : <span>{auffaellig.length} {auffaellig.length === 1 ? 'Dienst' : 'Dienste'} auffällig</span>}
      </div>
    );
  }
  return (
    <div className={`vp-ueb-dienste-leiste${auffaellig.length > 0 ? ' vp-ueb-dienste-leiste--warn' : ''}`} data-testid="ueb-dienste">
      {dienste.map((d) => (
        <span className="vp-ueb-dienst" key={d.id}>
          <i className={`vp-ueb-dienst-punkt ${d.ton}`} />
          <b>{d.label}</b>
          <small>{d.text}</small>
        </span>
      ))}
    </div>
  );
}

// ── Auffällig ───────────────────────────────────────────────────────────────

function AuffaelligKarte({ zeilen }: { zeilen: ReturnType<typeof uebersichtAuffaellig> }) {
  if (zeilen.length === 0) return null;
  return (
    <Card>
      <div className="vp-admin-sec-head" style={{ padding: 0, marginBottom: 6 }}>
        <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>Auffällig</span>
          <span className="vp-muted vp-text-sm">Tageswerte</span>
        </h2>
      </div>
      <div data-testid="ueb-auffaellig">
        {zeilen.map((z) => (
          <div className="vp-ueb-auffaellig-zeile" key={z.key}>
            <span>{z.ort}</span>
            <span>{z.text}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Telefon: die übrigen Plattform-Reiter als Zeilen ───────────────────────

function ReiterZeilen({
  onNavigate,
  fernwartung,
  werkstatt,
  software,
}: {
  onNavigate?: (target: Route) => void;
  fernwartung: FernwartungUebersicht | null;
  werkstatt: WerkstattDienst | null;
  software: UebersichtKachel | null;
}) {
  const urteil = (id: PageId): string | null => {
    if (id === 'edge-updates') return software ? `${software.zahl} ${software.wortKurz}` : null;
    if (id === 'werkstatt') {
      const laufend = werkstatt?.laeufe.filter((l) => l.zustand !== 'fertig').length ?? 0;
      return laufend > 0 ? `${laufend} in Arbeit` : null;
    }
    if (id === 'fernwartung') return fernwartung ? `${fernwartung.fensterOffen} Fenster offen` : null;
    if (id === 'katalog') return `${KATALOG_BEREICHE} Bereiche`;
    return null;
  };
  return (
    <div className="vp-ueb-reiter-liste" data-testid="ueb-reiter-zeilen">
      {PLATFORM_TAB_PAGES.filter((p) => ['edge-updates', 'werkstatt', 'fernwartung', 'katalog'].includes(p.id)).map((p) => (
        <button
          key={p.id}
          type="button"
          className="vp-ueb-reiter-zeile"
          onClick={() => onNavigate?.(pageRoute(p.id))}
        >
          <Icon name={p.icon} size={18} />
          <span>{p.label}</span>
          <span className="vp-ueb-reiter-urteil">{urteil(p.id)}</span>
          <Icon name="chevron-right" size={16} />
        </button>
      ))}
    </div>
  );
}

const KATALOG_BEREICHE = 4;
