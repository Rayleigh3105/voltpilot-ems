package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.LocalDate;
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
 * Verbessern-Konzept v1, PR 2 (Entscheide 6 und 13): {@code V20261006213000} gibt der Maßnahme ihre Art
 * ({@code gemessen · nicht_gemessen · organisatorisch}) und die erwartete Einsparung in kWh im Jahr. Der Bestand bekommt
 * seine Art aus dem, was die Zeile schon sagt - auch eine verworfene Maßnahme -, sonst bleibt jede Spalte jeder Zeile
 * zeichengleich; das Vokabular wird nur geweitet; die Art ist nie änderbar, die Einsparung nur solange geplant; und die
 * Migration trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMassnahmeArtMigrationTest {

    private static final String DIESE = "20261006213000";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "vb_v1_pr2_test_pw";
    private static final OffsetDateTime AM_15_01_2028 = OffsetDateTime.parse("2028-01-15T10:00:00+01:00");
    private static final List<String> NEU = List.of("massnahme_art:1:gemessen", "massnahme_art:2:nicht_gemessen",
            "massnahme_art:3:organisatorisch");
    /** Die Ausgangslage von M-2028-0001 (R3) als kanonischer Text. */
    private static final String AUSGANGSLAGE = "{\"bezugsbasis\":\"BB-0001\",\"delta_prozent\":12.9,\"erwartet_kwh\":69098,"
            + "\"fassung\":1,\"gemessen_kwh\":78000,\"gemessen_version\":1,\"kennzahl\":\"KZ-0004\",\"monat\":\"2027-12\","
            + "\"urteil\":\"schlechter\"}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static UUID tenant, standort, kennzahl, basis;
    /** Die fünf Maßnahmen des Bestands - die übrigen Fälle legen in derselben Datenbank weitere an. */
    private static final List<UUID> BESTAND = new ArrayList<>();
    private static Map<String, String> fingerVorher, fingerNachher;
    private static String massnahmenVorher, massnahmenNachher;
    private static List<String> vokabularVorher;

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        bestand();
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of("massnahme"));
        massnahmenVorher = Bestandsschutz.inhaltOhne(root, "massnahme", "art");
        vokabularVorher = vokabular();
        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachher = Bestandsschutz.fingerabdruck(root, List.of("massnahme"));
        massnahmenNachher = Bestandsschutz.inhaltOhne(root, "massnahme", "art");
        flyway(POSTGRES.getJdbcUrl()).load().migrate();
    }

    /** Fünf Maßnahmen: mit Kennzahl (umgesetzt), von Hand, aus Feststellung, aus Audit (verworfen), aus Beschluss. */
    private static void bestand() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        for (String[] p : new String[][] {{"IK", "Ines Kaltenbach"}, {"MD", "Murat Demirci"}, {"JW", "Jonas Wendlinger"}}) {
            root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                    tenant, p[0], p[1]);
        }
        standort = UUID.randomUUID();
        root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'AHR', 'Europe/Berlin', 'aktiv')", standort, tenant, unternehmen);
        kennzahl = root.queryForObject("INSERT INTO kennzahl(tenant_id,kennzeichen,name,rechenform,geltung_art,"
                + "standort_id,verantwortlich_sub,verantwortlich_name) VALUES (?,'KZ-0004','Stromeinsatz Spritzguss je kg',"
                + "'quotient','standort',?,'IK','Ines Kaltenbach') RETURNING id", UUID.class, tenant, standort);
        basis = root.queryForObject("INSERT INTO bezugsbasis(tenant_id,kennzeichen,kennzahl_id,verantwortlich_sub,"
                + "verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,'BB-0001',?,"
                + "'IK','Ines Kaltenbach','benutzer','IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id",
                UUID.class, tenant, kennzahl);
        root.update("INSERT INTO bezugsbasis_fassung(tenant_id,bezugsbasis_id,fassung,referenzperiode,methode,datenlage,gilt_ab,"
                + "begruendung,actor_sub,actor_name,actor_rolle,actor_art,freigabe_status,freigabe_sub,freigabe_name,"
                + "freigabe_rolle,freigabe_art,freigabe_am,freigegeben_am) VALUES (?,?,1,'2026-10/2026-10','verhaeltnis',"
                + "'vorlaeufig','2026-11-01','Erste Energieleistungskennzahl: ein abgeschlossener Monat — vorläufig.',"
                + "'IK','Ines Kaltenbach','energiemanager','kunde','freigegeben','IK','Ines Kaltenbach','energiemanager',"
                + "'kunde','2026-11-12 10:00','2026-11-12 10:00')", tenant, basis);
        UUID gemessen = massnahme(mitKennzahl(Map.of()));
        BESTAND.add(gemessen);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = DATE '2028-01-22', umgesetzt_begruendung = "
                + "'Zeitschaltuhren an Maschinen 3–6 programmiert.', umgesetzt_gemeldet_am = TIMESTAMPTZ "
                + "'2028-01-22 16:00+01' WHERE id = ?", gemessen);
        BESTAND.add(massnahme(Map.of("titel", "Druckluft-Leckagen orten und beseitigen")));
        BESTAND.add(massnahme(Map.of("herkunft_art", "nichtkonformitaet", "herkunft_kennung", "F-2029-0001",
                "titel", "Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen")));
        UUID verworfen = massnahme(Map.of("herkunft_art", "audit", "herkunft_kennung", "AU-2029-0001",
                "titel", "Bekanntmachung der Energiepolitik im Werk Lindach wiederholen"));
        BESTAND.add(verworfen);
        root.update("UPDATE massnahme SET zustand = 'verworfen', verworfen_am = now(), verworfen_grund = "
                + "'Die Bekanntmachung ist schon im Intranet angekündigt.' WHERE id = ?", verworfen);
        BESTAND.add(massnahme(Map.of("herkunft_art", "managementbewertung", "herkunft_kennung", "BR-2029-0001/B2",
                "titel", "Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal")));
    }

    @Test
    void derBestandBekommtSeineArtAusDerZeile() {
        assertThat(root.queryForList("SELECT titel || ':' || zustand || ':' || art FROM massnahme WHERE id = ANY (?) "
                + "ORDER BY kennzeichen", String.class, (Object) BESTAND.toArray(new UUID[0]))).containsExactly(
                "Werkzeugheizungen in Betriebspausen abschalten:umgesetzt:gemessen",
                "Druckluft-Leckagen orten und beseitigen:geplant:nicht_gemessen",
                "Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen:geplant:organisatorisch",
                "Bekanntmachung der Energiepolitik im Werk Lindach wiederholen:verworfen:organisatorisch",
                "Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal:geplant:nicht_gemessen");
    }

    /** Außer der neuen Spalte `art` ändert sich keine Zeile - weder an der Maßnahme noch irgendwo sonst. */
    @Test
    void sonstBleibtDerBestandZeichengleich() {
        assertThat(massnahmenVorher).isNotEqualTo(Bestandsschutz.LEER).isEqualTo(massnahmenNachher);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachher)).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM massnahme WHERE id = ANY (?) AND ("
                + "erwartete_einsparung_kwh_jahr IS NOT NULL OR erwartete_einsparung_grundlage_kwh IS NOT NULL "
                + "OR erwartete_einsparung_grundlage_monate IS NOT NULL)", Integer.class,
                (Object) BESTAND.toArray(new UUID[0]))).isZero();
    }

    /** Die Wörter von vorher bleiben an ihrem Platz; dazu genau die Art, am Ende. */
    @Test
    void dasVokabularWirdNurGeweitet() {
        List<String> nachher = vokabular();
        assertThat(nachher.subList(0, vokabularVorher.size())).containsExactlyElementsOf(vokabularVorher);
        assertThat(nachher.subList(vokabularVorher.size(), nachher.size())).containsExactlyElementsOf(NEU);
        assertThat(root.queryForList("SELECT wort FROM verbesserung_vokabular() WHERE vokabular = 'massnahme_art' "
                + "ORDER BY nr", String.class)).containsExactlyElementsOf(VerbesserungRegeln.VOKABULARE.get("massnahme_art"));
    }

    /** Ein Schreibweg ohne Art bekommt dieselbe Ableitung wie der Bestand; eine genannte Art bleibt. */
    @Test
    void ohneArtLeitetDerAnlegeTriggerSieAb() {
        assertThat(art(massnahme(mitKennzahl(Map.of())))).isEqualTo("gemessen");
        assertThat(art(massnahme(Map.of()))).isEqualTo("nicht_gemessen");
        assertThat(art(massnahme(Map.of("herkunft_art", "audit", "herkunft_kennung", "AU-2029-0002"))))
                .isEqualTo("organisatorisch");
        assertThat(art(massnahme(Map.of("art", "organisatorisch")))).isEqualTo("organisatorisch");
    }

    /** Entscheid 6: gemessen genau mit Messgrundlage; ein fremdes Wort fällt durch. */
    @Test
    void gemessenGenauMitKennzahl() {
        checkFehler("massnahme_art_chk", () -> massnahme(Map.of("art", "gemessen")));
        checkFehler("massnahme_art_chk", () -> massnahme(mitKennzahl(Map.of("art", "nicht_gemessen"))));
        checkFehler("massnahme_art_chk", () -> massnahme(mitKennzahl(Map.of("art", "organisatorisch"))));
        checkFehler("massnahme_art_chk", () -> massnahme(Map.of("art", "geschaetzt")));
    }

    /**
     * Entscheid 13: ganze kWh, nie 0; mit Kennzahl nur mit Prozent und Grundlage; ohne Kennzahl nur weniger Energie und
     * ohne Grundlage; organisatorisch keine Zahl.
     */
    @Test
    void dieEinsparungFolgtDerArt() {
        UUID ohne = massnahme(Map.of("erwartete_einsparung_kwh_jahr", new BigDecimal("12000")));
        assertThat(root.queryForObject("SELECT erwartete_einsparung_kwh_jahr FROM massnahme WHERE id = ?", BigDecimal.class,
                ohne)).isEqualByComparingTo("12000");
        UUID mit = massnahme(mitKennzahl(Map.of("erwartete_einsparung_kwh_jahr", new BigDecimal("30512"),
                "erwartete_einsparung_grundlage_kwh", new BigDecimal("1017050"),
                "erwartete_einsparung_grundlage_monate", "2028-04/2029-03")));
        assertThat(art(mit)).isEqualTo("gemessen");
        // Mit Kennzahl darf die Umrechnung auch „mehr“ sagen (negativ), ohne Kennzahl nie.
        massnahme(mitKennzahl(Map.of("erwartete_wirkung_prozent", new BigDecimal("2.0"),
                "erwartete_einsparung_kwh_jahr", new BigDecimal("-20341"),
                "erwartete_einsparung_grundlage_kwh", new BigDecimal("1017050"),
                "erwartete_einsparung_grundlage_monate", "2028-04/2029-03")));
        for (Map<String, Object> falsch : List.of(
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("-500")),
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", BigDecimal.ZERO),
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("1200.5")),
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("1200"),
                        "erwartete_einsparung_grundlage_kwh", new BigDecimal("40000"),
                        "erwartete_einsparung_grundlage_monate", "2028-04/2029-03"),
                Map.<String, Object>of("art", "organisatorisch", "erwartete_einsparung_kwh_jahr", new BigDecimal("1200")))) {
            checkFehler("massnahme_einsparung_chk", () -> massnahme(falsch));
        }
        for (Map<String, Object> falsch : List.of(
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("30512")),
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("30512"),
                        "erwartete_einsparung_grundlage_kwh", new BigDecimal("1017050")),
                Map.<String, Object>of("erwartete_einsparung_kwh_jahr", new BigDecimal("30512"),
                        "erwartete_einsparung_grundlage_kwh", new BigDecimal("1017050"),
                        "erwartete_einsparung_grundlage_monate", "2028-04"))) {
            checkFehler("massnahme_einsparung_chk", () -> massnahme(mitKennzahl(falsch)));
        }
        // Mit Kennzahl, aber ohne Zahl der Person: nichts umzurechnen.
        checkFehler("massnahme_einsparung_chk", () -> massnahme(ohneProzent(mitKennzahl(Map.of(
                "erwartete_einsparung_kwh_jahr", new BigDecimal("30512"),
                "erwartete_einsparung_grundlage_kwh", new BigDecimal("1017050"),
                "erwartete_einsparung_grundlage_monate", "2028-04/2029-03")))));
    }

    /** Die Art bleibt für immer; die Einsparung ändert sich nur, solange die Maßnahme geplant ist. */
    @Test
    void artBleibtUndEinsparungNurSolangeGeplant() {
        UUID id = massnahme(Map.of("erwartete_einsparung_kwh_jahr", new BigDecimal("12000")));
        checkFehler("massnahme_art_bleibt", () -> root.update("UPDATE massnahme SET art = 'organisatorisch', "
                + "erwartete_einsparung_kwh_jahr = NULL WHERE id = ?", id));
        root.update("UPDATE massnahme SET erwartete_einsparung_kwh_jahr = 15000 WHERE id = ?", id);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = DATE '2028-01-22', umgesetzt_begruendung = "
                + "'Leckagen mit Ultraschall geortet und behoben.', umgesetzt_gemeldet_am = TIMESTAMPTZ "
                + "'2028-01-22 16:00+01' WHERE id = ?", id);
        checkFehler("massnahme_nur_geplant_aenderbar", () -> root.update(
                "UPDATE massnahme SET erwartete_einsparung_kwh_jahr = 16000 WHERE id = ?", id));
    }

    /** Die App-Rolle darf die Einsparung ändern (Schreibweg „Ändern“), die Art nie. */
    @Test
    void dieAppRolleAendertNurDieEinsparung() {
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'massnahme', 'erwartete_einsparung_kwh_jahr', "
                + "'UPDATE')", Boolean.class, APP)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'massnahme', 'art', 'UPDATE')", Boolean.class, APP))
                .isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'massnahme', 'art', 'INSERT')", Boolean.class, APP))
                .isTrue();
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-massnahme-art");
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
        for (String check : List.of("massnahme_art_chk", "massnahme_einsparung_chk")) {
            String sql = "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '" + check + "'";
            assertThat(spaetDb.queryForObject(sql, String.class)).as(check).isEqualTo(root.queryForObject(sql, String.class));
        }
        String woerter = "SELECT string_agg(vokabular || ':' || nr || ':' || wort, '|' ORDER BY vokabular, nr) "
                + "FROM verbesserung_vokabular()";
        assertThat(spaetDb.queryForObject(woerter, String.class)).isEqualTo(root.queryForObject(woerter, String.class));
        String trigger = "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'massnahme'::regclass "
                + "AND NOT tgisinternal";
        assertThat(spaetDb.queryForObject(trigger, String.class)).isEqualTo(root.queryForObject(trigger, String.class));
    }

    // ============================================================ Gerüst

    private static Map<String, Object> mitKennzahl(Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("titel", "Werkzeugheizungen in Betriebspausen abschalten");
        werte.put("herkunft_art", "abweichung");
        werte.put("herkunft_kennung", "AW-2028-0001");
        werte.put("standort_id", standort);
        werte.put("kennzahl_id", kennzahl);
        werte.put("bezugsbasis_id", basis);
        werte.put("fassung", 1);
        werte.put("ausgangslage", AUSGANGSLAGE);
        werte.put("ausgangslage_pruefsumme", root.queryForObject("SELECT bericht_pruefsumme(?)", String.class,
                AUSGANGSLAGE));
        werte.put("erwartete_wirkung_prozent", new BigDecimal("-3.0"));
        werte.putAll(spalten);
        return werte;
    }

    private static Map<String, Object> ohneProzent(Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>(spalten);
        werte.remove("erwartete_wirkung_prozent");
        return werte;
    }

    /** Eine Maßnahme am Unternehmen ohne Messgrundlage, verantwortlich Murat, angelegt am 15.01.2028. */
    private static UUID massnahme(Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", tenant);
        werte.put("titel", "Werkzeugheizungen in Betriebspausen abschalten");
        werte.put("verantwortlich_sub", "MD");
        werte.put("verantwortlich_name", "Murat Demirci");
        werte.put("verantwortlich_konto", "benutzer");
        werte.put("termin", LocalDate.parse("2028-01-31"));
        werte.put("herkunft_art", "von_hand");
        werte.put("erwartete_wirkung_wortlaut", "Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.");
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        werte.put("angelegt_am", AM_15_01_2028);
        werte.putAll(spalten);
        String sql = "INSERT INTO massnahme(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> "?").toList()) + ") RETURNING id";
        return root.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    private static String art(UUID massnahme) {
        return root.queryForObject("SELECT art FROM massnahme WHERE id = ?", String.class, massnahme);
    }

    private static List<String> vokabular() {
        return new ArrayList<>(root.queryForList("SELECT vokabular || ':' || nr || ':' || wort FROM verbesserung_vokabular()",
                String.class));
    }

    private static void checkFehler(String constraint, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet CHECK " + constraint).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo("23514");
        assertThat(ursache.getMessage() + " " + ((org.postgresql.util.PSQLException) ursache).getServerErrorMessage()
                .getConstraint()).contains(constraint);
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
