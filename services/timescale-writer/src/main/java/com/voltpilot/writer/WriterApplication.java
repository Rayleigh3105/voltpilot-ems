package com.voltpilot.writer;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;

/**
 * Voltpilot-EMS TimescaleDB-Writer.
 *
 * <p>Responsibility (architecture section 8): read {@code telemetry.raw} from
 * Redpanda and write into the TimescaleDB {@code telemetry} hypertable.
 * Stateless. Final hop of the MVP data path.
 *
 * <p>MVP skeleton: the Kafka consumer and JDBC batch writer are declared as
 * dependencies but not yet wired. {@link DataSourceAutoConfiguration} is
 * excluded so the skeleton starts without a live database; re-enable it once
 * the writer is implemented.
 */
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
public class WriterApplication {

    public static void main(String[] args) {
        SpringApplication.run(WriterApplication.class, args);
    }
}
