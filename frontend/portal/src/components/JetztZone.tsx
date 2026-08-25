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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type ControlStatus, type CurtailmentStatus, type SchedulePlan, type Site } from '../api';
import { PartHead } from './SteuerungParts';
import { ConsumerOverrideDialog } from './ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import { SOFORT_LABEL, type ManualOverride, type SofortAktion } from '../consumers/fulfillment';
import type { SiteCharging } from '../ladepunkte';
import {
  JETZT_INTRO,
  JETZT_TITEL,
  jetztZone,
  type JetztZeile,
} from '../steuerungJetzt';
import './Steuerung.css';

/** Der Takt, in dem der Countdown neu gerechnet wird (eine Minute genügt). */
const TICK_MS = 30_000;

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
  onReload,
}: {
  site: Site;
  charging?: SiteCharging | null;
  speicherRegelAktiv?: boolean;
  speicherName?: string | null;
  onReload?: () => void;
}): JSX.Element {
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtail, setCurtail] = useState<CurtailmentStatus | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [status, setStatus] = useState<ConsumerRuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [eingriff, setEingriff] = useState<{ consumer: Consumer; aktion: SofortAktion } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), TICK_MS);
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
        now,
      },
      geraete: consumers.map((c) => ({
        consumer: c,
        status: status.find((s) => s.entityId === c.id) ?? null,
        override: overrides.find((o) => o.entityId === c.id) ?? null,
        anyStatusReported,
      })),
      charging,
      overrides,
      now,
    });
  }, [plan, control, curtail, consumers, status, overrides, charging, site.plantKind,
    speicherRegelAktiv, speicherName, now]);

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
            {bannerGeraet && (
              <button
                type="button"
                className="vp-jetzt-banner-act"
                disabled={busy}
                onClick={() => setEingriff({ consumer: bannerGeraet, aktion: 'resume' })}
              >
                {view.banner.aktion}
              </button>
            )}
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
                onToggle={() => setOffen((o) => (o === z.key ? null : z.key))}
                onAktion={(a) => {
                  const c = consumers.find((x) => x.id === z.entityId);
                  setOffen(null);
                  if (c) setEingriff({ consumer: c, aktion: a });
                }}
              />
            ))}
          </ul>
        )}
      </Card>

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
  onToggle,
  onAktion,
}: {
  zeile: JetztZeile;
  offen: boolean;
  busy: boolean;
  onToggle: () => void;
  onAktion: (a: SofortAktion) => void;
}): JSX.Element {
  return (
    <li className="vp-jetztrow">
      <span className={`vp-rowdot ${zeile.ton}`} aria-hidden="true" />
      <span className="vp-jetztrow-text">
        <strong>{zeile.name}</strong>
        <span className="vp-jetztrow-state">{zeile.zustand}</span>
        {zeile.grund && <span className="vp-jetztrow-why">{zeile.grund}</span>}
        <span className="vp-jetztrow-meta">
          {zeile.quelleText && <span className="vp-jetztrow-src">{zeile.quelleText}</span>}
          {zeile.bis && <span className="vp-jetztrow-until">{zeile.bis}</span>}
        </span>
      </span>
      {zeile.aktionen.length > 0 ? (
        <span className="vp-jetztrow-act">
          <button
            type="button"
            className="vp-jetzt-menu"
            aria-expanded={offen}
            aria-label={`${zeile.name}: eingreifen`}
            disabled={busy}
            onClick={onToggle}
          >
            Eingreifen
            <Icon name="chevron-right" size={14} />
          </button>
          {offen && (
            <span className="vp-jetzt-menulist" role="menu">
              {zeile.aktionen.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="menuitem"
                  className="vp-jetzt-menuitem"
                  onClick={() => onAktion(a)}
                >
                  {SOFORT_LABEL[a]}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        zeile.keinEingriff && <span className="vp-jetztrow-noact">{zeile.keinEingriff}</span>
      )}
    </li>
  );
}
