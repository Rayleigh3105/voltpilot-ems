import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import type { History, HistoryRange, ProtocolEvent, Site } from '../api';
import { eurAmount } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import { gridCostHinweis, zeitraumHinweis } from '../energieBilanz';
import {
  availableWelten,
  historieHash,
  weltSwitchCards,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import type { AnlageSurface } from '../surface';

import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { HistoryDayChart } from '../HistoryChart';
import { KartenKopf, WeltFuss, WeltKopf, ZeitLeiste } from '../components/HistorieWelt';

import '../components/Historie.css';

/**
 * **Welt B · „Erlöse"** (`#/anlage/{id}/erloese`) — die Geld-Welt der Historie
 * (Konzept `data/vp-historie-konzept-t4`, Captain-Struktur H1). Sie erscheint in
 * der Navigation nur, wenn die Anlage einen Geld-Modus hat (`surface.ts`
 * `erloes-historie`), ist per Lesezeichen aber nie eine Sackgasse: das
 * Kartenpaar im Kopf führt immer zurück.
 *
 * **Was hier NEU ist, ist die Struktur, nicht der Inhalt.** Die Zahlen sind die
 * bisherigen — aber jede Karte trägt jetzt genau EIN Ehrlichkeits-Abzeichen und
 * enthält nur Zahlen derselben Art (report §7). Deshalb sind es zwei getrennte
 * Karten: **Stromkosten** (bewertet — sie sind aus der gemessenen Energie-Karte
 * hierher gezogen) und **geplante Speicher-Ersparnis** (geplant — eine
 * Vorher-Rechnung des Optimierers, die nie unbeschriftet neben einer gemessenen
 * Zahl stehen darf).
 *
 * Das inhaltliche Füllen (gemessener Erlös, Komposition, Geld im Verlauf,
 * Marktwert-Vergleich) ist der nächste Schritt und hängt hier nur die Karten
 * ein — das Skelett steht.
 */

const EVENT_ICONS: Record<ProtocolEvent['type'], { icon: IconName; label: string }> = {
  'batterie-laden': { icon: 'arrow-up', label: 'Laden' },
  'batterie-entladen': { icon: 'arrow-down', label: 'Entladen' },
  'pv-spitze': { icon: 'sun', label: 'PV' },
  'preis-tief': { icon: 'trending-down', label: 'Preis-Tief' },
  'preis-hoch': { icon: 'trending-up', label: 'Preis-Hoch' },
};

/** Die Geld-Karten des Zeitraums (je Art eine Karte, je Karte ein Abzeichen). */
function GeldKarten({
  history,
  range,
  anchor,
}: {
  history: History;
  range: HistoryRange;
  anchor: Date;
}) {
  const totals = history.totals;
  const hinweis = zeitraumHinweis(anchor, range, new Date());
  const isDay = range === 'day';
  const label = periodLabel(anchor, range);

  if (history.buckets.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="history"
          category="dynamic"
          title="Keine Daten in diesem Zeitraum"
          description="Sobald Ihr Gerät Messwerte liefert, entstehen hier die Kosten und die geplante Ersparnis - Tag für Tag nachvollziehbar. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
        />
      </Card>
    );
  }

  return (
    <>
      {/* Bewertet: was der Strombezug im Zeitraum gekostet hat. */}
      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <KartenKopf icon="euro" category="primary" titel={`Kosten · ${label}`} art="bewertet" />
          <section className="vp-kpis" aria-label="Geld im Zeitraum">
            <KpiCard
              icon={<Icon name="euro" size={20} />}
              category="dynamic"
              value={totals.gridCostEur == null ? '-' : eurAmount(totals.gridCostEur)}
              label="Stromkosten (Netzbezug)"
              title={
                totals.tarifPriced
                  ? 'Bezogene Energie, je Viertelstunde bewertet zu Ihrem Stromtarif statt zum Börsenpreis - dieselbe Rechnung, mit der die Steuerung plant.'
                  : 'Bezogene Energie × zugehöriger Börsenpreis, je Viertelstunde. Ein hinterlegter Stromtarif würde hier eingerechnet.'
              }
            />
          </section>
          <p className="vp-note" style={{ marginTop: 8 }}>
            {totals.gridCostEur == null
              ? 'Für diesen Zeitraum liegen keine Börsenpreise vor. '
              : `Bezogene Energie, ${gridCostHinweis(totals.tarifPriced)}. `}
            {hinweis}
          </p>
        </Card>
      </section>

      {/* Geplant: die Vorher-Rechnung des Optimierers - eigene Karte, eigenes
          Abzeichen, damit sie nie als gemessene Ersparnis gelesen wird. */}
      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <KartenKopf
            icon="battery-charging"
            category="battery"
            titel={`Geplante Speicher-Ersparnis · ${label}`}
            art="geplant"
          />
          <section className="vp-kpis" aria-label="Geplante Ersparnis im Zeitraum">
            <KpiCard
              icon={<Icon name="battery-charging" size={20} />}
              category="battery"
              value={
                totals.batterySavingsPlannedEur == null
                  ? '-'
                  : eurAmount(totals.batterySavingsPlannedEur)
              }
              label="Geplante Ersparnis gegenüber „ohne Speicher“"
              title="Aus den gespeicherten Fahrplänen GEPLANT: Kosten gegenüber einem Betrieb ohne Speicher. Nicht die gemessene Ersparnis - die steht im Geld-Überblick Ihrer Anlage."
            />
          </section>
          <p className="vp-note" style={{ marginTop: 8 }}>
            {totals.batterySavingsPlannedEur == null
              ? 'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die geplante Ersparnis erscheint, sobald geplant wird.'
              : 'Vorab geplant, nicht gemessen: die gemessene Ersparnis steht im Cockpit Ihrer Anlage. Beide dürfen deutlich voneinander abweichen.'}
          </p>
        </Card>
      </section>

      {/* Tagesansicht: der Nachweis - was der Speicher wirklich getan hat. */}
      {isDay && (
        <section className="vp-section">
          <Card padding="lg" radius="lg">
            <KartenKopf
              icon="battery"
              category="battery"
              titel="Speicher & Preis"
              art="gemessen"
              extra={
                history.plan.length > 0 ? (
                  <Badge variant="tint">Plan &amp; Ist</Badge>
                ) : (
                  <Badge variant="off">kein Plan</Badge>
                )
              }
            />
            <ChartSubtitle>
              Was Ihr Speicher an diesem Tag wirklich getan hat - direkt über dem
              Börsen-Strompreis, damit Sie sehen, dass er günstig lädt und teuer entlädt.
            </ChartSubtitle>
            <HistoryDayChart history={history} />
          </Card>
        </section>
      )}

      {/* Tagesprotokoll (nur Tag): der Tag in deutschen Sätzen. */}
      {isDay && (
        <section className="vp-section">
          <Card padding="lg" radius="lg">
            <KartenKopf icon="list" category="home" titel="Tagesprotokoll" art="bewertet" />
            {history.protocol.length === 0 ? (
              <p className="vp-muted">
                Keine besonderen Ereignisse an diesem Tag - keine nennenswerte
                Batterie-Aktivität, PV-Erzeugung oder Preisspreizung erkannt.
              </p>
            ) : (
              <ul className="vp-timeline">
                {history.protocol.map((e, i) => {
                  const fmt = (iso: string) =>
                    new Date(iso).toLocaleTimeString('de-DE', {
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                  const oneSlot =
                    new Date(e.end).getTime() - new Date(e.start).getTime() <= 15 * 60000;
                  return (
                    <li key={`${e.type}-${e.start}-${i}`}>
                      <span className="t">
                        {oneSlot ? fmt(e.start) : `${fmt(e.start)} - ${fmt(e.end)}`}
                      </span>
                      <span className="ico" aria-hidden="true">
                        {EVENT_ICONS[e.type] ? (
                          <Icon name={EVENT_ICONS[e.type].icon} size={16} />
                        ) : null}
                      </span>
                      <span className="txt">{e.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="vp-note" style={{ marginTop: 12 }}>
              Automatisch aus Messwerten und Börsenpreisen des Tages abgeleitet.
            </p>
          </Card>
        </section>
      )}
    </>
  );
}

export function ErloeseSection({
  site,
  surface,
  onOpenWelt,
}: {
  site: Site;
  surface?: AnlageSurface | null;
  onOpenWelt: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  const at = isoDate(anchor);
  const { history, loading, stale, err, retry } = useHistoryPeriod(site.id, range, at);

  // Zurück/Vorwärts oder ein Sprung mit Zeitraum: die Periode neu übernehmen.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const welt = WELTEN.erloese;
  const available = availableWelten(surface);

  return (
    <>
      <WeltKopf
        welt={welt}
        cards={weltSwitchCards('erloese', available)}
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
          <GeldKarten history={history} range={range} anchor={anchor} />
        )}
      </div>

      <WeltFuss welt={welt} />
    </>
  );
}
