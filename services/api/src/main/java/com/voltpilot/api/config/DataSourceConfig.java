package com.voltpilot.api.config;

import com.voltpilot.api.tenant.AnfragePfadDataSource;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.SQLException;
import javax.sql.DataSource;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Datasources for the portal API.
 *
 * <p><b>Primary (customer) datasource</b> - connects as the non-privileged
 * {@code voltpilot_app} role (so Row-Level-Security applies to it); the
 * {@link TenantAwareDataSource} wrapper stamps {@code app.tenant_id} onto each
 * borrowed connection. Every tenant-scoped endpoint (sites/devices/telemetry)
 * reads through this. Flyway is configured separately (spring.flyway.*) to run
 * migrations as the Postgres superuser.
 *
 * <p>Underneath it, {@link AnfragePfadDataSource} splits the SAME role into two
 * physical Hikari pools: {@code realDataSource} (the request pool - statement
 * and socket timeout from {@code spring.datasource.hikari}, see its Javadoc for
 * why those can only be pool-level settings) while an HTTP request runs
 * ({@code AnfrageZeitgrenze}, set by {@code TenantFilter}), and
 * {@code backgroundDataSource} (no timeout) otherwise - nightly/scheduled jobs,
 * MQTT listeners and anything else off the servlet thread. Both connect with the
 * same credentials; only the pool-level connection settings differ.
 *
 * <p><b>Admin datasource</b> - a SEPARATE pool that connects as the dedicated
 * {@code voltpilot_admin} role (BYPASSRLS, created by migration V4). It is used
 * ONLY by the platform-admin repositories to manage tenants across the whole
 * platform. Keeping it separate means the customer datasource's RLS is never
 * weakened: cross-tenant access is a distinct, explicitly-authorized code path
 * (guarded by {@code @PreAuthorize("hasRole('platform-admin')")}), not a hole in
 * the tenant isolation that protects customer data.
 *
 * <p>The admin role is split the same way as the app role (Lasttest
 * vp-lasttest, Rang 7): {@code adminRequestDataSource} (4, the former single
 * admin pool) while an HTTP request runs, {@code adminBackgroundDataSource}
 * (small, {@code minimumIdle 0}) for schedulers, collectors and listeners. The
 * role, its BYPASSRLS and its grants are identical on both sides; only who
 * waits for whom changes. {@code application_name} names the pool in
 * {@code pg_stat_activity}.
 */
@Configuration
public class DataSourceConfig {

    /**
     * Request pool: every HTTP-triggered query runs through this one while
     * {@code AnfrageZeitgrenze} is active. {@code connection-init-sql} sets
     * {@code statement_timeout} once per physical connection (a session GUC, so
     * it holds for that connection's whole life - no per-borrow SET/RESET
     * needed); {@code data-source-properties.socketTimeout} is pgjdbc's
     * client-side defense if Postgres itself never answers at all. Both are
     * baked in at connection creation and can't be toggled afterwards, which is
     * exactly why background work needs its OWN pool instead of a flag on this
     * one (see {@link AnfragePfadDataSource}).
     */
    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    HikariDataSource realDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    /**
     * Background pool: same role and database as {@link #realDataSource}, no
     * statement or socket timeout. Nightly/scheduled jobs and MQTT listeners
     * never set {@code AnfrageZeitgrenze}, so {@link AnfragePfadDataSource}
     * always routes them here.
     */
    @Bean
    @ConfigurationProperties("spring.background-datasource.hikari")
    HikariDataSource backgroundDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    @Bean
    @Primary
    DataSource dataSource(HikariDataSource realDataSource, HikariDataSource backgroundDataSource) {
        return new TenantAwareDataSource(new AnfragePfadDataSource(realDataSource, backgroundDataSource));
    }

    /**
     * Primary JdbcTemplate: the tenant-aware (RLS-scoped) one every customer
     * repository uses. Declared explicitly because the presence of the admin
     * JdbcTemplate below backs off Spring Boot's auto-configured one - so we must
     * define, and mark {@code @Primary}, the one repositories should get by default.
     */
    @Bean
    @Primary
    JdbcTemplate jdbcTemplate(@Qualifier("dataSource") DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }

    /**
     * Dedicated pool for the platform-admin (cross-tenant) datasource. Connects
     * as {@code voltpilot_admin} (BYPASSRLS). Same database as the app pool - only
     * the role differs - so the URL defaults to {@code spring.datasource.url}.
     */
    @Bean(name = "adminRequestDataSource")
    HikariDataSource adminRequestDataSource(
            @Value("${voltpilot.admin-datasource.url:${spring.datasource.url}}") String url,
            @Value("${voltpilot.admin-datasource.username:voltpilot_admin}") String username,
            @Value("${voltpilot.admin-datasource.password:voltpilot_admin_dev_pw}") String password) {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl(url);
        ds.setUsername(username);
        ds.setPassword(password);
        ds.setPoolName("voltpilot-admin-pool");
        ds.setMaximumPoolSize(4);
        ds.addDataSourceProperty("ApplicationName", "voltpilot-api admin");
        return ds;
    }

