package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260911200000} (UEMS AP-04 IP-10) gegen eine echte TimescaleDB: das
 * Gerät als Objekt — Einbau, Karten, zeitgültige Speisung der Komponenten — und die Ableitung
 * für den Bestand.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-10): nach der Migration hat JEDE Komponente genau
 * ein laufendes Gerät; der Hybrid-Wechselrichter speist seine komponierten Geschwister nach
 * den Regeln, die der Code heute hat; ein erneuter Lauf legt nichts an; der Zaun steht; die
 * Bestandstabellen bleiben zeichengleich. Dazu die Constraints (auf die Minute, ein Einbau je
 * Gerät und Zeitpunkt, ein Gerät je Komponente und Zeitpunkt, Karten nur am Controller, eine
 * Karte je Steckplatz), die Rechte der App-Rolle und das Offboarding.
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen ({@code uems-referenzunternehmen.json}):
 * die Bestands-Komponenten K-1, K-3 … K-7 der Anlage AN-1 kommen mit Namen, Verbindung (die
 * Datenquellen DQ-1 … DQ-3 mit ihren Geräte-IDs) und Beginn aus der Datei — und die Ableitung
 * muss ihnen genau die Geräte GR-1 … GR-6 der Datei geben. K-2 (Speicher „über K-1 gemeldet")
 * ist heute keine eigene Zeile: Wechselrichter und Speicher eines Hybrids sind EINE
 * {@code battery-hybrid}-Komponente. Die übrigen Fälle (komponierte Geschwister, Seriennummern
 * je Vorlage) laufen in einem neutralen Probe-Kundenbereich, der kein Ahrenberg-Objekt vorgibt.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsGeraetMigrationTest {

    private static final String DIESE = "20260911200000";
    private static final String DATEI = "V20260911200000__uems_geraet.sql";
    /** Die Nacharbeit: die Regel je Komponente, der Anlege-Weg (Trigger) und die umgeschriebene Ableitung. */
    private static final String ANLEGEWEG = "V20260911240000__uems_geraet_anlegeweg.sql";

    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN =
            List.of("geraet", "geraet_teil", "geraet_komponente", "geraet_kennzeichen_seq");
    /** Was das Portal über Komponenten, Anlagen und Boxen liest — die Migration schreibt nur daneben. */
    private static final List<String> BESTAND = List.of("measurement_point", "site", "device",
            "component_definition", "telemetry_v2_rollup_1d");

    private static final UUID AHRENBERG = UUID.fromString("4e0a0000-0000-0000-0000-000000000001");
    private static final UUID PROBE = UUID.fromString("4e0a0000-0000-0000-0000-000000000002");
    /** Die Ahrenberg-Komponenten der Anlage AN-1 in der Reihenfolge ihrer Zeilen-Kennung. */
    private static final List<String> AN1 = List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7");
    private static final Map<String, String> ART_DER_REFERENZ = Map.of(
            "K-1", "battery-hybrid", "K-3", "grid-meter", "K-4", "modbus-generic",
            "K-5", "modbus-generic", "K-6", "modbus-generic", "K-7", "modbus-generic");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;

    /** Kennzeichen der Komponente (K-1 …, oder der Probe-Name) → Zeilen-Kennung. */
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();
    private static Map<String, Map<String, String>> bestandVorher;
    private static Map<String, Map<String, String>> bestandNachher;
    /** Je Komponente ihre Speisungen, direkt nach DIESER Fassung. */
    private static Map<UUID, List<Map<String, Object>>> speisungenNachDerMigration;
    /** Je Gerät seine Zeile, direkt nach DIESER Fassung. */
    private static Map<UUID, Map<String, Object>> geraeteNachDerMigration;
    private static Map<UUID, Integer> zaehlerNachDerMigration;
    private static long komponentenGesamt;
    private static long teileNachDerMigration;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        bestandVorher = schnappschuesse();

        flyway().target(DIESE).load().migrate();
        bestandNachher = schnappschuesse();
        komponentenGesamt = anzahl("SELECT count(*) FROM measurement_point");
        teileNachDerMigration = anzahl("SELECT count(*) FROM geraet_teil");
        speisungenNachDerMigration = root.queryForList("SELECT entity_id, geraet_id, teil_id, gueltig_ab, "
                + "gueltig_bis FROM geraet_komponente ORDER BY gueltig_ab, entity_id").stream()
                .collect(Collectors.groupingBy(z -> (UUID) z.get("entity_id"), LinkedHashMap::new,
                        Collectors.toList()));
        geraeteNachDerMigration = root.queryForList("SELECT * FROM geraet").stream()
                .collect(Collectors.toMap(z -> (UUID) z.get("id"), z -> z, (a, b) -> a, LinkedHashMap::new));
        zaehlerNachDerMigration = root.queryForList("SELECT tenant_id, naechste_nummer FROM geraet_kennzeichen_seq")
                .stream().collect(Collectors.toMap(z -> (UUID) z.get("tenant_id"),
                        z -> (Integer) z.get("naechste_nummer")));

        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Die Ableitung ---------------------------------------------------------------

    @Test
    void jedeKomponenteHatNachDerMigrationGenauEinLaufendesGeraet() {
        assertThat(komponentenGesamt).isEqualTo(KOMPONENTEN.size());
        assertThat(speisungenNachDerMigration.keySet())
                .containsExactlyInAnyOrderElementsOf(KOMPONENTEN.values());
        for (Map.Entry<String, UUID> k : KOMPONENTEN.entrySet()) {
            List<Map<String, Object>> s = speisungenNachDerMigration.get(k.getValue());
            assertThat(s).as(k.getKey()).hasSize(1);
            Map<String, Object> speisung = s.get(0);
            assertThat(speisung.get("gueltig_bis")).as(k.getKey()).isNull();
            assertThat(speisung.get("teil_id")).as(k.getKey()).isNull();
            Map<String, Object> geraet = geraeteNachDerMigration.get((UUID) speisung.get("geraet_id"));
            assertThat(geraet.get("ausgebaut_am")).as(k.getKey()).isNull();
            assertThat(geraet.get("aus_bestand")).as(k.getKey()).isEqualTo(true);
            assertThat(geraet.get("created_by")).as("VoltPilot selbst").isNull();
            // Ohne Wechsel ist das Einbau-Kennzeichen das des Geräts.
            assertThat(geraet.get("einbau_kennzeichen")).isEqualTo(geraet.get("kennzeichen"));
            // Datenquellen der Bestandskunden legt erst die Vorschlagsliste an (AP-06 IP-4).
            assertThat(geraet.get("data_source_id")).isNull();
            assertThat(geraet.get("bezeichnung")).isNull();
            // Das Gerät beginnt nie nach der Speisung, die es trägt.
            assertThat(ts(speisung.get("gueltig_ab"))).isAfterOrEqualTo(ts(geraet.get("eingebaut_am")));
        }
        // Keine Karten im Bestand: ein Controller mit Energiekarten entsteht erst mit AP-05.
        assertThat(teileNachDerMigration).isZero();
    }

    /**
     * AN-1: K-1 (Hybrid), K-3 (Netzzähler) und die vier Unterzähler hinter DQ-3 bekommen
     * GENAU die Geräte der Referenzdatei — Kennzeichen, Geräteart, Geräte-ID und Einbaubeginn.
     * Eine Seriennummer steht nirgends im Bestand: auch GR-4 bekommt keine (Z-5a mit 4471023
     * trägt erst der Zählerwechsel ein) — null heißt nicht erhoben, nie erfunden.
     */
    @Test
    void dieAbleitungGibtAhrenbergGenauDieGeraeteDerReferenzdatei() {
        for (String k : AN1) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode soll = element(referenz.get("geraete"), komponente.get("geraet").asText());
            Map<String, Object> ist = geraetVon(k);
            assertThat(ist.get("kennzeichen")).as(k).isEqualTo(soll.get("kennzeichen").asText());
            assertThat(ist.get("geraeteart")).as(k).isEqualTo(geraeteart(soll.get("art").asText()));
            assertThat(ist.get("geraete_id")).as(k).isEqualTo(soll.get("modbus_geraete_id").asInt());
            assertThat(ist.get("hersteller")).as(k).isEqualTo(text(soll.get("hersteller")));
            assertThat(ist.get("typ")).as(k).isEqualTo(text(soll.get("typ")));
            assertThat(ist.get("seriennummer")).as(k).isNull();
            assertThat(ts(ist.get("eingebaut_am"))).as(k).isEqualTo(
                    OffsetDateTime.parse(soll.at("/einbauten/0/gueltig_ab").asText()).toInstant());
            assertThat(ts(ist.get("eingebaut_am"))).as(k).isEqualTo(
                    OffsetDateTime.parse(komponente.get("in_betrieb_ab").asText()).toInstant());
        }
        assertThat(zaehlerNachDerMigration.get(AHRENBERG)).isEqualTo(AN1.size() + 1);
    }

    /**
     * Der Hybrid-Fall nach dem Einheitsmodell: EIN Wechselrichter speist sich selbst (mit dem
     * Speicher — eine Zeile) und die komponierten Geschwister derselben Box, die nichts Eigenes
     * tragen (grid-meter, house-load). Wer eine eigene Verbindung, Marke oder einen Pin hat,
     * „gehört einem anderen Gerät" (reusableComposedRow) — auch ein komponierter Netzzähler.
     */
    @Test
    void derHybridSpeistSeineKomponiertenGeschwisterUndSonstBekommtJedeKomponenteIhrGeraet() {
        Map<String, Object> hybrid = geraetVon("Hybrid");
        assertThat(geraetVon("Netzzähler komponiert")).isEqualTo(hybrid);
        assertThat(geraetVon("Hausverbrauch komponiert")).isEqualTo(hybrid);
        assertThat(hybrid.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(hybrid.get("hersteller")).isEqualTo("Deye");
        assertThat(hybrid.get("typ")).isEqualTo("SUN-12K-SG04LP3-EU");
        // `serial` ist bei solarman_v5 die des DATENLOGGERS — nie die des Geräts.
        assertThat(hybrid.get("seriennummer")).isNull();
        // Die Geräte-ID hinter dem Logger: mb_slave_id.
        assertThat(hybrid.get("geraete_id")).isEqualTo(1);
        assertThat(hybrid.get("kennzeichen")).isEqualTo("GR-1");

        // Der Beginn des Verlaufs: der erste Tag mit Werten (Europe/Berlin) liegt VOR der
        // Anlagezeit — das Gerät beginnt dort; jede Geschwister-Speisung mit ihrer Anlagezeit,
        // abgerundet auf die Minute.
        assertThat(ts(hybrid.get("eingebaut_am"))).isEqualTo(Instant.parse("2026-07-17T22:00:00Z"));
        assertThat(beginnDerSpeisung("Hybrid")).isEqualTo(Instant.parse("2026-07-17T22:00:00Z"));
        assertThat(beginnDerSpeisung("Netzzähler komponiert")).isEqualTo(Instant.parse("2026-07-20T14:23:00Z"));
        assertThat(beginnDerSpeisung("Hausverbrauch komponiert")).isEqualTo(Instant.parse("2026-07-20T14:23:00Z"));

        Map<String, Object> janitza = geraetVon("Netzzähler Janitza");
        assertThat(janitza).isNotEqualTo(hybrid);
        assertThat(janitza.get("geraeteart")).isEqualTo("zaehler");
        assertThat(janitza.get("geraete_id")).isEqualTo(2);

        Map<String, Object> fronius = geraetVon("Fronius");
        assertThat(fronius.get("geraeteart")).isEqualTo("wechselrichter");
        assertThat(fronius.get("hersteller")).isEqualTo("Fronius");

        // kaco_http führt `serial` als „Seriennummer des Wechselrichters".
        Map<String, Object> kaco = geraetVon("KACO");
        assertThat(kaco.get("seriennummer")).isEqualTo("KACO-2207-0815");
        assertThat(kaco.get("geraete_id")).isNull();

        assertThat(geraetVon("Wallbox").get("geraeteart")).isEqualTo("ladestation");
        assertThat(geraetVon("Batterie").get("geraeteart")).isEqualTo("speicher");
        assertThat(geraetVon("Heizstab").get("geraeteart")).isEqualTo("sonstiges");

        assertThat(List.of("Hybrid", "Fronius", "Netzzähler Janitza", "KACO", "Wallbox", "Batterie",
                "Heizstab").stream().map(k -> (String) geraetVon(k).get("kennzeichen")))
                .containsExactly("GR-1", "GR-2", "GR-3", "GR-4", "GR-5", "GR-6", "GR-7");
    }

    /** Ohne Wechselrichter an der Box wird nichts zusammengelegt — nie geraten. */
    @Test
    void ohneWechselrichterWirdNieZusammengelegtUndMitZweienTraegtDerErste() {
        Map<String, Object> netz = geraetVon("ohne WR: Netzzähler");
        Map<String, Object> haus = geraetVon("ohne WR: Hausverbrauch");
        assertThat(netz).isNotEqualTo(haus);
        assertThat(netz.get("geraeteart")).isEqualTo("zaehler");
        assertThat(haus.get("geraeteart")).isEqualTo("sonstiges");

        // Der Wechselrichter einer Box ist ihr ERSTER battery-hybrid (firstEntityOfType).
        assertThat(geraetVon("zwei WR: Hausverbrauch")).isEqualTo(geraetVon("zwei WR: erster"));
        assertThat(geraetVon("zwei WR: zweiter")).isNotEqualTo(geraetVon("zwei WR: erster"));
        assertThat(List.of("ohne WR: Netzzähler", "ohne WR: Hausverbrauch", "zwei WR: erster",
                "zwei WR: zweiter").stream().map(k -> (String) geraetVon(k).get("kennzeichen")))
                .containsExactly("GR-8", "GR-9", "GR-10", "GR-11");
        assertThat(zaehlerNachDerMigration.get(PROBE)).isEqualTo(12);
    }

    @Test
    void einErneuterLaufLegtNichtsAnUndAendertNichts() throws IOException {
        // Der Fixpunkt: auch was andere Tests dieser Klasse ohne Gerät angelegt haben.
        ableiten();
        Map<String, String> vorher = inhalte();
        fuehreDieseMigrationErneutAus();
        assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class)).isZero();
        assertThat(inhalte()).isEqualTo(vorher);
        // Die Nacharbeit ebenso — und sie stellt die Ableitung auf die Regel je Komponente zurück.
        fuehreErneutAus(ANLEGEWEG);
        assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class)).isZero();
        assertThat(inhalte()).isEqualTo(vorher);
    }

    /**
     * V20260911240000 zieht die Regel in {@code uems_geraet_ableiten_fuer} um; die
     * Bestands-Ableitung ist nur noch die Schleife darüber. Auf DEMSELBEN Bestand gibt die neue
     * Fassung GENAU die Geräte der Fassung von V20260911200000 — Gruppierung, Kennzeichen,
     * Werte, Zeiträume. Geprüft in einer Transaktion, die zurückrollt.
     */
    @Test
    void dieUmgeschriebeneAbleitungGibtDemBestandGenauDieGeraeteDerErstenFassung() throws IOException {
        fuehreErneutAus(ANLEGEWEG);
        List<String> felder = List.of("site_id", "kennzeichen", "einbau_kennzeichen", "geraeteart", "hersteller",
                "typ", "seriennummer", "bezeichnung", "data_source_id", "geraete_id", "eingebaut_am",
                "ausgebaut_am", "aus_bestand", "created_by");
        new TransactionTemplate(new DataSourceTransactionManager(root.getDataSource())).executeWithoutResult(tx -> {
            for (String t : List.of("geraet", "geraet_kennzeichen_seq")) {
                root.update("DELETE FROM " + t + " WHERE tenant_id IN (?, ?)", AHRENBERG, PROBE);
            }
            long geraeteVorher = geraeteNachDerMigration.values().stream()
                    .filter(g -> List.of(AHRENBERG, PROBE).contains((UUID) g.get("tenant_id"))).count();
            assertThat(root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class))
                    .isEqualTo((int) geraeteVorher);
            for (Map.Entry<String, UUID> k : KOMPONENTEN.entrySet()) {
                Map<String, Object> speisung = root.queryForMap("SELECT geraet_id, teil_id, gueltig_ab, gueltig_bis "
                        + "FROM geraet_komponente WHERE entity_id = ?", k.getValue());
                Map<String, Object> vorher = speisungenNachDerMigration.get(k.getValue()).get(0);
                assertThat(ts(speisung.get("gueltig_ab"))).as(k.getKey()).isEqualTo(ts(vorher.get("gueltig_ab")));
                assertThat(speisung.get("gueltig_bis")).as(k.getKey()).isNull();
                assertThat(speisung.get("teil_id")).as(k.getKey()).isNull();
                Map<String, Object> neu = root.queryForMap("SELECT * FROM geraet WHERE id = ?", speisung.get("geraet_id"));
                Map<String, Object> alt = geraetVon(k.getKey());
                for (String f : felder) {
                    Object a = alt.get(f);
                    Object n = neu.get(f);
                    if (a instanceof Timestamp) {
                        a = ts(a);
                        n = ts(n);
                    }
                    assertThat(n).as(k.getKey() + "." + f).isEqualTo(a);
                }
            }
            assertThat(root.queryForMap("SELECT naechste_nummer FROM geraet_kennzeichen_seq WHERE tenant_id = ?",
                    AHRENBERG).get("naechste_nummer")).isEqualTo(zaehlerNachDerMigration.get(AHRENBERG));
            assertThat(root.queryForMap("SELECT naechste_nummer FROM geraet_kennzeichen_seq WHERE tenant_id = ?",
                    PROBE).get("naechste_nummer")).isEqualTo(zaehlerNachDerMigration.get(PROBE));
            tx.setRollbackOnly();
        });
    }

    /**
     * Wiederholbar über den Bestand hinaus: ein neues komponiertes Geschwister hängt an den
     * laufenden Einbau seines Wechselrichters (kein neues Gerät), eine neue eigenständige
     * Komponente bekommt ihr eigenes — mit dem nächsten Kennzeichen.
     */
    @Test
    void neueGeschwisterHaengenAnDenLaufendenEinbauUndNeueKomponentenBekommenIhrGeraet() {
        // Die Ableitung läuft über alle Kundenbereiche — gezählt wird in der Werkstatt.
        Werkstatt w = new Werkstatt("Werkstatt Nachzügler");
        UUID hybrid = w.komponente("battery-hybrid", "battery-hybrid", w.box, true, null);
        ableiten();
        assertThat(w.geraete()).isOne();
        UUID geraet = laufendesGeraet(hybrid);

        UUID haus = w.komponente("house-load", "house-load", w.box, false, null);
        UUID zaehler = w.komponente("modbus-generic", "modbus-generic", null, false,
                "{\"ip\":\"10.0.0.7\",\"port\":502,\"unit_id\":7}");
        ableiten();
        assertThat(w.geraete()).isEqualTo(2);
        assertThat(laufendesGeraet(haus)).isEqualTo(geraet);
        UUID eigenes = laufendesGeraet(zaehler);
        assertThat(eigenes).isNotEqualTo(geraet);
        assertThat(root.queryForObject("SELECT kennzeichen FROM geraet WHERE id = ?", String.class, eigenes))
                .isEqualTo("GR-2");
        assertThat(root.queryForObject("SELECT geraete_id FROM geraet WHERE id = ?", Integer.class, eigenes))
                .isEqualTo(7);
        ableiten();
        assertThat(w.geraete()).isEqualTo(2);
        assertThat(anzahl("SELECT count(*) FROM geraet_komponente WHERE tenant_id = ?", w.tenant)).isEqualTo(3);
    }

    // ---- Der Bestand bleibt zeichengleich -----------------------------------------------

    @Test
    void dieBestandstabellenBleibenZeichengleich() {
        for (String t : BESTAND) {
            assertThat(bestandNachher.get(t)).as(t).isEqualTo(bestandVorher.get(t));
        }
        assertThat(bestandVorher.get("measurement_point").get("zeilen")).isNotBlank();
        assertThat(bestandVorher.get("telemetry_v2_rollup_1d").get("zeilen")).isNotBlank();
    }

    // ---- Der Zaun ------------------------------------------------------------------------

    @Test
    void derZaunStehtAufJederNeuenTabelle() {
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, t)).as(t).isTrue();
            // GENAU eine Mandanten-Policy - in der Form der Schwesterklassen (UemsOrteMigrationTest,
            // MessstelleZuordnungMigrationTest), die den Zaun an app.tenant_id festmachen statt an der
            // blossen Anzahl. PR 949 legt auf geraet zusaetzlich den Standortzaun
            // wago_geraet_site_scope AS RESTRICTIVE (wie measurement_point); eine RESTRICTIVE Policy
            // wird UND-verknuepft und kann nur verengen, nie oeffnen.
            assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual LIKE "
                    + "'%app.tenant_id%' AND with_check LIKE '%app.tenant_id%'", t)).as(t).isOne();
            // Und die Zusicherung bleibt schaerfer als ein blosses count: PERMISSIVE Policies werden
            // ODER-verknuepft und koennten den Zaun oeffnen - davon darf es genau die eine geben.
            assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = ? "
                    + "AND permissive = 'PERMISSIVE'", t)).as(t + ": nur eine PERMISSIVE Policy").isOne();
            // Ohne gewählten Kundenbereich sieht die App-Rolle nichts.
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t).isZero();
        }
        long ahrenberg = als(AHRENBERG, () -> app.queryForObject("SELECT count(*) FROM geraet", Long.class));
        assertThat(ahrenberg).isEqualTo(anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", AHRENBERG));
        assertThat(als(AHRENBERG, () -> app.queryForObject(
                "SELECT count(*) FROM geraet WHERE tenant_id <> ?", Long.class, AHRENBERG))).isZero();
        assertThat(als(AHRENBERG, () -> app.queryForObject("SELECT count(*) FROM geraet_komponente",
                Long.class))).isEqualTo(AN1.size());

        // Ein Gerät für einen fremden Kundenbereich schreibt die App-Rolle nicht …
        UUID fremdeAnlage = root.queryForObject("SELECT site_id FROM geraet WHERE tenant_id = ? LIMIT 1",
                UUID.class, PROBE);
        abgelehntWegen("42501", "row-level security", () -> alsTue(AHRENBERG, () -> app.update(
                "INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart, "
                        + "eingebaut_am) VALUES (?, ?, 'GR-99', 'GR-99', 'zaehler', ?)",
                PROBE, fremdeAnlage, Timestamp.from(Instant.parse("2026-10-01T06:00:00Z")))));
        // … und keines an einer fremden Anlage (der zusammengesetzte Fremdschlüssel).
        abgelehnt("23503", "geraet_site_fk", () -> alsTue(AHRENBERG, () -> app.update(
                "INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart, "
                        + "eingebaut_am) VALUES (?, ?, 'GR-99', 'GR-99', 'zaehler', ?)",
                AHRENBERG, fremdeAnlage, Timestamp.from(Instant.parse("2026-10-01T06:00:00Z")))));
    }

    // ---- Die Constraints -----------------------------------------------------------------

    /**
     * Der Zählerwechsel an der Datenbank: Z-5a endet genau, wo Z-5b beginnt — berühren ja,
     * überschneiden nie, auch nicht um eine Minute; dieselbe Regel für die Speisung von K-5.
     * Die Werte kommen aus der Referenzdatei (GR-4, Z-5a/Z-5b, 18.11.2026 10:40).
     */
    @Test
    void einEinbauJeGeraetUndZeitpunktUndEinGeraetJeKomponenteUndZeitpunkt() {
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        Instant wechsel = instant(z5a.get("gueltig_bis"));
        Werkstatt w = new Werkstatt("Werkstatt Zählerwechsel");
        UUID k5 = w.komponente("modbus-generic", "modbus-generic", null, false,
                "{\"ip\":\"192.168.10.31\",\"port\":502,\"unit_id\":2}", instant(z5a.get("gueltig_ab")));
        ableiten();
        UUID alt = laufendesGeraet(k5);
        String kennzeichen = root.queryForObject("SELECT kennzeichen FROM geraet WHERE id = ?", String.class, alt);

        alsTue(w.tenant, () -> {
            assertThat(app.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ?, "
                    + "ausgebaut_am = ? WHERE id = ?", z5a.get("kennzeichen").asText(),
                    z5a.get("seriennummer").asText(), Timestamp.from(wechsel), alt)).isOne();
            assertThat(app.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE entity_id = ?",
                    Timestamp.from(wechsel), k5)).isOne();
        });
        // Eine Minute zu früh: der neue Einbau überschneidet den alten.
        abgelehnt("23P01", "geraet_ein_einbau_je_zeitpunkt",
                () -> w.einbau(kennzeichen, "Z-5x", "zaehler", wechsel.minusSeconds(60)));
        UUID neu = w.einbau(kennzeichen, z5b.get("kennzeichen").asText(), "zaehler", wechsel);
        abgelehnt("23P01", "geraet_komponente_ein_geraet_je_zeitpunkt",
                () -> w.speisung(neu, k5, null, wechsel.minusSeconds(60)));
        w.speisung(neu, k5, null, wechsel);

        assertThat(root.queryForList("SELECT einbau_kennzeichen FROM geraet WHERE kennzeichen = ? "
                + "AND tenant_id = ? ORDER BY eingebaut_am", String.class, kennzeichen, w.tenant))
                .containsExactly("Z-5a", "Z-5b");
        // Dasselbe Einbau-Kennzeichen zweimal im Kundenbereich: nie.
        abgelehnt("23505", "uq_geraet_einbau_kennzeichen",
                () -> w.einbau("GR-77", "Z-5a", "zaehler", Instant.parse("2027-01-01T00:00:00Z")));
    }

    @Test
    void dieChecksLehnenAbStattZuRunden() {
        Werkstatt w = new Werkstatt("Werkstatt Formen");
        Instant t = Instant.parse("2026-10-01T06:00:00Z");
        abgelehnt("23514", "geraet_volle_minute", () -> w.einbau("GR-50", "GR-50", "zaehler", t.plusSeconds(30)));
        abgelehnt("23514", "geraet_kennzeichen_chk", () -> w.einbau("GR 51", "GR-51", "zaehler", t));
        abgelehnt("23514", "geraet_einbau_kennzeichen_chk", () -> w.einbau("GR-51", "-Z", "zaehler", t));
        // Die Energiekarte ist ein Teil des Controllers, keine Geräteart.
        abgelehnt("23514", "geraet_geraeteart_chk", () -> w.einbau("GR-52", "GR-52", "energiekarte", t));
        // Die Formen der Verträge gehen: Z-5a, C-1′, AHR-LP-01.
        w.einbau("GR-53", "C-1′", "controller", t);
        w.einbau("GR-54", "AHR-LP-01", "ladestation", t);
        UUID g = w.einbau("GR-55", "GR-55", "zaehler", t);
        abgelehnt("23514", "geraet_nicht_leer", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE geraet SET ausgebaut_am = eingebaut_am WHERE id = ?", g)));
        abgelehnt("23514", "geraet_text_chk", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE geraet SET seriennummer = '  ' WHERE id = ?", g)));
        UUID k = w.komponente("modbus-generic", "modbus-generic", null, false, "{\"ip\":\"10.0.0.9\"}");
        abgelehnt("23514", "geraet_komponente_volle_minute", () -> w.speisung(g, k, null, t.plusSeconds(1)));
    }

    /**
     * GR-7 „WAGO-Controller C-1" mit EK-1 … EK-4 auf den Steckplätzen 2 … 5 (Referenzdatei):
     * je Karte EINE Komponente, je Steckplatz und Zeitpunkt EINE Karte, Karten nur an einem
     * Controller, und die Karte einer Speisung gehört dem Gerät der Speisung.
     */
    @Test
    void derControllerTraegtSeineKartenInSteckplaetzen() {
        JsonNode gr7 = element(referenz.get("geraete"), "GR-7");
        Instant ab = instant(gr7.at("/einbauten/0/gueltig_ab"));
        Werkstatt w = new Werkstatt("Werkstatt WAGO");
        UUID c1 = w.einbau(gr7.get("kennzeichen").asText(), gr7.at("/einbauten/0/kennzeichen").asText(),
                "controller", ab);
        Map<Integer, UUID> karten = new LinkedHashMap<>();
        for (String k : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            int steckplatz = komponente.get("steckplatz").asInt();
            UUID karte = w.karte(c1, steckplatz, komponente.get("kartentyp").asText(), ab);
            karten.put(steckplatz, karte);
            w.komponenteAnKarte(c1, karte, ab);
        }
        assertThat(karten.keySet()).containsExactly(2, 3, 4, 5);
        assertThat(anzahl("SELECT count(*) FROM geraet_komponente WHERE geraet_id = ? AND teil_id IS NOT NULL",
                c1)).isEqualTo(4);

        // Je Steckplatz und Zeitpunkt EINE Karte; ein nicht erhobener Steckplatz kollidiert nie.
        abgelehnt("23P01", "geraet_teil_eine_karte_je_steckplatz", () -> w.karte(c1, 2, null, ab));
        UUID frei = w.karte(c1, null, null, ab);
        w.karte(c1, null, null, ab);
        // Je Karte und Zeitpunkt EINE Komponente.
        abgelehnt("23P01", "geraet_komponente_eine_komponente_je_karte",
                () -> w.komponenteAnKarte(c1, karten.get(2), ab));
        // Karten trägt nur ein Controller.
        UUID zaehler = w.einbau("GR-8", "GR-8", "zaehler", ab);
        abgelehnt("23503", "geraet_teil_geraet_fk", () -> w.karte(zaehler, 1, null, ab));
        // Die Karte gehört dem Gerät der Speisung (eine freie Karte — sonst verböte schon die
        // Ausschluss-Bedingung, die vor dem Fremdschlüssel prüft).
        abgelehnt("23503", "geraet_komponente_teil_fk", () -> w.komponenteAnKarte(zaehler, frei, ab));
    }

    // ---- Rechte, Löschen, Offboarding -----------------------------------------------------

    @Test
    void dieAppRolleLoeschtNieUndAendertNurWasSieDarf() {
        Werkstatt w = new Werkstatt("Werkstatt Rechte");
        Instant ab = Instant.parse("2026-10-01T06:00:00Z");
        UUID controller = w.einbau("GR-1", "GR-1", "controller", ab);
        UUID karte = w.karte(controller, 2, null, ab);
        UUID k = w.komponenteAnKarte(controller, karte, ab);

        alsTue(w.tenant, () -> {
            for (String t : TABELLEN) {
                abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM " + t));
            }
            for (String zuweisung : List.of("kennzeichen = 'GR-2'", "site_id = site_id",
                    "geraeteart = 'zaehler'",
                    "aus_bestand = true", "created_by = 'jemand'", "tenant_id = tenant_id")) {
                abgelehntWegen("42501", "permission denied",
                        () -> app.update("UPDATE geraet SET " + zuweisung + " WHERE id = ?", controller));
            }
            for (String zuweisung : List.of("steckplatz = 3", "geraet_id = geraet_id")) {
                abgelehntWegen("42501", "permission denied",
                        () -> app.update("UPDATE geraet_teil SET " + zuweisung + " WHERE id = ?", karte));
            }
            for (String zuweisung : List.of("geraet_id = geraet_id", "entity_id = entity_id", "teil_id = NULL")) {
                abgelehntWegen("42501", "permission denied", () -> app.update(
                        "UPDATE geraet_komponente SET " + zuweisung + " WHERE entity_id = ?", k));
            }
            // AP-04 A3: Beginnspalten sind nur für belegte zukünftige Wechsel freigegeben.
            abgelehnt("23514", "uems_wechsel_nur_geplant", () -> app.update(
                    "UPDATE geraet SET eingebaut_am=eingebaut_am-interval '1 day' WHERE id=?", controller));
            abgelehnt("23514", "uems_wechsel_nur_geplant", () -> app.update(
                    "UPDATE geraet_teil SET eingebaut_am=eingebaut_am-interval '1 day' WHERE id=?", karte));
            abgelehnt("23514", "uems_wechsel_nur_geplant", () -> app.update(
                    "UPDATE geraet_komponente SET gueltig_ab=gueltig_ab-interval '1 day' WHERE entity_id=?", k));
            // Was der Kunde nachträgt und was der Ausbau setzt, geht.
            Timestamp aus = Timestamp.from(Instant.parse("2027-02-05T13:00:00Z"));
            assertThat(app.update("UPDATE geraet SET seriennummer = 'C1-4711', bezeichnung = 'Controller "
                    + "Halle 2', hersteller = 'WAGO', typ = 'PFC200 750-8212', geraete_id = 1 WHERE id = ?",
                    controller)).isOne();
            assertThat(app.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE entity_id = ?", aus, k))
                    .isOne();
            assertThat(app.update("UPDATE geraet_teil SET ausgebaut_am = ?, seriennummer = 'EK-SN-1' "
                    + "WHERE id = ?", aus, karte)).isOne();
            assertThat(app.update("UPDATE geraet SET ausgebaut_am = ? WHERE id = ?", aus, controller)).isOne();
            // Die Ableitung ist kein Schreibweg der App.
            abgelehntWegen("42501", "permission denied",
                    () -> app.queryForObject("SELECT uems_geraete_ableiten()", Integer.class));
        });
    }

    /**
     * Eine Anlage mit Geräten bleibt löschbar (das heutige Löschen nimmt die Komponenten mit,
     * die Geräte folgen ihnen); eine gelöschte Komponente nimmt nur ihre Speisung mit, nie das
     * Gerät.
     */
    @Test
    void anlageUndKomponenteBleibenLoeschbar() {
        Werkstatt w = new Werkstatt("Werkstatt Löschen");
        UUID hybrid = w.komponente("battery-hybrid", "battery-hybrid", w.box, true, null);
        UUID haus = w.komponente("house-load", "house-load", w.box, false, null);
        ableiten();
        UUID geraet = laufendesGeraet(hybrid);

        assertThat(als(w.tenant, () -> app.update("DELETE FROM measurement_point WHERE id = ?", haus))).isOne();
        assertThat(anzahl("SELECT count(*) FROM geraet_komponente WHERE entity_id = ?", haus)).isZero();
        assertThat(anzahl("SELECT count(*) FROM geraet WHERE id = ?", geraet)).isOne();

        assertThat(als(w.tenant, () -> app.update("DELETE FROM site WHERE id = ?", w.site))).isOne();
        assertThat(anzahl("SELECT count(*) FROM geraet WHERE site_id = ?", w.site)).isZero();
        assertThat(anzahl("SELECT count(*) FROM geraet_komponente WHERE geraet_id = ?", geraet)).isZero();
    }

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        Werkstatt w = new Werkstatt("Werkstatt Offboarding");
        Instant ab = Instant.parse("2026-10-01T06:00:00Z");
        UUID controller = w.einbau("GR-7", "C-1", "controller", ab);
        UUID karte = w.karte(controller, 2, null, ab);
        w.komponenteAnKarte(controller, karte, ab);
        w.komponente("battery-hybrid", "battery-hybrid", w.box, true, null);
        ableiten();

        // Nie Kaskade vom Mandanten.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", w.tenant));

        new TenantRepository(admin).offboard(w.tenant);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", w.tenant)).isZero();
        for (String t : TABELLEN) {
            assertThat(anzahl("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", w.tenant)).as(t).isZero();
        }
    }

    /** Der Zähler vergibt GR-n je Kundenbereich, überspringt belegte Nummern und rückt nie zurück. */
    @Test
    void derKennzeichenZaehlerUeberspringtBelegteNummern() {
        Werkstatt w = new Werkstatt("Werkstatt Zähler");
        Instant ab = Instant.parse("2026-10-01T06:00:00Z");
        w.einbau("X-1", "GR-1", "zaehler", ab);
        w.einbau("GR-2", "GR-2", "zaehler", ab);
        assertThat(als(w.tenant, () -> app.queryForObject("SELECT uems_geraet_kennzeichen(?)", String.class,
                w.tenant))).isEqualTo("GR-3");
        assertThat(anzahl("SELECT naechste_nummer FROM geraet_kennzeichen_seq WHERE tenant_id = ?", w.tenant))
                .isEqualTo(4);
        // Ein anderer Kundenbereich zählt für sich.
        assertThat(zaehlerNachDerMigration.get(AHRENBERG)).isEqualTo(7);
        // Die App-Rolle zählt nie für einen fremden Kundenbereich.
        abgelehntWegen("42501", "row-level security", () -> alsTue(w.tenant, () -> app.queryForObject(
                "SELECT uems_geraet_kennzeichen(?)", String.class, UUID.randomUUID())));
    }

    // ---- Gerüst: der Bestand ----------------------------------------------------------------

    private static void saeBestand() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText());
        JsonNode an1 = element(referenz.get("anlagen"), "AN-1");
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, AHRENBERG, an1.get("name").asText(),
                OffsetDateTime.parse(an1.get("seit").asText()));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, AHRENBERG, site,
                e1.get("seriennummer").asText(), OffsetDateTime.parse(e1.get("in_betrieb_ab").asText()));
        int n = 0;
        for (String k : AN1) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode()
                    .put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt())
                    .put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = ART_DER_REFERENZ.get(k);
            // Die Zeilen-Kennung legt die Reihenfolge bei gleicher Anlagezeit fest (created_at, id).
            UUID id = UUID.fromString(String.format("4e0a0000-0000-0000-0001-%012d", ++n));
            root.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                    + "device_id, control, source_kind, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)", id, AHRENBERG, site, art,
                    komponente.get("name").asText(), art, box, "battery-hybrid".equals(art),
                    "battery-hybrid".equals(art) || "grid-meter".equals(art) ? "composed" : "custom",
                    "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp", verbindung.toString(),
                    OffsetDateTime.parse(komponente.get("in_betrieb_ab").asText()));
            KOMPONENTEN.put(k, id);
        }

        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich Probe')", PROBE);
        UUID hybridAnlage = anlage(PROBE, "Probe Hybrid", "2026-07-01T08:00:00Z");
        UUID p1 = box(PROBE, hybridAnlage, "VP-BOX-PROBE-0001");
        bestand(PROBE, hybridAnlage, "Hybrid", "battery-hybrid", "battery-hybrid", p1, true, "Deye",
                "SUN-12K-SG04LP3-EU", "solarman_v5",
                "{\"ip\":\"192.168.178.40\",\"port\":8899,\"serial\":\"2712345678\",\"mb_slave_id\":1}",
                null, "2026-07-20T14:23:17Z");
        // Der erste Tag mit Werten liegt vor der Anlagezeit (Europe/Berlin-Mitternacht).
        for (String tag : List.of("2026-07-17T22:00:00Z", "2026-07-18T22:00:00Z")) {
            root.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, "
                    + "avg_value, min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, "
                    + "'battery_soc_pct', 50, 20, 80, 55, 96)", Timestamp.from(Instant.parse(tag)), PROBE,
                    hybridAnlage, KOMPONENTEN.get("Hybrid").toString());
        }
        bestand(PROBE, hybridAnlage, "Netzzähler komponiert", "grid-meter", "grid-meter", p1, false, null,
                null, null, null, null, "2026-07-20T14:23:18Z");
        bestand(PROBE, hybridAnlage, "Hausverbrauch komponiert", "house-load", "house-load", p1, false, null,
                null, null, "{}", null, "2026-07-20T14:23:19Z");
        bestand(PROBE, hybridAnlage, "Fronius", "pv-generation", "producer", null, false, "Fronius",
                "Symo 10.0-3-M", "fronius_sunspec", "{\"ip\":\"192.168.178.41\",\"port\":502,\"unit_id\":1}",
                "fronius-1", "2026-07-21T09:00:00Z");
        bestand(PROBE, hybridAnlage, "Netzzähler Janitza", "grid-meter", "grid-meter", p1, false, "Janitza",
                "UMG 604-PRO", "modbus_tcp", "{\"ip\":\"192.168.178.50\",\"port\":502,\"unit_id\":2}", null,
                "2026-07-22T09:00:00Z");
        bestand(PROBE, hybridAnlage, "KACO", "pv-generation", "producer", null, false, "KACO",
                "blueplanet 10.0 NX3 M2", "kaco_http", "{\"ip\":\"192.168.178.60\",\"serial\":\"KACO-2207-0815\"}",
                null, "2026-07-23T09:00:00Z");
        bestand(PROBE, hybridAnlage, "Wallbox", "consumer", "wallbox", null, false, "go-e", "Charger Gemini",
                "goe_http_api", "{\"ip\":\"192.168.178.70\"}", null, "2026-07-24T09:00:00Z");
        bestand(PROBE, hybridAnlage, "Batterie", "consumer", "user-defined-battery", null, false, null, null,
                null, "{\"topic\":\"bms/+/soc\"}", null, "2026-07-25T09:00:00Z");
        bestand(PROBE, hybridAnlage, "Heizstab", "consumer", "heating-rod", null, false, "Shelly", "Pro 1PM",
                "shelly_http", "{\"ip\":\"192.168.178.80\",\"channel\":0}", null, "2026-07-26T09:00:00Z");

        UUID ohne = anlage(PROBE, "Probe ohne Wechselrichter", "2026-08-01T08:00:00Z");
        UUID p2 = box(PROBE, ohne, "VP-BOX-PROBE-0002");
        bestand(PROBE, ohne, "ohne WR: Netzzähler", "grid-meter", "grid-meter", p2, false, null, null, null,
                null, null, "2026-08-01T09:00:00Z");
        bestand(PROBE, ohne, "ohne WR: Hausverbrauch", "house-load", "house-load", p2, false, null, null, null,
                null, null, "2026-08-01T09:01:00Z");

        UUID zwei = anlage(PROBE, "Probe zwei Wechselrichter", "2026-08-02T08:00:00Z");
        UUID p3 = box(PROBE, zwei, "VP-BOX-PROBE-0003");
        bestand(PROBE, zwei, "zwei WR: erster", "battery-hybrid", "battery-hybrid", p3, true, null, null, null,
                null, null, "2026-08-02T10:00:00Z");
        bestand(PROBE, zwei, "zwei WR: zweiter", "battery-hybrid", "battery-hybrid", p3, false, null, null,
                null, null, null, "2026-08-02T11:00:00Z");
        bestand(PROBE, zwei, "zwei WR: Hausverbrauch", "house-load", "house-load", p3, false, null, null, null,
                null, null, "2026-08-02T12:00:00Z");
    }

    private static UUID anlage(UUID tenant, String name, String seit) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, name, Timestamp.from(Instant.parse(seit)));
    }

    private static UUID box(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, ref);
    }

    private static void bestand(UUID tenant, UUID site, String name, String rolle, String art, UUID box,
            boolean steuert, String marke, String modell, String kommunikation, String verbindung, String pin,
            String angelegt) {
        UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, brand, model, communication, connection_json, "
                + "edge_source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id",
                UUID.class, tenant, site, rolle, name, art, box, steuert, marke, modell, kommunikation,
                verbindung, pin, Timestamp.from(Instant.parse(angelegt)));
        KOMPONENTEN.put(name, id);
    }

    /**
     * Ein eigener Kundenbereich je verändernder Test — er berührt den Bestand nicht. Seine
     * Komponenten entstehen NACH der Migration (ohne Gerät, bis {@link #ableiten()} läuft oder
     * der Test die Speisung von Hand setzt, wie es die Wechsel von AP-04/AP-05 tun werden).
     */
    private static final class Werkstatt {
        final UUID tenant;
        final UUID site;
        final UUID box;

        Werkstatt(String name) {
            tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
            site = anlage(tenant, name, "2026-09-01T08:00:00Z");
            box = UemsGeraetMigrationTest.box(tenant, site, "VP-BOX-" + tenant);
        }

        UUID komponente(String rolle, String art, UUID anBox, boolean steuert, String verbindung) {
            return komponente(rolle, art, anBox, steuert, verbindung, Instant.parse("2026-09-02T08:00:00Z"));
        }

        UUID komponente(String rolle, String art, UUID anBox, boolean steuert, String verbindung, Instant angelegt) {
            return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                    + "device_id, control, connection_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?) "
                    + "RETURNING id", UUID.class, tenant, site, rolle, art, anBox, steuert, verbindung,
                    Timestamp.from(angelegt));
        }

        /**
         * Eine Komponente, die eine Energiekarte des Controllers speist — angelegt, wie AP-05 sie
         * anlegen wird: Komponente und Speisung in EINER Anweisung (Transaktion). Der Anlege-Weg
         * (V20260911240000, zur Commit-Zeit) sieht dann ihre Speisung und legt kein Gerät an.
         */
        UUID komponenteAnKarte(UUID geraet, UUID karte, Instant ab) {
            return root.queryForObject("WITH k AS (INSERT INTO measurement_point (tenant_id, site_id, role, "
                    + "entity_type, control, created_at) VALUES (?, ?, 'modbus-generic', 'modbus-generic', false, ?) "
                    + "RETURNING id) INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, "
                    + "gueltig_ab) SELECT ?, ?, k.id, ?, ? FROM k RETURNING entity_id", UUID.class, tenant, site,
                    Timestamp.from(ab), tenant, geraet, karte, Timestamp.from(ab));
        }

        UUID einbau(String kennzeichen, String einbau, String art, Instant ab) {
            return als(tenant, () -> app.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, "
                    + "einbau_kennzeichen, geraeteart, eingebaut_am) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                    UUID.class, tenant, site, kennzeichen, einbau, art, Timestamp.from(ab)));
        }

        UUID karte(UUID geraet, Integer steckplatz, String typ, Instant ab) {
            return als(tenant, () -> app.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, "
                    + "steckplatz, typ, eingebaut_am) VALUES (?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant,
                    geraet, steckplatz, typ, Timestamp.from(ab)));
        }

        long geraete() {
            return anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", tenant);
        }

        void speisung(UUID geraet, UUID komponente, UUID karte, Instant ab) {
            alsTue(tenant, () -> app.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, "
                    + "teil_id, gueltig_ab) VALUES (?, ?, ?, ?, ?)", tenant, geraet, komponente, karte,
                    Timestamp.from(ab)));
        }
    }

    private static Integer ableiten() {
        return root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class);
    }

    private static UUID laufendesGeraet(UUID komponente) {
        return root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
    }

    /** Das Gerät, das die Komponente direkt nach der Migration speiste. */
    private static Map<String, Object> geraetVon(String komponente) {
        List<Map<String, Object>> s = speisungenNachDerMigration.get(KOMPONENTEN.get(komponente));
        assertThat(s).as(komponente).hasSize(1);
        return geraeteNachDerMigration.get((UUID) s.get(0).get("geraet_id"));
    }

    private static Instant beginnDerSpeisung(String komponente) {
        return ts(speisungenNachDerMigration.get(KOMPONENTEN.get(komponente)).get(0).get("gueltig_ab"));
    }

    /** Alles, was die Ableitung schreibt — Zeile für Zeile. */
    private static Map<String, String> inhalte() {
        Map<String, String> m = new LinkedHashMap<>();
        for (String t : TABELLEN) {
            m.put(t, root.queryForObject("SELECT coalesce(string_agg(z, E'\\n' ORDER BY z), '') FROM "
                    + "(SELECT to_jsonb(t)::text AS z FROM " + t + " t) AS zeilen", String.class));
        }
        return m;
    }

    private static String geraeteart(String referenzArt) {
        return switch (referenzArt) {
            case "Wechselrichter" -> "wechselrichter";
            case "Zähler" -> "zaehler";
            case "Controller" -> "controller";
            case "Ladestation" -> "ladestation";
            default -> throw new IllegalArgumentException(referenzArt);
        };
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static Instant instant(JsonNode n) {
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static Instant ts(Object o) {
        return o instanceof Timestamp t ? t.toInstant() : ((OffsetDateTime) o).toInstant();
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    // ---- Gerüst: der Schnappschuss einer Tabelle --------------------------------------------

    private static Map<String, Map<String, String>> schnappschuesse() {
        Map<String, Map<String, String>> m = new LinkedHashMap<>();
        for (String t : BESTAND) {
            m.put(t, schnappschuss(t));
        }
        return m;
    }

    /**
     * Alles, was eine Migration an einer Tabelle ändern könnte: Spalten, jede Zeile, eigene
     * Constraints, Indexe, Policies, RLS-Schalter, eigene Trigger und Rechte. Nicht darin: die
     * internen Fremdschlüssel-Trigger, die jeder Verweis AUF die Tabelle anlegt — sie gehören dem
     * verweisenden Constraint (hier geraet_komponente → measurement_point).
     */
    private static Map<String, String> schnappschuss(String tabelle) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', column_name, "
                + "data_type, is_nullable, column_default, ordinal_position), E'\\n' ORDER BY ordinal_position) "
                + "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
                String.class, tabelle));
        s.put("zeilen", root.queryForObject("SELECT coalesce(string_agg(z, E'\\n' ORDER BY z), '') FROM "
                + "(SELECT to_jsonb(t)::text AS z FROM " + tabelle + " t) AS zeilen", String.class));
        s.put("constraints", root.queryForObject("SELECT coalesce(string_agg(conname || ':' || "
                + "pg_get_constraintdef(oid), E'\\n' ORDER BY conname), '') FROM pg_constraint "
                + "WHERE conrelid = ?::regclass", String.class, tabelle));
        s.put("indexe", root.queryForObject("SELECT coalesce(string_agg(indexdef, E'\\n' ORDER BY indexname), '') "
                + "FROM pg_indexes WHERE schemaname = 'public' AND tablename = ?", String.class, tabelle));
        s.put("policies", root.queryForObject("SELECT coalesce(string_agg(policyname || ':' || "
                + "coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' ORDER BY policyname), '') "
                + "FROM pg_policies WHERE tablename = ?", String.class, tabelle));
        s.put("rls", root.queryForObject("SELECT relrowsecurity || '/' || relforcerowsecurity FROM pg_class "
                + "WHERE oid = ?::regclass", String.class, tabelle));
        s.put("trigger", root.queryForObject("SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), '') "
                + "FROM pg_trigger WHERE tgrelid = ?::regclass AND NOT tgisinternal", String.class, tabelle));
        s.put("rechte", root.queryForObject("SELECT coalesce(string_agg(grantee || ':' || privilege_type, ',' "
                + "ORDER BY grantee, privilege_type), '') FROM information_schema.role_table_grants "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        return s;
    }

    // ---- Gerüst: Zaun und Ablehnungen --------------------------------------------------------

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    /** Die Ablehnung der Datenbank — oder {@code null}, wenn sie annimmt. */
    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        if (constraint != null) {
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    // ---- Gerüst: Flyway ------------------------------------------------------------------

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    /** Dieselbe Datei noch einmal, wie Flyway sie ausführt (Platzhalter ersetzt). */
    private static void fuehreDieseMigrationErneutAus() throws IOException {
        fuehreErneutAus(DATEI);
    }

    private static void fuehreErneutAus(String datei) throws IOException {
        String sql;
        try (InputStream in = UemsGeraetMigrationTest.class.getResourceAsStream("/db/migration/" + datei)) {
            sql = new String(Objects.requireNonNull(in, datei).readAllBytes(), StandardCharsets.UTF_8);
        }
        root.execute(sql.replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER));
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
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
