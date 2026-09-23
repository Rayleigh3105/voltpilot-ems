package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Nachtrag der Tagesmenge (Captain 15.09.2026, Empfehlung B): Tage, die vor AP-08 IP-5 schon endgültig waren,
 * tragen keine Menge — der Nachtrag läuft über den regulären Korrekturweg. Eine Reihe mit zwei solchen Tagen und einem
 * dritten mit Menge, dazu eine Reihe mit einem Tag ohne bildbare Menge.
 *
 * <p>„Vor IP-5“ wird hergestellt, wie es in Produktion steht: die Zeile ist mit der Regel von heute gebildet und
 * endgültig, danach werden die vier Spalten von V20260912205000 geleert (menge, menge_zustand, kennzeichen, kadenz_s)
 * — so sah jede Zeile aus, die vor dieser Migration endgültig war.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsTagesmengeNachtragTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";
    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000031");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static final LocalDate D1 = LocalDate.of(2026, 10, 5);
    private static final LocalDate D2 = LocalDate.of(2026, 10, 6);
    private static final LocalDate D3 = LocalDate.of(2026, 10, 7);
    private static final Instant T_V1 = Instant.parse("2026-10-08T00:30:00Z");
    private static final Instant T_V1_TAKT = Instant.parse("2026-10-08T01:00:00Z");
    private static final Instant T_ENDGUELTIG = Instant.parse("2026-10-16T01:00:00Z");
    private static final Instant T_NACHTRAG = Instant.parse("2026-10-20T08:00:00Z");
    private static final Instant T_KASKADE = Instant.parse("2026-10-20T09:00:00Z");
    private static final Instant T_RUECKNAHME = Instant.parse("2026-10-21T09:00:00Z");

    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final ProtokollAkteur JONAS = new ProtokollAkteur("kc-jonas-wendlinger", "Jonas Wendlinger",
            "kundenadministrator", "kunde");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate admin;
    private static JdbcTemplate app;
    private static MessreiheKorrekturRepository korrekturen;

    private static TagesmengeNachtragLaeufer.Lauf erster;
    private static TagesmengeNachtragLaeufer.Lauf zweiter;
    private static TagesmengeNachtragLaeufer.Lauf nachDerFreigabe;
    private static List<Korrektur> vorschlaege;
    private static String zahlenVorher;
    private static String zahlenNachZweiLaeufen;
    private static String d3Vorher;
    private static String d3Nachher;
    private static String tageV1Vorher;
    private static String tageV1Nachher;
    private static Throwable systemFreigabe;
    private static KorrekturKaskade.Lauf kaskade;
    private static List<Map<String, Object>> versionen;
    private static List<Map<String, Object>> versionenNachRuecknahme;

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        stammdaten();
        MeasurementCatalog katalog = new MeasurementCatalog(JSON);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        TagVerdichter tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        BerechnetePeriodenLauf berechnete = berechnete(katalog);
        EndgueltigkeitLaeufer laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        korrekturen = new MessreiheKorrekturRepository(app);
        ErsatzwertLauf ersatzwerte = new ErsatzwertLauf(admin, katalog, verdichter, 200);
        KorrekturKaskade kette = new KorrekturKaskade(admin, katalog, verdichter, ersatzwerte, berechnete,
                new KennzahlenNaht.Keine(), new BerichteNaht.Keine(), 50);
        TagesmengeNachtragLaeufer nachtrag = new TagesmengeNachtragLaeufer(admin, katalog, ersatzwerte, false);

        // ---- Drei Tage N (0,5 kWh je Minute = 720 kWh je Tag) und ein Tag L, gebildet und endgültig ---------------
        saeen("N", TagRegeln.beginn(D1, BERLIN), TagRegeln.ende(D3, BERLIN));
        saeen("L", TagRegeln.beginn(D1, BERLIN), TagRegeln.ende(D1, BERLIN));
        for (int i = 0; i < 200; i++) {
            if (verdichter.lauf(T_V1).rueckrechnungFertig()
                    && zahl("SELECT count(*) FROM messreihe_viertelstunde_arbeit") == 0) {
                break;
            }
        }
        tage.rueckrechnenGanz(T_V1_TAKT, 200);
        laeufer.takt(T_V1_TAKT);
        laeufer.takt(T_ENDGUELTIG);
        assertThat(zahl("SELECT count(*) FROM messreihe_tag WHERE zustand = 'endgueltig' AND menge IS NOT NULL"))
                .as("drei Tage N und ein Tag L, gebildet und endgültig").isEqualTo(4);

        // ---- So stand ein Tag da, der vor V20260912205000 endgültig war ------------------------------------------
        root.update("UPDATE messreihe_tag SET menge = NULL, menge_zustand = NULL, kennzeichen = '[]'::jsonb, "
                + "kadenz_s = NULL WHERE (entity_id = ? AND tag IN (?, ?)) OR (entity_id = ? AND tag = ?)", IDS.get("N"),
                D1, D2, IDS.get("L"), D1);
        // L: die Viertelstunden gibt es nicht mehr — keine Menge bildbar.
        root.update("DELETE FROM messreihe_viertelstunde WHERE entity_id = ?", IDS.get("L"));

        zahlenVorher = zahlen();
        d3Vorher = Bestandsschutz.inhalt(root, "messreihe_tag", "t.entity_id = ? AND t.tag = ?", IDS.get("N"), D3);
        tageV1Vorher = Bestandsschutz.inhalt(root, "messreihe_tag", "t.entity_id = ?", IDS.get("N"));

        erster = nachtrag.lauf(T_NACHTRAG);
        zweiter = nachtrag.lauf(T_NACHTRAG.plusSeconds(3600));
        zahlenNachZweiLaeufen = zahlen();
        vorschlaege = als(() -> korrekturen.fuerReihe(KB, IDS.get("N"), KANAL));

        // ---- Die Freigabe: Vier Augen AN; der System-Weg kann nicht selbst freigeben -------------------------------
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", KB);
        String k1 = kennung(D1);
        String k2 = kennung(D2);
        try {
            admin.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, actor_name, actor_art) "
                    + "VALUES (?, ?, 2, 'freigegeben', 'VoltPilot', 'voltpilot')", KB, k1);
        } catch (RuntimeException e) {
            systemFreigabe = e;
        }
        als(() -> korrekturen.freigeben(KB, k1, "Tagesmenge vom Zähler geprüft, passt zur Rechnung.", INES, true));
        als(() -> korrekturen.freigeben(KB, k2, "Tagesmenge vom Zähler geprüft, passt zur Rechnung.", JONAS, true));

        kaskade = kette.lauf(T_KASKADE);
        versionen = root.queryForList("SELECT ebene, tag, version, menge, menge_zustand, kennzeichen::text AS kennzeichen, "
                + "anlass_kennung, korrekturen::text AS korrekturen FROM messreihe_periode_version WHERE entity_id = ? "
                + "ORDER BY ebene, tag, version", IDS.get("N"));
        d3Nachher = Bestandsschutz.inhalt(root, "messreihe_tag", "t.entity_id = ? AND t.tag = ?", IDS.get("N"), D3);
        tageV1Nachher = Bestandsschutz.inhalt(root, "messreihe_tag", "t.entity_id = ?", IDS.get("N"));
        nachDerFreigabe = nachtrag.lauf(T_KASKADE.plusSeconds(600));

        // ---- Rücknahme: der Stand VOR der Korrektur (§4.6) — keine Menge, wie Version 1 ---------------------------
        als(() -> korrekturen.zuruecknehmen(KB, k2, "Nachtrag des 06.10. zurückgenommen, Zähler wird geprüft.",
                JONAS));
        kette.lauf(T_RUECKNAHME);
        versionenNachRuecknahme = root.queryForList("SELECT tag, version, menge, menge_zustand, anlass_kennung, "
                + "korrekturen::text AS korrekturen FROM messreihe_periode_version WHERE entity_id = ? AND ebene = 'tag' "
                + "AND tag = ? ORDER BY version", IDS.get("N"), D2);
    }

    // =========================================================================== Die Vorschläge

    @Test
    void genauZweiVorschlaegeFuerDieZweiTageVorIp5UndDerTagOhneMengeIstGezaehltUndBenannt() {
        assertThat(erster.vorschlaege()).isEqualTo(2);
        assertThat(erster.fehler()).isZero();
        assertThat(erster.kundenbereiche()).isEqualTo(1);
        assertThat(erster.ohneMenge()).containsExactly(IDS.get("L") + "/" + KANAL + " " + D1);
        assertThat(vorschlaege).hasSize(2);
        assertThat(vorschlaege).allSatisfy(k -> {
            assertThat(k.anlage().art()).isEqualTo(KorrekturVorschlagRegeln.MENGE_NACHGETRAGEN);
            assertThat(k.ersteller().sub()).as("ein Vorschlag des Systems").isNull();
        });
        assertThat(zahl("SELECT count(*) FROM messreihe_korrektur WHERE reihen @> ?::jsonb",
                "[{\"entity_id\":\"" + IDS.get("L") + "\"}]")).as("kein Vorschlag für L").isZero();
    }

    @Test
    void derVorschlagZeigtDenTagAltOhneMengeNeuAusDenViertelstunden() throws Exception {
        Korrektur k = vorschlaege.stream().filter(x -> x.anlage().von().equals(TagRegeln.beginn(D1, BERLIN)))
                .findFirst().orElseThrow();
        assertThat(k.anlage().bis()).isEqualTo(TagRegeln.ende(D1, BERLIN));
        assertThat(k.anlage().begruendung()).isEqualTo(KorrekturVorschlagRegeln.mengeNachgetragen(D1,
                TagRegeln.endgueltigAb(TagRegeln.ende(D1, BERLIN)), BERLIN));
        JsonNode v = JSON.readTree(String.valueOf(k.anlage().vorschau()));
        assertThat(v).hasSize(1);
        assertThat(v.get(0).path("periode").asText()).isEqualTo("tag");
        assertThat(v.get(0).path("aendert").asBoolean()).isTrue();
        assertThat(v.get(0).path("alt").path("version").asInt()).isEqualTo(1);
        assertThat(v.get(0).path("alt").path("menge").isNull()).isTrue();
        assertThat(new BigDecimal(v.get(0).path("neu").path("menge").asText())).isEqualByComparingTo("720");
        assertThat(v.get(0).path("neu").path("menge_zustand").asText()).isEqualTo("vollständig");
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'correction' AND urheber = 'cloud' "
                + "AND nutzlast ->> 'korrektur_art' = 'menge_nachgetragen'")).as("Marker je Vorschlag").isEqualTo(2);
    }

    @Test
    void derZweiteLaufErzeugtNichtsUndBisZurFreigabeAendertSichKeineZahl() {
        assertThat(zweiter.vorschlaege()).isZero();
        assertThat(zweiter.gesperrt()).isEqualTo(2);
        assertThat(zweiter.ohneMenge()).hasSize(1);
        assertThat(zahlenNachZweiLaeufen).isEqualTo(zahlenVorher);
        assertThat(nachDerFreigabe.vorschlaege()).as("nach der Freigabe trägt der Tag eine Version").isZero();
        assertThat(nachDerFreigabe.gesperrt()).isZero();
    }

    // =========================================================================== Freigabe und Kaskade

    @Test
    void derSystemWegKannDenNachtragNichtSelbstFreigeben() {
        assertThat(systemFreigabe).as("die BYPASSRLS-Rolle darf nur Fassung 1 anlegen").isNotNull();
    }

    @Test
    void nachDerFreigabeTraegtDerTagVersionZweiMitMengeUndProtokoll() {
        assertThat(kaskade.abgelehnt()).isEmpty();
        assertThat(kaskade.anlaesse()).isEqualTo(2);
        List<Map<String, Object>> tage = versionen.stream().filter(v -> "tag".equals(v.get("ebene"))).toList();
        assertThat(tage).hasSize(2);
        for (Map<String, Object> v : tage) {
            assertThat(v.get("version")).isEqualTo(2);
            assertThat((BigDecimal) v.get("menge")).isEqualByComparingTo("720");
            assertThat(v.get("menge_zustand")).isEqualTo("vollständig");
            assertThat((String) v.get("anlass_kennung")).startsWith("K-");
            assertThat((String) v.get("korrekturen")).contains((String) v.get("anlass_kennung"));
            assertThat((String) v.get("kennzeichen")).contains("korrigiert (Version 2)");
        }
        assertThat(versionen).as("Monate und Jahre lesen die Viertelstunden — keine Version")
                .allSatisfy(v -> assertThat(v.get("ebene")).isEqualTo("tag"));
        List<Map<String, Object>> freigaben = root.queryForList("SELECT kennung, freigabe_vieraugen, grund, actor_sub "
                + "FROM messreihe_korrektur WHERE fassung = 2 AND status = 'freigegeben' ORDER BY kennung");
        assertThat(freigaben).hasSize(2).allSatisfy(f -> assertThat(f.get("freigabe_vieraugen")).isEqualTo(true));
        assertThat(zahl("SELECT count(*) FROM messreihe_ereignis WHERE art = 'correction' AND urheber = 'kunde' "
                + "AND nutzlast ->> 'status' = 'freigegeben'")).isEqualTo(2);
    }

    @Test
    void versionEinsBleibtLesbarUndDerDritteTagUnberuehrt() {
        assertThat(tageV1Nachher).as("Version 1 aller drei Tage Zeichen für Zeichen").isEqualTo(tageV1Vorher);
        assertThat(d3Nachher).isEqualTo(d3Vorher);
        assertThat(versionen).noneMatch(v -> D3.equals(((java.sql.Date) v.get("tag")).toLocalDate()));
        assertThat(root.queryForObject("SELECT menge FROM messreihe_tag WHERE entity_id = ? AND tag = ?",
                BigDecimal.class, IDS.get("N"), D1)).as("Version 1 bleibt ohne Menge").isNull();
    }

    @Test
    void dieRuecknahmeSchreibtDenStandVorDerKorrektur() {
        assertThat(versionenNachRuecknahme).hasSize(2);
        Map<String, Object> drei = versionenNachRuecknahme.get(1);
        assertThat(drei.get("version")).isEqualTo(3);
        assertThat(drei.get("menge")).as("wie Version 1: keine Menge").isNull();
        assertThat((String) drei.get("korrekturen")).isEqualTo("{}");
    }

    // =========================================================================== Aufbau

    private static String kennung(LocalDate tag) {
        return vorschlaege.stream().filter(x -> x.anlage().von().equals(TagRegeln.beginn(tag, BERLIN))).findFirst()
                .orElseThrow().kennung();
    }

    /** Was bis zur Freigabe unverändert bleiben muss: Tage, Versionen, Monate. */
    private static String zahlen() {
        return Bestandsschutz.inhalt(root, "messreihe_tag", "true") + Bestandsschutz.inhalt(root,
                "messreihe_periode_version", "true") + Bestandsschutz.inhalt(root, "messreihe_periode", "true")
                + Bestandsschutz.inhalt(root, "messreihe_viertelstunde_version", "true");
    }

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Ahrenberg', 'Europe/Berlin') "
                + "RETURNING id", KB);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, u);
        UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, an, st);
        IDS.put("AN", an);
        for (String name : List.of("N", "L")) {
            UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                    + "RETURNING id", KB, an, "VP-BOX-TN-" + name);
            UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                    + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, "
                    + "'grid-meter', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                    + "'2024-03-12T00:00:00Z') RETURNING id", KB, an, name, box);
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                    + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                    KB, an, box, entity, KANAL);
            IDS.put(name, entity);
            IDS.put("BOX:" + name, box);
        }
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING";

    /** Ein Stand je Minute in [von, bis], 0,5 kWh Zuwachs je Minute, pünktlich eingegangen. */
    private static void saeen(String reihe, Instant von, Instant bis) {
        List<Object[]> stapel = new ArrayList<>();
        BigDecimal wert = new BigDecimal("1000.0");
        for (Instant t = von; !t.isAfter(bis); t = t.plusSeconds(60)) {
            stapel.add(new Object[] {Timestamp.from(t), Timestamp.from(t.plusSeconds(2)), KB, IDS.get("AN"),
                    IDS.get("BOX:" + reihe), KANAL, wert, t.getEpochSecond(), IDS.get(reihe)});
            wert = wert.add(new BigDecimal("0.5"));
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static BerechnetePeriodenLauf berechnete(MeasurementCatalog katalog) {
        MessstelleRepository ms = new MessstelleRepository(app);
        MessstelleQuelleRepository quellen = new MessstelleQuelleRepository(app);
        SpeicherklasseHistorie historie = new SpeicherklasseHistorie(app, katalog);
        BerechnetePeriodenRepository speicher = new BerechnetePeriodenRepository(app);
        MessstelleWerteService werte = new MessstelleWerteService(app, ms, quellen, new QuelleKadenzRepository(app),
                new MesskanalService(app, new com.voltpilot.api.zugriff.Geltungsbereich(app), katalog, JSON,
                        new GeraetRepository(app), quellen),
                historie, speicher);
        return new BerechnetePeriodenLauf(admin, app, ms, new BilanzRestRepository(app),
                new MessstelleFormelTermRepository(app), new BilanzStellungen(ms, new MessstelleZuordnungRepository(app)),
                werte, historie, speicher);
    }

    private static int zahl(String sql, Object... args) {
        return root.queryForObject(sql, Integer.class, args);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static <T> T als(Supplier<T> arbeit) {
        TenantContext.set(KB);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
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
