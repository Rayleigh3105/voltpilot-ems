package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
 * Die Term-Art {@code verteilung} und der {@code anteil} (UEMS AP-10 IP-5, eingelöst mit IP-8) gegen die
 * echte Kette: {@code POST …/berechnet}, {@code POST …/formel/fassungen}, {@code GET …/formel|wert|verlauf}
 * und — seit AP-10 IP-8 — {@code PUT …/verteilung}.
 *
 * <ul>
 *   <li>Der Teil eines Messwerts wartet weiter benannt: 422 mit dem Code und dem Kundensatz AUS DEM
 *       VERTRAG ({@code verteilung-vectors.json}, Block {@code leseweg}), und es wird nichts
 *       gespeichert — beim Anlegen nicht und bei einer neuen Fassung nicht.</li>
 *   <li>Ein Verteilungs-Term wird gespeichert (die Ablehnung {@code verteilung_wartet_auf_ip8} ist
 *       eingelöst); eine Kostenstelle, die es nicht gibt, ist 404 — nie der Fremdschlüssel als 500.</li>
 *   <li>Ohne Zeile der Verteilung am Tag nennen Wert und Verlauf den Term als fehlend
 *       ({@code nicht_verteilt}) — nie eine Zahl, nie eine Teilsumme, nie 0 %.</li>
 *   <li>Die EINE Stelle {@link AnteilLeseweg#lies} liest die echte Verteilung: dieselbe Kette rechnet den
 *       Anteil JE TAG des Buckets — der alte Tag mit dem Anteil von damals.</li>
 *   <li>Bestand zeichengleich, fremd ist 404.</li>
 * </ul>
 *
 * <p>Die Tage sind relativ zu HEUTE in Berlin (Buckets um 12:00, damit Mitternacht nichts vertauscht).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleFormelVerteilungsTermApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Path VERTRAG = Path.of("..", "..", "docs", "contracts", "v2", "verteilung-vectors.json");

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
    private static JsonNode leseweg;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final AtomicInteger SEQ = new AtomicInteger();

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        leseweg = MAPPER.readTree(Files.readString(VERTRAG)).path("leseweg");
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private static LocalDate heute() {
        return LocalDate.now(BERLIN);
    }

    // ======================================== eingelöst: der Verteilungs-Term wird gespeichert

    /**
     * Seit AP-10 IP-8 lehnt der Schreibweg einen Verteilungs-Term nicht mehr ab: er wird angelegt und in
     * einer neuen Fassung eingetragen. An der Stelle der eingelösten Ablehnung steht „die Kostenstelle ist
     * da“ — eine unbekannte ist 404 und es wird nichts gespeichert.
     */
    @Test
    void einVerteilungsTermWirdGespeichertEineUnbekannteKostenstelleIst404() throws Exception {
        Welt w = welt();
        UUID quelle = anlegen(w, term(w, PV1, "+"));
        long messstellenVorher = messstellen(w);

        Antwort unbekannt = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                berechnet(vterm(quelle, UUID.randomUUID())));
        assertThat(unbekannt.status()).as("Antwort " + unbekannt.body()).isEqualTo(404);
        assertThat(unbekannt.text()).doesNotContain("verteilung_wartet_auf_ip8");
        assertThat(messstellen(w)).as("nichts angelegt").isEqualTo(messstellenVorher);

        UUID kostenstelle = kostenstelle(w);
        UUID anteil = anlegen(w, vterm(quelle, kostenstelle));
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ? "
                + "AND eingang_art = 'verteilung' AND verteilung_ziel = ?", Long.class, anteil, kostenstelle)).isOne();

        long fassungenVorher = fassungen(quelle);
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + quelle + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+"), vterm(anlegen(w, term(w, PV2, "+")), kostenstelle))), 201);
        assertThat(fassungen(quelle)).as("die Fassung ist eingetragen").isEqualTo(fassungenVorher + 1);
    }

    @Test
    void einTeilDesMesswertsWirdBenanntAbgelehnt() throws Exception {
        Welt w = welt();
        Map<String, Object> laden = term(w, PV1, "-");
        laden.put("anteil", "positiv");
        pruefeAblehnung(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(term(w, PV2, "+"), laden)),
                "anteil_wartet_auf_ap08", "terme[1].anteil");

        UUID speicher = anlegen(w, term(w, PV3, "+"));
        Map<String, Object> entladen = mterm(speicher);
        entladen.put("anteil", "negativ");
        long fassungenVorher = fassungen(speicher);
        pruefeAblehnung(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + speicher + "/formel/fassungen",
                fassung(heute(), term(w, PV1, "+"), entladen)), "anteil_wartet_auf_ap08", "terme[1].anteil");
        assertThat(fassungen(speicher)).isEqualTo(fassungenVorher);

        // Beides fehlt: genannt wird zuerst der Teil des Messwerts (Prüfreihenfolge des Vertrags).
        Map<String, Object> beides = vterm(speicher, UUID.randomUUID());
        beides.put("anteil", "positiv");
        pruefeAblehnung(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(beides)),
                "anteil_wartet_auf_ap08", "terme[0].anteil");
    }

    @Test
    void dieFormUndDieVertragsregelGehenDemLesewegVoraus() throws Exception {
        Welt w = welt();
        UUID quelle = anlegen(w, term(w, PV1, "+"));

        Map<String, Object> kopierterFaktor = vterm(quelle, UUID.randomUUID());
        kopierterFaktor.put("faktor", 0.7);
        Antwort faktor = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(kopierterFaktor));
        pruefeAblehnung(faktor, "verteilungs_term_ohne_faktor", "terme[0].faktor");

        Map<String, Object> halb = term(w, PV1, "+");
        halb.put("anteil", "halb");
        Antwort unbekannt = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(halb));
        assertThat(unbekannt.status()).isEqualTo(400);
        assertThat(unbekannt.body().get("feld").asText()).isEqualTo("terme[0].anteil");

        Map<String, Object> ohneZiel = vterm(quelle, UUID.randomUUID());
        ohneZiel.remove("verteilung_ziel");
        assertThat(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(ohneZiel)).status())
                .isEqualTo(400);

        Map<String, Object> kanalMitZiel = term(w, PV1, "+");
        kanalMitZiel.put("verteilung_ziel", UUID.randomUUID().toString());
        Antwort zielAmKanal = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(kanalMitZiel));
        assertThat(zielAmKanal.status()).isEqualTo(400);
        assertThat(zielAmKanal.body().get("feld").asText()).isEqualTo("terme[0].verteilung_ziel");

        // `gesamt` ausdrücklich ist die Vorgabe: gespeichert wie ohne, gelesen wie vorher.
        Map<String, Object> gesamt = term(w, PV2, "+");
        gesamt.put("anteil", "gesamt");
        UUID id = anlegen(w, gesamt);
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ? "
                + "AND anteil IS NULL AND verteilung_ziel IS NULL", Long.class, id)).isOne();
        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200);
        // AP-08 (PR 758, mit dem main-Merge): gilt_als_erzeugung steht seitdem an jedem Term.
        assertThat(felder(formel.at("/terme/0"))).containsExactly("position", "eingang_art", "entity_id",
                "point_key", "quell_messstelle_id", "vorzeichen", "faktor", "gilt_als_erzeugung",
                "groesse", "eingerichtet");
    }

    @Test
    void eineFremdeQuelleIst404AuchMitVerteilung() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID vonA = anlegen(a, term(a, PV1, "+"));
        Antwort fremd = ruf(b, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                berechnet(vterm(vonA, UUID.randomUUID())));
        assertThat(fremd.status()).as("nicht da — nie ein 422, das die fremde Messstelle bestätigt").isEqualTo(404);
    }

    // ======================================================= im Wert und im Verlauf

    /**
     * Ein Term, dessen Anteil wartet, steht doch in der Datenbank (ein Schreiber ohne die Schnittstelle):
     * Wert und Verlauf nennen ihn als fehlend mit dem Code als Grund — nie eine Zahl, nie eine
     * Teilsumme aus den übrigen Termen. Ein Verteilungs-Term ohne Zeile der Verteilung am Tag ebenso:
     * {@code nicht_verteilt}, nie 0 %.
     */
    @Test
    void wertUndVerlaufNennenDenFehlendenTermStattEinerZahl() throws Exception {
        Welt w = welt();
        LocalDate gestern = heute().minusDays(1);
        Instant mittag = gestern.atTime(12, 0).atZone(BERLIN).toInstant();
        for (String pk : List.of(PV1, PV2, PV3)) {
            rollup(w, pk, mittag, 10000);
            probe(w, pk, 10000);
        }
        UUID quelle = anlegen(w, term(w, PV3, "+"));

        UUID verteilt = anlegen(w, term(w, PV1, "+"));
        UUID ziel = kostenstelle(w);
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor, verteilung_ziel) SELECT tenant_id, messstelle_id, "
                + "fassung_id, 1, 'verteilung', ?, '+', 1, ? FROM messstelle_formel_term WHERE messstelle_id = ?",
                quelle, ziel, verteilt);
        pruefeWartend(w, verteilt, mittag, "nicht_verteilt");
        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + verteilt + "/formel", null), 200);
        assertThat(formel.at("/terme/1/eingang_art").asText()).isEqualTo("verteilung");
        assertThat(formel.at("/terme/1/verteilung_ziel").asText()).isEqualTo(ziel.toString());
        assertThat(formel.at("/terme/1").has("anteil")).as("gesamt steht nicht im Körper").isFalse();

        UUID geteilt = anlegen(w, term(w, PV1, "+"));
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, eingang_art, "
                + "entity_id, point_key, vorzeichen, faktor, anteil) SELECT tenant_id, messstelle_id, fassung_id, 1, "
                + "'messkanal', ?, ?, '-', 1, 'positiv' FROM messstelle_formel_term WHERE messstelle_id = ?",
                w.komponente(), PV2, geteilt);
        pruefeWartend(w, geteilt, mittag, "anteil_wartet_auf_ap08");
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + geteilt + "/formel", null), 200)
                .at("/terme/1/anteil").asText()).isEqualTo("positiv");

        // Die Summe ohne den wartenden Term rechnet weiter wie vorher: 10 kW.
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + quelle + "/wert", null), 200)
                .get("wert").asDouble()).isEqualTo(10.0);
    }

    private void pruefeWartend(Welt w, UUID id, Instant mittag, String code) throws Exception {
        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").isNull()).as("nie eine Zahl").isTrue();
        assertThat(wert.get("unvollstaendig").asBoolean()).isTrue();
        assertThat(wert.get("stand").isNull()).isTrue();
        assertThat(wert.get("fehlende")).hasSize(1);
        assertThat(wert.at("/fehlende/0/position").asInt()).isEqualTo(1);
        assertThat(wert.at("/fehlende/0/grund").asText()).isEqualTo(code);

        JsonNode verlauf = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/verlauf?range=7d", null), 200);
        JsonNode punkt = null;
        for (JsonNode p : verlauf.get("punkte")) {
            if (java.time.OffsetDateTime.parse(p.get("zeit").asText()).toInstant().equals(mittag)) {
                punkt = p;
            }
        }
        assertThat(punkt).as("der Bucket steht da (der andere Term hat einen Wert)").isNotNull();
        assertThat(punkt.get("wert").isNull()).as("null — nie die Teilsumme 10").isTrue();
    }

    // ================================================ die EINE Stelle: Anteil je Tag

    /**
     * Die EINE Stelle {@link AnteilLeseweg#lies} liest die echte Verteilung ({@code PUT …/verteilung}):
     * dieselbe Schnittstelle speichert den Term und rechnet ihn mit dem Anteil DES TAGES — vorgestern
     * 70 %, ab gestern 60 %, heute 60 %; vor der Verteilung hat der Term keinen Anteil und der Bucket keinen
     * Wert (nie ein geratener Anteil).
     */
    @Test
    void derAufrufAnDerEinenStelleRechnetDenAnteilDesTages() throws Exception {
        Welt w = welt();
        LocalDate vorvorgestern = heute().minusDays(3);
        LocalDate vorgestern = heute().minusDays(2);
        LocalDate gestern = heute().minusDays(1);
        for (LocalDate tag : List.of(vorvorgestern, vorgestern, gestern)) {
            rollup(w, PV1, tag.atTime(12, 0).atZone(BERLIN).toInstant(), 10000);
        }
        probe(w, PV1, 10000);
        UUID quelle = anlegen(w, term(w, PV1, "+"));
        UUID kostenstelle = kostenstelle(w);
        UUID andere = kostenstelle(w);
        ok(ruf(w, HttpMethod.PUT, "/api/v1/messstellen/" + quelle + "/verteilung",
                satz(vorgestern, kostenstelle, "70", andere, "30")), 200);
        ok(ruf(w, HttpMethod.PUT, "/api/v1/messstellen/" + quelle + "/verteilung",
                satz(gestern, kostenstelle, "60", andere, "40")), 200);

        UUID anteil = anlegen(w, vterm(quelle, kostenstelle));
        Map<String, Double> punkte = verlauf(w, anteil);
        assertThat(punkte).containsEntry(mittag(vorgestern), 7.0);
        assertThat(punkte).as("der alte Tag behält seinen Anteil").containsEntry(mittag(gestern), 6.0);
        assertThat(punkte).as("ohne Verteilung am Tag kein Wert").doesNotContainKey(mittag(vorvorgestern));
        assertThat(verlauf(w, quelle)).containsEntry(mittag(vorvorgestern), 10.0);

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + anteil + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).as("heute gilt 60 %").isEqualTo(6.0);
        assertThat(wert.get("fehlende")).isEmpty();
    }

    private static Map<String, Object> satz(LocalDate ab, UUID k1, String a1, UUID k2, String a2) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("gueltig_ab", ab.toString());
        s.put("zeilen", List.of(Map.of("kostenstelle_id", k1.toString(), "anteil_prozent", a1),
                Map.of("kostenstelle_id", k2.toString(), "anteil_prozent", a2)));
        return s;
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, UUID box, UUID komponente) {}

    /** Das Ziel eines Verteilungs-Terms ist seit AP-10 IP-7 eine echte Kostenstelle des Kundenbereichs (Fremdschlüssel). */
    private UUID kostenstelle(Welt w) {
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Unternehmen', 'Europe/Berlin') "
                + "ON CONFLICT (tenant_id) DO NOTHING", w.mandant());
        return root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "SELECT u.tenant_id, u.id, 'K-' || (SELECT count(*) + 1 FROM kostenstelle k WHERE k.tenant_id = u.tenant_id), "
                + "'Spritzguss', DATE '2026-01-01' FROM unternehmen u WHERE u.tenant_id = ? RETURNING id", UUID.class,
                w.mandant());
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Verteilungs-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "VT-" + nr);
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

    private static long messstellen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ?", Long.class, w.mandant());
    }

    private static String mittag(LocalDate tag) {
        return tag.atTime(12, 0).atZone(BERLIN).toInstant().toString();
    }

    /** Die Punkte des Verlaufs (7 Tage) mit Wert, Zeitpunkt (UTC-Instant als Text) → kW. */
    private Map<String, Double> verlauf(Welt w, UUID id) throws Exception {
        JsonNode v = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/verlauf?range=7d", null), 200);
        Map<String, Double> out = new LinkedHashMap<>();
        for (JsonNode p : v.get("punkte")) {
            if (!p.get("wert").isNull()) {
                out.put(java.time.OffsetDateTime.parse(p.get("zeit").asText()).toInstant().toString(),
                        p.get("wert").asDouble());
            }
        }
        return out;
    }

    /** 422, Code, Feld, Paket und der Kundensatz Zeichen für Zeichen aus dem Vertrag. */
    private static void pruefeAblehnung(Antwort a, String code, String feld) {
        JsonNode soll = null;
        for (JsonNode x : leseweg.path("ablehnungen")) {
            if (x.path("code").asText().equals(code)) {
                soll = x;
            }
        }
        assertThat(soll).as(code + " steht im Vertrag").isNotNull();
        assertThat(a.status()).as("Antwort " + a.body()).isEqualTo(soll.path("status").asInt());
        assertThat(a.body().get("code").asText()).isEqualTo(code);
        assertThat(a.body().get("message").asText()).isEqualTo(soll.path("satz").asText());
        assertThat(a.body().get("feld").asText()).isEqualTo(feld);
        if (soll.path("wartet_auf").isNull()) {
            assertThat(a.body().has("wartet_auf")).isFalse();
        } else {
            assertThat(a.body().get("wartet_auf").asText()).isEqualTo(soll.path("wartet_auf").asText());
        }
    }

    // ================================================================ das Gerüst

    private UUID anlegen(Welt w, Map<?, ?>... terme) throws Exception {
        return UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet", berechnet(terme)), 201)
                .get("id").asText());
    }

    private static Map<String, Object> berechnet(Map<?, ?>... terme) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("name", "Gesamtwert");
        a.put("terme", List.of(terme));
        return a;
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

    private static Map<String, Object> vterm(UUID quell, UUID kostenstelle) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "verteilung");
        t.put("quell_messstelle_id", quell.toString());
        t.put("verteilung_ziel", kostenstelle.toString());
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
