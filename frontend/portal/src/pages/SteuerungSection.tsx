/**
 * Anlage → **Steuerung** (Portal v3 · M4, spec `docs/portal.md`).
 *
 * Die Fläche beantwortet EINE Frage — „Was darf VoltPilot, und was habe ich
 * selbst geregelt?" — mit genau ZWEI Kapseln und einer schmalen Schutz-Zeile:
 *
 *  1. **Anwendungen** — kompakte, ANTIPPBARE Zeilen (Statuspunkt · ein Satz
 *     mit echten Zahlen · Chevron · Schalter); ein Tipp auf die Zeile öffnet den
 *     Modus-Container (v3.1-M2, `ModusContainer`), darunter als Fußzeile der
 *     Ko-Optimierungs-Streifen mit dem SoC-Reservierungs-Stack.
 *  2. **Automationen** — je Regel eine Zeile mit ihrem lebenden Zustand und
 *     EINEM Knopf „＋ Neue Automation", dessen Dialog die drei Wege in dieser
 *     Reihenfolge anbietet: Vorlage → geführter Baukasten → Editor.
 *
 * Die frühere Vier-Teilung (Aktive Modi → Ko-Optimierung → Automationen +
 * Vorlagen → Werkzeugkiste) ist damit aufgelöst; Angebote leben ausschließlich
 * in M3s Regal, es gibt keine zweite Tür in den Editor mehr.
 *
 * Alle Ableitung liegt in den reinen Modulen `surface.ts` (M0), `profiles.ts`
 * (M3), `steuerungArea.ts` und `flows/templateFilter.ts`; diese Seite lädt und
 * rendert. Gates bleiben unverändert — der Server prüft bei jeder Aktivierung
 * selbst nach.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ApiError,
  api,
  type EarningsSite,
  type Site,
  type SiteAsset,
  type SiteCharging,
} from '../api';
import { ErrorState, TextSkeleton } from '../components/States';
import { InfoTip } from '../components/InfoTip';
import { JetztZone } from '../components/JetztZone';
import { SteuerungIntro } from '../components/SteuerungIntro';
import { LadeparkRahmenKarte } from '../components/LadeparkRahmenKarte';
import { RegelnKapsel } from '../components/RegelnKapsel';
import { SteuerartDialog } from '../components/SteuerartDialog';
import { SteuerartIntro } from '../components/SteuerartIntro';
import type { SteuerartWunsch } from '../steuerartDialog';
import { VerbraucherZone } from '../components/VerbraucherZone';
import { quelleLang, type SiteVerbraucher } from '../verbraucherZone';
import type { SiteFahrzeuge } from '../fahrzeugProfile';
import { Betriebsmodelle } from '../components/Betriebsmodelle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ModusContainer } from '../components/ModusContainer';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import { anlageRoute, befehleHash, hashForRoute, pageRoute, type AnlagenSub } from '../nav';
import type { NavTarget } from '../ebenenNav';
import {
  customerFlowApi,
  type FlowNodeGovernance,
  type FlowSummary,
} from '../flows/flowsApi';
import { catalogType, type EditorEntity, type FlowDocument } from '../flows/model';
import { flowMode, paletteFilterFor, type SteuerungMode } from '../flows/steuerung';
import {
  PROFILE_CAPSULE_EMPTY,
  PROFILE_CAPSULE_INTRO,
  PROFILE_CAPSULE_TITLE,
  PROTECTION_INTRO,
  protectionItems,
} from '../steuerungArea';
import {
  betriebsmodellZone,
  type AmpelZeile,
  type BetriebsmodellKarte,
} from '../betriebsmodelle';
import { ausschaltFolgen, folgenZeilen, wechselFolgen, type FolgenKarte }
  from '../regeln/folgen';
import { type ProfileState, type SiteProfiles } from '../profiles';
import { beanspruchtSpeicher } from '../regeln/zustand';
import {
  activeModes,
  baseSurface,
  type ActiveMode,
  type SurfaceFlow,
  type SurfaceSignals,
} from '../surface';
import { FlowEditorPage } from './admin/FlowEditorPage';
import '../components/Profile.css';

const EMPTY_DOC: FlowDocument = {
  schema_version: '1.0', name: '', runtime: 'edge', nodes: [], edges: [], triggers: [],
};

interface Editing {
  flowId: string;
  version: number;
  /** Welcher Palettenausschnitt geöffnet wird (U3-Regel: Strategie-Knoten gewinnt). */
  palette: SteuerungMode;
  /**
   * Audit E-1: eine frisch GEBAUTE Regel (Baukasten/Vorlage) landet auf dem
   * Prüf-Schritt in Klartext, nicht auf der Leinwand. Eine bestehende Regel
   * öffnet weiterhin direkt im Editor.
   */
  view?: 'review' | 'editor';
}

