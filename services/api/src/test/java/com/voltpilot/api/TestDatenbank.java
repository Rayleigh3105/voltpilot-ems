package com.voltpilot.api;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.Location;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.Configuration;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.output.MigrateResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.lifecycle.Startable;
import org.testcontainers.utility.DockerImageName;

/**
 * Eine eigene, frische Datenbank je Testklasse - in einem TimescaleDB-Container, den alle Testklassen
 * eines Testlaufs (einer JVM) teilen. Ersetzt den bisherigen eigenen {@code PostgreSQLContainer} je
 * Klasse: im Nachtlauf startete jede der rund 380 Datenbank-Testklassen einen Container und migrierte
 * ihn vollständig (Lauf 595: fünf api-Teile je 80 bis 104 min).
 *
 * <p>Wie ein eigener Container verhält sich die Datenbank, weil vor jeder neuen Datenbank der ganze
 * Cluster auf seinen Grundzustand zurückgesetzt wird ({@link #start()}, ebenso {@link #stop()}):
 * <ul>
 *   <li>alle Datenbanken außer den Grunddatenbanken werden gelöscht, auch die, die eine Klasse selbst
 *       angelegt hat ({@code CREATE DATABASE voltpilot_spaet});
 *   <li>alle Rollen, die eine Klasse oder ihre Migration angelegt hat, werden gelöscht - die nächste
 *       Migration legt {@code voltpilot_app} und {@code voltpilot_admin} mit ihrem eigenen Passwort
 *       neu an, wie in einem frischen Container (V1/V4 legen nur an, wenn die Rolle fehlt);
 *   <li>die neue Datenbank ist eine Kopie der unberührten Grunddatenbank ({@code vp_leer}, wie
 *       {@code POSTGRES_DB} des Abbilds: nur die Erweiterung {@code timescaledb}), und ihr
 *       TimescaleDB-Scheduler läuft sofort, nicht erst nach der 60-s-Abfrage des Launchers.
 * </ul>
 *
 * <p>{@link #migriere(FluentConfiguration)} spart den vollen Flyway-Lauf, wo er nachweislich
 * dasselbe Ergebnis hat: eine unberührte Datenbank, die vollständig nur mit
 * {@code classpath:db/migration} migriert wird, wird stattdessen aus einer einmal je Konfiguration
 * gebauten Vorlage kopiert (Vorlage = derselbe Flyway-Lauf auf einer ebenso frischen Datenbank).
 * Die Rollen der Vorlage behalten ihre Identität, liegen zwischen den Klassen umbenannt
 * ({@code vp_vorlage_1_voltpilot_app}) und bekommen beim Ausleihen ihren Namen und das Passwort der
 * Klasse. Nie aus einer Vorlage: Ziele ({@code target}), eigene Orte, Callbacks und die Dev-Saat
 * {@code db/dev} - deren Zeilen hängen an {@code now()} (Telemetrie „gerade eben“, 5-min-Fenster)
 * und wären aus einer älteren Vorlage gealtert. Belegt in {@code TestDatenbankTest}.
 *
 * <p>Alle Instanzen einer JVM laufen nacheinander (eine Klasse nach der anderen); zwei gleichzeitig
 * benutzte Datenbanken in einem Cluster gibt es nicht - eine zweite {@link #start()} setzt die erste
 * zurück.
 */
public final class TestDatenbank implements Startable {

    private static final Logger LOG = LoggerFactory.getLogger(TestDatenbank.class);
    private static final DockerImageName BILD = DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
            .asCompatibleSubstituteFor("postgres");
    private static final String SUPERUSER = "voltpilot";
    private static final String SUPERUSER_PASSWORT = "voltpilot_dev_pw";
    /** Die vom Container angelegte {@code POSTGRES_DB}; bleibt unberührt, Klassen bekommen Kopien. */
    private static final String CONTAINER_DB = "voltpilot";
    private static final String LEER = "vp_leer";
    private static final String VORLAGE = "vp_vorlage_";
    /** Passwort-Platzhalter je Rollen-Platzhalter (V1 und V4); nur sie fehlen im Vorlagenschlüssel. */
    static final Map<String, String> PASSWORT_ZU_ROLLE = Map.of(
            "appDbPassword", "appDbUser",
            "adminDbPassword", "adminDbUser");

    private static final Map<List<String>, Cluster> CLUSTER = new HashMap<>();

