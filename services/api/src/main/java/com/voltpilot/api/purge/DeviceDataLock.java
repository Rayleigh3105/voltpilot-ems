package com.voltpilot.api.purge;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Cross-instance serialization boundary for one device's destructive purge and
 * OCPP persistence. PostgreSQL advisory locks are database-wide, so this holds
 * even when purge and MQTT ingestion land on different API replicas.
 *
 * <p>The purge needs a session lock because its watermark update deliberately
 * commits before the delete transaction. OCPP ingestion takes the same key as
 * a transaction lock and re-reads the watermark only after acquiring it.
 */
@Component
public final class DeviceDataLock {

    private final DataSource dataSource;
    private final JdbcTemplate jdbc;

    public DeviceDataLock(DataSource dataSource, JdbcTemplate jdbc) {
        this.dataSource = dataSource;
        this.jdbc = jdbc;
    }

    /** Hold the device key across several independently committed statements. */
    public SessionLock lockSession(UUID deviceId) {
        long key = key(deviceId);
        Connection connection = null;
        try {
            connection = dataSource.getConnection();
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT pg_advisory_lock(?)")) {
                statement.setLong(1, key);
                statement.execute();
            }
            return new SessionLock(connection, key);
        } catch (SQLException ex) {
            closeQuietly(connection);
            throw new IllegalStateException("Could not acquire device data lock", ex);
        }
    }

    /** Hold the device key until the caller's current Spring transaction ends. */
    public void lockTransaction(UUID deviceId) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Device transaction lock requires an active transaction");
        }
        jdbc.query("SELECT pg_advisory_xact_lock(?)", resultSet -> { }, key(deviceId));
    }

    /** Stable signed 64-bit lock namespace derived from the complete UUID. */
    static long key(UUID deviceId) {
        return deviceId.getMostSignificantBits() ^ deviceId.getLeastSignificantBits();
    }

    public static final class SessionLock implements AutoCloseable {
        private final Connection connection;
        private final long key;
        private boolean closed;

        private SessionLock(Connection connection, long key) {
            this.connection = connection;
            this.key = key;
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            try {
                try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT pg_advisory_unlock(?)")) {
                    statement.setLong(1, key);
                    try (ResultSet result = statement.executeQuery()) {
                        if (!result.next() || !result.getBoolean(1)) {
                            throw new SQLException("device data lock was not owned by this session");
                        }
                    }
                }
            } catch (SQLException ex) {
                throw new IllegalStateException("Could not release device data lock", ex);
            } finally {
                closeQuietly(connection);
            }
        }
    }

    private static void closeQuietly(Connection connection) {
        if (connection == null) return;
        try {
            connection.close();
        } catch (SQLException ignored) {
            // The original acquisition/release failure is the actionable one.
        }
    }
}
