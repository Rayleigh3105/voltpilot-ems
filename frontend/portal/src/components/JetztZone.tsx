import { Recht } from './Recht';
/**
 * Zone ① **„Jetzt"** der Steuerung (Konzept `vp-steuerung-konzept-b3` §3.2,
 * Stufe 1) — die erste Zone der Seite, weil sie die häufigste Frage
 * beantwortet: *Was tut meine Anlage gerade, warum, und kann ich eingreifen?*
 *
 * Hier wird NICHTS abgeleitet: jede Zeile, jeder Countdown und jeder Banner
 * kommt aus dem reinen `steuerungJetzt.ts`; diese Datei lädt, rendert und ruft
 * die BESTEHENDEN Endpunkte. Der Handeingriff selbst ist der unveränderte
 * `ConsumerOverrideDialog` (§14.13) — er wandert in dieser Stufe nur aus der
 * Verbraucher-Liste ins Zeilen-Menü, seine Folgenliste und seine Dauer-Pflicht
 * bleiben Zeichen für Zeichen dieselben.
 *
 * Ehrlichkeiten, die man beim Anfassen kennen muss:
 *  - **Jeder Abruf ist fail-soft.** Fehlt einer, ist die Zone ruhiger, nie
 *    kaputt — und wo nichts belegt ist, steht der Leer-Satz mit dem Weg.
 *  - **Ein Knopf, der nichts bewirken kann, wird nicht angeboten**, sondern
 *    durch seinen Grund ersetzt (`keinEingriff`).
 *  - **Der Countdown tickt sichtbar**: die Zone rechnet jede Minute neu, damit
 *    „noch 1 Std. 12 Min." nicht einfriert. Ein abgelaufener Handeingriff
 *    verschwindet damit von selbst.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type ControlStatus,
  type CurtailmentStatus,
  type SchedulePlan,
  type Site,
  type SiteInterventions,
} from '../api';
import { PartHead } from './SteuerungParts';
import { ConsumerOverrideDialog } from './ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import { SOFORT_LABEL, type ManualOverride, type SofortAktion } from '../consumers/fulfillment';
import {
  boostEndeKarte,
  boostFolgenKarte,
  pauseFolgenKarte,
  LADEPUNKT_DAUER_VORGABE,
  LADEPUNKT_DAUERN,
  LADEPUNKT_HINWEIS,
  LADEPUNKT_LABEL,
  type LadepunktAktion,
  type SiteCharging,
} from '../ladepunkte';
import {
  JETZT_INTRO,
  JETZT_TITEL,
  jetztZone,
  LADEPUNKT_BANNER_ID,
  PAUSE_BANNER_ID,
  type JetztZeile,
  type LadepunktAdresse,
} from '../steuerungJetzt';
import {
  DAUERN,
  endeVon,
  HANDEINGRIFF_LABEL,
  handeingriffFolgen,
  planVerzicht,
  type HandeingriffAktion,
  type SpeicherAktion,
} from '../handeingriff';
import { HandeingriffDialog } from './HandeingriffDialog';
import './Steuerung.css';
// Eine Uhr, die „läuft noch X" zeigt, darf nicht seltener ticken, als neue
// Daten ankommen - deshalb der LIVE-Takt.
import { LIVE_POLL_MS } from '../pollCadence';

/**
 * Die VORAUSGEWÄHLTE Dauer des Speicher-/Anlagen-Eingriffs. Sie ist bewusst
 * kurz: ein Eingriff, den man vergisst, soll von selbst enden - länger wählt
 * der Kunde im Dialog.
 */
const HAND_DEFAULT_DAUER = '2h';

function handEnde(now: Date, key: string): Date {
  const gewaehlt = DAUERN.find((d) => d.key === key) ?? DAUERN[2];
  return endeVon(gewaehlt, now);
}

