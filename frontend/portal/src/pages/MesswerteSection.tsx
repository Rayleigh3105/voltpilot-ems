import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { History, HistoryRange, Site } from '../api';
import { NBSP } from '../format';
import { isoDate } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  energieBilanz,
  summenTitel,
  zeitraumHinweis,
  type EnergieFarbe,
  type EnergieSumme,
} from '../energieBilanz';
import { chartTheme } from '../chartTheme';
import {
  availableWelten,
  historieHash,
  weltSwitchCards,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import type { AnlageSurface } from '../surface';

import { InfoTip } from '../components/InfoTip';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { HistoryEnergieChart } from '../HistoryChart';
import { KartenKopf, WeltFuss, WeltKopf, ZeitLeiste } from '../components/HistorieWelt';

import '../components/Historie.css';

/**
 * **Welt A · „Messwerte"** (`#/anlage/{id}/messwerte`) — die Basis-Welt der
 * Historie, auf JEDER Anlage vorhanden (Konzept `data/vp-historie-konzept-t4`,
 * Captain-Struktur H1).
 *
 * Sie zeigt ausschließlich GEMESSENE Zahlen: die Energiemengen des Zeitraums,
 * das eine Mehrreihen-Diagramm (`energieBilanz.ts` + `HistoryChart` —
 * unverändert übernommen) und darunter, aufklappbar, den Messwerte-Explorer.
 *
 * Zwei Struktur-Entscheidungen stecken darin:
 * - **Der dritte Umschalter „Übersicht | Messwerte" entfällt ersatzlos.** Der
 *   Explorer ist ein Abschnitt DIESER Welt, kein konkurrierender Modus; der
 *   bestehende Deep-Link `?m=…&z=tag` öffnet ihn direkt aufgeklappt.
 * - **Die Stromkosten sind hier weg.** Sie sind eine BEWERTETE Zahl (heute
 *   gepflegtes Preisblatt) und standen als einzelner Chip in einer gemessenen
 *   Karte; sie leben jetzt in der Erlöse-Welt (report §7).
 */

function kwh(v: number | null | undefined): string {
  return v == null
    ? '-'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}kWh`;
}

function pct(v: number | null | undefined): string {
  return v == null ? '-' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}%`;
}

/** The pure `EnergieFarbe` key -> the resolved chart hex (the KPI dots). */
function dotColor(key: EnergieFarbe): string {
  const t = chartTheme();
  const map: Record<EnergieFarbe, string> = {
    pv: t.pv,
    load: t.load,
    grid: t.flowGrid,
    gridImport: t.discharge,
    gridExport: t.charge,
    charge: t.charge,
    battDischarge: t.battDischarge,
    soc: t.soc,
  };
  return map[key];
}

/** One period-total tile: value + coloured dot + plain-German hint. */
function SummeTile({ summe }: { summe: EnergieSumme }) {
  return (
    <div className="vp-esum" title={summe.hinweis}>
      <span className="vp-esum-v">{kwh(summe.kwh)}</span>
      <span className="vp-esum-l">
        <span className="vp-esum-dot" style={{ ['--dot' as string]: dotColor(summe.farbe) }} />
        {summe.label}
      </span>
    </div>
  );
}

