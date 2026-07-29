import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ApiError, type Site } from '../../api';
import { adminApi, type Tenant } from '../../admin/adminApi';
import { fmtNum, plantKindLabel } from '../../format';
import { ChartInsight } from '../../components/ChartExplain';
import { InfoTip } from '../../components/InfoTip';
import { ChartCardSkeleton, EmptyState, ErrorState, TextSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';
import {
  optimizerApi,
  type OptimizerConfig,
  type OptimizerDiagnostics,
} from '../../optimizerApi';
import {
  buildConfigRequest,
  configFormFromOverrides,
  decisionLabelText,
  defaultSlotIndex,
  fmtCt,
  fmtEur,
  modeBadge,
  notableSlots,
  objectiveTotals,
  runDateLabel,
  runLabel,
  slotTimeLabel,
  slotWaterfall,
  verdict,
  type ConfigFormState,
} from '../../optimizer';
import { OptimizerPlanChart } from './OptimizerPlanChart';

/**
 * Plattform → Optimizer: the admin diagnostic + tune surface (design
 * vp-admin-optimizer-ui-design, backend PR #125). One scrollable page: pick a
 * Mandant → Anlage → run, then read WHAT the optimizer did and WHY (verdict,
 * inputs, the plan chart, explain-a-slot, objective breakdown) and tune its
 * per-site/per-asset knobs. The what-if re-optimize is a deferred separate
 * increment (shown disabled). Everything honours the backend's null discipline:
 * a value that is not honestly computable shows "—", never a fabricated 0.
 */
export function OptimizerPage({ tenants }: { tenants: Tenant[] }) {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesState, setSitesState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [siteId, setSiteId] = useState<string | null>(null);

  const [runAt, setRunAt] = useState<string | null>(null); // null = latest
  const [runDate, setRunDate] = useState<string | null>(null); // Berlin day of the run list
  const [diag, setDiag] = useState<OptimizerDiagnostics | null>(null);
  const [diagState, setDiagState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [diagError, setDiagError] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<number>(-1);

  const [config, setConfig] = useState<OptimizerConfig | null>(null);
  const [configState, setConfigState] = useState<'idle' | 'loading' | 'error'>('idle');

  // ---- data loading ----------------------------------------------------------

  useEffect(() => {
    if (!tenantId) {
      setSites([]);
      setSiteId(null);
      return;
    }
    let cancelled = false;
    setSitesState('loading');
    adminApi
      .listSites(tenantId)
      .then((list) => {
        if (cancelled) return;
        setSites(list);
        setSitesState('idle');
      })
      .catch(() => {
        if (!cancelled) setSitesState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const loadDiagnostics = useCallback(
    (gen: string | null, date: string | null = null) => {
      if (!tenantId || !siteId) return;
      setDiagState('loading');
      setDiagError('');
      optimizerApi
        .diagnostics(tenantId, siteId, gen, date)
        .then((d) => {
          setDiag(d);
          setRunAt(d.generatedAt);
          setRunDate(d.availableRunsDate);
          setSelectedSlot(defaultSlotIndex(d.slots));
          setDiagState('idle');
        })
        .catch((e) => {
          setDiag(null);
          setDiagError(e instanceof ApiError ? e.message : 'Diagnose konnte nicht geladen werden.');
          setDiagState('error');
        });
    },
    [tenantId, siteId],
  );

  const loadConfig = useCallback(() => {
    if (!tenantId || !siteId) return;
    setConfigState('loading');
    optimizerApi
      .config(tenantId, siteId)
      .then((c) => {
        setConfig(c);
        setConfigState('idle');
      })
      .catch(() => setConfigState('error'));
  }, [tenantId, siteId]);

  // Site chosen (or tenant switched to a site): load the latest run + config.
  useEffect(() => {
    if (!tenantId || !siteId) {
      setDiag(null);
      setConfig(null);
      return;
    }
    loadDiagnostics(null);
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, siteId]);

  const selectedSite = useMemo(() => sites.find((s) => s.id === siteId) ?? null, [sites, siteId]);
  const siteName = selectedSite?.name ?? 'Diese Anlage';

  return (
    <>
      <AdminPageHead
        icon="settings"
        category="primary"
        title="Optimizer"
        description="Diagnose & Konfiguration: verstehen, was der Optimizer für eine Anlage geplant hat und warum - und die Stellhebel pro Anlage justieren. Änderungen wirken beim nächsten Planungslauf."
      />

      {/* ---- picker row -------------------------------------------------------- */}
      <Card className="vp-optim-pickers" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <div className="vp-optim-picker">
          <label htmlFor="optim-tenant">Mandant</label>
          <select
            id="optim-tenant"
            className="vp-select"
            value={tenantId ?? ''}
            onChange={(e) => {
              setTenantId(e.target.value || null);
              setSiteId(null);
              setDiag(null);
              setConfig(null);
            }}
          >
            <option value="">Mandant wählen…</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="vp-optim-picker">
          <label htmlFor="optim-site">Anlage</label>
          <select
            id="optim-site"
            className="vp-select"
            value={siteId ?? ''}
            disabled={!tenantId || sitesState === 'loading'}
            onChange={(e) => setSiteId(e.target.value || null)}
          >
            <option value="">{sitesState === 'loading' ? 'Lädt…' : 'Anlage wählen…'}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {diag && diag.lastRunDate != null && (
          <>
            <div className="vp-optim-picker">
              <label htmlFor="optim-run-date">Tag</label>
              <input
                id="optim-run-date"
                type="date"
                className="vp-select"
                value={runDate ?? ''}
                min={diag.firstRunDate ?? undefined}
                max={diag.lastRunDate ?? undefined}
                onChange={(e) => {
                  if (e.target.value) loadDiagnostics(null, e.target.value);
                }}
              />
            </div>
            <div className="vp-optim-picker">
              <label htmlFor="optim-run">Lauf</label>
              <select
                id="optim-run"
                className="vp-select"
                value={runAt ?? ''}
                disabled={diag.availableRuns.length === 0}
                onChange={(e) => loadDiagnostics(e.target.value || null, runDate)}
              >
                {diag.availableRuns.length === 0 ? (
                  <option value="">Keine Läufe an diesem Tag</option>
                ) : (
                  diag.availableRuns.map((r) => (
                    <option key={r} value={r}>
                      {runLabel(r)}
                    </option>
                  ))
                )}
              </select>
            </div>
          </>
        )}

        {diag && (
          <div className="vp-optim-mode">
            <Badge variant={modeBadge(diag.netzladenErlaubt).tone} dot>
              {modeBadge(diag.netzladenErlaubt).text}
            </Badge>
          </div>
        )}
      </Card>

      {sitesState === 'error' && (
        <ErrorState message="Anlagen dieses Mandanten konnten nicht geladen werden." />
      )}

      {!tenantId ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="settings"
            category="primary"
            title="Optimizer-Diagnose öffnen"
            description="Wählen Sie oben einen Mandanten und eine Anlage, um die Optimizer-Diagnose zu öffnen."
          />
        </Card>
      ) : !siteId ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="sun"
            category="solar"
            title="Anlage wählen"
            description="Wählen Sie eine Anlage dieses Mandanten, um ihren Fahrplan und die Stellhebel zu sehen."
          />
        </Card>
      ) : diagState === 'loading' && !diag ? (
        <Card>
          <ChartCardSkeleton stats={4} />
        </Card>
      ) : diagState === 'error' ? (
        <ErrorState message={diagError} onRetry={() => loadDiagnostics(runAt, runDate)} />
      ) : diag && diag.slots.length === 0 ? (
        <Card padding="lg" radius="lg">
          {diag.lastRunDate == null ? (
            <EmptyState
              icon="calendar"
              category="dynamic"
              title="Noch kein Fahrplan"
              description="Für diese Anlage liegt noch kein Optimizer-Lauf vor. Sobald Preise und Prognosen für den Planungshorizont vorhanden sind, erscheint hier der Fahrplan."
            />
          ) : (
            <EmptyState
              icon="calendar"
              category="dynamic"
              title="Keine Läufe an diesem Tag"
              description={`Für den gewählten Tag liegen keine Optimizer-Läufe vor. Läufe gibt es zwischen dem ${runDateLabel(diag.firstRunDate ?? diag.lastRunDate)} und dem ${runDateLabel(diag.lastRunDate)} - wählen Sie oben einen anderen Tag.`}
            />
          )}
        </Card>
      ) : diag ? (
        <div className="vp-optim-body">
          <VerdictBanner diag={diag} siteName={siteName} />
          <InputsAtAGlance diag={diag} />
          <PlanSection diag={diag} selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} />
          <ExplainSlot diag={diag} selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} />
          <ObjectiveBreakdown diag={diag} />
          {tenantId && siteId && (
            <ConfigPanel
              key={siteId}
              tenantId={tenantId}
              siteId={siteId}
              config={config}
              state={configState}
              onReload={loadConfig}
              onSaved={(c) => {
                setConfig(c);
                // A knob change alters the next run, not this persisted one -
                // reload the diagnostics so the panel doesn't imply otherwise.
                loadDiagnostics(runAt);
              }}
            />
          )}
          <WhatIfPlaceholder />
        </div>
      ) : null}
    </>
  );
}

// ---- verdict banner ----------------------------------------------------------

function VerdictBanner({ diag, siteName }: { diag: OptimizerDiagnostics; siteName: string }) {
  const v = verdict(diag, siteName);
  return (
    <div className={`vp-optim-verdict tone-${v.tone}`}>
      <div className="num">{v.eur == null ? '—' : `${fmtEur(v.eur)}/Tag`}</div>
      <p className="txt">{v.text}</p>
    </div>
  );
}

// ---- inputs at a glance ------------------------------------------------------

function InputsAtAGlance({ diag }: { diag: OptimizerDiagnostics }) {
  const startSoc = diag.slots.find((s) => s.socPct != null)?.socPct ?? null;
  const b = diag.battery;
  return (
    <section className="vp-optim-section">
      <h2>Eingaben auf einen Blick</h2>
      <div className="vp-optim-cards">
        <GlanceCard label="Anlagentyp" value={plantKindLabel(diag.plantKind)} note={tariffNote(diag)} />
        <GlanceCard
          label="Netzladen"
          value={diag.netzladenErlaubt ? 'Erlaubt (Merchant)' : 'Nur Solar (EEG)'}
          note={
            diag.netzladenErlaubt
              ? 'Arbitrage aus dem Netz zulässig'
              : 'Ausschließlichkeitsprinzip - hartes Constraint'
          }
        />
        <GlanceCard
          label="SoC-Start"
          value={startSoc == null ? '—' : `${Number(startSoc).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`}
          note="Ladestand zu Beginn des Plans"
        />
        <GlanceCard
          label="Backup-Reserve"
          value={
            diag.backupReserveSocPct == null
              ? 'kein Boden'
              : `${Number(diag.backupReserveSocPct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`
          }
          note="harter SoC-Mindeststand"
        />
        <GlanceCard
          label="Aktive Modelle"
          value={diag.activePvModel}
          note={`Last: ${diag.activeLoadModel}`}
        />
        <GlanceCard
          label="Bezugspreis-Quelle"
          value={priceSourceLabel(diag.priceSource)}
          note={priceSourceNote(diag.priceSource)}
        />
        <GlanceCard
          label="§14a-Limit"
          value="nicht gespeichert"
          note="pro Lauf nicht abgelegt (bekannte Lücke)"
        />
      </div>
      {b && (
        <div className="vp-optim-cards" style={{ marginTop: 'var(--vp-space-4)' }}>
          <GlanceCard
            label="Speicher-Kapazität"
            value={b.capacityKwh == null ? '—' : fmtNum(Number(b.capacityKwh), 'kWh', 1)}
            note={
              b.roundtripEfficiencyPct == null
                ? 'Wirkungsgrad n/a'
                : `Wirkungsgrad ${fmtNum(Number(b.roundtripEfficiencyPct), '%', 0)}`
            }
          />
          <GlanceCard
            label="Verschleißkosten"
            value={fmtCt(b.wearCostCtPerKwh, 1)}
            note={b.wearCostSource === 'asset' ? 'Anlagen-Override' : 'Plattform-Standard'}
          />
          <GlanceCard
            label="Nutzbares SoC-Band"
            value={`${fmtNum(b.socMinPct, '', 0)}–${fmtNum(b.socMaxPct, '%', 0)}`}
            note="effektive Ober-/Untergrenze"
          />
        </div>
      )}
    </section>
  );
}

function tariffNote(diag: OptimizerDiagnostics): string {
  if (diag.tarifArt === 'dynamisch') {
    return diag.tarifParamCtKwh != null
      ? `dynamisch · Spot + ${fmtNum(Number(diag.tarifParamCtKwh), 'ct/kWh', 1)} Aufschlag`
      : 'dynamisch · Spot';
  }
  if (diag.tarifArt === 'fest') {
    return diag.tarifParamCtKwh != null
      ? `fest · ${fmtNum(Number(diag.tarifParamCtKwh), 'ct/kWh', 1)}`
      : 'fester Tarif';
  }
  return 'ohne Tarif-Bewertung';
}

/** The effective import-price source label (Stufe 2 admin echo, priceSource). */
function priceSourceLabel(source: string): string {
  switch (source) {
    case 'fest':
      return 'Fest (all-in)';
    case 'preisblatt':
      return 'Preisblatt (Komponenten)';
    case 'sammelaufschlag':
      return 'Sammelaufschlag';
    case 'default-flag':
      return 'Default-Vorschlag (Flag)';
    default:
      return 'Nur Börsenpreis';
  }
}

function priceSourceNote(source: string): string {
  switch (source) {
    case 'fest':
      return 'flacher Endkundenpreis · Komponenten ignoriert';
    case 'preisblatt':
      return 'gepflegte site_supply_price-Zeile aktiv';
    case 'sammelaufschlag':
      return 'Spot + einzelner dynamisch-Aufschlag';
    case 'default-flag':
      return 'recherchierter Default (OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS)';
    default:
      return 'nackter Spot – Bezug ohne Netzentgelte/Abgaben (Preisblatt pflegen)';
  }
}

function GlanceCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="vp-optim-glance">
      <div className="lbl">{label}</div>
      <div className="big">{value}</div>
      {note && <div className="note">{note}</div>}
    </Card>
  );
}

