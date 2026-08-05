import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import type { HistoryRange, ProtocolEvent, Site } from '../api';
import { eurAmount } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  delta,
  keineVergleichsDatenText,
  laufendHinweis,
  normalisiereModus,
  ueberlagerungAktiv,
  ueberlagerungLegende,
  vergleichsKopf,
  vergleichsName,
  wirksamerModus,
  type VergleichsModus,
} from '../historieVergleich';
import { mitVergleich, parseVergleichModus } from '../historieZeit';
import {
  DASH,
  erloesErgebnis,
  preisTreiber,
  type ErgebnisZeile,
} from '../erloesKomposition';
import {
  availableWelten,
  historieHash,
  weltSwitchCards,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import { useSiteEarnings, useVergleichsErloese } from '../useSiteEarnings';
import type { AnlageSurface } from '../surface';

import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { HistoryDayChart } from '../HistoryChart';
import {
  DeltaZeile,
  KartenKopf,
  PeriodeFehlgeschlagen,
  WeltFuss,
  WeltKopf,
  ZeitLeiste,
} from '../components/HistorieWelt';
import { ErloeseVerlaufChart } from '../components/ErloeseVerlaufChart';

import '../components/Historie.css';
import '../components/Erloese.css';

/**
 * **Welt B · „Erlöse"** (`#/anlage/{id}/erloese`) — die Geld-Welt der Historie
 * (Konzept `data/vp-historie-konzept-t4`, Captain-Struktur H1, Feature **F1**).
 *
 * **Der behobene Fehler war, dass der Tab „Erlöse" keine Erlöse enthielt:** er
 * zeigte zwei Zahlen — Stromkosten (eine KOSTEN-Größe) und die GEPLANTE
 * Speicher-Ersparnis — und für Woche/Monat/Jahr sonst nichts. Der gemessene
 * Erlös derselben Anlage existierte längst, nur eine Fläche weiter. Jetzt führt
 * die Welt mit ihm:
 *
 * 1. **Ergebnis** — die eine große Zahl (Einspeise-Erlös + Wert des
 *    Eigenverbrauchs − Stromkosten), die Zurechnung „davon durch die Steuerung"
 *    als Unterzeile (nie ein weiterer Summand) und das Δ zur Vorperiode.
 * 2. **Geld im Verlauf** — dieselben drei Teile über die Zeit, für JEDEN
 *    Zeitraum (bisher hing das Diagramm an `isDay`).
 * 3. **Was den Preis gemacht hat** — Ø Bezugspreis, erzielter Marktwert gegen
 *    den Monatsdurchschnitt, Marktprämie, Netzladen-Anteil.
 * 4. **Geplante Speicher-Ersparnis** — bleibt, aber mit eigenem Abzeichen
 *    „Geplant": eine Vorher-Rechnung steht nie unbeschriftet neben einer
 *    gemessenen Zahl (report §7).
 * 5. **Der Tag im Detail** — Speicher & Preis + Tagesprotokoll, wie gehabt.
 *
 * Zwei Abrufe, beide über ihren Cache: die Geld-Zahlen aus dem anlagen-scharfen
 * `GET /sites/{id}/earnings` (P3) und — nur für die geplante Ersparnis und den
 * Tag — die bestehende Historie-Antwort.
 */

const EVENT_ICONS: Record<ProtocolEvent['type'], { icon: IconName; label: string }> = {
  'batterie-laden': { icon: 'arrow-up', label: 'Laden' },
  'batterie-entladen': { icon: 'arrow-down', label: 'Entladen' },
  'pv-spitze': { icon: 'sun', label: 'PV' },
  'preis-tief': { icon: 'trending-down', label: 'Preis-Tief' },
  'preis-hoch': { icon: 'trending-up', label: 'Preis-Hoch' },
};

/**
 * Eine Zeile der Ergebnis-Komposition (Punkt · Name · Operator · Betrag). Das
 * Perioden-Etikett steht NUR, wenn der Stapel wirklich mehrere Perioden mischt
 * — sonst sagt es die Überschrift der Karte schon.
 */
function KompositionsZeile({ row, zeigePeriode }: { row: ErgebnisZeile; zeigePeriode: boolean }) {
  return (
    <li className={row.eur == null ? 'vp-ekomp-row vp-ekomp-off' : 'vp-ekomp-row'}>
      <span className="vp-ekomp-dot" style={{ background: row.hue }} aria-hidden="true" />
      <span className="vp-ekomp-name">
        {row.label}
        {zeigePeriode && <span className="vp-ekomp-period">{row.periodLabel}</span>}
      </span>
      <span className="vp-ekomp-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(row.barFraction * 100)}%`, background: row.hue }} />
      </span>
      <span className="vp-ekomp-value">
        {row.eur != null && (
          <span className="vp-ekomp-sign" aria-hidden="true">
            {row.vorzeichen === 'minus' ? '−' : '+'}
          </span>
        )}
        <span className="vp-ekomp-amount">{row.valueText}</span>
      </span>
      {row.note && <span className="vp-ekomp-note">{row.note}</span>}
    </li>
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

  // F8: der Vergleichs-Zustand reist in der Adresse (`v=`) - derselbe Parameter
  // wie in der Messwerte-Welt, also nimmt der Welt-Wechsel ihn mit.
  const [modusWahl, setModusWahl] = useState<VergleichsModus>(() =>
    parseVergleichModus(window.location.hash),
  );

  const at = isoDate(anchor);
  // Das Geld dieser Anlage - ein Abruf, eine Anlage, ein Zeitraum (P3).
  const { money, loading, stale, err, retry } = useSiteEarnings(site.id, range, at);
  // Die Historie-Antwort trägt hier nur noch die GEPLANTE Ersparnis und den Tag
  // (Speicher & Preis, Tagesprotokoll) - und die Datenlage der Zeit-Leiste.
  const { history } = useHistoryPeriod(site.id, range, at);
  // F3: der zweite Abruf mit verschobenem Anker - erst, wenn der gezeigte
  // Zeitraum überhaupt Zahlen trägt.
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  const vorher = useVergleichsErloese(
    site.id,
    range,
    anchor,
    !stale && money?.nettoErgebnisEur != null,
    wirksamerModus(modus),
  );
  // Ehrlich statt leer: eine Vergleichsperiode ohne bewertete Viertelstunden
  // wird GESAGT, nicht als Null-Linie gezeichnet.
  const vergleichSerie =
    ueberlagerungAktiv(modus) && (vorher?.series.length ?? 0) > 0 ? vorher!.series : null;
  const vergleichHinweis =
    ueberlagerungAktiv(modus) && vorher != null && vorher.series.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const setModus = useCallback(
    (m: VergleichsModus) => {
      setModusWahl(m);
      window.history.replaceState(
        null,
        '',
        mitVergleich(historieHash(site.id, 'erloese', range, at), m),
      );
    },
    [site.id, range, at],
  );

  // Zurück/Vorwärts oder ein Sprung mit Zeitraum: die Periode neu übernehmen.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      setModusWahl(parseVergleichModus(window.location.hash));
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const welt = WELTEN.erloese;
  const available = availableWelten(surface);
  const label = periodLabel(anchor, range);
  const now = new Date();
  const isDay = range === 'day';

  const ergebnis = erloesErgebnis({ money, periodLabel: label });
  const preise = preisTreiber({
    money,
    netzladenErlaubt: site.netzladenErlaubt,
    siteId: site.id,
  });
  const vergleichName = vergleichsName(anchor, range, modus);
  const kopfVergleich = vorher ? (
    <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range, modus)}</span>
  ) : undefined;
  const laufend = vorher ? laufendHinweis(anchor, range, now, modus) : null;
  // Mehr Ergebnis ist eindeutig besser; die GEPLANTE Ersparnis ist eine
  // Plan-Aussage und wird deshalb nicht als Erfolg gewertet.
  const nettoDelta = delta(
    money?.nettoErgebnisEur,
    vorher?.nettoErgebnisEur,
    true,
    vergleichName,
  );

  return (
    <>
      <WeltKopf
        welt={welt}
        cards={weltSwitchCards('erloese', available)}
        hrefFor={(c) => mitVergleich(historieHash(site.id, c.welt.id, range, at), modus)}
        onOpen={(c) => onOpenWelt(c.welt.id)}
      />
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        coverage={history?.coverage}
        stale={stale}
        vergleich={modus}
        onVergleich={setModus}
        vergleichHinweis={vergleichHinweis}
      />

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {err && !money ? (
          <ErrorState
            message={`Die Erlöse konnten nicht geladen werden (${err}).`}
            onRetry={retry}
          />
        ) : !money ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton />
            </Card>
          ) : null
        ) : (
          <>
            {err && stale && (
              <PeriodeFehlgeschlagen periode={label} onRetry={retry} />
            )}

            {/* Karte 1 - das Ergebnis des Zeitraums samt seiner Herkunft. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="euro"
                  category="primary"
                  titel={ergebnis.titel}
                  art="bewertet"
                  extra={kopfVergleich}
                />
                {ergebnis.nettoEur == null ? (
                  <EmptyState
                    icon="euro"
                    category="dynamic"
                    title="Noch kein Ergebnis für diesen Zeitraum"
                    description={
                      ergebnis.leerText ??
                      'Sobald Messwerte und Preise vorliegen, steht hier, was Ihre Anlage eingebracht hat.'
                    }
                  />
                ) : (
                  <>
                    <p
                      className={`vp-erg-netto vp-erg-${ergebnis.richtung ?? 'ertrag'}`}
                      title={ergebnis.nettoSatz}
                    >
                      {ergebnis.nettoText}
                    </p>
                    <p className="vp-erg-satz">{ergebnis.nettoSatz}</p>
                    {ergebnis.steering && (
                      <p className="vp-erg-steering" title={ergebnis.steeringTitel ?? undefined}>
                        <Icon name="zap" size={14} aria-hidden="true" />
                        {ergebnis.steering}
                      </p>
                    )}
                    {nettoDelta && (
                      <p className="vp-kpi-delta">
                        <DeltaZeile delta={nettoDelta} />
                      </p>
                    )}
                    {laufend && <p className="vp-note vp-note-laufend">{laufend}</p>}
                    {/* Die Herkunft der großen Zahl - nur, wenn es eine gibt;
                        eine Liste aus lauter „—" erklärt nichts. */}
                    <ul className="vp-ekomp" aria-label="Woraus sich das Ergebnis zusammensetzt">
                      {ergebnis.rows.map((row) => (
                        <KompositionsZeile
                          key={row.id}
                          row={row}
                          zeigePeriode={ergebnis.mehrerePerioden}
                        />
                      ))}
                    </ul>
                    {ergebnis.periodNote && <p className="vp-note">{ergebnis.periodNote}</p>}
                    {ergebnis.footnote && <p className="vp-note">{ergebnis.footnote}</p>}
                  </>
                )}
              </Card>
            </section>

            {/* Karte 2 - dieselben Teile über die Zeit, für JEDEN Zeitraum. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="trending-up"
                  category="dynamic"
                  titel={`Geld im Verlauf · ${label}`}
                  art="bewertet"
                />
                <ErloeseVerlaufChart
                  series={money.series}
                  range={range}
                  vergleich={vergleichSerie}
                  legende={ueberlagerungLegende(anchor, range, modus)}
                />
              </Card>
            </section>

            {/* Karte 3 - die Preise hinter dem Ergebnis. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="euro"
                  category="industry"
                  titel="Was den Preis gemacht hat"
                  art="bewertet"
                />
                <ul className="vp-preistreiber">
                  {preise.map((z) => (
                    <li key={z.id} className={z.vorhanden ? undefined : 'vp-pt-off'}>
                      <span className="vp-pt-wert">{z.wert}</span>
                      <span className="vp-pt-label">{z.label}</span>
                      {z.note && <span className="vp-pt-note">{z.note}</span>}
                      {z.hinweise.map((h) => (
                        <span key={h} className="vp-pt-hint">
                          {h}
                        </span>
                      ))}
                      {z.href && (
                        <a className="vp-pt-link" href={z.href}>
                          Zu den Einstellungen
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>

            {/* Geplant: die Vorher-Rechnung des Optimierers - eigene Karte,
                eigenes Abzeichen, damit sie nie als gemessene Ersparnis gilt. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="battery-charging"
                  category="battery"
                  titel={`Geplante Speicher-Ersparnis · ${label}`}
                  art="geplant"
                />
                <p className="vp-erg-plan">
                  {history?.totals.batterySavingsPlannedEur == null
                    ? DASH
                    : eurAmount(history.totals.batterySavingsPlannedEur)}
                </p>
                <p className="vp-note">
                  {history?.totals.batterySavingsPlannedEur == null
                    ? 'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die geplante Ersparnis erscheint, sobald geplant wird.'
                    : 'Vorab geplant, nicht gemessen: der gemessene Beitrag der Steuerung steht oben im Ergebnis. Beide dürfen deutlich voneinander abweichen.'}
                </p>
              </Card>
            </section>

            {/* Tagesansicht: der Nachweis - was der Speicher wirklich getan hat. */}
            {isDay && history && (
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
            {isDay && history && (
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
        )}
      </div>

      <WeltFuss welt={welt} />
    </>
  );
}
