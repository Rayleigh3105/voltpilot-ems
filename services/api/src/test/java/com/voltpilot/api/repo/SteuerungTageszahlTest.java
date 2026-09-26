package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.optimizer.OptimizerProperties;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.assertj.core.data.Offset;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * DIE EINE TAGESZAHL der Steuerung (Definition A, Captain 24.09.2026 -
 * Diagnose vp-erloes-zahlen-widerspruch-z1 §5): der Speicher-Anteil eines
 * Zeitraums ist die Summe der Tageszuwächse EINES durchlaufenden sturen
 * Vergleichsspeichers, verankert am gemessenen Ladestand zum Monatsbeginn und
 * an jeder Berliner Monatsgrenze neu. Geprüft an der Rechenstelle selbst
 * ({@link EarningsRepository}), mit festen Tagen statt der Uhr:
 *
 * <ul>
 *   <li><b>Tagesfenster = Reihe:</b> {@code savedSpeicherForSite} und die
 *       Einordnung des Tages (der Weg beider Controller auf {@code range=day})
 *       liefern je Tag denselben Speicher-Anteil wie {@code dailySavedPerSite}
 *       - bitgleich, auch am Reihenanfang und über die Monatsgrenze.</li>
 *   <li><b>Σ Tage = Monat, Σ Monate = Jahr</b>, und die Neuverankerung am 1.
 *       (handgerechnet, Anlage „Monatsgrenze“).</li>
 *   <li><b>„Speicher abends geleert“</b>: die Live-Werte der Referenzanlage
 *       vom 23./24.09.2026 aus {@code docs/contracts/steuerung-tag-vectors.json}
 *       - der Vergleichsspeicher geht mit 38,6 kWh in den 24.09., der echte mit
 *       3,25 kWh; der Nachtbezug steht am 24.09. (−9,78 €), der Verkauf am
 *       23.09. (+12,78 €). Das alte Tagesfenster zeigte −3,76 €.</li>
 * </ul>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class SteuerungTageszahlTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "steuerung-tag-vectors.json");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID TENANT = UUID.fromString("5e000000-0000-0000-0000-000000000001");
    /** Die Referenzanlage des Vektors {@code abends_geleert}. */
    private static final UUID ABENDS = UUID.fromString("5e000000-0000-0000-0000-0000000000a1");
    /** Handgerechnet über die Monatsgrenze April/Mai 2026. */
    private static final UUID GRENZE = UUID.fromString("5e000000-0000-0000-0000-0000000000b1");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode vektor;
    private static EarningsRepository earnings;
    private static HistoryRepository history;

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();
        vektor = MAPPER.readTree(Files.readString(VECTORS)).path("abends_geleert");

        DriverManagerDataSource superuser = new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        try (Connection c = superuser.getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Tageszahl')");
            seedAbendsGeleert(c);
            seedMonatsgrenze(c);
        }

        SingleConnectionDataSource app = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = app.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, TENANT.toString());
            ps.execute();
        }
        OptimizerProperties props = new OptimizerProperties(4.0, 0.3, null, null, false);
        earnings = new EarningsRepository(new JdbcTemplate(app), props);
        history = new HistoryRepository(new JdbcTemplate(app), props);
    }

    // ---------------------------------------------------------------- abends geleert

    @Test
    void abendsGeleertDerNachtbezugStehtAmFolgetag() {
        JsonNode tage = vektor.path("erwartet").path("tage");
        Offset<Double> eur = Offset.offset(vektor.path("erwartet").path("$toleranz_eur").asDouble());
        for (String d : List.of("2026-09-23", "2026-09-24")) {
            LocalDate day = LocalDate.parse(d);
            JsonNode e = tage.path(d);
            BigDecimal saved = saved(ABENDS, day);
            BigDecimal speicher = earnings.savedSpeicherForSite(ABENDS, from(day), to(day));
            assertThat(saved.doubleValue()).as("saved %s", d)
                    .isCloseTo(e.path("saved_eur").asDouble(), eur);
            assertThat(speicher.doubleValue()).as("speicher %s", d)
                    .isCloseTo(e.path("speicher_eur").asDouble(), eur);
            assertThat(saved.subtract(speicher).doubleValue()).as("steuerung %s", d)
                    .isCloseTo(e.path("steuerung_eur").asDouble(), eur);
        }
        // Die Tageszahl des 24.09. auf den Cent: −9,78 € (das alte Tagesfenster
        // zeigte −3,76 €), der Vortag +12,78 €.
        assertThat(steuerung(ABENDS, LocalDate.parse("2026-09-24")).doubleValue())
                .isCloseTo(-9.78, Offset.offset(0.005));
        assertThat(steuerung(ABENDS, LocalDate.parse("2026-09-23")).doubleValue())
                .isCloseTo(12.78, Offset.offset(0.005));
    }

    @Test
    void abendsGeleertDieEinordnungDes24() {
        JsonNode e = vektor.path("erwartet").path("tage").path("2026-09-24");
        Offset<Double> eur = Offset.offset(vektor.path("erwartet").path("$toleranz_eur").asDouble());
        Offset<Double> kwh = Offset.offset(0.0005);
        LocalDate day = LocalDate.parse("2026-09-24");
        EarningsRepository.Tageseinordnung t =
                earnings.tageseinordnungForSite(ABENDS, from(day), to(day));

        // Der Vergleichsspeicher trägt seine EIGENE Ladung über Mitternacht:
        // 38,6 kWh gegen 3,25 kWh im echten Speicher.
        assertThat(t.vergleichSocStartKwh().doubleValue())
                .isCloseTo(e.path("vergleich_soc_start_kwh").asDouble(), kwh);
        assertThat(t.echtSocStartKwh().doubleValue())
                .isCloseTo(e.path("echt_soc_start_kwh").asDouble(), kwh);
        assertThat(t.vergleichSocEndKwh().doubleValue())
                .isCloseTo(e.path("vergleich_soc_ende_kwh").asDouble(), kwh);
        assertThat(t.echtSocEndKwh().doubleValue())
                .isCloseTo(e.path("echt_soc_ende_kwh").asDouble(), kwh);
        assertThat(t.speicherVorsprungKwh().doubleValue())
                .isCloseTo(e.path("speicher_vorsprung_kwh").asDouble(), kwh);
        assertThat(t.pvKwh().doubleValue()).isCloseTo(e.path("pv_kwh").asDouble(), kwh);
        assertThat(t.loadKwh().doubleValue()).isCloseTo(e.path("load_kwh").asDouble(), kwh);
        assertThat(t.steuerungEur().doubleValue())
                .isCloseTo(e.path("steuerung_eur").asDouble(), eur);
        assertThat(t.steuerungVortagEur().doubleValue())
                .isCloseTo(e.path("steuerung_vortag_eur").asDouble(), eur);
        assertThat(t.steuerungMonatBisherEur().doubleValue())
                .isCloseTo(e.path("steuerung_monat_bisher_eur").asDouble(), eur);

        // Der Fahrplan-Planwert kommt aus derselben Slot-Menge wie
        // history.totals.steuerungPlannedEur - einzeln und flottenweit.
        BigDecimal plan = history.plannedSavings(ABENDS, from(day), to(day)).steuerungEur();
        assertThat(plan).isEqualByComparingTo(
                vektor.path("plan_steuerung_eur").path("2026-09-24").decimalValue());
        assertThat(history.plannedSteuerungPerSite(from(day), to(day)).get(ABENDS))
                .isEqualByComparingTo(plan);

        List<String> erwartet = new ArrayList<>();
        e.path("gruende").forEach(n -> erwartet.add(n.asText()));
        assertThat(SteuerungGrund.fuer(t.steuerungEur(), t, plan))
                .containsExactlyElementsOf(erwartet);
        // Der Verkaufstag selbst ist im Plus - kein Grund, aber eine Liste.
        LocalDate vortag = LocalDate.parse("2026-09-23");
        EarningsRepository.Tageseinordnung v =
                earnings.tageseinordnungForSite(ABENDS, from(vortag), to(vortag));
        assertThat(SteuerungGrund.fuer(v.steuerungEur(), v, null)).isEmpty();
    }

    @Test
    void abendsGeleertTagesfensterReiheUndMonatSagenDasselbe() {
        assertEinWalk(ABENDS, LocalDate.parse("2026-09-11"), LocalDate.parse("2026-09-24"));
        // Nur zwei covered Tage im September: Monat = Summe der beiden Tage.
        BigDecimal monat = steuerungMonth(ABENDS, 2026, 9);
        BigDecimal tage = steuerung(ABENDS, LocalDate.parse("2026-09-23"))
                .add(steuerung(ABENDS, LocalDate.parse("2026-09-24")));
        assertThat(monat.doubleValue()).isCloseTo(tage.doubleValue(), Offset.offset(1e-9));
    }

    // ---------------------------------------------------------------- Monatsgrenze

    /**
     * Die Anlage „Monatsgrenze“ (Zone CH, fest 30 ct, Spot 100 EUR/MWh, kein
     * PV-Asset → Einspeisung = Spot): 10 kWh, 5/5 kW (1,25 kWh je Slot), η = 1,
     * Band 5-95 % (Boden 0,5 / Decke 9,5). Gemessen fährt sie ohne Speicher
     * (Netz = Baseline), also saved = 0 und steuerung = −speicher. Je Tag EIN
     * Slot um 12:00 UTC:
     * <pre>
     *   Tag    pv  load  Vergleichsspeicher                  speicher
     *   29.04. 4   0     Boden 0,50 → lädt 1,25 → 1,75       −1,25 × 0,10 = −0,125
     *   30.04. 0   1     entlädt 1,00 → 0,75                 +1,00 × 0,30 = +0,300
     *   ---- 01.05. 00:00: NEU verankert am gemessenen Stand 80 % = 8,00 kWh
     *        (nicht die 0,75 des Aprillaufs)
     *   01.05. 0   2     entlädt 1,25 → 6,75                 +1,25 × 0,30 = +0,375
     *        gemessen am Ende des 01.05.: 6 % = 0,60 kWh
     *   02.05. 0   3     entlädt 1,25 → 5,50 (trägt 6,75,    +1,25 × 0,30 = +0,375
     *                    nicht die gemessenen 0,60)
     *   April 0,175 · Mai 0,750 · Jahr 0,925 = April + Mai
     * </pre>
     * Ein am echten Stand neu gestartetes Tagesfenster hätte am 02.05. bei
     * 0,60 kWh begonnen und nur 0,10 kWh entladen (0,03 €).
     */
    @Test
    void monatsgrenzeNeuverankerungUndDieSummen() {
        Offset<Double> exakt = Offset.offset(1e-9);
        Map<String, Double> speicher = Map.of(
                "2026-04-29", -0.125, "2026-04-30", 0.300,
                "2026-05-01", 0.375, "2026-05-02", 0.375);
        speicher.forEach((d, wert) -> {
            LocalDate day = LocalDate.parse(d);
            assertThat(earnings.savedSpeicherForSite(GRENZE, from(day), to(day)).doubleValue())
                    .as("speicher %s", d).isCloseTo(wert, exakt);
            assertThat(steuerung(GRENZE, day).doubleValue())
                    .as("steuerung %s", d).isCloseTo(-wert, exakt);
        });

        // Neuverankerung am 1., Durchlauf am 2.
        EarningsRepository.Tageseinordnung erster = einordnung(GRENZE, "2026-05-01");
        assertThat(erster.vergleichSocStartKwh()).isEqualByComparingTo("8.000");
        assertThat(erster.echtSocStartKwh()).isEqualByComparingTo("8.000");
        EarningsRepository.Tageseinordnung zweiter = einordnung(GRENZE, "2026-05-02");
        assertThat(zweiter.vergleichSocStartKwh()).isEqualByComparingTo("6.750");
        assertThat(zweiter.echtSocStartKwh()).isEqualByComparingTo("0.600");
        assertThat(zweiter.vergleichSocEndKwh()).isEqualByComparingTo("5.500");

        // Vortag über die Monatsgrenze, Monat bisher nur im eigenen Monat.
        assertThat(erster.steuerungVortagEur().doubleValue()).isCloseTo(-0.300, exakt);
        assertThat(erster.steuerungMonatBisherEur().doubleValue()).isCloseTo(-0.375, exakt);
        assertThat(zweiter.steuerungVortagEur().doubleValue()).isCloseTo(-0.375, exakt);
        assertThat(zweiter.steuerungMonatBisherEur().doubleValue()).isCloseTo(-0.750, exakt);

        // Σ Tage = Monat, Σ Monate = Jahr - für den Speicher- UND den Steuerungs-Anteil.
        assertThat(speicherMonth(GRENZE, 2026, 4).doubleValue()).isCloseTo(0.175, exakt);
        assertThat(speicherMonth(GRENZE, 2026, 5).doubleValue()).isCloseTo(0.750, exakt);
        BigDecimal jahr = earnings.savedSpeicherForSite(GRENZE,
                LocalDate.of(2026, 1, 1).atStartOfDay(BERLIN).toInstant(),
                LocalDate.of(2027, 1, 1).atStartOfDay(BERLIN).toInstant());
        assertThat(jahr.doubleValue()).isCloseTo(
                speicherMonth(GRENZE, 2026, 4).add(speicherMonth(GRENZE, 2026, 5)).doubleValue(),
                exakt).isCloseTo(0.925, exakt);
        assertThat(steuerungMonth(GRENZE, 2026, 5).doubleValue()).isCloseTo(
                steuerung(GRENZE, LocalDate.parse("2026-05-01"))
                        .add(steuerung(GRENZE, LocalDate.parse("2026-05-02"))).doubleValue(),
                exakt);

        // Jedes Fenster, das die Grenze enthält, sagt je Tag dasselbe.
        assertEinWalk(GRENZE, LocalDate.parse("2026-04-20"), LocalDate.parse("2026-05-02"));
        assertEinWalk(GRENZE, LocalDate.parse("2026-04-30"), LocalDate.parse("2026-05-02"));
    }

    @Test
    void nurWasBelegbarIstWirdGrundNieGeraten() {
        EarningsRepository.Tageseinordnung zweiter = einordnung(GRENZE, "2026-05-02");
        // −0,375 € ohne Planwert, 6,75 − 0,60 < 10 kWh und am Ende kein
        // gemessener Ladestand (also KEIN Vorsprung, keine erfundene 0): es
        // bleibt allein „wenig Sonne“ (0 kWh PV bei 3 kWh Verbrauch).
        assertThat(zweiter.echtSocEndKwh()).isNull();
        assertThat(zweiter.speicherVorsprungKwh()).isNull();
        assertThat(SteuerungGrund.fuer(zweiter.steuerungEur(), zweiter, null))
                .containsExactly(SteuerungGrund.WENIG_SONNE);
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Die Reihe über {@code [von, bis]} und jedes einzelne Tagesfenster darin
     * liefern je Tag denselben Speicher-Anteil (bitgleich) und damit dieselbe
     * Steuerungs-Zahl - sowohl über {@code savedSpeicherForSite} (Woche, Monat,
     * Jahr) als auch über die Einordnung (der Tages-Weg beider Controller).
     */
    private static void assertEinWalk(UUID site, LocalDate von, LocalDate bis) {
        List<EarningsRepository.DailySaved> reihe = earnings
                .dailySavedPerSite(from(von), to(bis)).get(site);
        assertThat(reihe).isNotEmpty();
        for (EarningsRepository.DailySaved d : reihe) {
            BigDecimal fenster = earnings.savedSpeicherForSite(site, from(d.day()), to(d.day()));
            EarningsRepository.Tageseinordnung t =
                    earnings.tageseinordnungForSite(site, from(d.day()), to(d.day()));
            assertThat(d.savedEur().subtract(d.savedSteuerungEur()))
                    .as("Reihe %s", d.day()).isEqualByComparingTo(fenster);
            assertThat(t.speicherEur()).as("Einordnung %s", d.day()).isEqualByComparingTo(fenster);
            assertThat(t.steuerungEur()).as("Einordnung %s", d.day())
                    .isEqualByComparingTo(d.savedSteuerungEur());
            assertThat(steuerung(site, d.day()).doubleValue()).as("Tagesfenster %s", d.day())
                    .isCloseTo(d.savedSteuerungEur().doubleValue(), Offset.offset(1e-9));
        }
    }

    private static EarningsRepository.Tageseinordnung einordnung(UUID site, String day) {
        LocalDate d = LocalDate.parse(day);
        return earnings.tageseinordnungForSite(site, from(d), to(d));
    }

    private static BigDecimal saved(UUID site, LocalDate day) {
        EarningsRepository.SiteAggregate a = earnings.aggregateForSite(site, from(day), to(day));
        return a.baselineEur().subtract(a.actualEur());
    }

    /** Der Rest-Trick des Controllers für ein Tagesfenster. */
    private static BigDecimal steuerung(UUID site, LocalDate day) {
        return saved(site, day).subtract(earnings.savedSpeicherForSite(site, from(day), to(day)));
    }

    private static BigDecimal speicherMonth(UUID site, int year, int month) {
        LocalDate first = LocalDate.of(year, month, 1);
        return earnings.savedSpeicherForSite(site, from(first),
                first.plusMonths(1).atStartOfDay(BERLIN).toInstant());
    }

    private static BigDecimal steuerungMonth(UUID site, int year, int month) {
        LocalDate first = LocalDate.of(year, month, 1);
        Instant f = from(first);
        Instant t = first.plusMonths(1).atStartOfDay(BERLIN).toInstant();
        EarningsRepository.SiteAggregate a = earnings.aggregateForSite(site, f, t);
        return a.baselineEur().subtract(a.actualEur())
                .subtract(earnings.savedSpeicherForSite(site, f, t));
    }

    private static Instant from(LocalDate day) {
        return day.atStartOfDay(BERLIN).toInstant();
    }

    private static Instant to(LocalDate day) {
        return day.plusDays(1).atStartOfDay(BERLIN).toInstant();
    }

    private static void seedAbendsGeleert(Connection c) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone, tarif_art, tarif_param_ct_kwh)"
                + " VALUES ('" + ABENDS + "', '" + TENANT + "', 'Abends geleert', 'DE-LU',"
                + " 'fest', 25)");
        exec(c, "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw,"
                + " max_discharge_kw) VALUES ('" + TENANT + "', '" + ABENDS
                + "', 'battery', 65, 30, 30)");
        JsonNode anker = vektor.path("monatsanker");
        rollup(c, ABENDS, Instant.parse(anker.path("bucket").asText()), null, null, null, null,
                anker.path("soc_last_pct").decimalValue());
        for (JsonNode e : vektor.path("eimer")) {
            Instant t = Instant.parse(e.get(0).asText());
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh,"
                            + " currency, source) VALUES (?, 'DE-LU', 'PT15M', ?, 'EUR', 'test')")) {
                ps.setTimestamp(1, Timestamp.from(t));
                ps.setBigDecimal(2, e.get(6).decimalValue());
                ps.execute();
            }
            rollup(c, ABENDS, t, e.get(1).decimalValue(), e.get(2).decimalValue(),
                    e.get(3).decimalValue(), e.get(4).decimalValue(), e.get(5).decimalValue());
        }
        // Ein Fahrplan-Slot trägt den Planwert des 24.09. (stur − cost).
        BigDecimal plan = vektor.path("plan_steuerung_eur").path("2026-09-24").decimalValue();
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, battery_kw,"
                        + " cost_eur, baseline_cost_eur, stur_cost_eur)"
                        + " VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)")) {
            ps.setTimestamp(1, Timestamp.from(Instant.parse("2026-09-24T06:00:00Z")));
            ps.setObject(2, TENANT);
            ps.setObject(3, ABENDS);
            ps.setObject(4, UUID.randomUUID());
            ps.setTimestamp(5, Timestamp.from(Instant.parse("2026-09-23T20:00:00Z")));
            ps.setBigDecimal(6, plan.negate());
            ps.setBigDecimal(7, plan.negate());
            ps.execute();
        }
    }

    private static void seedMonatsgrenze(Connection c) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone, tarif_art, tarif_param_ct_kwh)"
                + " VALUES ('" + GRENZE + "', '" + TENANT + "', 'Monatsgrenze', 'CH', 'fest', 30)");
        exec(c, "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw,"
                + " max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + TENANT + "', '"
                + GRENZE + "', 'battery', 10, 5, 5, 100)");
        String[][] slots = {
            // bucket (UTC)           pv   load soc_last_pct
            {"2026-04-29T12:00:00Z", "4", "0", null},
            {"2026-04-30T12:00:00Z", "0", "1", null},
            {"2026-05-01T12:00:00Z", "0", "2", "6"},
            {"2026-05-02T12:00:00Z", "0", "3", null},
        };
        for (String[] s : slots) {
            Instant t = Instant.parse(s[0]);
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh,"
                            + " currency, source) VALUES (?, 'CH', 'PT15M', 100, 'EUR', 'test')")) {
                ps.setTimestamp(1, Timestamp.from(t));
                ps.execute();
            }
            BigDecimal pv = new BigDecimal(s[1]);
            BigDecimal load = new BigDecimal(s[2]);
            // Gemessen ohne Speicher: das Netz trägt genau die Baseline.
            rollup(c, GRENZE, t, pv, load, load.subtract(pv).max(BigDecimal.ZERO),
                    pv.subtract(load).max(BigDecimal.ZERO), s[3] == null ? null : new BigDecimal(s[3]));
        }
        // Der Monatsanker Mai: 30.04. 23:45 Berlin, 80 %, ohne Energie (nicht covered).
        rollup(c, GRENZE, Instant.parse("2026-04-30T21:45:00Z"), null, null, null, null,
                new BigDecimal("80"));
    }

    private static void rollup(Connection c, UUID site, Instant bucket, BigDecimal pv,
            BigDecimal load, BigDecimal imp, BigDecimal exp, BigDecimal socLastPct)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh,"
                        + " grid_import_kwh, grid_export_kwh, soc_last_pct, n_samples)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 90)")) {
            ps.setTimestamp(1, Timestamp.from(bucket));
            ps.setObject(2, TENANT);
            ps.setObject(3, site);
            ps.setBigDecimal(4, pv);
            ps.setBigDecimal(5, load);
            ps.setBigDecimal(6, imp);
            ps.setBigDecimal(7, exp);
            ps.setBigDecimal(8, socLastPct);
            ps.execute();
        }
    }

    private static void exec(Connection c, String sql) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.execute();
        }
    }
}