// ---- the plan ----------------------------------------------------------------

function PlanSection({
  diag,
  selectedSlot,
  onSelectSlot,
}: {
  diag: OptimizerDiagnostics;
  selectedSlot: number;
  onSelectSlot: (idx: number) => void;
}) {
  const totals = objectiveTotals(diag);
  return (
    <section className="vp-optim-section">
      <h2>Der Plan</h2>
      <p className="vp-chart-sub">
        Geplante Batterieleistung (Balken) über dem Preis: durchgezogen der Spot-Preis, den der
        Solver optimiert, gestrichelt der reale Bezugs-/Einspeisewert dieser Anlage. Klicken Sie
        einen Balken für die €-Aufschlüsselung.
      </p>
      <Card>
        <OptimizerPlanChart diag={diag} selectedIdx={selectedSlot} onSelectSlot={onSelectSlot} />
        {totals.grossSavingsEur != null && (
          <ChartInsight>
            Der Plan verschiebt Energie so, dass er gegenüber einem Betrieb ohne Speicher{' '}
            <strong>{fmtEur(totals.grossSavingsEur)}/Tag</strong> einspart
            {totals.wearKnown ? (
              <>
                {' '}
                (abzüglich {fmtEur(totals.wearEur)} Verschleiß bleiben{' '}
                <strong>{fmtEur(totals.netSavingsEur)}/Tag</strong> netto).
              </>
            ) : (
              ' - jeweils zu den realen Tarif-/Vergütungspreisen bewertet.'
            )}
          </ChartInsight>
        )}
      </Card>
    </section>
  );
}