    private List<String> befehl = List.of();
    private Cluster cluster;
    private String name;

    /**
     * Startbefehl des geteilten Containers, wie {@code PostgreSQLContainer#withCommand}; je
     * verschiedenem Befehl gibt es einen eigenen geteilten Container.
     */
    public TestDatenbank withCommand(String... befehl) {
        if (cluster != null) {
            throw new IllegalStateException("withCommand nach start()");
        }
        this.befehl = List.of(befehl);
        return this;
    }

    @Override
    public synchronized void start() {
        if (cluster != null && cluster.aktiv == this) {
            return;
        }
        cluster = Cluster.fuer(befehl);
        name = cluster.neueDatenbank(this);
    }

    @Override
    public synchronized void stop() {
        if (cluster != null && cluster.aktiv == this) {
            cluster.zuruecksetzen();
        }
    }

    public String getJdbcUrl() {
        return getJdbcUrl(name());
    }

    /**
     * Adresse einer weiteren Datenbank desselben Clusters, die die Klasse selbst anlegt
     * ({@code CREATE DATABASE voltpilot_spaet}); sie verschwindet mit dem Zurücksetzen.
     */
    public String getJdbcUrl(String datenbank) {
        name();
        if (cluster.grundDatenbanken.contains(datenbank) || cluster.istVorlage(datenbank)) {
            // Was dort geschähe, überlebte das Zurücksetzen.
            throw new IllegalArgumentException(datenbank + " gehört dem geteilten Cluster");
        }
        return cluster.url(datenbank);
    }

    public String getDatabaseName() {
        return name();
    }

    public String getUsername() {
        return SUPERUSER;
    }

    public String getPassword() {
        return SUPERUSER_PASSWORT;
    }

    /** Wie {@code JdbcDatabaseContainer#createConnection}: Superuser-Verbindung zur Klassen-Datenbank. */
    public Connection createConnection(String abfrage) throws SQLException {
        String url = getJdbcUrl();
        if (!abfrage.isEmpty()) {
            url = url.contains("?") && abfrage.startsWith("?") ? url + "&" + abfrage.substring(1) : url + abfrage;
        }
        Properties p = new Properties();
        p.setProperty("user", SUPERUSER);
        p.setProperty("password", SUPERUSER_PASSWORT);
        return DriverManager.getConnection(url, p);
    }

    /** Log des geteilten Containers - enthält auch die Zeilen früherer Klassen. */
    public String getLogs() {
        name();
        return cluster.container.getLogs();
    }

    /**
     * {@code konfiguration.load().migrate()} - bei einer unberührten Datenbank und einer
     * vorlagenfähigen Konfiguration (siehe Klassenkommentar) aus der Vorlage, sonst mit vollem Lauf.
     * Flyway läuft in beiden Fällen und findet nach der Kopie nichts mehr zu tun.
     */
    public MigrateResult migriere(FluentConfiguration konfiguration) {
        name();
        cluster.vorMigration(this, konfiguration);
        return konfiguration.load().migrate();
    }

    private String name() {
        if (cluster == null || cluster.aktiv != this) {
            throw new IllegalStateException("TestDatenbank ist nicht (mehr) gestartet");
        }
        return name;
    }

    /** Ein geteilter Container mit seinem Grundzustand und seinen Vorlagen. */
    static final class Cluster {

        final PostgreSQLContainer<?> container;
        private final Set<String> grundDatenbanken = new LinkedHashSet<>();
        private final Set<String> grundRollen = new LinkedHashSet<>();
        private final Map<String, Vorlage> vorlagen = new LinkedHashMap<>();
        private Vorlage ausgeliehen;
        private TestDatenbank aktiv;
        private int zaehler;

        static synchronized Cluster fuer(List<String> befehl) {
            return CLUSTER.computeIfAbsent(befehl, Cluster::new);
        }

        @SuppressWarnings("resource")
        private Cluster(List<String> befehl) {
            container = new PostgreSQLContainer<>(BILD)
                    .withDatabaseName(CONTAINER_DB)
                    .withUsername(SUPERUSER)
                    .withPassword(SUPERUSER_PASSWORT);
            if (!befehl.isEmpty()) {
                container.withCommand(befehl.toArray(String[]::new));
            }
            container.start();
            // Wie POSTGRES_DB: das Abbild legt timescaledb in template1 und in POSTGRES_DB an.
            kopiere(LEER, "template1");
            sql("postgres", "ALTER DATABASE " + LEER + " WITH IS_TEMPLATE true ALLOW_CONNECTIONS false");
            grundDatenbanken.addAll(liste("postgres", "SELECT datname FROM pg_database"));
            grundRollen.addAll(liste("postgres", "SELECT rolname FROM pg_roles"));
        }

