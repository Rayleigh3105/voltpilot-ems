package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
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
 * Der Bestandsschutz der Bezugsbasis (UEMS AP-17 IP-25, NW-5, R10, §6.10): ein Bestandskunde, der keine Bezugsbasis
 * anlegt, merkt nichts — der Rollout ändert keine Zeile seines Bestands, und weder Kaskade noch Struktur-Läufer noch
 * Wetter-Abruf schreiben etwas für die Bezugsbasis, mit Schalter an und aus.
 *
 * <p><b>Der Bestand</b> ist Werk Ahrenberg aus dem Demo-Seed ({@code infra/local/seed/ahrenberg.sql}) auf der Fassung VOR
 * der ersten AP-17-Migration ({@code V20260924071500}), dazu das, was AP-17 danach liest oder berührt: eine Kennzahl
 * KZ-0003 ohne Bezugsbasis (R10), eine Bezugsgröße BZ-1 mit einem Monatswert (die Tabelle {@code bezugsgroesse_wert}
 * bekommt mit {@code V20260924192700} drei leere Spalten), eine Gradtagzahl am Standort ohne Wetterbezug, zwei
 * Protokollzeilen, die Pfad 2 des Anstoßes lesen würde ({@code ort_aenderung} korrigiert, {@code bezugsgroesse_aenderung}
 * bearbeitet), und ein Monatsbericht (die Tabelle {@code bericht} bekommt mit {@code V20260924211800} die leere Spalte
 * {@code kennzahl_id}). Danach laufen ALLE späteren Migrationen — die AP-17-Migrationen sind die jüngsten Versionen, der
 * Lauf ist also zugleich die frische Reihenfolge und die späte Ankunft.
 *
 * <p><b>Was sich außerhalb der neuen Tabellen ändern DARF, steht mit Namen da:</b> nichts an einer Zeile. Neue Tabellen
 * ({@link #NEUE_TABELLEN}) müssen leer, neue Spalten in jeder Bestandszeile NULL sein ({@link Bestandsschutz}). Die neue
 * Vorlage {@code leistungsvergleich} und die neuen Wörter sind Funktionen ({@code bericht_vorlage()},
 * {@code bericht_vokabular()}, {@code bezugsdaten_vokabular()}), keine Tabellenzeilen: jedes Wort von vorher steht nachher
 * mit derselben Nummer da, hinzu kommen nur die hier genannten.
 *
 * <p><b>Die Schalter</b> {@value BezugsbasisAnstoss#SCHALTER} und {@code voltpilot.uems.wetter-archiv.enabled} lesen nur
 * die Naht und die Läufer ({@link UemsBezugsbasisFlagArchitekturTest}); hier laufen Struktur-Läufer und Anstoß mit Schalter
 * an und aus über denselben Bestand und schreiben beide Male nichts für die Bezugsbasis. Wie der Schalter bei einer ECHTEN
 * freigegebenen Fassung beide Pfade schweigen lässt (Wasserzeichen {@code abgeschaltet}), beweist
 * {@code UemsBezugsbasisAnstossTest}; dass Kennzahl-Übersicht und Vergleich ohne Basis nur den Satz zeigen,
 * {@code BezugsbasisPflegeApiTest} und {@code BezugsbasisVergleichApiTest} (R10).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsbasisBestandsschutzTest {

    /** Die erste Migration von AP-17 (IP-6); der Bestand entsteht auf der Fassung davor. */
    private static final String ERSTE_AP17 = "20260924071500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");

    private static final UUID KB = UUID.fromString("20000000-0000-0000-0000-000000000001");
    private static final UUID UNTERNEHMEN = UUID.fromString("20000000-0000-0000-0000-000000000010");
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1");
    private static final UUID HALLE_1 = UUID.fromString("20000000-0000-0000-0000-000000000101");

    /** Die Tabellen, die AP-17 anlegt — bei einem Bestandskunden ohne Bezugsbasis bleiben sie leer. */
    private static final List<String> NEUE_TABELLEN = List.of("bezugsbasis", "bezugsbasis_aenderung",
            "bezugsbasis_anstoss", "bezugsbasis_faktor", "bezugsbasis_fassung", "bezugsbasis_kennzeichen_seq",
            "bezugsbasis_struktur_gelesen", "bezugsbasis_variable", "bezugsgroesse_wetterbezug");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static Map<String, String> vorher;
    private static Map<String, String> nachher;
    private static Map<String, TreeSet<String>> woerterVorher;
    private static long ortKorrektur;
    private static long bezugBearbeitet;

    @BeforeAll
    static void bestandUndRollout() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVor(ERSTE_AP17)).load().migrate();
        assertThat(tabelleDa("bezugsbasis")).as("der Bestand entsteht vor AP-17").isFalse();
        bestand();
        jobsAus();
        vorher = Bestandsschutz.fingerabdruck(root, List.of());
        woerterVorher = woerter();

        flyway().load().migrate();
        jobsAus();
        nachher = Bestandsschutz.fingerabdruck(root, List.of());
    }

    // ============================================================ der Rollout

    @Test
    void derRolloutLaesstDenBestandByteGleich() {
        for (String t : List.of("kennzahl", "bezugsgroesse", "bezugsgroesse_wert", "bezugsgroesse_aenderung", "bericht",
                "ort_aenderung", "benutzer")) {
            assertThat(vorher.get(t)).as("der Bestand hat Zeilen in " + t).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(vorher, nachher))
                .as("jede Bestandstabelle byte-gleich, neue Spalten leer (bericht.kennzahl_id, bezugsgroesse_wert.bezug_*)")
                .isEmpty();
        assertThat(nachher.keySet()).containsAll(vorher.keySet());
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE kennzahl_id IS NOT NULL", Integer.class))
                .as("kein Bestandsbericht zitiert eine Kennzahl").isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezug_quelle IS NOT NULL "
                + "OR abgerufen_am IS NOT NULL OR bezug_herkunft IS NOT NULL", Integer.class))
                .as("kein Bestandswert trägt eine Wetter-Herkunft").isZero();
    }

    @Test
    void dieNeuenTabellenSindDaUndLeer() {
        for (String tabelle : NEUE_TABELLEN) {
            assertThat(vorher).as(tabelle + " kommt erst mit AP-17").doesNotContainKey(tabelle);
            assertThat(nachher.get(tabelle)).as(tabelle + " nach dem Rollout").isEqualTo(Bestandsschutz.LEER);
        }
        List<String> neu = new ArrayList<>(nachher.keySet());
        neu.removeAll(vorher.keySet());
        neu.removeIf(t -> t.startsWith(Bestandsschutz.KATALOG_METADATEN + "@"));
        assertThat(neu).as("AP-17 legt genau diese Tabellen an").containsExactlyInAnyOrderElementsOf(NEUE_TABELLEN);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE vorlage = 'leistungsvergleich'",
                Integer.class)).as("kein Leistungsvergleich entsteht von selbst").isZero();
    }

    /** Die neue Vorlage und die neuen Wörter: additiv, jedes Wort von vorher mit derselben Nummer. */
    @Test
    void vorlageUndVokabulareWachsenNurUmDieGenanntenWoerter() {
        Map<String, TreeSet<String>> jetzt = woerter();
        Map<String, List<String>> erwartet = Map.of(
                "bericht_vorlage", List.of("leistungsvergleich|unternehmen|monat",
                        "leistungsvergleich|unternehmen|jahr", "leistungsvergleich|unternehmen|datengrundlage",
                        "leistungsvergleich|standort|monat", "leistungsvergleich|standort|jahr",
                        "leistungsvergleich|standort|datengrundlage"),
                "bericht_vokabular", List.of("vorlage|6|leistungsvergleich", "quelle_art|10|bezugsbasis"),
                "bezugsdaten_vokabular", List.of("herkunft_art|5|bezogen|"));
        woerterVorher.forEach((funktion, alt) -> {
            TreeSet<String> dazu = new TreeSet<>(jetzt.get(funktion));
            assertThat(dazu).as(funktion + ": jedes Wort von vorher bleibt, mit derselben Nummer").containsAll(alt);
            dazu.removeAll(alt);
            assertThat(dazu).as(funktion + ": nur die genannten Wörter kommen dazu")
                    .containsExactlyInAnyOrderElementsOf(erwartet.get(funktion));
        });
    }

    // ============================================================ die Läufer und die Schalter

    /**
     * R10 Schritt 2 und 3: Pfad 2 des Anstoßes liest nur Protokollzeilen eines Kundenbereichs, der eine VOR ihnen
     * freigegebene Fassung hat — der Bestand hat keine, also setzt der Struktur-Läufer kein Bezugsbasis-Wasserzeichen,
     * weder mit Schalter an noch aus. Er liest weiter, was er vor AP-17 las (die Ortskorrektur für die Berichte, AP-12).
     */
    @Test
    void keinLaeuferSchreibtFuerDieBezugsbasis_mitSchalterAnUndAus() {
        BerichtAbzugBildung bildung = new BerichtAbzugBildung(new MeasurementCatalog(new ObjectMapper()),
                new ObjectMapper(), new BerichtRegelwerk("VoltPilot Test", Map.of("bericht", "1.1")));
        BerichtKaskade kaskade = new BerichtKaskade(bildung);
        StrukturAenderungLaeufer laeufer = new StrukturAenderungLaeufer(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)),
                kaskade, 200);
        BezugsbasisAnstoss anstoss = new BezugsbasisAnstoss();
        assertThat(ReflectionTestUtils.getField(anstoss, "eingeschaltet")).as("Vorgabe AN").isEqualTo(true);
        laeufer.bezugsbasis(anstoss);
        Map<String, String> vorLauf = Bestandsschutz.fingerabdruck(root, List.of());

        StrukturAenderungLaeufer.Lauf an = laeufer.lauf(Instant.parse("2026-11-20T09:05:00Z"));
        assertThat(an.gescheitert()).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_struktur_gelesen", Integer.class))
                .as("ohne freigegebene Fassung kein Wasserzeichen, auch nicht für die Bezugsgröße %d", bezugBearbeitet)
                .isZero();
        assertThat(root.queryForList("SELECT protokoll || '-' || eintrag_id FROM bericht_struktur_gelesen", String.class))
                .as("das einzige Wasserzeichen gehört AP-12").containsExactly("ort_aenderung-" + ortKorrektur);
        Map<String, String> nachLauf = Bestandsschutz.fingerabdruck(root, List.of());
        assertThat(Bestandsschutz.abweichungen(vorLauf, nachLauf))
                .containsExactly("bericht_struktur_gelesen: bestehender Inhalt geändert");

        ReflectionTestUtils.setField(anstoss, "eingeschaltet", false);
        StrukturAenderungLaeufer.Lauf aus = laeufer.lauf(Instant.parse("2026-11-20T09:10:00Z"));
        assertThat(aus.gescheitert()).isEmpty();
        assertThat(aus.gelesen()).as("Schalter aus, zweiter Takt").isZero();
        assertThat(BezugsbasisAnstoss.mitSchalter(true).strukturLauf(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)),
                Instant.parse("2026-11-20T09:15:00Z"), 200).gelesen()).as("Pfad 2 allein, Schalter an").isZero();
        assertThat(Bestandsschutz.abweichungen(nachLauf, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("weder der zweite Takt noch der Schalter schreiben etwas").isEmpty();
    }

    /** Der Wetter-Abruf fragt ohne Wetterbezug kein Archiv und schreibt nichts — die Gradtagzahl des Bestands bleibt. */
    @Test
    void derWetterAbrufFragtOhneWetterbezugNichtsAn() {
        Map<String, String> vorLauf = Bestandsschutz.fingerabdruck(root, List.of());
        WetterArchiv nieGefragt = (breite, laenge, von, bis, zone) -> {
            throw new AssertionError("ohne Wetterbezug fragt der Abruf kein Archiv");
        };
        WetterArchivAbruf.Lauf l = new WetterArchivAbruf(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)), new ObjectMapper(),
                nieGefragt).lauf(Instant.parse("2026-11-20T05:10:00Z"));
        assertThat(l.bezuege()).isZero();
        assertThat(l.geschrieben()).isZero();
        assertThat(Bestandsschutz.abweichungen(vorLauf, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
    }

    /** Beißt der Vergleich auf diesem Bestand? Eine geänderte Zeile, eine Spalte mit Wert, eine Tabelle mit Inhalt. */
    @Test
    void mutationsprobe() {
        Bestandsschutz.mutationsprobe(root, List.of(), "bezugsgroesse",
                "UPDATE bezugsgroesse SET name = name || ' (Probe)' WHERE kennzeichen = 'BZ-1'");
        Bestandsschutz.mutationsprobe(root, List.of(), "kennzahl",
                "UPDATE kennzahl SET name = name || ' (Probe)' WHERE kennzeichen = 'KZ-0003'");
    }

    // ============================================================ der Bestand (Fassung vor AP-17)

    private static void bestand() throws Exception {
        try (Connection con = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = con.createStatement()) {
            s.execute(Files.readString(SEED));
        }
        assertThat(root.queryForObject("SELECT count(*) FROM standort WHERE tenant_id = ?", Integer.class, KB))
                .as("der Seed läuft auf der Fassung vor AP-17").isPositive();

        root.update("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, unternehmen_id, "
                + "verantwortlich_sub, verantwortlich_name) VALUES (?, 'KZ-0003', 'Energie je Kilogramm', 'quotient', "
                + "'unternehmen', ?, 'kc-ines-kaltenbach', 'Ines Kaltenbach')", KB, UNTERNEHMEN);
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, unternehmen_id) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 'kg', "
                + "'monat', 'unternehmen', ?) RETURNING id", UUID.class, KB, UNTERNEHMEN);
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', "
                + "1, 'erstwert', 'wirksam', 412000, 'eingabe', 'kc-ines-kaltenbach', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde')", KB, bz1, Date.valueOf("2026-08-01"), Date.valueOf("2026-08-31"));
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, art, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, 'BZ-2', 'Gradtagzahl', 'gradtagzahl', 'periodenwert', 'Kd', "
                + "'monat', 'standort', ?)", KB, ST1);
        bezugBearbeitet = root.queryForObject("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, "
                + "alt, neu, gilt_ab, rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, ?, "
                + "'bearbeitet', '{\"einheit\":\"t\"}'::jsonb, '{\"einheit\":\"kg\"}'::jsonb, ?, false, "
                + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'kunde', ?) RETURNING id", Long.class, KB, bz1,
                Timestamp.from(Instant.parse("2026-11-03T09:00:00Z")), Timestamp.from(Instant.parse("2026-11-03T09:00:00Z")));
        ortKorrektur = root.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu, "
                + "gilt_ab, rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, 'gebaeude', ?, "
                + "'korrigiert', '{}'::jsonb, '{}'::jsonb, ?, false, 'kc-jonas-wendlinger', 'Jonas Wendlinger', 'kunde', ?) "
                + "RETURNING id", Long.class, KB, HALLE_1, Date.valueOf(LocalDate.parse("2026-10-01")),
                Timestamp.from(Instant.parse("2026-11-03T09:30:00Z")));
        root.update("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, standort_id, "
                + "zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach')",
                KB, ST1);
    }

    /** Die Wörter der Vokabular-Funktionen, die AP-17 neu fasst — je Zeile alle Spalten, mit Nummer. */
    private static Map<String, TreeSet<String>> woerter() {
        return Map.of(
                "bericht_vorlage", zeilen("SELECT concat_ws('|', vorlage, geltung_art, zeitraum_art) FROM bericht_vorlage()"),
                "bericht_vokabular", zeilen("SELECT concat_ws('|', vokabular, nr, wort) FROM bericht_vokabular()"),
                "bezugsdaten_vokabular", zeilen("SELECT concat_ws('|', vokabular, nr, wort, coalesce(groesse, '')) "
                        + "FROM bezugsdaten_vokabular()"));
    }

    private static TreeSet<String> zeilen(String sql) {
        return new TreeSet<>(root.queryForList(sql, String.class));
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
