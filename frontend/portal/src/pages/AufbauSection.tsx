import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type Device,
  type EntityStrategy,
  type Overview,
  type Site,
  type SiteComponents,
  type SiteComponentTemplate,
  type SiteEntities,
  type SiteEntity,
  type SiteSource,
  type SiteTopology,
  type StandorteAmStichtag,
} from '../api';
import {
  CONTROL_BADGE,
  componentActions,
  ioBindungenAus,
  plantModel,
  reconnectCandidates,
  type ComponentHealth,
  type PlantComponent,
} from '../komponenten';
import { showTechnicalLayer, type AdoptableSource } from '../rollen';
import { boxOf, boxRefOf } from '../geraetSeite';
import { zentraleListe, zentraleSatz, type GeraeteKarte } from '../zentraleListe';
import {
  aufbauBaum,
  type AufbauAnlage,
  type AufbauBox,
  type AufbauGeraet,
  type AufbauWert,
  type AufbauWurzel,
} from '../aufbauBaum';
import type { SiteCharging } from '../ladepunkte';
import { ZuordnenDialog } from '../components/ZuordnenDialog';
import { SchaltFreigabeDrawer } from '../components/SchaltFreigabeDrawer';
import { freigabeZustand } from '../schaltFreigabe';
import { REGEL_BRUECKE_LABEL, bietetRegelBruecke, regelBrueckeHash } from '../selbstbauBruecke';
import { UmbenennenDialog } from '../components/UmbenennenDialog';
import { KomponenteLoeschenDialog, ZuordnungAendernDialog } from '../components/ZuordnungAendern';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import { sofortAktionen, SOFORT_LABEL, type SofortAktion } from '../consumers/fulfillment';
import { InfoTip } from '../components/InfoTip';
import { ErrorState, TextSkeleton } from '../components/States';
import { fmtNum } from '../format';
import { NO_DATA } from '../nodata';
import { BEFEHLE_LABEL } from '../befehle';
import { SPEICHER_BLATT_LABEL, SPEICHER_KACHEL } from '../geraetGesicht';
import { abschnittHash } from '../geraetRahmen';
import {
  anlageRoute,
  befehleHash,
  geraetBearbeitenHash,
  geraetKomponenteBearbeitenHash,
  hashForRoute,
  komponenteBearbeitenHash,
  modellBearbeitenKomponente,
  ohneModellBearbeiten,
  parseKomponente,
} from '../nav';
import type { TypId } from '../anlegenFlow';
import {
  AdoptDrawer,
  EntityDrawer,
  RegistryDrift,
  RollenZuordnung,
  TechnischeZeile,
  type DrawerState,
} from '../components/TechnischeKarten';
import { entitiesApi, type EntityTypeDef } from '../entitiesApi';
import { EigeneVorlagenPanel } from '../components/EigeneVorlagenPanel';
import { AnlegenFlow } from '../components/AnlegenFlow';
import { AddDeviceDrawer, DeviceDetailDrawer } from '../components/DeviceDrawers';
import { AnlageAnlegenDrawerLazy } from '../components/AnlageAnlegenDrawerLazy';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { ablehnungText, haltGrund, ohneMesswertHinweis, sollIstText, sollIstTon, verwaltungsHinweis } from '../komponentenAssistent';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { LIST_POLL_MS } from '../pollCadence';
import { mitStaffel, useStaffel } from '../staffel';
import '../components/Aufbau.css';

/**
 * Der Reiter **„Aufbau"** (Konzept „Anlage – neu gedacht", Entscheide E1–E6 = A
 * vom 25.09.2026): EIN Baum Standort → Anlagen → VoltPilot-Boxen → Geräte statt
 * der zwei Sichten Anlagenbild + Liste.
 *
 * - **Zahlen statt Sätze.** Jede Zeile trägt Name, Zustandspunkt und ihre Werte
 *   als kurze Chips; Erklärungen stehen erst im Kurzblick.
 * - **E2 · Tippen öffnet den Kurzblick** (zentriertes `Modal`, am Telefon ein
 *   Vollbild-Blatt): Werte je Komponente, Steuerung, alle Handlungen, und einen
 *   Tipp weiter die Geräteseite.
 * - **E3 · Alle Ebenen, immer.** Auch mit einer Anlage und einer Box steht der
 *   Baum gleich da - die Struktur ändert sich nicht, sobald eine zweite Box kommt.
 * - **E4 · Hinzufügen, wo es hingehört.** „+ Hinzufügen" am Standort fragt
 *   Gerät · VoltPilot-Box · Anlage; „+" an einer Box beginnt direkt beim Gerät.
 *   Was die Box selbst meldet, steht gestrichelt im Baum („Übernehmen").
 *
 * Die Daten sind dieselben wie vorher (`plantModel` → `zentraleListe`); die
 * Anordnung im Baum ist die reine Ableitung `aufbauBaum.ts`. Diese Datei rendert
 * nur. Die technische Sicht (Installateur) steht - wie vorher - ausschließlich
 * hinter dem EINEN Tor `showTechnicalLayer()`.
 */
