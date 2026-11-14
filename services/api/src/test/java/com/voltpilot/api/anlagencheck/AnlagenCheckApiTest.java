package com.voltpilot.api.anlagencheck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.history.HistoryRange;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Anlagen-Check gegen die echte Kette (Bauplan §9.2, Tests A2/A5): zwei Wechselrichter an zwei Einheiten, die
 * Erwartung aus {@code solar_erwartung_einheit}, die Stundenwerte aus {@code telemetry_v2_rollup_1h}; ohne Zuordnung
 * die ganze Anlage aus {@code forecast_rueckblick}; die Speicher-Bilanz aus {@code telemetry_rollup_1d}. Dazu
 * Mandantentrennung (fremde Anlage 404, RLS/FORCE der neuen Tabelle) und die Rechte der App-Rolle.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AnlagenCheckApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final double BREITE = 48.7;
    private static final double LAENGE = 12.6;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID site) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private static LocalDate gestern() {
        return LocalDate.now(HistoryRange.ZONE).minusDays(1);
    }

    // ================================================================== Einheiten

    @Test
    void zweiGeraeteAnZweiEinheitenCarportLiefertWeniger() throws Exception {
        Welt w = welt();
        UUID sued = einheit(w, "Dach Süd", 10.0);
        UUID carport = einheit(w, "Carport", 10.0);
        UUID wr1 = messpunkt(w, "Kaco 1");
        UUID wr2 = messpunkt(w, "Kaco 2");
        zuordnen(w, sued, wr1);
        zuordnen(w, carport, wr2);
        for (int i = 0; i < 7; i++) {
            LocalDate d = gestern().minusDays(i);
            erwartung(w, sued, d, 50.0);
            erwartung(w, carport, d, 50.0);
            stunden(w, wr1, d, 50.0);
            stunden(w, wr2, d, 30.0);
        }

        JsonNode a = ok(ruf(w, "/anlagen-check?z=woche&at=" + gestern()));
        assertThat(a.get("pv").asBoolean()).isTrue();
        assertThat(a.get("modus").asText()).isEqualTo("einheiten");
        JsonNode kachel = a.get("kachel");
        assertThat(kachel.get("gesamt").asText()).isEqualTo("weniger");
        assertThat(kachel.get("fensterTage").asInt()).isEqualTo(7);
        assertThat(kachel.get("sonnenTage").asInt()).isEqualTo(7);
        assertThat(kachel.at("/einheiten/0/name").asText()).isEqualTo("Dach Süd");
        assertThat(kachel.at("/einheiten/0/zustand").asText()).isEqualTo("wie_erwartet");
        assertThat(kachel.at("/einheiten/0/verhaeltnis").asDouble()).isCloseTo(1.0, within(0.001));
        assertThat(kachel.at("/einheiten/1/zustand").asText()).isEqualTo("weniger");
        assertThat(kachel.at("/einheiten/1/verhaeltnis").asDouble()).isCloseTo(0.6, within(0.001));
        assertThat(kachel.at("/einheiten/1/gemessenKwh").asDouble()).isCloseTo(210.0, within(0.01));

        JsonNode z = a.get("zeitraum");
        assertThat(z.get("z").asText()).isEqualTo("woche");
        assertThat(z.get("eimer").asText()).isEqualTo("tag");
        assertThat(z.get("saeulen").size()).isBetween(1, 7);
        assertThat(z.at("/saeulen/0/kwh").size()).isEqualTo(2);
        assertThat(z.at("/einheiten/1/zustand").asText()).isIn("weniger", "offen");
        assertThat(a.get("ohneGeraet")).isEmpty();
    }

    @Test
    void einSchweigenderWechselrichterIstMesswerteFehlenNichtWeniger() throws Exception {
        Welt w = welt();
        UUID e1 = einheit(w, null, 10.0);
        UUID e2 = einheit(w, null, 10.0);
        UUID wr1 = messpunkt(w, "Kaco 1");
        UUID wr3 = messpunkt(w, "Kaco 3");
        zuordnen(w, e1, wr1);
        zuordnen(w, e2, wr3);
        for (int i = 0; i < 7; i++) {
            LocalDate d = gestern().minusDays(i);
            erwartung(w, e1, d, 50.0);
            erwartung(w, e2, d, 50.0);
            stunden(w, wr1, d, 50.0);
            if (i >= 3) {
                stunden(w, wr3, d, 50.0); // die letzten drei Tage: nichts
            }
        }
        JsonNode k = ok(ruf(w, "/anlagen-check")).get("kachel");
        assertThat(k.get("gesamt").asText()).isEqualTo("messwerte_fehlen");
        assertThat(k.at("/einheiten/1/name").asText()).as("ohne Bezeichnung: das eine Gerät").isEqualTo("Kaco 3");
        assertThat(k.at("/einheiten/1/zustand").asText()).isEqualTo("fehlt");
        assertThat(k.at("/einheiten/1/keineWerteSeit").asText()).isEqualTo(gestern().minusDays(2).toString());
    }

    // ================================================================== ganze Anlage

    @Test
    void ohneZuordnungVergleichtDieGanzeAnlage() throws Exception {
        Welt w = welt();
        einheit(w, "Hybrid", 9.8);
        for (int i = 0; i < 14; i++) {
            root.update("INSERT INTO forecast_rueckblick (day, tenant_id, site_id, kind, model, lead_days, "
                    + "erwartet_kwh, gemessen_kwh, mae_kw, n_slots) VALUES (?, ?, ?, 'pv', 'pv-physical', 1, "
                    + "40, 38, 0.3, 96)", gestern().minusDays(i), w.mandant(), w.site());
        }
        JsonNode a = ok(ruf(w, "/anlagen-check"));
        assertThat(a.get("modus").asText()).isEqualTo("ganze_anlage");
        assertThat(a.at("/kachel/fensterTage").asInt()).isEqualTo(14);
        assertThat(a.at("/kachel/gesamt").asText()).isEqualTo("wie_erwartet");
        assertThat(a.at("/kachel/einheiten/0/name").asText()).isEqualTo("Ganze Anlage");
        assertThat(a.at("/kachel/einheiten/0/verhaeltnis").asDouble()).isCloseTo(0.95, within(1e-6));
        assertThat(a.get("zeitraum").isNull()).as("ohne z nur die Kachel").isTrue();
    }

    @Test
    void ohnePvKeineKachel() throws Exception {
        Welt w = welt();
        JsonNode a = ok(ruf(w, "/anlagen-check?z=monat"));
        assertThat(a.get("pv").asBoolean()).isFalse();
        assertThat(ruf(w, "/anlagen-check?z=quartal").status()).isEqualTo(400);
    }

    // ================================================================== Mandantentrennung

    @Test
    void fremdeAnlageIst404UndRlsHaeltDieErwartungZurueck() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID e = einheit(a, "Dach", 10.0);
        erwartung(a, e, gestern(), 50.0);
        assertThat(ruf(b, "/anlagen-check", a.site()).status()).isEqualTo(404);
        assertThat(ruf(b, "/speicher-bilanz", a.site()).status()).isEqualTo(404);

        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        Long fremd = app.execute((java.sql.Connection c) -> {
            try (var st = c.createStatement()) {
                st.execute("SET app.tenant_id = '" + b.mandant() + "'");
                try (var rs = st.executeQuery("SELECT count(*) FROM solar_erwartung_einheit")) {
                    rs.next();
                    return rs.getLong(1);
                }
            }
        });
        assertThat(fremd).isZero();
        assertThat(root.queryForObject("SELECT relforcerowsecurity FROM pg_class WHERE relname = "
                + "'solar_erwartung_einheit'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'solar_erwartung_einheit', 'INSERT')",
                Boolean.class, APP_USER)).as("die App liest nur").isFalse();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'solar_erwartung_einheit', 'SELECT')",
                Boolean.class, APP_USER)).isTrue();
    }

    // ================================================================== Speicher

    @Test
    void speicherBilanzMitLadestandAusgleich() throws Exception {
        Welt w = welt();
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) "
                + "VALUES (?, ?, 'battery', 10, 5, 5)", w.mandant(), w.site());
        LocalDate bis = gestern();
        LocalDate von = bis.minusDays(29);
        tag1d(w, von.minusDays(1), 4.0, 3.5, 8.0);
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            tag1d(w, d, 141.2 / 30, 119.3 / 30, d.equals(bis) ? 94.0 : 50.0);
        }
        JsonNode s = ok(ruf(w, "/speicher-bilanz"));
        assertThat(s.get("zustand").asText()).isEqualTo("normal");
        assertThat(s.get("kapazitaetKwh").asDouble()).isEqualTo(10.0);
        assertThat(s.get("wirkungsgrad").asDouble()).isCloseTo(0.906, within(0.001));
        assertThat(s.get("ausgleichKwh").asDouble()).isCloseTo(8.6, within(0.001));
        assertThat(s.get("vollzyklen").asDouble()).isCloseTo(11.93, within(0.001));
        assertThat(s.get("vollzyklenSeitBeginn").asDouble()).isCloseTo(12.28, within(0.001));
    }

    @Test
    void speicherBilanzOhneDaten() throws Exception {
        Welt w = welt();
        JsonNode s = ok(ruf(w, "/speicher-bilanz"));
        assertThat(s.get("zustand").asText()).isEqualTo("ohne_daten");
        assertThat(s.get("wirkungsgrad").isNull()).isTrue();
    }

    // ================================================================== Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Anlagen-Check #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, latitude, longitude) VALUES (?, ?, ?, ?) "
                + "RETURNING id", UUID.class, t, "Haus am Mühlbach #" + nr, BREITE, LAENGE);
        return new Welt(t, s);
    }

    private static UUID einheit(Welt w, String name, double kwp) {
        return root.queryForObject("INSERT INTO register_einheit (tenant_id, site_id, art, bezeichnung, "
                + "inbetriebnahme, leistung_kwp, bestaetigt_am) VALUES (?, ?, 'pv', ?, '2020-01-01', ?, now()) "
                + "RETURNING id", UUID.class, w.mandant(), w.site(), name, kwp);
    }

    private static UUID messpunkt(Welt w, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label) "
                + "VALUES (?, ?, 'pv-generation', ?) RETURNING id", UUID.class, w.mandant(), w.site(), label);
    }

    private static void zuordnen(Welt w, UUID einheit, UUID mp) {
        root.update("INSERT INTO einheit_geraet (tenant_id, einheit_id, measurement_point_id) VALUES (?, ?, ?)",
                w.mandant(), einheit, mp);
    }

    private static void erwartung(Welt w, UUID einheit, LocalDate d, double kwh) {
        root.update("INSERT INTO solar_erwartung_einheit (day, tenant_id, site_id, einheit_id, model, lead_days, "
                + "erwartet_kwh, leistung_kwp) VALUES (?, ?, ?, ?, 'pv-physical', 1, ?, 10)",
                d, w.mandant(), w.site(), einheit, kwh);
    }

    /** {@code kwh} gleichmäßig auf die Tagstunden (Sonne über 5° in der Stundenmitte) des Tages verteilt. */
    private static void stunden(Welt w, UUID mp, LocalDate d, double kwh) {
        List<Instant> h = AnlagenCheckService.stundenDesTages(d);
        List<Instant> hell = h.stream().filter(s -> SonnenStand.hoehe(BREITE, LAENGE,
                s.plus(Duration.ofMinutes(30))) > AnlagenCheckRegel.TAG_AB_GRAD).toList();
        for (Instant s : hell) {
            root.update("INSERT INTO telemetry_v2_rollup_1h (bucket, tenant_id, site_id, entity_id, channel, "
                    + "avg_value, min_value, max_value, last_value, n_samples) "
                    + "VALUES (?, ?, ?, ?, 'pv_power_kw', ?, 0, 0, 0, 720)",
                    Timestamp.from(s), w.mandant(), w.site(), mp.toString(), kwh / hell.size());
        }
    }

    private static void tag1d(Welt w, LocalDate d, double hinein, double heraus, double soc) {
        root.update("INSERT INTO telemetry_rollup_1d (bucket, tenant_id, site_id, battery_charge_kwh, "
                + "battery_discharge_kwh, soc_last_pct, n_samples) VALUES (?, ?, ?, ?, ?, ?, 96)",
                Timestamp.from(d.atStartOfDay(HistoryRange.ZONE).toInstant()), w.mandant(), w.site(), hinein, heraus,
                soc);
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    private Antwort ruf(Welt w, String pfad) throws Exception {
        return ruf(w, pfad, w.site());
    }

    private Antwort ruf(Welt w, String pfad, UUID site) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/sites/" + site + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("preferred_username", "Alex Beispiel");
                    j.claim("tenant_id", w.mandant().toString());
                }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