/** Karte 1 + 2 der Welt: Energiemengen des Zeitraums und das eine Diagramm. */
function EnergieKarten({
  history,
  range,
  anchor,
}: {
  history: History;
  range: HistoryRange;
  anchor: Date;
}) {
  const bilanz = energieBilanz(history);
  const hinweis = zeitraumHinweis(anchor, range, new Date());
  const isDay = range === 'day';

  if (history.buckets.length === 0 || bilanz.empty) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="history"
          category="dynamic"
          title="Keine Messwerte in diesem Zeitraum"
          description="Sobald Ihre Anlage misst, entsteht hier die Energiegeschichte: PV-Erzeugung, Hausverbrauch, Netz und Speicher in einem Bild. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
        />
      </Card>
    );
  }

  return (
    <>
      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <KartenKopf icon="zap" titel={summenTitel(anchor, range)} art="gemessen" />

          <div className="vp-energie-summen" aria-label="Energiemengen im Zeitraum">
            {bilanz.summen.map((s) => (
              <SummeTile key={s.key} summe={s} />
            ))}
          </div>

          <div className="vp-energie-chips">
            <span className="vp-energie-chip">
              Autarkie <b>{pct(bilanz.autarkiePct)}</b>
              <InfoTip title="Autarkiegrad">
                Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben (aus PV und Speicher) -
                der Rest kam aus dem Netz. Formel: 1 − Netzbezug/Verbrauch.
              </InfoTip>
            </span>
            <span className="vp-energie-chip">
              Eigenverbrauch <b>{pct(bilanz.eigenverbrauchPct)}</b>
              <InfoTip title="Eigenverbrauchsquote">
                Anteil Ihrer PV-Erzeugung, den Sie selbst genutzt statt eingespeist haben.
                Formel: selbst genutzte PV / PV-Erzeugung.
              </InfoTip>
            </span>
          </div>

          {hinweis && <p className="vp-note">{hinweis}</p>}
        </Card>
      </section>

      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <KartenKopf
            icon="activity"
            titel="Ihre Energie im Verlauf"
            art="gemessen"
            extra={
              <Badge variant="tint">
                {isDay ? '15-Minuten-Mittel' : range === 'week' ? 'stündlich' : 'täglich'}
              </Badge>
            }
          />
          <ChartSubtitle>
            {isDay
              ? 'Der Tagesverlauf Ihrer Anlage in einem Bild: PV-Erzeugung, Hausverbrauch, Netz und Speicher - dazu der Ladestand.'
              : 'Erzeugung, Verbrauch, Netz und Speicher je Abschnitt im gewählten Zeitraum - als Energiemengen in Kilowattstunden, dazu der Ladestand.'}
          </ChartSubtitle>
          <HistoryEnergieChart history={history} />
        </Card>
      </section>
    </>
  );
}

export function MesswerteSection({
  site,
  surface,
  onOpenWelt,
}: {
  site: Site;
  /** Das M0-Lese-Modell der Anlage — entscheidet, ob es die Erlöse-Welt gibt. */
  surface?: AnlageSurface | null;
  onOpenWelt: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  // Der Explorer ist ein Abschnitt dieser Welt; ein Deep-Link auf einen
  // Messwert öffnet ihn direkt aufgeklappt (bestehende Links bleiben gültig).
  const [explorerOpen, setExplorerOpen] = useState(init.target != null);

  const at = isoDate(anchor);
  const { history, loading, stale, err, retry } = useHistoryPeriod(site.id, range, at);

  // Ein Cockpit-Sprung (oder Zurück/Vorwärts) ändert den Deep-Link, während
  // diese Fläche montiert bleibt - Zeitraum + Explorer daraus neu setzen. Der
  // replaceState des Explorers löst kein hashchange aus, das hier reagiert also
  // nur auf echte Navigation.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      if (!p.target) return;
      setExplorerOpen(true);
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const welt = WELTEN.messwerte;
  const available = availableWelten(surface);

  const toggleExplorer = useCallback(() => {
    setExplorerOpen((open) => {
      // Beim Zuklappen die Messwert-Parameter aus der Adresse nehmen, damit ein
      // Neuladen die Welt so zeigt, wie sie gerade aussieht.
      if (open) {
        window.history.replaceState(null, '', historieHash(site.id, 'messwerte', range, at));
      }
      return !open;
    });
  }, [site.id, range, at]);

  return (
    <>
      <WeltKopf
        welt={welt}
        cards={weltSwitchCards('messwerte', available)}
        hrefFor={(c) => historieHash(site.id, c.welt.id, range, at)}
        onOpen={(c) => onOpenWelt(c.welt.id)}
      />
      <ZeitLeiste range={range} anchor={anchor} onRange={setRange} onAnchor={setAnchor} />

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {err && !history ? (
          <ErrorState message={`Die Historie konnte nicht geladen werden (${err}).`} onRetry={retry} />
        ) : !history ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton />
            </Card>
          ) : null
        ) : (
          <EnergieKarten history={history} range={range} anchor={anchor} />
        )}
      </div>

      {/* Karte 3: der Messwerte-Explorer - ein Abschnitt DIESER Welt. */}
      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <button
            type="button"
            className={explorerOpen ? 'vp-welt-disclosure open' : 'vp-welt-disclosure'}
            aria-expanded={explorerOpen}
            onClick={toggleExplorer}
          >
            <span className="vp-wd-title">Einzelne Messwerte vergleichen</span>
            <span className="vp-wd-sub">bis zu 3 gleichzeitig</span>
            <span className="vp-wd-chev" aria-hidden="true">
              <Icon name="chevron-down" size={20} />
            </span>
          </button>
          {explorerOpen && (
            <div className="vp-welt-disclosure-body">
              <VerlaufExplorer
                site={site}
                range={range}
                anchor={anchor}
                initialTargets={init.targets}
              />
            </div>
          )}
        </Card>
      </section>

      <WeltFuss welt={welt} />
    </>
  );
}
