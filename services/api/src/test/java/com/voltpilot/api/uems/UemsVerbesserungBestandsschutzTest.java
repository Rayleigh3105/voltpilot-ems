package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
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
 * Der Bestandsschutz der Verbesserung (UEMS AP-18 IP-21, NW-5, R13, Invariante 6): ein Bestandskunde, der kein
 * Energieziel, keine Maßnahme und keine Abweichung anlegt, merkt nichts — der Rollout ändert keine Zeile seines Bestands,
 * kein Wert, keine Fassung, kein Bericht ändert sich, und die Naht schreibt weder ohne Energieleistungskennzahl noch mit
 * Schalter aus etwas.
 *
 * <p><b>Der Bestand</b> ist Werk Ahrenberg aus dem Demo-Seed ({@code infra/local/seed/ahrenberg.sql}, Fassung 1.4 — W14)
 * auf der Fassung VOR der ersten AP-18-Migration ({@code V20260924223000}), dazu das, was AP-18 danach liest: eine
 * Kennzahl KZ-0003 OHNE Bezugsbasis mit einem endgültigen Monatswert (ein Kunde ohne Energieleistungskennzahl), eine
 * Energieleistungskennzahl KZ-0004 mit freigegebener Bezugsbasis BB-0001 Fassung 1 und endgültigem Monatswert (ein
 * AP-17-Kunde, der AP-18 nicht benutzt) und ein Monatsbericht. Danach laufen die Migrationen bis zur letzten von AP-18
 * ({@link #LETZTE_AP18}, Abdruck für „genau diese Tabellen und Vokabulare“) und dann ALLE späteren (AP-19 ff.) — der
 * Bestand bleibt auch über sie byte-gleich.
 *
 * <p><b>Was sich außerhalb der neuen Tabellen ändern DARF, steht mit Namen da:</b> nichts. AP-18 legt nur daneben
 * ({@link #NEUE_TABELLEN}, leer) und hängt an keine Bestandstabelle eine Spalte; die Wörter stehen in einer eigenen
 * Funktion {@code verbesserung_vokabular()} — jedes Vokabular von vorher hat nachher dieselben Zeilen.
 *
 * <p><b>Der Schalter</b> {@value VerbesserungNaht#SCHALTER} liest nur die Naht ({@link UemsVerbesserungFlagArchitekturTest}:
 * keine Route, kein DTO, kein Portal) — darum antworten die Routen mit Schalter aus wie mit Schalter an (R13 Schritt 2).
 * Hier laufen alle drei Eingänge der Naht (Auffälligkeit, Anstoß Pfad 1, Anstoß Pfad 2) mit Schalter an und aus über
 * denselben Bestand und schreiben beide Male nichts. Wie der Schalter bei einer ECHTEN schlechteren Kennzahl schweigt,
 * beweist {@code VerbesserungNahtTest}; dass Register und Übersicht ohne Vorgang nur den Leer-Satz zeigen, die
 * {@code *ApiTest} der drei Objekte.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsVerbesserungBestandsschutzTest {

    /** Die erste Migration von AP-18 (IP-5); der Bestand entsteht auf der Fassung davor. */
    private static final String ERSTE_AP18 = "20260924223000";
    /**
     * Die letzte Migration von AP-18 (IP-15, Grant der Auffälligkeit). „Genau diese Tabellen“ und „kein Vokabular ändert
     * sich“ gelten für AP-18 und werden auf DIESEM Stand gemessen — spätere Programme (AP-19 ff.) legen danach eigene
     * Tabellen und Wörter an und haben dafür ihren eigenen Bestandsschutz. Der Rollout bis zum neuesten Stand prüft danach
     * weiter, dass die Bestandszeilen byte-gleich bleiben, die AP-18-Tabellen leer und kein Wort verschwindet.
     */
    private static final String LETZTE_AP18 = "20260925002000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** Der Takt nach dem Endgültigwerden des Dezembers 2026 (R1: am 7. des Folgemonats). */
    private static final Instant JETZT = Instant.parse("2027-01-07T09:00:00Z");

    private static final UUID KB = UUID.fromString("20000000-0000-0000-0000-000000000001");
    private static final UUID UNTERNEHMEN = UUID.fromString("20000000-0000-0000-0000-000000000010");
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1");
    /** Ines Kaltenbach im Seed — die Bezugsbasis bindet ihren Verantwortlichen per Fremdschlüssel an {@code benutzer}. */
    private static final String INES = "20000000-0000-0000-0000-0000000008a2";

    /** Die Tabellen, die AP-18 anlegt — bei einem Bestandskunden ohne Vorgang bleiben sie leer. */
    private static final List<String> NEUE_TABELLEN = List.of("abweichung", "abweichung_aenderung", "auffaelligkeit",
            "energieziel", "energieziel_aenderung", "massnahme", "massnahme_aenderung", "massnahme_bewertung",
            "verbesserung_kennung_seq", "vorgang_anstoss");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static Map<String, String> vorher;
    private static Map<String, String> bisAp18;
    private static Map<String, String> nachher;
    private static Map<String, TreeSet<String>> vokabulareVorher;
    private static Map<String, TreeSet<String>> vokabulareBisAp18;
    private static UUID kz3;
    private static UUID kz4;
    private static UUID bb1;

    @BeforeAll
    static void bestandUndRollout() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVor(ERSTE_AP18)).load().migrate();
        assertThat(tabelleDa("energieziel")).as("der Bestand entsteht vor AP-18").isFalse();
        bestand();
        jobsAus();
        vorher = Bestandsschutz.fingerabdruck(root, List.of());
        vokabulareVorher = vokabulare();

        flyway().target(LETZTE_AP18).load().migrate();
        jobsAus();
        bisAp18 = Bestandsschutz.fingerabdruck(root, List.of());
        vokabulareBisAp18 = vokabulare();

        flyway().load().migrate();
        jobsAus();
        nachher = Bestandsschutz.fingerabdruck(root, List.of());
    }

    // ============================================================ der Rollout

    @Test
    void derRolloutLaesstDenBestandByteGleich() {
        for (String t : List.of("kennzahl", "kennzahl_fassung", "kennzahl_wert", "bezugsbasis", "bezugsbasis_fassung",
                "bericht", "benutzer")) {
            assertThat(vorher.get(t)).as("der Bestand hat Zeilen in " + t).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(vorher, bisAp18)).as("AP-18: jede Bestandstabelle byte-gleich").isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, nachher))
                .as("bis zum neuesten Stand: kein Wert, keine Fassung, kein Bericht ändert sich").isEmpty();
        assertThat(nachher.keySet()).containsAll(vorher.keySet());
    }

    @Test
    void dieNeuenTabellenSindDaUndLeer() {
        for (String tabelle : NEUE_TABELLEN) {
            assertThat(vorher).as(tabelle + " kommt erst mit AP-18").doesNotContainKey(tabelle);
            assertThat(nachher.get(tabelle)).as(tabelle + " nach dem Rollout").isEqualTo(Bestandsschutz.LEER);
        }
        try (var dateien = Files.list(MIGRATIONEN)) {
            assertThat(dateien.map(d -> d.getFileName().toString()))
                    .as("die letzte AP-18-Migration").anyMatch(n -> n.startsWith("V" + LETZTE_AP18 + "__"));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        List<String> neu = new ArrayList<>(bisAp18.keySet());
        neu.removeAll(vorher.keySet());
        neu.removeIf(t -> t.startsWith(Bestandsschutz.KATALOG_METADATEN + "@"));
        assertThat(neu).as("AP-18 legt genau diese Tabellen an").containsExactlyInAnyOrderElementsOf(NEUE_TABELLEN);
        assertThat(nachher.keySet()).as("spätere Programme nehmen keine AP-18-Tabelle weg").containsAll(bisAp18.keySet());
    }

    /**
     * Die Wörter: AP-18 bringt sein eigenes Vokabular ({@code verbesserung_vokabular()}) und fasst kein bestehendes neu —
     * gemessen am Endstand von AP-18 ({@link #LETZTE_AP18}); danach verliert kein Wort seinen Platz.
     */
    @Test
    void keinBestehendesVokabularAendertSich() {
        assertThat(vokabulareVorher).as("der Bestand kennt die Vokabulare von AP-11/AP-12/AP-16/AP-17")
                .containsKeys("bericht_vokabular", "bericht_vorlage", "bezugsdaten_vokabular")
                .doesNotContainKey("verbesserung_vokabular");
        List<String> neu = new ArrayList<>(vokabulareBisAp18.keySet());
        neu.removeAll(vokabulareVorher.keySet());
        assertThat(neu).as("AP-18 legt genau ein Vokabular an").containsExactly("verbesserung_vokabular");
        assertThat(vokabulareBisAp18.get("verbesserung_vokabular")).isNotEmpty();
        Map<String, TreeSet<String>> neuester = vokabulare();
        vokabulareVorher.forEach((funktion, alt) -> {
            assertThat(vokabulareBisAp18.get(funktion)).as(funktion + ": AP-18 ändert kein Wort").isEqualTo(alt);
            assertThat(neuester.get(funktion)).as(funktion + ": kein Wort verschwindet oder wird umnummeriert")
                    .containsAll(alt);
        });
    }

    // ============================================================ die Naht und der Schalter

    /**
     * R13 Schritt 1 und 2: die drei Eingänge der Naht über den Bestand — der endgültige Dezember beider Kennzahlen
     * (Auffälligkeit), dieselben Monate als Version n + 1 (Anstoß Pfad 1) und das Ende von BB-0001 (Anstoß Pfad 2). Ohne
     * Energieleistungskennzahl vermerkt die Naht nichts, ohne Vorgang stößt sie nichts an; mit Schalter aus schweigt sie
     * auch an der Energieleistungskennzahl. Kein Aufruf ändert eine Zeile.
     */
    @Test
    void dieNahtSchreibtNichts_mitSchalterAnUndAus() throws Exception {
        VerbesserungNaht naht = new VerbesserungNaht(null, null, new ObjectMapper());
        assertThat(ReflectionTestUtils.getField(naht, "eingeschaltet")).as("Vorgabe AN").isEqualTo(true);
        KennzahlLauf.Neu dez3 = dezember(kz3, "KZ-0003", 1);
        KennzahlLauf.Neu dez4 = dezember(kz4, "KZ-0004", 1);
        Map<String, String> vorLauf = Bestandsschutz.fingerabdruck(root, List.of());

        try (Connection con = ds(ADMIN_USER, ADMIN_PW).getConnection()) {
            con.setAutoCommit(false);
            // Schalter an: ohne freigegebene Fassung kein Vergleich, also kein Vermerk (der Kennzahl-Leser wird nie gefragt).
            assertThat(naht.vermerken(con, KB, List.of(dez3), JETZT)).as("KZ-0003 ohne Bezugsbasis").isEmpty();
            assertThat(naht.anstossen(con, KB, "K-2027-0001", List.of(dezember(kz3, "KZ-0003", 2),
                    dezember(kz4, "KZ-0004", 2)), JETZT)).as("Pfad 1 ohne Maßnahme und Energieziel").isEmpty();
            assertThat(naht.messgrundlage(con, KB, bb1, "bezugsbasis_beendet", 1L, JETZT))
                    .as("Pfad 2 ohne Vorgang an BB-0001").isEmpty();

            ReflectionTestUtils.setField(naht, "eingeschaltet", false);
            assertThat(naht.vermerken(con, KB, List.of(dez3, dez4), JETZT))
                    .as("Schalter aus: auch an der Energieleistungskennzahl KZ-0004 kein Vermerk").isEmpty();
            assertThat(naht.anstossen(con, KB, "K-2027-0001", List.of(dez4), JETZT)).isEmpty();
            assertThat(naht.messgrundlage(con, KB, bb1, "bezugsbasis_beendet", 1L, JETZT)).isEmpty();
            con.commit();
        }
        assertThat(Bestandsschutz.abweichungen(vorLauf, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("weder Naht noch Schalter schreiben etwas").isEmpty();
        for (String tabelle : NEUE_TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle, Integer.class)).as(tabelle).isZero();
        }
    }

    /**
     * Beißt der Vergleich auf diesem Bestand? Eine geänderte Zeile an der Energieleistungskennzahl und am Standort (Wert,
     * Fassung und Bericht schützen ihre Zeilen per Trigger — dort geht keine Probe).
     */
    @Test
    void mutationsprobe() {
        Bestandsschutz.mutationsprobe(root, List.of(), "kennzahl",
                "UPDATE kennzahl SET name = name || ' (Probe)' WHERE kennzeichen = 'KZ-0004'");
        Bestandsschutz.mutationsprobe(root, List.of(), "standort",
                "UPDATE standort SET name = name || ' (Probe)' WHERE id = '" + ST1 + "'");
    }

    // ============================================================ der Bestand (Fassung vor AP-18)

    private static void bestand() throws Exception {
        try (Connection con = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = con.createStatement()) {
            s.execute(Files.readString(SEED));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM standort WHERE tenant_id = ?", Integer.class, KB))
                .as("der Seed läuft auf der Fassung vor AP-18").isPositive();
        assertThat(root.queryForObject("SELECT count(*) FROM benutzer WHERE tenant_id = ?", Integer.class, KB))
                .as("die Personen des Seeds").isPositive();

        kz3 = kennzahl("KZ-0003", "Energie je Kilogramm");
        kz4 = kennzahl("KZ-0004", "Strom je Kilogramm Spritzguss");
        wert(kz3, "0.41");
        wert(kz4, "0.46");
        bb1 = root.queryForObject("INSERT INTO bezugsbasis (tenant_id, kennzeichen, kennzahl_id, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, "
                + "'BB-0001', ?, ?, 'Ines Kaltenbach', 'benutzer', ?, "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde') RETURNING id", UUID.class, KB, kz4, INES, INES);
        root.update("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, methode, "
                + "datenlage, gilt_ab, begruendung, actor_sub, actor_name, actor_rolle, actor_art, freigabe_status, "
                + "freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) VALUES (?, ?, 1, "
                + "'2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', '2026-11-01', 'Erste Energieleistungskennzahl: ein "
                + "abgeschlossener Monat — vorläufig.', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', "
                + "'freigegeben', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', '2026-11-12 10:00', "
                + "'2026-11-12 10:00')", KB, bb1, INES, INES);
        root.update("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-12', 'Europe/Berlin', 'Ines Kaltenbach')",
                KB, ST1);
    }

    private static UUID kennzahl(String kennzeichen, String name) {
        UUID kz = root.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, "
                + "unternehmen_id, verantwortlich_sub, verantwortlich_name) VALUES (?, ?, ?, 'quotient', 'unternehmen', ?, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach') RETURNING id", UUID.class, KB, kennzeichen, name, UNTERNEHMEN);
        root.update("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, herkunft, actor_sub, "
                + "actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, 'quotient', 'anlage', 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', 'kWh/kg')", KB, kz);
        return kz;
    }

    /** Der endgültige Dezember 2026 (Version 1, endgültig ab 07.01.2027). */
    private static void wert(UUID kennzahl, String wert) {
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, richtung, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?::numeric, "
                + "?::numeric * 412000, 412000, 'vollständig', NULL, '[]'::jsonb, 'endgueltig', ?, ?, ?)", KB, kennzahl,
                Date.valueOf("2026-12-01"), Date.valueOf("2026-12-31"), wert, wert,
                Timestamp.from(Instant.parse("2027-01-06T23:00:00Z")), fassung,
                Timestamp.from(Instant.parse("2027-01-01T01:20:00Z")));
    }

    private static KennzahlLauf.Neu dezember(UUID kennzahl, String kennzeichen, int version) {
        return new KennzahlLauf.Neu(kennzahl, kennzeichen, "monat", LocalDate.parse("2026-12-01"),
                LocalDate.parse("2026-12-31"), BERLIN, version);
    }

    /** Jede Vokabular-Funktion ohne Argument ({@code *_vokabular()}, {@code bericht_vorlage()}) mit allen Zeilen. */
    private static Map<String, TreeSet<String>> vokabulare() {
        Map<String, TreeSet<String>> aus = new TreeMap<>();
        for (String f : root.queryForList("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                + "WHERE n.nspname = 'public' AND p.pronargs = 0 AND p.proretset "
                + "AND (p.proname LIKE '%\\_vokabular' OR p.proname = 'bericht_vorlage')", String.class)) {
            aus.put(f, new TreeSet<>(root.queryForList("SELECT v::text FROM " + f + "() v", String.class)));
        }
        return aus;
    }

    private static boolean tabelleDa(String tabelle) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT to_regclass(?) IS NOT NULL", Boolean.class, tabelle));
    }

    private static void jobsAus() {
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
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
