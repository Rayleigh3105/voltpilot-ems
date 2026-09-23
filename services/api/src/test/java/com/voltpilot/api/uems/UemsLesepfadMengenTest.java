package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static com.voltpilot.api.measurement.BestandGeraeteCsvVergleich.erzeugung;
import static com.voltpilot.api.measurement.BestandGeraeteCsvVergleich.ohneNeueKopfzeilen;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.MeasurementHistoryService.Datum;
import com.voltpilot.api.measurement.MeasurementHistoryService.EnergieAusLeistung;
import com.voltpilot.api.measurement.MeasurementHistoryService.History;
import com.voltpilot.api.measurement.MeasurementHistoryService.Marker;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der LESEPFAD holt auf (UEMS-Nacharbeit zu AP-07 IP-14): was AP-08 IP-5 (Perioden-Mengen), IP-3
 * (Energie aus Leistung) und IP-4 (Überlauf) in die Speicherklassen geschrieben haben, erscheint
 * jetzt auch im Verlauf — gegen eine echte TimescaleDB, gebildet von den ECHTEN Läufen.
 *
 * <p><b>Die Beispielwelt</b> ist Ahrenberg (Box Halle 2, AN-2, Zeitzone Europe/Berlin): F8 der
 * Vektor-Datei (03.11.2026, 3,5 Stunden Box-Ausfall), eine Stunde mit einer Lücke von 35 Minuten
 * (10.11.2026), eine Leistung mit Quellenbindung {@code integration} und dieselbe ohne (12.11.2026),
 * dazu ein Zähler, dessen Stand über das Ende seines Wertebereichs läuft. Die Rohwerte des November
 * sind danach gelöscht (derselbe Zustand wie nach dem Chunk-Drop), die Uhr steht auf dem 10.04.2027.
 *
 * <p><b>Neue Felder werden über das JSON gelesen</b>, nicht über Record-Zugriffe: die Aussage-Tests
 * liefen so unverändert auch gegen den Stand VOR der Nacharbeit (origin/uems 0de28e6e, ohne die
 * beiden später ergänzten Tests für Lockstep und Energie-Wächter) — die Vorher-Zahlen im PR-Text und
 * {@link #FLAECHE_VORHER} sind ihre Ausgabe.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsLesepfadMengenTest {

    /** Katalog mit den Testkanälen {@code energy_kwh_*} als kWh-Zähler ({@link UemsTestKatalog}). */
    private static final MeasurementCatalog KATALOG = UemsTestKatalog.mitKwhTestkanaelen();
    /** Der Laufzeitstand des Katalogs, unter dem {@link #FLAECHE_VORHER} aufgenommen wurde. */
    private static final String LAUFZEITSTAND_DER_AUFNAHME = "2026.08.26.3";

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-0000000000b7");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-0000000000b8");

    /** Die Uhr des Lesers: die Rohdaten-Frist endet am 10.01.2027 12:00 UTC. */
    private static final Instant JETZT = Instant.parse("2027-04-10T12:00:00Z");

    /** Die Läufe des November liefen kurz nach den Messungen. */
    private static final Instant T_BILDEN = Instant.parse("2026-11-20T12:00:00Z");

    private static final String F8 = "deye.hybrid_1p.meter.today-energy-import";
    private static final String H = "deye.hybrid_1p.meter.today-load-consumption";
    private static final String Z = "deye.hybrid_1p.meter.total-battery-charge";
    private static final String P = "deye.hybrid_1p.grid.grid-power";
    private static final String P0 = "deye.hybrid_1p.grid.external-power";
    /** Ein Zähler, dessen Kadenz MITTEN in einer Stunde wechselt (Befund aus PR 725). */
    private static final String K = "deye.hybrid_1p.meter.today-energy-export";

    /** 96 Tage — jenseits der Frist und über 90 Tage: die Tagesklasse. */
    private static final Instant TAG_VON = Instant.parse("2026-10-01T00:00:00Z");
    private static final Instant TAG_BIS = Instant.parse("2027-01-05T00:00:00Z");

    /** 80 Tage — jenseits der Frist, Viertelstundenwerte im Raster von einer Stunde. */
    private static final Instant GROB_VON = Instant.parse("2026-10-01T00:00:00Z");
    private static final Instant GROB_BIS = Instant.parse("2026-12-20T00:00:00Z");

    private static final String INTEGRIERT = "aus Leistung integriert";

    private static final Pattern KENNUNG =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    /**
     * Die Fläche INNERHALB der Frist und die unveränderten Teile des Rückfalls — aufgenommen mit
     * genau dieser Klasse auf dem Stand VOR der Nacharbeit (origin/uems 0de28e6e).
     */
    private static final Map<String, String> FLAECHE_VORHER = Map.ofEntries(
            Map.entry("Zähler roh 09.04. decoded JSON", "f5cd38062508356cf78a552bfbcc428d"),
            Map.entry("Zähler roh 09.04. decoded CSV", "223af6c7d59304be91039a990b98b830"),
            Map.entry("Zähler roh 09.04. raw JSON", "b32d4b7344dd1707b35858afd48d8331"),
            Map.entry("Zähler roh 09.04. raw CSV", "954792dbbd62de62006e1896e55d1dcf"),
            Map.entry("Leistung roh 09.04. decoded JSON", "69f77406deb28490670043833b6eb93a"),
            Map.entry("Leistung roh 09.04. decoded CSV", "a55383981869e8f805c6f276b7209f44"),
            Map.entry("Leistung roh 09.04. raw JSON", "2f6fbaf5b94a642e7855ce09e2ce0030"),
            Map.entry("Leistung roh 09.04. raw CSV", "d4ab2f324c6bfb0447dc5cf9ddacbf3f"),
            Map.entry("F8 Viertelstunden 03.11. CSV", "29da8d7b042f239c06cba61c86e80161"),
            Map.entry("F8 Viertelstunden 03.11. Bestandsfelder", "131eb5918dfcf09f382fecd753b6ec0d"),
            Map.entry("Leistung Viertelstunden 12.11. CSV", "6377bdeb947b98ff79aaf77b40082615"),
            Map.entry("Leistung Viertelstunden 12.11. Bestandsfelder", "20b906466409467377e9ab79bdd6cb65"),
            Map.entry("Leistung Stunden CSV", "6b361ae9c62b7c11614fc90268253612"));

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final ObjectMapper JSON = JsonMapper.builder().addModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS).build();

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static MeasurementHistoryService verlauf;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    // =========================================================================== Aufbau

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        stammdaten();

        // ---- November 2026: Rohwerte, die echten Läufe, dann die Frist ------------------------
        JsonNode f8 = null;
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith("f8-")) {
                f8 = fall;
            }
        }
        saeen(F8, "counter", VerbrauchVectorsTest.rohwerte(f8.path("input").path("reihe")));
        saeen(H, "counter", stundeMitLuecke());
        saeen(P, "gauge", leistung(Instant.parse("2026-11-12T09:00:00Z"), 60));
        saeen(P0, "gauge", leistung(Instant.parse("2026-11-12T09:00:00Z"), 60));
        saeen(K, "counter", kadenzWechsel());

        JdbcTemplate admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ViertelstundeVerdichter viertelstunden = new ViertelstundeVerdichter(admin,
                KATALOG, new SpaetankunftMelder(), 500, 40, 200_000);
        EndgueltigkeitLauf endgueltigkeit = new EndgueltigkeitLauf(admin, 2000, 200);
        TagVerdichter tage = new TagVerdichter(admin, KATALOG, 200, 40, 20_000, 200_000);
        root.update("""
                INSERT INTO messreihe_viertelstunde_arbeit (tenant_id, entity_id, messkanal, intervall_beginn, grund)
                SELECT DISTINCT s.tenant_id, s.entity_id, s.point_key,
                       to_timestamp(floor(extract(epoch FROM s.time) / 900) * 900), 'eingang'
                  FROM device_measurement_sample s WHERE s.entity_id IS NOT NULL
                ON CONFLICT DO NOTHING
                """);
        while (viertelstunden.verdichteEinenStapel(T_BILDEN)[0] > 0) {
            // bis die Liste leer ist
        }
        endgueltigkeit.umschalten(T_BILDEN);
        root.update("""
                INSERT INTO messreihe_tag_arbeit (tenant_id, entity_id, messkanal, utc_tag, grund)
                SELECT DISTINCT v.tenant_id, v.entity_id, v.messkanal,
                       (v.intervall_beginn AT TIME ZONE 'UTC')::date, 'viertelstunde'
                  FROM messreihe_viertelstunde v
                ON CONFLICT DO NOTHING
                """);
        while (tage.bildeEinenStapel(T_BILDEN)[0] > 0) {
            // bis die Liste leer ist
        }
        endgueltigkeit.umschalten(JETZT);
        tage.eintragenAusFrist(JETZT);
        while (tage.bildeEinenStapel(JETZT)[0] > 0) {
            // bis die Liste leer ist
        }
        // Die Retention hat die Rohwerte des November gelöscht (A2: „Simulation: Chunk-Drop").
        root.update("DELETE FROM device_measurement_sample WHERE time < '2027-01-01'");

        // ---- April 2027: Rohwerte INNERHALB der Frist, dazu die Zählerbrüche ------------------
        saeen(Z, "counter", ueberlaufUndRuecksetzung());
        saeen(Z, "counter", ruhigerZaehler());
        saeen(P, "gauge", leistung(Instant.parse("2027-04-09T01:00:00Z"), 120));
        zaehlerbrueche();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        verlauf = new MeasurementHistoryService(app, KATALOG,
                new MeasurementSelectionRepository(app), new SpeicherklasseHistorie(app, KATALOG),
                Clock.fixed(JETZT, ZoneOffset.UTC));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ 1. Die Perioden-Mengen

    /**
     * F8, der Kern: der 03.11.2026 hatte 3,5 Stunden Box-Ausfall. Die Tagesklasse trägt die Menge
     * aus den Periodenständen — 2 304,0 kWh, vollständig, Abdeckung 85 % — und der Verlauf zeigt
     * GENAU sie. Die Summe der Viertelstunden (1 966,4 kWh) verlöre den gemessenen Zuwachs über den
     * Ausfall (337,6 kWh); vor der Nacharbeit zeigte die Tagesklasse gar keinen Wert.
     */
    @Test
    void derTagMitAusfallZeigtDieTagesmengeUndNichtDieSumme() {
        TenantContext.set(KB);
        History h = frei(F8, TAG_VON, TAG_BIS);
        assertThat(h.meta().quelle()).isEqualTo("tag");
        int i = index(h, Instant.parse("2026-11-02T23:00:00Z"));
        Datum tag = h.data().get(i);
        JsonNode herkunft = JSON.valueToTree(h).path("data").get(i).path("herkunft");

        BigDecimal summe = root.queryForObject("SELECT sum(menge) FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND intervall_beginn >= '2026-11-02T23:00:00Z' "
                + "AND intervall_beginn < '2026-11-03T23:00:00Z'", BigDecimal.class, IDS.get(F8));
        assertThat(summe).as("die Summe der Viertelstunden").isEqualByComparingTo("1966.4");

        assertThat(tag.value()).as("die gespeicherte Tagesmenge, nicht die Summe")
                .isEqualByComparingTo("2304.0");
        assertThat(herkunft.path("mengeZustand").asText()).isEqualTo("vollständig");
        assertThat(tag.herkunft().abdeckungProzent()).isEqualTo(85);
        assertThat(texte(herkunft.path("kennzeichen"))).as("die Kennzeichen des Tages, wie gespeichert")
                .isEqualTo(texte(root.queryForObject("SELECT kennzeichen::text FROM messreihe_tag "
                        + "WHERE entity_id = ? AND tag = '2026-11-03'", String.class, IDS.get(F8))));
        assertThat(tag.value().subtract(summe)).as("der Zuwachs über den Ausfall")
                .isEqualByComparingTo("337.6");
    }

    /**
     * Das grobe Raster: 80 Tage werden in Stunden gezeichnet. Die Stunde 10:00–11:00 am 10.11.2026
     * hat eine Lücke von 35 Minuten — die Summe ihrer drei Viertelstunden-Zeilen ist 40,0 kWh und
     * sah vollständig aus, weil eine Viertelstunde OHNE Rohwert gar keine Zeile hat. Die Stunde aus
     * ihren Periodenständen (freier Zeitraum, AP-08 P7) ist 96,0 kWh mit dem Lücken-Kennzeichen.
     */
    @Test
    void imGrobenRasterIstDieStundeEinZeitraumUndKeineSumme() {
        TenantContext.set(KB);
        History h = frei(H, GROB_VON, GROB_BIS);
        assertThat(h.meta().quelle()).isEqualTo("viertelstunde");
        assertThat(h.meta().bucketSeconds()).isEqualTo(3600);

        Instant stunde = Instant.parse("2026-11-10T09:00:00Z");
        Map<String, Object> zeilen = root.queryForMap("SELECT sum(menge) s, count(*) n, count(menge) m "
                + "FROM messreihe_viertelstunde WHERE entity_id = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?", IDS.get(H), Timestamp.from(stunde),
                Timestamp.from(stunde.plusSeconds(3600)));
        assertThat((BigDecimal) zeilen.get("s")).as("die Summe der Viertelstunden-Zeilen")
                .isEqualByComparingTo("40.0");
        assertThat(((Number) zeilen.get("n")).intValue()).as("drei Zeilen, jede mit Menge").isEqualTo(3);
        assertThat(((Number) zeilen.get("m")).intValue()).isEqualTo(3);

        int i = index(h, stunde);
        JsonNode herkunft = JSON.valueToTree(h).path("data").get(i).path("herkunft");
        assertThat(h.data().get(i).value()).as("Stand 11:00 − Stand 10:00").isEqualByComparingTo("96.0");
        assertThat(herkunft.path("mengeZustand").asText()).isEqualTo("vollständig");
        assertThat(texte(herkunft.path("kennzeichen"))).containsExactly(
                "Lücke 10:05–10:40: Zuwachs 56,0 kWh gemessen, nicht auf Viertelstunden verteilbar");

        assertThat(h.data().get(index(h, stunde.minusSeconds(3600))).value())
                .as("eine volle Stunde davor").isEqualByComparingTo("96.0");
    }

    /**
     * F8 im groben Raster: die Stunde 17:00–18:00 Ortszeit ist eine Erwartung der Vektor-Datei —
     * 46,4 kWh, unvollständig, „Anfang nicht gemessen". Dieselbe Zahl wie vorher (dort zufällig
     * gleich der Summe), jetzt mit Zustand und Kennzeichen.
     */
    @Test
    void dieVektorStundeVonF8StehtImGrobenRaster() {
        TenantContext.set(KB);
        History h = frei(F8, GROB_VON, GROB_BIS);
        int i = index(h, Instant.parse("2026-11-03T16:00:00Z"));
        JsonNode herkunft = JSON.valueToTree(h).path("data").get(i).path("herkunft");
        assertThat(h.data().get(i).value()).isEqualByComparingTo("46.4");
        assertThat(herkunft.path("mengeZustand").asText()).isEqualTo("unvollständig");
        assertThat(texte(herkunft.path("kennzeichen")))
                .containsExactly("Anfang nicht gemessen (kein Stand an der Periodengrenze)");
    }

    /**
     * GEGENPROBE zum Befund aus PR 725 — F8, Stunde 17:00–18:00 Ortszeit. Zwei ihrer vier Viertelstunden haben
     * keinen einzigen Rohwert und darum keine Zeile. Die Stunde erwartet trotzdem 60 Werte, nicht die 30 der
     * beiden vorhandenen: 29 von 60 = 48 % wie in der Vektor-Datei. Vorher stand hier 29 von 30 = 96 % —
     * eine fast vollständige Stunde, der die halbe Zeit fehlt, neben einer richtigen Menge.
     */
    @Test
    void gegenprobeF8Stunde17UhrHatAchtundvierzigProzentNichtSechsundneunzig() {
        TenantContext.set(KB);
        Instant stunde = Instant.parse("2026-11-03T16:00:00Z");
        Map<String, Object> zeilen = root.queryForMap("SELECT count(*) AS n, sum(erwartet) AS erwartet "
                + "FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?", IDS.get(F8), F8, Timestamp.from(stunde),
                Timestamp.from(stunde.plusSeconds(3600)));
        assertThat(((Number) zeilen.get("n")).intValue()).as("zwei Viertelstunden ohne Zeile").isEqualTo(2);
        assertThat(((Number) zeilen.get("erwartet")).intValue()).as("was die Zeilen allein erwarten").isEqualTo(30);

        History h = frei(F8, GROB_VON, GROB_BIS);
        JsonNode herkunft = JSON.valueToTree(h).path("data").get(index(h, stunde)).path("herkunft");
        assertThat(herkunft.path("erhalten").asInt()).isEqualTo(29);
        assertThat(herkunft.path("erwartet").asInt()).as("Zeitraum ÷ Kadenz, nicht die Summe der Zeilen")
                .isEqualTo(60);
        assertThat(herkunft.path("abdeckungProzent").asInt()).as("48 %, nicht 96 %").isEqualTo(48);
    }

    /**
     * Die Kadenz wechselt INNERHALB der Stunde (Reihe K, 05.11.2026, 11:00–12:00 Ortszeit): 60 s bis 11:15,
     * 30 s bis 11:30, 120 s bis 13:00, heute 300 s. Die Viertelstunden 11:15 und 11:30 haben keine Zeile;
     * jede erwartet, was ZU IHRER ZEIT galt — 30 und 7 —, dazu die gespeicherten 15 und 7 der beiden
     * vorhandenen: 59. Jede andere Kadenz verrät sich: die von jetzt ergäbe 28, die der jüngsten Zeile 37,
     * die zum Stundenbeginn 52, die Zeilen allein 22.
     */
    @Test
    void einKadenzWechselInDerStundeZaehltJedeFehlendeViertelstundeMitIhrerKadenz() {
        TenantContext.set(KB);
        Instant stunde = Instant.parse("2026-11-05T10:00:00Z");
        List<Map<String, Object>> zeilen = root.queryForList("SELECT erhalten, erwartet, kadenz_s "
                + "FROM messreihe_viertelstunde WHERE entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ? ORDER BY intervall_beginn", IDS.get(K), K, Timestamp.from(stunde),
                Timestamp.from(stunde.plusSeconds(3600)));
        assertThat(zeilen).extracting(z -> ((Number) z.get("kadenz_s")).intValue())
                .as("11:00 und 11:45 — jede Zeile mit der Kadenz zu ihrem Beginn").containsExactly(60, 120);
        assertThat(zeilen).extracting(z -> ((Number) z.get("erwartet")).intValue()).containsExactly(15, 7);
        int erhalten = zeilen.stream().mapToInt(z -> ((Number) z.get("erhalten")).intValue()).sum();

        History h = frei(K, GROB_VON, GROB_BIS);
        JsonNode herkunft = JSON.valueToTree(h).path("data").get(index(h, stunde)).path("herkunft");
        assertThat(herkunft.path("erwartet").asInt()).as("15 + 30 + 7 + 7").isEqualTo(59);
        assertThat(herkunft.path("erhalten").asInt()).isEqualTo(erhalten);
        assertThat(herkunft.path("abdeckungProzent").asInt())
                .isEqualTo(SpeicherklasseHistorie.abdeckung(erhalten, 59));

        // Der freie Zeitraum derselben Stunde sagt dasselbe — eine Kadenz-Kette, zwei Wege.
        ZeitraumMenge.Zeitraum z = new ZeitraumMenge(app, KATALOG).zeitraum(KB, IDS.get(K), K, stunde,
                stunde.plusSeconds(3600), JETZT);
        assertThat(z.erhalten()).isEqualTo(erhalten);
        assertThat(z.erwartet()).isEqualTo(59);
    }

    /**
     * Lockstep: JEDER Schritt des groben Rasters ist genau das, was die Regel für ihn sagt — der
     * Zählerstand gegen {@link ZeitraumMenge#zeitraum} (freier Zeitraum, P7), die Leistung gegen
     * {@link ViertelstundenTeile#werte} über {@link ViertelstundenTeile#laden}. Der Lesepfad ruft die
     * Regel auf; der eine Lesezug für alle Schritte ändert an keiner Zahl etwas.
     */
    @Test
    void jederSchrittDesGrobenRastersIstDieRegelFuerDiesenZeitraum() {
        TenantContext.set(KB);
        ZeitraumMenge zeitraum = new ZeitraumMenge(app, KATALOG);
        int geprueft = 0;
        for (String kanal : List.of(F8, H)) {
            History h = frei(kanal, GROB_VON, GROB_BIS);
            JsonNode daten = JSON.valueToTree(h).path("data");
            for (int i = 0; i < h.data().size(); i++) {
                Instant von = h.data().get(i).time();
                ZeitraumMenge.Zeitraum sollZeitraum = zeitraum.zeitraum(KB, IDS.get(kanal), kanal, von,
                        von.plusSeconds(3600), JETZT);
                VerbrauchRegeln.Ergebnis soll = sollZeitraum.menge().ergebnis();
                BigDecimal ist = h.data().get(i).value();
                assertThat(ist == null ? null : ist.stripTrailingZeros()).as(kanal + " " + von)
                        .isEqualTo(soll.menge() == null ? null : soll.menge().stripTrailingZeros());
                assertThat(daten.get(i).path("herkunft").path("mengeZustand").asText()).isEqualTo(soll.zustand());
                assertThat(texte(daten.get(i).path("herkunft").path("kennzeichen"))).isEqualTo(soll.kennzeichen());
                assertThat(daten.get(i).path("herkunft").path("erhalten").asInt()).as(kanal + " " + von)
                        .isEqualTo(sollZeitraum.erhalten());
                assertThat(daten.get(i).path("herkunft").path("erwartet").asInt()).as(kanal + " " + von)
                        .isEqualTo(sollZeitraum.erwartet());
                geprueft++;
            }
        }
        History p = frei(P, GROB_VON, GROB_BIS);
        for (int i = 0; i < p.data().size(); i++) {
            Instant von = p.data().get(i).time();
            VerbrauchRegeln.Werteteil soll = app.execute((java.sql.Connection con) -> {
                ViertelstundenTeile.Geladen g = ViertelstundenTeile.laden(con, KB, IDS.get(P), P, von,
                        von.plusSeconds(3600));
                return ViertelstundenTeile.werte(g.werteteile(), g.wertart(), g.kadenzS(), von, von.plusSeconds(3600));
            });
            JsonNode herkunft = JSON.valueToTree(p).path("data").get(i).path("herkunft");
            assertThat(herkunft.path("energieAusLeistung").path("wert").decimalValue())
                    .isEqualByComparingTo(soll.energie());
            assertThat(herkunft.path("mengeZustand").asText()).isEqualTo(soll.teil().ergebnis().zustand());
            assertThat(texte(herkunft.path("kennzeichen"))).isEqualTo(soll.teil().ergebnis().kennzeichen());
            geprueft++;
        }
        assertThat(geprueft).as("F8 mit zwanzig Stunden, H mit vier, P mit einer").isGreaterThan(20);
    }

    /** Im Viertelstunden-Raster bleibt der Kurvenwert die gespeicherte Menge je Viertelstunde. */
    @Test
    void imViertelstundenRasterBleibtDieGespeicherteMenge() {
        TenantContext.set(KB);
        History h = frei(F8, Instant.parse("2026-11-02T23:00:00Z"), Instant.parse("2026-11-03T23:00:00Z"));
        assertThat(h.meta().bucketSeconds()).isEqualTo(900);
        List<BigDecimal> gespeichert = root.queryForList("SELECT menge FROM messreihe_viertelstunde "
                + "WHERE entity_id = ? AND intervall_beginn BETWEEN '2026-11-02T23:00:00Z' "
                + "AND '2026-11-03T23:00:00Z' ORDER BY intervall_beginn", BigDecimal.class, IDS.get(F8));
        assertThat(h.data()).hasSameSizeAs(gespeichert);
        for (int i = 0; i < gespeichert.size(); i++) {
            assertThat(h.data().get(i).value() == null ? null : h.data().get(i).value().stripTrailingZeros())
                    .isEqualTo(gespeichert.get(i) == null ? null : gespeichert.get(i).stripTrailingZeros());
        }
    }

    // ======================================================== 2. Die Energie aus Leistung

    /**
     * 72 kW eine Stunde lang, Quellenbindung {@code integration}: je Viertelstunde 18,0 kWh, die
     * Stunde und der Tag 72,0 kWh — und NIE ohne das Kennzeichen „aus Leistung integriert". Der
     * Kurvenwert bleibt das Mittel (72,0 kW); die Energie steht nur in der Herkunft.
     */
    @Test
    void eineIntegrierteEnergieErscheintNurMitIhremKennzeichen() {
        TenantContext.set(KB);
        Instant neun = Instant.parse("2026-11-12T09:00:00Z");
        History fein = frei(P, neun.minusSeconds(3600), neun.plusSeconds(7200));
        History grob = frei(P, GROB_VON, GROB_BIS);
        History tag = frei(P, TAG_VON, TAG_BIS);

        JsonNode viertel = energie(fein, index(fein, neun));
        assertThat(viertel.path("wert").decimalValue()).isEqualByComparingTo("18.0");
        assertThat(viertel.path("kennzeichen").asText()).startsWith(INTEGRIERT);
        assertThat(fein.data().get(index(fein, neun)).value()).as("der Kurvenwert bleibt das Mittel")
                .isEqualByComparingTo("72.0");

        JsonNode stunde = energie(grob, index(grob, neun));
        assertThat(stunde.path("wert").decimalValue()).isEqualByComparingTo("72.0");
        assertThat(stunde.path("kennzeichen").asText()).startsWith(INTEGRIERT);

        JsonNode tagesenergie = energie(tag, index(tag, Instant.parse("2026-11-11T23:00:00Z")));
        assertThat(tagesenergie.path("wert").decimalValue()).isEqualByComparingTo("72.0");
        assertThat(tagesenergie.path("kennzeichen").asText()).startsWith(INTEGRIERT);

        for (History h : List.of(fein, grob, tag)) {
            for (JsonNode d : JSON.valueToTree(h).path("data")) {
                JsonNode e = d.path("herkunft").path("energieAusLeistung");
                if (!e.isMissingNode() && !e.isNull()) {
                    assertThat(e.path("kennzeichen").asText()).as("keine Energie ohne Kennzeichen")
                            .startsWith(INTEGRIERT);
                }
            }
        }
    }

    /** Der Leser hält die Prüfregel der Datenbank selbst: eine Energie ohne ihr Kennzeichen gibt es nicht. */
    @Test
    void eineEnergieOhneKennzeichenGibtEsNicht() {
        assertThatThrownBy(() -> new EnergieAusLeistung(new BigDecimal("18.0"), "gemessen"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EnergieAusLeistung(new BigDecimal("18.0"), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(EnergieAusLeistung.aus(new BigDecimal("18.0"),
                List.of("gemessene Zeit 7:30 min von 15:00 min"))).isNull();
        assertThat(EnergieAusLeistung.aus(null, List.of(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT))).isNull();
        assertThat(EnergieAusLeistung.aus(new BigDecimal("18.0"), List.of(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT)))
                .isEqualTo(new EnergieAusLeistung(new BigDecimal("18.0"), VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT));
    }

    /** Dieselbe Leistung OHNE Quellenbindung {@code integration}: keine Energie, auf keinem Weg. */
    @Test
    void ohneIntegrationGibtEsKeineEnergie() {
        TenantContext.set(KB);
        Instant neun = Instant.parse("2026-11-12T09:00:00Z");
        for (History h : List.of(frei(P0, neun.minusSeconds(3600), neun.plusSeconds(7200)),
                frei(P0, GROB_VON, GROB_BIS), frei(P0, TAG_VON, TAG_BIS))) {
            assertThat(h.data()).isNotEmpty();
            for (JsonNode d : JSON.valueToTree(h).path("data")) {
                assertThat(d.path("herkunft").path("energieAusLeistung").isMissingNode()).isTrue();
            }
        }
    }

    // ================================================================= 3. Der Überlauf

    /**
     * Innerhalb der Frist, am 08.04.2027: um 10:30 läuft der Zähler über (99 999 → 1). Der Bestand
     * schreibt dafür wie immer {@code counter_reset}, der Writer daneben {@code counter_overflow} —
     * der Verlauf zeigt EINE Marke „Zähler übergelaufen". Die echte Rücksetzung um 11:15 (ohne
     * Überlauf) bleibt „Zählerneustart", Zeichen für Zeichen wie vorher.
     */
    @Test
    void derUeberlaufErscheintAlsUeberlaufUndDieRuecksetzungNichtDoppelt() {
        TenantContext.set(KB);
        History h = frei(Z, Instant.parse("2027-04-08T10:00:00Z"), Instant.parse("2027-04-08T11:30:00Z"));
        assertThat(h.meta().quelle()).isEqualTo("roh");
        assertThat(h.markers()).extracting(Marker::time, Marker::kind, Marker::label, Marker::count)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(Instant.parse("2027-04-08T10:30:00Z"),
                                "counter_overflow", "Zähler übergelaufen", 1),
                        org.assertj.core.groups.Tuple.tuple(Instant.parse("2027-04-08T11:15:00Z"),
                                "counter_reset", "Zählerneustart", 1));
    }

    /**
     * Jenseits der Frist, am 14.11.2026: an derselben Messzeit stehen die Bestands-Rücksetzung, eine
     * Rücksetzung des Writers an der Reihe UND der Überlauf. Gezeigt wird nur der Überlauf.
     */
    @Test
    void derUeberlaufVerdraengtAuchDieRuecksetzungAnDerReihe() {
        TenantContext.set(KB);
        History h = frei(Z, Instant.parse("2026-11-14T00:00:00Z"), Instant.parse("2026-11-15T00:00:00Z"));
        assertThat(h.markers()).extracting(Marker::time, Marker::kind, Marker::label)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(
                        Instant.parse("2026-11-14T08:00:00Z"), "counter_overflow", "Zähler übergelaufen"));
    }

    // ============================================================= Zaun und Bestandsschutz

    /**
     * Der Mandantenzaun: ein fremder Kundenbereich bekommt 404 und keine Zeile — und sein Überlauf
     * an DERSELBEN Messzeit wie unsere echte Rücksetzung (11:15) verdrängt sie nicht.
     */
    @Test
    void derZaunStehtAuchVorDerVerdraengung() {
        TenantContext.set(FREMD);
        assertThatThrownBy(() -> frei(Z, Instant.parse("2027-04-08T10:00:00Z"),
                Instant.parse("2027-04-08T11:30:00Z")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        for (String tabelle : List.of("messreihe_viertelstunde", "messreihe_tag")) {
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).isZero();
        }
        assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis", Long.class))
                .as("nur der eigene Überlauf").isEqualTo(1L);

        TenantContext.set(KB);
        assertThat(frei(Z, Instant.parse("2027-04-08T11:00:00Z"), Instant.parse("2027-04-08T11:30:00Z"))
                .markers()).extracting(Marker::kind).containsExactly("counter_reset");
    }

    /**
     * Die Fläche, die heute schon richtig antwortet, bleibt ZEICHENGLEICH — gemessen mit dem
     * gemeinsamen Vergleich {@link Bestandsschutz#abweichungen}: innerhalb der Frist das volle JSON
     * und der Export je Weg, im Rückfall der Export und die Bestandsfelder des Viertelstunden-Rasters.
     */
    @Test
    void wasHeuteRichtigAntwortetBleibtZeichengleich() {
        TenantContext.set(KB);
        Map<String, String> nachher = flaeche();
        System.out.println("FLAECHE " + nachher);
        assertThat(Bestandsschutz.abweichungen(FLAECHE_VORHER, nachher)).isEmpty();
        assertThat(nachher.keySet()).containsExactlyInAnyOrderElementsOf(FLAECHE_VORHER.keySet());
    }

    /** Der Lesepfad schreibt nichts — jede Tabelle des Schemas ist nach allen Lesungen dieselbe. */
    @Test
    void derLesepfadSchreibtNichts() {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        TenantContext.set(KB);
        flaeche();
        frei(F8, TAG_VON, TAG_BIS);
        frei(H, GROB_VON, GROB_BIS);
        frei(P, TAG_VON, TAG_BIS);
        frei(Z, Instant.parse("2026-11-14T00:00:00Z"), Instant.parse("2026-11-15T00:00:00Z"));
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        Bestandsschutz.mutationsprobe(root, List.of(), "device_measurement_event",
                "UPDATE device_measurement_event SET details = '{\"probe\":1}'::jsonb");
    }

    // ================================================================= Hilfen

    private static Map<String, String> flaeche() {
        Map<String, String> aus = new LinkedHashMap<>();
        Instant von = Instant.parse("2027-04-09T00:00:00Z");
        Instant bis = Instant.parse("2027-04-09T06:00:00Z");
        for (String kanal : List.of(Z, P)) {
            String name = kanal.equals(Z) ? "Zähler" : "Leistung";
            for (String darstellung : List.of("decoded", "raw")) {
                History h = verlauf.history(IDS.get("BOX"), kanal, "free", von, bis, darstellung, null, null);
                aus.put(name + " roh 09.04. " + darstellung + " JSON", md5(json(h)));
                aus.put(name + " roh 09.04. " + darstellung + " CSV", md5(exportVorher(h)));
            }
        }
        History fein = frei(F8, Instant.parse("2026-11-02T23:00:00Z"), Instant.parse("2026-11-03T23:00:00Z"));
        aus.put("F8 Viertelstunden 03.11. CSV", md5(exportVorher(fein)));
        aus.put("F8 Viertelstunden 03.11. Bestandsfelder", md5(bestandsfelder(fein)));
        History leistung = frei(P, Instant.parse("2026-11-12T08:00:00Z"), Instant.parse("2026-11-12T11:00:00Z"));
        aus.put("Leistung Viertelstunden 12.11. CSV", md5(exportVorher(leistung)));
        aus.put("Leistung Viertelstunden 12.11. Bestandsfelder", md5(bestandsfelder(leistung)));
        History grob = frei(P, GROB_VON, GROB_BIS);
        aus.put("Leistung Stunden CSV", md5(exportVorher(grob)));
        return aus;
    }

    /**
     * Der Export von heute OHNE die neun Kopfzeilen von AP-12 IP-10 (DA4) — seine md5 ist die aus der Karte
     * {@link #FLAECHE_VORHER}, die AP-07 IP-14 vor diesem Paket aufgenommen hat: dieselben Spalten, dieselben Zeilen,
     * dieselben Kopfzeilen davor, Byte für Byte. Stehen die neun woanders, bricht schon der Vergleich selbst.
     */
    private static byte[] exportVorher(History h) {
        return ohneNeueKopfzeilen(verlauf.csv(h, erzeugung()));
    }

    /** Die Felder von VOR IP-14 (dieselbe Projektion wie {@code UemsLesepfadTest}). */
    private static byte[] bestandsfelder(History h) {
        StringBuilder s = new StringBuilder();
        for (Datum d : h.data()) {
            s.append(d.time()).append(',').append(d.value()).append(',').append(d.minimum()).append(',')
                    .append(d.maximum()).append(',').append(d.text()).append(',').append(d.sampleCount())
                    .append(',').append(d.gap()).append('\n');
        }
        for (Marker m : h.markers()) {
            s.append(m.time()).append(',').append(m.kind()).append(',').append(m.label()).append('\n');
        }
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static History frei(String kanal, Instant von, Instant bis) {
        return verlauf.history(IDS.get("BOX"), kanal, "free", von, bis, "decoded", null, null);
    }

    private static int index(History h, Instant zeit) {
        for (int i = 0; i < h.data().size(); i++) {
            if (h.data().get(i).time().equals(zeit)) {
                return i;
            }
        }
        throw new AssertionError("kein Wert um " + zeit + " in " + h.data().stream().map(Datum::time).toList());
    }

    private static JsonNode energie(History h, int i) {
        return JSON.valueToTree(h).path("data").get(i).path("herkunft").path("energieAusLeistung");
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    private static List<String> texte(String json) {
        try {
            return texte(JSON.readTree(json));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] json(History h) {
        try {
            return JSON.writeValueAsBytes(h);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Der md5 einer Antwort — mit durchnummerierten Kennungen statt der UUIDs, die jeder Testlauf neu
     * vergibt (Anlage, Komponente, Box). Die Struktur bleibt: dieselbe Kennung bekommt dieselbe Nummer.
     * Der heutige Laufzeitstand des Katalogs ({@code meta.catalogVersion}) wird durch den Stand ersetzt,
     * unter dem die Karte aufgenommen wurde — eine Hebung des Katalogs verschiebt so keinen Fingerabdruck.
     */
    private static String md5(byte[] bytes) {
        Matcher m = KENNUNG.matcher(new String(bytes, StandardCharsets.UTF_8)
                .replace(KATALOG.version(), LAUFZEITSTAND_DER_AUFNAHME));
        Map<String, String> nummern = new LinkedHashMap<>();
        StringBuilder s = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(s, nummern.computeIfAbsent(m.group(), k -> "kennung-" + nummern.size()));
        }
        m.appendTail(s);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5")
                    .digest(s.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ========================================================= Aufbau der Beispielwelt

    private static void stammdaten() {
        for (UUID t : new UUID[] {KB, FREMD}) {
            root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", t,
                    t.equals(KB) ? "Kunststoffwerk Ahrenberg GmbH" : "Kundenbereich B");
            IDS.put("U:" + t, uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                    + "VALUES (?, ?, 'Europe/Berlin') RETURNING id", t, "U " + t));
        }
        IDS.put("ST", uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id",
                KB, IDS.get("U:" + KB)));
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, IDS.get("AN2"), IDS.get("ST"));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        for (String kanal : List.of(F8, H, Z, P, P0, K)) {
            IDS.put(kanal, reihe(KB, IDS.get("AN2"), IDS.get("BOX"), kanal));
        }
        // MS-10-artig: Wirkenergie aus der Leistung — Herleitung `integration` (AP-04 Regel 7).
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, 'MS-0001', 'Energie aus Leistung', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') RETURNING id", KB);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(P));
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'gauge', 'integration', "
                + "'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', 'Probe', 'kunde')",
                KB, ms, IDS.get(P), geraet, P);

        // Die Reihe K wechselt ihre Kadenz in der Stunde 11:00–12:00 Ortszeit: 60 s bis 11:15, 30 s bis
        // 11:30, 120 s bis 13:00, danach — und damit „jetzt" — 300 s (Fassungen, AP-07 IP-10).
        UUID msK = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, 'MS-0002', 'Kadenz-Wechsel', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", KB);
        UUID geraetK = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(K));
        UUID bindungK = uuid("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', "
                + "'zaehlerstand', 'fuehrend', '2024-03-12T00:00:00Z', false, now(), 'sub', 'Probe', 'kunde') "
                + "RETURNING id", KB, msK, IDS.get(K), geraetK, K);
        String fassung = "INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, "
                + "gueltig_ab, gueltig_bis, rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, "
                + "'eintrag', ?::timestamptz, ?::timestamptz, false, 'sub', 'Probe', 'kunde')";
        root.update(fassung, KB, bindungK, 60, "2024-03-12T00:00:00Z", "2026-11-05T10:15:00Z");
        root.update(fassung, KB, bindungK, 30, "2026-11-05T10:15:00Z", "2026-11-05T10:30:00Z");
        root.update(fassung, KB, bindungK, 120, "2026-11-05T10:30:00Z", "2026-11-05T12:00:00Z");
        root.update(fassung.replace(", gueltig_bis", "").replace(", ?::timestamptz, false", ", false"),
                KB, bindungK, 300, "2026-11-05T12:00:00Z");

        IDS.put("AN-F", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'B-1') RETURNING id", FREMD));
        IDS.put("BOX-F", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-B', 'claimed') RETURNING id", FREMD, IDS.get("AN-F")));
        IDS.put("FREMD", reihe(FREMD, IDS.get("AN-F"), IDS.get("BOX-F"), Z));
    }

    private static UUID reihe(UUID tenant, UUID site, UUID box, String kanal) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                tenant, site, kanal, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, entity, kanal);
        return entity;
    }

    /** 10.11.2026, 09:00–12:00 Ortszeit, 1,6 kWh je Minute — ohne Werte von 10:06 bis 10:39. */
    private static List<Rohwert> stundeMitLuecke() {
        List<Rohwert> aus = new ArrayList<>();
        Instant beginn = Instant.parse("2026-11-10T08:00:00Z");
        for (int i = 0; i <= 180; i++) {
            Instant t = beginn.plusSeconds(60L * i);
            if (!t.isBefore(Instant.parse("2026-11-10T09:06:00Z")) && t.isBefore(Instant.parse("2026-11-10T09:40:00Z"))) {
                continue;
            }
            aus.add(new Rohwert(t, new BigDecimal("500000.0").add(new BigDecimal("1.6").multiply(BigDecimal.valueOf(i)))));
        }
        return aus;
    }

    /**
     * 05.11.2026 für die Reihe K: 11:00–11:14 Ortszeit jede Minute, 11:15–11:44 kein einziger Wert (zwei
     * Viertelstunden ohne Zeile), ab 11:46 alle zwei Minuten bis 12:08 — je Viertelstunde sieben Werte,
     * genau die Erwartung bei 120 s.
     */
    private static List<Rohwert> kadenzWechsel() {
        List<Rohwert> aus = new ArrayList<>();
        Instant beginn = Instant.parse("2026-11-05T10:00:00Z");
        for (int i = 0; i < 15; i++) {
            aus.add(new Rohwert(beginn.plusSeconds(60L * i), new BigDecimal("700000.0").add(BigDecimal.valueOf(i))));
        }
        for (int i = 46; i < 70; i += 2) {
            aus.add(new Rohwert(beginn.plusSeconds(60L * i), new BigDecimal("700000.0").add(BigDecimal.valueOf(i))));
        }
        return aus;
    }

    /** 72 kW je Minute ab {@code beginn}, {@code anzahl} Werte. */
    private static List<Rohwert> leistung(Instant beginn, int anzahl) {
        List<Rohwert> aus = new ArrayList<>();
        for (int i = 0; i < anzahl; i++) {
            aus.add(new Rohwert(beginn.plusSeconds(60L * i), new BigDecimal("72.0")));
        }
        return aus;
    }

    /** 08.04.2027 10:00–11:30: 99 970 … 99 999, um 10:30 übergelaufen auf 1, um 11:15 zurückgesetzt auf 0. */
    private static List<Rohwert> ueberlaufUndRuecksetzung() {
        List<Rohwert> aus = new ArrayList<>();
        Instant beginn = Instant.parse("2027-04-08T10:00:00Z");
        for (int i = 0; i <= 90; i++) {
            long stand = i < 30 ? 99_970 + i : i < 75 ? i - 29 : i - 75;
            aus.add(new Rohwert(beginn.plusSeconds(60L * i), BigDecimal.valueOf(stand)));
        }
        return aus;
    }

    /** 09.04.2027 00:00–06:00 — mit einer Rücksetzung um 03:00, OHNE Überlauf (die Bestandsfläche). */
    private static List<Rohwert> ruhigerZaehler() {
        List<Rohwert> aus = new ArrayList<>();
        Instant beginn = Instant.parse("2027-04-09T00:00:00Z");
        for (int i = 0; i <= 360; i++) {
            aus.add(new Rohwert(beginn.plusSeconds(60L * i), BigDecimal.valueOf(i < 180 ? 7000 + 2L * i : i - 180)));
        }
        return aus;
    }

    private static void zaehlerbrueche() {
        UUID box = IDS.get("BOX");
        // Innerhalb der Frist: Überlauf 10:30 (Bestand + Spiegel + Writer), Rücksetzung 11:15 (Bestand + Spiegel).
        bestand("2027-04-08T10:30:00Z", 99_999, 1);
        bestand("2027-04-08T11:15:00Z", 45, 0);
        bestand("2027-04-09T03:00:00Z", 7358, 0);
        ueberlauf(KB, IDS.get(Z), box, "2027-04-08T10:30:00Z", 99_999, 1);
        // Der fremde Kundenbereich meldet einen Überlauf an unserer Rücksetzungs-Messzeit — auf SEINER Reihe.
        ueberlauf(FREMD, IDS.get("FREMD"), IDS.get("BOX-F"), "2027-04-08T11:15:00Z", 99_999, 1);
        // Jenseits der Frist: Bestand + Rücksetzung des Writers an der Reihe + Überlauf, dieselbe Messzeit.
        bestand("2026-11-14T08:00:00Z", 99_990, 4);
        ereignis(KB, "counter_reset", "2026-11-14T08:00:00Z", "{\"komponente\":\"" + IDS.get(Z) + "\"}", Z,
                "{\"stand_alt\":99990,\"stand_neu\":4}", null, IDS.get(Z), false);
        ueberlauf(KB, IDS.get(Z), box, "2026-11-14T08:00:00Z", 99_990, 4);
    }

    /** Die Bestands-Rücksetzung in {@code device_measurement_event} und ihr Spiegel ({@code aus_bestand}). */
    private static void bestand(String zeit, long alt, long neu) {
        Timestamp t = Timestamp.from(Instant.parse(zeit));
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, point_key, "
                + "event_kind, previous_numeric, value_numeric, catalog_version, edge_sequence) "
                + "VALUES (?, ?, ?, ?, ?, 'counter_reset', ?, ?, '2026.09.11.1', ?)",
                t, KB, IDS.get("AN2"), IDS.get("BOX"), Z, alt, neu, t.getTime() / 1000);
        ereignis(KB, "counter_reset", zeit, "{\"box\":\"" + IDS.get("BOX") + "\"}", Z,
                "{\"stand_alt\":" + alt + ",\"stand_neu\":" + neu + "}", IDS.get("BOX"), null, true);
    }

    private static void ueberlauf(UUID tenant, UUID entity, UUID box, String zeit, long alt, long neu) {
        ereignis(tenant, "counter_overflow", zeit, "{\"box\":\"" + box + "\",\"komponente\":\"" + entity + "\"}", Z,
                "{\"stand_alt\":" + alt + ",\"stand_neu\":" + neu + ",\"messzeit_alt\":\""
                        + Instant.parse(zeit).minusSeconds(60) + "\",\"wertebereich_modul\":100000,"
                        + "\"hoechstzuwachs_je_kadenz\":50,\"kadenz_s\":60}",
                box, entity, false);
    }

    private static void ereignis(UUID tenant, String art, String zeit, String kennungen, String messkanal,
            String nutzlast, UUID box, UUID entity, boolean ausBestand) {
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, site_id, kennungen, "
                        + "device_id, entity_id, messkanal, nutzlast, aus_bestand) "
                        + "VALUES (?, ?, ?, ?, 'writer', ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?)",
                Timestamp.from(Instant.parse(zeit)), tenant, UUID.randomUUID(), art,
                tenant.equals(KB) ? IDS.get("AN2") : IDS.get("AN-F"), kennungen, box, entity, messkanal,
                nutzlast, ausBestand);
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                    + "entity_id, applied_revision, value_kind, role, delivery, delay_s) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.11.1', ?, ?, ?, 3, ?, 'fuehrend', 'direkt', 2)";

    private static void saeen(String kanal, String wertart, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), KB,
                    IDS.get("AN2"), IDS.get("BOX"), kanal, r.wert(), r.wert(), r.zeit().getEpochSecond(),
                    wertart, IDS.get(kanal), wertart});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
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
