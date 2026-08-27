import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type EntityStrategy,
  type Device,
  type Site,
  type SiteComponents,
  type SiteComponentTemplate,
  type SiteComponentRow,
  type SiteEntities,
  type SiteEntity,
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
import { boxOf, boxRefOf } from '../geraetSeite';
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
import { ErrorState, TextSkeleton } from '../components/States';
import { fmtNum } from '../format';
import { NO_DATA } from '../nodata';
import { BEFEHLE_LABEL } from '../befehle';
import { SPEICHER_BLATT_LABEL, SPEICHER_KACHEL } from '../geraetGesicht';
import { abschnittHash } from '../geraetRahmen';
import {
  anlageRoute,
  befehleHash,
  hashForRoute,
  parseKomponente,
  parseZentraleAnsicht,
  zentraleAnsichtHash,
  type ZentraleAnsicht,
} from '../nav';
import { useIsDesktop } from '../useIsPhone';
import { anlagenBild } from '../anlagenBild';
import { AnlagenBild } from '../components/AnlagenBild';
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
import {
  ablehnungText,
  ohneMesswertHinweis,
  sollIstText,
  sollIstTon,
  verwaltungsHinweis,
  type KomponentenRolle,
} from '../komponentenAssistent';
import '../components/AnlagenModell.css';
import '../components/KomponenteAssistent.css';

