package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.FleetMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * <b>Der Metrik-Vertrag, gelesen aus dem ECHTEN Scrape-Rumpf.</b>
 *
 * <p>Die Alarm-Regeln leben in einem anderen Repository und kennen von hier nur
 * Zeichenketten. Ein Test gegen die Meter-Namen im Code bewiese deshalb das
 * Falsche: Micrometer und der Prometheus-Client formen Namen um (Einheiten-
 * Suffixe, {@code _total} bei Zählern, Zeichensatz), und was zählt, ist einzig,
 * was am Draht steht. Deshalb wird hier die Ausgabe von
 * {@code PrometheusMeterRegistry.scrape()} Zeile für Zeile geprüft - eine
 * Umbenennung bricht hier, nicht erst als stiller Alarm-Ausfall in Produktion.
 *
 * <p>Ohne Spring und ohne Docker: die Datenbank ist eine Attrappe, denn geprüft
 * werden Namen, Labels und die Ehrlichkeitsregeln - nicht SQL.
 */
class FleetMetricsScrapeTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID GEPLANT = UUID.fromString("11111111-0000-0000-0000-000000000001");
    private static final UUID VERALTET = UUID.fromString("22222222-0000-0000-0000-000000000002");
    private static final UUID FRISCH = UUID.fromString("33333333-0000-0000-0000-000000000003");

    private static final Instant NOW = Instant.parse("2026-08-07T09:07:30Z");

    /**
     * Eine Attrappe der Datenbank-Schicht - {@link FleetMetricsRepository} hat
     * nur nicht-finale öffentliche Methoden, lässt sich also schlicht überschreiben.
     */
    private static final class StubRepo extends FleetMetricsRepository {
        private final List<SiteRow> sites = new ArrayList<>();
        private final Map<UUID, Instant> plans = new LinkedHashMap<>();
        private final Set<UUID> everPlanned = new java.util.HashSet<>();
        private final Map<UUID, Instant> telemetry = new LinkedHashMap<>();
        private final Map<String, List<Instant>> priced = new LinkedHashMap<>();
        /** Simuliert eine unerreichbare Datenbank. */
        private boolean explode;

        StubRepo() {
            super(null);
        }

        @Override
        public List<SiteRow> sites() {
            if (explode) {
                throw new IllegalStateException("Failed to obtain JDBC Connection");
            }
            return sites;
        }

        @Override
        public Map<UUID, Instant> lastPlanPerSite(Instant from) {
            return plans;
        }

        @Override
        public Set<UUID> sitesThatEverPlanned() {
            return everPlanned;
        }

        @Override
        public Map<UUID, Instant> lastTelemetryPerSite() {
            return telemetry;
        }

        @Override
        public Map<String, List<Instant>> pricedSlotsPerZone(Instant from, Instant to) {
            return priced;
        }
    }

    /** Die drei Anlagen-Lagen, die es zu unterscheiden gilt, plus zwei Zonen. */
    private static StubRepo fleet() {
        StubRepo repo = new StubRepo();
        repo.sites.add(new FleetMetricsRepository.SiteRow(GEPLANT, TENANT, "DE-LU"));
        repo.sites.add(new FleetMetricsRepository.SiteRow(VERALTET, TENANT, "DE-LU"));
        repo.sites.add(new FleetMetricsRepository.SiteRow(FRISCH, TENANT, "AT"));

        // GEPLANT: Lauf vor 30 Minuten, Messung vor 2 Minuten.
        repo.plans.put(GEPLANT, NOW.minus(Duration.ofMinutes(30)));
        repo.everPlanned.add(GEPLANT);
        repo.telemetry.put(GEPLANT, NOW.minus(Duration.ofMinutes(2)));

        // VERALTET: hatte Fahrplaene, aber keinen im Fenster; sendet noch.
        repo.everPlanned.add(VERALTET);
        repo.telemetry.put(VERALTET, NOW.minus(Duration.ofHours(9)));

        // FRISCH: nie ein Fahrplan, nie eine Messung.

        // DE-LU luekenlos bis zum Horizont, AT hat gar keine Preise (der Vorfall).
        List<Instant> deLu = new ArrayList<>();
        Instant slot = FleetMetrics.floorToSlot(NOW);
        for (int i = 0; i < FleetMetrics.HORIZON_SLOTS; i++) {
            deLu.add(slot.plus(FleetMetrics.SLOT.multipliedBy(i)));
        }
        repo.priced.put("DE-LU", deLu);
        return repo;
    }

    private static String scrapeOf(StubRepo repo) {
        PrometheusMeterRegistry registry =
                new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        FleetMetricsCollector collector = new FleetMetricsCollector(
                repo, registry, Clock.fixed(NOW, ZoneOffset.UTC));
        collector.collect();
        return registry.scrape();
    }

    /** Die genaue Zeile eines Messwerts, oder {@code null}. */
    private static String line(String scrape, String prefix) {
        return scrape.lines()
                .filter(l -> l.startsWith(prefix))
                .findFirst()
                .orElse(null);
    }

    @Test
    void theContractNamesAppearVerbatimInTheScrape() {
        String scrape = scrapeOf(fleet());

        // Die vier Pflicht-Metriken des Auftrags, woertlich.
        assertThat(scrape)
                .contains("voltpilot_site_last_plan_age_seconds{")
                .contains("voltpilot_site_last_telemetry_age_seconds{")
                .contains("voltpilot_priced_slots_ahead{")
                .contains("voltpilot_sites ");

        // ... und die Enums, die "nie" von "veraltet" trennen.
        assertThat(scrape)
                .contains("voltpilot_site_plan_state{")
                .contains("voltpilot_site_telemetry_state{");
    }

    @Test
    void noSuffixIsAppendedToAnyContractName() {
        String scrape = scrapeOf(fleet());

        // Der eigentliche Fallstrick: Micrometer haengt bei gesetzter baseUnit die
        // Einheit an, und der Prometheus-Client normalisiert _total-Suffixe. Beide
        // wuerden den Vertrag brechen, ohne dass irgendetwas rot wird. Also: es
        // darf KEINE voltpilot_-Zeile geben, deren Name nicht genau einer der
        // vereinbarten ist.
        Set<String> vereinbart = Set.of(
                FleetMetricsCollector.PLAN_AGE,
                FleetMetricsCollector.TELEMETRY_AGE,
                FleetMetricsCollector.PLAN_STATE,
                FleetMetricsCollector.TELEMETRY_STATE,
                FleetMetricsCollector.PRICED_SLOTS,
                FleetMetricsCollector.SITES,
                FleetMetricsCollector.PLAN_LOOKBACK,
                FleetMetricsCollector.COLLECT_AGE,
                FleetMetricsCollector.COLLECT_DURATION);

        List<String> gefunden = scrape.lines()
                .filter(l -> l.startsWith("voltpilot_"))
                .map(l -> l.substring(0, indexOfNameEnd(l)))
                .distinct()
                .toList();

        assertThat(gefunden).isNotEmpty().allSatisfy(name ->
                assertThat(vereinbart).as("unerwarteter Metrikname im Scrape: %s", name)
                        .contains(name));
        // Und andersherum: jede vereinbarte Metrik ist auch wirklich da.
        assertThat(gefunden).containsAll(vereinbart);
    }

    private static int indexOfNameEnd(String line) {
        int brace = line.indexOf('{');
        int space = line.indexOf(' ');
        if (brace < 0) {
            return space < 0 ? line.length() : space;
        }
        return space < 0 ? brace : Math.min(brace, space);
    }

    @Test
    void aSiteThatNeverHadAPlanExportsNoAgeAtAllButSaysSoExplicitly() {
        String scrape = scrapeOf(fleet());

        // Kein erfundenes "Alter 0" - die Zeitreihe fehlt fuer diese Anlage.
        assertThat(scrape).doesNotContain(
                "voltpilot_site_last_plan_age_seconds{site=\"" + FRISCH + "\"");
        assertThat(scrape).doesNotContain(
                "voltpilot_site_last_telemetry_age_seconds{site=\"" + FRISCH + "\"");

        // Stattdessen sagt das Enum ausdruecklich "nie" - darauf kann eine Regel bauen.
        assertThat(line(scrape, "voltpilot_site_plan_state{site=\"" + FRISCH
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_site_plan_state{site=\"" + FRISCH
                + "\",state=\"known\",tenant=\"" + TENANT + "\"}")).endsWith(" 0.0");
        assertThat(line(scrape, "voltpilot_site_telemetry_state{site=\"" + FRISCH
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
    }

    @Test
    void aPlanOlderThanTheWindowIsAnAlarmNotAnUnknown() {
        String scrape = scrapeOf(fleet());

        // Auch hier kein erfundenes Alter - das Fenster kann es nicht mehr beziffern.
        assertThat(scrape).doesNotContain(
                "voltpilot_site_last_plan_age_seconds{site=\"" + VERALTET + "\"");
        // Aber es ist ausdruecklich NICHT "nie": die Anlage hatte schon Plaene.
        assertThat(line(scrape, "voltpilot_site_plan_state{site=\"" + VERALTET
                + "\",state=\"older_than_window\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_site_plan_state{site=\"" + VERALTET
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 0.0");

        // Die Telemetrie derselben Anlage ist dagegen bekannt und alt - 9 h.
        assertThat(line(scrape, "voltpilot_site_last_telemetry_age_seconds{site=\"" + VERALTET
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 32400.0");
    }

    @Test
    void aKnownAgeIsTheRealAgeInSeconds() {
        String scrape = scrapeOf(fleet());

        assertThat(line(scrape, "voltpilot_site_last_plan_age_seconds{site=\"" + GEPLANT
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 1800.0");
        assertThat(line(scrape, "voltpilot_site_last_telemetry_age_seconds{site=\"" + GEPLANT
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 120.0");
        assertThat(line(scrape, "voltpilot_site_plan_state{site=\"" + GEPLANT
                + "\",state=\"known\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
    }

    @Test
    void aZoneWithoutASinglePriceStillGetsItsRowWithZero() {
        String scrape = scrapeOf(fleet());

        // DAS ist der Vorfall vom 06./07.08.2026. Kaeme die Zonen-Menge aus der
        // Preistabelle statt aus der Flotte, verschwaende diese Zeile genau dann,
        // wenn sie gebraucht wird - und die Alarm-Regel "< 16" feuerte nie.
        assertThat(line(scrape, "voltpilot_priced_slots_ahead{zone=\"AT\"}")).endsWith(" 0.0");
        assertThat(line(scrape, "voltpilot_priced_slots_ahead{zone=\"DE-LU\"}")).endsWith(" 96.0");
    }

    @Test
    void theLabelsCarryInternalIdentifiersAndNothingElse() {
        String scrape = scrapeOf(fleet());

        List<String> voltpilotLines = scrape.lines()
                .filter(l -> l.startsWith("voltpilot_"))
                .toList();

        // Der Endpunkt antwortet unauthentifiziert und seine Ausgabe reist bis in
        // Telegram und E-Mail. Es darf deshalb NUR die drei vereinbarten Labels
        // geben - kein site_name, kein Mandantenname, keine Adresse, kein Messwert.
        assertThat(voltpilotLines).isNotEmpty();
        for (String l : voltpilotLines) {
            int open = l.indexOf('{');
            if (open < 0) {
                continue;
            }
            String labels = l.substring(open + 1, l.indexOf('}'));
            for (String pair : labels.split(",")) {
                assertThat(pair.substring(0, pair.indexOf('=')))
                        .as("Label in %s", l)
                        .isIn("site", "tenant", "zone", "state");
            }
        }
    }

    @Test
    void theAgeKeepsGrowingWhenTheCollectorStops() {
        // Ein Sammler, der stirbt, darf die Alarm-Grundlage nicht einfrieren:
        // laege eine feste Zahl aus, bliebe "Alter des Fahrplans" auf einem
        // gesunden Wert stehen und JEDER Alarm verstummte still. Das Alter wird
        // deshalb beim SCRAPE gerechnet - hier belegt an einer Uhr, die
        // weiterlaeuft, waehrend collect() nicht mehr aufgerufen wird.
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        FleetMetricsCollector collector = new FleetMetricsCollector(fleet(), registry, clock);
        collector.collect();

        assertThat(line(registry.scrape(), "voltpilot_site_last_plan_age_seconds{site=\"" + GEPLANT
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 1800.0");

        clock.advance(Duration.ofHours(3));

        assertThat(line(registry.scrape(), "voltpilot_site_last_plan_age_seconds{site=\"" + GEPLANT
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 12600.0");
        // ... und der Sammler-Wachhund sagt selbst, dass er stehengeblieben ist.
        assertThat(line(registry.scrape(), "voltpilot_metrics_collect_age_seconds"))
                .endsWith(" 10800.0");
    }

    @Test
    void aDisappearedSiteLosesItsSeriesInsteadOfLingering() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubRepo repo = fleet();
        FleetMetricsCollector collector = new FleetMetricsCollector(repo, registry, clock);
        collector.collect();
        assertThat(registry.scrape()).contains("site=\"" + GEPLANT + "\"");

        // Anlage offboarded: ihre Serien muessen verschwinden, sonst alarmierte
        // eine Regel spaeter auf einer Anlage, die es nicht mehr gibt.
        repo.sites.removeIf(s -> s.siteId().equals(GEPLANT));
        repo.plans.remove(GEPLANT);
        repo.telemetry.remove(GEPLANT);
        collector.collect();

        String scrape = registry.scrape();
        assertThat(scrape).doesNotContain("site=\"" + GEPLANT + "\"");
        assertThat(line(scrape, "voltpilot_sites ")).endsWith(" 2.0");
    }

    @Test
    void aRepeatedCollectRefreshesTheValueInsteadOfKeepingTheFirstOne() {
        // MultiGauge.register(rows) ohne overwrite behaelt die ZUERST registrierte
        // Zeile - die Werte froeren nach dem ersten Lauf ein. Dieser Test faellt,
        // wenn jemand das `true` entfernt.
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubRepo repo = fleet();
        FleetMetricsCollector collector = new FleetMetricsCollector(repo, registry, clock);
        collector.collect();
        assertThat(line(registry.scrape(), "voltpilot_priced_slots_ahead{zone=\"AT\"}"))
                .endsWith(" 0.0");

        List<Instant> at = new ArrayList<>();
        Instant slot = FleetMetrics.floorToSlot(NOW);
        for (int i = 0; i < 20; i++) {
            at.add(slot.plus(FleetMetrics.SLOT.multipliedBy(i)));
        }
        repo.priced.put("AT", at);
        collector.collect();

        assertThat(line(registry.scrape(), "voltpilot_priced_slots_ahead{zone=\"AT\"}"))
                .endsWith(" 20.0");
    }

    @Test
    void aFailingTickNeverThrowsAndLeavesTheLastStandStanding() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubRepo repo = fleet();
        FleetMetricsCollector collector = new FleetMetricsCollector(repo, registry, clock);
        collector.tick();
        assertThat(line(registry.scrape(), "voltpilot_sites ")).endsWith(" 3.0");

        // Ein Sammler, der an einem Durchlauf stirbt, hoert auf zu sammeln - und
        // hier waere die Folge, dass die Alarm-Grundlage still verschwindet.
        repo.explode = true;
        clock.advance(Duration.ofMinutes(1));
        collector.tick();
        collector.tick();

        // Der letzte Stand bleibt stehen ...
        String scrape = registry.scrape();
        assertThat(line(scrape, "voltpilot_sites ")).endsWith(" 3.0");
        // ... und dass er alt ist, sagt der Waechter ueber dem Waechter.
        assertThat(line(scrape, "voltpilot_metrics_collect_age_seconds")).endsWith(" 60.0");
    }

    @Test
    void theLookbackWindowIsExposedSoARuleNeedNotHardcodeIt() {
        assertThat(line(scrapeOf(fleet()), "voltpilot_site_plan_lookback_seconds"))
                .endsWith(" 604800.0");
    }

    /** Eine Uhr, die man vorstellen kann. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
