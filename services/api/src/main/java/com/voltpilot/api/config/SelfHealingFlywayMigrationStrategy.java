package com.voltpilot.api.config;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.ErrorCode;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.flywaydb.core.api.output.ValidateResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.core.env.Environment;

/**
 * Fail closed before migration or repair when this build does not know an applied
 * core migration, or the history contains a core DELETE marker. An older image
 * must never rewrite a newer database's history or become ready on that schema.
 * The diagnosis is read-only; an unreadable diagnosis also prevents startup.
 * An explicit developer exception requires the sole active profile local AND
 * voltpilot.flyway.startwaechter=nur-warnen. It warns and retains the previous
 * Flyway behaviour, including potentially destructive repair of future entries.
 * Without that profile, the switch alone can never relax this guard.
 *
 * <p>Known missing development seeds are the explicit exception below. For known
 * migrations, checksum/description/type drift still receives one loud repair and
 * retry. This accepted bookkeeping repair does not execute changed SQL; applied
 * migrations must remain immutable. Flyway repair can also mark unresolved
 * migrations DELETE, so it is NOT merely a checksum adjustment.
 *
 * <p>New resolved migrations, including late lower versions with out-of-order
 * enabled, are allowed. IGNORED arrivals with out-of-order disabled cannot be
 * repaired. SQL execution errors and a failed retry propagate unchanged.
 *
 * <p>This single class deliberately has no UEMS dependency, so the same protection
 * can be shipped in an older release. It does not stop processes already running
 * when a different build migrates the database; the rollout must handle those.
 */
public class SelfHealingFlywayMigrationStrategy implements FlywayMigrationStrategy {

