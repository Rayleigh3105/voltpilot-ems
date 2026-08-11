/**
 * Die Kapsel **„Regeln"** der Steuerung (Einheitsmodell Stufe 5a, Konzept
 * `vp-komponenten-einheit-h2` Teil 5 + 5b; Naming Set A).
 *
 * Sie ist der EINE Logik-Ort: hier stehen die Wenn/Dann-Regeln UND die
 * Verbraucher-Regeln als Karten nebeneinander — die frühere eigene Seite
 * „Verbraucher" ist damit aufgelöst (ihre Einschübe leben unverändert in
 * `VerbraucherDrawers.tsx` weiter und werden von hier gehostet).
 *
 * Es wird hier NICHTS abgeleitet: Karten, Zustände, Sortierung, Sätze und die
 * Rezept-Galerie kommen aus den reinen Modulen `regeln/*`; diese Datei lädt,
 * rendert und ruft die BESTEHENDEN Endpunkte.
 *
 * Ehrlichkeiten, die man beim Anfassen kennen muss:
 *  - **Jeder Zusatz-Abruf ist fail-soft.** Nur die Flow-Liste ist tragend (sie
 *    kommt von der Steuerung); Verbraucher, Zustände, Eingriffe, Nachweise,
 *    Regel-Dokumente und Geräte-Bestätigungen dürfen fehlen — dann ist die
 *    Fläche ruhiger, nie kaputt.
 *  - **AUS geht immer, AN prüft der Server erneut.** Eine Ablehnung bleibt AUS
 *    und zeigt den deutschen Server-Grund — nie ein Schein-Erfolg.
 *  - **Der Verlauf wird in dieser Stufe nicht aufgezeichnet** (Stufe 5b), und
 *    der Einschub sagt das; es gibt hier keinen Schaltzähler.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import {
  ApiError, api,
  type EntityStrategy, type RuleEvents, type Site, type SiteTopology,
} from '../api';
import { PartHead } from './SteuerungParts';
import { ConsumerOverrideDialog } from './ConsumerOverrideDialog';
import { NeueRegelDialog } from './NeueRegelDialog';
import { RegelDrawer } from './RegelDrawer';
import { RegelKarteView, SofortBanner } from './RegelKarten';
import { RegelProtokoll } from './RegelProtokoll';
import { RezeptGalerieView } from './RezeptGalerie';
import { VerbraucherAnlegenDrawer, VerbraucherRegelDrawer } from './VerbraucherDrawers';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer, ConsumerOptions, ConsumerPolicyVersion } from '../consumers/types';
import type { ConsumerDraft } from '../consumers/questions';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { ConsumerFulfilment, ManualOverride, SofortAktion } from '../consumers/fulfillment';
import { policySentence } from '../consumers/policy';
import { parseVerbraucherParams, templateConsumer } from '../consumers/vorlagen';
import { buildGuidedFlow, parseGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import type { BoundFlowApi, FlowDeviceAck, FlowSummary } from '../flows/flowsApi';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { rolloutMessage } from '../flows/rollout';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { showTechnicalLayer } from '../rollen';
import {
  istVerbraucherRezept,
  rezept,
  rezeptGalerie,
  rezeptPrefill,
  speicherSchutzRegel,
  type RezeptId,
} from '../regeln/rezepte';
import { regelDetail } from '../regeln/detail';
import { protokoll as protokollView } from '../regeln/verlauf';
import {
  istGenerierteVerbraucherregel,
  regelKarten,
  sofortBanner,
  type RegelKarte,
  type RezeptRegelInput,
} from '../regeln/zustand';
import {
  NEUE_REGEL_LABEL,
  REGEL_CAPSULE_INTRO,
  REGEL_CAPSULE_TITLE,
} from '../steuerungArea';
import './Regeln.css';

type CondKind = 'entity' | 'price' | 'schedule';

/** Die Folgenliste des Hauses, bevor eine Regel verschwindet. */
export function loeschFolgen(karte: RegelKarte): string[] {
  if (karte.art === 'rezept') {
    return [
      'Die Regel wird abgeschaltet — VoltPilot sendet dafür keine Befehle mehr.',
      'Ihr Gerät fällt auf seine sichere Grundeinstellung zurück.',
      'Das Gerät selbst bleibt bestehen; Sie finden es im Anlagen-Modell.',
    ];
  }
  return [
    'Die Regel wird gelöscht und läuft danach nicht mehr auf Ihrem Gerät.',
    'Ihre Komponenten bleiben unverändert bestehen.',
    'Frühere Versionen dieser Regel sind danach nicht mehr abrufbar.',
  ];
}