        synchronized String neueDatenbank(TestDatenbank db) {
            zuruecksetzen();
            String name = "test_" + (++zaehler);
            erzeuge(name, LEER);
            aktiv = db;
            return name;
        }

        /** Cluster auf den Grundzustand: nur Grunddatenbanken, Vorlagen und deren Rollen bleiben. */
        synchronized void zuruecksetzen() {
            aktiv = null;
            for (String db : liste("postgres", "SELECT datname FROM pg_database")) {
                if (!grundDatenbanken.contains(db) && !istVorlage(db)) {
                    sql("postgres", "DROP DATABASE " + ident(db) + " WITH (FORCE)");
                }
            }
            if (ausgeliehen != null) {
                Vorlage v = ausgeliehen;
                ausgeliehen = null;
                v.rollen.forEach((echt, versteckt) -> sql("postgres",
                        "ALTER ROLE " + ident(echt) + " RENAME TO " + ident(versteckt)));
                if (!v.rollenAbbild.equals(rollenAbbild(v.rollen.values()))) {
                    // Eine Klasse hat die Rollen der Vorlage geändert: die Vorlage ist verbraucht.
                    LOG.info("TestDatenbank: Rollen von {} geändert, Vorlage verworfen: {} -> {}", v.datenbank,
                            v.rollenAbbild, rollenAbbild(v.rollen.values()));
                    verwerfe(v);
                }
            }
            for (String rolle : liste("postgres", "SELECT rolname FROM pg_roles")) {
                if (!grundRollen.contains(rolle) && !istVorlagenRolle(rolle)) {
                    sql("postgres", "DROP ROLE " + ident(rolle));
                }
            }
        }

        synchronized void vorMigration(TestDatenbank db, Configuration konfiguration) {
            String schluessel = vorlagenSchluessel(konfiguration);
            String ohneVorlage = schluessel == null ? "Konfiguration nicht vorlagenfähig"
                    : !zielIst(konfiguration, db.name) ? "Flyway zielt auf eine andere Datenbank"
                    : !unberuehrt(db.name) ? "Datenbank nicht mehr unberührt"
                    : !rollenImGrundzustand() ? "Rollen nicht im Grundzustand"
                    : null;
            if (ohneVorlage != null) {
                LOG.info("TestDatenbank {}: voller Flyway-Lauf ({})", db.name, ohneVorlage);
                return;
            }
            Vorlage v = vorlagen.containsKey(schluessel) ? vorlagen.get(schluessel) : baueVorlage(konfiguration);
            vorlagen.put(schluessel, v);
            sql("postgres", "DROP DATABASE " + ident(db.name) + " WITH (FORCE)");
            erzeuge(db.name, v.datenbank);
            LOG.info("TestDatenbank {}: Kopie aus {}", db.name, v.datenbank);
            ausgeliehen = v;
            Map<String, String> platzhalter = konfiguration.getPlaceholders();
            v.rollen.forEach((echt, versteckt) -> sql("postgres",
                    "ALTER ROLE " + ident(versteckt) + " RENAME TO " + ident(echt)));
            PASSWORT_ZU_ROLLE.forEach((passwort, rolle) -> {
                String echt = platzhalter.get(rolle);
                if (echt != null && v.rollen.containsKey(echt) && platzhalter.containsKey(passwort)) {
                    sql("postgres", "ALTER ROLE " + ident(echt) + " PASSWORD " + literal(platzhalter.get(passwort)));
                }
            });
        }

        private Vorlage baueVorlage(Configuration konfiguration) {
            String name = VORLAGE + (++zaehler);
            erzeuge(name, LEER);
            Set<String> vorher = new LinkedHashSet<>(liste("postgres", "SELECT rolname FROM pg_roles"));
            Flyway.configure(konfiguration.getClassLoader())
                    .configuration(konfiguration)
                    .dataSource(url(name), SUPERUSER, SUPERUSER_PASSWORT)
                    .load()
                    .migrate();
            Map<String, String> rollen = new TreeMap<>();
            for (String rolle : liste("postgres", "SELECT rolname FROM pg_roles")) {
                if (!vorher.contains(rolle)) {
                    String versteckt = name + "_" + rolle;
                    sql("postgres", "ALTER ROLE " + ident(rolle) + " RENAME TO " + ident(versteckt));
                    rollen.put(rolle, versteckt);
                }
            }
            sql("postgres", "ALTER DATABASE " + name + " WITH IS_TEMPLATE true ALLOW_CONNECTIONS false");
            sql("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '" + name + "'");
            return new Vorlage(name, rollen, rollenAbbild(rollen.values()));
        }

