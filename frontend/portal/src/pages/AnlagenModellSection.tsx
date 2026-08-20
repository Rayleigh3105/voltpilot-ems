import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Device,
  type Site,
  type SiteComponents,
  type SiteComponentTemplate,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';
import {
  CONTROL_BADGE,
  EDGE_BOX_HINT,
  GUARD_FOOTNOTE,
  componentActions,
  plantModel,
  reconnectCandidates,
  type ComponentActions,
  type ComponentHealth,
  type PlantComponent,
} from '../komponenten';
import { showTechnicalLayer, type AdoptableSource } from '../rollen';
import { boxRefOf } from '../geraetSeite';
import {
  HINZUFUEGEN_LABEL,
  LISTE_TITEL,
  REGISTER_VERWEIS,
  zentraleListe,
  zentraleSatz,
  type GeraeteKarte,
} from '../zentraleListe';
import type { SiteCharging } from '../ladepunkte';
import { ZuordnenDialog } from '../components/ZuordnenDialog';
import { SchaltFreigabeDrawer } from '../components/SchaltFreigabeDrawer';
import { freigabeZustand } from '../schaltFreigabe';
import {
  REGEL_BRUECKE_LABEL,
  bietetRegelBruecke,
  regelBrueckeHash,
} from '../selbstbauBruecke';
import { UmbenennenDialog } from '../components/UmbenennenDialog';
import {
  KomponenteLoeschenDialog,
  ZuordnungAendernDialog,
} from '../components/ZuordnungAendern';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import { sofortAktionen, SOFORT_LABEL, type SofortAktion } from '../consumers/fulfillment';
import { InfoTip } from '../components/InfoTip';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { fmtNum } from '../format';
import { NO_DATA } from '../nodata';
import { BEFEHLE_LABEL } from '../befehle';
import { anlageRoute, befehleHash, hashForRoute } from '../nav';
import { EntitaetenSection } from './EntitaetenSection';
import { EigeneVorlagenPanel } from '../components/EigeneVorlagenPanel';
import { KomponenteHinzufuegenDrawer } from '../components/KomponenteHinzufuegenDrawer';
import {
  ablehnungText,
  sollIstText,
  sollIstTon,
  verwaltungsHinweis,
} from '../komponentenAssistent';
import '../components/AnlagenModell.css';
import '../components/KomponenteAssistent.css';

/**
 * Portal v3 · M6 — the Anlagen-Modell, rebuilt to the approved **Variante A**
 * (design `data/vp-anlagenmodell-ux-w7`, Captain-Go 2026-07-29).
 *
 * Die Seite beantwortet EINE Frage — „Kennt VoltPilot meine Anlage richtig, und
 * woher kommt jede Zahl?" — und zwar in dieser Reihenfolge: Kopfsatz (Zustand)
 * → die EINE VoltPilot-Box mit den Geräten, die ihr Messwerte liefern → die
 * Komponenten in Rollen-Gruppen MIT Live-Werten und Herkunft → Fußzeile
 * (Schutz-Satz + wo die Komponenten wieder auftauchen). Die frühere dritte
 * Spalte („Ihre Anlage") ist aufgelöst.
 *
 * Tapping a device highlights the components it measures (the interaction of
 * the old layout, kept). A newly reported device is assigned in one move
 * (`ZuordnenDialog`); an orphaned pin leads straight back into the SAME
 * „Wieder verbinden"-Fluss (PR #271) instead of minting a duplicate.
 *
 * The customer dictionary is Gerät / Komponente / Messwert (D3) — the words
 * Entität / Messpunkt / Quelle live only in the admin/installer panel below,
 * gated by the ONE `showTechnicalLayer()` helper (M7). All derivation is the
 * pure `komponenten.ts`; this file only renders.
 */