// ---- explain a slot ----------------------------------------------------------

function ExplainSlot({
  diag,
  selectedSlot,
  onSelectSlot,
}: {
  diag: OptimizerDiagnostics;
  selectedSlot: number;
  onSelectSlot: (idx: number) => void;
}) {
  const slots = diag.slots;
  const slot = selectedSlot >= 0 && selectedSlot < slots.length ? slots[selectedSlot] : null;
  const notable = notableSlots(slots);
  const rows = slot ? slotWaterfall(slot) : [];
  const maxAbs = Math.max(1, ...rows.map((r) => (r.ctKwh == null ? 0 : Math.abs(r.ctKwh))));

  return (
    <section className="vp-optim-section">
      <h2>Diesen Slot erklären</h2>
      <div className="vp-optim-explain">
        <Card>
          <div className="vp-optim-slotpick">
            {notable.firstDischarge != null && (
              <button
                type="button"
                className={`vp-optim-slotbtn${selectedSlot === notable.firstDischarge ? ' active' : ''}`}
                onClick={() => onSelectSlot(notable.firstDischarge as number)}
              >
                Erste Entladung
              </button>
            )}
            {notable.firstCharge != null && (
              <button
                type="button"
                className={`vp-optim-slotbtn${selectedSlot === notable.firstCharge ? ' active' : ''}`}
                onClick={() => onSelectSlot(notable.firstCharge as number)}
              >
                Erstes Laden
              </button>
            )}
            {notable.firstGridImport != null && (
              <button
                type="button"
                className={`vp-optim-slotbtn${selectedSlot === notable.firstGridImport ? ' active' : ''}`}
                onClick={() => onSelectSlot(notable.firstGridImport as number)}
              >
                Erster Netzbezug
              </button>
            )}
            <select
              className="vp-select vp-optim-slotselect"
              aria-label="Slot wählen"
              value={selectedSlot}
              onChange={(e) => onSelectSlot(Number(e.target.value))}
            >
              {slots.map((s, i) => (
                <option key={s.time} value={i}>
                  {slotTimeLabel(s.time)} · {decisionLabelText(s.decisionLabel)}
                </option>
              ))}
            </select>
          </div>

          {slot ? (
            <>
              <div className="vp-optim-slothead">
                <span className="t">{slotTimeLabel(slot.time)}</span>
                <Badge variant={decisionTone(slot.decisionLabel)} dot>
                  {decisionLabelText(slot.decisionLabel)}
                </Badge>
              </div>
              <div className="vp-optim-waterfall">
                {rows.map((r) => (
                  <div className="wf-row" key={r.key}>
                    <span className="wf-label">
                      {r.label}
                      {r.approximate && (
                        <InfoTip label="Was bedeutet das?">
                          Näherung: der Wert der gespeicherten Energie ist der beste erreichbare
                          Vorwärtspreis abzüglich Wirkungsgrad-Verlust - keine exakte MILP-Größe.
                        </InfoTip>
                      )}
                    </span>
                    <span className="wf-bar-wrap">
                      {r.ctKwh != null && (
                        <span
                          className={`wf-bar kind-${r.kind}`}
                          style={{ width: `${(Math.abs(r.ctKwh) / maxAbs) * 100}%` }}
                        />
                      )}
                    </span>
                    <span className={`wf-val${r.ctKwh != null && r.ctKwh < 0 ? ' neg' : ''}`}>
                      {fmtCt(r.ctKwh, 1)}
                    </span>
                  </div>
                ))}
              </div>
              {slot.whyText && <p className="vp-optim-why">{slot.whyText}</p>}
              {diag.storedEnergyValueIsApproximation && (
                <p className="vp-note vp-optim-approx">
                  Der „Wert gespeicherter Energie" ist eine Vorwärts-Näherung, kein exakter
                  Schattenpreis des Solvers.
                </p>
              )}
            </>
          ) : (
            <p className="vp-muted">Wählen Sie einen Slot.</p>
          )}
        </Card>

        <Card className="vp-optim-legend-card">
          <h4>Was zeigt die Aufschlüsselung?</h4>
          <p className="vp-muted">
            Jede Zeile ist ein Preisbestandteil in ct/kWh, gegen den der Solver diesen Slot bewertet
            hat. <strong style={{ color: 'var(--vp-chart-charge)' }}>Grün</strong> sind Erlöse/Werte
            (Einspeisung, gespeicherte Energie),{' '}
            <strong style={{ color: 'var(--vp-chart-discharge)' }}>rot</strong> Kosten (Bezug,
            Verschleiß). Der Satz darunter fasst die Entscheidung in einem Satz zusammen - er kommt
            direkt aus dem Optimizer.
          </p>
        </Card>
      </div>
    </section>
  );
}

