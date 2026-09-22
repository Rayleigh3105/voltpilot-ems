package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260912140000} (UEMS AP-07 IP-6) gegen eine echte TimescaleDB: die
 * Messwert-Rohtabelle bekommt ihre REIHE je Komponente (E2), ihre Herkunftsspalten und den neuen
 * DOPPEL-ERKENNUNGSSCHLÜSSEL Reihe + Messzeit (E3) — mit 30 TAGEN BESTAND darunter.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-6):
 *
 * <ul>
 *   <li><b>Der Bestand bleibt.</b> Gleiche Zeilenzahl, und jede Zeile ist ohne ihre neuen Spalten
 *       zeichengleich (Fingerabdruck vor/nach). Die Bestandsflächen — Cockpit, Erlöse, Fahrplan,
 *       Verlauf und Registry-Push — lesen dieselben Tabellen zeichengleich weiter, und der
 *       Verdichtungslauf über die Rohwerte liefert dasselbe Ergebnis.</li>
 *   <li><b>Nachgetragen, nie geraten.</b> Wo die Komponente aus der Auswahl EINDEUTIG folgt, steht
 *       sie in der Zeile; wo nicht (zwei baugleiche Geräte hinter einer Box, die alte
 *       Box-Semantik {@code entity_id IS NULL}, gar keine Auswahlzeile), bleibt die Zeile ohne
 *       Komponente und trägt die Rolle {@code spiegel}. Einbau, Fassung, Wertart und Zustellart
 *       bleiben im Bestand LEER.</li>
 *   <li><b>E3 greift.</b> Gleiche Reihe + Messzeit mit gleichem Wert = EIN Wert; mit abweichendem
 *       Wert bleibt der erste und der zweite wird abgewiesen — und zwar jetzt auch, wenn die
 *       Sequenz eine andere ist (genau das ließ der alte Schlüssel zu). Der SPIEGEL liegt
 *       außerhalb des Index (Vertrag §7.4, A9: kein stilles Verdrängen).</li>
 *   <li><b>Der alte Schlüssel bleibt unberührt</b> — er weist dieselben Zeilen ab wie vorher —,
 *       RLS, Policy, Rechte und die Aufbewahrung sind unverändert.</li>
 * </ul>
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen ({@code uems-referenzunternehmen.json}):
 * die Anlage AN-1, die Box E-1 und die Komponenten K-3 (Netzzähler) und K-5 (Unterzähler
 * Spritzguss) tragen ihre Namen und Zeiten aus der Datei. Die uneindeutigen Fälle laufen in einem
 * neutralen Probe-Kundenbereich, der kein Ahrenberg-Objekt vorgibt.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMesswertRohtabelleMigrationTest {

    private static final String DIESE = "20260912140000";
    private static final String DATEI = "V20260912140000__uems_messwert_rohtabelle.sql";

    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Die sieben Spalten, die diese Migration anlegt — alles andere muss zeichengleich bleiben. */
    private static final List<String> NEUE_SPALTEN = List.of("entity_id", "device_install_id",
            "applied_revision", "value_kind", "role", "delivery", "delay_s");

    /**
     * Was die Bestandsflächen lesen: Cockpit/Erlöse/Verlauf (telemetry_v2 + Verdichtungen),
     * Fahrplan (schedule), der Verlauf der zusätzlichen Messwerte (device_measurement_*) und der
     * Registry-Push (die Auswahl samt Papier-Spur).
     */
    private static final List<String> BESTAND = List.of("telemetry_v2", "telemetry_v2_rollup_15m",
            "telemetry_v2_rollup_1h", "telemetry_v2_rollup_1d", "schedule",
            "device_measurement_sample", "device_measurement_rollup_5m",
            "device_measurement_rollup_15m", "device_measurement_event",
            "device_measurement_point_state", "device_measurement_selection",
            "device_measurement_selection_event");

    private static final UUID AHRENBERG = UUID.fromString("4e070000-0000-0000-0000-000000000001");
    private static final UUID PROBE = UUID.fromString("4e070000-0000-0000-0000-000000000002");

    /** Der Selbstbau-Kanal des Unterzählers K-5 (Zählerstand) und ein Katalogpunkt für K-3. */
    private static final String K5_KANAL = "wirkenergie-bezug";
    private static final String K3_KANAL = "sunspec.model_203.w";
    /** Die Kanäle der uneindeutigen Fälle im Probe-Kundenbereich. */
    private static final String ZWEI_GERAETE_KANAL = "sunspec.model_101.w";
    private static final String BOX_SEMANTIK_KANAL = "goe.status.nrg-power";
    private static final String OHNE_AUSWAHL_KANAL = "shelly.switch.0.apower";

    private static final String KATALOG = "2026.08.26.3";
    /** 30 Tage Bestand, stündlich — die Rohtabelle staffelt sie auf 31 Tages-Chunks. */
    private static final int TAGE = 30;

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

    private static UUID ahrenbergSite;
    private static UUID ahrenbergBox;
    /** Die zweite Box derselben Anlage: sie liest dieselbe Komponente (Spiegel-Fälle). */
    private static UUID ahrenbergBox2;
    private static UUID probeSite;
    private static UUID probeBox;
    /** Kennzeichen der Komponente → Zeilen-Kennung. */
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();

    /** Der Messzeitpunkt, an dem im Bestand ZWEI Zeilen derselben Reihe liegen (E3). */
    private static Instant doppelteMesszeit;
    private static Instant erstesMessfenster;

    private static Map<String, String> fingerabdruckVorher;
    private static Map<String, String> fingerabdruckNachher;
    private static Map<String, String> strukturVorher;
    private static Map<String, String> strukturNachher;
    private static long zeilenVorher;
    private static long zeilenNachher;
    private static long chunksVorher;

    /**
     * Der Stand des Bestands DIREKT nach der Migration, je Kundenbereich und Messkanal — die
     * Tests darunter schreiben selbst in die Tabelle, also wird hier gemessen und dort geprüft.
     */
    private static Map<String, Map<String, Object>> nachtragJeKanal;
    private static long rollenAusserSpiegel;
    private static long xorVerstoesse;
    private static long erfundeneHerkunft;
    private static long verdichtungsartGesetzt;
    private static List<Map<String, Object>> doppelZeilen;
    /** Der Beweis der Wiederholbarkeit: derselbe Lauf noch einmal, vor und nach. */
    private static Map<String, String> vorDemZweitenLauf;
    private static Map<String, String> nachDemZweitenLauf;
    private static String spaltenVorDemZweitenLauf;
    private static String spaltenNachDemZweitenLauf;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        // Die Verdichtung der Rohwerte EINMAL vor der Migration laufen lassen: ihr Ergebnis
        // gehört danach zum Bestand, den die Migration nicht anrühren darf.
        verdichte();
        zeilenVorher = anzahl("SELECT count(*) FROM device_measurement_sample");
        chunksVorher = anzahl("SELECT count(*) FROM timescaledb_information.chunks "
                + "WHERE hypertable_name = 'device_measurement_sample'");
        fingerabdruckVorher = fingerabdruecke();
        strukturVorher = schnappschuss("device_measurement_sample");

        flyway().target(DIESE).load().migrate();

        zeilenNachher = anzahl("SELECT count(*) FROM device_measurement_sample");
        strukturNachher = schnappschuss("device_measurement_sample");
        nachtragJeKanal = nachtragJeKanal();
        rollenAusserSpiegel = anzahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE role IS NOT NULL AND role <> 'spiegel'");
        xorVerstoesse = anzahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE (entity_id IS NULL) <> (role = 'spiegel')");
        erfundeneHerkunft = anzahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE device_install_id IS NOT NULL OR applied_revision IS NOT NULL "
                + "OR value_kind IS NOT NULL OR delivery IS NOT NULL OR delay_s IS NOT NULL");
        verdichtungsartGesetzt = anzahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE aggregation_kind IS NOT NULL");
        doppelZeilen = root.queryForList("SELECT entity_id, role, edge_sequence, received_at, "
                + "decoded_numeric FROM device_measurement_sample WHERE tenant_id = ? "
                + "AND point_key = ? AND time = ? ORDER BY received_at", AHRENBERG, K5_KANAL,
                Timestamp.from(doppelteMesszeit));
        // Derselbe Verdichtungslauf nach der Migration: er schreibt dieselben Zeilen (Upsert über
        // alle Spalten) — oder der Fingerabdruck der Verdichtungen unten fällt auseinander.
        verdichte();
        fingerabdruckNachher = fingerabdruecke();

        // Wiederholbarkeit: dieselbe Datei noch einmal ändert keine einzige Zeile.
        vorDemZweitenLauf = fingerabdruecke();
        spaltenVorDemZweitenLauf = alleSpaltenFingerabdruck();
        fuehreDieseMigrationErneutAus();
        nachDemZweitenLauf = fingerabdruecke();
        spaltenNachDemZweitenLauf = alleSpaltenFingerabdruck();

        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Der Bestand bleibt ------------------------------------------------------------------

    /** 30 Tage Bestand, und nach der Migration liegt genau dieselbe Menge Zeilen in der Tabelle. */
    @Test
    void derBestandVerliertKeineEinzigeZeileUndKeinenEinzigenWert() {
        assertThat(zeilenVorher).as("30 Tage Bestand gesät").isGreaterThan(1_400L);
        assertThat(zeilenNachher).as("keine Zeile gelöscht, keine hinzugefügt").isEqualTo(zeilenVorher);
        assertThat(chunksVorher).as("der Bestand liegt über viele Tages-Chunks").isGreaterThan(29L);
        // Die Rohwerte selbst: ohne die neuen Spalten ist jede Zeile zeichengleich.
        assertThat(fingerabdruckNachher.get("device_measurement_sample"))
                .as("jede Bestandszeile zeichengleich (ohne die neuen Spalten)")
                .isEqualTo(fingerabdruckVorher.get("device_measurement_sample"));
    }

    /**
     * Bestandsschutz: Cockpit, Erlöse, Fahrplan, Verlauf und Registry-Push lesen Tabellen, die
     * diese Migration nicht anfasst — bewiesen über den Fingerabdruck ALLER Messwert- und
     * Auswahl-Tabellen vor und nach der Migration, die Verdichtung der Rohwerte eingeschlossen.
     */
    @Test
    void dieBestandsflaechenLesenZeichengleichWeiter() {
        assertThat(fingerabdruckNachher).isEqualTo(fingerabdruckVorher);
        // Und der Fingerabdruck ist nicht die leere Menge: die Tabellen der Flächen tragen Bestand.
        for (String t : List.of("telemetry_v2", "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1d",
                "schedule", "device_measurement_sample", "device_measurement_rollup_5m",
                "device_measurement_rollup_15m", "device_measurement_selection")) {
            assertThat(anzahl("SELECT count(*) FROM " + t)).as(t + " trägt Bestand").isPositive();
        }
    }

    /**
     * Die Struktur der Tabelle: genau sieben Spalten mehr — hinten angehängt, alle bestehenden
     * unverändert in Typ, Nullbarkeit, Vorgabe und Reihenfolge. Genau EIN Index mehr, und der alte
     * Schlüssel steht Zeichen für Zeichen unverändert. Policy, RLS-Schalter, Trigger und Rechte
     * sind unberührt (die Grants sind tabellenweit, die neuen Spalten liegen damit ohne ein
     * weiteres GRANT im bisherigen Zaun).
     */
    @Test
    void dieMigrationIstStrengAdditiv() {
        List<String> vorher = zeilenListe(strukturVorher.get("spalten"));
        List<String> nachher = zeilenListe(strukturNachher.get("spalten"));
        assertThat(nachher).startsWith(vorher.toArray(new String[0]));
        assertThat(nachher.subList(vorher.size(), nachher.size()))
                .extracting(z -> z.split("\\|")[0]).containsExactlyElementsOf(NEUE_SPALTEN);
        for (String z : nachher.subList(vorher.size(), nachher.size())) {
            assertThat(z.split("\\|")[2]).as("jede neue Spalte ist nullbar: " + z).isEqualTo("YES");
            // Keine Vorgabe: format('%s', NULL) schreibt das leere Feld — nie ein geratener Wert.
            assertThat(z.split("\\|", -1)[3]).as("keine Vorgabe, kein geratener Wert: " + z)
                    .isEmpty();
        }

        List<String> indexeVorher = zeilenListe(strukturVorher.get("indexe"));
        List<String> indexeNachher = zeilenListe(strukturNachher.get("indexe"));
        assertThat(indexeNachher).containsAll(indexeVorher);
        assertThat(indexeNachher).hasSize(indexeVorher.size() + 1);
        assertThat(indexeNachher.stream().filter(i -> i.contains("uq_device_measurement_sample_reihe"))
                .findFirst().orElseThrow())
                .contains("(tenant_id, entity_id, point_key, \"time\")")
                .contains("WHERE ((entity_id IS NOT NULL) AND (role IS DISTINCT FROM 'spiegel'::text))");

        for (String teil : List.of("policies", "rls", "trigger", "rechte")) {
            assertThat(strukturNachher.get(teil)).as(teil + " unverändert")
                    .isEqualTo(strukturVorher.get(teil));
        }
        assertThat(strukturNachher.get("rls")).as("RLS und FORCE stehen").isEqualTo("true/true");
        // Die Migration vergibt kein einziges Recht: der Vergleich oben ist der Nachweis, und die
        // neuen Spalten liegen ohne weiteres GRANT im bisherigen (tabellenweiten) Zaun.
        assertThat(strukturNachher.get("rechte")).contains("voltpilot_app:SELECT")
                .contains("voltpilot_app:INSERT");
    }

    /** Aufbewahrung und Verdichtung sind nicht Sache dieses Pakets: unverändert 90 Tage, nie komprimiert. */
    @Test
    void aufbewahrungUndVerdichtungBleibenUnberuehrt() {
        assertThat(anzahl("SELECT count(*) FROM timescaledb_information.jobs "
                + "WHERE hypertable_name = 'device_measurement_sample' AND proc_name = 'policy_retention'"))
                .isEqualTo(1L);
        assertThat(anzahl("SELECT count(*) FROM timescaledb_information.jobs "
                + "WHERE hypertable_name = 'device_measurement_sample' AND proc_name = 'policy_compression'"))
                .isZero();
        assertThat(root.queryForObject("SELECT compression_enabled FROM timescaledb_information.hypertables "
                + "WHERE hypertable_name = 'device_measurement_sample'", Boolean.class)).isFalse();
    }

    // ---- Nachgetragen, nie geraten -----------------------------------------------------------

    /**
     * Der eindeutige Fall: zu (Gerät, Messkanal) steht genau eine Auswahlzeile mit Komponente —
     * jede Zeile der Reihe bekommt sie, und ihre Rolle bleibt OFFEN (die Rolle zur Messzeit
     * schlägt erst der Writer nach, IP-7; ein „führend" hier wäre geraten).
     */
    @Test
    void woDieAuswahlEindeutigIstTraegtJedeZeileIhreKomponente() {
        for (Map.Entry<String, String> reihe : Map.of("K-5", K5_KANAL, "K-3", K3_KANAL).entrySet()) {
            Map<String, Object> stand = nachtragJeKanal.get(AHRENBERG + "|" + reihe.getValue());
            long gesamt = (long) stand.get("gesamt");
            // Bis auf die eine doppelte Messzeit (E3, unten) trägt jede Zeile die Komponente.
            long doppelt = K5_KANAL.equals(reihe.getValue()) ? 1L : 0L;
            assertThat(gesamt).as(reihe.getKey()).isEqualTo(TAGE * 24L + doppelt);
            assertThat(stand.get("mit_komponente")).as(reihe.getKey()).isEqualTo(gesamt - doppelt);
            assertThat(stand.get("komponenten")).as(reihe.getKey() + ": genau EINE Komponente")
                    .isEqualTo(KOMPONENTEN.get(reihe.getKey()).toString());
            assertThat(stand.get("rolle_mit_komponente")).as("keine geratene Rolle").isEqualTo(0L);
        }
    }

    /**
     * Die drei uneindeutigen Fälle bleiben OHNE Komponente und bekommen die Rolle {@code spiegel}:
     * zwei baugleiche Geräte hinter einer Box (die zwei Fronius Eco von Herzogau) teilen einen
     * Messkanal; die alte BOX-Semantik ({@code entity_id IS NULL} in der Auswahl) sagt „die
     * Auswahl gehört dem Gerät als Ganzem", nicht „unbekannt"; und zu manchen Zeilen steht gar
     * keine Auswahlzeile mehr.
     */
    @Test
    void woDieAuswahlNichtEindeutigIstBleibtDieZeileSpiegelOhneKomponente() {
        for (String kanal : List.of(ZWEI_GERAETE_KANAL, BOX_SEMANTIK_KANAL, OHNE_AUSWAHL_KANAL)) {
            Map<String, Object> stand = nachtragJeKanal.get(PROBE + "|" + kanal);
            assertThat(stand.get("gesamt")).as(kanal).isEqualTo(TAGE * 24L);
            assertThat(stand.get("mit_komponente")).as(kanal + ": keine Komponente").isEqualTo(0L);
            assertThat(stand.get("spiegel")).as(kanal + ": jede Zeile Spiegel")
                    .isEqualTo(stand.get("gesamt"));
        }
        // Und keine Zeile des Bestands hat eine Rolle der ZUSTÄNDIGEN Spur bekommen: führend,
        // Vergleich und Beobachtung folgen aus der Quellenbindung zur Messzeit (IP-7), nie hier.
        assertThat(rollenAusserSpiegel).isZero();
        // Genau zwei Zustände, nichts dazwischen: Komponente ODER Spiegel.
        assertThat(xorVerstoesse).isZero();
    }

    /**
     * E3 auf den Bestand: der alte Schlüssel ließ zwei Zeilen zur selben Messzeit zu, sobald die
     * Sequenz sich unterschied. Nach der Migration trägt die Reihe den ZUERST entgegengenommenen
     * Wert; der zweite bleibt vollständig gespeichert, aber ohne Komponente (Spiegel). Nichts
     * wird gelöscht, nichts überschrieben.
     */
    @Test
    void dieDoppelteMesszeitDesBestandsFolgtE3DerErsteBleibtInDerReihe() {
        List<Map<String, Object>> zeilen = doppelZeilen;
        assertThat(zeilen).hasSize(2);
        assertThat(zeilen.get(0).get("entity_id")).as("der zuerst entgegengenommene bleibt in der Reihe")
                .isEqualTo(KOMPONENTEN.get("K-5"));
        assertThat(zeilen.get(0).get("role")).isNull();
        assertThat(zeilen.get(1).get("entity_id")).as("der zweite gibt die Komponente ab").isNull();
        assertThat(zeilen.get(1).get("role")).isEqualTo("spiegel");
        // Beide Werte stehen weiter da — der abweichende zweite ist nicht verschwunden.
        assertThat(zeilen).extracting(z -> z.get("decoded_numeric").toString())
                .containsExactly("1083415.2", "1083415.9");
        assertThat(zeilen).extracting(z -> z.get("edge_sequence")).containsExactly(48_213L, 48_291L);
    }

    /** Die übrigen Herkunftsspalten bleiben im Bestand LEER: null heißt „nicht nachgeschlagen". */
    @Test
    void derBestandBekommtKeineErfundeneHerkunft() {
        assertThat(erfundeneHerkunft).isZero();
        // Insbesondere ist die Wertart NICHT aus der Verdichtungsart abgeschrieben worden: die
        // steht in JEDER Zeile, die Wertart in keiner.
        assertThat(verdichtungsartGesetzt).isEqualTo(zeilenNachher);
    }

    /** Die Migration ist wiederholbar: derselbe Lauf noch einmal ändert keine einzige Zeile. */
    @Test
    void einZweiterLaufAendertNichts() {
        assertThat(nachDemZweitenLauf).isEqualTo(vorDemZweitenLauf);
        assertThat(spaltenNachDemZweitenLauf).isEqualTo(spaltenVorDemZweitenLauf);
    }

    // ---- Der neue Doppel-Erkennungsschlüssel (E3) ---------------------------------------------

    /**
     * Der Schlüsselwechsel in einem Satz: zur selben Reihe und Messzeit nimmt die Tabelle keinen
     * zweiten Wert mehr an — auch nicht mit einer anderen Sequenz und auch nicht aus einer anderen
     * Box. Genau das ließ der alte Schlüssel zu.
     */
    @Test
    void derNeueSchluesselWeistDenZweitenWertDerselbenReiheUndMesszeitAb() {
        Instant zeit = erstesMessfenster.plus(90, ChronoUnit.MINUTES);
        UUID k5 = KOMPONENTEN.get("K-5");
        schreibeRohwert(AHRENBERG, ahrenbergSite, ahrenbergBox, K5_KANAL, zeit, k5, null, 1_000.5, 70_001L);

        // Gleiche Messzeit, GLEICHER Wert, andere Sequenz: der alte Schlüssel hätte ihn genommen.
        abgelehnt("23505", "uq_device_measurement_sample_reihe", () -> schreibeRohwert(AHRENBERG,
                ahrenbergSite, ahrenbergBox, K5_KANAL, zeit, k5, null, 1_000.5, 70_002L));
        // Gleiche Messzeit, ABWEICHENDER Wert: der erste bleibt (E3), der zweite kommt nicht hinein.
        abgelehnt("23505", "uq_device_measurement_sample_reihe", () -> schreibeRohwert(AHRENBERG,
                ahrenbergSite, ahrenbergBox, K5_KANAL, zeit, k5, null, 1_000.9, 70_003L));
        // Auch aus einer ZWEITEN Box derselben Anlage: die Reihe gehört der Komponente, nicht der
        // Box (E2) — dieselbe Komponente aus zwei Boxen ist nie ein zweiter Wert.
        abgelehnt("23505", "uq_device_measurement_sample_reihe", () -> schreibeRohwert(AHRENBERG,
                ahrenbergSite, ahrenbergBox2, K5_KANAL, zeit, k5, null, 1_000.5, 70_004L));

        List<Map<String, Object>> gespeichert = root.queryForList("SELECT decoded_numeric, edge_sequence "
                + "FROM device_measurement_sample WHERE tenant_id = ? AND entity_id = ? "
                + "AND point_key = ? AND time = ?", AHRENBERG, k5, K5_KANAL, Timestamp.from(zeit));
        assertThat(gespeichert).hasSize(1);
        assertThat(gespeichert.get(0).get("decoded_numeric").toString()).isEqualTo("1000.5");
        assertThat(gespeichert.get(0).get("edge_sequence")).isEqualTo(70_001L);

        // Und die Wiederholung desselben Pakets bleibt EIN Wert: der Writer wird sie so abweisen,
        // wie E3 es sagt — ohne Ereignis, ohne zweite Zeile.
        assertThat(root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                + "site_id, device_id, point_key, raw_numeric, decoded_numeric, quality, "
                + "catalog_version, edge_sequence, aggregation_kind, gap, dropped_samples, entity_id) "
                + "VALUES (?, now(), ?, ?, ?, ?, 10005, 1000.5, 'good', ?, 70005, 'counter', false, 0, ?) "
                + "ON CONFLICT (tenant_id, entity_id, point_key, time) "
                + "WHERE entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel' DO NOTHING",
                Timestamp.from(zeit), AHRENBERG, ahrenbergSite, ahrenbergBox, K5_KANAL, KATALOG, k5))
                .as("gleiches Paket zweimal = ein Wert").isZero();
    }

    /**
     * Der SPIEGEL liegt außerhalb des Index (Vertrag §7.4, Abnahmefall A9): ein Wert einer zur
     * Messzeit nicht zuständigen Box verdrängt den führenden derselben Reihe und Messzeit nicht
     * und wird von ihm nicht verdrängt — beide stehen da, und zwei Spiegel zweier Boxen auch.
     */
    @Test
    void derSpiegelLiegtAusserhalbDesSchluessels() {
        Instant zeit = erstesMessfenster.plus(150, ChronoUnit.MINUTES);
        UUID k3 = KOMPONENTEN.get("K-3");
        schreibeRohwert(AHRENBERG, ahrenbergSite, ahrenbergBox, K3_KANAL, zeit, k3, "fuehrend", 61.3, 70_101L);
        schreibeRohwert(AHRENBERG, ahrenbergSite, ahrenbergBox2, K3_KANAL, zeit, k3, "spiegel", 61.3, 70_102L);
        schreibeRohwert(AHRENBERG, ahrenbergSite, ahrenbergBox, K3_KANAL, zeit, k3, "spiegel", 61.4, 70_103L);

        assertThat(root.queryForList("SELECT role, edge_sequence FROM device_measurement_sample "
                + "WHERE tenant_id = ? AND entity_id = ? AND point_key = ? AND time = ? "
                + "ORDER BY edge_sequence", AHRENBERG, k3, K3_KANAL, Timestamp.from(zeit)))
                .extracting(z -> z.get("role")).containsExactly("fuehrend", "spiegel", "spiegel");
        // Der zweite Wert der ZUSTÄNDIGEN Spur bleibt trotzdem abgewiesen.
        abgelehnt("23505", "uq_device_measurement_sample_reihe", () -> schreibeRohwert(AHRENBERG,
                ahrenbergSite, ahrenbergBox, K3_KANAL, zeit, k3, "vergleich", 61.3, 70_104L));
    }

    /**
     * Der ALTE Schlüssel steht daneben und weist weiter dieselben Zeilen ab wie vorher: dasselbe
     * Paket derselben Box (Gerät, Kanal, Messzeit, Sequenz) — auch ohne Komponente, also genau so,
     * wie der heutige Writer schreibt. Bis zur Umschaltung (IP-7) trägt ER die Wiederholung. Seit
     * AP-07 IP-18b (V20260922236000) heißt er {@code uq_device_measurement_sample_box} und gilt für
     * jede Zeile ohne {@code edge_entity_id} — für diesen Bestand also jede, mit derselben Folge.
     */
    @Test
    void derAlteSchluesselBleibtDerSchluesselDesHeutigenWriters() {
        Instant zeit = erstesMessfenster.plus(210, ChronoUnit.MINUTES);
        schreibeRohwert(PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, zeit, null, null, 3.3, 70_201L);
        abgelehnt("23505", "uq_device_measurement_sample_box", () -> schreibeRohwert(PROBE,
                probeSite, probeBox, OHNE_AUSWAHL_KANAL, zeit, null, null, 3.3, 70_201L));
        // Ohne Komponente ist der NEUE Index nie im Weg: eine andere Sequenz geht durch wie heute.
        schreibeRohwert(PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, zeit, null, null, 3.4, 70_202L);
        assertThat(anzahl("SELECT count(*) FROM device_measurement_sample WHERE tenant_id = ? "
                + "AND point_key = ? AND time = ?", PROBE, OHNE_AUSWAHL_KANAL, Timestamp.from(zeit)))
                .isEqualTo(2L);
    }

    /** Die geschlossenen Vokabulare: ein fremdes Wort wird abgewiesen, nie aufgelöst. */
    @Test
    void dieNeuenSpaltenNehmenNurDieWoerterDesVertrags() {
        Instant zeit = erstesMessfenster.plus(270, ChronoUnit.MINUTES);
        abgelehnt("23514", "device_measurement_sample_role_ck", () -> schreibeRohwert(PROBE, probeSite,
                probeBox, OHNE_AUSWAHL_KANAL, zeit, null, "leading", 1.0, 70_301L));
        abgelehnt("23514", "device_measurement_sample_value_kind_ck", () -> root.update(
                "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples, value_kind) VALUES (?, now(), ?, ?, ?, ?, "
                + "1, 'good', ?, 70302, 'gauge', false, 0, 'zaehlerstand')", Timestamp.from(zeit),
                PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, KATALOG));
        abgelehnt("23514", "device_measurement_sample_delivery_ck", () -> root.update(
                "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples, delivery, delay_s) VALUES (?, now(), ?, ?, "
                + "?, ?, 1, 'good', ?, 70303, 'gauge', false, 0, 'spaeter', 7)", Timestamp.from(zeit),
                PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, KATALOG));
        // Zustellart und Verzögerung sind EINE Angabe — eine Zahl ohne Art wäre eine Aussage ohne Beleg.
        abgelehnt("23514", "device_measurement_sample_delay_ck", () -> root.update(
                "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples, delay_s) VALUES (?, now(), ?, ?, ?, ?, 1, "
                + "'good', ?, 70304, 'gauge', false, 0, 7)", Timestamp.from(zeit), PROBE, probeSite,
                probeBox, OHNE_AUSWAHL_KANAL, KATALOG));
        abgelehnt("23514", "device_measurement_sample_applied_revision_ck", () -> root.update(
                "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples, applied_revision) VALUES (?, now(), ?, ?, "
                + "?, ?, 1, 'good', ?, 70305, 'gauge', false, 0, -1)", Timestamp.from(zeit), PROBE,
                probeSite, probeBox, OHNE_AUSWAHL_KANAL, KATALOG));
        // Die Verzögerung darf negativ sein: eine Box-Uhr, die innerhalb der Toleranz vorgeht.
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples, delivery, delay_s) VALUES (?, now(), ?, ?, "
                + "?, ?, 1, 'good', ?, 70306, 'gauge', false, 0, 'direkt', -300)",
                Timestamp.from(zeit), PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, KATALOG);
    }

    // ---- Der Zaun ----------------------------------------------------------------------------

    /**
     * Der Mandanten-Zaun steht unverändert: die App-Rolle liest die neuen Spalten im bisherigen
     * Zaun (tabellenweite Grants, diese Migration vergibt keines), sieht nur ihren Kundenbereich
     * und kommt in einen fremden nicht hinein.
     */
    @Test
    void derZaunUndDieRechteSindUnveraendert() {
        alsTue(AHRENBERG, () -> assertThat(app.queryForObject("SELECT count(*) FROM "
                + "device_measurement_sample WHERE entity_id IS NOT NULL", Long.class)).isPositive());
        alsTue(PROBE, () -> assertThat(app.queryForObject("SELECT count(*) FROM "
                + "device_measurement_sample WHERE tenant_id = ?", Long.class, AHRENBERG)).isZero());
        // Ein fremder Kundenbereich kommt auch nicht HINEIN (WITH CHECK der Policy). Auf einer
        // Hypertable meldet TimescaleDB den abgewiesenen Eintrag mit seinem eigenen Fehler statt
        // mit 42501 — geprüft wird deshalb, dass er abgewiesen wird UND nichts liegen bleibt.
        assertThat((Object) ablehnung(() -> alsTue(PROBE, () -> app.update(
                "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, gap, dropped_samples) VALUES (now(), now(), ?, ?, ?, "
                + "'fremder-eintrag', 1, 'good', ?, 1, 'gauge', false, 0)", AHRENBERG, ahrenbergSite,
                ahrenbergBox, KATALOG)))).as("kein Eintrag in einen fremden Kundenbereich").isNotNull();
        assertThat(anzahl("SELECT count(*) FROM device_measurement_sample "
                + "WHERE point_key = 'fremder-eintrag'")).isZero();
    }

    // ---- Gerüst: der Bestand -----------------------------------------------------------------

    private static void saeBestand() {
        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.HOURS);
        erstesMessfenster = jetzt.minus(TAGE, ChronoUnit.DAYS);
        doppelteMesszeit = jetzt.minus(10, ChronoUnit.DAYS);

        // ---- Ahrenberg: die eindeutigen Reihen -------------------------------------------
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText());
        JsonNode an1 = element(referenz.get("anlagen"), "AN-1");
        ahrenbergSite = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, ?, ?) RETURNING id", UUID.class, AHRENBERG, an1.get("name").asText(),
                OffsetDateTime.parse(an1.get("seit").asText()));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        ahrenbergBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, "
                + "created_at) VALUES (?, ?, ?, ?) RETURNING id", UUID.class, AHRENBERG, ahrenbergSite,
                e1.get("seriennummer").asText(), OffsetDateTime.parse(e1.get("in_betrieb_ab").asText()));
        ahrenbergBox2 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-BOX-2026-0482') RETURNING id", UUID.class, AHRENBERG,
                ahrenbergSite);

        komponente("K-5", AHRENBERG, ahrenbergSite, ahrenbergBox, "modbus-generic");
        komponente("K-3", AHRENBERG, ahrenbergSite, ahrenbergBox, "grid-meter");
        auswahl(AHRENBERG, ahrenbergSite, ahrenbergBox, K5_KANAL, KOMPONENTEN.get("K-5"), "counter", 900);
        auswahl(AHRENBERG, ahrenbergSite, ahrenbergBox, K3_KANAL, KOMPONENTEN.get("K-3"), "gauge", 300);
        reihe(AHRENBERG, ahrenbergSite, ahrenbergBox, K5_KANAL, "counter", 900, 1_080_000, 1.7, 10_000);
        reihe(AHRENBERG, ahrenbergSite, ahrenbergBox, K3_KANAL, "gauge", 300, 140, 0.3, 20_000);

        // Die doppelte Messzeit des Bestands (§2.4): zwei Zeilen, unterschiedliche Sequenz,
        // unterschiedlicher Wert — der alte Schlüssel nahm beide. Der zweite kam SPÄTER an.
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, "
                + "edge_sequence, aggregation_kind, long_term_cadence_s, gap, dropped_samples) "
                + "VALUES (?, ?, ?, ?, ?, ?, 10834159, 1083415.9, 'good', ?, 48291, 'counter', 900, "
                + "false, 0)", Timestamp.from(doppelteMesszeit),
                Timestamp.from(doppelteMesszeit.plusSeconds(3_600)), AHRENBERG, ahrenbergSite,
                ahrenbergBox, K5_KANAL, KATALOG);
        root.update("UPDATE device_measurement_sample SET raw_numeric = 10834152, "
                + "decoded_numeric = 1083415.2, edge_sequence = 48213, received_at = ? "
                + "WHERE tenant_id = ? AND point_key = ? AND time = ? AND edge_sequence <> 48291",
                Timestamp.from(doppelteMesszeit.plusSeconds(7)), AHRENBERG, K5_KANAL,
                Timestamp.from(doppelteMesszeit));

        // ---- Der Probe-Kundenbereich: die drei uneindeutigen Fälle -----------------------
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich Probe')", PROBE);
        probeSite = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Probe') "
                + "RETURNING id", UUID.class, PROBE);
        probeBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-BOX-PROBE-0001') RETURNING id", UUID.class, PROBE, probeSite);

        // a) Zwei baugleiche Geräte hinter EINER Box teilen den Messkanal: zwei Auswahlzeilen.
        komponente("Fronius Eco West", PROBE, probeSite, probeBox, "pv-generation");
        komponente("Fronius Eco Ost", PROBE, probeSite, probeBox, "pv-generation");
        auswahl(PROBE, probeSite, probeBox, ZWEI_GERAETE_KANAL,
                KOMPONENTEN.get("Fronius Eco West"), "gauge", 300);
        auswahl(PROBE, probeSite, probeBox, ZWEI_GERAETE_KANAL,
                KOMPONENTEN.get("Fronius Eco Ost"), "gauge", 300);
        // b) Die alte BOX-Semantik: eine Auswahlzeile OHNE Komponente.
        komponente("Wallbox", PROBE, probeSite, probeBox, "consumer");
        auswahl(PROBE, probeSite, probeBox, BOX_SEMANTIK_KANAL, null, "gauge", 300);
        // c) Gar keine Auswahlzeile mehr (abgewählt und weggeräumt, oder nie eine gehabt).
        reihe(PROBE, probeSite, probeBox, ZWEI_GERAETE_KANAL, "gauge", 300, 4_500, 1.1, 30_000);
        reihe(PROBE, probeSite, probeBox, BOX_SEMANTIK_KANAL, "gauge", 300, 11_000, 0.9, 40_000);
        reihe(PROBE, probeSite, probeBox, OHNE_AUSWAHL_KANAL, "gauge", 300, 2_200, 0.5, 50_000);

        // ---- Was die Bestandsflächen lesen ----------------------------------------------
        saeBestandsflaechen(AHRENBERG, ahrenbergSite, ahrenbergBox);
    }

    /** Cockpit/Erlöse/Verlauf (telemetry_v2 + Verdichtungen) und Fahrplan (schedule). */
    private static void saeBestandsflaechen(UUID tenant, UUID site, UUID box) {
        String entity = KOMPONENTEN.get("K-3").toString();
        UUID plan = UUID.randomUUID();
        for (int i = 0; i < 96; i++) {
            Instant t = erstesMessfenster.plus(Duration.ofMinutes(15L * i));
            root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                    + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, 'power_kw', ?)",
                    Timestamp.from(t), Timestamp.from(t.plusSeconds(4)), tenant, site, box, entity,
                    40.0 + i * 0.25);
            root.update("INSERT INTO telemetry_v2_rollup_15m (bucket, tenant_id, site_id, entity_id, "
                    + "channel, avg_value, min_value, max_value, last_value, n_samples) "
                    + "VALUES (?, ?, ?, ?, 'power_kw', ?, 10, 90, ?, 90)", Timestamp.from(t), tenant,
                    site, entity, 40.0 + i * 0.25, 40.0 + i * 0.25);
            root.update("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, "
                    + "generated_at, battery_kw, soc_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    Timestamp.from(t), tenant, site, box, plan, Timestamp.from(erstesMessfenster),
                    -4.5 + i * 0.1, 30 + (i % 60));
        }
        for (int tag = 0; tag < TAGE; tag++) {
            Instant t = erstesMessfenster.plus(tag, ChronoUnit.DAYS);
            root.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, "
                    + "channel, avg_value, min_value, max_value, last_value, n_samples) "
                    + "VALUES (?, ?, ?, ?, 'power_kw', 48.5, 0, 120, 51.2, 96)", Timestamp.from(t),
                    tenant, site, entity);
        }
    }

    private static void komponente(String name, UUID tenant, UUID site, UUID box, String art) {
        UUID id = UUID.fromString(String.format("4e070000-0000-0000-0001-%012d", KOMPONENTEN.size() + 1));
        root.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, source_kind, communication, connection_json) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, false, 'custom', 'modbus_tcp', '{}'::jsonb)",
                id, tenant, site, art, name, art, box);
        KOMPONENTEN.put(name, id);
    }

    private static void auswahl(UUID tenant, UUID site, UUID box, String kanal, UUID entity,
            String art, int langfristig) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                + "point_key, entity_id, enabled, cadence_s, desired_revision, enabled_at, "
                + "catalog_version, changed_by, apply_status, applied_at, retention_class, "
                + "long_term_cadence_s, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, ?, ?, "
                + "'demo', 'applied', ?, ?, ?, ?)", tenant, site, box, kanal, entity,
                Timestamp.from(erstesMessfenster), KATALOG, Timestamp.from(erstesMessfenster),
                "counter".equals(art) ? "energy_counter" : "live_power", langfristig,
                langfristig == 900 ? "fifteen_minute" : "five_minute");
    }

    /** Eine Reihe über {@link #TAGE} Tage, stündlich — der Bestand, den die Migration vorfindet. */
    private static void reihe(UUID tenant, UUID site, UUID box, String kanal, String art,
            int langfristig, double start, double schritt, long sequenz) {
        List<Object[]> zeilen = new ArrayList<>();
        for (int stunde = 0; stunde < TAGE * 24; stunde++) {
            Instant t = erstesMessfenster.plus(stunde, ChronoUnit.HOURS);
            double wert = start + stunde * schritt;
            zeilen.add(new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(7)), tenant, site,
                    box, kanal, Math.round(wert * 10), wert, "good", KATALOG, sequenz + stunde, art,
                    langfristig});
        }
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                + "site_id, device_id, point_key, raw_numeric, decoded_numeric, quality, "
                + "catalog_version, edge_sequence, aggregation_kind, long_term_cadence_s, gap, "
                + "dropped_samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, 0)", zeilen);
    }

    private static void schreibeRohwert(UUID tenant, UUID site, UUID box, String kanal, Instant zeit,
            UUID entity, String rolle, double wert, long sequenz) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, "
                + "edge_sequence, aggregation_kind, gap, dropped_samples, entity_id, role) "
                + "VALUES (?, now(), ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'gauge', false, 0, ?, ?)",
                Timestamp.from(zeit), tenant, site, box, kanal, Math.round(wert * 10), wert, KATALOG,
                sequenz, entity, rolle);
    }

    private static void verdichte() {
        root.execute("CALL device_measurement_rollup_job(0, NULL::jsonb)");
    }

    // ---- Gerüst: Fingerabdruck und Schnappschuss ---------------------------------------------

    /**
     * Der Fingerabdruck jeder Bestands-Tabelle. Für die Rohtabelle OHNE die neuen Spalten (sie
     * kommen ja gerade dazu) — jede andere Spalte, jede Zeile, jede Zahl muss zeichengleich
     * bleiben.
     */
    private static Map<String, String> fingerabdruecke() {
        Map<String, String> m = new LinkedHashMap<>();
        for (String t : BESTAND) {
            String zeile = "device_measurement_sample".equals(t)
                    ? "to_jsonb(x) - '{" + String.join(",", NEUE_SPALTEN) + "}'::text[]"
                    : "to_jsonb(x)";
            m.put(t, root.queryForObject("SELECT md5(coalesce(string_agg(z, E'\\n' ORDER BY z), '')) "
                    + "FROM (SELECT (" + zeile + ")::text AS z FROM " + t + " x) AS zeilen",
                    String.class));
        }
        return m;
    }

    /**
     * Je Kundenbereich und Messkanal: wie viele Zeilen, wie viele mit Komponente, wie viele
     * Spiegel, welche Komponenten (sortiert, damit „genau eine" prüfbar ist) und wie viele eine
     * Rolle trotz Komponente haben.
     */
    private static Map<String, Map<String, Object>> nachtragJeKanal() {
        Map<String, Map<String, Object>> m = new LinkedHashMap<>();
        for (Map<String, Object> z : root.queryForList("SELECT tenant_id, point_key, count(*) "
                + "AS gesamt, count(entity_id) AS mit_komponente, count(*) FILTER "
                + "(WHERE role = 'spiegel') AS spiegel, count(*) FILTER (WHERE entity_id IS NOT NULL "
                + "AND role IS NOT NULL) AS rolle_mit_komponente, string_agg(DISTINCT "
                + "entity_id::text, ',' ORDER BY entity_id::text) AS komponenten "
                + "FROM device_measurement_sample GROUP BY 1, 2")) {
            m.put(z.get("tenant_id") + "|" + z.get("point_key"), z);
        }
        return m;
    }

    /** Alle Spalten der Rohtabelle, die neuen eingeschlossen — für den Nachweis der Wiederholbarkeit. */
    private static String alleSpaltenFingerabdruck() {
        return root.queryForObject("SELECT md5(coalesce(string_agg(z, E'\\n' ORDER BY z), '')) FROM "
                + "(SELECT to_jsonb(x)::text AS z FROM device_measurement_sample x) AS zeilen",
                String.class);
    }

    /** Was eine Migration an einer Tabelle ändern könnte: Spalten, Indexe, Policies, RLS, Trigger, Rechte. */
    private static Map<String, String> schnappschuss(String tabelle) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', column_name, "
                + "data_type, is_nullable, column_default, ordinal_position), E'\\n' "
                + "ORDER BY ordinal_position) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        s.put("indexe", root.queryForObject("SELECT coalesce(string_agg(indexdef, E'\\n' "
                + "ORDER BY indexname), '') FROM pg_indexes WHERE schemaname = 'public' "
                + "AND tablename = ?", String.class, tabelle));
        s.put("policies", root.queryForObject("SELECT coalesce(string_agg(policyname || ':' || "
                + "coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' ORDER BY policyname), "
                + "'') FROM pg_policies WHERE tablename = ?", String.class, tabelle));
        s.put("rls", root.queryForObject("SELECT relrowsecurity || '/' || relforcerowsecurity "
                + "FROM pg_class WHERE oid = ?::regclass", String.class, tabelle));
        s.put("trigger", root.queryForObject("SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), "
                + "'') FROM pg_trigger WHERE tgrelid = ?::regclass AND NOT tgisinternal",
                String.class, tabelle));
        s.put("rechte", root.queryForObject("SELECT coalesce(string_agg(grantee || ':' || "
                + "privilege_type, ',' ORDER BY grantee, privilege_type), '') "
                + "FROM information_schema.role_table_grants WHERE table_schema = 'public' "
                + "AND table_name = ?", String.class, tabelle));
        return s;
    }

    private static List<String> zeilenListe(String mehrzeilig) {
        return mehrzeilig == null || mehrzeilig.isEmpty() ? List.of() : List.of(mehrzeilig.split("\n"));
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode n : liste) {
            if (kennzeichen.equals(n.path("kennzeichen").asText())) {
                return n;
            }
        }
        throw new IllegalArgumentException("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
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

    /**
     * Die Datenbank muss ablehnen. Auf einer Hypertable nennt sie den Index bzw. Constraint des
     * CHUNKS (mit Präfix) — geprüft wird deshalb, dass der Name unseren enthält.
     */
    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).as("der Name des Schlüssels/Constraints").contains(constraint);
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    // ---- Gerüst: Flyway ----------------------------------------------------------------------

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
        String sql;
        try (InputStream in = UemsMesswertRohtabelleMigrationTest.class
                .getResourceAsStream("/db/migration/" + DATEI)) {
            sql = new String(Objects.requireNonNull(in, DATEI).readAllBytes(), StandardCharsets.UTF_8);
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