export function SteuerungSection({
  site,
  isAdmin = false,
  onOpenSub,
  onSiteSaved,
}: {
  site: Site;
  isAdmin?: boolean;
  onOpenSub?: (sub: AnlagenSub) => void;
  /**
   * Eine Site-Einstellung wurde IM Modus-Container gespeichert (v3.1-M3) — die
   * Anlagen-Seite lädt daraufhin neu, damit alle Flächen den neuen Wert zeigen.
   */
  onSiteSaved?: (updated: Site) => void;
}) {
  const flowApi = useMemo(() => customerFlowApi(site.id), [site.id]);
  // Lokaler Site-Zustand, damit ein Container-Save (Netzladen/Tarif/…) sofort in
  // der Ableitung (`activeModes` — Netzladen ∧ dyn. Tarif IST ein Markt-Signal!)
  // und in den Lese-Zeilen sichtbar wird; die Prop bleibt die Quelle der Wahrheit
  // und synchronisiert bei einem Anlagenwechsel/Seiten-Reload zurück.
  const [siteState, setSiteState] = useState<Site>(site);
  useEffect(() => setSiteState(site), [site]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [signals, setSignals] = useState<SurfaceSignals | null>(null);
  const [earnings, setEarnings] = useState<EarningsSite | null>(null);
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  // Die Ladepunkte (Lastmanagement Stufe 3) - fail-soft: ein älteres Backend
  // kennt die Route nicht, dann gibt es die Ladepark-Kapsel schlicht nicht.
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  /**
   * Das Lese-Aggregat der Verbraucher-Zone. Fail-soft wie jede zusätzliche
   * Quelle dieser Seite: ein älteres Backend (Route unbekannt) oder ein
   * Netzfehler lässt die Zone ihren ehrlichen Leer-Zustand rendern - die
   * Steuerungsseite bleibt vollständig bedienbar.
   */
  const [verbraucher, setVerbraucher] = useState<SiteVerbraucher | null>(null);
  // P7: die Ladekarten. null = nicht geladen bzw. ein älteres Backend - der
  // Abschnitt erscheint dann gar nicht, statt eine leere Liste zu behaupten.
  const [fahrzeuge, setFahrzeuge] = useState<SiteFahrzeuge | null>(null);
  /**
   * Die Komponente, deren Steuerart gerade bearbeitet wird (P2) - ein interner
   * Sub-View-State wie `editing`, kein neuer Routen-Parameter.
   */
  const [steuerartFuer, setSteuerartFuer] = useState<string | null>(null);
  const [steuerartBusy, setSteuerartBusy] = useState(false);
  const [steuerartFehler, setSteuerartFehler] = useState<string | null>(null);
  /** Der Wunsch eines Vorschlags, mit dem der Dialog aufmacht (§6.1). */
  const [steuerartVorbelegung, setSteuerartVorbelegung] = useState<SteuerartWunsch | null>(null);
  /** Bezugszeit der Betriebsmodell-Zone; wird beim Nachladen neu gesetzt. */
  const [zoneNow, setZoneNow] = useState(() => new Date());
  /** Die offene Folgen-Karte (Wechsel/Ausschalten) samt ihrer Handlung. */
  const [folgen, setFolgen] = useState<
    { karte: FolgenKarte; run: () => void } | null
  >(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<Editing | null>(null);
  /**
   * v3.1-M2: der offene Modus-Container (die Profil-Id) — ein interner
   * Sub-View-State wie `editing` (der Flow-Editor-Präzedenzfall), kein neuer
   * `Route`-Parameter. Der Bookmark `#/anlage/{id}/profile` redirectet auf
   * `steuerung` (`nav.ts` LEGACY_SUBS), landet also auf den zwei Kapseln.
   */
  const [openContainer, setOpenContainer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The notice strip lives at the TOP of the area while the actions that can
  // fail sit far below it - a message set there read as "nothing happened"
  // (G6). Every setError goes through `fail`, which also brings the strip
  // into view, so a refusal is never silent.
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const fail = useCallback((message: string) => {
    setError(message);
    // The strip renders in the same commit; scroll after paint.
    requestAnimationFrame(() => {
      noticeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  /**
   * The honest message for a failed flow action. A 403 means the account is
   * not unlocked for this - VoltPilot sets it up - NOT that the server is
   * unreachable. The gate is unchanged; only the copy tells the truth.
   */
  const flowFailure = useCallback((e: unknown, fallback: string): string => {
    if (e instanceof ApiError && e.status === 403) {
      return `Der volle Editor ist für Ihr Konto nicht freigeschaltet. ${EINRICHTUNG_DURCH_VOLTPILOT}`;
    }
    return e instanceof ApiError ? e.message : fallback;
  }, []);

  const reload = useCallback(() => {
    setListState('loading');
    // Nur die Flow-Liste ist tragend; alles andere ist fail-soft (der
    // `useAdaptiveLive`/`useAnlageSurface`-Präzedenzfall) - ein älteres Backend
    // oder ein 403 auf einer Admin-Route lässt die Fläche einfach ruhiger
    // aussehen, statt sie zu blockieren.
    Promise.all([
      flowApi.list(),
      flowApi.entities().catch(() => [] as EditorEntity[]),
      flowApi.governance().catch(() => ({ gatedNodes: [] } as FlowNodeGovernance)),
      api.usageProfile(site.id).catch(() => null),
      api.earnings('month').catch(() => null),
      api.siteProfiles(site.id).catch(() => null),
      // Der Speicher-Asset speist die Speicherschonungs-Einstellung im Container
      // (v3.1-M3); fail-soft wie der Rest.
      api.siteAssets(site.id).catch(() => null),
      // Lastmanagement Stufe 3: ohne Ladesäulen kommt eine leere Antwort und
      // die Ladepark-Kapsel entfällt - kein Sonderfall, nur nichts zu zeigen.
      api.siteChargers(site.id).catch(() => null),
      // Verbrauchsmanagement v1: die Steuerart je Komponente, der
      // Anlagen-Standard und die Rangliste - EIN Aggregat, zwei Abnehmer
      // (die Verbraucher-Zone und die Quelle der Ladepunkt-Zeilen in „Jetzt").
      api.siteVerbraucher(site.id).catch(() => null),
      // Verbrauchsmanagement v1 / P7: die Ladekarten dieser Anlage. Fail-soft
      // wie der Rest - ein älteres Backend kennt die Route nicht, und dann
      // erscheint der Abschnitt gar nicht statt leer.
      api.siteFahrzeuge(site.id).catch(() => null),
    ])
      .then(([list, entityList, gov, profile, money, shelf, siteAssets, chargePoints,
        verbraucherZone, fahrzeugListe]) => {
        setFlows(list);
        setEntities(entityList);
        setGovernance(gov);
        setSignals(profile?.signals ?? null);
        setEarnings(money?.sites.find((s) => s.id === site.id) ?? null);
        setProfiles(shelf);
        setAssets(siteAssets);
        setCharging(chargePoints);
        setVerbraucher(verbraucherZone);
        setFahrzeuge(fahrzeugListe);
        setZoneNow(new Date());
        setListState('idle');
      })
      .catch(() => setListState('error'));
  }, [flowApi, site.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const enabledGatedTypes = useMemo(
    () => (governance?.gatedNodes ?? []).filter((n) => n.enabled).map((n) => n.type),
    [governance],
  );

  /**
   * Bedingungs-Arten des Baukastens, deren Katalog-Knoten GATED und für diese
   * Anlage nicht freigeschaltet ist (AE7-Governance). Der Server verweigert die
   * Aktivierung sonst mit `gated_node_not_enabled`, also wird die Art sichtbar
   * gesperrt statt eine Regel bauen zu lassen, die nie live gehen kann.
   */
  const lockedCondKinds = useMemo<('price')[]>(
    () => (catalogType('vp.price.current')?.gated
      && !enabledGatedTypes.includes('vp.price.current') ? ['price'] : []),
    [enabledGatedTypes],
  );

  /** Die EINE Projektions-Eingabe dieser Fläche (M0) - nichts wird hier neu abgeleitet. */
  const surfaceInput = useMemo(
    () => ({
      signals,
      config: {
        plantKind: siteState.plantKind,
        tarifArt: siteState.tarifArt,
        netzladenErlaubt: siteState.netzladenErlaubt,
        leistungspreisEurKw: siteState.leistungspreisEurKw ?? null,
      },
      flows: (flows as SurfaceFlow[] | null) ?? null,
      entities: null,
    }),
    [signals, siteState, flows],
  );

  /** Die MENGE der aktiven Modi (M0). */
  const modes = useMemo<ActiveMode[]>(() => activeModes(surfaceInput), [surfaceInput]);

  /**
   * Die BASIS-Ansichten (Fahrplan bei Speicher, Marktpreise bei Börsentarif).
   * Der Modus-Container zieht sie von „Ansichten dieses Modus" ab, damit er
   * nichts als Freischaltung ausweist, was ohnehin in der Navigation steht.
   */
  const baseViews = useMemo(() => baseSurface(surfaceInput).deepViews, [surfaceInput]);

  /**
   * Zone ③ (Stufe 5). `now` ist ein Zustand statt `new Date()` im Rumpf, damit
   * „läuft seit heute, 14:02" nicht bei jedem Render neu gerechnet wird — der
   * Wert ändert sich nur beim Nachladen (die `liveness.ts`-Disziplin: Zustand
   * und Bezugszeit gehören zusammen).
   */
  const zone = useMemo(
    () => betriebsmodellZone(profiles?.profiles, modes, earnings, zoneNow),
    [profiles, modes, earnings, zoneNow],
  );
  const protections = useMemo(() => protectionItems(siteState), [siteState]);
  /**
   * Beansprucht eine AKTIVE Regel den Speicher? Die Jetzt-Zone nennt danach
   * ihre Quelle („Ihre Regel" statt „Fahrplan") — und beantwortet die Frage
   * NICHT selbst: hier steht der Beleg (aktive Version + Anspruch aus dem
   * Dokument), dieselbe Ableitung, die die Regel-Karte trägt.
   */
  const speicherRegelAktiv = useMemo(
    () => (flows ?? []).some(
      (f) => f.activeVersion != null && beanspruchtSpeicher(f.latestDocument ?? null, entities),
    ),
    [flows, entities],
  );
  // ⚠ `flowApi.entities()` faellt fuer ein LABEL-loses Messobjekt auf seine Id
  // zurueck (der Flow-Editor braucht dort einen adressierbaren Schluessel) - eine
  // KOMPONIERTE Batterie traegt seit der Label-Hygiene aber genau kein Label.
  // Ungefiltert stand deshalb eine nackte UUID als Name der Speicher-Zeile.
  // Gleich der Id heisst hier: kein Kundenname -> `speicherZeile` sagt "Speicher".
  const speicherName = useMemo(() => {
    const b = entities.find((e) => e.entityType === 'battery-hybrid');
    if (!b) return null;
    return b.label && b.label !== b.id ? b.label : null;
  }, [entities]);
  const battery = useMemo(
    () => (assets ?? []).find((a) => a.type === 'battery') ?? null,
    [assets],
  );

  /** Ein Container-Save einer Site-Einstellung: lokal spiegeln + Seite nachladen. */
  const handleSiteSaved = useCallback(
    (updated: Site) => {
      setSiteState(updated);
      onSiteSaved?.(updated);
      reload();
    },
    [onSiteSaved, reload],
  );

  /** Ein Container-Save der Speicherschonung: die neuen Assets übernehmen. */
  const handleBatterySaved = useCallback((updatedAssets: SiteAsset[]) => {
    setAssets(updatedAssets);
  }, []);

  const openFlow = useCallback(
    (flowId: string, version: number, doc: FlowDocument | null) => {
      setEditing({ flowId, version, palette: flowMode(doc ?? EMPTY_DOC) });
    },
    [],
  );

  const openSaved = useCallback(
    async (name: string, doc: FlowDocument | null, palette: SteuerungMode) => {
      setBusy(true);
      setError('');
      try {
        const created = await flowApi.create(name);
        if (doc) {
          const saved = await flowApi.save(created.flowId, 1, name, doc);
          // E-1: ein fertig gebautes Dokument (Baukasten/Vorlage) geht auf den
          // Prüf-Schritt; die leere Fläche öffnet direkt im Editor.
          setEditing({
            flowId: saved.flowId, version: saved.flowVersion, palette, view: 'review',
          });
        } else {
          setEditing({ flowId: created.flowId, version: created.flowVersion, palette });
        }
      } catch (e) {
        fail(flowFailure(e, 'Die Regel konnte nicht angelegt werden.'));
      } finally {
        setBusy(false);
      }
    },
    [flowApi, fail, flowFailure],
  );

  /**
   * Eine BESTEHENDE Regel wurde im Baukasten überarbeitet: der Server legt beim
   * Speichern auf einer simulierten/aktiven Version eine NEUE Entwurfs-Version
   * an - die Antwort trägt sie, also wird sie und nicht die gesendete geöffnet.
   */
  const saveEdited = useCallback(
    async (flowId: string, version: number, name: string, doc: FlowDocument) => {
      setBusy(true);
      setError('');
      try {
        const saved = await flowApi.save(flowId, version, name, doc);
        setEditing({
          flowId: saved.flowId,
          version: saved.flowVersion,
          palette: flowMode(doc),
          view: 'review',
        });
      } catch (e) {
        fail(flowFailure(e, 'Die Regel konnte nicht gespeichert werden.'));
      } finally {
        setBusy(false);
      }
    },
    [flowApi, fail, flowFailure],
  );

  /** Der Profil-Schalter schreibt NUR den Willen; der Server schaltet frei. */
  const toggleProfile = useCallback(
    async (id: string, next: ProfileState) => {
      setToggling(id);
      setError('');
      try {
        setProfiles(await api.setSiteProfile(site.id, id, next));
        reload();
      } catch (e) {
        fail(
          e instanceof ApiError && e.message
            ? e.message
            : 'Das Betriebsmodell konnte nicht umgeschaltet werden. Bitte später erneut versuchen.',
        );
      } finally {
        setToggling(null);
      }
    },
    [site.id, reload, fail],
  );

  /** Eine Unterseite DIESER Anlage öffnen (Behebungs-Wege, Container-Ziele). */
  const openSub = useCallback(
    (sub: AnlagenSub) => {
      if (onOpenSub) onOpenSub(sub);
      else window.location.hash = hashForRoute(anlageRoute(site.id, sub));
    },
    [onOpenSub, site.id],
  );

  /**
   * Zone ③ · die RADIOGRUPPE. `null` = zurück in den Grundmodus.
   *
   * ⚠ **Es wird IMMER nur EIN Aufruf abgesetzt** — das Abschalten des alten
   * Modells macht der SERVER in derselben Transaktion (`SiteProfileService`).
   * Zwei Aufrufe nacheinander hätten ein Fenster, in dem beide oder keines an
   * ist, und ein Fehlschlag dazwischen ließe die Anlage in genau diesem
   * halben Zustand zurück.
   */
  const waehleModell = useCallback(
    (karte: BetriebsmodellKarte | null) => {
      // ⚠ Auf einer ALTBESTANDS-Anlage laufen mehrere zugleich; `zone.aktiv` ist
      // dann bewusst null (es gibt kein EINES). Was durch die Wahl ENDET, sind
      // die anderen laufenden — die Karte muss sie beim Namen nennen, sonst
      // verschwiege sie genau die Folge, wegen der gefragt wird.
      const endende = zone.altbestand.length > 0
        ? zone.altbestand.filter((k) => k.id !== (karte?.id ?? null))
        : (zone.aktiv && zone.aktiv.id !== (karte?.id ?? null) ? [zone.aktiv] : []);
      // Die Wahl, die schon gilt, ist keine Entscheidung — ein Radio kann sich
      // nicht selbst abwählen, und eine Rückfrage darüber wäre Rauschen.
      if (endende.length === 0 && (karte?.id ?? null) === (zone.aktiv?.id ?? null)) return;
      if (!karte) {
        if (endende.length === 0) return;
        // Zurück in den Grundmodus: es endet ALLES, was gerade läuft.
        setFolgen({
          karte: ausschaltFolgen(endende.map((k) => k.label).join('" und „')),
          run: () => {
            for (const k of endende) void toggleProfile(k.id, 'aus');
          },
        });
        return;
      }
      setFolgen({
        karte: wechselFolgen({
          von: endende.length > 0 ? endende.map((k) => k.label).join('" und „') : null,
          nach: karte.label,
          belegVon: endende.length === 1 ? endende[0].beleg : null,
          risikoNach: karte.blockedReason,
        }),
        run: () => void toggleProfile(karte.id, 'an'),
      });
    },
    [zone, toggleProfile],
  );

  /** Zone ③ · ein Modell OHNE Gruppe (eigener Schalter, keine Wechsel-Karte). */
  const schalteModell = useCallback(
    (karte: BetriebsmodellKarte, an: boolean) => {
      if (!an) {
        setFolgen({
          karte: ausschaltFolgen(karte.label),
          run: () => void toggleProfile(karte.id, 'aus'),
        });
        return;
      }
      setFolgen({
        karte: wechselFolgen({ von: null, nach: karte.label, risikoNach: karte.blockedReason }),
        run: () => void toggleProfile(karte.id, 'an'),
      });
    },
    [toggleProfile],
  );

  /**
   * Der Behebungs-Weg einer Ampel-Zeile. Es gibt bewusst NUR die drei Ziele,
   * die es wirklich gibt — ein viertes Wort führt nirgendwohin, also wird auch
   * nichts getan (der Server sendet nie eines, das der Katalog nicht kennt).
   */
  const geheWeg = useCallback(
    (zeile: AmpelZeile) => {
      if (!zeile.weg) return;
      if (zeile.weg.ziel === 'einstellungen') openSub('technik');
      else if (zeile.weg.ziel === 'modell') openSub('modell');
      else if (zeile.weg.ziel === 'ladepark') {
        // Der Ladepark wohnt auf DIESER Seite — ein Nav-Sprung führte im Kreis.
        document.getElementById('vp-ladepark')?.scrollIntoView({ block: 'start' });
      }
    },
    [openSub],
  );

  /** Eine Ansicht dieses Modus öffnen (Container → Sidebar-Ziel). */
  const navigateView = useCallback(
    (target: NavTarget) => {
      if (target.kind === 'sub') {
        if (target.sub == null) return;
        openSub(target.sub);
      } else if (target.kind === 'page') {
        window.location.hash = hashForRoute(pageRoute(target.page));
      }
    },
    [openSub],
  );

  /** „Flow öffnen" aus dem Container: den echten Flow des Modus öffnen. */
  /**
   * Die STEUERART eines Ladepunkts als Wort - für die Jetzt-Zeile.
   *
   * ⚠ Sie wird ÜBERGEBEN, nie in der Jetzt-Zone geraten: sie kommt aus dem
   * Lese-Aggregat, das der Server projiziert hat. Kennt es die Komponente
   * nicht (älteres Backend, noch nicht geladen), bleibt die Quelle der Zeile
   * ehrlich leer.
   */
  const steuerartVon = useCallback(
    (entityId: string | null | undefined): string | null => {
      if (!entityId || !verbraucher) return null;
      const e = verbraucher.verbraucher.find((x) => x.entityId === entityId);
      return e ? quelleLang(e.steuerart) : null;
    },
    [verbraucher],
  );

  /**
   * Der NAME zum Karten-Pseudonym einer laufenden Ladung (P7).
   *
   * ⚠ NUR ein BENANNTES Fahrzeug wird genannt. „Karte 1f2e…" in der Jetzt-Zeile
   * beantwortete keine Frage - der Kunde erkennt daran nichts wieder, und die
   * Zeile trüge ein Wort mehr ohne eine Aussage mehr. Wer benennen will, tut es
   * in der Fahrzeuge-Karte oder aus dem Ladevorgangs-Verlauf heraus.
   */
  const fahrzeugVon = useCallback(
    (tagRef: string | null | undefined): string | null => {
      if (!tagRef || !fahrzeuge) return null;
      const f = fahrzeuge.fahrzeuge.find((x) => x.tagRef === tagRef);
      const name = (f?.name ?? '').trim();
      return name || null;
    },
    [fahrzeuge],
  );

  /**
   * Der Sprung „N Regeln →" in die Regel-Kapsel.
   *
   * ⚠ Er SCROLLT, er filtert (noch) nicht. Das gefilterte Bild „Regeln ·
   * Wallbox Garage (2)" gehört zu P2; der bestehende `?komponente=`-Parameter
   * dieser Seite führt in den Baukasten (die Selbstbau-Brücke) und wäre hier
   * das falsche Ziel. Ein Scroll ist wenig - aber er führt nirgends hin, wo
   * der Kunde nicht hinwollte.
   */
  const setRegelSprung = useCallback((_entityId: string) => {
    document.getElementById('vp-regeln')?.scrollIntoView({ block: 'start' });
  }, []);

  const openContainerFlow = useCallback(
    (flowRef: { flowId: string; name: string }) => {
      const flow = (flows ?? []).find((f) => f.flowId === flowRef.flowId);
      if (flow) openFlow(flow.flowId, flow.latestVersion, flow.latestDocument);
    },
    [flows, openFlow],
  );

  if (editing) {
    return (
      <FlowEditorPage
        api={flowApi}
        site={site}
        flowId={editing.flowId}
        initialVersion={editing.version}
        canEnableGated={isAdmin}
        lockedHint={EINRICHTUNG_DURCH_VOLTPILOT}
        paletteFilter={paletteFilterFor(editing.palette)}
        initialView={editing.view ?? 'editor'}
        backLabel="Zur Steuerung"
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  // v3.1-M2: ist ein Modus-Container geöffnet, ersetzt er die zwei Kapseln.
  // `profiles` bleibt über einen Reload erhalten, der Container flackert also
  // beim Umschalten nicht weg.
  const openProfile =
    openContainer != null
      ? profiles?.profiles.find((p) => p.id === openContainer) ?? null
      : null;
  if (openProfile) {
    const mode = modes.find((m) => String(m.kind) === openProfile.id) ?? null;
    return (
      <div className="vp-steuerung vp-steuerung-area">
        <div ref={noticeRef}>
          {error && (
            <p className="vp-flowed-notice error" role="alert">
              {error}
            </p>
          )}
        </div>
        <ModusContainer
          profile={openProfile}
          mode={mode}
          activeModes={modes}
          baseViews={baseViews}
          site={siteState}
          battery={battery}
          earnings={earnings}
          busy={toggling === openProfile.id}
          onToggle={toggleProfile}
          onBack={() => setOpenContainer(null)}
          onNavigate={navigateView}
          onOpenFlow={openContainerFlow}
          onSiteSaved={handleSiteSaved}
          onBatterySaved={handleBatterySaved}
        />
      </div>
    );
  }

  return (
    <div className="vp-steuerung vp-steuerung-area">
      <div ref={noticeRef}>
        {error && (
          <p className="vp-flowed-notice error" role="alert">
            {error}
          </p>
        )}
      </div>

      {listState === 'loading' && <TextSkeleton lines={5} />}
      {listState === 'error' && (
        <ErrorState message="Die Steuerung konnte nicht geladen werden." onRetry={reload} />
      )}

      {listState === 'idle' && flows && (
        <>
          {/* --- Steuern-Regel (Captain 15.09.2026) ------------------------
              Eine Anlage, die nur misst, bekommt hier KEINEN Hinweis, der
              Steuern anbietet („aufnehmen", „einrichten", „Gerät anbinden") —
              auch nicht, wenn am Standort eine andere Anlage steuert. Die Seite
              selbst bleibt: die Zonen darunter sind der Weg zu Steuerart und
              Regeln. Still heißt nicht Sackgasse. */}
          {/* --- Erstbegegnung (Konzept b3 §3.9, Stufe 8) -------------------
              Drei Zonen in drei Sätzen, einmal wegklickbar, je ORGANISATION
              gemerkt. Er steht ÜBER den Zonen, weil er sie erklärt - und er
              rendert sich selbst weg, sobald der Kunde ihn gesehen hat. */}

          <SteuerungIntro />

          {/* --- Zone ① · Jetzt (Konzept b3 §3.2, Stufe 1) ------------------
              Sie steht ZUERST, weil sie die häufigste Frage beantwortet: der
              Kunde kommt, weil gerade etwas passiert — oder nicht passiert. */}
          <JetztZone
            site={siteState}
            charging={charging}
            speicherRegelAktiv={speicherRegelAktiv}
            speicherName={speicherName}
            steuerart={steuerartVon}
            fahrzeug={fahrzeugVon}
          />

          {/* --- Zone ② · Verbraucher (Verbrauchsmanagement v1 §6.1) -------
              Sie steht ZWISCHEN „Jetzt" und „Regeln", weil sie die Frage
              danach beantwortet: was passiert gerade — und wie ist es
              GRUNDSÄTZLICH eingestellt? In diesem Paket ist sie LESEND; der
              Steuerart-Dialog kommt mit P2. */}
          {/* --- Erstbesuch der Verbraucher-Zone (§7.4) --------------------
              Was VoltPilot aus dem Bestand übernommen hat — einmal je Anlage,
              und nur, wenn es wirklich etwas zu übernehmen gab. */}
          <SteuerartIntro siteId={site.id} daten={verbraucher} />

          <VerbraucherZone
            daten={verbraucher}
            onRegeln={(entityId) => setRegelSprung(entityId)}
            onSteuerart={(entityId) => {
              setSteuerartFehler(null);
              setSteuerartVorbelegung(null);
              setSteuerartFuer(entityId);
            }}
            onEinstellungen={charging && charging.chargers.length > 0
              ? () => document.getElementById('vp-ladepark')?.scrollIntoView({ block: 'start' })
              : undefined}
            /* Paket P4: die Reihenfolge bei knapper Leistung. Die Antwort IST
               die Normalform - sie ersetzt den Zustand, statt ihn zu ergänzen,
               damit die Fläche nie eine Anordnung stehen lässt, die niemand
               gespeichert hat. */
            onRangliste={async (rumpf) => {
              setVerbraucher(await api.saveRangliste(site.id, rumpf));
            }}
            /* Paket P7: die Fahrzeug-Profile. Die Antwort ersetzt die Liste -
               dieselbe Disziplin wie bei der Rangliste, damit die Fläche nie
               einen Zustand zeigt, den niemand gespeichert hat. */
            fahrzeuge={fahrzeuge}
            onFahrzeug={async (tagRef, wunsch) => {
              setFahrzeuge(await api.setzeFahrzeug(site.id, tagRef, wunsch));
            }}
            onFahrzeugEntfernen={async (tagRef) => {
              setFahrzeuge(await api.entferneFahrzeugProfil(site.id, tagRef));
            }}
          />

          {/* --- Der Steuerart-Dialog (P2) --------------------------------
              Er hängt an der Zone, nicht an einer Route: eine Steuerart ist
              eine Einstellung dieser Seite, kein eigener Ort. */}
          {steuerartFuer && verbraucher && (() => {
            const eintrag = verbraucher.verbraucher.find(
              (e) => e.entityId === steuerartFuer);
            if (!eintrag) return null;
            return (
              <SteuerartDialog
                eintrag={eintrag}
                standard={verbraucher.ladepunkte?.standard ?? null}
                busy={steuerartBusy}
                fehler={steuerartFehler}
                vorbelegung={steuerartVorbelegung}
                onClose={() => setSteuerartFuer(null)}
                onSpeichern={(wunsch) => {
                  setSteuerartBusy(true);
                  setSteuerartFehler(null);
                  api.setzeSteuerart(site.id, eintrag.entityId, wunsch)
                    .then((res) => {
                      setSteuerartFuer(null);
                      // ⚠ Eine ABGELEHNTE Aktivierung ist kein Fehler, sondern
                      // ein benannter Ausgang: die Steuerart ist gespeichert,
                      // und der Satz des Servers sagt, was noch fehlt.
                      if (!res.aktiv && res.nachricht) fail(res.nachricht);
                      reload();
                    })
                    .catch((e) => setSteuerartFehler(
                      e instanceof ApiError ? e.message
                        : 'Die Steuerart konnte nicht gespeichert werden.'))
                    .finally(() => setSteuerartBusy(false));
                }}
              />
            );
          })()}

          {/* --- Kapsel ③ · Regeln (Naming Set A) -------------------------- */}
          <div id="vp-regeln">
          <RegelnKapsel
            site={site}
            flows={flows}
            entities={entities}
            flowApi={flowApi}
            lockedKinds={lockedCondKinds}
            lockedHint={EINRICHTUNG_DURCH_VOLTPILOT}
            busy={busy}
            onBusy={setBusy}
            onError={(m) => (m ? fail(m) : setError(''))}
            onReload={reload}
            onOpenFlow={openFlow}
            onBuiltFlow={(name, doc) => void openSaved(name, doc, 'automation')}
            onEditedFlow={(flowId, version, name, doc) =>
              void saveEdited(flowId, version, name, doc)}
            onOpenEditor={() => void openSaved('Neue Regel', null, 'automation')}
            onSteuerart={(entityId, wunsch) => {
              setSteuerartFehler(null);
              setSteuerartVorbelegung(wunsch);
              setSteuerartFuer(entityId);
            }}
          />
          </div>

          {/* --- Zone ④ · Betriebsmodelle (Konzept b3 §3.4, Stufe 5) --------
              Radio statt unabhängiger Schalter: es fährt immer genau EINES,
              oder der Grundmodus. Die Exklusivität erzwingt der SERVER — hier
              steht nur, wie sie aussieht und was der Kunde vorher liest.

              ⚠ Das Ladepark-Lastmanagement steht hier NICHT mehr (es ist
              Schutz, kein Betriebsmodell) — sein Platz ist der Ladepark-Rahmen
              im Kopf des Ladepunkt-Abschnitts von Zone ②. */}
          <Betriebsmodelle
            zone={zone}
            title={PROFILE_CAPSULE_TITLE}
            intro={PROFILE_CAPSULE_INTRO}
            emptyText={PROFILE_CAPSULE_EMPTY}
            busyId={toggling}
            onWaehlen={waehleModell}
            onSchalten={schalteModell}
            onOpen={setOpenContainer}
            onWeg={geheWeg}
          />

          {/* --- Der Ladepark-RAHMEN (nur mit Ladesäulen) ------------------
              ⚠ Er steht bewusst UNTER den vier Zonen: der Rahmen-Kopf von
              Zone ② verlinkt hierher („Einstellungen"), aber die Zonen selbst
              sollen ununterbrochen aufeinander folgen.

              P5/E10: die frühere Ladepark-KAPSEL ist hier aufgegangen. Ihre
              zwei Radio-Gruppen sind ERSATZLOS entfallen — die Quellen-Wahl ist
              der Anlagen-Standard bzw. die Steuerart je Säule (Zone ②), der
              Speicher-Vorrang ist die Rangliste (Zone ③). Geblieben ist die
              Anschlussgrenze; dazugekommen sind die Rahmen-Werte zum LESEN. */}
          {charging && charging.chargers.length > 0 && (
            <div id="vp-ladepark">
              <LadeparkRahmenKarte
                site={siteState}
                rahmen={verbraucher?.ladepunkte?.rahmen ?? null}
              />
            </div>
          )}

          {/* --- Der BEFEHLS-VERLAUF (Kommando-Transparenz V1, F2) ---------
              Der zweite Einstieg neben der Komponenten-Karte: „was schickt
              VoltPilot wirklich an meine Geräte?" gehört neben die Frage
              „was steuert eigentlich?". Ohne gewählte Komponente zeigt die
              Seite den Verlauf der ganzen Anlage. */}
          <p className="vp-protline">
            <Icon name="shield" size={14} />
            <a href={befehleHash(site.id)}>Befehle an Ihre Geräte ansehen →</a>
          </p>

          {/* --- Die schmale Schutz-Zeile --------------------------------- */}
          <p className="vp-protline">
            <Icon name="shield" size={14} />
            <span className="vp-protline-intro">{PROTECTION_INTRO}</span>
            {protections.map((p) => (
              <span key={p.key} className="vp-protline-item">
                {p.label} <InfoTip title={p.label}>{p.tip}</InfoTip>
              </span>
            ))}
          </p>

          {folgen && (
            <ConfirmDialog
              open
              title={folgen.karte.titel}
              intro={folgen.karte.intro}
              consequences={folgenZeilen(folgen.karte)}
              confirmLabel={folgen.karte.bestaetigen}
              busy={toggling != null}
              onConfirm={() => {
                const run = folgen.run;
                setFolgen(null);
                run();
              }}
              onCancel={() => setFolgen(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