export function RegelnKapsel({
  site,
  flows,
  entities,
  topology = null,
  flowApi,
  lockedKinds,
  lockedHint,
  busy,
  onBusy,
  onError,
  onReload,
  onOpenFlow,
  onBuiltFlow,
  onEditedFlow,
  onOpenEditor,
}: {
  site: Site;
  flows: FlowSummary[];
  entities: EditorEntity[];
  topology?: SiteTopology | null;
  flowApi: BoundFlowApi;
  lockedKinds: CondKind[];
  lockedHint: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  /** Die Flow-Liste der Steuerung neu laden. */
  onReload: () => void;
  onOpenFlow: (flowId: string, version: number, doc: FlowDocument | null) => void;
  onBuiltFlow: (name: string, doc: FlowDocument) => void;
  /** Eine BESTEHENDE Regel wurde im Baukasten überarbeitet. */
  onEditedFlow: (flowId: string, version: number, name: string, doc: FlowDocument) => void;
  onOpenEditor: () => void;
}) {
  const [options, setOptions] = useState<ConsumerOptions | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [status, setStatus] = useState<ConsumerRuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  const [fulfillment, setFulfillment] = useState<Record<string, ConsumerFulfilment>>({});
  const [policies, setPolicies] = useState<Record<string, ConsumerPolicyVersion | null>>({});
  const [acks, setAcks] = useState<FlowDeviceAck[]>([]);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]>>({});
  const [ruleEvents, setRuleEvents] = useState<RuleEvents | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [ruleFor, setRuleFor] = useState<Consumer | null>(null);
  const [rulePrefill, setRulePrefill] = useState<Partial<ConsumerDraft> | null>(null);
  const [bearbeiten, setBearbeiten] = useState<
  { flow: FlowSummary; rule: GuidedRule } | null>(null);
  const [eingreifen, setEingreifen] = useState(false);
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  const deepLinkDone = useRef(false);

  const reloadConsumers = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    // Alles hier ist ZUSATZ - jede Zusage ist fail-soft, damit ein älteres
    // Backend oder ein 403 die Kapsel nur ruhiger macht, nie blockiert.
    consumersApi.options(site.id).then((o) => alive && setOptions(o)).catch(() => {});
    api.entityStrategies(site.id).then((s) => alive && setStrategies(s ?? {})).catch(() => {});
    consumersApi.status(site.id).then((s) => alive && setStatus(s ?? [])).catch(() => {});
    // Das Regel-Protokoll (Stufe 5b) - fail-soft wie alles hier: ein
    // älteres Backend kennt die Route nicht, dann bleibt die Fläche
    // zeichengleich zu Stufe 5a.
    api.siteRuleEvents(site.id).then((r) => alive && setRuleEvents(r ?? null))
      .catch(() => {});
    consumersApi.overrides(site.id).then((o) => alive && setOverrides(o ?? [])).catch(() => {});
    // Die Geräte-Bestätigung je Regel; der Aufruf steht IM Promise, damit auch
    // ein Client ohne diese Route (älteres Backend) nur still nichts liefert.
    Promise.resolve()
      .then(() => flowApi.liveStatus())
      .then((s) => alive && setAcks(s?.acks ?? []))
      .catch(() => {});
    consumersApi
      .list(site.id)
      .then(async (list) => {
        if (!alive) return;
        setConsumers(list ?? []);
        const mitRegel = (list ?? []).filter(
          (c) => c.hasDraftPolicy || c.controlActivation !== 'not_activated',
        );
        const paare = await Promise.all(mitRegel.map((c) => Promise.all([
          consumersApi.getPolicy(site.id, c.id).catch(() => null),
          consumersApi.fulfillment(site.id, c.id).catch(() => ({ tasks: [] })),
        ]).then(([p, f]) => [c.id, p, f] as const)));
        if (!alive) return;
        setPolicies(Object.fromEntries(paare.map(([id, p]) => [id, p])));
        setFulfillment(Object.fromEntries(paare.map(([id, , f]) => [id, f])));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [site.id, flowApi, reloadKey]);

  /**
   * Die Karten: Flow-Regeln OHNE die aus einer Verbraucherregel GENERIERTEN
   * (die erscheinen GENAU EINMAL — als Rezept-Karte ihres Verbrauchers), plus
   * je Verbraucher mit gespeicherter Regel eine Rezept-Karte.
   */
  const karten = useMemo(() => {
    const anyStatusReported = status.length > 0;
    const rezepte: RezeptRegelInput[] = consumers
      .filter((c) => c.hasDraftPolicy || c.controlActivation !== 'not_activated')
      .map((c) => {
        const policy = policies[c.id];
        return {
          consumer: c,
          status: status.find((s) => s.entityId === c.id) ?? null,
          fulfilment: fulfillment[c.id] ?? null,
          override: overrides.find((o) => o.entityId === c.id) ?? null,
          satz: policy ? policySentence(policy.document, c.name) : null,
          anyStatusReported,
        };
      });
    return regelKarten({
      entities,
      rezepte,
      protokoll: ruleEvents,
      flows: flows
        .filter((f) => !istGenerierteVerbraucherregel(f.latestDocument))
        .map((f) => ({
          flowId: f.flowId,
          name: f.name,
          activeVersion: f.activeVersion,
          latestVersion: f.latestVersion,
          latestLifecycle: f.latestLifecycle,
          latestDocument: f.latestDocument ?? null,
          ack: acks.find((a) => a.flowId === f.flowId) ?? null,
        })),
    });
  }, [flows, acks, consumers, status, fulfillment, overrides, policies, entities, ruleEvents]);

  const namen = useMemo(
    () => Object.fromEntries(consumers.map((c) => [c.id, c.name])),
    [consumers],
  );
  // Das Gesamt-Protokoll spricht die NAMEN der Karten - ein Ereignis ohne
  // zuordenbare Regel bleibt sichtbar, nennt aber keine (nie eine geratene).
  const protokoll = useMemo(
    () => protokollView(ruleEvents, Object.fromEntries(karten.map((k) => [k.key, k.name]))),
    [ruleEvents, karten],
  );
  const banner = useMemo(() => sofortBanner(overrides, namen), [overrides, namen]);
  const galerie = useMemo(() => rezeptGalerie({ entities, topology }), [entities, topology]);
  const steuerbare = useMemo(
    () => consumers.filter((c) => c.connection === 'connected'),
    [consumers],
  );

  // --- Deep link (?vorlage= / ?verbraucher=) --------------------------------
  useEffect(() => {
    if (deepLinkDone.current || consumers.length === 0) return;
    const params = parseVerbraucherParams(window.location.hash);
    if (!params.vorlage && !params.verbraucher) {
      deepLinkDone.current = true;
      return;
    }
    deepLinkDone.current = true;
    window.history.replaceState(null, '', window.location.hash.split('?')[0]);
    if (params.verbraucher) {
      const c = consumers.find((x) => x.id === params.verbraucher);
      if (c) setRuleFor(c);
      return;
    }
    const prefill = params.vorlage ? rezeptPrefill(params.vorlage) : null;
    if (!prefill) return;
    const c = templateConsumer(params.vorlage as string, consumers);
    if (c) {
      setRulePrefill(prefill);
      setRuleFor(c);
    } else {
      setWizard(true);
    }
  }, [consumers]);

  // --- Ein Rezept wählen ----------------------------------------------------
  const waehleRezept = useCallback((id: RezeptId) => {
    setCreating(false);
    const def = rezept(id);
    if (!def) return;
    if (istVerbraucherRezept(id)) {
      const c = templateConsumer(id, consumers);
      if (!c) {
        // Kein passendes Gerät: erst die Komponente, dann die Regel — nie eine
        // Sackgasse (die k6-Brücke).
        setWizard(true);
        return;
      }
      setRulePrefill(rezeptPrefill(id));
      setRuleFor(c);
      return;
    }
    if (id === 'storage-protect') {
      const rule = speicherSchutzRegel(entities);
      if (!rule) {
        onError('Für dieses Rezept braucht Ihre Anlage einen Speicher und ein steuerbares Gerät.');
        return;
      }
      onBuiltFlow(def.titel, buildGuidedFlow(rule, def.titel, site.id));
    }
  }, [consumers, entities, onBuiltFlow, onError, site.id]);

  // --- Schnellschalter ------------------------------------------------------
  const toggle = useCallback(async (karte: RegelKarte, an: boolean) => {
    onBusy(true);
    onError('');
    try {
      if (karte.art === 'rezept') {
        const c = consumers.find((x) => x.id === karte.id);
        if (!c) return;
        if (!an) {
          await consumersApi.pause(site.id, c.id);
        } else {
          const out = c.controlActivation === 'paused'
            ? await consumersApi.resume(site.id, c.id)
            : await consumersApi.activatePolicy(site.id, c.id);
          // Eine Ablehnung bleibt AUS und nennt den Server-Grund.
          if (!out.activated) onError(out.message);
        }
        reloadConsumers();
        return;
      }
      const flow = flows.find((f) => f.flowId === karte.id);
      if (!flow) return;
      if (!an) {
        await flowApi.deactivate(flow.flowId);
      } else {
        const out = await flowApi.activate(flow.flowId, flow.activeVersion ?? flow.latestVersion);
        if (!out.activated) {
          onError(rolloutMessage({
            phase: 'fehler', failedAt: 'ausrollen', reason: out.reason ?? null, message: out.message,
          }) ?? out.message);
        }
      }
      onReload();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Das hat gerade nicht geklappt.');
    } finally {
      onBusy(false);
    }
  }, [consumers, flowApi, flows, onBusy, onError, onReload, reloadConsumers, site.id]);

  // --- Löschen / Abschalten -------------------------------------------------
  const entfernen = useCallback(async (karte: RegelKarte) => {
    onBusy(true);
    onError('');
    try {
      if (karte.art === 'rezept') {
        await consumersApi.deactivatePolicy(site.id, karte.id);
        reloadConsumers();
      } else {
        await flowApi.remove(karte.id);
        onReload();
      }
      setOffen(null);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Das hat gerade nicht geklappt.');
    } finally {
      onBusy(false);
    }
  }, [flowApi, onBusy, onError, onReload, reloadConsumers, site.id]);

  // --- Sofortaktion ---------------------------------------------------------
  const runSofort = useCallback(async (durationMinutes?: number) => {
    if (!sofort) return;
    const { consumer: c, action } = sofort;
    onBusy(true);
    onError('');
    try {
      const out = action === 'resume'
        ? await consumersApi.clearOverride(site.id, c.id)
        : await consumersApi.startOverride(site.id, c.id, { action, durationMinutes });
      if (!out.pushed && out.message) onError(out.message);
      setSofort(null);
      reloadConsumers();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Der Eingriff ist fehlgeschlagen.');
    } finally {
      onBusy(false);
    }
  }, [onBusy, onError, reloadConsumers, site.id, sofort]);

  // --- Der geöffnete Einschub ----------------------------------------------
  const offeneKarte = karten.find((k) => k.key === offen) ?? null;
  const offenerFlow = offeneKarte && offeneKarte.art !== 'rezept'
    ? flows.find((f) => f.flowId === offeneKarte.id) ?? null
    : null;
  const offenerConsumer = offeneKarte && offeneKarte.art === 'rezept'
    ? consumers.find((c) => c.id === offeneKarte.id) ?? null
    : null;
  const offeneRule = offenerFlow?.latestDocument
    ? parseGuidedFlow(offenerFlow.latestDocument)
    : null;

  return (
    <section className="vp-capsule" aria-label={REGEL_CAPSULE_TITLE}>
      <PartHead title={REGEL_CAPSULE_TITLE} intro={REGEL_CAPSULE_INTRO}>
        <span className="vp-capsule-action">
          {steuerbare.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEingreifen((v) => !v)}
              aria-expanded={eingreifen}
            >
              Eingreifen
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setCreating(true)}>
            {NEUE_REGEL_LABEL}
          </Button>
        </span>
      </PartHead>

      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        {banner && (
          <SofortBanner
            text={banner.text}
            hinweis={banner.hinweis}
            busy={busy}
            onBeenden={() => {
              const laufend = overrides[0];
              const c = consumers.find((x) => x.id === laufend?.entityId);
              if (c) setSofort({ consumer: c, action: 'resume' });
            }}
          />
        )}

        {eingreifen && steuerbare.length > 0 && (
          <div className="vp-neuregel-bridge" role="group" aria-label="Sofortaktion">
            <p>
              Ein Eingriff gilt nur für die gewählte Zeit — Ihre gespeicherten Regeln
              bleiben unverändert.
            </p>
            <div className="vp-regeld-aktionen">
              {steuerbare.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEingreifen(false);
                    setSofort({ consumer: c, action: 'start' });
                  }}
                >
                  {`„${c.name}" jetzt starten`}
                </Button>
              ))}
            </div>
          </div>
        )}

        {karten.length === 0 ? (
          // Leerer Zustand: die Galerie steht INLINE statt einer leeren Liste
          // mit einem Knopf.
          <RezeptGalerieView
            galerie={galerie}
            busy={busy}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            onWaehlen={waehleRezept}
            onKomponenteAnlegen={() => setWizard(true)}
          />
        ) : (
          <ul className="vp-regeln">
            {karten.map((k) => (
              <RegelKarteView
                key={k.key}
                karte={k}
                busy={busy}
                onToggle={(karte, an) => void toggle(karte, an)}
                onOpen={(karte) => setOffen(karte.key)}
              />
            ))}
          </ul>
        )}

        {/* Das kompakte Gesamt-Protokoll - ein Aufklapper unter der Liste,
            kein eigener Navigationspunkt (5b.6). Es erscheint erst, wenn für
            diese Anlage überhaupt aufgezeichnet wird. */}
        {karten.length > 0 && ruleEvents && <RegelProtokoll view={protokoll} />}
      </Card>

      {/* --- Der Detail-Einschub ------------------------------------------- */}
      {offeneKarte && (
        <RegelDrawer
          karte={offeneKarte}
          view={regelDetail({
            karte: offeneKarte,
            entities,
            rule: offeneRule,
            rezeptSatz: offeneKarte.satz,
            simulation: offenerFlow?.simulation ?? null,
            fulfilment: offenerConsumer ? fulfillment[offenerConsumer.id] ?? null : null,
            versionen: offenerFlow?.versions ?? null,
            aktiveVersion: offenerFlow?.activeVersion ?? null,
            protokoll: ruleEvents,
          })}
          busy={busy}
          loeschFolgen={loeschFolgen(offeneKarte)}
          onClose={() => setOffen(null)}
          onToggle={(an) => void toggle(offeneKarte, an)}
          onBearbeiten={() => {
            setOffen(null);
            if (offenerConsumer) {
              setRuleFor(offenerConsumer);
              return;
            }
            if (offenerFlow && offeneRule) {
              setBearbeiten({ flow: offenerFlow, rule: offeneRule });
              return;
            }
            if (offenerFlow) {
              onOpenFlow(offenerFlow.flowId, offenerFlow.latestVersion, offenerFlow.latestDocument);
            }
          }}
          onLoeschen={() => void entfernen(offeneKarte)}
        />
      )}

      {/* --- „Bearbeiten → Baukasten" -------------------------------------- */}
      {bearbeiten && (
        <Drawer
          open
          onClose={() => setBearbeiten(null)}
          title={`Regel bearbeiten: ${bearbeiten.flow.name}`}
        >
          <GuidedRuleBuilder
            entities={entities}
            siteId={site.id}
            busy={busy}
            lockedKinds={lockedKinds}
            lockedHint={lockedHint}
            allowDiagnosticActions={showTechnicalLayer()}
            initialRule={bearbeiten.rule}
            initialName={bearbeiten.flow.name}
            onCancel={() => setBearbeiten(null)}
            onBuild={(name, doc) => {
              const f = bearbeiten.flow;
              setBearbeiten(null);
              onEditedFlow(f.flowId, f.latestVersion, name, doc);
            }}
          />
        </Drawer>
      )}

      {/* --- Die drei Türen ------------------------------------------------- */}
      <NeueRegelDialog
        open={creating}
        onClose={() => setCreating(false)}
        entities={entities}
        topology={topology}
        siteId={site.id}
        busy={busy}
        lockedKinds={lockedKinds}
        lockedHint={lockedHint}
        onRezept={waehleRezept}
        onKomponenteAnlegen={() => {
          setCreating(false);
          setWizard(true);
        }}
        onBuilt={(name, doc) => {
          setCreating(false);
          onBuiltFlow(name, doc);
        }}
        onOpenEditor={() => {
          setCreating(false);
          onOpenEditor();
        }}
      />

      {/* --- Die zwei Verbraucher-Einschübe (unverändert) -------------------- */}
      {options && (
        <VerbraucherAnlegenDrawer
          site={site}
          options={options}
          open={wizard}
          onClose={() => setWizard(false)}
          onCreated={(created, openRule) => {
            setWizard(false);
            reloadConsumers();
            if (openRule) setRuleFor(created);
          }}
        />
      )}

      {options && ruleFor && (
        <VerbraucherRegelDrawer
          site={site}
          options={options}
          consumer={ruleFor}
          prefill={rulePrefill}
          claims={strategies[ruleFor.id]}
          onClose={() => {
            setRuleFor(null);
            setRulePrefill(null);
          }}
          onSaved={() => {
            setRuleFor(null);
            setRulePrefill(null);
            reloadConsumers();
          }}
        />
      )}

      <ConsumerOverrideDialog
        action={sofort?.action ?? null}
        consumerName={sofort?.consumer.name ?? ''}
        effectivePowerKw={sofort ? Number(sofort.consumer.ratedPowerKw) : null}
        busy={busy}
        onConfirm={(m) => void runSofort(m)}
        onCancel={() => setSofort(null)}
      />
    </section>
  );
}