export function AufbauSection({
  site,
  sites,
  devices,
  devicesFetchedAt = null,
  onReload,
}: {
  site: Site;
  /** Alle Anlagen des Kunden - für neue Anlagen am Standort. */
  sites?: Site[];
  /** Die Boxen der Schale (alle Anlagen), mit ihrer Anlage. */
  devices?: Device[];
  /** Bezugszeit der Boxenliste - die Box altert dagegen, nie gegen eine Wanduhr. */
  devicesFetchedAt?: number | null;
  /** Nach „Box hinzufügen"/„Anlage anlegen": die Schale lädt neu (optional mit Auswahl). */
  onReload?: (selectSiteId?: string) => void;
}) {
  const showTechnical = showTechnicalLayer();
  const [data, setData] = useState<SiteEntities | null>(null);
  const [dataSiteId, setDataSiteId] = useState<string | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [components, setComponents] = useState<SiteComponents | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Aufgaben-Flächen
  const [kurzblickId, setKurzblickId] = useState<string | null>(null);
  const [hinzufuegen, setHinzufuegen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addBox, setAddBox] = useState<Device | null>(null);
  const [addTyp, setAddTyp] = useState<TypId | null>(null);
  const [vorlage, setVorlage] = useState<SiteComponentTemplate | null>(null);
  const [boxAnmelden, setBoxAnmelden] = useState(false);
  const [boxVerwalten, setBoxVerwalten] = useState<string | null>(null);
  const [anlageAnlegen, setAnlageAnlegen] = useState(false);
  const [assign, setAssign] = useState<AdoptableSource | null>(null);
  const [rename, setRename] = useState<PlantComponent | null>(null);
  const [renameEntry, setRenameEntry] = useState<string | null>(() =>
    modellBearbeitenKomponente(typeof window === 'undefined' ? '' : window.location.hash),
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const [freigabe, setFreigabe] = useState<PlantComponent | null>(null);
  const [repin, setRepin] = useState<PlantComponent | null>(null);
  const [remove, setRemove] = useState<PlantComponent | null>(null);
  const [sofort, setSofort] = useState<{ consumer: Consumer; action: SofortAktion } | null>(null);
  const [sofortBusy, setSofortBusy] = useState(false);

  // Die technische Sicht - nur hinter dem EINEN Tor geholt.
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]>>({});
  const [catalog, setCatalog] = useState<EntityTypeDef[] | null>(null);
  const [technikDrawer, setTechnikDrawer] = useState<DrawerState | null>(null);
  const [technikAdopt, setTechnikAdopt] = useState<AdoptableSource | null>(null);

  // Welche Knoten offen sind (Anlage/Box). Vorgabe: die geöffnete Anlage und
  // ihre Boxen offen, Nachbar-Anlagen zu.
  const [zu, setZu] = useState<Record<string, boolean>>({});
  const [nachbarKarten, setNachbarKarten] = useState<Record<string, GeraeteKarte[] | undefined>>({});
  const nachbarLaeuft = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    setData(null);
    setDataSiteId(null);
    setError(false);
    api.siteEntities(site.id).then(
      (d) => {
        if (!active) return;
        setData(d);
        setDataSiteId(site.id);
      },
      () => active && setError(true),
    );
    // Alles Weitere fail-soft: ohne es fehlt genau seine Angabe, nie der Baum.
    api.topology(site.id).then((t) => active && setTopology(t), () => active && setTopology(null));
    api.siteSources(site.id).then((s) => active && setSources(s), () => active && setSources(null));
    api.siteChargers(site.id).then((c) => active && setCharging(c), () => active && setCharging(null));
    api.siteComponents(site.id).then((c) => active && setComponents(c), () => active && setComponents(null));
    consumersApi.list(site.id).then((l) => active && setConsumers(l ?? []), () => active && setConsumers([]));
    api.standorte().then((s) => active && setStandorte(s), () => active && setStandorte(null));
    api.overview().then((o) => active && setOverview(o), () => active && setOverview(null));
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  useEffect(() => {
    if (!showTechnical) return;
    let active = true;
    api.entityStrategies(site.id).then((m) => active && setStrategies(m), () => active && setStrategies({}));
    entitiesApi.typeCatalog().then((c) => active && setCatalog(c.types), () => active && setCatalog(null));
    return () => {
      active = false;
    };
  }, [showTechnical, site.id, reloadKey]);

  // Die Werte altern: Live-Werte, Säulen und Zustandswörter frisch halten,
  // sonst stünde nach zehn Minuten ein alter Wert da, als wäre er aktuell.
  useFreshnessPoll(() => {
    setNow(Date.now());
    api.topology(site.id).then(setTopology, () => {});
    api.siteChargers(site.id).then(setCharging, () => {});
    api.overview().then(setOverview, () => {});
  }, LIST_POLL_MS);

  const reload = () => setReloadKey((k) => k + 1);

  const model = useMemo(
    () => (data && dataSiteId === site.id ? plantModel(data.entities, topology, data.localSetup, sources, ioBindungenAus(consumers)) : null),
    [data, dataSiteId, site.id, topology, sources, consumers],
  );

  const eigeneBoxen = useMemo(() => (devices ?? []).filter((d) => d.siteId === site.id), [devices, site.id]);
  const boxRef = useMemo(() => boxRefOf(devices, site.id), [devices, site.id]);

  const karten = useMemo(
    () =>
      model
        ? zentraleListe({
            siteId: site.id,
            model,
            devices: eigeneBoxen,
            devicesFetchedAt,
            boxRef,
            localSetup: data?.localSetup ?? null,
            sources,
            charging,
            now,
          })
        : null,
    [model, site.id, eigeneBoxen, devicesFetchedAt, boxRef, data, sources, charging, now],
  );

  const baum = useMemo(
    () =>
      aufbauBaum({
        siteId: site.id,
        siteName: site.name,
        standorte,
        devices: devices ?? [],
        devicesFetchedAt,
        karten,
        localSetup: data?.localSetup ?? null,
        charging,
        registryBoxId: data?.registry?.deviceId ?? null,
        overview: overview?.sites ?? null,
        nachbarKarten,
        now,
      }),
    [site.id, site.name, standorte, devices, devicesFetchedAt, karten, data, charging, overview, nachbarKarten, now],
  );

  const satz = useMemo(() => (karten ? zentraleSatz(karten) : null), [karten]);

  // Der Namens-Einstieg per Adresse (`…/modell?bearbeiten=1&komponente=…`).
  useEffect(() => {
    const onHash = () => setRenameEntry(modellBearbeitenKomponente(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!renameEntry || !model) return;
    const target = model.components.find((c) => c.entityId === renameEntry && c.renameable) ?? null;
    setRenameEntry(null);
    replaceCurrentNavigation(ohneModellBearbeiten(window.location.hash));
    if (!target) {
      setRenameError('Diese Komponente ist nicht mehr verfügbar.');
      return;
    }
    setRenameError(null);
    setRename(target);
  }, [model, renameEntry]);

  // Der Weg ZURÜCK auf eine Komponente (`…/modell?komponente=…`): Cockpit,
  // Regel-Karte und der Anlege-Assistent fragen „wo steht das?" - die Antwort
  // ist die Zeile ihres Geräts, kurz hervorgehoben. Genau einmal je Adresse.
  const [sprungZiel, setSprungZiel] = useState<string | null>(() =>
    parseKomponente(typeof window === 'undefined' ? '' : window.location.hash),
  );
  const [gesprungen, setGesprungen] = useState<string | null>(null);
  useEffect(() => {
    const onHash = () => setSprungZiel(parseKomponente(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!karten || karten.length === 0) return;
    const ziel = sprungZiel;
    if (!ziel || ziel === gesprungen) return;
    setGesprungen(ziel);
    const karte = karten.find((k) => k.art !== 'box' && k.komponenten.some((c) => c.id === ziel || c.entityId === ziel));
    if (!karte) return;
    const el = document.querySelector(`[data-aufbau-geraet="${CSS.escape(karte.id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('is-angesprungen');
    const t = window.setTimeout(() => el.classList.remove('is-angesprungen'), 2400);
    return () => window.clearTimeout(t);
  }, [karten, gesprungen, sprungZiel]);

  const offen = (id: string, vorgabe: boolean) => (id in zu ? !zu[id] : vorgabe);
  const umschalten = (anlage: AufbauAnlage | null, id: string, vorgabe: boolean) => {
    const jetztOffen = offen(id, vorgabe);
    setZu((z) => ({ ...z, [id]: jetztOffen }));
    // Eine Nachbar-Anlage lädt ihre Geräte erst beim ersten Aufklappen.
    if (anlage && !anlage.aktuell && !jetztOffen) ladeNachbar(anlage.id);
  };

  const ladeNachbar = (id: string) => {
    if (nachbarKarten[id] || nachbarLaeuft.current.has(id)) return;
    nachbarLaeuft.current.add(id);
    Promise.all([
      api.siteEntities(id),
      api.siteChargers(id).catch(() => null),
    ]).then(
      ([d, c]) => {
        const m = plantModel(d.entities, null, d.localSetup, null);
        const boxen = (devices ?? []).filter((x) => x.siteId === id);
        setNachbarKarten((alt) => ({
          ...alt,
          [id]: zentraleListe({
            siteId: id,
            model: m,
            devices: boxen,
            devicesFetchedAt,
            boxRef: boxRefOf(devices, id),
            localSetup: d.localSetup,
            sources: null,
            charging: c,
            now: Date.now(),
          }),
        }));
      },
      () => {
        nachbarLaeuft.current.delete(id);
      },
    );
  };

  const runSofort = async (durationMinutes?: number) => {
    if (!sofort) return;
    const { consumer: c, action } = sofort;
    setSofortBusy(true);
    try {
      if (action === 'resume') await consumersApi.clearOverride(site.id, c.id);
      else await consumersApi.startOverride(site.id, c.id, { action, durationMinutes });
    } catch {
      // Eine Anzeige kippt nicht in einen Fehlerzustand - der Dialog schließt.
    } finally {
      setSofort(null);
      setSofortBusy(false);
    }
  };

  /**
   * Der Anlege-Assistent erscheint NUR auf einer portal-verwalteten Anlage: auf
   * einer box-verwalteten würde ein gespeichertes Soll nie wirken.
   */
  const portalManaged = components?.componentAuthority === 'portal';
  const stand = components?.components[0]
    ? {
        text: sollIstText(components.components[0].syncStatus, components.components[0].definitionVersion ?? 1),
        ton: sollIstTon(components.components[0].syncStatus),
      }
    : null;
  const ablehnung = ablehnungText(components?.refusedRevision, components?.refusedReason);
  const halt = haltGrund(components?.components[0]?.syncStatus, components?.heldReason);
  const verwaltung = components ? verwaltungsHinweis(components.componentAuthority, components.adoptedAt) : null;
  const ohneMesswertById = useMemo(() => {
    const out = new Map<string, { badge: string; satz: string }>();
    for (const row of components?.components ?? []) {
      const h = ohneMesswertHinweis(row.connection);
      if (h) out.set(row.id, h);
    }
    return out;
  }, [components]);

  const aktuelleAnlage = baum.anlagen[0];
  const alleGeraete: { geraet: AufbauGeraet; box: AufbauBox | null }[] = [
    ...aktuelleAnlage.boxen.flatMap((b) => b.geraete.map((g) => ({ geraet: g, box: b }))),
    ...aktuelleAnlage.ohneBox.map((g) => ({ geraet: g, box: null })),
  ];
  const funde = alleGeraete.filter((x) => x.geraet.art === 'neu');
  const kurzblick = alleGeraete.find((x) => x.geraet.id === kurzblickId) ?? null;
  // Das Modal blendet aus: sein Inhalt bleibt während der Ausblendung stehen.
  const letzterKurzblick = useRef<typeof kurzblick>(null);
  if (kurzblick) letzterKurzblick.current = kurzblick;
  const kurzblickInhalt = kurzblick ?? letzterKurzblick.current;

  const oeffneAnlegen = (box: Device | null, typ: TypId | null = null) => {
    setHinzufuegen(false);
    setAddBox(box);
    setAddTyp(typ);
    setAddOpen(true);
  };

  /** Eine Handlung aus dem Kurzblick: erst schließen, dann die Aufgabe öffnen. */
  const ausKurzblick = (tu: () => void) => {
    setKurzblickId(null);
    tu();
  };

  if (rename) {
    return (
      <div className="vp-auf">
        <UmbenennenDialog
          key={`rename:${site.id}:${rename.entityId}`}
          inline
          siteId={site.id}
          siteName={site.name}
          geraetKennung={rename.derivedLabel}
          target={{ entityId: rename.entityId, alias: rename.alias, derivedLabel: rename.derivedLabel }}
          onClose={() => setRename(null)}
          onSaved={() => {
            setRename(null);
            setRenameError(null);
            reload();
          }}
        />
      </div>
    );
  }

  const hinweise: { ton: 'warn' | 'ruhig'; text: string }[] = [];
  if (satz && satz.ton === 'warn' && karten && karten.length > 0) hinweise.push({ ton: 'warn', text: satz.text });
  if (components && components.componentAuthority !== 'portal') {
    hinweise.push({
      ton: 'ruhig',
      text:
        components.componentAuthority === 'box'
          ? 'Diese Anlage wird an Ihrer VoltPilot-Box verwaltet. Änderungen nehmen Sie an der Box vor.'
          : 'Für diese Anlage ist keine Gerätebearbeitung im Portal freigegeben.',
    });
  }
  if (verwaltung && components?.componentAuthority === 'portal') hinweise.push({ ton: 'ruhig', text: verwaltung });
  if (stand && stand.ton !== 'ok') hinweise.push({ ton: 'ruhig', text: stand.text });
  if (ablehnung) hinweise.push({ ton: 'warn', text: ablehnung });
  if (halt) hinweise.push({ ton: 'ruhig', text: halt });

  return (
    <div className="vp-auf">
      {renameError && (
        <div className="vp-alert vp-alert-err" role="alert">
          {renameError}
        </div>
      )}

      <Wurzel
        wurzel={baum.wurzel}
        anlagenZahl={baum.anlagen.length}
        boxZahl={baum.boxZahl}
        onHinzufuegen={() => setHinzufuegen(true)}
        technik={
          showTechnical ? (
            <button type="button" className="vp-auf-technik-add" onClick={() => setTechnikDrawer({ mode: 'create' })}>
              <Icon name="cpu" size={14} /> Komponente anlegen (technisch)
            </button>
          ) : null
        }
      />

      {hinweise.length > 0 && (
        <ul className="vp-auf-hinweise">
          {hinweise.map((h) => (
            <li key={h.text} className={`is-${h.ton}`}>
              <Icon name={h.ton === 'warn' ? 'alert-triangle' : 'info'} size={15} />
              <span>{h.text}</span>
            </li>
          ))}
        </ul>
      )}
      {showTechnical && data && <RegistryDrift data={data} />}

      {!data && !error && <TextSkeleton lines={5} />}
      {error && <ErrorState message="Der Aufbau konnte nicht geladen werden." onRetry={reload} />}

      {data && (
        <Baum
          anlagen={baum.anlagen}
          offen={offen}
          onUmschalten={umschalten}
          onKurzblick={setKurzblickId}
          onUebernehmen={setAssign}
          onTechnischUebernehmen={showTechnical ? setTechnikAdopt : null}
          onGeraetAnBox={portalManaged ? (b) => oeffneAnlegen(eigeneBoxen.find((d) => d.id === b.id) ?? null) : null}
          onBoxHinzufuegen={() => setBoxAnmelden(true)}
          onBoxVerwalten={(b) => setBoxVerwalten(b.id)}
          hinweisFor={(g) => g.karte.komponenten.map((c) => ohneMesswertById.get(c.entityId)?.badge).find(Boolean) ?? null}
        />
      )}

      {showTechnical && <RollenZuordnung siteId={site.id} topology={topology} onChanged={setTopology} />}

      {/* ---------- Kurzblick (E2) ---------- */}
      <Modal
        open={kurzblick != null}
        onClose={() => setKurzblickId(null)}
        title={kurzblickInhalt?.geraet.titel ?? ''}
        icon={kurzblickInhalt ? <Kachel geraet={kurzblickInhalt.geraet} /> : null}
        footer={
          // Ohne Geräteseite und ohne Bearbeiten-Ort gibt es keinen Fuß - das
          // Schließen-Kreuz im Kopf reicht.
          kurzblickInhalt && (kurzblickInhalt.geraet.karte.href || bearbeitenHref(kurzblickInhalt.geraet)) ? (
            <KurzblickFuss geraet={kurzblickInhalt.geraet} editHref={bearbeitenHref(kurzblickInhalt.geraet)} />
          ) : null
        }
      >
        {kurzblickInhalt && (
          <Kurzblick
            siteId={site.id}
            geraet={kurzblickInhalt.geraet}
            box={kurzblickInhalt.box}
            actionsFor={(c) => componentActions(c, data?.entities.find((e) => e.id === c.entityId))}
            renameHrefFor={(c) =>
              c.renameable
                ? boxRef && kurzblickInhalt.geraet.karte.href
                  ? geraetKomponenteBearbeitenHash(site.id, boxRef, kurzblickInhalt.geraet.id, c.entityId)
                  : komponenteBearbeitenHash(site.id, c.entityId)
                : null
            }
            sofortFor={(c) => consumers.find((x) => x.id === c.entityId && x.connection === 'connected') ?? null}
            // Die Ausnahme gilt dem Speicher: die PV-Zeile desselben Hybrids trägt sie nicht.
            ohneMesswertFor={(c) => (c.aspect === 'main' ? ohneMesswertById.get(c.entityId) ?? null : null)}
            onSofort={(consumer, action) => ausKurzblick(() => setSofort({ consumer, action }))}
            onFreigabe={(c) => ausKurzblick(() => setFreigabe(c))}
            onRepin={(c) => ausKurzblick(() => setRepin(c))}
            onRemove={(c) => ausKurzblick(() => setRemove(c))}
            onUebernehmen={(q) => ausKurzblick(() => setAssign(q))}
            technik={
              showTechnical
                ? {
                    entityFor: (id) => data?.entities.find((e) => e.id === id) ?? null,
                    strategiesFor: (id) => strategies[id] ?? [],
                    topology,
                    onEdit: (entity) => ausKurzblick(() => setTechnikDrawer({ mode: 'edit', entity })),
                    onAdopt: (q) => ausKurzblick(() => setTechnikAdopt(q)),
                    onChanged: reload,
                  }
                : null
            }
          />
        )}
      </Modal>

      {/* ---------- Hinzufügen (E4) ---------- */}
      <Modal open={hinzufuegen} onClose={() => setHinzufuegen(false)} title="Hinzufügen">
        <div className="vp-auf-add">
          {funde.map(({ geraet }) =>
            geraet.karte.quelle ? (
              <div key={geraet.id} className="vp-auf-fund">
                <span className="vp-auf-tile is-fund" aria-hidden="true">
                  <Icon name="search" size={16} />
                </span>
                <span className="txt">
                  <b>{geraet.titel}</b>
                  <small>{geraet.unterzeile}</small>
                </span>
                <button
                  type="button"
                  className="vp-btn vp-btn--outline vp-btn--sm"
                  onClick={() => {
                    setHinzufuegen(false);
                    setAssign(geraet.karte.quelle as AdoptableSource);
                  }}
                >
                  Übernehmen
                </button>
              </div>
            ) : null,
          )}
          <p className="vp-auf-add-frage">Was möchten Sie hinzufügen?</p>
          <Wahl
            icon="sun"
            kategorie="solar"
            titel="Gerät"
            text={
              portalManaged
                ? 'Wechselrichter, Zähler, Wallbox … an einer Box'
                : 'Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.'
            }
            haupt
            disabled={!portalManaged}
            onClick={() => oeffneAnlegen(boxOf(devices, site.id))}
          />
          <Wahl
            icon="wifi"
            kategorie="navy"
            titel="VoltPilot-Box"
            text="mit der Geräte-ID vom Aufkleber"
            onClick={() => {
              setHinzufuegen(false);
              setBoxAnmelden(true);
            }}
          />
          <Wahl
            icon="layers"
            kategorie="anlage"
            titel="Anlage"
            text={
              baum.wurzel?.art === 'standort'
                ? `weiterer Netzanschluss am Standort ${baum.wurzel.name}`
                : 'weiterer Netzanschluss'
            }
            onClick={() => {
              setHinzufuegen(false);
              setAnlageAnlegen(true);
            }}
          />
          {portalManaged && (
            <details className="vp-auf-vorlagen">
              <summary>
                <Icon name="chevron-right" size={14} /> Aus eigener Vorlage
              </summary>
              <EigeneVorlagenPanel
                siteId={site.id}
                onAnlegen={(v) => {
                  setHinzufuegen(false);
                  setVorlage(v);
                }}
              />
            </details>
          )}
        </div>
      </Modal>

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
        <AnlegenFlow
          siteId={site.id}
          box={addBox ?? boxOf(devices, site.id) ?? undefined}
          vorlage={vorlage}
          initialTyp={vorlage ? null : addTyp}
          onClose={() => {
            setAddOpen(false);
            setAddTyp(null);
            setAddBox(null);
            setVorlage(null);
          }}
          onSaved={(result) => {
            setComponents(result);
            setAddTyp(null);
            reload();
          }}
        />
      )}

      <AddDeviceDrawer
        open={boxAnmelden}
        title="VoltPilot-Box hinzufügen"
        sites={[site]}
        onClose={() => setBoxAnmelden(false)}
        onClaimed={() => onReload?.(site.id)}
      />

      {/* Die Box wohnt seit E5 hier: Name, Typ, Neu-Verbinden und Entfernen
          liegen an ihr, nicht mehr in den Einstellungen. */}
      <DeviceDetailDrawer
        device={eigeneBoxen.find((d) => d.id === boxVerwalten) ?? null}
        sites={sites ?? [site]}
        onClose={() => setBoxVerwalten(null)}
        onChanged={() => onReload?.(site.id)}
      />

      <AnlageAnlegenDrawerLazy
        open={anlageAnlegen}
        onClose={() => setAnlageAnlegen(false)}
        existingSites={sites}
        standortId={baum.wurzel?.art === 'standort' ? baum.wurzel.id : null}
        onChanged={(createdSiteId) => onReload?.(createdSiteId)}
      />

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

      {technikDrawer && catalog && (
        <EntityDrawer
          siteId={site.id}
          catalog={catalog}
          state={technikDrawer}
          onClose={() => setTechnikDrawer(null)}
          onSaved={() => {
            setTechnikDrawer(null);
            reload();
          }}
        />
      )}

      {technikAdopt && catalog && (
        <AdoptDrawer
          siteId={site.id}
          source={technikAdopt}
          catalog={catalog}
          onClose={() => setTechnikAdopt(null)}
          onAdopted={() => {
            setTechnikAdopt(null);
            reload();
          }}
        />
      )}
    </div>
  );

  /** Der EINE Bearbeiten-Ort eines Geräts: der Inline-Modus seiner Geräteseite. */
  function bearbeitenHref(g: AufbauGeraet): string | undefined {
    const k = g.karte;
    if (k.art === 'geraet') {
      const definition = components?.components.find(
        (row) =>
          Boolean(row.templateRef) &&
          (row.edgeSourceId === k.id || k.komponenten.some((c) => c.entityId === row.id)),
      );
      return portalManaged && boxRef && k.href && definition ? geraetBearbeitenHash(site.id, boxRef, k.id) : undefined;
    }
    if (k.art === 'ladepunkt') {
      const c = k.komponenten.find((x) => x.renameable && x.entityId);
      return boxRef && c ? geraetKomponenteBearbeitenHash(site.id, boxRef, k.id, c.entityId) : undefined;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Standort-Kopf
// ---------------------------------------------------------------------------

function Wurzel({
  wurzel,
  anlagenZahl,
  boxZahl,
  onHinzufuegen,
  technik,
}: {
  wurzel: AufbauWurzel | null;
  anlagenZahl: number;
  boxZahl: number;
  onHinzufuegen: () => void;
  technik: ReactNode;
}) {
  return (
    <section className="vp-auf-wurzel" aria-label={wurzel ? `Standort ${wurzel.name}` : 'Aufbau'}>
      <span className={`vp-auf-tile is-navy is-gross${wurzel?.art === 'ohne-standort' ? ' is-leer' : ''}`} aria-hidden="true">
        <Icon name="map-pin" size={20} />
      </span>
      <div className="vp-auf-wurzel-name">
        {wurzel ? (
          <>
            <span className="vp-auf-kicker">
              Standort{wurzel.kurzzeichen ? ` · ${wurzel.kurzzeichen}` : ''}
              {wurzel.entwurf && <span className="vp-auf-pill is-ruhig">Entwurf</span>}
            </span>
            <h2>{wurzel.name}</h2>
            {wurzel.art === 'standort' && (
              <span className="vp-auf-sub">{wurzel.adresse ?? 'Adresse noch nicht hinterlegt'}</span>
            )}
          </>
        ) : (
          <>
            <span className="vp-auf-kicker">Standort</span>
            <h2>Ihre Anlage</h2>
          </>
        )}
      </div>
      <div className="vp-auf-zahlen" aria-label="Umfang">
        <span className="vp-auf-pill">
          {anlagenZahl} {anlagenZahl === 1 ? 'Anlage' : 'Anlagen'}
        </span>
        <span className="vp-auf-pill">
          {boxZahl} {boxZahl === 1 ? 'Box' : 'Boxen'}
        </span>
      </div>
      <div className="vp-auf-wurzel-aktion">
        <button type="button" className="vp-btn vp-btn--primary vp-btn--sm" onClick={onHinzufuegen}>
          <Icon name="plus" size={16} /> Hinzufügen
        </button>
        {technik}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Der Baum
// ---------------------------------------------------------------------------

const TON_PUNKT: Record<'ok' | 'warn' | 'off', string> = {
  ok: 'vp-health-ok',
  warn: 'vp-health-warn',
  off: 'vp-health-off',
};

const WERT_ICON: Record<AufbauWert['art'], IconName> = {
  pv: 'sun',
  speicher: 'battery',
  netz: 'activity',
  haus: 'home',
  verbraucher: 'sliders',
  laden: 'zap',
};

function Chips({ werte }: { werte: AufbauWert[] }) {
  if (werte.length === 0) return null;
  return (
    <span className="vp-auf-chips">
      {werte.map((w) => (
        <span key={`${w.art}:${w.text}`} className={`vp-auf-chip is-${w.art}`} aria-label={w.label} title={w.label}>
          <Icon name={WERT_ICON[w.art]} size={13} />
          <span aria-hidden="true">{w.text}</span>
        </span>
      ))}
    </span>
  );
}

function Kachel({ geraet }: { geraet: AufbauGeraet }) {
  return (
    <span className={`vp-auf-tile is-${geraet.kategorie}`} aria-hidden="true">
      <Icon name={geraet.icon} size={16} />
    </span>
  );
}

function Baum({
  anlagen,
  offen,
  onUmschalten,
  onKurzblick,
  onUebernehmen,
  onTechnischUebernehmen,
  onGeraetAnBox,
  onBoxHinzufuegen,
  onBoxVerwalten,
  hinweisFor,
}: {
  anlagen: AufbauAnlage[];
  offen: (id: string, vorgabe: boolean) => boolean;
  onUmschalten: (anlage: AufbauAnlage | null, id: string, vorgabe: boolean) => void;
  onKurzblick: (id: string) => void;
  onUebernehmen: (q: AdoptableSource) => void;
  onTechnischUebernehmen: ((q: AdoptableSource) => void) | null;
  onGeraetAnBox: ((b: AufbauBox) => void) | null;
  onBoxHinzufuegen: () => void;
  /** Name, Typ, Neu-Verbinden und Entfernen einer Box der geöffneten Anlage. */
  onBoxVerwalten: (b: AufbauBox) => void;
  /** Eine Ausnahme an einer Komponente („ohne Ladestand") - sie steht schon in der Zeile. */
  hinweisFor: (g: AufbauGeraet) => string | null;
}) {
  const staffel = useStaffel('aufbau-baum');
  const geraetZeilen = (geraete: AufbauGeraet[], nurLesend: boolean) =>
    geraete.map((g) => (
      <li key={g.id} className="vp-auf-knoten is-geraet">
        {g.art === 'neu' && g.karte.quelle ? (
          <FundZeile
            geraet={g}
            onUebernehmen={nurLesend ? null : onUebernehmen}
            onTechnisch={nurLesend ? null : onTechnischUebernehmen}
          />
        ) : nurLesend ? (
          g.karte.href ? (
            <a className="vp-auf-zeile" href={g.karte.href} data-aufbau-geraet={g.id}>
              <GeraetInhalt geraet={g} />
            </a>
          ) : (
            <div className="vp-auf-zeile" data-aufbau-geraet={g.id}>
              <GeraetInhalt geraet={g} ohnePfeil />
            </div>
          )
        ) : (
          <button
            type="button"
            className="vp-auf-zeile"
            data-aufbau-geraet={g.id}
            onClick={() => onKurzblick(g.id)}
            aria-haspopup="dialog"
          >
            <GeraetInhalt geraet={g} hinweis={hinweisFor(g)} />
          </button>
        )}
      </li>
    ));

  return (
    <ol className={mitStaffel('vp-auf-baum vp-auf-liste', staffel)} aria-label="Anlagen an diesem Standort">
      {anlagen.map((a) => {
        const anlageOffen = offen(a.id, a.aktuell);
        return (
          <li key={a.id} className={`vp-auf-knoten is-anlage${a.aktuell ? ' is-aktuell' : ''}${anlageOffen ? ' is-offen' : ''}`}>
            <button
              type="button"
              className="vp-auf-zeile"
              aria-expanded={anlageOffen}
              onClick={() => onUmschalten(a, a.id, a.aktuell)}
            >
              <span className="vp-auf-tile is-anlage" aria-hidden="true">
                <Icon name="layers" size={16} />
              </span>
              <span className="vp-auf-name">
                <b>
                  <span className="txt">Anlage {a.name}</span>
                </b>
                <small>
                  {a.aktuell && <span className="vp-auf-hier">Sie sind hier</span>}
                  <span>
                    {a.boxen.length} {a.boxen.length === 1 ? 'Box' : 'Boxen'}
                    {a.geraeteZahl != null && ` · ${a.geraeteZahl} ${a.geraeteZahl === 1 ? 'Gerät' : 'Geräte'}`}
                  </span>
                  {a.wertStand === 'veraltet' && <span className="is-warn">keine aktuellen Werte</span>}
                </small>
              </span>
              <Chips werte={a.werte} />
              <span className="vp-auf-ende" aria-hidden="true">
                <Icon name="chevron-down" size={18} />
              </span>
            </button>
            <div className="vp-auf-kinder">
              <div className="vp-auf-kinder-innen">
                <ol className={mitStaffel('vp-auf-liste', staffel)}>
                  {a.boxen.map((b) => (
                    <li key={b.id} className="vp-auf-knoten is-box">
                      {/* Die Box ist ein TOR mit eigener Seite: ihr Name führt dorthin,
                          „+ Gerät" beginnt an ihr den Anlege-Weg. Ihre Geräte stehen
                          immer darunter (E3) - es gibt nichts zuzuklappen. */}
                      <div className="vp-auf-zeile is-geteilt">
                        <a className="vp-auf-treffer" href={b.href}>
                          <span className="vp-auf-tile is-navy" aria-hidden="true">
                            <Icon name="wifi" size={16} />
                          </span>
                          <span className="vp-auf-name">
                            <b>
                              <span className={`vp-health-dot ${b.ton === 'ok' ? 'vp-fleet-dot tone-ok' : TON_PUNKT[b.ton]}`} />
                              <span className="txt">{b.name}</span>
                            </b>
                            <small>
                              {b.fuehrend && (
                                <span className="vp-auf-fuehrend">
                                  <Icon name="star" size={11} /> führende Box
                                </span>
                              )}
                              <span className="vp-auf-ref">{b.ref}</span>
                              <span className={b.ton === 'ok' ? undefined : 'is-warn'}>{b.zustand}</span>
                            </small>
                          </span>
                          <Icon name="chevron-right" size={18} />
                        </a>
                        {a.aktuell && (
                          <span className="vp-auf-ende">
                            {onGeraetAnBox && (
                              <button
                                type="button"
                                className="vp-auf-plus"
                                onClick={() => onGeraetAnBox(b)}
                                aria-label={`Gerät an ${b.name} hinzufügen`}
                              >
                                <Icon name="plus" size={16} />
                                <span className="lbl" aria-hidden="true">
                                  Gerät
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="vp-auf-plus is-ruhig"
                              onClick={() => onBoxVerwalten(b)}
                              aria-label={`${b.name} verwalten`}
                              aria-haspopup="dialog"
                            >
                              <Icon name="more-horizontal" size={16} />
                            </button>
                          </span>
                        )}
                      </div>
                      <ol className={mitStaffel('vp-auf-liste', staffel)}>
                        {geraetZeilen(b.geraete, !a.aktuell)}
                        {b.geraete.length === 0 && (
                          <li className="vp-auf-knoten is-leer">
                            <span className="vp-auf-leer">
                              {a.aktuell || a.geraeteZahl != null ? 'Noch kein Gerät an dieser Box' : 'Wird geladen …'}
                            </span>
                          </li>
                        )}
                      </ol>
                    </li>
                  ))}
                  {a.ohneBox.length > 0 && geraetZeilen(a.ohneBox, !a.aktuell)}
                  {a.boxen.length === 0 && (
                    <li className="vp-auf-knoten is-leer">
                      {a.aktuell ? (
                        <button type="button" className="vp-auf-leer is-aktion" onClick={onBoxHinzufuegen}>
                          <Icon name="plus" size={15} /> Noch keine VoltPilot-Box – jetzt hinzufügen
                        </button>
                      ) : (
                        <span className="vp-auf-leer">Noch keine VoltPilot-Box</span>
                      )}
                    </li>
                  )}
                </ol>
                {!a.aktuell && (
                  <a className="vp-auf-wechsel" href={hashForRoute(anlageRoute(a.id, 'modell'))}>
                    Zu dieser Anlage wechseln <Icon name="chevron-right" size={14} />
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function GeraetInhalt({
  geraet,
  hinweis = null,
  ohnePfeil = false,
}: {
  geraet: AufbauGeraet;
  hinweis?: string | null;
  ohnePfeil?: boolean;
}) {
  return (
    <>
      <Kachel geraet={geraet} />
      <span className="vp-auf-name">
        <b>
          <span className={`vp-health-dot ${TON_PUNKT[geraet.ton]}`} />
          <span className="txt">{geraet.titel}</span>
        </b>
        <small>
          <span className="vp-auf-modell">{geraet.unterzeile}</span>
          {geraet.ton !== 'ok' && <span className="is-warn">{geraet.zustand}</span>}
          {hinweis && <span className="is-warn">{hinweis}</span>}
        </small>
      </span>
      <Chips werte={geraet.werte} />
      {!ohnePfeil && (
        <span className="vp-auf-ende" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      )}
    </>
  );
}

function FundZeile({
  geraet,
  onUebernehmen,
  onTechnisch,
}: {
  geraet: AufbauGeraet;
  onUebernehmen: ((q: AdoptableSource) => void) | null;
  onTechnisch: ((q: AdoptableSource) => void) | null;
}) {
  const quelle = geraet.karte.quelle as AdoptableSource;
  return (
    <div className="vp-auf-zeile is-fund" data-aufbau-geraet={geraet.id}>
      <Kachel geraet={geraet} />
      <span className="vp-auf-name">
        <b>
          <span className="txt">{geraet.titel}</span>
        </b>
        <small>
          <span className="vp-auf-modell">{geraet.unterzeile}</span>
          <span>noch nicht übernommen</span>
        </small>
      </span>
      {onUebernehmen && (
        <span className="vp-auf-ende">
          <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" onClick={() => onUebernehmen(quelle)}>
            Übernehmen
          </button>
          {/* Die TECHNISCHE Übernahme steht NEBEN der geführten - Typ,
              Nennleistung und MaStR von Hand. */}
          {onTechnisch && (
            <button type="button" className="vp-auf-technik-add" onClick={() => onTechnisch(quelle)}>
              technisch
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hinzufügen: die drei Wege
// ---------------------------------------------------------------------------

function Wahl({
  icon,
  kategorie,
  titel,
  text,
  haupt = false,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  kategorie: string;
  titel: string;
  text: string;
  haupt?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`vp-auf-wahl${haupt ? ' is-haupt' : ''}`} onClick={onClick} disabled={disabled}>
      <span className={`vp-auf-tile is-${kategorie} is-gross`} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="txt">
        <b>{titel}</b>
        <small>{text}</small>
      </span>
      <Icon name="chevron-right" size={18} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Kurzblick (E2)
// ---------------------------------------------------------------------------

interface TechnikSicht {
  entityFor: (entityId: string) => SiteEntity | null;
  strategiesFor: (entityId: string) => EntityStrategy[];
  topology: SiteTopology | null;
  onEdit: (entity: SiteEntity) => void;
  onAdopt: (source: AdoptableSource) => void;
  onChanged: () => void;
}

const HEALTH_TON: Record<ComponentHealth, 'ok' | 'warn' | 'off'> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

/** Die §14a-Erklärung, einmal, dort, wo die maßgebliche Messung steht. */
const PARAGRAF_14A =
  'Am maßgeblichen Netzanschluss zählt, was Sie beziehen und einspeisen. Verlangt Ihr ' +
  'Netzbetreiber kurzzeitig weniger Bezug (§ 14a EnWG), hält VoltPilot diese Grenze ein.';

function Kurzblick({
  siteId,
  geraet,
  box,
  actionsFor,
  renameHrefFor,
  sofortFor,
  ohneMesswertFor,
  onSofort,
  onFreigabe,
  onRepin,
  onRemove,
  onUebernehmen,
  technik,
}: {
  siteId: string;
  geraet: AufbauGeraet;
  box: AufbauBox | null;
  actionsFor: (c: PlantComponent) => { canRepin: boolean; canDelete: boolean };
  renameHrefFor: (c: PlantComponent) => string | null;
  sofortFor: (c: PlantComponent) => Consumer | null;
  ohneMesswertFor: (c: PlantComponent) => { badge: string; satz: string } | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
  onFreigabe: (c: PlantComponent) => void;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  onUebernehmen: (q: AdoptableSource) => void;
  technik: TechnikSicht | null;
}) {
  const k = geraet.karte;
  const komponenten = k.komponenten;
  return (
    <div className="vp-auf-kb">
      <p className="vp-auf-kb-sub">
        {geraet.unterzeile}
        {box ? ` · an ${box.name}` : ''}
      </p>
      <p className="vp-auf-kb-zustand">
        <span className={`vp-health-dot ${TON_PUNKT[geraet.ton]}`} />
        {geraet.zustand}
      </p>
      {k.zusatz && <p className="vp-auf-kb-notiz">{k.zusatz}</p>}

      {k.art === 'neu' && k.quelle && (
        <div className="vp-auf-kb-aktionen">
          <button type="button" className="vp-btn vp-btn--primary vp-btn--sm" onClick={() => onUebernehmen(k.quelle as AdoptableSource)}>
            Übernehmen
          </button>
          {technik && (
            <button type="button" className="vp-auf-technik-add" onClick={() => technik.onAdopt(k.quelle as AdoptableSource)}>
              technisch übernehmen
            </button>
          )}
        </div>
      )}

      {komponenten.length > 0 && (
        <ul className="vp-auf-kb-liste" aria-label="Was dieses Gerät misst">
          {komponenten.map((c) => (
            <KomponenteZeile
              key={c.id}
              siteId={siteId}
              component={c}
              zeigeName={komponenten.length > 1 || c.label !== geraet.titel}
              geraetHref={k.href}
              actions={actionsFor(c)}
              renameHref={renameHrefFor(c)}
              sofort={sofortFor(c)}
              ohneMesswert={ohneMesswertFor(c)}
              onSofort={onSofort}
              onFreigabe={onFreigabe}
              onRepin={onRepin}
              onRemove={onRemove}
              technik={technik}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function KurzblickFuss({ geraet, editHref }: { geraet: AufbauGeraet; editHref: string | undefined }) {
  const href = geraet.karte.href;
  return (
    <div className="vp-auf-kb-fuss">
      {href ? (
        <p className="vp-auf-kb-register">Register lesen und schreiben Sie auf der Geräteseite.</p>
      ) : null}
      <div className="vp-auf-kb-knoepfe">
        {editHref && (
          <a className="vp-btn vp-btn--outline vp-btn--sm" href={editHref}>
            <Icon name="pencil" size={15} /> Bearbeiten
          </a>
        )}
        {href && (
          <a className="vp-btn vp-btn--primary vp-btn--sm" href={href}>
            Geräteseite öffnen <Icon name="chevron-right" size={15} />
          </a>
        )}
      </div>
    </div>
  );
}

function KomponenteZeile({
  siteId,
  component: c,
  zeigeName,
  geraetHref,
  actions,
  renameHref,
  sofort,
  ohneMesswert,
  onSofort,
  onFreigabe,
  onRepin,
  onRemove,
  technik,
}: {
  siteId: string;
  component: PlantComponent;
  zeigeName: boolean;
  geraetHref: string | null;
  actions: { canRepin: boolean; canDelete: boolean };
  renameHref: string | null;
  sofort: Consumer | null;
  ohneMesswert: { badge: string; satz: string } | null;
  onSofort: (consumer: Consumer, action: SofortAktion) => void;
  onFreigabe: (c: PlantComponent) => void;
  onRepin: (c: PlantComponent) => void;
  onRemove: (c: PlantComponent) => void;
  technik: TechnikSicht | null;
}) {
  const entity = technik && c.entityId ? technik.entityFor(c.entityId) : null;
  const regelBruecke = bietetRegelBruecke({
    entityId: c.entityId,
    label: c.label,
    channels: c.channels.map((m) => ({ channel: m.raw })),
  });
  const freigabeAnzeige =
    c.schaltbar || c.freigabeFaehig ? freigabeZustand({ schaltbar: c.schaltbar, quelle: c.freigabeQuelle }) : null;
  const hatMehr =
    sofort != null ||
    c.freigabeFaehig ||
    regelBruecke ||
    c.entityId != null ||
    (c.role === 'storage' && geraetHref != null) ||
    (!c.orphaned && (actions.canRepin || actions.canDelete)) ||
    entity != null ||
    c.channels.length > 0;
  return (
    <li className="vp-auf-kb-zeile" data-komponente={c.id}>
      <div className="vp-auf-kb-kopf">
        <span className={`vp-health-dot ${TON_PUNKT[HEALTH_TON[c.health]]}`} />
        <span className="vp-auf-kb-label">
          {zeigeName ? c.label : 'Messwert'}
          {c.primary && <InfoTip title="Maßgebliche Messung">{PARAGRAF_14A}</InfoTip>}
        </span>
        {renameHref && (
          <a className="vp-auf-stift" href={renameHref} aria-label={`„${c.label}“ umbenennen`}>
            <Icon name="pencil" size={14} />
          </a>
        )}
        <span className={`vp-auf-kb-wert${c.reading ? '' : ' is-leer'}`}>
          {c.reading ? fmtNum(c.reading.value, c.reading.unit) : NO_DATA}
          {c.reading?.caption && <small>{c.reading.caption}</small>}
        </span>
      </div>
      {(c.control || freigabeAnzeige || ohneMesswert || (c.measuredVia && c.reading == null)) && (
        <div className="vp-auf-kb-marken">
          {c.control && (
            <span className="vp-auf-marke is-ok">
              <Icon name="shield" size={12} /> {CONTROL_BADGE}
            </span>
          )}
          {freigabeAnzeige && (
            <span className={`vp-auf-marke is-${freigabeAnzeige.ton}`} title={freigabeAnzeige.satz}>
              <Icon name={freigabeAnzeige.ton === 'ok' ? 'zap' : 'shield'} size={12} /> {freigabeAnzeige.wort}
            </span>
          )}
          {ohneMesswert && (
            <span className="vp-auf-marke is-warn" title={ohneMesswert.satz}>
              <Icon name="alert-triangle" size={12} /> {ohneMesswert.badge}
            </span>
          )}
          {c.measuredVia && c.reading == null && <span className="vp-auf-marke">{c.measuredVia}</span>}
        </div>
      )}
      {ohneMesswert && <p className="vp-auf-kb-notiz">{ohneMesswert.satz}</p>}
      {c.orphaned && (
        <div className="vp-auf-kb-verwaist">
          <Icon name="alert-triangle" size={14} />
          <span>nicht mehr mit einem gemeldeten Gerät verbunden</span>
          {actions.canRepin && (
            <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" onClick={() => onRepin(c)}>
              wieder verbinden
            </button>
          )}
          {actions.canDelete && (
            <button type="button" className="vp-btn vp-btn--sm vp-auf-gefahr" onClick={() => onRemove(c)}>
              löschen
            </button>
          )}
        </div>
      )}
      {hatMehr && (
        <details className="vp-auf-kb-mehr">
          <summary>
            <Icon name="chevron-right" size={13} /> Mehr zu {zeigeName ? c.label : 'diesem Gerät'}
          </summary>
          {c.channels.length > 0 && (
            <span className="vp-auf-kb-kanaele">
              {c.channels.map((ch) => (
                <span key={ch.raw} title={ch.raw}>
                  {ch.label}
                </span>
              ))}
            </span>
          )}
          <span className="vp-auf-kb-aktionen">
            {sofort &&
              sofortAktionen({ connected: true, hasOverride: false }).map((a) => (
                <button key={a} type="button" className="vp-auf-aktion" onClick={() => onSofort(sofort, a)}>
                  <Icon name="zap" size={13} /> {SOFORT_LABEL[a]}
                </button>
              ))}
            {c.freigabeFaehig && (
              <button type="button" className="vp-auf-aktion" onClick={() => onFreigabe(c)}>
                <Icon name="zap" size={13} /> {c.schaltbar ? 'Steuerung dieses Geräts' : 'Steuern freigeben'}
              </button>
            )}
            {regelBruecke && (
              <a className="vp-auf-aktion" href={regelBrueckeHash(siteId, c.entityId)}>
                <Icon name="zap" size={13} /> {REGEL_BRUECKE_LABEL}
              </a>
            )}
            {c.entityId && (
              <a className="vp-auf-aktion" href={befehleHash(siteId, c.entityId)}>
                <Icon name="shield" size={13} /> {BEFEHLE_LABEL}
              </a>
            )}
            {c.role === 'storage' && geraetHref && (
              <a className="vp-auf-aktion" href={abschnittHash(geraetHref, 'buehne', SPEICHER_KACHEL)}>
                <Icon name="battery" size={13} /> {SPEICHER_BLATT_LABEL}
              </a>
            )}
            {!c.orphaned && actions.canRepin && (
              <button type="button" className="vp-auf-aktion" onClick={() => onRepin(c)}>
                <Icon name="link" size={13} /> Zuordnung ändern
              </button>
            )}
            {!c.orphaned && actions.canDelete && (
              <button type="button" className="vp-auf-aktion is-gefahr" onClick={() => onRemove(c)}>
                <Icon name="trash" size={13} /> Komponente löschen
              </button>
            )}
          </span>
          {technik && entity && (
            <TechnischeZeile
              entity={entity}
              siteId={siteId}
              strategies={technik.strategiesFor(entity.id)}
              topology={technik.topology}
              onEdit={() => technik.onEdit(entity)}
              onChanged={technik.onChanged}
            />
          )}
        </details>
      )}
    </li>
  );
}