export function JetztZone({
  site,
  charging = null,
  /**
   * Ob eine AKTIVE Kundenregel den SPEICHER beansprucht. Der Aufrufer leitet es
   * aus den Ansprüchen der aktiven Regeln ab (ein Server-Fakt) — hier wird es
   * NIE geraten, und ohne die Angabe nennt die Zeile den Fahrplan.
   */
  speicherRegelAktiv = false,
  /** Der Anzeigename der Speicher-Komponente; ohne einen heißt sie „Speicher". */
  speicherName = null,
  /**
   * Die STEUERART eines Ladepunkts als Wort („Überschuss (Sonne zuerst)").
   *
   * ⚠ Sie wird ÜBERGEBEN, nie hier geraten: sie kommt aus dem Lese-Aggregat
   * der Verbraucher-Zone, das der SERVER projiziert hat. Ohne sie bleibt die
   * Quelle der Ladepunkt-Zeile leer — „unbekannt" ist ein vollwertiges Urteil.
   */
  steuerart,
  fahrzeug,
  onReload,
  eingriffeAngeboten = true,
  funktionsAktion,
}: {
  site: Site;
  charging?: SiteCharging | null;
  speicherRegelAktiv?: boolean;
  speicherName?: string | null;
  steuerart?: (entityId: string | null | undefined) => string | null;
  /**
   * Der NAME zu einem Karten-Pseudonym (P7). Ohne ihn - oder ohne benanntes
   * Fahrzeug - bleibt jede Ladepunkt-Zeile Zeichen für Zeichen die von vorher.
   */
  fahrzeug?: (tagRef: string | null | undefined) => string | null;
  onReload?: () => void;
  /** Eine angehaltene Funktion bietet keinerlei Handeingriff an. */
  eingriffeAngeboten?: boolean;
  /** IP-11: Anhalten/Fortsetzen der Funktion neben den Handeingriffen. */
  funktionsAktion?: ReactNode;
}): JSX.Element {
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtail, setCurtail] = useState<CurtailmentStatus | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [status, setStatus] = useState<ConsumerRuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  const [interventions, setInterventions] = useState<SiteInterventions | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [eingriff, setEingriff] = useState<{ consumer: Consumer; aktion: SofortAktion } | null>(null);
  /** Der Speicher-/Anlagen-Eingriff (Stufe 4) - eigener Dialog, eigene Dauern. */
  /**
   * ⚠ Der Eingriff trägt seinen UMFANG mit, nicht nur seine Handlung: „Automatik
   * fortsetzen" gibt es zweimal - für den Speicher und für die ganze Anlage -,
   * und beide können gleichzeitig laufen. Aus `resume` allein wäre nicht
   * ableitbar, welchen der beiden der Kunde gerade gedrückt hat.
   */
  const [hand, setHand] = useState<
    { aktion: HandeingriffAktion; umfang: 'speicher' | 'anlage' } | null>(null);
  /**
   * ⚠ Die gewählte Dauer lebt HIER, nicht im Dialog: die Folgen-Karte muss
   * beschreiben, was der Knopf tun WIRD - Endzeit UND Fahrplan-Verzicht hängen
   * an ihr. Mit dialog-interner Auswahl stünde dort dauerhaft die Vorauswahl.
   */
  const [handDauer, setHandDauer] = useState(HAND_DEFAULT_DAUER);
  /**
   * Der LADEPUNKT-Eingriff (P3a). Er ist bewusst ein eigener Zustand neben dem
   * Speicher-Eingriff: er adressiert einen STECKER statt einer Komponente, und
   * seine Dauern sind die des Boosts („bis Abstecken" statt „bis morgen früh").
   */
  const [lade, setLade] = useState<
    { adresse: LadepunktAdresse; aktion: LadepunktAktion } | null>(null);
  const [ladeDauer, setLadeDauer] = useState(LADEPUNKT_DAUER_VORGABE);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), LIVE_POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    // Jeder Abruf einzeln fail-soft: eine fehlende Antwort macht die Zone
    // ruhiger, nie kaputt.
    api.schedule(site.id).then((p) => alive && setPlan(p ?? null)).catch(() => {});
    api.controlStatus(site.id).then((c) => alive && setControl(c ?? null)).catch(() => {});
    api.curtailmentStatus(site.id).then((c) => alive && setCurtail(c ?? null)).catch(() => {});
    consumersApi.list(site.id).then((l) => alive && setConsumers(l ?? [])).catch(() => {});
    consumersApi.status(site.id).then((s) => alive && setStatus(s ?? [])).catch(() => {});
    consumersApi.overrides(site.id).then((o) => alive && setOverrides(o ?? [])).catch(() => {});
    // Stufe 4: die laufenden Handeingriffe + die Pause. Fail-soft wie alles
    // hier - ein älteres Backend kennt die Route nicht, dann bleibt die Zone
    // Zeichen für Zeichen die der Stufe 1.
    api.siteInterventions(site.id)
      .then((i) => alive && setInterventions(i ?? null)).catch(() => {});
    return () => { alive = false; };
  }, [site.id, reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1);
    onReload?.();
  }, [onReload]);

  const view = useMemo(() => {
    const anyStatusReported = status.length > 0;
    return jetztZone({
      speicher: {
        name: speicherName,
        control,
        // Ein Plan MIT Gerät heißt: diese Anlage wird wirklich gesteuert.
        expectControl: plan?.deviceId != null,
        slots: plan?.slots ?? null,
        curtail,
        plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
        regelHaeltAn: speicherRegelAktiv,
        eingriff: interventions?.interventions.find((i) => i.entityId != null) ?? null,
        pausiert: interventions?.automationPaused === true,
        now,
      },
      geraete: consumers.map((c) => ({
        consumer: c,
        status: status.find((s) => s.entityId === c.id) ?? null,
        override: overrides.find((o) => o.entityId === c.id) ?? null,
        anyStatusReported,
      })),
      charging,
      fahrzeug,
      steuerart,
      overrides,
      interventions,
      now,
    });
  }, [plan, control, curtail, consumers, status, overrides, interventions, charging,
    site.plantKind, speicherRegelAktiv, speicherName, steuerart, fahrzeug, now]);

  const bestaetigen = useCallback(async (minutes?: number) => {
    if (!eingriff) return;
    setBusy(true);
    try {
      if (eingriff.aktion === 'resume') {
        await consumersApi.clearOverride(site.id, eingriff.consumer.id);
      } else {
        await consumersApi.startOverride(site.id, eingriff.consumer.id, {
          action: eingriff.aktion, durationMinutes: minutes ?? 30,
        });
      }
      setEingriff(null);
      reload();
    } catch {
      // Ein abgelehnter Eingriff lässt die Zone stehen, wie sie war — nie ein
      // Schein-Erfolg. Den Grund zeigt die Seite über ihren Fehler-Streifen.
      setEingriff(null);
      reload();
    } finally {
      setBusy(false);
    }
  }, [eingriff, site.id, reload]);

  /** Die Zahl der Folgen-Karte - aus DEMSELBEN Plan, den das Diagramm zeichnet. */
  const handFolgen = useMemo(() => {
    if (!hand) return null;
    const ende = handEnde(now, handDauer);
    return handeingriffFolgen({
      aktion: hand.aktion,
      endeText: ende.toLocaleTimeString('de-DE',
        { hour: '2-digit', minute: '2-digit' }) + ' Uhr',
      // ⚠ Ladestand und Ladeleistung stehen auf DIESER Fläche nicht belegt zur
      // Verfügung (das Rücklesen trägt den Sollwert, nicht den Stand) - die
      // Folgen-Karte lässt die Klammern dann weg, statt eine Zahl zu erfinden.
      socPct: null,
      leistungKw: null,
      verzicht: planVerzicht(plan?.slots ?? null, now, ende),
    });
  }, [hand, handDauer, plan, now]);

  const handBestaetigen = useCallback(async (minutes: number | null) => {
    if (!hand) return;
    setBusy(true);
    try {
      // ⚠ „bis morgen früh" reist als absolutes ENDE, jede andere Dauer als
      // Minuten - genau das, was der Server erwartet (er rechnet die Zone der
      // Anlage selbst, hier steht sie nur für die Vorschau).
      const body = minutes == null
        ? { endsAt: handEnde(new Date(), handDauer).toISOString() }
        : { durationMinutes: minutes };
      if (hand.aktion === 'pause') {
        await api.pauseAutomation(site.id, body);
      } else if (hand.aktion === 'resume') {
        if (hand.umfang === 'anlage') await api.resumeAutomation(site.id);
        else await api.clearBatteryOverride(site.id);
      } else {
        await api.startBatteryOverride(site.id,
          { kind: hand.aktion as SpeicherAktion, ...body });
      }
    } catch {
      // Ein abgelehnter Eingriff lässt die Zone stehen, wie sie war - nie ein
      // Schein-Erfolg. Den Grund zeigt die Seite über ihren Fehler-Streifen.
    } finally {
      setHand(null);
      setBusy(false);
      reload();
    }
  }, [hand, handDauer, site.id, reload]);

  /** Die Folgen-Karte des Ladepunkt-Eingriffs — vier Blöcke, wie am Speicher. */
  const ladeFolgen = useMemo(() => {
    if (!lade) return null;
    // ⚠ Die RÜCKNAHME beschreibt, was gerade LÄUFT - die zwei Richtungen enden
    // verschieden, und „Sie beenden die volle Ladung" über einer Pause wäre
    // eine Falschaussage im Bestätigungs-Dialog.
    if (lade.aktion === 'resume') return boostEndeKarte(lade.adresse.eingriff ?? 'voll_laden');
    const d = LADEPUNKT_DAUERN.find((x) => x.key === ladeDauer) ?? LADEPUNKT_DAUERN[2];
    if (lade.aktion === 'laden_pausieren') return pauseFolgenKarte(d);
    return boostFolgenKarte(charging?.budget ?? null, d);
  }, [lade, ladeDauer, charging]);

  const ladeBestaetigen = useCallback(async () => {
    if (!lade) return;
    setBusy(true);
    try {
      const d = LADEPUNKT_DAUERN.find((x) => x.key === ladeDauer) ?? LADEPUNKT_DAUERN[2];
      await api.chargingBoost(site.id, {
        chargePointId: lade.adresse.chargePointId,
        connectorId: lade.adresse.connectorId,
        // ⚠ „bis Abstecken" reist als FEHLENDE Dauer: dann gilt der
        // Vertrags-Deckel der Box, und die Bindung an die Transaktion beendet
        // den Eingriff ohnehin beim Abstecken.
        ...(lade.aktion !== 'resume' && d.minutes != null ? { minutes: d.minutes } : {}),
        cancel: lade.aktion === 'resume',
        // ⚠ Die RICHTUNG reist auch bei der RÜCKNAHME mit: die Papier-Spur des
        // Kommando-Verlaufs folgt ihr, und „Jetzt voll laden beendet" über einer
        // Pause wäre dort eine Falschaussage.
        action:
          lade.aktion === 'laden_pausieren'
            || (lade.aktion === 'resume' && lade.adresse.eingriff === 'pausiert')
            ? 'pause'
            : 'voll',
      });
    } catch {
      // Ein abgelehnter Eingriff lässt die Zone stehen, wie sie war - nie ein
      // Schein-Erfolg. Den Grund zeigt die Seite über ihren Fehler-Streifen.
    } finally {
      setLade(null);
      setBusy(false);
      reload();
    }
  }, [lade, ladeDauer, site.id, reload]);

  const bannerGeraet = view.banner
    ? consumers.find((c) => c.id === view.banner!.entityId) ?? null
    : null;

  return (
    <section className="vp-capsule vp-jetzt" aria-label={JETZT_TITEL}>
      <PartHead title={JETZT_TITEL} intro={JETZT_INTRO} />
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        {view.banner && (
          <p className="vp-jetzt-banner" role="status">
            <Icon name="alert-triangle" size={16} />
            <span>{view.banner.text}</span>
            {eingriffeAngeboten && (view.banner.entityId === LADEPUNKT_BANNER_ID && view.banner.ladepunkt ? (
              <Recht aktion="handeingriff.setzen"><button
                type="button"
                className="vp-jetzt-banner-act"
                disabled={busy}
                onClick={() => setLade({
                  adresse: view.banner!.ladepunkt!, aktion: 'resume',
                })}
              >
                {view.banner.aktion}
              </button></Recht>
            ) : view.banner.entityId !== PAUSE_BANNER_ID && bannerGeraet ? (
              <Recht aktion="handeingriff.setzen"><button
                type="button"
                className="vp-jetzt-banner-act"
                disabled={busy}
                onClick={() => setEingriff({ consumer: bannerGeraet, aktion: 'resume' })}
              >
                {view.banner.aktion}
              </button></Recht>
            ) : (
              <Recht aktion="handeingriff.setzen"><button
                type="button"
                className="vp-jetzt-banner-act"
                disabled={busy}
                onClick={() => setHand({
                  aktion: 'resume',
                  // Der Banner der ANLAGEN-Pause trägt den Sentinel; jeder
                  // andere bannerlose Rückweg gilt dem Speicher.
                  umfang: view.banner!.entityId === PAUSE_BANNER_ID ? 'anlage' : 'speicher',
                })}
              >
                {view.banner.aktion}
              </button></Recht>
            ))}
          </p>
        )}

        {view.leer ? (
          <p className="vp-capsule-empty">{view.leer}</p>
        ) : (
          <ul className="vp-jetztrows">
            {view.zeilen.map((z) => (
              <JetztZeileView
                key={z.key}
                zeile={z}
                offen={offen === z.key}
                busy={busy}
                aktionenAngeboten={eingriffeAngeboten}
                onToggle={() => setOffen((o) => (o === z.key ? null : z.key))}
                onAktion={(a: SofortAktion | HandeingriffAktion | LadepunktAktion) => {
                  setOffen(null);
                  if (z.art === 'ladepunkt' && z.ladepunkt) {
                    setLadeDauer(LADEPUNKT_DAUER_VORGABE);
                    setLade({ adresse: z.ladepunkt, aktion: a as LadepunktAktion });
                    return;
                  }
                  if (z.art === 'speicher') {
                    setHandDauer(HAND_DEFAULT_DAUER);
                    setHand({ aktion: a as HandeingriffAktion, umfang: 'speicher' });
                    return;
                  }
                  const c = consumers.find((x) => x.id === z.entityId);
                  if (c) setEingriff({ consumer: c, aktion: a as SofortAktion });
                }}
              />
            ))}
          </ul>
        )}

        {/* ⚠ Die zusammengefassten Ladepunkte werden GEZÄHLT, nie
            verschwiegen (§6.4: die Jetzt-Zone zeigt bei einem grossen
            Ladepark nur die mit Auto). */}
        {view.weitereLadepunkte && (
          <p className="vp-jetzt-weitere">{view.weitereLadepunkte}</p>
        )}
      </Card>

      {/* Die ANLAGEN-Pause ist keine Zeile: sie gilt allen. */}
      {((!view.leer && eingriffeAngeboten && !interventions?.automationPaused) || funktionsAktion) && (
        <p className="vp-jetzt-pausezeile">
          {!view.leer && eingriffeAngeboten && !interventions?.automationPaused && (
            <Recht aktion="handeingriff.setzen"><button
              type="button"
              className="vp-jetzt-pausebtn"
              disabled={busy}
              onClick={() => {
                setHandDauer(HAND_DEFAULT_DAUER);
                setHand({ aktion: 'pause', umfang: 'anlage' });
              }}
            >
              {HANDEINGRIFF_LABEL.pause}
            </button></Recht>
          )}
          {funktionsAktion}
        </p>
      )}

      <HandeingriffDialog
        folgen={handFolgen}
        busy={busy}
        withDuration={hand?.aktion !== 'resume'}
        dauerKey={handDauer}
        onDauer={setHandDauer}
        onConfirm={(m) => void handBestaetigen(m)}
        onCancel={() => setHand(null)}
      />

      {/* P3a: derselbe Folgen-Karten-Dialog wie am Speicher - eine Grammatik
          für jeden Handeingriff der Zone, nur mit den Dauern des Boosts. */}
      <HandeingriffDialog
        folgen={ladeFolgen}
        busy={busy}
        withDuration={lade?.aktion !== 'resume'}
        dauern={LADEPUNKT_DAUERN}
        dauerKey={ladeDauer}
        onDauer={setLadeDauer}
        onConfirm={() => void ladeBestaetigen()}
        onCancel={() => setLade(null)}
      />

      <ConsumerOverrideDialog
        action={eingriff?.aktion ?? null}
        consumerName={eingriff?.consumer.name ?? ''}
        effectivePowerKw={eingriff?.consumer.ratedPowerKw ?? null}
        busy={busy}
        onConfirm={(m) => void bestaetigen(m)}
        onCancel={() => setEingriff(null)}
      />
    </section>
  );
}

