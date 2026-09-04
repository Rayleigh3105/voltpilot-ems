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
  type EntityStrategy, type RuleEvents, type ScheduleSlot, type Site,
  type SiteInterventions, type SiteTopology,
} from '../api';
import { PartHead } from './SteuerungParts';
import { ConsumerOverrideDialog } from './ConsumerOverrideDialog';
import { NeueRegelDialog } from './NeueRegelDialog';
import { RegelDrawer } from './RegelDrawer';
import { ConfirmDialog } from './ConfirmDialog';
import { RegelKarteView } from './RegelKarten';
import { RegelProtokoll } from './RegelProtokoll';
import type { SteuerartWunsch } from '../steuerartDialog';
import { VorschlagsKarten } from './VorschlagsKarten';
import { VerbraucherAnlegenDrawer, VerbraucherRegelDrawer } from './VerbraucherDrawers';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer, ConsumerOptions, ConsumerPolicyVersion } from '../consumers/types';
import type { ConsumerDraft } from '../consumers/questions';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { ConsumerFulfilment, ManualOverride, SofortAktion } from '../consumers/fulfillment';
import { policySentence } from '../consumers/policy';
import { parseVerbraucherParams, templateConsumer } from '../consumers/vorlagen';
import {
  brueckenKomponente,
  komponenteAusHash,
  vorbefuellteRegel,
  vorbefuellterName,
} from '../selbstbauBruecke';
import { parseGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import type { BoundFlowApi, FlowDeviceAck, FlowSummary } from '../flows/flowsApi';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { rolloutMessage } from '../flows/rollout';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import { Modal } from '../../designsystem/components/shell/Modal';
import { showTechnicalLayer } from '../rollen';
import {
  KOMPONENTE_ANLEGEN,
  istVerbraucherRezept,
  rezept,
  rezeptPrefill,
  speicherSchutzRegel,
  vorbelegungen,
  type RezeptId,
} from '../regeln/rezepte';
import { regelDetail } from '../regeln/detail';
import { folgenZeilen, regelFolgen, vorrangArt, type FolgenKarte } from '../regeln/folgen';
import type { VorrangArt } from '../regeln/satz';
import { knoepfeFuerSpeicherRegel, nachteilBisher, nachteilZeile } from '../vorschau';
import { useVorschau } from './useVorschau';
import { protokoll as protokollView } from '../regeln/verlauf';
import {
  istGenerierteVerbraucherregel,
  regelKarten,
  type RegelKarte,
  type RezeptRegelInput,
} from '../regeln/zustand';
import {
  NEUE_REGEL_LABEL,
  REGEL_CAPSULE_INTRO,
  REGEL_CAPSULE_TITLE,
} from '../steuerungArea';
import { replaceCurrentNavigation } from '../navigationBlocker';
import {
  LEER_MIT_VORSCHLAEGEN,
  PLATTFORM_ZONE,
  vorschlaege as leiteVorschlaegeAb,
  type Vorschlag,
} from '../vorschlaege';
import './Regeln.css';

type CondKind = 'entity' | 'price' | 'schedule';

/** Die Folgenliste des Hauses, bevor eine Regel verschwindet. */
export function loeschFolgen(karte: RegelKarte): string[] {
  if (karte.art === 'rezept') {
    return [
      'Die Regel wird abgeschaltet — VoltPilot sendet dafür keine Befehle mehr.',
      'Ihr Gerät fällt auf seine sichere Grundeinstellung zurück.',
      'Das Gerät selbst bleibt bestehen; Sie finden es unter „Komponenten".',
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
  onSteuerart,
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
  /**
   * „Übernehmen" eines Vorschlags öffnet den STEUERART-Dialog vorbefüllt (P2).
   * Fehlt der Wirt, bleibt der alte Weg (Regel-Baukasten) - nie ein toter Knopf.
   */
  onSteuerart?: (entityId: string, wunsch: SteuerartWunsch) => void;
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
  // Steuerung Stufe 6: die drei ZUSATZ-Quellen der Vorschläge. Alle fail-soft -
  // fehlt eine, entsteht schlicht kein Vorschlag (nie ein geratener).
  const [slots, setSlots] = useState<ScheduleSlot[] | null>(null);
  const [eingriffe, setEingriffe] = useState<SiteInterventions | null>(null);
  const [stumm, setStumm] = useState<string[]>([]);
  /**
   * Steuerung Stufe 7: die Entladeleistung des Speichers - die Obergrenze der
   * Energie, die eine haltende Regel dem Fahrplan entzieht. Ohne sie gibt es
   * KEINEN Nachteil-Beleg (nie eine geratene Grenze).
   */
  const [entladeKw, setEntladeKw] = useState<number | null>(null);

  const [creating, setCreating] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [ruleFor, setRuleFor] = useState<Consumer | null>(null);
  const [rulePrefill, setRulePrefill] = useState<Partial<ConsumerDraft> | null>(null);
  const [bearbeiten, setBearbeiten] = useState<
  { flow: FlowSummary; rule: GuidedRule } | null>(null);
  const [eingreifen, setEingreifen] = useState(false);
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  /** Die Brücke (Stufe 4, Anforderung 9): eine aus einer Komponente vorbefüllte Regel. */
  const [komponentenRegel, setKomponentenRegel] =
    useState<{ rule: GuidedRule; name: string } | null>(null);
  const deepLinkDone = useRef(false);
  const brueckeDone = useRef(false);

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
    // Die Zutaten der VORSCHLÄGE (Stufe 6): der Fahrplan liefert die Zahlen,
    // die Eingriffe und das Gedächtnis entscheiden, was NICHT gezeigt wird.
    api.schedule(site.id).then((p) => alive && setSlots(p?.slots ?? null)).catch(() => {});
    api.siteInterventions(site.id).then((i) => alive && setEingriffe(i ?? null)).catch(() => {});
    api.suggestionStates(site.id)
      .then((r) => alive && setStumm((r?.states ?? []).map((x) => x.key)))
      .catch(() => {});
    api.siteAssets(site.id)
      .then((a) => alive && setEntladeKw(
        a?.find((x) => x.type === 'battery')?.maxDischargeKw ?? null,
      ))
      .catch(() => {});
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
  /**
   * Der NACHTEIL-BELEG je Regel (Steuerung Stufe 7, Leitprinzip Regel 3).
   *
   * Er entsteht NUR, wo alle vier Zutaten belegt sind: die Regel beansprucht
   * eine Komponente DIREKT (`claimedAt` aus `flow_claim`), der Fahrplan deckt
   * die Zeit seither ab, jede seiner Viertelstunden trägt Preis UND
   * Speicherwert, und die Entladeleistung ist bekannt. Fehlt eines davon,
   * steht an der Karte NICHTS — kein „0,00 €" und keine Schätzung.
   */
  const nachteile = useMemo(() => {
    const out: Record<string, string> = {};
    if (!slots || entladeKw == null) return out;
    const now = new Date();
    for (const [, liste] of Object.entries(strategies)) {
      for (const st of liste) {
        if (!st.claimedAt) continue;
        const seit = new Date(st.claimedAt);
        if (Number.isNaN(seit.getTime())) continue;
        const key = `flow:${st.flowId}`;
        if (out[key]) continue;
        const zeile = nachteilZeile(
          nachteilBisher(slots, seit, now, entladeKw), seit, PLATTFORM_ZONE,
        );
        if (zeile) out[key] = zeile;
      }
    }
    return out;
  }, [slots, strategies, entladeKw]);

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
      nachteile,
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
  }, [flows, acks, consumers, status, fulfillment, overrides, policies, entities, ruleEvents,
    nachteile]);

  // Das Gesamt-Protokoll spricht die NAMEN der Karten - ein Ereignis ohne
  // zuordenbare Regel bleibt sichtbar, nennt aber keine (nie eine geratene).
  const protokoll = useMemo(
    () => protokollView(ruleEvents, Object.fromEntries(karten.map((k) => [k.key, k.name]))),
    [ruleEvents, karten],
  );
  const start = useMemo(() => vorbelegungen({ entities, topology }), [entities, topology]);
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
    replaceCurrentNavigation(window.location.hash.split('?')[0]);
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

  // --- Die BRÜCKE: `?komponente=` (Stufe 4, Anforderung 9) -------------------
  //
  // Bewusst ein EIGENER Effekt neben dem Verbraucher-Deep-Link: der wartet auf
  // `consumers`, und eine Anlage mit einem selbst gebauten Gerät hat oft gar
  // keinen Verbraucher - die Brücke käme dort nie an. Sie hängt an `entities`,
  // weil die vorbefüllte Bedingung aus den MESSWERTEN der Komponente entsteht.
  useEffect(() => {
    if (brueckeDone.current || entities.length === 0) return;
    const entityId = komponenteAusHash(window.location.hash);
    if (!entityId) {
      brueckeDone.current = true;
      return;
    }
    brueckeDone.current = true;
    replaceCurrentNavigation(window.location.hash.split('?')[0]);
    const e = entities.find((x) => x.id === entityId);
    if (!e) return;
    const k = brueckenKomponente(e);
    const rule = vorbefuellteRegel(k);
    // Ohne Messwert gibt es nichts zu bedingen - dann öffnet der normale
    // Drei-Türen-Weg, nie ein Baukasten ohne wählbare Größe.
    if (!rule) {
      setCreating(true);
      return;
    }
    setKomponentenRegel({ rule, name: vorbefuellterName(k) });
    setCreating(true);
  }, [entities]);

  // --- Einen STARTPUNKT wählen ----------------------------------------------
  /**
   * Steuerung Stufe 2: ein Startpunkt VERBELEGT — er baut nichts fertig.
   *
   * ⚠ Das ist der Unterschied zur früheren Galerie: „Speicher schützen" hat
   * dort hinter dem Rücken des Kunden einen Flow erzeugt und gespeichert (die
   * Vorlagen-Mechanik, die der Captain abgelehnt hat). Jetzt füllt es den
   * Baukasten, der Kunde sieht die Regel und entscheidet — und vor dem
   * Aktivieren steht die Folgen-Karte. Die MASCHINEN dahinter sind unverändert:
   * eine Verbraucher-Absicht kann der Wenn/Dann-Baukasten nicht ausdrücken,
   * also öffnet sie den Verbraucher-Fragenbaum vorbefüllt.
   */
  const waehleStartpunkt = useCallback((id: RezeptId) => {
    const def = rezept(id);
    if (!def) return;
    if (istVerbraucherRezept(id)) {
      setCreating(false);
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
        onError('Dafür braucht Ihre Anlage einen Speicher und ein steuerbares Gerät.');
        return;
      }
      setKomponentenRegel({ rule, name: def.titel });
      setCreating(true);
    }
  }, [consumers, entities, onError]);

  // --- VORSCHLÄGE (Steuerung Stufe 6, Konzept b3 §3.3) -----------------------
  /**
   * Die Karten kommen ausschliesslich aus der reinen Ableitung - hier wird
   * NICHTS gerechnet und NICHTS formuliert. Fehlt eine Zutat (kein Fahrplan,
   * keine steuerbare Komponente, kein belastbares Fenster), ist die Liste leer
   * und die Fläche zeigt schlicht keine Vorschläge.
   */
  const angebote = useMemo(() => leiteVorschlaegeAb({
    slots,
    consumers,
    claims: strategies,
    eingriffe: eingriffe?.interventions ?? null,
    pausiert: eingriffe?.automationPaused === true,
    stumm,
    now: new Date(),
    // Die Plattform-Zone (v1, wie `anlage.ts`/`HistoryRange.ZONE`) - die
    // Anlage trägt keine eigene, und die Uhrzeit einer Karte darf nicht von
    // der Zeitzone des Browsers abhängen.
    zone: PLATTFORM_ZONE,
  }), [slots, consumers, strategies, eingriffe, stumm]);

  /**
   * „Übernehmen" zielt seit Verbrauchsmanagement v1 P2 auf die STEUERART
   * (Konzept §6.1) statt auf eine Regel: ein Vorschlag sagt, WIE ein Gerät
   * grundsätzlich laufen soll — und genau das ist die Steuerart, nicht die
   * Ausnahme davon.
   *
   * ⚠ Er SETZT sie nicht sofort. Der Steuerart-Dialog öffnet vorbefüllt auf
   * seiner FOLGEN-Karte: die Haus-Regel „die Folgen-Karte steht IMMER vor der
   * Aktivierung" gilt auch hier, und mit „Zurück" ist jede Antwort noch
   * änderbar (das ist zugleich das „Anpassen" des Konzepts — ein eigener
   * vierter Knopf daneben führte auf dieselbe Fläche).
   *
   * Ohne den Wirt (ein älterer Aufrufer ohne `onSteuerart`) bleibt der alte
   * Weg: der Regel-Baukasten vorbefüllt - nie ein toter Knopf.
   */
  const uebernehmen = useCallback((v: Vorschlag) => {
    const c = consumers.find((x) => x.id === v.komponenteId);
    if (!c) return;
    if (onSteuerart) {
      onSteuerart(v.komponenteId, v.steuerart);
      return;
    }
    setRulePrefill(v.prefill);
    setRuleFor(c);
  }, [consumers, onSteuerart]);

  /**
   * „Später"/„Ablehnen". Die Karte verschwindet SOFORT (der Kunde hat
   * entschieden), die Frist rechnet der Server - ein Fehlschlag holt sie
   * zurück, statt eine Stummschaltung vorzutäuschen, die nicht gespeichert ist.
   */
  const stummSchalten = useCallback((v: Vorschlag, state: 'spaeter' | 'abgelehnt') => {
    setStumm((prev) => (prev.includes(v.key) ? prev : [...prev, v.key]));
    api.setSuggestionState(site.id, v.key, state).catch((e) => {
      setStumm((prev) => prev.filter((k) => k !== v.key));
      onError(e instanceof ApiError ? e.message : 'Das konnte nicht gespeichert werden.');
    });
  }, [site.id, onError]);

  // --- Schnellschalter ------------------------------------------------------
  /**
   * Die FOLGEN-KARTE vor jeder Aktivierung (Konzept `vp-steuerung-konzept-b3`
   * §3.5, Leitprinzip Regel 2). Sie steht IMMER vor dem Einschalten — auch
   * dann, wenn wenig zu sagen ist.
   *
   * ⚠ Das AUSschalten fragt bewusst NICHT: es nimmt eine Erlaubnis zurück, es
   * gibt keine her — dieselbe Regel wie beim Abschalten der Wellen-Automatik.
   */
  const [folgen, setFolgen] = useState<{ karte: RegelKarte; art: VorrangArt } | null>(null);

  const fragen = useCallback((karte: RegelKarte, an: boolean) => {
    if (!an) return false;
    const flow = karte.art === 'rezept' ? null : flows.find((f) => f.flowId === karte.id);
    setFolgen({ karte, art: vorrangArt(flow?.latestDocument ?? null, entities) });
    return true;
  }, [entities, flows]);

  /**
   * Die VORSCHAU der geöffneten Karte (Stufe 7). Sie wird GENAU EINMAL je
   * geöffneter Regel geholt (der `nonce` ist die Regel-Id) und nur für eine
   * Regel, die den Speicher beansprucht — nur die lässt sich in die drei
   * Knöpfe der Route übersetzen. Für eine reine Geräte-Regel bleibt die Karte
   * bei ihrer zahllosen Fassung, statt eine fremde Frage zu rechnen.
   */
  const speicherRegel = folgen?.art === 'speicher';
  const uebersetzung = speicherRegel ? knoepfeFuerSpeicherRegel() : null;
  const vorschau = useVorschau(
    site.id,
    uebersetzung?.knoepfe ?? null,
    speicherRegel && folgen ? folgen.karte.key : null,
  );

  // Die Karte entsteht bei JEDEM Render neu — so trägt sie die Zahl, sobald
  // sie da ist, statt die Fassung von vor der Antwort einzufrieren.
  const folgenView: FolgenKarte | null = folgen
    ? regelFolgen({
      name: folgen.karte.name,
      satz: folgen.karte.satz,
      art: folgen.art,
      // Der Fahrplan-Block sagt seinen Grund; ohne geladenen Plan bleibt es
      // beim allgemeinen „noch nicht berechenbar" (nie eine erfundene Zahl).
      hatFahrplan: true,
      vorschau: vorschau.ergebnis,
      vorschauLaeuft: vorschau.laeuft,
      vorschauUntergrenze: uebersetzung?.untergrenze,
    })
    : null;

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
        {/* Steuerung Stufe 6: die VORSCHLÄGE stehen ganz oben - sie sind der
            Einstieg („Vorschlag vor Regel"), nicht eine Beigabe unter der
            Liste. Ohne belastbares Fenster rendert die Komponente nichts. */}
        <VorschlagsKarten
          vorschlaege={angebote}
          busy={busy}
          onUebernehmen={uebernehmen}
          onStumm={stummSchalten}
        />

        {/* Steuerung Stufe 1: der Banner eines laufenden Handeingriffs wohnt
            jetzt EINMAL — in Zone ① „Jetzt", wo der Eingriff auch gemacht
            wird (Konzept b3 §3.2). Hier bleibt, was die REGEL angeht: ihre
            Karte sagt „wartet — Sofortaktion hat Vorrang". */}

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
          // Leerer Zustand (Steuerung Stufe 2): EIN Satz mit dem Weg statt der
          // Galerie — auf einer Anlage ohne schaltbares Gerät sah der Kunde
          // sonst dieselbe Sackgasse dreimal (Befund B7 des Konzepts).
          <div className="vp-regeln-leer" role="status">
            {start.brauchtKomponente ? (
              <>
                <p>{KOMPONENTE_ANLEGEN}</p>
                <Button size="sm" disabled={busy} onClick={() => setWizard(true)}>
                  Komponente anlegen
                </Button>
              </>
            ) : (
              <>
                <p>
                  {angebote.length > 0 ? LEER_MIT_VORSCHLAEGEN
                    : 'Noch keine Regel. Im Baukasten sagen Sie in Ihren Worten, was '
                      + 'passieren soll — vor dem Aktivieren zeigt VoltPilot die Folgen.'}
                </p>
                <Button size="sm" disabled={busy} onClick={() => setCreating(true)}>
                  Regel erstellen
                </Button>
              </>
            )}
          </div>
        ) : (
          <ul className="vp-regeln">
            {karten.map((k) => (
              <RegelKarteView
                key={k.key}
                karte={k}
                siteId={site.id}
                busy={busy}
                onToggle={(karte, an) => {
                  if (!fragen(karte, an)) void toggle(karte, an);
                }}
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
          onToggle={(an) => {
            if (!fragen(offeneKarte, an)) void toggle(offeneKarte, an);
          }}
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
        <Modal
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
        </Modal>
      )}

      {/* --- Die drei Türen ------------------------------------------------- */}
      <NeueRegelDialog
        open={creating}
        onClose={() => { setCreating(false); setKomponentenRegel(null); }}
        entities={entities}
        topology={topology}
        siteId={site.id}
        busy={busy}
        lockedKinds={lockedKinds}
        lockedHint={lockedHint}
        initialRule={komponentenRegel?.rule ?? null}
        initialName={komponentenRegel?.name}
        onRezept={waehleStartpunkt}
        onSolarUeberschuss={() => waehleStartpunkt('pv-surplus-consumer')}
        onKomponenteAnlegen={() => {
          setCreating(false);
          setWizard(true);
        }}
        onBuilt={(name, doc) => {
          setCreating(false);
          setKomponentenRegel(null);
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

      {folgen && folgenView && (
        <ConfirmDialog
          open
          title={folgenView.titel}
          intro={folgenView.intro}
          consequences={folgenZeilen(folgenView)}
          confirmLabel={folgenView.bestaetigen}
          busy={busy}
          onCancel={() => setFolgen(null)}
          onConfirm={() => {
            const k = folgen.karte;
            setFolgen(null);
            void toggle(k, true);
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
