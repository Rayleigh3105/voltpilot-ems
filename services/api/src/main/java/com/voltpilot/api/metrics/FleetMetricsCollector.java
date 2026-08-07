package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.FleetMetrics.DataState;
import com.voltpilot.api.metrics.FleetMetrics.PlanState;
import com.voltpilot.api.metrics.FleetMetrics.SiteSnapshot;
import com.voltpilot.api.metrics.FleetMetrics.ZoneCoverage;
import com.voltpilot.api.repo.FleetMetricsRepository;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Hängt die Betriebs-Wahrheit aus {@link FleetMetricsRepository} als
 * Prometheus-Messwerte auf, damit ein Alarm darauf wachen kann. Die REGELN
 * stehen in {@link FleetMetrics}; hier steht nur die Verdrahtung.
 *
 * <p><b>Getaktet, nicht je Scrape.</b> Die Werte werden alle
 * {@code voltpilot.metrics.fleet.interval-ms} (Vorgabe 60 s) EINMAL gesammelt.
 * Ein Scrape darf keine flottenweite Aggregat-Abfrage auslösen: Prometheus
 * scrapt in kurzen Abständen und ein zweiter Scraper (oder ein
 * Neustart-Sturm) machte daraus sonst Last auf genau der Datenbank, deren
 * Gesundheit gemeldet werden soll. Für {@code for:}-Alarme über Minuten ist ein
 * bis zu 60 s alter Stand ohne Belang.
 *
 * <p><b>Das ALTER wird aber beim Scrape gerechnet, nicht beim Sammeln - und das
 * ist tragend.</b> Gespeichert wird der Zeitstempel, die Metrik liefert
 * {@code now - Zeitstempel} zum Abrufzeitpunkt. Stürbe der Sammler und lägen
 * feste Zahlen aus, dann fröre „Alter des Fahrplans" bei einem gesunden Wert
 * ein und JEDER Alarm verstummte still - dieselbe Klasse Fehler, gegen die
 * dieses ganze Stück gebaut ist. So wächst das Alter statt einzufrieren, ein
 * toter Sammler sieht also aus wie ein toter Optimierer: die sichere Richtung.
 * Zusätzlich meldet {@code voltpilot_metrics_collect_age_seconds}, wie lange der
 * letzte ERFOLGREICHE Durchlauf her ist.
 *
 * <p><b>Replica-Hinweis (bekannte Grenze).</b> Wie die MQTT-Listener und
 * {@code RolloutWatcher} ist dies ein Replica-Singleton-Muster in dem Sinne,
 * dass heute genau EINE api-Replica läuft. Bei mehreren Replicas sammelte jede
 * für sich und exponierte dieselben {@code site}-Serien unter eigenem
 * {@code pod}/{@code instance}-Label. Fachlich falsch wäre das nicht (jede liest
 * dieselben Zeilen), es vervielfachte aber die Serien und Alarm-Regeln müssten
 * aggregieren. Deshalb sind sie in
 * <a href="../../../../../../../../docs/k8s-readiness.md">docs/k8s-readiness.md</a>
 * als {@code max by (site, tenant)} bzw. {@code min by (zone)} dokumentiert -
 * damit sind sie von Tag eins replica-fest, ohne dass hier etwas geraten wird.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.fleet.enabled", havingValue = "true",
        matchIfMissing = true)
