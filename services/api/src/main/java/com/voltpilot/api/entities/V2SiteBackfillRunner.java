package com.voltpilot.api.entities;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The automatic v1 -> v2 entity migration (MIG report §6): on api boot every
 * site that has never been backfilled is composed into the v2 pilot entity
 * model through the EXISTING {@link EntityRegistryService#bootstrapIfEligible}
 * - so after a deploy each existing plant renders the complete new face
 * (PV + Speicher + Haus + Netz) with its real values, with no operator step.
 *
 * <p><b>Why not a Flyway data migration.</b> The composition rules live in Java
 * and evolve (this very change adds {@code house-load}); an applied Flyway
 * migration is immutable + checksum-validated, and SQL would be a SECOND
 * composition truth that drifts from the admin bootstrap and the E13a cutover.
 * The registry push + revision recording also need the MQTT publisher and the
 * {@link TenantContext}, which Flyway has neither of.
 *
 * <p><b>The four guards</b> (the captain's properties):
 * <ul>
 *   <li><b>automatic</b> - runs on {@link ApplicationReadyEvent} AND on the
 *       {@link #reconcile()} tick; no flag flip is required.
 *       {@code voltpilot.entities.backfill.enabled=false} exists only as an ops
 *       kill-switch (it stops both).</li>
 *   <li><b>idempotent</b> - the bootstrap itself refreshes in place, and a site
 *       that already carries entity rows composes nothing.</li>
 *   <li><b>guarded</b> - a site with no unambiguous gateway device is SKIPPED
 *       and deliberately NOT marked, so it is picked up by a later tick once a
 *       device is claimed (MIG §7: composing entities for a device-less plant
 *       would replace its honest onboarding guide with an empty Energiefluss).</li>
 *   <li><b>reversible, and the rollback STICKS</b> - the marker
 *       {@code site.v2_backfilled_at} (migration V20260722000000) is stamped on
 *       success and the runner only ever looks at NULL rows, so deleting a
 *       site's entities is not silently re-migrated on the next restart.
 *       Re-arm one site by clearing its marker.</li>
 * </ul>
 *
 * <p><b>Safety envelope.</b> The run writes ONLY {@code measurement_point}
 * (entity_type/capabilities/guard_config plus the two synthesized measure-only
 * rows), {@code entity_registry_state} and the marker column. It never touches
 * {@code asset}, {@code telemetry} or {@code device}; the composed grid-meter
 * and house-load carry no {@code actuate} and {@code control = false}, so
 * nothing it creates can reach a device.
 *
 * <p>Enumerating sites is cross-tenant, so it uses the BYPASSRLS
 * {@code adminJdbcTemplate} (the {@code TenantRepository} pattern) - but every
 * WRITE goes through the RLS-scoped service with the site's tenant bound in the
 * {@link TenantContext}, exactly like an admin using the X-Tenant-Id switcher.
 * A failure on one site is logged and never aborts the run or the boot.
 */
@Component
public class V2SiteBackfillRunner {

    private static final Logger log = LoggerFactory.getLogger(V2SiteBackfillRunner.class);

    /** One site to consider: its id and the tenant whose context the write needs. */
    record Candidate(UUID siteId, UUID tenantId, String name) {}

    /** What one run did (for logging + tests). */
    public record RunSummary(int considered, int migrated, int alreadyV2, int skippedNoGateway,
            int failed) {}

    private final JdbcTemplate adminJdbc;
    private final EntityRegistryService entities;
    private final EntityRegistryRepository repo;
    private final Clock clock;
    private final boolean enabled;
    private final boolean reconcileEnabled;

    /**
     * The {@code @Autowired} is LOAD-BEARING (the BrokerAuthzReloader footgun):
     * with the package-private test-seam constructor below and no annotation,
     * Spring cannot pick an injection constructor and the api context
     * crash-loops with "No default constructor found".
     */
    @org.springframework.beans.factory.annotation.Autowired
    public V2SiteBackfillRunner(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            EntityRegistryService entities, EntityRegistryRepository repo,
            @Value("${voltpilot.entities.backfill.enabled:true}") boolean enabled,
            @Value("${voltpilot.entities.backfill.reconcile-enabled:true}")
            boolean reconcileEnabled) {
        this(adminJdbc, entities, repo, enabled, reconcileEnabled, Clock.systemUTC());
    }

    V2SiteBackfillRunner(JdbcTemplate adminJdbc, EntityRegistryService entities,
            EntityRegistryRepository repo, boolean enabled, boolean reconcileEnabled,
            Clock clock) {
        this.adminJdbc = adminJdbc;
        this.entities = entities;
        this.repo = repo;
        this.enabled = enabled;
        this.reconcileEnabled = reconcileEnabled;
        this.clock = clock;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        if (!enabled) {
            log.info("v2 entity backfill disabled (voltpilot.entities.backfill.enabled=false)");
            return;
        }
        runQuietly("boot");
    }

    /**
     * <b>Der getaktete Abgleich - die Selbstheilung für BESTANDSanlagen.</b>
     * Bis hierher lief die Komposition ausschliesslich beim api-Start: eine
     * Anlage, die danach entstand oder ihr Gerät danach beanspruchte, wartete
     * auf den nächsten Deploy - im Live-Befund „Mienbach" (10.08.2026) auf
     * unbestimmte Zeit, während das Portal „Sobald Ihr Gerät sich meldet …"
     * versprach. Derselbe Lauf, dieselben Wächter, nur zusätzlich getaktet:
     * damit heilt sich eine Bestandsanlage OHNE Deploy, ohne Re-Claim und ohne
     * einen einzigen Klick - weder vom Kunden noch vom Admin.
     *
     * <p>Er ist billig genug für diese Kadenz: die Kandidatenabfrage ist ein
     * Index-loser, aber winziger Scan über {@code site} nach NULL-Markern, und
     * jede fertige Anlage wird beim ersten Treffer gestempelt und danach nie
     * wieder betrachtet. Übrig bleiben dauerhaft nur die Anlagen ohne
     * eindeutiges Gateway - genau die, die noch auf ihr Gerät warten.
     *
     * <p><b>Replica-Singleton wie die MQTT-Zuhörer</b> (heute 1 api-Replica):
     * jeder Schritt ist idempotent, bei mehreren Replicas gäbe es höchstens
     * doppelte Log-Zeilen.
     */
    @Scheduled(fixedDelayString = "${voltpilot.entities.backfill.interval-ms:300000}",
            initialDelayString = "${voltpilot.entities.backfill.interval-ms:300000}")
    public void reconcile() {
        // BEIDE Schalter, und das ist kein Gürtel-und-Hosenträger: Springs
        // @EnableScheduling ist GLOBAL - sobald irgendeine andere Konfiguration
        // (OTA, Metriken) es einschaltet, wäre diese Methode auch dann getaktet,
        // wenn EntitiesSchedulingConfig gar nicht existiert. Der Takt hängt
        // deshalb zusätzlich am eigenen Feld.
        if (!enabled || !reconcileEnabled) {
            return;
        }
        runQuietly("reconcile");
    }

    private void runQuietly(String trigger) {
        try {
            RunSummary summary = run();
            if (summary.migrated() > 0 || summary.failed() > 0 || summary.considered() > 0) {
                log.info("v2 entity backfill ({}): {} site(s) considered, {} migrated, "
                        + "{} already v2, {} skipped (no gateway device), {} failed",
                        trigger, summary.considered(), summary.migrated(), summary.alreadyV2(),
                        summary.skippedNoGateway(), summary.failed());
            }
        } catch (RuntimeException e) {
            // A backfill must never keep the api from serving - nor kill the
            // scheduler thread, which would silently end the self-healing.
            log.error("v2 entity backfill run ({}) failed, sites stay on v1: {}", trigger,
                    e.toString(), e);
        }
    }

    /** Backfill every un-marked site; returns what happened. Never throws per site. */
    public RunSummary run() {
        List<Candidate> candidates = pending();
        int migrated = 0;
        int already = 0;
        int skipped = 0;
        int failed = 0;
        for (Candidate c : candidates) {
            try {
                TenantContext.set(c.tenantId());
                EntityRegistryService.BackfillOutcome outcome =
                        entities.bootstrapIfEligible(c.siteId());
                switch (outcome) {
                    case MIGRATED -> {
                        repo.markV2Backfilled(c.siteId(), clock.instant());
                        migrated++;
                        log.info("v2 entity backfill: composed site {} (\"{}\")", c.siteId(),
                                c.name());
                    }
                    case ALREADY_V2 -> {
                        // Marked too: the site IS on v2, and marking keeps a
                        // later deliberate rollback from being re-migrated.
                        repo.markV2Backfilled(c.siteId(), clock.instant());
                        already++;
                    }
                    case SKIPPED_NO_GATEWAY -> {
                        // NON-marking on purpose: retry on a later boot (§7).
                        skipped++;
                        log.info("v2 entity backfill: site {} (\"{}\") skipped - no claimed "
                                + "gateway device yet; it keeps its v1 face and is retried "
                                + "after a device is claimed", c.siteId(), c.name());
                    }
                }
            } catch (RuntimeException e) {
                failed++;
                log.warn("v2 entity backfill: site {} failed, staying on v1: {}", c.siteId(),
                        e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return new RunSummary(candidates.size(), migrated, already, skipped, failed);
    }

    /** Sites that were never auto-backfilled, oldest first (deterministic). */
    List<Candidate> pending() {
        return adminJdbc.query(
                "SELECT id, tenant_id, name FROM site WHERE v2_backfilled_at IS NULL "
                        + "ORDER BY created_at, id",
                (rs, n) -> new Candidate(rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class), rs.getString("name")));
    }
}