/**
 * Portal v3 · M6 — the Anlagen-Modell, rebuilt to the approved **Variante A**
 * (design `data/vp-anlagenmodell-ux-w7`, Captain-Go 2026-07-29).
 *
 * Geräte-Erlebnis Slice 1 stellt dieselben Identitäten zuerst als elektrisches
 * Anlagenbild dar; die vollständige Gerät-/Komponentenliste bleibt die
 * synchronisierte Zweitsicht. Beide werden ausschließlich aus `plantModel`
 * und `zentraleListe` projiziert, nicht als zweites Datenmodell gespeichert.
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
  const [addTyp, setAddTyp] = useState<TypId | null>(null);
  const [addRolle, setAddRolle] = useState<KomponentenRolle | null>(null);
  const [editComponent, setEditComponent] = useState<SiteComponentRow | null>(null);
  /**
   * Geräte-Erlebnis Slice 1: Anlagenbild ist die Vorgabe auf jeder Breite;
   * die Liste bleibt dieselbe synchronisierte Zweitsicht. Die Wahl lebt im
   * Hash, damit Lesezeichen und Zurück-Taste dieselbe Sicht wiederherstellen.
   */
  const isDesktop = useIsDesktop();
  const [ansicht, setAnsicht] = useState<ZentraleAnsicht>(() =>
    parseZentraleAnsicht(typeof window === 'undefined' ? '' : window.location.hash),
  );
  /** Auswahl ist eine Identität, die zwischen Anlagenbild und Liste überlebt. */
  const [selectedKarteId, setSelectedKarteId] = useState<string | null>(null);
  /** Die Vorschau ist getrennt: Schließen entfernt nie die Auswahl. */
  const [previewKarteId, setPreviewKarteId] = useState<string | null>(null);
  const ansichtWechselt = useRef(false);
  // Einheitsmodell Stufe 6: aus einer EIGENEN Vorlage ein Gerät machen - der
  // Assistent öffnet dann direkt in der Selbstbau-Tür, vorbefüllt.
  const [vorlage, setVorlage] = useState<SiteComponentTemplate | null>(null);
  /*
    Anlagen-Zentrale Stufe 3 (PR 3a): die zwei Lesepfade der aufgelösten
    Installateur-Ansicht. Sie werden NUR hinter dem EINEN Tor geholt - ein
    Kunde soll nicht zwei Abrufe bezahlen, die er nie sieht -, und beide
    fail-soft: ohne sie fehlt genau ihre Zeile, nie die Liste.
  */
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]>>({});
  const [catalog, setCatalog] = useState<EntityTypeDef[] | null>(null);
  const [technikDrawer, setTechnikDrawer] = useState<DrawerState | null>(null);
  const [technikAdopt, setTechnikAdopt] = useState<AdoptableSource | null>(null);

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

  /*
    Die zwei ZUSÄTZLICHEN Lesepfade der technischen Sicht - nur hinter dem
    EINEN Tor (M7), beide fail-soft.
  */
  useEffect(() => {
    if (!showTechnical) return;
    let active = true;
    api.entityStrategies(site.id).then(
      (m) => active && setStrategies(m),
      () => active && setStrategies({}),
    );
    entitiesApi.typeCatalog().then(
      (c) => active && setCatalog(c.types),
      () => active && setCatalog(null),
    );
    return () => {
      active = false;
    };
  }, [showTechnical, site.id, reloadKey]);

  /**
   * Die Ansicht folgt dem Hash (Lesezeichen + Zurück-Taste), und ein Wechsel
   * schreibt ihn - über `replaceState`, damit nicht jeder Reiter-Klick einen
   * Verlaufs-Eintrag erzeugt (das `VerlaufExplorer`-Muster).
   */
  useEffect(() => {
    const onHash = () => setAnsicht(parseZentraleAnsicht(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const zeigeAnsicht = (naechste: ZentraleAnsicht) => {
    ansichtWechselt.current = true;
    setAnsicht(naechste);
    const ziel = zentraleAnsichtHash(site.id, naechste);
    if (typeof window !== 'undefined' && window.location.hash !== ziel) {
      window.history.replaceState(null, '', ziel);
    }
  };

  useEffect(() => {
    if (!ansichtWechselt.current) return;
    ansichtWechselt.current = false;
    if (!selectedKarteId) return;
    const attribut = ansicht === 'schaltbild' ? 'data-anlagen-knoten' : 'data-anlagen-karte';
    const id = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[${attribut}="${CSS.escape(selectedKarteId)}"]`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [ansicht, selectedKarteId]);

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

  /*
    Anlagen-Zentrale Stufe 3 (PR 3c): der Weg ZURÜCK auf eine Komponente. Cockpit
    und Regel-Karte fragen dasselbe wie ein Klick im Schaltbild („wo kommt das
    her?"), also führen sie an DIESELBE Stelle - die Zeile in ihrer
    Geräte-Karte, an der auch die Handlungen hängen.

    ⚠ Der Sprung wartet auf die LISTE: vor `karten` gibt es die Zeile noch gar
    nicht, ein `scrollIntoView` liefe dann ins Leere. Und er läuft GENAU EINMAL
    je Adresse - sonst risse jeder Re-Render den Leser wieder nach oben.
  */
  const [gesprungen, setGesprungen] = useState<string | null>(null);
  const [sprungZiel, setSprungZiel] = useState<string | null>(() =>
    parseKomponente(typeof window === 'undefined' ? '' : window.location.hash),
  );
  // ⚠ Der Sprung folgt dem HASH, nicht nur dem Mounten: sonst führte ein
  // zweiter Weg auf eine andere Komponente - während die Zentrale schon offen
  // ist - nirgendwohin.
  useEffect(() => {
    const onHash = () => setSprungZiel(parseKomponente(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (karten.length === 0) return;
    const ziel = sprungZiel;
    if (!ziel || ziel === gesprungen) return;
    setGesprungen(ziel);
    const el = document.querySelector(`[data-komponente="${CSS.escape(ziel)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    // Die Hervorhebung ist eine ANTWORT auf den Sprung, kein Zustand: sie
    // verblasst von selbst, damit die Zeile danach aussieht wie jede andere.
    el.classList.add('is-angesprungen');
    const t = window.setTimeout(() => el.classList.remove('is-angesprungen'), 2400);
    return () => window.clearTimeout(t);
  }, [karten.length, gesprungen, sprungZiel]);

  /** Anlagenbild und Liste lesen exakt dieselben Kartenidentitäten. */
  const bild = useMemo(() => (model ? anlagenBild(karten) : null), [model, karten]);

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
  const editForKarte = (karteId: string) => {
    const karte = karten.find((item) => item.id === karteId);
    const entityIds = new Set(
      karte?.komponenten.map((component) => component.entityId).filter(Boolean) ?? [],
    );
    const row = components?.components.find(
      (component) => entityIds.has(component.id) && Boolean(component.templateRef),
    );
    if (row) setEditComponent(row);
  };
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
    Die DAUERHAFTE Ausnahme je Komponente (Live-Fall Muehlfeldweg 2): sie steht
    in der gespeicherten Anbindung, die der Server zurückgibt - hier wird nichts
    abgeleitet, nur gelesen. Ohne Beleg ist die Karte byte-identisch wie vorher.
  */
  const ohneMesswertById = useMemo(() => {
    const out = new Map<string, { badge: string; satz: string }>();
    for (const row of components?.components ?? []) {
      const hinweis = ohneMesswertHinweis(row.connection);
      if (hinweis) out.set(row.id, hinweis);
    }
    return out;
  }, [components]);
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
          <ErrorState message="Die Komponenten konnten nicht geladen werden." onRetry={reload} />
        )}
        {model && (
          <>
            {/* Slice 1: Anlagenbild führt; der globale Einstieg bleibt für den
                objektorientierten Weg sichtbar. */}
            <div className="vp-am-kopf">
              <p className={`vp-am-headline${satz.ton === 'warn' ? ' warn' : ''}`}>
                <span className={`vp-health-dot vp-health-${satz.ton}`} />
                <span>{satz.text}</span>
              </p>
              {portalManaged && (
                <button
                  type="button"
                  className="vp-btn vp-btn--primary vp-btn--sm vp-am-global-add"
                  onClick={() => {
                    setAddTyp(null);
                    setAddRolle(null);
                    setAddOpen(true);
                  }}
                >
                  <Icon name="plus" size={14} /> {HINZUFUEGEN_LABEL}
                </button>
              )}
              {/* Anlagen-Zentrale Stufe 3 (§6.4): die ADMIN-Tür desselben
                  Knopfs. Sie steht bewusst NEBEN dem Assistenten und nicht
                  darin: der Assistent legt Gerät UND Komponente in einem Zug
                  an, diese Tür legt eine Entität OHNE Gerät an - und sie gilt
                  auch auf einer box-verwalteten Anlage, wo es den Assistenten
                  gar nicht gibt. */}
              {showTechnical && (
                <button
                  type="button"
                  className="vp-am-add is-technisch"
                  onClick={() => setTechnikDrawer({ mode: 'create' })}
                >
                  <Icon name="cpu" size={14} /> Komponente anlegen (technisch)
                </button>
              )}
            </div>

            {components && components.componentAuthority !== 'portal' && (
              <p className="vp-am-authority">
                {components.componentAuthority === 'box'
                  ? 'Diese Anlage wird an Ihrer VoltPilot-Box verwaltet. Freie Plätze zeigen, was elektrisch möglich ist; Änderungen nehmen Sie an der Box vor.'
                  : 'Für diese Anlage ist keine Gerätebearbeitung im Portal freigegeben. Freie Plätze zeigen nur, was elektrisch möglich ist.'}
              </p>
            )}

            {isEmpty && (
              <div className="vp-am-empty-intro">
                <Icon name="layers" size={24} />
                <div>
                  <strong>Ihre Anlage wartet auf das erste Gerät.</strong>
                  <span>
                    {portalManaged
                      ? 'Wählen Sie einen freien Platz oder starten Sie mit „Gerät hinzufügen".'
                      : 'Die freien Plätze zeigen den möglichen Aufbau, ohne fehlende Geräte zu erfinden.'}
                  </span>
                </div>
                {portalManaged && (
                  <button
                    type="button"
                    className="vp-btn vp-btn--primary vp-btn--sm"
                    onClick={() => {
                      setAddTyp(null);
                      setAddRolle(null);
                      setAddOpen(true);
                    }}
                  >
                    Gerät hinzufügen
                  </button>
                )}
              </div>
            )}

            {/* Anlagenbild und Liste sind auf ALLEN Breiten echte Ansichten. */}
            <div className="vp-am-ansicht">
              <div className="vp-seg vp-seg-compact" role="tablist" aria-label="Ansicht">
                <button
                  id="vp-anlagenbild-tab"
                  type="button"
                  role="tab"
                  aria-selected={ansicht === 'schaltbild'}
                  aria-controls="vp-anlagenbild"
                  tabIndex={ansicht === 'schaltbild' ? 0 : -1}
                  className={ansicht === 'schaltbild' ? 'on' : undefined}
                  onClick={() => zeigeAnsicht('schaltbild')}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'End') return;
                    event.preventDefault();
                    zeigeAnsicht('geraete');
                    window.requestAnimationFrame(() =>
                      document.getElementById('vp-anlagenliste-tab')?.focus(),
                    );
                  }}
                >
                  Anlagenbild
                </button>
                <button
                  id="vp-anlagenliste-tab"
                  type="button"
                  role="tab"
                  aria-selected={ansicht === 'geraete'}
                  aria-controls="vp-anlagenliste"
                  tabIndex={ansicht === 'geraete' ? 0 : -1}
                  className={ansicht === 'geraete' ? 'on' : undefined}
                  onClick={() => zeigeAnsicht('geraete')}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'Home') return;
                    event.preventDefault();
                    zeigeAnsicht('schaltbild');
                    window.requestAnimationFrame(() =>
                      document.getElementById('vp-anlagenbild-tab')?.focus(),
                    );
                  }}
                >
                  Liste
                </button>
              </div>
              <span className="vp-am-ansicht-hint">
                {ansicht === 'schaltbild'
                  ? 'Elektrische Struktur und freie Plätze'
                  : 'Dieselben Geräte mit allen Komponentenaktionen'}
              </span>
            </div>

            {ansicht === 'schaltbild' && bild && (
              <div
                id="vp-anlagenbild"
                role="tabpanel"
                aria-labelledby="vp-anlagenbild-tab"
              >
                <AnlagenBild
                  bild={bild}
                  desktop={isDesktop}
                  authority={
                    components?.componentAuthority === 'portal'
                      ? 'portal'
                      : components?.componentAuthority === 'box'
                        ? 'box'
                        : 'unknown'
                  }
                  selectedId={selectedKarteId}
                  previewId={previewKarteId}
                  onSelect={(id) => {
                    setSelectedKarteId(id);
                    setPreviewKarteId(id);
                  }}
                  onClosePreview={() => setPreviewKarteId(null)}
                  onAdd={(slot) => {
                    setAddTyp(slot.typ);
                    setAddRolle(slot.initialRolle);
                    setAddOpen(true);
                  }}
                  onAssign={setAssign}
                  onEdit={editForKarte}
                />
              </div>
            )}

            {/* Die bestehende Liste bleibt vollständig und teilt Auswahl/Fokus. */}
            <div
              id="vp-anlagenliste"
              role="tabpanel"
              aria-label="Liste"
              hidden={ansicht === 'schaltbild'}
            >
              <section aria-label={LISTE_TITEL} className="vp-am-liste">
              <p className="vp-am-box-hint">{EDGE_BOX_HINT}</p>
              {verwaltung && <p className="vp-am-stand is-unbekannt">{verwaltung}</p>}
              {komponentenStand && (
                <p className={`vp-am-stand is-${komponentenStand.ton}`}>{komponentenStand.text}</p>
              )}
              {ablehnung && <p className="vp-am-stand is-warn">{ablehnung}</p>}
              {showTechnical && data && <RegistryDrift data={data} />}

              {karten.length === 0 && (
                <p className="vp-am-list-empty">
                  Noch keine Geräte vorhanden. Im Anlagenbild sehen Sie die möglichen Plätze.
                </p>
              )}

              {karten.map((k) => (
                <GeraeteKarteView
                  key={k.id}
                  karte={k}
                  selected={selectedKarteId === k.id}
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
                  ohneMesswertFor={(c) => ohneMesswertById.get(c.entityId ?? '') ?? null}
                  onEdit={portalManaged ? (karte) => editForKarte(karte.id) : undefined}
                  onRepin={setRepin}
                  onRemove={setRemove}
                  sofortFor={(c) =>
                    consumers.find((x) => x.id === c.entityId && x.connection === 'connected') ??
                    null
                  }
                  onSofort={(consumer, action) => setSofort({ consumer, action })}
                  technik={
                    showTechnical
                      ? {
                          entityFor: (id) => data?.entities.find((e) => e.id === id) ?? null,
                          strategiesFor: (id) => strategies[id] ?? [],
                          topology,
                          onEdit: (entity) => setTechnikDrawer({ mode: 'edit', entity }),
                          onAdopt: setTechnikAdopt,
                          onChanged: reload,
                        }
                      : null
                  }
                />
              ))}

                {portalManaged && <EigeneVorlagenPanel siteId={site.id} onAnlegen={setVorlage} />}
              </section>
            </div>

            {!isEmpty && (
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
            )}
          </>
        )}
      </Card>

      {/* Der zweite Wohnort der aufgelösten Installateur-Ansicht (§6.4): die
          Karte „Rollen & Zuordnung" UNTER der Liste. Sie beantwortet eine
          andere Frage als die Liste („welche Messung zählt wozu") und ist
          deshalb eine eigene Karte geblieben - nur ihr Rahmen, der
          `<details>`-Block „Installateur-Ansicht", ist entfallen. */}
      {showTechnical && (
        <RollenZuordnung siteId={site.id} topology={topology} onChanged={setTopology} />
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

      {(addOpen || vorlage || editComponent) && (
        <AnlegenFlow
          siteId={site.id}
          box={boxOf(devices, site.id) ?? undefined}
          vorlage={vorlage}
          initialTyp={vorlage ? null : addTyp}
          initialRolle={vorlage ? null : addRolle}
          bearbeiten={editComponent}
          onClose={() => {
            setAddOpen(false);
            setAddTyp(null);
            setAddRolle(null);
            setVorlage(null);
            setEditComponent(null);
          }}
          onSaved={(result) => {
            setComponents(result);
            setAddTyp(null);
            setAddRolle(null);
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

      {/* Die zwei technischen Drawer - EIN Bauteil, EIN Wirt (die Landkarte).
          Ohne Katalog wird gar nichts geöffnet: eine Typ-Auswahl ohne Typen
          wäre ein Formular, das nichts anlegen kann. */}
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

/**
 * Die technische Sicht als EIN Bündel (Stufe 3, PR 3a). `null` = das EINE Tor
 * ist zu (M7) - dann rendert nichts davon, und der Wirt holt seine zwei
 * Lesepfade gar nicht erst.
 */
interface TechnikSicht {
  entityFor: (entityId: string) => SiteEntity | null;
  strategiesFor: (entityId: string) => EntityStrategy[];
  topology: SiteTopology | null;
  onEdit: (entity: SiteEntity) => void;
  onAdopt: (source: AdoptableSource) => void;
  onChanged: () => void;
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
  selected,
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
  technik,
  ohneMesswertFor,
  onEdit,
}: {
  karte: GeraeteKarte;
  selected: boolean;
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
  technik: TechnikSicht | null;
  /** Die dauerhafte Ausnahme je Komponente (siehe {@link ComponentRow}). */
  ohneMesswertFor: (c: PlantComponent) => { badge: string; satz: string } | null;
  onEdit?: (karte: GeraeteKarte) => void;
}) {
  const k = karte;
  return (
    <section
      className={`vp-am-karte is-${k.art}${selected ? ' is-selected' : ''}`}
      aria-label={k.titel}
      data-anlagen-karte={k.id}
      tabIndex={selected ? -1 : undefined}
    >
      <div className="vp-am-karte-head">
        <span className={`vp-health-dot vp-health-${k.ton}`} />
        <span className="nm">{k.titel}</span>
        {k.technischerName && <span className="tech">Technik: {k.technischerName}</span>}
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
        {onEdit && k.art === 'geraet' && k.komponenten.some((c) => c.entityId) && (
          <button type="button" className="vp-am-karte-go" onClick={() => onEdit(k)}>
            Bearbeiten <Icon name="pencil" size={14} />
          </button>
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
        {/* Der dritte Wohnort (§6.4): die TECHNISCHE Übernahme. Sie steht NEBEN
            der geführten - die eine legt in einem Zug an, was der Kunde sieht,
            die andere wählt Typ, Nennleistung, kWp und MaStR-Nummer von Hand.
            Beide führen auf dieselbe Route; keine ersetzt die andere. */}
        {k.art === 'neu' && k.quelle && technik && (
          <button
            type="button"
            className="vp-am-karte-go is-technisch"
            onClick={() => technik.onAdopt(k.quelle as AdoptableSource)}
          >
            technisch <Icon name="chevron-right" size={14} />
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
              technik={technik}
              ohneMesswert={ohneMesswertFor(c)}
              geraetHref={k.href}
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
  technik,
  ohneMesswert,
  geraetHref,
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
  technik: TechnikSicht | null;
  /**
   * Die DAUERHAFTE Ausnahme dieser Komponente („mit unplausiblen Testwerten
   * angelegt am …"). Sie kommt aus der gespeicherten Anbindung des Servers -
   * sie wird hier nie abgeleitet, und ohne Beleg steht sie nicht da.
   */
  ohneMesswert?: { badge: string; satz: string } | null;
  /**
   * Der Weg auf die Geräteseite DIESER Karte - `null`, wo es keinen gibt (eine
   * Box ohne eindeutige Referenz, ein synthetisches Gerät). Er trägt den
   * §5.3-Absprung des Speichers: die Batterie hat KEINE eigene Seite, ihr
   * Gesicht ist der Speicher-Teil des Hybrid-Blatts.
   */
  geraetHref?: string | null;
}) {
  const c = component;
  // Die PV-Aspekt-Zeile hat keine eigene Entität - sie hat damit auch keine
  // technische Sicht, und eine erfundene wäre eine Aussage über etwas, das es
  // nicht gibt.
  const entity = technik && c.entityId ? technik.entityFor(c.entityId) : null;
  return (
    // `data-komponente` ist das Sprungziel des Schaltbilds (§13.2: ein Klick auf
    // eine Komponente führt zu IHRER Zeile) - die Zeile trägt die Handlungen,
    // das Bild erklärt nur die Struktur.
    <div className="vp-am-comp" data-komponente={c.id}>
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
          {/* Die AUSNAHME dieser Komponente - dauerhaft sichtbar, nicht nur im
              Assistenten (Anforderung 4): sie erklärt, warum ein Messwert fehlt
              UND warum die Steuerung aus bleibt. */}
          {ohneMesswert && (
            <span className="vp-am-ohne" title={ohneMesswert.satz}>
              <Icon name="alert-triangle" size={12} />
              {ohneMesswert.badge}
            </span>
          )}
          <span>{c.summary}</span>
        </span>
        {ohneMesswert && <span className="vp-am-ohne-satz">{ohneMesswert.satz}</span>}
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
      {(c.channels.length > 0 || sofort != null || c.entityId != null || entity != null
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
          {/* §5.3: die BATTERIE hat kein eigenes Blatt - sie ist der
              Speicher-Teil des Hybrid-Gesichts. Der Absprung markiert dort
              genau ihre Kachel (`?abschnitt=jetzt&kachel=speicher`); ohne
              Geräteseite gibt es ihn nicht (die `registerZugang`-Regel). */}
          {c.role === 'storage' && geraetHref && (
            <span className="vp-am-actions">
              <a
                className="vp-am-action"
                href={abschnittHash(geraetHref, 'jetzt', SPEICHER_KACHEL)}
              >
                <Icon name="battery" size={13} /> {SPEICHER_BLATT_LABEL}
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
          {/* Der ERSTE Wohnort der aufgelösten Installateur-Ansicht (§6.4):
              Typ, Soll/Ist, Rollen, Regeln, „Steuert" und Guards - an der
              Komponente selbst statt in einer zweiten Karte weiter unten. */}
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
    </div>
  );
}