public class FleetMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(FleetMetricsCollector.class);

    /**
     * Die Metrik-NAMEN sind der Vertrag mit den Alarm-Regeln (gitops-Repo).
     * Sie werden wörtlich so registriert, wie sie im Scrape stehen sollen, und
     * OHNE Micrometer-{@code baseUnit}, damit die Namenskonvention nichts
     * anhängt. {@code FleetMetricsScrapeTest} liest sie aus dem ECHTEN
     * Scrape-Rumpf zurück - eine Umbenennung bricht dort, nicht erst in der
     * Alarm-Regel.
     */
    public static final String PLAN_AGE = "voltpilot_site_last_plan_age_seconds";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String TELEMETRY_AGE = "voltpilot_site_last_telemetry_age_seconds";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String PLAN_STATE = "voltpilot_site_plan_state";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String TELEMETRY_STATE = "voltpilot_site_telemetry_state";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String PRICED_SLOTS = "voltpilot_priced_slots_ahead";

    /**
     * Anzahl der Anlagen - der Nenner für Quoten.
     *
     * <p><b>⚠ Heisst {@code voltpilot_sites}, NICHT {@code voltpilot_sites_total}
     * - das ist gemessen, nicht gewählt.</b> Der Prometheus-Java-Client 1.x
     * (über den Boot 3.3 exponiert) entfernt das {@code _total}-Suffix beim
     * Aufbau des Snapshots bedingungslos, weil {@code _total} dort dem ZÄHLER
     * gehört: ein Zähler {@code foo_total} heisst intern {@code foo} und bekommt
     * das Suffix erst beim Schreiben zurück. Ein Gauge kann in diesem Stapel
     * also gar nicht auf {@code _total} enden - der ursprünglich vereinbarte
     * Name wäre still zu diesem hier geworden. Und der Client hat recht: die
     * Anzahl der Anlagen SINKT beim Offboarding, sie ist ein Gauge, und
     * {@code _total} an einem Gauge widerspricht der Prometheus-Konvention.
     * {@code FleetMetricsScrapeTest} nagelt den tatsächlichen Namen fest, damit
     * ihn niemand „zurückrepariert".
     */
    public static final String SITES = "voltpilot_sites";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String PLAN_LOOKBACK = "voltpilot_site_plan_lookback_seconds";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String COLLECT_AGE = "voltpilot_metrics_collect_age_seconds";

    /** Siehe {@link #PLAN_AGE}. */
    public static final String COLLECT_DURATION = "voltpilot_metrics_collect_duration_seconds";

    private final FleetMetricsRepository repo;
    private final Clock clock;

    private final MultiGauge planAge;
    private final MultiGauge telemetryAge;
    private final MultiGauge planState;
    private final MultiGauge telemetryState;
    private final MultiGauge pricedSlots;

    /**
     * Der zuletzt gesammelte Stand. <b>Muss als Feld gehalten werden:</b>
     * {@link MultiGauge} referenziert das Objekt einer Zeile SCHWACH (wie
     * {@code Gauge.builder(name, obj, fn)}), ein nur lokal gebautes
     * Schnappschuss-Objekt könnte also eingesammelt werden und die Metrik
     * lieferte danach {@code NaN}. Die Liste hier ist die starke Referenz.
     */
    private volatile List<SiteSnapshot> sites = List.of();

    /** Starke Referenz für die Zonen-Zeilen, siehe {@link #sites}. */
    private volatile List<ZoneCoverage> zones = List.of();

    private final AtomicReference<Instant> lastCollect = new AtomicReference<>();
    private volatile double lastDurationSeconds = Double.NaN;

    /** Ob der letzte Takt scheiterte - steuert das Melden bei ÄNDERUNG. */
    private volatile boolean failing;

    @Autowired
    public FleetMetricsCollector(FleetMetricsRepository repo, MeterRegistry registry) {
        this(repo, registry, Clock.systemUTC());
    }

    /**
     * Test-Naht mit steuerbarer Uhr. <b>Der Produktions-Konstruktor oben MUSS
     * {@code @Autowired} tragen</b> - bei mehreren Konstruktoren und keiner
     * Markierung kann Spring keinen wählen und sucht einen parameterlosen; genau
     * daran ist {@code BrokerAuthzReloader} schon einmal beim Start abgestürzt.
     */
    FleetMetricsCollector(FleetMetricsRepository repo, MeterRegistry registry, Clock clock) {
        this.repo = repo;
        this.clock = clock;

        this.planAge = MultiGauge.builder(PLAN_AGE)
                .description("Alter des juengsten Optimierer-Laufs; fehlt, wenn unbekannt"
                        + " - siehe voltpilot_site_plan_state")
                .register(registry);
        this.telemetryAge = MultiGauge.builder(TELEMETRY_AGE)
                .description("Alter der juengsten Mess-ANKUNFT (received_at); fehlt, wenn nie"
                        + " gemessen - siehe voltpilot_site_telemetry_state")
                .register(registry);
        this.planState = MultiGauge.builder(PLAN_STATE)
                .description("1 fuer den aktiven Zustand: known | older_than_window | never")
                .register(registry);
        this.telemetryState = MultiGauge.builder(TELEMETRY_STATE)
                .description("1 fuer den aktiven Zustand: known | never")
                .register(registry);
        this.pricedSlots = MultiGauge.builder(PRICED_SLOTS)
                .description("Luekenlos bepreiste Viertelstunden ab jetzt (Deckel 96);"
                        + " der Optimierer braucht 16")
                .register(registry);

        Gauge.builder(SITES, () -> sites.size())
                .description("Anlagen der Plattform - der Nenner fuer Quoten")
                .register(registry);
        Gauge.builder(PLAN_LOOKBACK, () -> FleetMetrics.PLAN_LOOKBACK.getSeconds())
                .description("Nachschaufenster von voltpilot_site_last_plan_age_seconds")
                .register(registry);
        Gauge.builder(COLLECT_AGE, this::collectAgeSeconds)
                .description("Sekunden seit dem letzten ERFOLGREICHEN Sammel-Lauf")
                .register(registry);
        Gauge.builder(COLLECT_DURATION, () -> lastDurationSeconds)
                .description("Dauer des letzten Sammel-Laufs")
                .register(registry);
    }

    /**
     * Ein Sammel-Lauf. Wirft NIE: ein Sammler, der an einem Durchlauf stirbt,
     * hört auf zu sammeln ({@code RolloutWatcher.tick}) - und hier wäre die
     * Folge, dass die Alarm-Grundlage still verschwindet. Ein fehlgeschlagener
     * Lauf lässt den letzten Stand stehen; dass er alt ist, sagen das
     * mitwachsende Alter und {@code voltpilot_metrics_collect_age_seconds}.
     */
    @Scheduled(fixedDelayString = "${voltpilot.metrics.fleet.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.fleet.initial-delay-ms:10000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("fleet metrics collection recovered");
            }
        } catch (Exception e) {
            // Bei JEDER AENDERUNG melden, nie je Takt - die Hausregel der
            // OTA-Sperre: eine Zeile pro Minute, stundenlang, ist Rauschen, in dem
            // der Hinweis untergeht, und das Aufhoeren erfaehrt man nie. Dass es
            // ueberhaupt noch klemmt, sagt ohnehin
            // voltpilot_metrics_collect_age_seconds - lueckenlos und maschinenlesbar.
            if (!failing) {
                failing = true;
                log.warn("fleet metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("fleet metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Sammelt und veröffentlicht einen Stand. Paket-sichtbar für die Tests. */
    void collect() {
        long startedNanos = System.nanoTime();
        Instant now = clock.instant();

        List<FleetMetricsRepository.SiteRow> siteRows = repo.sites();
        Map<java.util.UUID, Instant> lastPlans =
                repo.lastPlanPerSite(now.minus(FleetMetrics.PLAN_LOOKBACK));
        Set<java.util.UUID> everPlanned = repo.sitesThatEverPlanned();
        Map<java.util.UUID, Instant> lastTelemetry = repo.lastTelemetryPerSite();

        Instant firstSlot = FleetMetrics.floorToSlot(now);
        Map<String, List<Instant>> priced = repo.pricedSlotsPerZone(
                firstSlot, firstSlot.plus(FleetMetrics.SLOT.multipliedBy(FleetMetrics.HORIZON_SLOTS)));

        List<SiteSnapshot> collectedSites = new ArrayList<>(siteRows.size());
        // Die Zonen kommen aus der FLOTTE, nicht aus der Preistabelle. Nur so
        // bekommt eine Zone ohne einen einzigen Preis überhaupt eine Zeile - und
        // die 0 dieser Zeile IST der Vorfall. Käme die Menge aus den Preisen,
        // verschwände die Metrik genau dann, wenn sie gebraucht wird.
        Set<String> fleetZones = new LinkedHashSet<>();
        for (FleetMetricsRepository.SiteRow row : siteRows) {
            collectedSites.add(FleetMetrics.evaluate(
                    row.siteId(),
                    row.tenantId(),
                    lastPlans.get(row.siteId()),
                    everPlanned.contains(row.siteId()),
                    lastTelemetry.get(row.siteId())));
            if (row.biddingZone() != null && !row.biddingZone().isBlank()) {
                fleetZones.add(row.biddingZone());
            }
        }

        List<ZoneCoverage> collectedZones = new ArrayList<>(fleetZones.size());
        for (String zone : fleetZones) {
            collectedZones.add(new ZoneCoverage(zone, FleetMetrics.contiguousPricedSlots(
                    now, priced.getOrDefault(zone, List.of()))));
        }

        this.sites = collectedSites;
        this.zones = collectedZones;
        publish();

        this.lastDurationSeconds = (System.nanoTime() - startedNanos) / 1_000_000_000.0;
        this.lastCollect.set(now);
        log.debug("fleet metrics collected: {} sites, {} zones, {} ms",
                collectedSites.size(), collectedZones.size(),
                Math.round(lastDurationSeconds * 1000));
    }

    private void publish() {
        List<SiteSnapshot> current = this.sites;

        // Alter NUR fuer Anlagen, deren Alter wirklich bekannt ist - eine fehlende
        // Zeile ist die ehrliche Aussage, eine 0 waere eine erfundene.
        List<MultiGauge.Row<?>> planAges = new ArrayList<>();
        List<MultiGauge.Row<?>> telemetryAges = new ArrayList<>();
        // Die Enums existieren fuer JEDE Anlage, damit eine Regel "nie" von
        // "veraltet" unterscheiden kann, statt aus einer fehlenden Zeile zu raten.
        List<MultiGauge.Row<?>> planStates = new ArrayList<>();
        List<MultiGauge.Row<?>> telemetryStates = new ArrayList<>();

        for (SiteSnapshot s : current) {
            if (s.lastPlanAt() != null) {
                planAges.add(MultiGauge.Row.of(siteTags(s), s,
                        snap -> FleetMetrics.ageSeconds(snap.lastPlanAt(), clock.instant())));
            }
            if (s.lastTelemetryAt() != null) {
                telemetryAges.add(MultiGauge.Row.of(siteTags(s), s,
                        snap -> FleetMetrics.ageSeconds(snap.lastTelemetryAt(), clock.instant())));
            }
            for (PlanState state : PlanState.values()) {
                planStates.add(MultiGauge.Row.of(
                        siteTags(s).and("state", state.label()),
                        s.planState() == state ? 1 : 0));
            }
            for (DataState state : DataState.values()) {
                telemetryStates.add(MultiGauge.Row.of(
                        siteTags(s).and("state", state.label()),
                        s.telemetryState() == state ? 1 : 0));
            }
        }

        planAge.register(planAges, true);
        telemetryAge.register(telemetryAges, true);
        planState.register(planStates, true);
        telemetryState.register(telemetryStates, true);

        List<MultiGauge.Row<?>> zoneRows = new ArrayList<>();
        for (ZoneCoverage zone : this.zones) {
            zoneRows.add(MultiGauge.Row.of(Tags.of("zone", zone.biddingZone()), zone.slotsAhead()));
        }
        pricedSlots.register(zoneRows, true);
    }

    /**
     * Die Labels einer Anlage: INTERNE Kennungen, sonst nichts.
     *
     * <p>Bewusst KEIN Name, keine Adresse, kein Messwert. Der Endpunkt antwortet
     * unauthentifiziert, und was er ausgibt, fliesst über Prometheus und
     * Alertmanager bis in Telegram und E-Mail - also aus der Plattform heraus.
     * Ein Anlagen- oder Mandantenname wäre dort Kundenstammdaten (bei
     * Selbstregistrierung ist der Mandantenname der Personen- oder Firmenname des
     * Kunden). Die UUID benennt die Anlage eindeutig, und wer sie auflösen darf,
     * tut es im Portal unter {@code #/anlage/{site}} - der Klartext bleibt hinter
     * der Anmeldung.
     */
    private static Tags siteTags(SiteSnapshot snapshot) {
        return Tags.of(
                "site", snapshot.siteId().toString(),
                "tenant", snapshot.tenantId() == null ? "" : snapshot.tenantId().toString());
    }

    private double collectAgeSeconds() {
        Instant last = lastCollect.get();
        // Vor dem ersten Lauf gibt es kein Alter - NaN, nie eine 0, die
        // "gerade eben gesammelt" behaupten wuerde.
        return last == null ? Double.NaN : FleetMetrics.ageSeconds(last, clock.instant());
    }

    /** Der zuletzt veröffentlichte Stand. Paket-sichtbar für die Tests. */
    List<SiteSnapshot> snapshot() {
        return sites;
    }

    /** Die zuletzt veröffentlichte Preis-Abdeckung. Paket-sichtbar für die Tests. */
    List<ZoneCoverage> zoneSnapshot() {
        return zones;
    }

    /** Dauer des letzten Sammel-Laufs. Paket-sichtbar für die Kostenmessung im Test. */
    Duration lastDuration() {
        return Double.isNaN(lastDurationSeconds)
                ? Duration.ZERO
                : Duration.ofNanos((long) (lastDurationSeconds * 1_000_000_000.0));
    }
}