export function AnlagenModellSection({
  site,
  devices,
  devicesFetchedAt = null,
}: {
  site: Site;
  devices?: Device[];
  /**
   * Bezugszeit der Geräteliste. Die Box-Zeile altert dagegen, nie gegen eine
   * weiterlaufende Wanduhr über einem stehenden Schnappschuss (`liveness.ts`).
   */
  devicesFetchedAt?: number | null;
}) {
  // The ONE technical-layer decision (M7): a platform-admin sees the installer
  // panel added to the same page; a customer never does.
  const showTechnical = showTechnicalLayer();
  const [data, setData] = useState<SiteEntities | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  /**
   * Die Ladesäulen (§13 R7) - FAIL-SOFT: ein älteres Backend kennt die Route
   * nicht, dann fehlt schlicht ihre Karte. Ohne sie war eine Säule bis hierher
   * eine Komponente ohne Messwert (die dokumentierte „bekannte Grenze").
   */
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [assign, setAssign] = useState<AdoptableSource | null>(null);
  const [rename, setRename] = useState<PlantComponent | null>(null);
  const [freigabe, setFreigabe] = useState<PlantComponent | null>(null);
  // Die zwei Bereinigungs-Hebel AN der Komponente (vp-bereinigung-ui-k3).
  const [repin, setRepin] = useState<PlantComponent | null>(null);
  const [remove, setRemove] = useState<PlantComponent | null>(null);
  /**
   * Sofortaktion AN DER KOMPONENTE (Einheitsmodell Stufe 5a, 5b.7): EIN
   * Mechanismus, ZWEI Orte - derselbe Dialog wie im Kopf der Regeln-Kapsel.
   * Fail-soft: ohne steuerbare Verbraucher (älteres Backend, keine Freigabe)
   * erscheint gar kein Knopf, nie ein wirkungsloser.
   */
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  const [sofortBusy, setSofortBusy] = useState(false);
  /**
   * Einheitsmodell Stufe 1: der EINE Anlege-Assistent + der Soll/Ist-Stand.
   * FAIL-SOFT geholt - ein älteres Backend kennt die Route nicht, dann bleibt
   * die Fläche exakt wie vorher (kein Knopf, keine Stand-Zeile).
   */
  const [components, setComponents] = useState<SiteComponents | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Einheitsmodell Stufe 6: aus einer EIGENEN Vorlage ein Gerät machen - der
  // Assistent öffnet dann direkt in der Selbstbau-Tür, vorbefüllt.
  const [vorlage, setVorlage] = useState<SiteComponentTemplate | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    // Topology fail-soft (a v1/un-migrated site simply lacks it — the model
    // still renders from the entities + local setup, then without live values).
    api.topology(site.id).then(
      (t) => active && setTopology(t),
      () => active && setTopology(null),
    );
    // The reported measurement points (`/sources`), fail-soft — they carry the
    // honest per-inverter PV split the energy flow uses (F1 caveat).
    api.siteSources(site.id).then(
      (s) => active && setSources(s),
      () => active && setSources(null),
    );
    api.siteChargers(site.id).then(
      (c) => active && setCharging(c),
      () => active && setCharging(null),
    );
    // Der Autoritäts- und Soll/Ist-Stand (Stufe 1), fail-soft.
    api.siteComponents(site.id).then(
      (c) => active && setComponents(c),
      () => active && setComponents(null),
    );
    // Die steuerbaren Verbraucher — nur für die Sofortaktion an der Zeile.
    consumersApi.list(site.id).then(
      (list) => active && setConsumers(list ?? []),
      () => active && setConsumers([]),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const runSofort = async (durationMinutes?: number) => {
    if (!sofort) return;
    const { consumer: c, action } = sofort;
    setSofortBusy(true);
    try {
      if (action === 'resume') await consumersApi.clearOverride(site.id, c.id);
      else await consumersApi.startOverride(site.id, c.id, { action, durationMinutes });
      setSofort(null);
    } catch {
      // Die Fläche ist eine ANZEIGE - ein fehlgeschlagener Eingriff darf sie
      // nicht in einen Fehlerzustand kippen; der Dialog schließt einfach.
      setSofort(null);
    } finally {
      setSofortBusy(false);
    }
  };

  const reload = () => setReloadKey((k) => k + 1);

  const model = useMemo(
    () => (data ? plantModel(data.entities, topology, data.localSetup, sources) : null),
    [data, topology, sources],
  );

  /**
   * Die Referenz der EINEN Box - der Schlüssel jeder Geräteseite. Ohne sie
   * (keine oder mehrere Boxen) wird KEIN Weg angeboten, statt einen zu raten.
   */
  const boxRef = useMemo(() => boxRefOf(devices, site.id), [devices, site.id]);

  /** Die vereinte Liste (§13) - EIN Aufruf, alles Übrige rendert nur. */
  const karten = useMemo(
    () =>
      model
        ? zentraleListe({
            siteId: site.id,
            model,
            devices: (devices ?? []).filter((d) => d.siteId === site.id),
            devicesFetchedAt,
            boxRef,
            localSetup: data?.localSetup ?? null,
            sources,
            charging,
          })
        : [],
    [model, site.id, devices, devicesFetchedAt, boxRef, data, sources, charging],
  );
  const satz = useMemo(() => zentraleSatz(karten), [karten]);

  const isEmpty =
    model != null &&
    model.devices.length === 0 &&
    model.components.length === 0 &&
    model.newlyReported.length === 0;

  /**
   * Einheitsmodell Stufe 1. Der Assistent erscheint NUR auf einer
   * portal-verwalteten Anlage: auf einer box-verwalteten Bestandsanlage würde
   * ein gespeichertes Soll nie wirken, und ein Knopf, der in eine ehrliche
   * Ablehnung läuft, ist schlechter als kein Knopf.
   */
  const portalManaged = components?.componentAuthority === 'portal';
  const komponentenStand = components
    ? {
        text: sollIstText(
          components.components[0]?.syncStatus,
          components.components[0]?.definitionVersion ?? 1,
        ),
        ton: sollIstTon(components.components[0]?.syncStatus),
      }
    : null;
  const ablehnung = ablehnungText(components?.refusedRevision, components?.refusedReason);
  /*
    Einheitsmodell Stufe 2: EIN Satz, der sagt, wo gepflegt wird. Er erscheint
    nur, wenn es etwas zu erklären gibt - eine Anlage, die immer schon im Portal
    entstanden ist, schweigt.
  */
  const verwaltung = components
    ? verwaltungsHinweis(components.componentAuthority, components.adoptedAt)
    : null;

  return (
    <div className="vp-modell">
      <Card className="vp-modell-card">
        {!data && !error && <TextSkeleton lines={5} />}
        {error && (
          <ErrorState message="Das Anlagen-Modell konnte nicht geladen werden." onRetry={reload} />
        )}
        {model && isEmpty && (
          <EmptyState
            icon="layers"
            category="primary"
            title="Noch keine Komponenten"
            description="Sobald Ihr Gerät sich meldet, erscheint hier, wie Ihre Anlage verschaltet ist."
          />
        )}

        {model && !isEmpty && (
          <>
            {/* 1 · EIN Satz über die Gesundheit + der EINE Anlege-Knopf (D6).
                Die frühere Vier-Zahlen-Kopfzeile ist ersetzt: die Zahlen stehen
                in den Karten darunter, hier steht die Antwort auf „geht es
                meiner Anlage gut?". */}
            <div className="vp-am-kopf">
              <p className={`vp-am-headline${satz.ton === 'warn' ? ' warn' : ''}`}>
                <span className={`vp-health-dot vp-health-${satz.ton}`} />
                <span>{satz.text}</span>
              </p>
              {portalManaged && (
                <button type="button" className="vp-am-add" onClick={() => setAddOpen(true)}>
                  <Icon name="plus" size={14} /> {HINZUFUEGEN_LABEL}
                </button>
              )}
            </div>

            {/* 2 · EINE Liste: je Gerät eine Karte, je Komponente eine Zeile
                darin (§13 R1/R2). Die frühere Doppelung - dasselbe Ding einmal
                als Geräte-Kachel und einmal als Komponenten-Zeile - ist damit
                strukturell aufgelöst. */}
            <section aria-label={LISTE_TITEL} className="vp-am-liste">
              <p className="vp-am-box-hint">{EDGE_BOX_HINT}</p>
              {verwaltung && <p className="vp-am-stand is-unbekannt">{verwaltung}</p>}
              {komponentenStand && (
                <p className={`vp-am-stand is-${komponentenStand.ton}`}>{komponentenStand.text}</p>
              )}
              {ablehnung && <p className="vp-am-stand is-warn">{ablehnung}</p>}

              {karten.map((k) => (
                <GeraeteKarteView
                  key={k.id}
                  karte={k}
                  siteId={site.id}
                  onAssign={setAssign}
                  onRename={setRename}
                  onFreigabe={setFreigabe}
                  onRegelBruecke={(c) => {
                    window.location.hash = regelBrueckeHash(site.id, c.entityId);
                  }}
                  actionsFor={(c) =>
                    componentActions(
                      c,
                      data?.entities.find((e) => e.id === c.entityId),
                    )
                  }
                  onRepin={setRepin}
                  onRemove={setRemove}
                  sofortFor={(c) =>
                    consumers.find((x) => x.id === c.entityId && x.connection === 'connected') ??
                    null
                  }
                  onSofort={(consumer, action) => setSofort({ consumer, action })}
                />
              ))}

              {/*
                Einheitsmodell Stufe 6: die EIGENEN Vorlagen dieser Anlage. Sie
                wohnen bei den Geräten, weil sie aus einem entstehen und zu
                einem führen - und nur dort, wo das Portal die Geräte verwaltet.
              */}
              {portalManaged && <EigeneVorlagenPanel siteId={site.id} onAnlegen={setVorlage} />}
            </section>

            {/* 3 · Die Fußzeile: Schutz-Satz, wo die Komponenten wieder
                auftauchen - und der EINE Register-Verweis (§6.2). Rollen-Summen
                stehen bewusst NICHT hier (R8): die Zentrale beantwortet „WAS ist
                meine Anlage", nicht „wie viel gerade". */}
            <div className="vp-am-foot">
              {GUARD_FOOTNOTE}
              <div className="vp-am-links">
                <span>Diese Komponenten begegnen Ihnen überall:</span>
                <a href={hashForRoute(anlageRoute(site.id))}>→ Cockpit</a>
                <a href={hashForRoute(anlageRoute(site.id, 'messwerte'))}>→ Messwerte</a>
                <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>→ Steuerung</a>
              </div>
              <p className="vp-am-register-hint">{REGISTER_VERWEIS}</p>
            </div>
          </>
        )}
      </Card>

      {/* The technical/installer view (entity types, raw channels, guard bands,
          Soll/Ist sync, registry) is gated behind the ONE showTechnicalLayer()
          helper (M7). Nothing was deleted; it just no longer frames the
          customer, and only a platform-admin ever sees it. */}
      {showTechnical && (
        <details className="vp-modell-installer">
          <summary>
            <Icon name="settings" size={16} /> Installateur-Ansicht (technisch)
          </summary>
          <EntitaetenSection site={site} isAdmin={showTechnical} />
        </details>
      )}

      <ConsumerOverrideDialog
        action={sofort?.action ?? null}
        consumerName={sofort?.consumer.name ?? ''}
        effectivePowerKw={sofort ? Number(sofort.consumer.ratedPowerKw) : null}
        busy={sofortBusy}
        onConfirm={(m) => void runSofort(m)}
        onCancel={() => setSofort(null)}
      />

      {assign && (
        <ZuordnenDialog
          siteId={site.id}
          source={assign}
          candidates={data ? reconnectCandidates(assign, data.entities) : []}
          onClose={() => setAssign(null)}
          onAssigned={() => {
            setAssign(null);
            reload();
          }}
        />
      )}

      {(addOpen || vorlage) && (
        <KomponenteHinzufuegenDrawer
          siteId={site.id}
          vorlage={vorlage}
          onClose={() => {
            setAddOpen(false);
            setVorlage(null);
          }}
          onSaved={(result) => {
            setComponents(result);
            reload();
          }}
        />
      )}

      {freigabe && (
        <SchaltFreigabeDrawer
          open
          siteId={site.id}
          entityId={freigabe.entityId}
          komponentenName={freigabe.label}
          bereitsFreigegeben={freigabe.schaltbar}
          leistungJetztKw={freigabe.reading?.unit === 'kW' ? freigabe.reading.value : null}
          onClose={() => setFreigabe(null)}
          onChanged={reload}
        />
      )}

      {rename && (
        <UmbenennenDialog
          siteId={site.id}
          target={{
            entityId: rename.entityId,
            alias: rename.alias,
            derivedLabel: rename.derivedLabel,
          }}
          onClose={() => setRename(null)}
          onSaved={() => {
            setRename(null);
            reload();
          }}
        />
      )}

      {repin && data && (
        <ZuordnungAendernDialog
          siteId={site.id}
          component={repin}
          entities={data.entities}
          localSetup={data.localSetup}
          sources={sources}
          onClose={() => setRepin(null)}
          onSaved={() => {
            setRepin(null);
            reload();
          }}
        />
      )}

      {remove && data && (
        <KomponenteLoeschenDialog
          siteId={site.id}
          component={remove}
          entities={data.entities}
          localSetup={data.localSetup}
          onClose={() => setRemove(null)}
          onDeleted={() => {
            setRemove(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

const HEALTH_TONE: Record<ComponentHealth, 'ok' | 'warn' | 'off'> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  // H2: „noch keine Rückmeldung" is grey, never green.
  unknown: 'off',
};

/**
 * EINE Karte der vereinten Liste: ein GERÄT als Rahmen, seine Komponenten als
 * ZEILEN (§13 R1/R2). Die Zeile ist wörtlich die von vorher - Umbenennen,
 * Zuordnung ändern, Löschen, Freigabe, „Regel erstellen" und Befehle bleiben an
 * ihr, nur der Ort wechselt.
 */
function GeraeteKarteView({
  karte,
  siteId,
  onAssign,
  onRename,
  onFreigabe,
  onRegelBruecke,
  actionsFor,
  onRepin,
  onRemove,
  sofortFor,
  onSofort,
}: {
  karte: GeraeteKarte;
  siteId: string;
  onAssign: (s: AdoptableSource) => void;
  onRename?: (c: PlantComponent) => void;
  onFreigabe?: (c: PlantComponent) => void;
  onRegelBruecke?: (c: PlantComponent) => void;
  actionsFor: (c: PlantComponent) => ComponentActions;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  sofortFor: (c: PlantComponent) => Consumer | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
}) {
  const k = karte;
  return (
    <section className={`vp-am-karte is-${k.art}`} aria-label={k.titel}>
      <div className="vp-am-karte-head">
        <span className={`vp-health-dot vp-health-${k.ton}`} />
        <span className="nm">{k.titel}</span>
        <span className="ty">{k.untertitel}</span>
        <span className={`st${k.ton === 'warn' ? ' warn' : ''}`}>{k.zustand}</span>
        {/* Ein Weg, der strukturell nirgends hinführt, wird gar nicht erst
            angeboten - stattdessen steht bei „neu" die Übernahme. */}
        {/* ⚠ „Geräteseite", nicht „Details": die Komponenten-ZEILE in derselben
            Karte hat ihren eigenen „Details"-Aufklapper - zweimal dasselbe Wort
            auf einer Karte für zwei verschiedene Ziele wäre genau die
            Doppeldeutigkeit, die die Haus-Regel verbietet. Es benennt zudem das
            ZIEL statt eine Geste. */}
        {k.href && (
          <a className="vp-am-karte-go" href={k.href}>
            Geräteseite <Icon name="chevron-right" size={14} />
          </a>
        )}
        {k.art === 'neu' && k.quelle && (
          <button
            type="button"
            className="vp-am-karte-go"
            onClick={() => onAssign(k.quelle as AdoptableSource)}
          >
            Übernehmen <Icon name="chevron-right" size={14} />
          </button>
        )}
      </div>
      {k.zusatz && <p className="vp-am-karte-sub">{k.zusatz}</p>}
      {k.komponenten.length > 0 && (
        <div className="vp-am-karte-rows">
          {k.komponenten.map((c) => (
            <ComponentRow
              key={c.id}
              component={c}
              siteId={siteId}
              onRename={onRename}
              onFreigabe={onFreigabe}
              onRegelBruecke={onRegelBruecke}
              actions={actionsFor(c)}
              onRepin={onRepin}
              onRemove={onRemove}
              sofort={sofortFor(c)}
              onSofort={onSofort}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The §14a explanation, once, where the maßgebliche Messung is named. */
const PARAGRAF_14A =
  'Am maßgeblichen Netzanschluss zählt, was Sie beziehen und einspeisen. Verlangt Ihr ' +
  'Netzbetreiber kurzzeitig weniger Bezug (§ 14a EnWG), hält VoltPilot diese Grenze ein.';

/** One Komponente: name, Herkunft, Steuer-Abzeichen, Live-Wert. */
function ComponentRow({
  component,
  siteId,
  onRename,
  onFreigabe,
  onRegelBruecke,
  actions,
  onRepin,
  onRemove,
  sofort,
  onSofort,
}: {
  component: PlantComponent;
  /** Für den Absprung in den Befehls-Verlauf DIESER Komponente. */
  siteId: string;
  onRename?: (c: PlantComponent) => void;
  onFreigabe?: (c: PlantComponent) => void;
  /** Die Brücke (Stufe 4, Anforderung 9): Regel mit dieser Komponente erstellen. */
  onRegelBruecke?: (c: PlantComponent) => void;
  actions: ComponentActions;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  sofort: Consumer | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
}) {
  const c = component;
  return (
    <div className="vp-am-comp">
      <div className="vp-am-comp-main">
        <span className="vp-am-comp-name">
          {/* Seit der vereinten Liste (§13) ist der Name reiner TEXT: das
              frühere „Antippen markiert, was ein Gerät misst" ist überflüssig -
              was ein Gerät misst, steht jetzt IN seiner Karte. Ein Knopf ohne
              Wirkung wäre schlechter als keiner. */}
          <span className="vp-am-comp-btn">
            <span className={`vp-health-dot vp-health-${HEALTH_TONE[c.health]}`} />
            {c.label}
          </span>
          {c.primary && <InfoTip title="Maßgebliche Messung">{PARAGRAF_14A}</InfoTip>}
        </span>
        <span className="vp-am-comp-sub">
          {c.provenance && (
            <span className="vp-am-prov">
              <Icon name="cpu" size={11} />
              {c.provenance}
            </span>
          )}
          {c.control && (
            <span className="vp-am-ctrl">
              <Icon name="shield" size={12} />
              {CONTROL_BADGE}
            </span>
          )}
          {/* Der FREIGABE-Zustand (Einheitsmodell Stufe 4, Anforderung 8): EINE
              Anzeige über alle drei Vertrauens-Stufen - und „gesperrt" ist ein
              ZUSTAND, kein Fehler, deshalb der ruhige Ton. Er steht nur, wo er
              etwas aussagt: an einem Gerät, das schaltet oder es könnte. */}
          {(c.schaltbar || c.freigabeFaehig) && (() => {
            const z = freigabeZustand({ schaltbar: c.schaltbar, quelle: c.freigabeQuelle });
            return (
              <span className={`vp-am-freigabe is-${z.ton}`} title={z.satz}>
                <Icon name={z.ton === 'ok' ? 'zap' : 'shield'} size={12} />
                {z.wort}
              </span>
            );
          })()}
          <span>{c.summary}</span>
        </span>
        {/* Identity churn (vp-vier-erzeuger-p9): the pinned device vanished from
            the report — honest amber state plus the way back into the existing
            „Wieder verbinden"-Fluss, instead of a silent duplicate. */}
        {c.orphaned && (
          <span className="vp-am-orphan">
            <Icon name="alert-triangle" size={14} />
            nicht mehr mit einem gemeldeten Gerät verbunden
            {/* Der Weg zurück steht DIREKT neben der Warnung — vorher hing er am
                „Wieder verbinden"-Dialog eines NEU gemeldeten Geräts, den es auf
                einer voll zugeordneten Anlage gar nicht gibt. */}
            {actions.canRepin && (
              <button type="button" className="vp-am-orphan-btn" onClick={() => onRepin(c)}>
                wieder verbinden
              </button>
            )}
            {actions.canDelete && (
              <button
                type="button"
                className="vp-am-orphan-btn danger"
                onClick={() => onRemove(c)}
              >
                löschen
              </button>
            )}
          </span>
        )}
        {/* F1 caveat: a producer read through the inverter has no own series — a
            plain dot would read „noch keine Daten" forever. */}
        {c.measuredVia && c.reading == null && <span className="vp-am-note">{c.measuredVia}</span>}
      </div>

      {/* Every real component may be named - including the platform-composed
          battery / grid / house rows. The PV ASPECT row is the one exception
          (`renameable: false`): it belongs to its carrier and follows its name. */}
      {onRename && c.renameable && (
        <button
          type="button"
          className="vp-am-pencil"
          aria-label={`„${c.label}“ umbenennen`}
          onClick={() => onRename(c)}
        >
          <Icon name="pencil" size={15} />
        </button>
      )}

      <span className={`vp-am-comp-val${c.reading ? '' : ' none'}`}>
        {c.reading ? fmtNum(c.reading.value, c.reading.unit) : NO_DATA}
        {c.reading?.caption && <small>{c.reading.caption}</small>}
      </span>

      {/* Die Bereinigung wohnt hier: an einer gesunden Komponente ruhig im
          Details-Bereich, an einer verwaisten prominent neben der Warnung. */}
      {(c.channels.length > 0 || sofort != null || c.entityId != null
        || (c.freigabeFaehig && onFreigabe != null)
        || (!c.orphaned && (actions.canRepin || actions.canDelete))) && (
        <details className="vp-am-details">
          <summary>
            <Icon name="chevron-right" size={12} /> Details
          </summary>
          {c.channels.length > 0 && (
            <span className="vp-am-chips">
              {c.channels.map((ch) => (
                <span key={ch.raw} title={ch.raw}>
                  {ch.label}
                </span>
              ))}
            </span>
          )}
          {/* Sofortaktion (5b.7): derselbe Mechanismus wie im Kopf der
              Regeln-Kapsel, hier AN der Komponente. Nur für ein verbundenes,
              steuerbares Gerät - nie ein wirkungsloser Knopf. */}
          {sofort && (
            <span className="vp-am-actions">
              {sofortAktionen({ connected: true, hasOverride: false }).map((a) => (
                <button
                  key={a}
                  type="button"
                  className="vp-am-action"
                  onClick={() => onSofort(sofort, a)}
                >
                  <Icon name="zap" size={13} /> {SOFORT_LABEL[a]}
                </button>
              ))}
            </span>
          )}
          {/* Die Freigabe ist ein EIGENER, bewusst getrennter Schritt an der
              fertigen Komponente - nie ein fünfter Schritt des Anlege-Wegs. */}
          {c.freigabeFaehig && onFreigabe && (
            <span className="vp-am-actions">
              <button type="button" className="vp-am-action" onClick={() => onFreigabe(c)}>
                <Icon name="zap" size={13} />
                {c.schaltbar ? 'Steuerung dieses Geräts' : 'Steuern freigeben'}
              </button>
            </span>
          )}
          {/* Die BRÜCKE (Stufe 4, Anforderung 9): ein freigegebener Schalter ist
              danach die AKTION der vorbefüllten Regel. Sie wird nur angeboten,
              wo es etwas zu bedingen gibt - ohne Messwert wäre der Absprung eine
              Sackgasse mit Extraschritt. */}
          {onRegelBruecke && bietetRegelBruecke({
            entityId: c.entityId,
            label: c.label,
            channels: c.channels.map((m) => ({ channel: m.raw })),
          }) && (
            <span className="vp-am-actions">
              <button
                type="button"
                className="vp-am-action"
                onClick={() => onRegelBruecke(c)}
              >
                <Icon name="zap" size={13} /> {REGEL_BRUECKE_LABEL}
              </button>
            </span>
          )}
          {/* Der BEFEHLS-VERLAUF (Kommando-Transparenz V1, F2/F4): an JEDER
              echten Komponente, auch an einer nur gelesenen - dort IST „wir
              schicken nichts" die Antwort, die zwei Untersuchungsrunden
              gekostet hat. Die PV-Aspekt-Zeile hat keine eigene Entität und
              bekommt deshalb keinen. */}
          {c.entityId && (
            <span className="vp-am-actions">
              <a className="vp-am-action" href={befehleHash(siteId, c.entityId)}>
                <Icon name="shield" size={13} /> {BEFEHLE_LABEL}
              </a>
            </span>
          )}
          {!c.orphaned && (actions.canRepin || actions.canDelete) && (
            <span className="vp-am-actions">
              {actions.canRepin && (
                <button type="button" className="vp-am-action" onClick={() => onRepin(c)}>
                  <Icon name="link" size={13} /> Zuordnung ändern
                </button>
              )}
              {actions.canDelete && (
                <button
                  type="button"
                  className="vp-am-action danger"
                  onClick={() => onRemove(c)}
                >
                  <Icon name="trash" size={13} /> Komponente löschen
                </button>
              )}
            </span>
          )}
        </details>
      )}
    </div>
  );
}