        private void verwerfe(Vorlage v) {
            vorlagen.values().remove(v);
            sql("postgres", "ALTER DATABASE " + v.datenbank + " WITH IS_TEMPLATE false");
            sql("postgres", "DROP DATABASE " + v.datenbank + " WITH (FORCE)");
            v.rollen.values().forEach(r -> sql("postgres", "DROP ROLE " + ident(r)));
        }

        /**
         * Schlüssel der Vorlage oder {@code null}, wenn diese Konfiguration nie aus einer Vorlage kommt.
         * Enthält alles, was das Ergebnis eines Laufs auf einer frischen Datenbank bestimmt, außer den
         * Rollen-Passwörtern (die setzt das Ausleihen).
         */
        static String vorlagenSchluessel(Configuration k) {
            List<String> orte = Arrays.stream(k.getLocations()).map(Location::getDescriptor).toList();
            boolean bisZumEnde = k.getTarget() == null || MigrationVersion.LATEST.equals(k.getTarget());
            if (!orte.equals(List.of("classpath:db/migration")) || !bisZumEnde
                    || (k.getCherryPick() != null && k.getCherryPick().length > 0)
                    || k.getCallbacks().length > 0 || k.getJavaMigrations().length > 0
                    || k.getResolvers().length > 0 || k.getInitSql() != null
                    || k.isSkipExecutingMigrations() || !k.isPlaceholderReplacement()) {
                return null;
            }
            Map<String, String> platzhalter = new TreeMap<>(k.getPlaceholders());
            PASSWORT_ZU_ROLLE.keySet().forEach(platzhalter::remove);
            return String.join("|", List.of(
                    String.join(",", orte), platzhalter.toString(),
                    String.valueOf(k.getBaselineVersion()), String.valueOf(k.isBaselineOnMigrate()),
                    String.valueOf(k.isOutOfOrder()),
                    Arrays.stream(k.getIgnoreMigrationPatterns()).map(Object::toString)
                            .collect(Collectors.joining(",")),
                    k.getTable(), String.join(",", k.getSchemas()), String.valueOf(k.getDefaultSchema()),
                    String.valueOf(k.isGroup()), String.valueOf(k.isMixed()),
                    String.valueOf(k.isExecuteInTransaction()), String.valueOf(k.isCreateSchemas()),
                    String.valueOf(k.getInstalledBy()), String.valueOf(k.getEncoding()),
                    k.getPlaceholderPrefix() + k.getPlaceholderSuffix(), k.getSqlMigrationPrefix()));
        }

        private boolean zielIst(Configuration k, String datenbank) {
            try (Connection c = k.getDataSource().getConnection()) {
                return datenbank.equals(c.getCatalog());
            } catch (SQLException e) {
                return false;
            }
        }

        /**
         * Nichts außer dem, was {@code vp_leer} schon hat: keine eigenen Schemas, Erweiterungen, Tabellen,
         * Funktionen oder Typen (die Funktionen von timescaledb in {@code public} gehören der Erweiterung).
         */
        private boolean unberuehrt(String datenbank) {
            return liste(datenbank, """
                    SELECT n.nspname FROM pg_namespace n
                    WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
                      AND n.nspname NOT LIKE '\\_timescaledb%' AND n.nspname NOT LIKE 'timescaledb\\_%'
                      AND (n.nspname <> 'public'
                           OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid
                                      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                                      AND d.objid = c.oid AND d.deptype = 'e'))
                           OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = n.oid
                                      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                                      AND d.objid = p.oid AND d.deptype = 'e'))
                           OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typnamespace = n.oid
                                      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                                                      AND d.objid = t.oid AND d.deptype = 'e')))
                    UNION ALL
                    SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql', 'timescaledb')
                    """).isEmpty();
        }

        private boolean rollenImGrundzustand() {
            return liste("postgres", "SELECT rolname FROM pg_roles").stream()
                    .allMatch(r -> grundRollen.contains(r) || istVorlagenRolle(r));
        }