/**
 * Eine Zeile: Punkt · Name · Zustand · Grund · Quelle/Countdown, rechts das
 * Menü „Eingreifen ▾". Wo es keinen Eingriff gibt, steht sein GRUND — nie eine
 * Taste, die in nichts läuft.
 */
function JetztZeileView({
  zeile,
  offen,
  busy,
  aktionenAngeboten,
  onToggle,
  onAktion,
}: {
  zeile: JetztZeile;
  offen: boolean;
  busy: boolean;
  aktionenAngeboten: boolean;
  onToggle: () => void;
  onAktion: (a: SofortAktion | HandeingriffAktion | LadepunktAktion) => void;
}): JSX.Element {
  return (
    <li className="vp-jetztrow">
      <span className={`vp-rowdot ${zeile.ton}`} aria-hidden="true" />
      <span className="vp-jetztrow-text">
        <strong>{zeile.name}</strong>
        <span className="vp-jetztrow-state">{zeile.zustand}</span>
        {zeile.grund && <span className="vp-jetztrow-why">{zeile.grund}</span>}
        <span className="vp-jetztrow-meta">
          {/* ⚠ Das FAHRZEUG steht VOR der Quelle: „Lädt 11 kW · Dienstwagen ·
              Sofort laden" — erst WER dort lädt, dann WIE. Es steht nur, wo der
              Kunde die Karte benannt hat (P7). */}
          {zeile.fahrzeug && <span className="vp-jetztrow-car">{zeile.fahrzeug}</span>}
          {zeile.quelleText && <span className="vp-jetztrow-src">{zeile.quelleText}</span>}
          {zeile.bis && <span className="vp-jetztrow-until">{zeile.bis}</span>}
        </span>
      </span>
      {aktionenAngeboten && zeile.aktionen.length > 0 ? (
        <span className="vp-jetztrow-act">
          <Recht aktion="handeingriff.setzen"><button
            type="button"
            className="vp-jetzt-menu"
            aria-expanded={offen}
            aria-label={`${zeile.name}: eingreifen`}
            disabled={busy}
            onClick={onToggle}
          >
            Eingreifen
            <Icon name="chevron-right" size={14} />
          </button></Recht>
          {offen && (
            <span className="vp-jetzt-menulist" role="menu">
              {/* Am Telefon ist die Liste ein Bottom-Sheet - dort fehlt der
                  Zeilen-Zusammenhang, den man am Rechner noch sieht. */}
              <span className="vp-jetzt-menuhead" aria-hidden="true">
                Eingreifen · {zeile.name}
              </span>
              {zeile.aktionen.map((a) => (
                <Recht aktion="handeingriff.setzen" key={a}><button
                  type="button"
                  role="menuitem"
                  className="vp-jetzt-menuitem"
                  onClick={() => onAktion(a)}
                >
                  {menuLabel(zeile, a)}
                  {menuHinweis(zeile, a) && (
                    <small className="vp-jetzt-menuhint">{menuHinweis(zeile, a)}</small>
                  )}
                </button></Recht>
              ))}
            </span>
          )}
        </span>
      ) : (
        aktionenAngeboten && zeile.keinEingriff && <span className="vp-jetztrow-noact">{zeile.keinEingriff}</span>
      )}
    </li>
  );
}

/**
 * Die Beschriftung eines Menü-Eintrags - JE ZEILENART aus ihrer eigenen
 * Wortquelle. Ein Ladepunkt spricht das Ladepunkt-Vokabular („Jetzt voll laden
 * (nur diese Ladung)"), ein Gerät das der Sofortaktionen, der Speicher das der
 * Handeingriffe; keine Fläche erfindet hier ein Wort.
 */
function menuLabel(zeile: JetztZeile, a: string): string {
  if (zeile.art === 'ladepunkt') return LADEPUNKT_LABEL[a as LadepunktAktion] ?? a;
  if (a in SOFORT_LABEL) return SOFORT_LABEL[a as SofortAktion];
  return HANDEINGRIFF_LABEL[a as HandeingriffAktion] ?? a;
}

/** Die zweite Zeile eines Eintrags - nur, wo es eine belegte FOLGE zu sagen gibt. */
function menuHinweis(zeile: JetztZeile, a: string): string | null {
  if (zeile.art !== 'ladepunkt') return null;
  return LADEPUNKT_HINWEIS[a as LadepunktAktion] ?? null;
}
