package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-19 IP-17 (W1, W4, W14; FS3, R10): {@code V20260925040000} weitet die Herkunft der Maßnahme um
 * {@code nichtkonformitaet · audit · managementbewertung}. Vorher lehnt {@code massnahme_herkunft_chk} die Zeile ab
 * ({@code CASE … ELSE false}), nachher nimmt er sie mit den Mustern F-/AU-/BR-…/Bn an; die Bestandsmaßnahmen und jede
 * andere Zeile bleiben zeichengleich (NW-5), das Vokabular wird nur geweitet, und die Migration trägt auch als späte
 * Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMassnahmeHerkunftMigrationTest {

    private static final String DIESE = "20260925040000";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ap19_ip17_test_pw";
    private static final OffsetDateTime AM_26_01_2029 = OffsetDateTime.parse("2029-01-26T10:00:00+01:00");
    private static final List<String> NEU = List.of("massnahme_herkunft:5:nichtkonformitaet", "massnahme_herkunft:6:audit",
            "massnahme_herkunft:7:managementbewertung");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static UUID tenant;
    private static Map<String, String> fingerVorher, fingerNachher;
    private static List<String> vokabularVorher;
    private static Throwable vorherAbgelehnt;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        // Bestand: M-2028-0001 aus der Abweichung AW-2028-0001, M-2028-0002 von Hand (R3, R7 in Kurzform).
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        root.update("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Kunststoffwerk Ahrenberg GmbH',"
                + "'Europe/Berlin')", tenant);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'JW','benutzer',"
                + "'Jonas Wendlinger','aktiv')", tenant);
        massnahme(Map.of("herkunft_art", "abweichung", "herkunft_kennung", "AW-2028-0001",
                "angelegt_am", OffsetDateTime.parse("2028-01-15T10:00:00+01:00")));
        massnahme(Map.of("angelegt_am", OffsetDateTime.parse("2028-01-20T10:00:00+01:00")));
        vorherAbgelehnt = catchThrowable(() -> massnahme(Map.of("herkunft_art", "nichtkonformitaet",
                "herkunft_kennung", "F-2029-0001")));
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        vokabularVorher = vokabular();
        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();
    }

    @Test
    void vorherLehntDerCheckDieFeststellungAb() {
        assertThat(vorherAbgelehnt).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) vorherAbgelehnt).getMostSpecificCause();
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo("23514");
        assertThat(ursache.getMessage()).contains("massnahme_herkunft_chk");
    }

    /** NW-5: die Migration ändert keine Zeile — die zwei Bestandsmaßnahmen sind zeichengleich. */
    @Test
    void derBestandBleibtZeichengleich() {
        assertThat(fingerVorher.get("massnahme")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachher)).isEmpty();
        assertThat(root.queryForList("SELECT kennzeichen || ':' || herkunft_art || ':' || coalesce(herkunft_kennung, '-') "
                + "FROM massnahme WHERE tenant_id = ? AND kennzeichen LIKE 'M-2028-%' ORDER BY kennzeichen", String.class, tenant))
                .containsExactly("M-2028-0001:abweichung:AW-2028-0001", "M-2028-0002:von_hand:-");
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /** W4: die Wörter von vorher bleiben an ihrem Platz; dazu genau die drei Herkünfte, am Ende. */
    @Test
    void dasVokabularWirdNurGeweitet() {
        List<String> nachher = vokabular();
        assertThat(nachher.subList(0, vokabularVorher.size())).containsExactlyElementsOf(vokabularVorher);
        assertThat(nachher.subList(vokabularVorher.size(), nachher.size())).containsExactlyElementsOf(NEU);
        assertThat(root.queryForList("SELECT wort FROM verbesserung_vokabular() WHERE vokabular = 'massnahme_herkunft' "
                + "ORDER BY nr", String.class)).containsExactlyElementsOf(VerbesserungRegeln.VOKABULARE
                .get("massnahme_herkunft"));
    }

    /** FS3/W4: jede neue Herkunft mit genau ihrem Muster; die Existenz prüft der Schreibweg (W14). */
    @Test
    void nachherNimmtDerCheckDieDreiHerkuenfteMitIhremMusterAn() {
        for (String[] ok : new String[][] {{"nichtkonformitaet", "F-2029-0001"}, {"audit", "AU-2029-0001"},
            {"managementbewertung", "BR-2029-0001/B2"}}) {
            UUID id = massnahme(Map.of("herkunft_art", ok[0], "herkunft_kennung", ok[1]));
            assertThat(root.queryForObject("SELECT herkunft_kennung FROM massnahme WHERE id = ?", String.class, id))
                    .isEqualTo(ok[1]);
        }
        for (String[] falsch : new String[][] {{"nichtkonformitaet", null}, {"nichtkonformitaet", "AU-2029-0001"},
            {"audit", "F-2029-0001"}, {"managementbewertung", "BR-2029-0001"}, {"managementbewertung", "BR-2029-0001/2"},
            {"feststellung", "F-2029-0001"}, {"von_hand", "F-2029-0001"}}) {
            Map<String, Object> spalten = new LinkedHashMap<>();
            spalten.put("herkunft_art", falsch[0]);
            spalten.put("herkunft_kennung", falsch[1]);
            Throwable fehler = catchThrowable(() -> massnahme(spalten));
            assertThat(fehler).as(Arrays.toString(falsch)).isInstanceOf(DataAccessException.class);
            assertThat(((DataAccessException) fehler).getMostSpecificCause().getMessage()).as(Arrays.toString(falsch))
                    .contains("massnahme_herkunft_chk");
        }
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-herkunft");
        try (var dateien = Files.list(Path.of("src", "main", "resources", "db", "migration"))) {
            for (Path datei : dateien.toList()) {
                if (!datei.getFileName().toString().startsWith("V" + DIESE + "__")) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        flyway(url).locations("filesystem:" + ohneDiese).load().migrate();
        var spaet = flyway(url).outOfOrder(true).load().migrate();
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactly(DIESE);
        JdbcTemplate spaetDb = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        String check = "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'massnahme_herkunft_chk'";
        assertThat(spaetDb.queryForObject(check, String.class)).isEqualTo(root.queryForObject(check, String.class));
        String woerter = "SELECT string_agg(vokabular || ':' || nr || ':' || wort, '|' ORDER BY vokabular, nr) "
                + "FROM verbesserung_vokabular()";
        assertThat(spaetDb.queryForObject(woerter, String.class)).isEqualTo(root.queryForObject(woerter, String.class));
    }

    // ============================================================ Gerüst

    /** Eine Maßnahme ohne Messgrundlage am Unternehmen, verantwortlich Jonas, angelegt am 26.01.2029. */
    private static UUID massnahme(Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", tenant);
        werte.put("titel", "Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen");
        werte.put("verantwortlich_sub", "JW");
        werte.put("verantwortlich_name", "Jonas Wendlinger");
        werte.put("verantwortlich_konto", "benutzer");
        werte.put("termin", java.sql.Date.valueOf("2029-02-28"));
        werte.put("herkunft_art", "von_hand");
        werte.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt.");
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.put("angelegt_am", AM_26_01_2029);
        werte.putAll(spalten);
        String sql = "INSERT INTO massnahme(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return root.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    private static List<String> vokabular() {
        return new ArrayList<>(root.queryForList("SELECT vokabular || ':' || nr || ':' || wort FROM verbesserung_vokabular()",
                String.class));
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway(POSTGRES.getJdbcUrl()).load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN, "adminDbPassword", PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