function decisionTone(label: string): 'ok' | 'warn' | 'off' {
  if (label === 'entladen') return 'warn';
  if (label === 'ruhe') return 'off';
  return 'ok';
}

// ---- objective breakdown -----------------------------------------------------

function ObjectiveBreakdown({ diag }: { diag: OptimizerDiagnostics }) {
  const t = objectiveTotals(diag);
  const kpi = (
    value: number | null,
    tone: 'pos' | 'neg' | 'neutral',
  ): { text: string; cls: string } => {
    const cls = value == null ? '' : tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : '';
    return { text: value == null ? '—' : `${fmtEur(value)}/Tag`, cls };
  };
  const net = kpi(t.netSavingsEur, t.netSavingsEur != null && t.netSavingsEur < 0 ? 'neg' : 'pos');
  const gross = kpi(t.grossSavingsEur, 'pos');
  const spot = kpi(t.spotSavingsEur, 'neutral');

  return (
    <section className="vp-optim-section">
      <h2>Zielfunktions-Aufschlüsselung</h2>
      <div className="vp-optim-kpis">
        <div className="vp-optim-kpi">
          <div className="lbl">
            Netto-Ersparnis (real){' '}
            <InfoTip label="Was bedeutet das?">
              Geplante Tagesersparnis gegenüber einem Betrieb ohne Speicher, zu den realen Tarif-
              und Vergütungspreisen bewertet, abzüglich der Verschleißkosten.
            </InfoTip>
          </div>
          <div className={`val ${net.cls}`}>{net.text}</div>
          <div className="foot">Ziel des Optimizers: Markterlös maximieren</div>
        </div>
        <div className="vp-optim-kpi">
          <div className="lbl">Brutto (vor Verschleiß)</div>
          <div className={`val ${gross.cls}`}>{gross.text}</div>
          <div className="foot">Σ(Basiskosten − Plankosten)</div>
        </div>
        <div className="vp-optim-kpi">
          <div className="lbl">
            Verschleißkosten{' '}
            <InfoTip label="Was bedeutet das?">
              Die im Plan bepreiste Batterie-Abnutzung (P2). „—" bedeutet, dass dieser Lauf noch
              keine Verschleißkosten abgelegt hat.
            </InfoTip>
          </div>
          <div className="val neg">{t.wearEur == null ? '—' : `${fmtEur(t.wearEur)}/Tag`}</div>
          <div className="foot">{t.wearKnown ? 'im Plan bepreist' : 'nicht bepreist (vor P2)'}</div>
        </div>
        <div className="vp-optim-kpi">
          <div className="lbl">
            Zum Vergleich: zu Spot bewertet{' '}
            <InfoTip label="Was bedeutet das?">
              Dieselbe Batterieentscheidung, aber nur mit dem reinen Börsen-Spotpreis bewertet -
              zeigt, wie die Kennzahl ohne Tarif/Vergütung aussähe.
            </InfoTip>
          </div>
          <div className={`val ${spot.cls}`}>{spot.text}</div>
          <div className="foot">
            {t.pricedSlotCount} von {t.slotCount} Slots bepreist
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- config panel ------------------------------------------------------------

function ConfigPanel({
  tenantId,
  siteId,
  config,
  state,
  onReload,
  onSaved,
}: {
  tenantId: string;
  siteId: string;
  config: OptimizerConfig | null;
  state: 'idle' | 'loading' | 'error';
  onReload: () => void;
  onSaved: (c: OptimizerConfig) => void;
}) {
  const [form, setForm] = useState<ConfigFormState>({
    wearCostCtPerKwh: '',
    socMinPct: '',
    socMaxPct: '',
    backupReserveSocPct: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (config) {
      // Reseed the form from the current overrides (incl. right after a save,
      // which returns the persisted values). Do NOT clear `ok` here: a
      // successful save sets it in the same tick this effect would run, so
      // clearing it would swallow the "Gespeichert" confirmation.
      setForm(configFormFromOverrides(config.overrides));
      setError('');
    }
  }, [config]);

  if (state === 'loading' && !config) {
    return (
      <section className="vp-optim-section">
        <h2>Optimizer konfigurieren</h2>
        <Card>
          <TextSkeleton lines={5} />
        </Card>
      </section>
    );
  }
  if (state === 'error' || !config) {
    return (
      <section className="vp-optim-section">
        <h2>Optimizer konfigurieren</h2>
        <ErrorState message="Konfiguration konnte nicht geladen werden." onRetry={onReload} />
      </section>
    );
  }

  const set = (k: keyof ConfigFormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setOk(false);
  };

  const save = () => {
    const built = buildConfigRequest(form, {
      socMinPct: config.defaults.socMinPct,
      socMaxPct: config.defaults.socMaxPct,
    });
    if (!built.ok || !built.body) {
      setError(built.error ?? 'Ungültige Eingabe.');
      return;
    }
    setSaving(true);
    setError('');
    setOk(false);
    optimizerApi
      .updateConfig(tenantId, siteId, built.body)
      .then((c) => {
        onSaved(c);
        setOk(true);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
      })
      .finally(() => setSaving(false));
  };

  const d = config.defaults;
  const eff = config.effective;

  return (
    <section className="vp-optim-section">
      <h2>Optimizer konfigurieren</h2>
      <p className="vp-chart-sub">
        Plattform-Standard vs. Override für diese Anlage. Ein leeres Feld setzt den Hebel auf den
        Plattform-Standard zurück. Änderungen wirken beim nächsten Planungslauf.
      </p>

      {!config.hasBattery && (
        <div className="vp-alert vp-alert-info" style={{ marginBottom: 'var(--vp-space-4)' }}>
          Diese Anlage hat keinen Batteriespeicher - Verschleißkosten und SoC-Band sind erst nach
          dem Anlegen eines Speichers einstellbar.
        </div>
      )}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <table className="vp-table responsive vp-optim-cfg">
          <thead>
            <tr>
              <th>Hebel</th>
              <th>Plattform-Standard</th>
              <th>Override</th>
              <th>Effektiv</th>
            </tr>
          </thead>
          <tbody>
            <LeverRow
              label="Verschleißkosten"
              desc="ct/kWh Durchsatz - stoppt Mikro-Zyklen bei Bruchteil-Cent-Spreads (P2)"
              def={fmtNum(d.wearCostCtPerKwh, 'ct/kWh', 1)}
              effective={eff.wearCostCtPerKwh == null ? '—' : fmtNum(eff.wearCostCtPerKwh, 'ct/kWh', 1)}
              input={
                <input
                  type="text"
                  inputMode="decimal"
                  className="vp-optim-num"
                  placeholder="Standard"
                  disabled={!config.hasBattery}
                  value={form.wearCostCtPerKwh}
                  onChange={set('wearCostCtPerKwh')}
                  aria-label="Verschleißkosten-Override in ct/kWh"
                />
              }
            />
            <LeverRow
              label="SoC-Band Untergrenze"
              desc="nutzbarer Ladebereich der Batterie (Untergrenze)"
              def={fmtNum(d.socMinPct, '%', 0)}
              effective={eff.socMinPct == null ? '—' : fmtNum(eff.socMinPct, '%', 0)}
              input={
                <input
                  type="text"
                  inputMode="decimal"
                  className="vp-optim-num"
                  placeholder="Standard"
                  disabled={!config.hasBattery}
                  value={form.socMinPct}
                  onChange={set('socMinPct')}
                  aria-label="SoC-Untergrenze-Override in Prozent"
                />
              }
            />
            <LeverRow
              label="SoC-Band Obergrenze"
              desc="nutzbarer Ladebereich der Batterie (Obergrenze)"
              def={fmtNum(d.socMaxPct, '%', 0)}
              effective={eff.socMaxPct == null ? '—' : fmtNum(eff.socMaxPct, '%', 0)}
              input={
                <input
                  type="text"
                  inputMode="decimal"
                  className="vp-optim-num"
                  placeholder="Standard"
                  disabled={!config.hasBattery}
                  value={form.socMaxPct}
                  onChange={set('socMaxPct')}
                  aria-label="SoC-Obergrenze-Override in Prozent"
                />
              }
            />
            <LeverRow
              label="Backup-Reserve-Boden"
              desc="harter SoC-Mindeststand, unabhängig vom Ziel (P11)"
              def="kein Boden"
              effective={
                eff.backupReserveSocPct == null ? 'kein Boden' : fmtNum(Number(eff.backupReserveSocPct), '%', 0)
              }
              input={
                <input
                  type="text"
                  inputMode="decimal"
                  className="vp-optim-num"
                  placeholder="kein Boden"
                  value={form.backupReserveSocPct}
                  onChange={set('backupReserveSocPct')}
                  aria-label="Backup-Reserve-Override in Prozent"
                />
              }
            />

            <tr className="vp-optim-cfg-group">
              <td colSpan={4}>Nur lesbar - über die Anlagen-Einstellungen editierbar</td>
            </tr>
            <ReadonlyRow label="Netzladen erlaubt" value={config.site.netzladenErlaubt ? 'Ja' : 'Nein (EEG)'} />
            <ReadonlyRow label="Anlagentyp" value={plantKindLabel(config.site.plantKind)} />
            <ReadonlyRow
              label="Tarifart / Aufschlag"
              value={
                config.site.tarifArt === 'dynamisch'
                  ? config.site.tarifParamCtKwh != null
                    ? `dynamisch · +${fmtNum(Number(config.site.tarifParamCtKwh), 'ct/kWh', 1)}`
                    : 'dynamisch'
                  : config.site.tarifArt === 'fest'
                    ? config.site.tarifParamCtKwh != null
                      ? `fest · ${fmtNum(Number(config.site.tarifParamCtKwh), 'ct/kWh', 1)}`
                      : 'fest'
                    : 'ohne'
              }
            />
            <ReadonlyRow
              label="Anzulegender Wert"
              value={
                config.site.anzulegenderWertCtKwh == null
                  ? '—'
                  : fmtNum(Number(config.site.anzulegenderWertCtKwh), 'ct/kWh', 2)
              }
            />
            <ReadonlyRow
              label="Terminal-Wert (Endwert)"
              value={
                d.terminalValueCtPerKwh != null
                  ? `${fmtNum(d.terminalValueCtPerKwh, 'ct/kWh', 1)} (fest)`
                  : `Quantil ${fmtNum(d.terminalValueQuantile * 100, '%', 0)} des Horizonts`
              }
            />
          </tbody>
        </table>
      </Card>

      <div className="vp-optim-cfg-actions">
        <Button variant="primary" disabled={saving} onClick={save}>
          {saving ? 'Speichern…' : 'Einstellungen speichern'}
        </Button>
        {ok && (
          <span className="vp-optim-saved">
            <Icon name="check" size={16} /> Gespeichert - wirkt beim nächsten Lauf.
          </span>
        )}
        {error && <span className="vp-optim-cfg-err">{error}</span>}
      </div>
    </section>
  );
}

function LeverRow({
  label,
  desc,
  def,
  effective,
  input,
}: {
  label: string;
  desc: string;
  def: string;
  effective: string;
  input: React.ReactNode;
}) {
  return (
    <tr>
      <td data-label="Hebel">
        <div className="lever">{label}</div>
        <div className="desc">{desc}</div>
      </td>
      <td data-label="Plattform-Standard" className="vp-mono">
        {def}
      </td>
      <td data-label="Override">{input}</td>
      <td data-label="Effektiv" className="vp-mono">
        {effective}
      </td>
    </tr>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td data-label="Hebel">
        <div className="lever">{label}</div>
      </td>
      <td data-label="Plattform-Standard" colSpan={2} className="vp-muted">
        über Anlagen-Einstellungen
      </td>
      <td data-label="Effektiv" className="vp-mono">
        {value}
      </td>
    </tr>
  );
}

// ---- what-if (deferred) ------------------------------------------------------

function WhatIfPlaceholder() {
  return (
    <section className="vp-optim-section">
      <h2>Was-wäre-wenn-Vorschau</h2>
      <Card className="vp-optim-whatif">
        <Icon name="settings" size={22} />
        <div>
          <h4 style={{ margin: 0 }}>Bald verfügbar</h4>
          <p className="vp-muted" style={{ margin: '4px 0 0' }}>
            Regler ändern → Plan für diese Anlage einmalig neu rechnen → Seite an Seite
            vergleichen. Braucht einen synchronen Re-Optimize-Endpoint, der noch nicht existiert -
            gespeicherte Einstellungen oben wirken bereits beim nächsten regulären Lauf.
          </p>
        </div>
      </Card>
    </section>
  );
}
