package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Regression guard for the production outage where the api crash-looped on a VM
 * running {@code SPRING_PROFILES_ACTIVE=local}: the dev fleet/earnings seeds
 * (V20260706020000 / V20260706030000) referenced the demo tenant
 * {@code 00000000-...-0001} unconditionally, and on a DB where that tenant row
 * is absent (offboarded, or never seeded) the site insert violated
 * {@code site_tenant_id_fkey} (SQLSTATE 23503) and Flyway aborted startup.
 *
 * <p>Reproduces that exact state - dev migration chain applied through
 * V20260706010000, demo tenant then deleted - and asserts the later dev seeds
 * now migrate cleanly as no-ops while an untouched tenant keeps its data.
 * The happy path (fresh DB gets the full demo fleet) stays covered by
 * {@link RlsIsolationTest} and {@code PortalApiTest}.
 *
 * <p>Seit AP-00 IP-7 / AP-02 IP-16 wacht dieselbe Klasse auch über die
 * Demo-Daten des Referenzunternehmens „Kunststoffwerk Ahrenberg GmbH"
 * ({@code infra/local/seed/ahrenberg.sql}): sie laufen gegen dieselbe, dann
 * vollständig migrierte Wegwerf-Datenbank — ohne den lokalen Stack des
 * Entwicklers anzufassen. Die Reihenfolge ist Absicht: der Bestandsfall oben
 * braucht eine NOCH NICHT vollständig migrierte Datenbank und lässt sie
 * vollständig migriert zurück, was der Ahrenberg-Fall genau braucht.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class DevSeedGuardTest {

    private static final String DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
    /** Der dritte Kundenbereich; dieselbe Kennung trägt das Realm-Attribut des Logins `ahrenberg`. */
    private static final String AHRENBERG_TENANT = "20000000-0000-0000-0000-000000000001";
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    @Order(1)
    void devSeedsNoOpCleanlyWhenTheDemoTenantIsAbsent() throws Exception {
        // 1. Apply everything up to (and including) V20260706010000 - V100 has
        //    seeded the demo tenants at this point, the fleet seed is pending.
        flyway().target("20260706010000").load().migrate();

        // 2. The VM's state: the demo tenant row is gone (site/device/asset
        //    cascade with it) before the fleet seed ever ran.
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute("DELETE FROM tenant WHERE id = '" + DEMO_TENANT + "'");
        }

        // 3. The rest of the chain (fleet seed, earnings seed, later core
        //    migrations) must apply cleanly - this exact call failed with
        //    SQLSTATE 23503 on site_tenant_id_fkey before the guards.
        flyway().load().migrate();

        // 4. The guarded seeds no-oped: no fleet rows for the absent tenant
        //    (rollup rows from V100's Berlin telemetry pre-date the delete and
        //    stay - hypertables have no FK - so scope to the seeded site ids),
        //    no dev-seed prices, while tenant B's V100 data is untouched.
        String fleetSites = "('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000022')";
        assertThat(count("SELECT count(*) FROM site WHERE tenant_id = '" + DEMO_TENANT + "'")).isZero();
        assertThat(count("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM schedule WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM day_ahead_prices WHERE source = 'dev-seed'")).isZero();
        assertThat(count("SELECT count(*) FROM site WHERE name = 'Nordwind Hamburg'")).isEqualTo(1L);
    }

    /**
     * AP-00 IP-7 + AP-02 IP-16: der Ahrenberg-Seed läuft gegen eine vollständig
     * migrierte Datenbank ein, ist idempotent, trifft NICHTS außerhalb seines
     * Kundenbereichs — und stimmt Zeile für Zeile mit der Referenzdatei überein.
     *
     * <p>Der Stichtag ist {@code unternehmen.momentaufnahme} der Referenz
     * (20.10.2026 10:15): an ihm sind genau die Boxen in Betrieb, die der Seed
     * schreibt. Die zeitgültigen Tabellen tragen dagegen den ganzen Verlauf,
     * auch den künftigen (Flächenänderung G-2 zum 01.01.2027).
     */
    @Test
    @Order(2)
    void ahrenbergSeedIstIdempotentUndSchreibtDieReferenzAb() throws Exception {
        JsonNode ref = new ObjectMapper().readTree(REFERENZ.toFile());
        String seed = Files.readString(SEED);

        // 1. Was außerhalb von Ahrenberg steht, darf der Seed nicht anfassen.
        String fremd = fingerabdruckOhneAhrenberg();

        // 2. Zweimal einspielen: der zweite Lauf scheitert nicht und ändert nichts.
        assertThatCode(() -> ausfuehren(seed)).doesNotThrowAnyException();
        String nachDemErsten = fingerabdruckAhrenberg();
        assertThatCode(() -> ausfuehren(seed)).doesNotThrowAnyException();
        assertThat(fingerabdruckAhrenberg()).isEqualTo(nachDemErsten);
        assertThat(fingerabdruckOhneAhrenberg()).isEqualTo(fremd);

        // 3. Die Zählungen und Kennzeichen sind die der Referenz.
        assertThat(texte("SELECT kurzzeichen FROM standort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("standorte")));
        assertThat(texte("SELECT kurzzeichen FROM ort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND art = 'gebaeude' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("gebaeude")));
        assertThat(texte("SELECT kurzzeichen FROM ort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND art = 'bereich' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("bereiche")));
        assertThat(texte("SELECT name FROM site WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY name")).isEqualTo(sortiert(ref.path("anlagen"), "name"));
        assertThat(count("SELECT count(*) FROM unternehmen WHERE tenant_id = '" + AHRENBERG_TENANT + "'"))
                .isEqualTo(1L);

        // Die Boxen: genau die, die am Stichtag der Referenz in Betrieb sind.
        assertThat(texte("SELECT external_ref FROM device WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY external_ref")).isEqualTo(boxenAmStichtag(ref));

        // 4. Jede Fläche und jede Zuordnung: Wert, „gültig ab" und „gültig bis".
        for (JsonNode st : ref.path("standorte")) {
            assertThat(flaechen("standort_id", st.path("kennzeichen").asText()))
                    .as("Bezugsflächen " + st.path("kennzeichen").asText())
                    .isEqualTo(sollFlaechen(st));
        }
        for (JsonNode g : ref.path("gebaeude")) {
            assertThat(flaechen("ort_id", g.path("kennzeichen").asText()))
                    .as("Bezugsflächen " + g.path("kennzeichen").asText())
                    .isEqualTo(sollFlaechen(g));
        }
        for (JsonNode z : ref.path("zuordnungen")) {
            String art = z.path("art").asText();
            String von = z.path("von").asText();
            if ("ort_eltern".equals(art) && !von.startsWith("ST-")) {
                assertThat(text("SELECT coalesce(e.kurzzeichen, s.kurzzeichen) || ' ab ' || zu.gueltig_ab"
                        + " FROM ort_zuordnung zu JOIN ort o ON o.id = zu.ort_id"
                        + " LEFT JOIN ort e ON e.id = zu.eltern_ort_id"
                        + " LEFT JOIN standort s ON s.id = zu.eltern_standort_id"
                        + " WHERE zu.tenant_id = '" + AHRENBERG_TENANT + "' AND o.kurzzeichen = '" + von + "'"))
                        .as("Ortsbaum " + von)
                        .isEqualTo(z.path("nach").asText() + " ab " + z.path("gueltig_ab").asText());
            } else if ("anlage_standort".equals(art)) {
                String anlage = anlagenname(ref, von);
                assertThat(text("SELECT s.kurzzeichen || ' ab ' || a.gueltig_ab FROM anlage_standort a"
                        + " JOIN site si ON si.id = a.site_id JOIN standort s ON s.id = a.standort_id"
                        + " WHERE a.tenant_id = '" + AHRENBERG_TENANT + "' AND si.name = '" + anlage + "'"))
                        .as("Anlage " + von)
                        .isEqualTo(z.path("nach").asText() + " ab " + z.path("gueltig_ab").asText());
            }
        }

        // 5. Werk Lindach hat AUSDRÜCKLICH keine eigene Bezugsfläche (Referenz ST-2):
        //    die 2 600 m² entstehen erst im Leseweg als Summe der Gebäude.
        assertThat(count("SELECT count(*) FROM flaeche_gueltigkeit f JOIN standort s ON s.id = f.standort_id"
                + " WHERE s.kurzzeichen = 'ST-2' AND f.tenant_id = '" + AHRENBERG_TENANT + "'")).isZero();

        // 6. Rechte-Zaun: für einen anderen Kundenbereich ist Ahrenberg unsichtbar.
        try (Connection app = DriverManager.getConnection(POSTGRES.getJdbcUrl(), APP_USER, APP_PW);
                Statement s2 = app.createStatement()) {
            s2.execute("SET app.tenant_id = '10000000-0000-0000-0000-000000000001'");
            for (String tabelle : List.of("standort", "ort", "ort_zuordnung", "flaeche_gueltigkeit",
                    "anlage_standort", "unternehmen", "site", "device")) {
                try (ResultSet rs = s2.executeQuery("SELECT count(*) FROM " + tabelle
                        + " WHERE tenant_id = '" + AHRENBERG_TENANT + "'")) {
                    rs.next();
                    assertThat(rs.getLong(1)).as("RLS " + tabelle).isZero();
                }
            }
        }
    }

    /**
     * Der Seed ist BEWUSST keine Flyway-Migration: unter {@code db/dev} läge er in jedem
     * Testlauf unter den Testklassen mit {@code @ActiveProfiles("local")} und änderte still
     * deren Ausgangslage — der Bestandsschutz verlangt das Gegenteil. Unter
     * {@code infra/local/timescale} liefe er vor Flyway, wo es die UEMS-Tabellen noch nicht gibt.
     */
    @Test
    @Order(3)
    void derAhrenbergSeedIstKeineMigrationUndKeinInitSkript() {
        assertThat(SEED).exists();
        assertThat(Path.of("services", "api", "src", "main", "resources", "db", "dev",
                "ahrenberg.sql")).doesNotExist();
        assertThat(Path.of("..", "..", "infra", "local", "timescale", "ahrenberg.sql")).doesNotExist();
    }

    // -------------------------------------------------------------------------

    private void ausfuehren(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    /** Alle Ahrenberg-Zeilen der berührten Tabellen als EIN Text — der Vergleich für „ändert nichts". */
    private String fingerabdruckAhrenberg() throws Exception {
        return abdruck("=");
    }

    private String fingerabdruckOhneAhrenberg() throws Exception {
        return abdruck("<>");
    }

    /** `tenant` trägt den Kundenbereich in `id`, jede andere Tabelle in `tenant_id`. */
    private String abdruck(String vergleich) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (String tabelle : List.of("tenant", "unternehmen", "standort", "ort", "ort_zuordnung",
                "flaeche_gueltigkeit", "anlage_standort", "site", "device", "ort_kurzzeichen")) {
            String spalte = "tenant".equals(tabelle) ? "id" : "tenant_id";
            sb.append(tabelle).append('=')
                    .append(text("SELECT coalesce(string_agg(t.z, '|' ORDER BY t.z), '-') FROM ("
                            + "SELECT x::text AS z FROM " + tabelle + " x WHERE x." + spalte + " " + vergleich
                            + " '" + AHRENBERG_TENANT + "') t"))
                    .append('\n');
        }
        return sb.toString();
    }

    private List<String> kennzeichen(JsonNode liste) {
        return sortiert(liste, "kennzeichen");
    }

    private List<String> sortiert(JsonNode liste, String feld) {
        Set<String> s = new LinkedHashSet<>();
        liste.forEach(n -> s.add(n.path(feld).asText()));
        return s.stream().sorted().toList();
    }

    /** Die Boxen, die am Stichtag der Referenz in Betrieb sind — E-2′ kommt erst am 04.11.2026. */
    private List<String> boxenAmStichtag(JsonNode ref) {
        OffsetDateTime stichtag = OffsetDateTime.parse(ref.path("unternehmen").path("momentaufnahme").asText());
        List<String> refs = new ArrayList<>();
        for (JsonNode b : ref.path("boxen")) {
            OffsetDateTime ab = OffsetDateTime.parse(b.path("in_betrieb_ab").asText());
            JsonNode aus = b.path("ausgebaut_am");
            boolean nochDa = aus.isNull() || aus.isMissingNode()
                    || OffsetDateTime.parse(aus.asText()).isAfter(stichtag);
            if (!ab.isAfter(stichtag) && nochDa) {
                refs.add(b.path("seriennummer").asText());
            }
        }
        return refs.stream().sorted().toList();
    }

    private String anlagenname(JsonNode ref, String kennzeichen) {
        for (JsonNode a : ref.path("anlagen")) {
            if (kennzeichen.equals(a.path("kennzeichen").asText())) {
                return a.path("name").asText();
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Referenz");
    }

    /** „m2 ab … bis …" je Objekt, in der Reihenfolge von „gültig ab". */
    private List<String> flaechen(String spalte, String kurzzeichen) throws Exception {
        String tabelle = "standort_id".equals(spalte) ? "standort" : "ort";
        return texte("SELECT f.m2 || ' ab ' || f.gueltig_ab || ' bis ' || coalesce(f.gueltig_bis::text, 'offen')"
                + " FROM flaeche_gueltigkeit f JOIN " + tabelle + " o ON o.id = f." + spalte
                + " WHERE f.tenant_id = '" + AHRENBERG_TENANT + "' AND o.kurzzeichen = '" + kurzzeichen + "'"
                + " ORDER BY f.gueltig_ab");
    }

    private List<String> sollFlaechen(JsonNode objekt) {
        List<String> soll = new ArrayList<>();
        for (JsonNode f : objekt.path("bezugsflaechen")) {
            JsonNode bis = f.path("gueltig_bis");
            soll.add(f.path("flaeche_m2").asInt() + " ab " + LocalDate.parse(f.path("gueltig_ab").asText())
                    + " bis " + (bis.isNull() || bis.isMissingNode() ? "offen" : bis.asText()));
        }
        return soll;
    }

    private List<String> texte(String sql) throws Exception {
        List<String> werte = new ArrayList<>();
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            while (rs.next()) {
                werte.add(rs.getString(1));
            }
        }
        return werte;
    }

    private String text(String sql) throws Exception {
        List<String> werte = texte(sql);
        assertThat(werte).as(sql).hasSize(1);
        return werte.get(0);
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private long count(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
