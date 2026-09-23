package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Date;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Bestandsschutz der energetischen Bewertung (UEMS AP-16 IP-27, NW-5, R11, Meilenstein M4): ein Bestandskunde, der
 * keinen Energieeinsatz anlegt, merkt nichts — der Rollout ändert keine Zeile seines Bestands, und kein Läufer schreibt
 * etwas für die Bewertung.
 *
 * <p><b>Der Bestand</b> ist Werk Ahrenberg aus dem Demo-Seed ({@code infra/local/seed/ahrenberg.sql}: Mandant, Unternehmen,
 * Standorte, Orte, Anlagen, Personen, Zugriffe, Funktionen) auf der Fassung VOR der ersten AP-16-Migration, dazu das, was
 * AP-16 danach liest oder berührt: MS-12 mit Prozess P-1, eine rückwirkende Prozess-Zuordnung
 * ({@code prozesse_zugeordnet} — die liest der Struktur-Läufer seit IP-23), eine Ortskorrektur (AP-12-Stoff für denselben
 * Läufer) und ein Monatsbericht (die Tabelle {@code bericht} bekommt mit {@code V20260922251800} eine Spalte mit Vorgabe).
 * Danach laufen ALLE späteren Migrationen, auch {@code V20260922236000} (AP-07 IP-18b), die dazwischen liegt.
 *
 * <p><b>Was sich außerhalb der neuen Tabellen ändern DARF, steht mit Namen da:</b> {@code bericht.wiedervorlage_monate}
 * ({@code NOT NULL DEFAULT 12}) — die Frist liest sie nur für die Vorlage {@code energetische_bewertung}
 * ({@code BerichtController} gibt sie für andere Vorlagen als {@code null} aus). Neue Tabellen müssen leer, neue Spalten in
 * jeder Bestandszeile NULL sein ({@link Bestandsschutz}). Die neue Vorlage ist eine Funktion ({@code bericht_vorlage()}),
 * keine Tabellenzeile.
 *
 * <p><b>Das Flag</b> {@code voltpilot.uems.bewertung.enabled} schaltet nur die Naht und den Läufer
 * ({@link UemsBewertungFlagArchitekturTest}); hier läuft der Läufer mit Flag an und aus über denselben Bestand und schreibt
 * beide Male nichts für die Bewertung. Wie das Flag bei einer ECHTEN Bewertung beide Pfade schweigen lässt, beweist
 * {@code UemsStrukturAenderungTest.bewertungKorrekturUndFassungenStossenAn_ohneBewertungUndBeiFlagAusSchweigtDerLaeufer}.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBewertungBestandsschutzTest {

    /** Die erste Migration von AP-16 (IP-3); der Bestand entsteht auf der Fassung davor. */
    private static final String ERSTE_AP16 = "20260922210000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    private static final UUID KB = UUID.fromString("20000000-0000-0000-0000-000000000001");
    private static final UUID UNTERNEHMEN = UUID.fromString("20000000-0000-0000-0000-000000000010");
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1");
    private static final UUID HALLE_1 = UUID.fromString("20000000-0000-0000-0000-000000000101");
    private static final LocalDate OKT_AB = LocalDate.parse("2026-10-01");

    /** Die Tabellen, die AP-16 anlegt — bei einem Bestandskunden ohne Energieeinsatz bleiben sie leer. */
    private static final List<String> NEUE_TABELLEN = List.of("bewertung_aenderung", "bewertung_kriterien_fassung",
            "bewertung_umfang", "bewertung_umfang_ausschluss", "bewertung_umfang_standort", "energieeinsatz",
            "energieeinsatz_aenderung", "energieeinsatz_einflussgroesse", "energieeinsatz_einstufung",
            "energieeinsatz_kennzeichen_seq", "geraet_aenderung", "messbedarf", "messbedarf_aenderung",
            "messbedarf_kennzeichen_seq", "vergleich_toleranz");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static Map<String, String> vorher;
    private static String berichtVorher;
    private static Map<String, String> nachher;
    private static long prozessZuordnung;
    private static long ortKorrektur;

    @BeforeAll
    static void bestandUndRollout() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVor(ERSTE_AP16)).load().migrate();
        bestand();
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
        vorher = Bestandsschutz.fingerabdruck(root, List.of());
        berichtVorher = Bestandsschutz.inhalt(root, "bericht", null);

        flyway().load().migrate();
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
        nachher = Bestandsschutz.fingerabdruck(root, List.of());
    }

    // ============================================================ der Rollout

    @Test
    void derRolloutLaesstDenBestandByteGleich_nurDieWiedervorlageDesBerichtsTraegtIhreVorgabe() {
        assertThat(vorher.get("bericht")).as("der Bestand hat einen Bericht").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(vorher.get("messstelle_aenderung")).as("… und Protokollzeilen für den Läufer")
                .isNotEqualTo(Bestandsschutz.LEER);
        assertThat(vorher.get("benutzer")).as("… und die Personen aus dem Seed").isNotEqualTo(Bestandsschutz.LEER);

        assertThat(Bestandsschutz.abweichungen(vorher, nachher))
                .as("außer der neuen Spalte mit Vorgabe ist jede Bestandstabelle byte-gleich")
                .containsExactly("bericht: bestehender Inhalt geändert");
        assertThat(Bestandsschutz.inhaltOhne(root, "bericht", "wiedervorlage_monate"))
                .as("der Bericht ohne die neue Spalte").isEqualTo(berichtVorher);
        assertThat(root.queryForList("SELECT DISTINCT wiedervorlage_monate FROM bericht", Integer.class))
                .as("jede Bestandszeile trägt die Vorgabe").containsExactly(12);
        assertThat(nachher.keySet()).containsAll(vorher.keySet());
    }

    @Test
    void dieNeuenTabellenSindDaUndLeer() {
        for (String tabelle : NEUE_TABELLEN) {
            assertThat(vorher).as(tabelle + " kommt erst mit AP-16").doesNotContainKey(tabelle);
            assertThat(nachher.get(tabelle)).as(tabelle + " nach dem Rollout").isEqualTo(Bestandsschutz.LEER);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE vorlage = 'energetische_bewertung'",
                Integer.class)).as("keine Bewertung entsteht von selbst").isZero();
    }

    // ============================================================ die Läufer und das Flag

    /**
     * R11 Schritt 2 und 4: der Struktur-Läufer liest nach dem Rollout nur, was er schon vor AP-16 las — die Ortskorrektur
     * (AP-12). Die rückwirkende Prozess-Zuordnung wird erst Kandidat, wenn es eine Bewertung gibt; ein zweiter Takt, mit
     * Flag an oder aus, schreibt nichts mehr.
     */
    @Test
    void keinLaeuferSchreibtFuerDieBewertung_mitFlagAnUndAus() throws Exception {
        BerichtAbzugBildung bildung = new BerichtAbzugBildung(new MeasurementCatalog(new ObjectMapper()),
                new ObjectMapper(), new BerichtRegelwerk("VoltPilot Test", Map.of("bericht", "1.1")));
        BerichtKaskade kaskade = new BerichtKaskade(bildung);
        StrukturAenderungLaeufer laeufer = new StrukturAenderungLaeufer(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)),
                kaskade, 200);
        assertThat(ReflectionTestUtils.getField(laeufer, "bewertungEnabled")).as("Vorgabe AN").isEqualTo(true);
        assertThat(ReflectionTestUtils.getField(kaskade, "bewertungEnabled")).as("Vorgabe AN").isEqualTo(true);

        StrukturAenderungLaeufer.Lauf an = laeufer.lauf(Instant.parse("2026-11-20T09:05:00Z"));
        assertThat(an.gescheitert()).isEmpty();
        assertThat(an.gelesen()).as("nur die Ortskorrektur (AP-12)").isEqualTo(1);
        assertThat(an.berichte()).isZero();
        assertThat(root.queryForList("SELECT protokoll || '-' || eintrag_id FROM bericht_struktur_gelesen", String.class))
                .as("das einzige Wasserzeichen gehört AP-12").containsExactly("ort_aenderung-" + ortKorrektur);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_struktur_gelesen WHERE protokoll = "
                + "'messstelle_aenderung' AND eintrag_id = ?", Integer.class, prozessZuordnung))
                .as("die rückwirkende Prozess-Zuordnung bleibt ohne Bewertung ungelesen").isZero();
        Map<String, String> nachLauf = Bestandsschutz.fingerabdruck(root, List.of());
        assertThat(Bestandsschutz.abweichungen(nachher, nachLauf)).containsExactly(
                "bericht_struktur_gelesen: bestehender Inhalt geändert");

        assertThat(laeufer.lauf(Instant.parse("2026-11-20T09:10:00Z")).gelesen()).as("zweiter Takt, Flag an").isZero();
        ReflectionTestUtils.setField(laeufer, "bewertungEnabled", false);
        ReflectionTestUtils.setField(kaskade, "bewertungEnabled", false);
        StrukturAenderungLaeufer.Lauf aus = laeufer.lauf(Instant.parse("2026-11-20T09:15:00Z"));
        assertThat(aus.gescheitert()).isEmpty();
        assertThat(aus.gelesen()).as("Flag aus").isZero();
        assertThat(Bestandsschutz.abweichungen(nachLauf, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("weder der zweite Takt noch das Flag schreiben etwas").isEmpty();
    }

    // ============================================================ der Bestand (Fassung vor AP-16)

    private static void bestand() throws Exception {
        try (Connection con = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = con.createStatement()) {
            s.execute(Files.readString(SEED));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM standort WHERE tenant_id = ?", Integer.class, KB))
                .as("der Seed läuft auf der Fassung vor AP-16").isPositive();

        JsonNode referenz = new ObjectMapper().readTree(Files.readString(REFERENZ));
        JsonNode m = eintrag(referenz.path("messstellen"), "MS-12");
        JsonNode h = m.path("hauptgroesse");
        UUID ms12 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-12', ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, KB,
                m.path("name").asText(), m.path("art").asText(), m.path("medium").asText(), h.path("groesse").asText(),
                h.path("richtung").asText(), h.path("einheit").asText(), h.path("wertart").asText());
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, gueltig_ab) VALUES (?, ?, ?, ?)", KB,
                ms12, HALLE_1, Date.valueOf(OKT_AB));
        UUID p1 = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "created_by) VALUES (?, ?, 'P-1', ?, ?, 'test') RETURNING id", UUID.class, KB, UNTERNEHMEN,
                eintrag(referenz.path("prozesse"), "P-1").path("name").asText(), Date.valueOf(OKT_AB));
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, ?, 'test')", KB, ms12, p1, Date.valueOf(OKT_AB));
        prozessZuordnung = root.queryForObject("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, alt, neu, "
                + "gilt_ab, rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, "
                + "'prozesse_zugeordnet', '{\"prozesse\":[]}'::jsonb, '{\"prozesse\":[\"P-1\"]}'::jsonb, ?, true, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?) RETURNING id", Long.class, KB,
                ms12, Timestamp.from(Instant.parse("2026-09-30T22:00:00Z")),
                Timestamp.from(Instant.parse("2026-11-03T09:00:00Z")));
        ortKorrektur = root.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu, "
                + "gilt_ab, rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, 'gebaeude', ?, 'korrigiert', "
                + "'{}'::jsonb, '{}'::jsonb, ?, false, 'kc-jonas-wendlinger', 'Jonas Wendlinger', 'kunde', ?) "
                + "RETURNING id", Long.class, KB, HALLE_1, Date.valueOf(OKT_AB),
                Timestamp.from(Instant.parse("2026-11-03T09:30:00Z")));
        root.update("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach')",
                KB, ST1);
    }

    private static JsonNode eintrag(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new IllegalStateException(kennzeichen);
    }

    private static String letzteFassungVor(String version) throws IOException {
        BigInteger diese = new BigInteger(version);
        try (var dateien = Files.list(MIGRATIONEN)) {
            return dateien.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("V") && n.contains("__"))
                    .map(n -> n.substring(1, n.indexOf("__")))
                    .filter(v -> v.matches("[0-9]+") && new BigInteger(v).compareTo(diese) < 0)
                    .max(Comparator.comparing(BigInteger::new))
                    .orElseThrow();
        }
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