        private boolean istVorlage(String datenbank) {
            return vorlagen.values().stream().anyMatch(v -> v.datenbank.equals(datenbank));
        }

        private boolean istVorlagenRolle(String rolle) {
            return vorlagen.values().stream().anyMatch(v -> v.rollen.containsValue(rolle));
        }

        /** Alles an den Rollen außer Name und Passwort: Attribute, Einstellungen, Mitgliedschaften. */
        List<String> rollenAbbild(java.util.Collection<String> rollen) {
            if (rollen.isEmpty()) {
                return List.of();
            }
            String namen = rollen.stream().map(Cluster::literal).collect(Collectors.joining(","));
            return liste("postgres", """
                    SELECT concat_ws('|', r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb,
                                     r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
                                     r.rolvaliduntil,
                                     (SELECT string_agg(s.setdatabase || ':' || array_to_string(s.setconfig, ','),
                                                        ';' ORDER BY s.setdatabase)
                                      FROM pg_db_role_setting s WHERE s.setrole = r.oid),
                                     (SELECT string_agg(g.rolname || '>' || m.admin_option, ';' ORDER BY g.rolname)
                                      FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                                      WHERE m.member = r.oid),
                                     (SELECT string_agg(u.rolname, ';' ORDER BY u.rolname)
                                      FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
                                      WHERE m.roleid = r.oid))
                    FROM pg_roles r WHERE r.rolname IN (%s) ORDER BY r.oid
                    """.formatted(namen));
        }

        String url(String datenbank) {
            return "jdbc:postgresql://" + container.getHost() + ":" + container.getMappedPort(5432) + "/"
                    + datenbank + "?loggerLevel=OFF";
        }

        /**
         * {@code CREATE DATABASE} aus einer Vorlage, dann den TimescaleDB-Scheduler der neuen Datenbank
         * starten (wie bei POSTGRES_DB sofort, nicht erst mit der nächsten Abfrage des Launchers).
         */
        private void erzeuge(String name, String vorlage) {
            kopiere(name, vorlage);
            sql(name, "SELECT _timescaledb_functions.start_background_workers()");
        }

        /**
         * Kopieren aus {@code template1} scheitert mit 55006, solange der Launcher dort kurz einen
         * Scheduler anmeldet (der sich gleich wieder abmeldet) - dann noch einmal.
         */
        private void kopiere(String name, String vorlage) {
            for (int versuch = 1; ; versuch++) {
                try (Connection c = verbinde("postgres"); Statement s = c.createStatement()) {
                    s.execute("CREATE DATABASE " + ident(name) + " TEMPLATE " + ident(vorlage));
                    break;
                } catch (SQLException e) {
                    if (!"55006".equals(e.getSQLState()) || versuch == 50) {
                        throw new IllegalStateException("CREATE DATABASE " + name + " scheiterte", e);
                    }
                    try {
                        Thread.sleep(100);
                    } catch (InterruptedException unterbrochen) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(unterbrochen);
                    }
                }
            }
        }

        List<String> liste(String datenbank, String abfrage) {
            try (Connection c = verbinde(datenbank); Statement s = c.createStatement();
                    ResultSet r = s.executeQuery(abfrage)) {
                List<String> werte = new ArrayList<>();
                while (r.next()) {
                    werte.add(r.getString(1));
                }
                return werte;
            } catch (SQLException e) {
                throw new IllegalStateException(abfrage, e);
            }
        }

        void sql(String datenbank, String anweisung) {
            try (Connection c = verbinde(datenbank); Statement s = c.createStatement()) {
                s.execute(anweisung);
            } catch (SQLException e) {
                throw new IllegalStateException(anweisung, e);
            }
        }

        private Connection verbinde(String datenbank) throws SQLException {
            return DriverManager.getConnection(url(datenbank), SUPERUSER, SUPERUSER_PASSWORT);
        }

        private static String ident(String name) {
            return '"' + name.replace("\"", "\"\"") + '"';
        }

        private static String literal(String wert) {
            return "'" + wert.replace("'", "''") + "'";
        }
    }

    /** Eine fertig migrierte, schreibgeschützte Datenbank und ihre versteckten Rollen (echt → versteckt). */
    record Vorlage(String datenbank, Map<String, String> rollen, List<String> rollenAbbild) {
    }
}
