package com.voltpilot.api.config;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.ErrorCode;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.flywaydb.core.api.output.ValidateResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;

/**
 * Deploy-resilient Flyway startup: keep STRICT validation on the happy path, but
 * SELF-HEAL a checksum drift instead of crash-looping the deploy - and, for the
 * drift class {@link Flyway#repair()} provably CANNOT fix, say so plainly
 * instead of claiming a heal that never happens.
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
 * FAILS ({@link FlywayValidateException}) does it react, and it then splits the
 * failure into two classes:
 *
 * <ul>
 *   <li><b>Repairable bookkeeping drift</b> (checksum/description/type of an
 *       ALREADY-APPLIED migration, an applied-but-no-longer-resolved one, a
 *       failed entry): loud {@code WARN} naming the drifted migrations, then
 *       {@link Flyway#repair()} - which realigns the recorded bookkeeping to the
 *       shipped migrations WITHOUT re-executing anything, because the schema is
 *       already in that state - and ONE retry of {@code migrate()}. The deploy
 *       heals itself with no manual step.</li>
 *   <li><b>Out-of-order arrivals</b> ({@link MigrationState#IGNORED}: a resolved
 *       migration whose version sits BELOW the highest already-applied one, so
 *       Flyway refuses to apply it while {@code out-of-order} is off). Here
 *       {@code repair()} is a no-op by construction - it only ever touches
 *       migrations that ARE applied - so the retry would fail identically and
 *       the only thing the old code added was a misleading "self-healing" line
 *       in front of the crash. This strategy now logs an {@code ERROR} that
 *       names the migrations, the cause and the fix, and rethrows immediately.
 *       See the {@code spring.flyway.out-of-order} block in
 *       {@code application.yml} for the 2026-08-26 production incident this
 *       class of failure caused.</li>
 * </ul>
 *
 * <p><b>Scope of the catch (deliberately narrow).</b> Only
 * {@link FlywayValidateException} is handled at all. A genuinely broken
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
 * "*:missing"}, {@code spring.flyway.out-of-order: true} plus the blank
 * production profile) is complementary: it stops both failure modes from
 * arising in the first place. This strategy is what rescues an instance that
 * already carries the drift - and what explains itself when it cannot.
 */
public class SelfHealingFlywayMigrationStrategy implements FlywayMigrationStrategy {

    private static final Logger log = LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);

    /**
     * The validation error codes {@link Flyway#repair()} genuinely realigns.
     * Everything else - notably {@code RESOLVED_*_MIGRATION_NOT_APPLIED} - is
     * about a migration that is NOT in the history table, which repair() never
     * touches. Kept as an explicit allowlist so the WARN lists only drift the
     * repair can actually address, instead of the pending-migration noise a
     * standalone {@code validate()} reports on every healthy deploy.
     */
    private static final Set<ErrorCode> REPAIRABLE = EnumSet.of(
            ErrorCode.CHECKSUM_MISMATCH,
            ErrorCode.DESCRIPTION_MISMATCH,
            ErrorCode.TYPE_MISMATCH,
            ErrorCode.APPLIED_VERSIONED_MIGRATION_NOT_RESOLVED,
            ErrorCode.APPLIED_REPEATABLE_MIGRATION_NOT_RESOLVED,
            ErrorCode.FAILED_VERSIONED_MIGRATION,
            ErrorCode.FAILED_REPEATABLE_MIGRATION);

    @Override
    public void migrate(Flyway flyway) {
        try {
            flyway.migrate();
        } catch (FlywayValidateException validationFailure) {
            List<String> outOfOrder = outOfOrderMigrations(flyway);
            if (!outOfOrder.isEmpty()) {
                log.error(
                        "Flyway startup validation FAILED and repair() CANNOT fix it: [{}] resolved but NOT "
                                + "applied, because their version is BELOW the highest version this database has "
                                + "already applied. That happens when PRs merge out of version order (the version "
                                + "is the AUTHORING time, the database sees MERGE order). repair() only realigns "
                                + "migrations that ARE applied, so retrying it would fail identically. FIX: allow "
                                + "the late arrival with spring.flyway.out-of-order=true (env "
                                + "SPRING_FLYWAY_OUT_OF_ORDER=true) - it is the shipped default; a deployment that "
                                + "overrode it to false has to clear that override. Do NOT renumber the migration: "
                                + "a fresh database applies in version order and would then run it in the wrong "
                                + "place (see docs/deploy.md).",
                        String.join(", ", outOfOrder),
                        validationFailure);
                throw validationFailure;
            }
            log.warn(
                    "Flyway startup validation FAILED - self-healing the migration history and retrying. "
                            + "Drifted migrations: [{}]. Running repair() to realign recorded checksums to the "
                            + "shipped migrations (no migration is re-executed), then migrate() once more. If an "
                            + "UNEXPECTED core (db/migration) version appears here, someone edited an already-applied "
                            + "migration - see AGENTS.md 'never edit an applied migration'.",
                    describeRepairableDrift(flyway),
                    validationFailure);
            flyway.repair();
            flyway.migrate();
        }
    }

    /**
     * The migrations Flyway parked in {@link MigrationState#IGNORED}: resolved,
     * versioned, and below the highest applied version, so they are skipped
     * while {@code out-of-order} is off. This is read from
     * {@link Flyway#info()} rather than from the validate result on purpose -
     * both an out-of-order arrival and an ordinary PENDING migration report the
     * same {@code RESOLVED_VERSIONED_MIGRATION_NOT_APPLIED} error code, and only
     * the state tells them apart.
     *
     * <p>Empty when info cannot be read, so an unreadable history falls back to
     * the previous repair-and-retry behaviour rather than blocking the boot on a
     * diagnosis we could not make.
     */
    private List<String> outOfOrderMigrations(Flyway flyway) {
        try {
            return Arrays.stream(flyway.info().all())
                    .filter(MigrationInfo::isVersioned)
                    .filter(m -> m.getState() == MigrationState.IGNORED)
                    .map(m -> m.getVersion() + " (" + m.getDescription() + ")")
                    .collect(Collectors.toList());
        } catch (RuntimeException infoFailed) {
            log.debug("Could not read Flyway info while classifying the validation failure", infoFailed);
            return List.of();
        }
    }

    /**
     * Best-effort listing of the REPAIRABLE drift, so the WARN names it. Entries
     * outside {@link #REPAIRABLE} are dropped: a standalone validate also flags
     * every ordinary pending migration, and listing those would bury the one
     * checksum mismatch the repair is actually about.
     */
    private String describeRepairableDrift(Flyway flyway) {
        try {
            ValidateResult result = flyway.validateWithResult();
            if (result.invalidMigrations == null || result.invalidMigrations.isEmpty()) {
                return "none reported by validateWithResult";
            }
            String repairable = result.invalidMigrations.stream()
                    .filter(m -> m.errorDetails != null && REPAIRABLE.contains(m.errorDetails.errorCode))
                    .map(m -> m.version + " (" + m.errorDetails.errorCode + ")")
                    .collect(Collectors.joining(", "));
            return repairable.isEmpty() ? "none repairable reported by validateWithResult" : repairable;
        } catch (RuntimeException enumerationFailed) {
            return "could not enumerate (" + enumerationFailed.getClass().getSimpleName() + ")";
        }
    }
}