    private static final Logger log = LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);

    private final boolean localWarnOnly;

    /** Direct users and tests remain strict unless they supply the gated environment. */
    public SelfHealingFlywayMigrationStrategy() {
        localWarnOnly = false;
    }

    public SelfHealingFlywayMigrationStrategy(Environment environment) {
        // Do not use default profiles here: an empty ACTIVE profile must stay strict.
        // Mixed profiles (e.g. local,prod) also stay strict rather than opening production.
        localWarnOnly = Arrays.equals(environment.getActiveProfiles(), new String[] {"local"})
                && "nur-warnen".equals(environment.getProperty("voltpilot.flyway.startwaechter", "streng"));
    }

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

    // Exact historical identities, not a prefix/range permission for absent core SQL.
    // Eight current db/dev files plus the original provisioned-devices seed from
    // 8766260c (before the current filename from ec6d93a7). See docs/api.md.
    private static final Map<String, String> OPTIONAL_DEV_SEEDS = Map.of(
            "100", "V100__dev_seed.sql",
            "20260702000100", "V20260702000100__dev_provisioned_devices.sql",
            "20260702020100", "V20260702020100__dev_provisioned_devices.sql",
            "20260706020000", "V20260706020000__dev_fleet_seed.sql",
            "20260706030000", "V20260706030000__dev_earnings_seed.sql",
            "20260707000100", "V20260707000100__dev_netzladen_dachau.sql",
            "20260707020100", "V20260707020100__dev_market_values_and_anzulegender_wert.sql",
            "20260707030100", "V20260707030100__dev_site_strompreis.sql",
            "20260708010100", "V20260708010100__dev_site_tarif.sql");

    private static final Set<MigrationState> UNKNOWN_APPLIED = EnumSet.of(
            MigrationState.FUTURE_SUCCESS, MigrationState.FUTURE_FAILED,
            MigrationState.MISSING_SUCCESS, MigrationState.MISSING_FAILED,
            MigrationState.DELETED);

    @Override
    public void migrate(Flyway flyway) {
        if (localWarnOnly) {
            log.warn("ACHTUNG ENTWICKLERMODUS: Profil local und voltpilot.flyway.startwaechter=nur-warnen. "
                    + "Unbekannte Kernmigrationen und DELETE-Marker sperren diesen lokalen Start nicht. "
                    + "Flyway repair() kann die Historie verändern. NIEMALS für Produktionsdaten verwenden.");
        }
        // Stable, database-local lock shared by every build carrying this strategy.
        // Flyway locks each individual command, not the info -> repair sequence.
        // The separate READ ONLY transaction holds no history-table lock and ends
        // even on a failed startup. Never change these keys across releases.
        try (Connection lock = flyway.getConfiguration().getDataSource().getConnection()) {
            lock.setAutoCommit(false);
            lock.setReadOnly(true);
            try {
                try (var statement = lock.createStatement()) {
                    statement.execute("SELECT pg_advisory_xact_lock(1448101453, 1179408727)");
                }
                migrateWithStartupLock(flyway);
            } finally {
                lock.rollback();
            }
        } catch (SQLException lockFailed) {
            String message = "Flyway-Start verweigert: Start-Sperre nicht sicher lesbar/erreichbar; "
                    + "nicht reparieren, nicht starten.";
            log.error(message, lockFailed);
            throw new FlywayException(message, lockFailed);
        }
    }

    private void migrateWithStartupLock(Flyway flyway) {
        requireCompatibleHistory(flyway);
        try {
            flyway.migrate();
        } catch (FlywayValidateException validationFailure) {
            MigrationInfo[] diagnosed = requireCompatibleHistory(flyway);
            List<String> outOfOrder = outOfOrderMigrations(diagnosed);
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
                            + "Drifted migrations: [{}]. Running repair() for checksum/description/type drift "
                            + "or known absent dev seeds (which may be marked DELETE), then migrate() once more. If an "
                            + "UNEXPECTED core (db/migration) version appears here, someone edited an already-applied "
                            + "migration - see AGENTS.md 'never edit an applied migration'.",
                    describeRepairableDrift(flyway),
                    validationFailure);
            // Recheck immediately before the write, including after validateWithResult().
            requireCompatibleHistory(flyway);
            flyway.repair();
            requireCompatibleHistory(flyway);
            flyway.migrate();
        }
        // A different build may have migrated while this process waited for Flyway's
        // lock. Diagnose again before returning to Spring's readiness lifecycle.
        requireCompatibleHistory(flyway);
    }

    /** No migration/repair is allowed when even the read-only diagnosis fails. */
    private MigrationInfo[] requireCompatibleHistory(Flyway flyway) {
        MigrationInfo[] migrations;
        List<String> incompatible = new ArrayList<>();
        try {
            migrations = flyway.info().all();
            for (MigrationInfo migration : migrations) {
                String version = migration.getVersion() == null ? null : migration.getVersion().getVersion();
                if (UNKNOWN_APPLIED.contains(migration.getState())
                        && !optionalDevSeed(version, migration.getScript())) {
                    incompatible.add(version + " (" + migration.getState() + ")");
                }
            }
            // Read the physical markers as well: info() describes the effective state,
            // which can hide an earlier DELETE when a version was subsequently reapplied.
            incompatible.addAll(deletedCoreMigrations(flyway));
        } catch (RuntimeException | SQLException diagnosisFailed) {
            String message = "Flyway-Start verweigert: Migrationshistorie nicht sicher lesbar. "
                    + "Nicht reparieren, nicht starten; Datenbankverbindung und Historie prüfen.";
            log.error(message, diagnosisFailed);
            throw new FlywayException(message, diagnosisFailed);
        }
        if (!incompatible.isEmpty()) {
            String diagnosis = "Diese Datenbank ist neuer als dieser Build "
                    + "oder ihre Kern-Migrationshistorie wurde als DELETE markiert. Versionen: "
                    + String.join(", ", incompatible);
            if (localWarnOnly) {
                log.warn("ACHTUNG ENTWICKLERMODUS — UNVERTRÄGLICHE MIGRATIONSHISTORIE: {}. "
                        + "Lokaler Zweigwechsel: Fortsetzung nach den bisherigen Flyway-Regeln. "
                        + "FUTURE-Versionen können bei repair() als DELETE markiert werden; "
                        + "vorhandene DELETE-Marker können erneute SQL-Ausführung und Fehler verursachen. "
                        + "Kein Kompatibilitätsnachweis, keine Freigabe für Produktionsdaten.", diagnosis);
                return migrations;
            }
            String message = "Flyway-Start verweigert: " + diagnosis
                    + ". Nicht reparieren, nicht starten; richtiges Image "
                    + "ausrollen oder Datenbank auf den Wiederherstellungspunkt wiederherstellen. "
                    + "Bei DELETE: API/Writer anhalten, Befund sichern, Rückweg auf den Punkt; "
                    + "ein neues Image allein behebt den Schaden nicht.";
            log.error(message);
            throw new FlywayException(message);
        }
        return migrations;
    }

    private static boolean optionalDevSeed(String version, String script) {
        return version != null && script != null && script.equals(OPTIONAL_DEV_SEEDS.get(version));
    }

    private List<String> deletedCoreMigrations(Flyway flyway) throws SQLException {
        var config = flyway.getConfiguration();
        try (Connection connection = config.getDataSource().getConnection()) {
            connection.setReadOnly(true);
            String schema = config.getDefaultSchema();
            if (schema == null) {
                schema = config.getSchemas().length == 0 ? connection.getSchema() : config.getSchemas()[0];
            }
            String table = quoteIdentifier(schema) + "." + quoteIdentifier(config.getTable());
            // A fresh database legitimately has no history table yet. All other SQL
            // errors (permissions, corrupt history, unavailable DB) must propagate.
            try (var exists = connection.prepareStatement("SELECT to_regclass(?)")) {
                exists.setString(1, table);
                try (var result = exists.executeQuery()) {
                    result.next();
                    if (result.getString(1) == null) {
                        return List.of();
                    }
                }
            }
            List<String> deleted = new ArrayList<>();
            try (var statement = connection.createStatement();
                    var rows = statement.executeQuery("SELECT version, script FROM " + table
                            + " WHERE type = 'DELETE' ORDER BY installed_rank")) {
                while (rows.next()) {
                    if (!optionalDevSeed(rows.getString(1), rows.getString(2))) {
                        deleted.add(rows.getString(1) + " (DELETE)");
                    }
                }
            }
            return deleted;
        }
    }

    private static String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    /** IGNORED is a known late arrival, unlike an unknown applied migration. */
    private List<String> outOfOrderMigrations(MigrationInfo[] migrations) {
        return Arrays.stream(migrations)
                .filter(MigrationInfo::isVersioned)
                .filter(m -> m.getState() == MigrationState.IGNORED)
                .map(m -> m.getVersion() + " (" + m.getDescription() + ")")
                .collect(Collectors.toList());
    }

    /**
     * Read-only listing of the REPAIRABLE drift, so the WARN names it. Entries
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
            String message = "Flyway-Start verweigert: Validierungsdiagnose nicht lesbar; nicht reparieren.";
            log.error(message, enumerationFailed);
            throw new FlywayException(message, enumerationFailed);
        }
    }
}
