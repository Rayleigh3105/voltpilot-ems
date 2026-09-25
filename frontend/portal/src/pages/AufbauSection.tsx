import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
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
} from '../aufbauBaum';
import {
  LEERER_FILTER,
  aufbauZahlen,
  filterOptionen,
  tabellenZeilen,
  type AufbauFilter,
} from '../aufbauTabelle';
import { AufbauSymbol, AufbauTabelle } from '../components/AufbauTabelle';
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
  befehleHash,
  geraetBearbeitenHash,
  geraetKomponenteBearbeitenHash,
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
import { AnlegenFlow } from '../components/AnlegenFlow';
import { AddDeviceDrawer, DeviceDetailDrawer } from '../components/DeviceDrawers';
import { AnlageAnlegenDrawerLazy } from '../components/AnlageAnlegenDrawerLazy';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { ablehnungText, haltGrund, ohneMesswertHinweis, sollIstText, sollIstTon, verwaltungsHinweis } from '../komponentenAssistent';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { LIST_POLL_MS } from '../pollCadence';
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
  // Suche und Filter der Tabelle, und die Geräte mit aufgeklappten Messwerten (K5).
  const [filter, setFilter] = useState<AufbauFilter>(LEERER_FILTER);
  const [geraetOffen, setGeraetOffen] = useState<ReadonlySet<string>>(() => new Set());
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

  const zeilen = useMemo(
    () => tabellenZeilen(baum, filter, { offen: (id, vorgabe) => (id in zu ? !zu[id] : vorgabe), geraete: geraetOffen }),
    [baum, filter, zu, geraetOffen],
  );
  const optionen = useMemo(() => filterOptionen(baum), [baum]);
  const zahlen = useMemo(() => aufbauZahlen(baum, filter), [baum, filter]);

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
  const kurzblick = alleGeraete.find((x) => x.geraet.id === kurzblickId) ?? null;
  // Das Modal blendet aus: sein Inhalt bleibt während der Ausblendung stehen.
  const letzterKurzblick = useRef<typeof kurzblick>(null);
  if (kurzblick) letzterKurzblick.current = kurzblick;
  const kurzblickInhalt = kurzblick ?? letzterKurzblick.current;

  const oeffneAnlegen = (box: Device | null, typ: TypId | null = null) => {
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
        <AufbauTabelle
          wurzel={baum.wurzel}
          anlagenZahl={baum.anlagen.length}
          boxZahl={baum.boxZahl}
          zeilen={zeilen}
          filter={filter}
          optionen={optionen}
          zahlen={zahlen}
          onFilter={setFilter}
          onAnlageUmschalten={(a) => umschalten(a, a.id, a.aktuell)}
          onBoxUmschalten={(b) => umschalten(null, b.id, true)}
          onGeraetUmschalten={(id) =>
            setGeraetOffen((alt) => {
              const neu = new Set(alt);
              if (neu.has(id)) neu.delete(id);
              else neu.add(id);
              return neu;
            })
          }
          onKurzblick={setKurzblickId}
          onUebernehmen={setAssign}
          onTechnischUebernehmen={showTechnical ? setTechnikAdopt : null}
          onGeraetHinzufuegen={
            portalManaged ? (b) => oeffneAnlegen(b ? eigeneBoxen.find((d) => d.id === b.id) ?? null : boxOf(devices, site.id)) : null
          }
          geraetGesperrt={
            components && !portalManaged
              ? components.componentAuthority === 'box'
                ? 'Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.'
                : 'Für diese Anlage ist keine Gerätebearbeitung im Portal freigegeben.'
              : null
          }
          onBoxHinzufuegen={() => setBoxAnmelden(true)}
          onAnlageHinzufuegen={() => setAnlageAnlegen(true)}
          onBoxVerwalten={(b) => setBoxVerwalten(b.id)}
          hinweisFor={(g) => g.karte.komponenten.map((c) => ohneMesswertById.get(c.entityId)?.badge).find(Boolean) ?? null}
          technik={
            showTechnical ? (
              <button type="button" className="vp-auf-technik-add" onClick={() => setTechnikDrawer({ mode: 'create' })}>
                <Icon name="cpu" size={14} /> Komponente anlegen (technisch)
              </button>
            ) : null
          }
        />
      )}

      {showTechnical && <RollenZuordnung siteId={site.id} topology={topology} onChanged={setTopology} />}

      {/* ---------- Kurzblick (E2) ---------- */}
      <Modal
        open={kurzblick != null}
        onClose={() => setKurzblickId(null)}
        title={kurzblickInhalt?.geraet.titel ?? ''}
        icon={kurzblickInhalt ? <AufbauSymbol kategorie={kurzblickInhalt.geraet.kategorie} icon={kurzblickInhalt.geraet.icon} /> : null}
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
// Zustands-Punkte (Kurzblick)
// ---------------------------------------------------------------------------

const TON_PUNKT: Record<'ok' | 'warn' | 'off', string> = {
  ok: 'vp-health-ok',
  warn: 'vp-health-warn',
  off: 'vp-health-off',
};

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