    /**
     * Hintergrund-Pool der Admin-Rolle (Lasttest vp-lasttest, Befund B3/B4, Rang 7): dieselbe Rolle und Datenbank
     * wie {@link #adminRequestDataSource}, aber nur für Arbeit außerhalb einer HTTP-Anfrage - Läufer, Sammler,
     * MQTT-Listener. Vorher teilten sich beide die vier Verbindungen des einen Admin-Pools: liefen
     * Flotten-Kennzahlen, Datenhaltungs-Sammler und Überwachung (je Takt mehrere Sekunden lange Admin-Abfragen),
     * konkurrierte jede Kunden-Anfrage, die über die Admin-Rolle prüft (Kundenbereich beendet?), und jede
     * Plattform-Seite mit ihnen um eine freie Verbindung. Größe {@code DB_POOL_ADMIN_BACKGROUND_MAX_SIZE},
     * Vorgabe 4 = so viel, wie die Hintergrundarbeit bisher höchstens bekam: kleiner (im Labor 2) staute die
     * Hintergrund-Abfragen untereinander bis 6,8 s - darunter die minütliche, {@code synchronized} Auffrischung
     * von {@code BeendeteKundenbereiche}, an der alle MQTT-Listener hängen. {@code minimumIdle 0}: die
     * Verbindungen entstehen erst, wenn ein Läufer sie braucht, und schließen nach einer Minute Ruhe - das
     * Gesamtbudget je Instanz wächst im Ruhezustand nicht.
     */
    @Bean(name = "adminBackgroundDataSource")
    HikariDataSource adminBackgroundDataSource(
            @Value("${voltpilot.admin-datasource.url:${spring.datasource.url}}") String url,
            @Value("${voltpilot.admin-datasource.username:voltpilot_admin}") String username,
            @Value("${voltpilot.admin-datasource.password:voltpilot_admin_dev_pw}") String password,
            @Value("${voltpilot.admin-datasource.background-max-size:4}") int maxSize) {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl(url);
        ds.setUsername(username);
        ds.setPassword(password);
        ds.setPoolName("voltpilot-admin-background-pool");
        ds.setMaximumPoolSize(maxSize);
        ds.setMinimumIdle(0);
        ds.setIdleTimeout(60_000);
        ds.addDataSourceProperty("ApplicationName", "voltpilot-api admin hintergrund");
        return ds;
    }

    /**
     * Die Admin-Datenquelle, die alle {@code @Qualifier("adminDataSource")}-/{@code adminJdbcTemplate}-Nutzer
     * bekommen: während einer HTTP-Anfrage ({@code AnfrageZeitgrenze}, gesetzt vom {@code TenantFilter}) der
     * Anfrage-Pool, sonst der Hintergrund-Pool - dieselbe Weiche wie für die App-Rolle
     * ({@link AnfragePfadDataSource}). Rolle, RLS-Umgehung und Rechte sind auf beiden Seiten dieselben; nur wer
     * auf wen warten muss, ändert sich.
     */
    /**
     * Öffnet den Anfrage-Pool der Admin-Rolle, sobald die Anwendung bereit ist (nach Flyway und den Start-Läufern).
     * Vorher öffneten Start-Läufer den einen Admin-Pool, und die erste Anfrage fand ihn offen; seit der Trennung
     * öffnen sie nur den Hintergrund-Pool - ohne dieses Vorwärmen zahlte die erste Kunden-Anfrage nach jedem Start
     * den Verbindungsaufbau. Scheitert es, öffnet die erste Anfrage den Pool wie bisher.
     */
    @Bean
    ApplicationListener<ApplicationReadyEvent> adminAnfragePoolVorwaermen(
            @Qualifier("adminRequestDataSource") HikariDataSource anfrage) {
        return event -> {
            try (Connection verbindung = anfrage.getConnection()) {
                verbindung.isValid(5);
            } catch (SQLException e) {
                LoggerFactory.getLogger(DataSourceConfig.class)
                        .warn("Admin-Anfrage-Pool nicht vorgewärmt: {}", e.getMessage());
            }
        };
    }

    @Bean(name = "adminDataSource")
    DataSource adminDataSource(@Qualifier("adminRequestDataSource") HikariDataSource anfrage,
            @Qualifier("adminBackgroundDataSource") HikariDataSource hintergrund) {
        return new AnfragePfadDataSource(anfrage, hintergrund);
    }

    /** JdbcTemplate bound to the admin (BYPASSRLS) datasource for admin repositories. */
    @Bean(name = "adminJdbcTemplate")
    JdbcTemplate adminJdbcTemplate(@Qualifier("adminDataSource") DataSource adminDataSource) {
        return new JdbcTemplate(adminDataSource);
    }
}
