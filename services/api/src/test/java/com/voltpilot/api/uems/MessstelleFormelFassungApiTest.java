package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Formel-Fassungen je Tag (UEMS AP-10 IP-3) gegen die echte Kette: {@code POST
 * …/messstellen/{id}/formel/fassungen}, {@code GET …/formel?am=} und die Berechnung, die die Fassung
 * DES TAGES liest — Live-Wert heute, Verlauf je Tag des Buckets.
 *
 * <p>Die Tage sind relativ zu HEUTE in Berlin (die Kundenbereiche der Tests haben keine
 * Unternehmen-Zeile, es gilt die Vorgabe-Zeitzone): Verlauf-Buckets liegen um 12:00 Uhr vorgestern
 * und gestern, damit kein Lauf um Mitternacht die Tage vertauscht.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleFormelFassungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static final String PV1 = "deye.hybrid_3p.pv.pv1-power";
    private static final String PV2 = "deye.hybrid_3p.pv.pv2-power";
    private static final String PV3 = "deye.hybrid_3p.pv.pv3-power";

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
    private static final AtomicInteger SEQ = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private static LocalDate heute() {
        return LocalDate.now(BERLIN);
    }

    // ============================================================ ohne Tag: wie vorher

    /**
     * Die Portal-Fläche aus PR #689 ruft {@code GET …/formel} OHNE Tag. Die Antwort trägt genau die
     * Felder von vor IP-3 in derselben Reihenfolge und die Terme der heutigen Fassung — für eine
     * Messstelle mit einer Fassung also ihre Terme. Mit {@code am} kommt NUR {@code fassung_am} dazu:
     * ohne diesen Block ist der Körper Zeichen für Zeichen derselbe.
     */
    @Test
    void einAufrufOhneTagLiefertZeichenFuerZeichenDasHeutige() throws Exception {
        Welt w = welt();
        UUID id = anlegen(w, term(w, PV1, "+"), term(w, PV2, "+"));

        Antwort ohne = ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null);
        assertThat(ohne.status()).isEqualTo(200);
        assertThat(felder(ohne.body())).containsExactly("messstelle_id", "schema_version", "hauptgroesse", "terme",
                "formel_vorhanden", "eingaenge_eingerichtet");
        assertThat(felder(ohne.body().at("/terme/0"))).containsExactly("position", "eingang_art", "entity_id",
                "point_key", "quell_messstelle_id", "vorzeichen", "faktor", "groesse", "eingerichtet");
        assertThat(ohne.body().get("schema_version").asText()).isEqualTo("1.0");
        assertThat(ohne.body().get("terme")).hasSize(2);

        Antwort mit = ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel?am=" + heute(), null);
        assertThat(mit.status()).isEqualTo(200);
        assertThat(mit.body().at("/fassung_am/tag").asText()).isEqualTo(heute().toString());
        assertThat(mit.body().at("/fassung_am/fassung/nummer").asInt()).isEqualTo(1);
        assertThat(mit.body().at("/fassung_am/fassung/gueltig_ab").isNull()).as("gilt seit Beginn").isTrue();
        assertThat(mit.body().at("/fassung_am/fassung/gueltig_bis").isNull()).isTrue();
        assertThat(mit.body().at("/fassung_am/fassung/herkunft").asText()).isEqualTo("anlage");
        assertThat(mit.body().at("/fassung_am/fassung/formel_typ").asText()).isEqualTo("gewichtete_summe");
        ObjectNode ohneBlock = (ObjectNode) mit.body().deepCopy();
        ohneBlock.remove("fassung_am");
        assertThat(ohne.text()).isEqualTo(MAPPER.writeValueAsString(ohneBlock));

        // Die Fassung 1 des Anlegens gilt auch für Tage VOR dem Anlegen (wie die zeitlosen Terme von PR #688).
        JsonNode frueher = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel?am=2020-01-01", null), 200);
        assertThat(frueher.get("terme")).isEqualTo(ohne.body().get("terme"));
    }

    // ================================================= gilt ab ihrem Tag, nicht rückwärts

    @Test
    void eineFassungGiltAbIhremTagUndNichtRueckwaerts() throws Exception {
        Welt w = welt();
        LocalDate vorgestern = heute().minusDays(2);
        LocalDate gestern = heute().minusDays(1);
        // Vorgestern und gestern um 12:00 liefern PV1 und PV2.
        for (LocalDate tag : List.of(vorgestern, gestern)) {
            Instant mittag = tag.atTime(12, 0).atZone(BERLIN).toInstant();
            rollup(w, PV1, mittag, 12000);
            rollup(w, PV2, mittag, 8000);
        }
        UUID id = anlegen(w, term(w, PV1, "+"));
        long protokollVorher = protokoll(id);

        // Fassung 2 ab gestern: PV1 + PV2 — eingetragen heute, also einen Tag rückwirkend.
        Antwort neu = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(gestern, term(w, PV1, "+"), term(w, PV2, "+")));
        JsonNode formel = ok(neu, 201);
        assertThat(formel.at("/fassung_am/tag").asText()).isEqualTo(gestern.toString());
        assertThat(formel.at("/fassung_am/fassung/nummer").asInt()).isEqualTo(2);
        assertThat(formel.at("/fassung_am/fassung/gueltig_ab").asText()).isEqualTo(gestern.toString());
        assertThat(formel.at("/fassung_am/fassung/herkunft").asText()).isEqualTo("eintrag");
        assertThat(formel.get("terme")).hasSize(2);

        // Fassung 1 endet am Vortag und bleibt lesbar.
        JsonNode alt = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel?am=" + vorgestern, null), 200);
        assertThat(alt.get("terme")).hasSize(1);
        assertThat(alt.at("/fassung_am/fassung/nummer").asInt()).isEqualTo(1);
        assertThat(alt.at("/fassung_am/fassung/gueltig_bis").asText()).isEqualTo(vorgestern.toString());
        // Heute gilt Fassung 2 — auch ohne Tag.
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200).get("terme"))
                .hasSize(2);

        // Der Verlauf rechnet jeden Tag mit SEINER Fassung: vorgestern 12 kW (nur PV1), gestern 20 kW.
        Map<String, Double> punkte = verlauf(w, id, "7d");
        assertThat(punkte).containsEntry(vorgestern.atTime(12, 0).atZone(BERLIN).toInstant().toString(), 12.0);
        assertThat(punkte).containsEntry(gestern.atTime(12, 0).atZone(BERLIN).toInstant().toString(), 20.0);

        // GENAU EIN Protokolleintrag, rückwirkend, gültig ab Mitternacht des Tages.
        assertThat(protokoll(id)).isEqualTo(protokollVorher + 1);
        Map<String, Object> eintrag = root.queryForMap("SELECT art, rueckwirkend, gilt_ab, neu::text AS neu "
                + "FROM messstelle_aenderung WHERE messstelle_id = ? AND art = 'formel_geaendert'", id);
        assertThat(eintrag.get("rueckwirkend")).isEqualTo(true);
        assertThat(((java.sql.Timestamp) eintrag.get("gilt_ab")).toInstant())
                .isEqualTo(gestern.atStartOfDay(BERLIN).toInstant());
        assertThat((String) eintrag.get("neu")).contains("\"fassung\": 2");
    }

    // ============================================================== Rückwirkend-Kennzeichen

    @Test
    void eineRueckwirkendeFassungIstGekennzeichnetEineHeutigeNicht() throws Exception {
        Welt w = welt();
        UUID id = anlegen(w, term(w, PV1, "+"));

        JsonNode drei = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute().minusDays(3), term(w, PV1, "+"), term(w, PV2, "+"))), 201);
        assertThat(drei.at("/fassung_am/fassung/rueckwirkend").asBoolean()).isTrue();
        assertThat(drei.at("/fassung_am/fassung/abzeichen").asText()).isEqualTo("rückwirkend (3 Tage)");

        JsonNode heuteAb = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+"), term(w, PV2, "+"), term(w, PV3, "+"))), 201);
        assertThat(heuteAb.at("/fassung_am/fassung/nummer").asInt()).isEqualTo(3);
        assertThat(heuteAb.at("/fassung_am/fassung/rueckwirkend").asBoolean()).isFalse();
        assertThat(heuteAb.at("/fassung_am/fassung/abzeichen").isNull()).isTrue();

        JsonNode geplant = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute().plusDays(10), term(w, PV1, "+"))), 201);
        assertThat(geplant.at("/fassung_am/fassung/rueckwirkend").asBoolean()).isFalse();
        // Das gespeicherte Kennzeichen liest sich später genauso.
        JsonNode spaeter = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel?am="
                + heute().minusDays(2), null), 200);
        assertThat(spaeter.at("/fassung_am/fassung/abzeichen").asText()).isEqualTo("rückwirkend (3 Tage)");
        assertThat(spaeter.at("/fassung_am/fassung/gueltig_bis").asText()).isEqualTo(heute().minusDays(1).toString());
    }

    // ================================================================= Überlappung

    @Test
    void eineUeberlappungWirdAbgelehntUndSchreibtNichts() throws Exception {
        Welt w = welt();
        UUID id = anlegen(w, term(w, PV1, "+"));
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute().minusDays(1), term(w, PV1, "+"), term(w, PV2, "+"))), 201);
        long fassungen = fassungen(id);
        long protokoll = protokoll(id);

        Antwort gleich = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute().minusDays(1), term(w, PV2, "+")));
        assertThat(gleich.status()).isEqualTo(422);
        assertThat(gleich.body().get("code").asText()).isEqualTo("formel_fassung_ueberlappt");
        assertThat(gleich.body().get("message").asText()).isEqualTo("Ab diesem Tag gilt schon Fassung 2.");
        assertThat(gleich.body().get("fassung").asInt()).isEqualTo(2);
        assertThat(gleich.body().get("gueltig_ab").asText()).isEqualTo(heute().minusDays(1).toString());

        Antwort davor = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute().minusDays(5), term(w, PV2, "+")));
        assertThat(davor.status()).isEqualTo(422);
        assertThat(davor.body().get("code").asText()).isEqualTo("formel_fassung_ueberlappt");

        assertThat(fassungen(id)).isEqualTo(fassungen);
        assertThat(protokoll(id)).isEqualTo(protokoll);
    }

    // =========================================== der Abnahmefall rechnet über die Fassung

    /**
     * Die Zahlen der Plan-Abnahme (F1: 100 · 60 · 30 → 10) als Momentanwerte in kW: Fassung 1 rechnet
     * PV1 − PV2 (40 kW), Fassung 2 ab heute PV1 − PV2 − PV3 = 10 kW — der Live-Wert liest die Fassung
     * von heute. Eine Fassung mit anderer Hauptgröße (nur PV1 = Erzeugung statt richtungslos) ist keine
     * Formel dieser Messstelle.
     */
    @Test
    void derAbnahmefallRechnetJetztUeberDieFassung() throws Exception {
        Welt w = welt();
        probe(w, PV1, 100_000);
        probe(w, PV2, 60_000);
        probe(w, PV3, 30_000);
        UUID id = anlegen(w, term(w, PV1, "+"), term(w, PV2, "-"));
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200).get("wert").asDouble())
                .isEqualTo(40.0);

        Antwort andereGroesse = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+")));
        assertThat(andereGroesse.status()).isEqualTo(422);
        assertThat(andereGroesse.body().get("code").asText()).isEqualTo("groessen_gemischt");
        assertThat(andereGroesse.body().get("grund").asText()).isEqualTo("richtung");

        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+"), term(w, PV2, "-"), term(w, PV3, "-"))), 201);
        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(10.0);
        assertThat(wert.get("einheit").asText()).isEqualTo("kW");
        assertThat(wert.get("unvollstaendig").asBoolean()).isFalse();
        // Der Lebenszyklus sieht die Fassung von heute.
        JsonNode ms = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id, null), 200);
        assertThat(ms.get("lebenszyklus").asText()).isEqualTo("aktiv");
    }

    // ================================================================ Mandantenzaun

    @Test
    void eineFremdeMessstelleIst404NieEine403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID id = anlegen(a, term(a, PV1, "+"));

        assertThat(ruf(b, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel?am=" + heute(), null).status())
                .isEqualTo(404);
        Antwort fremd = ruf(b, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute(), term(b, PV1, "+")));
        assertThat(fremd.status()).isEqualTo(404);
        assertThat(fassungen(id)).isEqualTo(1);
        // Eine fremde Komponente in den Termen ist ebenso nicht da.
        Antwort fremderTerm = ruf(a, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                fassung(heute(), term(b, PV1, "+")));
        assertThat(fremderTerm.status()).isEqualTo(404);
        assertThat(fassungen(id)).isEqualTo(1);
    }

    // ========================================================== Anfrage und Zyklus

    @Test
    void dieAnfrageWirdStrengGelesenUndEinKreisAbgelehnt() throws Exception {
        Welt w = welt();
        UUID b = anlegen(w, term(w, PV1, "+"));
        UUID a = anlegen(w, mterm(b));

        Map<String, Object> camel = new LinkedHashMap<>();
        camel.put("gueltigAb", heute().toString());
        camel.put("terme", List.of(term(w, PV1, "+")));
        Antwort falschGeschrieben = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + b + "/formel/fassungen", camel);
        assertThat(falschGeschrieben.status()).isEqualTo(400);
        assertThat(falschGeschrieben.body().get("feld").asText()).isEqualTo("gueltigAb");

        Antwort ohneTag = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + b + "/formel/fassungen",
                Map.of("terme", List.of(term(w, PV1, "+"))));
        assertThat(ohneTag.status()).isEqualTo(400);
        assertThat(ohneTag.body().get("feld").asText()).isEqualTo("gueltig_ab");

        assertThat(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + b + "/formel?am=gestern", null).status())
                .isEqualTo(400);

        // B verkettet ab heute A, das B verkettet: ein Kreis.
        Antwort kreis = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + b + "/formel/fassungen",
                fassung(heute(), mterm(a)));
        assertThat(kreis.status()).isEqualTo(422);
        assertThat(kreis.body().get("code").asText()).isEqualTo("formel_zyklus");
        assertThat(fassungen(b)).isEqualTo(1);

        // A verkettet B nur bis gestern (Fassung 2 von A ab heute liest PV1): ab heute darf B A verketten —
        // eine beendete Fassung bildet keinen Kreis mit einer, die erst danach beginnt.
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + a + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+"))), 201);
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + b + "/formel/fassungen",
                fassung(heute().plusDays(1), mterm(a))), 201);
        assertThat(fassungen(b)).isEqualTo(2);
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, UUID box, UUID komponente) {}

    /** Ein Kundenbereich mit einer Anlage, einer Box und einer Komponente, die PV1..PV3 liest. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Fassungs-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "FA-" + nr);
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, created_at) VALUES (?, ?, "
                + "'battery-hybrid', 'Wechselrichter', 'battery-hybrid', ?, false, 'modbus_tcp', now()) "
                + "RETURNING id", UUID.class, t, anlage, box);
        for (String pk : List.of(PV1, PV2, PV3)) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, "
                    + "changed_by, apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, "
                    + "true, 60, 1, now(), '2026.09.11.1', 'test', 'pending_edge', 'energy_counter', "
                    + "'fifteen_minute') ON CONFLICT DO NOTHING", t, anlage, box, k, pk);
        }
        return new Welt(t, anlage, box, k);
    }

    private void probe(Welt w, String pointKey, double watt) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, "
                + "edge_sequence, aggregation_kind, long_term_cadence_s) VALUES (now(), now(), ?, ?, ?, ?, "
                + "?, ?, 'good', '2026.09.11.1', ?, 'gauge', 900)",
                w.mandant(), w.anlage(), w.box(), pointKey, watt, watt, SEQ.incrementAndGet());
    }

    private void rollup(Welt w, String pointKey, Instant bucket, double watt) {
        root.update("INSERT INTO device_measurement_rollup_15m (bucket, tenant_id, site_id, device_id, "
                + "point_key, aggregation_kind, avg_numeric, last_numeric, sample_count, catalog_version) "
                + "VALUES (?, ?, ?, ?, ?, 'gauge', ?, ?, 1, '2026.09.11.1') ON CONFLICT DO NOTHING",
                java.sql.Timestamp.from(bucket), w.mandant(), w.anlage(), w.box(), pointKey, watt, watt);
    }

    private static long fassungen(UUID messstelle) {
        return root.queryForObject("SELECT count(*) FROM messstelle_formel_fassung WHERE messstelle_id = ?",
                Long.class, messstelle);
    }

    private static long protokoll(UUID messstelle) {
        return root.queryForObject("SELECT count(*) FROM messstelle_aenderung WHERE messstelle_id = ?",
                Long.class, messstelle);
    }

    /** Die Punkte des Verlaufs mit Wert, Zeitpunkt (UTC-Instant als Text) → kW. */
    private Map<String, Double> verlauf(Welt w, UUID id, String range) throws Exception {
        JsonNode v = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/verlauf?range=" + range, null), 200);
        Map<String, Double> out = new LinkedHashMap<>();
        for (JsonNode p : v.get("punkte")) {
            if (!p.get("wert").isNull()) {
                out.put(java.time.OffsetDateTime.parse(p.get("zeit").asText()).toInstant().toString(),
                        p.get("wert").asDouble());
            }
        }
        return out;
    }

    // ================================================================ das Gerüst

    private UUID anlegen(Welt w, Map<?, ?>... terme) throws Exception {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("name", "Gesamtwert");
        a.put("terme", List.of(terme));
        return UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", a), 201)
                .get("id").asText());
    }

    private static Map<String, Object> term(Welt w, String pointKey, String vorzeichen) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messkanal");
        t.put("entity_id", w.komponente().toString());
        t.put("point_key", pointKey);
        t.put("vorzeichen", vorzeichen);
        return t;
    }

    private static Map<String, Object> mterm(UUID quell) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messstelle");
        t.put("quell_messstelle_id", quell.toString());
        t.put("vorzeichen", "+");
        return t;
    }

    private static Map<String, Object> fassung(LocalDate ab, Map<?, ?>... terme) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("gueltig_ab", ab.toString());
        f.put("terme", List.of(terme));
        return f;
    }

    private static List<String> felder(JsonNode n) {
        List<String> out = new ArrayList<>();
        for (Iterator<String> it = n.fieldNames(); it.hasNext();) {
            out.add(it.next());
        }
        return out;
    }

    private record Antwort(int status, JsonNode body, String text) {}

    private static JsonNode ok(Antwort a, int status) {
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(status);
        return a.body();
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + w.mandant());
                    j.claim("name", "Test");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text), text);
    }
}
