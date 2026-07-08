package com.voltpilot.api.config;

import java.util.stream.Collectors;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.flywaydb.core.api.output.ValidateResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;

/**
 * Deploy-resilient Flyway startup: keep STRICT validation on the happy path, but
 * SELF-HEAL a checksum/version drift instead of crash-looping the deploy.
 *
 * <p><b>Why this exists.</b> A long-lived VM that ran (or still runs) with
 * {@code SPRING_PROFILES_ACTIVE=local} has the DEV-ONLY {@code db/dev} seed
 * migrations recorded in {@code flyway_schema_history}. When one of those seeds
 * is later edited (the FK existence-guard hotfixes to {@code V20260706020000} /
 * {@code V20260706030000} are the recurring example), the recorded checksum no
 * longer matches the shipped one, and Flyway's default startup validation
 * ABORTS the api boot with a checksum mismatch. That has bricked the captain's
 * production deploy repeatedly, each time needing a manual DB repair.
 *
 * <p><b>What it does.</b> This strategy first tries a normal
 * {@link Flyway#migrate()} - so a healthy database validates strictly exactly
 * like before, and any genuine drift is loudly logged. Only when validation
 * FAILS ({@link FlywayValidateException}) does it react: it logs a loud
 * {@code WARN} naming the drifted migrations, calls {@link Flyway#repair()} to
 * realign the recorded checksums to the shipped migrations (this rewrites the
 * history bookkeeping WITHOUT re-executing any migration - the schema is already
 * in that state), and retries {@code migrate()} ONCE. The deploy heals itself
 * with no manual step.
 *
 * <p><b>Scope of the catch (deliberately narrow).</b> Only
 * {@link FlywayValidateException} triggers a repair. A genuinely broken
 * migration (a SQL error while applying) throws a different exception, is NOT
 * caught here, and still fails the boot - repair could not fix it and must not
 * hide it. A second migrate failure after repair also propagates.
 *
 * <p><b>Residual risk (accepted, mitigated).</b> {@code repair()} realigns
 * checksums to whatever is on the classpath, so an accidental edit of an
 * already-applied CORE migration ({@code db/migration}) would be accepted with
 * only the logged {@code WARN} rather than blocking the boot. The mitigations
 * are unchanged project discipline: the "never edit an already-applied
 * migration" rule (AGENTS.md), and code review + CI - the WARN is loud and
 * names the versions so an unexpected core drift is visible in the deploy logs.
 * This trade is intentional: an auto-healed deploy beats a crash-loop that
 * needs a human at the DB, and the dev-seed drift that actually recurs is
 * harmless bookkeeping.
 *
 * <p>The forward-looking hygiene ({@code spring.flyway.ignore-migration-patterns:
 * "*:missing"} plus the blank production profile) is complementary: it stops
 * prod from running the dev seeds at all, so eventually there is no dev-seed
 * drift to heal. This strategy is what rescues the instances that already have
 * the dev migrations recorded.
 */
public class SelfHealingFlywayMigrationStrategy implements FlywayMigrationStrategy {

    private static final Logger log = LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);

    @Override
    public void migrate(Flyway flyway) {
        try {
            flyway.migrate();
        } catch (FlywayValidateException validationFailure) {
            log.warn(
                    "Flyway startup validation FAILED - self-healing the migration history and retrying. "
                            + "Drifted migrations: [{}]. Running repair() to realign recorded checksums to the "
                            + "shipped migrations (no migration is re-executed), then migrate() once more. If an "
                            + "UNEXPECTED core (db/migration) version appears here, someone edited an already-applied "
                            + "migration - see AGENTS.md 'never edit an applied migration'.",
                    describeDrift(flyway),
                    validationFailure);
            flyway.repair();
            flyway.migrate();
        }
    }

    /**
     * Best-effort listing of the migrations Flyway considers invalid, so the WARN
     * names them. Falls back to a hint if validation itself cannot be enumerated.
     */
    private String describeDrift(Flyway flyway) {
        try {
            ValidateResult result = flyway.validateWithResult();
            if (result.invalidMigrations == null || result.invalidMigrations.isEmpty()) {
                return "none reported by validateWithResult";
            }
            return result.invalidMigrations.stream()
                    .map(m -> m.version + " (" + m.errorDetails.errorCode + ")")
                    .collect(Collectors.joining(", "));
        } catch (RuntimeException enumerationFailed) {
            return "could not enumerate (" + enumerationFailed.getClass().getSimpleName() + ")";
        }
    }
}
