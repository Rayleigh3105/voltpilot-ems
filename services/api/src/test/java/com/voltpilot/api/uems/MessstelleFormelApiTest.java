package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
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
 * Die berechnete Messstelle (UEMS AP-10, „Gesamtwert") gegen die echte Kette: Sicherheit, RLS,
 * Flyway-Schema, die Ableitung der Hauptgröße, die Cloud-Berechnung aus den historisierten Samples
 * und die harte Ehrlichkeitsregel {@code null} statt Teilsumme.
 *
 * <p>Ankerfall: die drei MPPT-Tracker eines Deye-Hybrids ({@code deye.hybrid_3p.pv.pv1-power} …
 * {@code pv3-power}, Wirkleistung / Erzeugung / W) als eine Gesamt-PV-Messstelle in kW.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessstelleFormelApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    private static final String PV1 = "deye.hybrid_3p.pv.pv1-power";
    private static final String PV2 = "deye.hybrid_3p.pv.pv2-power";
    private static final String PV3 = "deye.hybrid_3p.pv.pv3-power";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";       // Wirkenergie (Zähler)
    private static final String NETZ = "sunspec.model_203.w";               // import_export
    private static final String OHNE_RICHTUNG = "deye.hybrid_3p.generator-smartload-microinverter.generator-power";

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

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ Anlegen + Wert

    @Test
    void anlegenLeitetDieHauptgroesseAbUndRechnetDenLiveWert() throws Exception {
        Welt w = welt();
        // Alle drei Tracker liefern frisch (W): 12400 + 8000 + 3100 = 23500 W = 23,5 kW.
        probe(w, PV1, 12400);
        probe(w, PV2, 8000);
        probe(w, PV3, 3100);

        JsonNode ms = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", term(w, PV1), term(w, PV2), term(w, PV3))), 201);
        assertThat(ms.get("art").asText()).isEqualTo("berechnet");
        assertThat(ms.at("/hauptgroesse/groesse").asText()).isEqualTo("Wirkleistung");
        assertThat(ms.at("/hauptgroesse/richtung").asText()).isEqualTo("Erzeugung");
        assertThat(ms.at("/hauptgroesse/einheit").asText()).isEqualTo("kW");
        assertThat(ms.at("/hauptgroesse/wertart").asText()).isEqualTo("Momentanwert");
        // Vollständig eingerichtet (Name + abgeleitete Hauptgröße + Formel + Eingänge) → aktiv.
        assertThat(ms.get("lebenszyklus").asText()).isEqualTo("aktiv");
        assertThat(ms.get("fehlt")).isEmpty();
        UUID id = UUID.fromString(ms.get("id").asText());

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(23.5);
        assertThat(wert.get("einheit").asText()).isEqualTo("kW");
        assertThat(wert.get("unvollstaendig").asBoolean()).isFalse();
        assertThat(wert.get("fehlende")).isEmpty();

        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200);
        assertThat(formel.get("formel_vorhanden").asBoolean()).isTrue();
        assertThat(formel.get("eingaenge_eingerichtet").asBoolean()).isTrue();
        assertThat(formel.get("terme")).hasSize(3);
        assertThat(formel.at("/terme/0/point_key").asText()).isEqualTo(PV1);
        assertThat(formel.at("/terme/0/groesse/groesse").asText()).isEqualTo("Wirkleistung");
    }

    // ================================================================ Ehrlichkeit

    @Test
    void fehltEinTermIstDerWertNullNieEineTeilsumme() throws Exception {
        Welt w = welt();
        // Nur zwei der drei Tracker liefern — der dritte hat KEINEN Wert.
        probe(w, PV1, 12400);
        probe(w, PV2, 8000);

        UUID id = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", term(w, PV1), term(w, PV2), term(w, PV3))), 201).get("id").asText());

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").isNull()).as("null statt Teilsumme 20,4 kW").isTrue();
        assertThat(wert.get("unvollstaendig").asBoolean()).isTrue();
        assertThat(wert.get("fehlende")).hasSize(1);
        assertThat(wert.at("/fehlende/0/position").asInt()).isEqualTo(2);
        assertThat(wert.at("/fehlende/0/grund").asText()).isEqualTo("kein_wert");
    }

    // ================================================================ Verlauf

    @Test
    void derVerlaufSummiertNurVollstaendigeBuckets() throws Exception {
        Welt w = welt();
        long viertel = 15 * 60;
        long jetzt = Instant.now().getEpochSecond() / viertel * viertel;
        Instant b1 = Instant.ofEpochSecond(jetzt - viertel);       // vollständig
        Instant b2 = Instant.ofEpochSecond(jetzt - 2 * viertel);   // pv3 fehlt → null
        rollup(w, PV1, b1, 12000);
        rollup(w, PV2, b1, 8000);
        rollup(w, PV3, b1, 2000);
        rollup(w, PV1, b2, 10000);
        rollup(w, PV2, b2, 5000);

        UUID id = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", term(w, PV1), term(w, PV2), term(w, PV3))), 201).get("id").asText());

        JsonNode v = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/verlauf?range=24h", null), 200);
        assertThat(v.get("einheit").asText()).isEqualTo("kW");
        List<Double> werte = new ArrayList<>();
        List<Boolean> nulls = new ArrayList<>();
        for (JsonNode p : v.get("punkte")) {
            nulls.add(p.get("wert").isNull());
            if (!p.get("wert").isNull()) {
                werte.add(p.get("wert").asDouble());
            }
        }
        assertThat(werte).contains(22.0);                 // 12000+8000+2000 = 22 kW
        assertThat(nulls).contains(true);                 // der Bucket ohne pv3 ist null, nicht 15 kW
    }

    // ================================================================ Ablehnungen

    @Test
    void gemischteGroessenWerdenAbgelehnt() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Unsinn", term(w, PV1), term(w, ENERGIE)));
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().get("code").asText()).isEqualTo("groessen_gemischt");
        assertThat(a.body().get("grund").asText()).isEqualTo("groesse");
    }

    @Test
    void einMesswertOhneVertragsRichtungIstKeinTerm() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Unsinn", term(w, OHNE_RICHTUNG)));
        assertThat(a.status()).isEqualTo(400);
        assertThat(a.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
    }

    // ============================================= AP-08: „gilt als Erzeugung"

    @Test
    void derRichtungsloseGenPortIstMitHakenErzeugungUndBleibtInDerSummeErzeugung() throws Exception {
        Welt w = welt();
        selektion(w, OHNE_RICHTUNG);
        // PV1 12,4 + PV2 8,0 + PV3 3,1 + Gen-Port 2,0 = 25,5 kW, Richtung Erzeugung.
        probe(w, PV1, 12400);
        probe(w, PV2, 8000);
        probe(w, PV3, 3100);
        probe(w, OHNE_RICHTUNG, 2000);

        JsonNode ms = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", term(w, PV1), term(w, PV2), term(w, PV3),
                        termHaken(w, OHNE_RICHTUNG))), 201);
        // Die Summe aus lauter +-Erzeugungs-Termen bleibt Erzeugung (statt zu richtungslos zu degradieren).
        assertThat(ms.at("/hauptgroesse/richtung").asText()).isEqualTo("Erzeugung");
        UUID id = UUID.fromString(ms.get("id").asText());

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(25.5);

        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200);
        assertThat(formel.at("/terme/0/gilt_als_erzeugung").asBoolean()).isFalse();  // PV1, gerichtet
        assertThat(formel.at("/terme/3/gilt_als_erzeugung").asBoolean()).isTrue();   // Gen-Port
        assertThat(formel.at("/terme/3/groesse/richtung").asText()).isEqualTo("Erzeugung");
    }

    @Test
    void derRichtungsloseGenPortOhneHakenBleibtKeinTerm() throws Exception {
        Welt w = welt();
        Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Unsinn", term(w, OHNE_RICHTUNG)));
        assertThat(a.status()).isEqualTo(400);
        assertThat(a.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
    }

    @Test
    void derHakenAufEinemGerichtetenKanalWirdAbgelehnt() throws Exception {
        Welt w = welt();
        // PV1 trägt schon die Katalog-Richtung Erzeugung — der Haken wäre wirkungslos, also 400.
        Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Unsinn", termHaken(w, PV1)));
        assertThat(a.status()).isEqualTo(400);
        assertThat(a.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(a.body().get("feld").asText()).isEqualTo("terme[0].gilt_als_erzeugung");
    }

    // ================================================================ RLS

    @Test
    void neuerVorzeichenNetzTermWirdMitUndOhneHakenAbgelehnt() throws Exception {
        Welt w = welt();
        for (boolean haken : List.of(true, false)) {
            Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                    anlegen("Netz", haken ? termHaken(w, NETZ) : term(w, NETZ)));
            assertThat(a.status()).isEqualTo(400);
            assertThat(a.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
            assertThat(a.body().get("feld").asText())
                    .isEqualTo(haken ? "terme[0].gilt_als_erzeugung" : "terme[0]");
        }
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ?",
                Integer.class, w.mandant())).isZero();
        UUID id = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("PV", term(w, PV1))), 201).get("id").asText());
        var vorher = root.queryForList("SELECT * FROM messstelle_formel_fassung WHERE messstelle_id = ?", id);
        for (boolean haken : List.of(true, false)) {
            Antwort a = ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                    Map.of("gueltig_ab", LocalDate.now(ZoneId.of("Europe/Berlin")).toString(),
                            "terme", List.of(haken ? termHaken(w, NETZ) : term(w, NETZ))));
            assertThat(a.status()).isEqualTo(400);
            assertThat(a.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
            assertThat(a.body().get("feld").asText())
                    .isEqualTo(haken ? "terme[0].gilt_als_erzeugung" : "terme[0]");
        }
        assertThat(root.queryForList("SELECT * FROM messstelle_formel_fassung WHERE messstelle_id = ?", id))
                .isEqualTo(vorher);
    }

    @Test
    void gespeicherterVorzeichenNetzTermMitHakenBleibtBeimLesenUnveraendert() throws Exception {
        Welt w = welt();
        selektion(w, NETZ);
        UUID id = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Bestand", term(w, PV1))), 201).get("id").asText());
        LocalDate heute = LocalDate.now(ZoneId.of("Europe/Berlin"));
        ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/" + id + "/formel/fassungen",
                Map.of("gueltig_ab", heute.minusDays(1).toString(), "terme", List.of(term(w, PV1)))), 201);
        // Altbestand in beiden Fassungen herstellen: vor W1 über die API möglich.
        root.update("UPDATE messstelle_formel_term SET point_key = ?, faktor = 1.5, "
                + "gilt_als_erzeugung = true WHERE messstelle_id = ?", NETZ, id);
        var alteFassungen = root.queryForList("SELECT * FROM messstelle_formel_fassung WHERE messstelle_id = ?", id);
        var alteTerme = root.queryForList("SELECT * FROM messstelle_formel_term WHERE messstelle_id = ?", id);
        var alteMessstelle = root.queryForList("SELECT * FROM messstelle WHERE id = ?", id);
        probe(w, NETZ, -2000);
        Instant bucket = Instant.ofEpochSecond(Instant.now().getEpochSecond() / 900 * 900 - 900);
        rollup(w, NETZ, bucket, 4000);

        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200);
        assertThat(formel.at("/terme/0/gilt_als_erzeugung").asBoolean()).isTrue();
        assertThat(formel.at("/terme/0/groesse/richtung").asText()).isEqualTo("Erzeugung");
        assertThat(formel.at("/hauptgroesse/richtung").asText()).isEqualTo("Erzeugung");
        assertThat(formel.get("eingaenge_eingerichtet").asBoolean()).isTrue();
        for (int nummer : List.of(1, 2)) {
            LocalDate tag = nummer == 1 ? heute.minusDays(2) : heute;
            JsonNode amTag = ok(ruf(w, HttpMethod.GET,
                    "/api/v1/messstellen/" + id + "/formel?am=" + tag, null), 200);
            assertThat(amTag.at("/fassung_am/fassung/nummer").asInt()).isEqualTo(nummer);
            assertThat(amTag.at("/terme/0/gilt_als_erzeugung").asBoolean()).isTrue();
            assertThat(amTag.at("/terme/0/groesse/richtung").asText()).isEqualTo("Erzeugung");
            assertThat(amTag.at("/terme/0/faktor").asDouble()).isEqualTo(1.5);
            assertThat(amTag.get("eingaenge_eingerichtet").asBoolean()).isTrue();
        }
        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(-3.0);
        assertThat(wert.get("unvollstaendig").asBoolean()).isFalse();
        JsonNode verlauf = ok(ruf(w, HttpMethod.GET,
                "/api/v1/messstellen/" + id + "/verlauf?range=24h", null), 200);
        List<Double> werte = new ArrayList<>();
        for (JsonNode punkt : verlauf.get("punkte")) {
            if (!punkt.get("wert").isNull()) werte.add(punkt.get("wert").asDouble());
        }
        assertThat(werte).containsExactly(6.0);
        assertThat(root.queryForList("SELECT * FROM messstelle_formel_term WHERE messstelle_id = ?", id))
                .isEqualTo(alteTerme);
        assertThat(root.queryForList("SELECT * FROM messstelle_formel_fassung WHERE messstelle_id = ?", id))
                .isEqualTo(alteFassungen);
        assertThat(root.queryForList("SELECT * FROM messstelle WHERE id = ?", id)).isEqualTo(alteMessstelle);
    }

    @Test
    void eineFremdeBerechneteMessstelleIst404NieEine403() throws Exception {
        Welt a = welt();
        Welt b = welt();
        probe(a, PV1, 12400);
        UUID id = UUID.fromString(ok(ruf(a, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", term(a, PV1))), 201).get("id").asText());

        assertThat(ruf(b, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null).status())
                .isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, "/api/v1/messstellen/" + id + "/wert", null).status())
                .isEqualTo(404);
        assertThat(ok(ruf(a, HttpMethod.GET, "/api/v1/messstellen/" + id + "/formel", null), 200)
                .get("terme")).hasSize(1);
    }

    // ================================================================ Bausteine

    @Test
    void einBausteinVerkettetEineAndereMessstelleUndRechnetRichtig() throws Exception {
        Welt w = welt();
        probe(w, PV1, 12400);
        probe(w, PV2, 8000);
        probe(w, PV3, 3100);
        // B = PV1 + PV2 = 20,4 kW.
        UUID b = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Teil-PV", term(w, PV1), term(w, PV2))), 201).get("id").asText());
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + b + "/wert", null), 200)
                .get("wert").asDouble()).isEqualTo(20.4);

        // A = Baustein(B) + PV3 = 20,4 + 3,1 = 23,5 kW.
        JsonNode msA = ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", mterm(b), term(w, PV3))), 201);
        assertThat(msA.at("/hauptgroesse/groesse").asText()).isEqualTo("Wirkleistung");
        assertThat(msA.get("lebenszyklus").asText()).isEqualTo("aktiv");
        UUID a = UUID.fromString(msA.get("id").asText());

        JsonNode wert = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + a + "/wert", null), 200);
        assertThat(wert.get("wert").asDouble()).isEqualTo(23.5);
        assertThat(wert.get("unvollstaendig").asBoolean()).isFalse();

        JsonNode formel = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + a + "/formel", null), 200);
        assertThat(formel.get("eingaenge_eingerichtet").asBoolean()).isTrue();
        assertThat(formel.at("/terme/0/eingang_art").asText()).isEqualTo("messstelle");
        assertThat(formel.at("/terme/0/quell_messstelle_id").asText()).isEqualTo(b.toString());
        assertThat(formel.at("/terme/0/groesse/groesse").asText()).isEqualTo("Wirkleistung");

        // Ein fehlender Eingang IM Baustein macht auch den verketteten Wert null (nie Teilsumme).
        Welt w2 = welt();
        probe(w2, PV1, 12400); // PV2 fehlt -> B unvollständig -> A null
        UUID b2 = UUID.fromString(ok(ruf(w2, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Teil-PV", term(w2, PV1), term(w2, PV2))), 201).get("id").asText());
        probe(w2, PV3, 3100);
        UUID a2 = UUID.fromString(ok(ruf(w2, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", mterm(b2), term(w2, PV3))), 201).get("id").asText());
        JsonNode wert2 = ok(ruf(w2, HttpMethod.GET, "/api/v1/messstellen/" + a2 + "/wert", null), 200);
        assertThat(wert2.get("wert").isNull()).as("Baustein unvollständig -> null, nicht 3,1 kW").isTrue();
        assertThat(wert2.get("unvollstaendig").asBoolean()).isTrue();
    }

    @Test
    void einZyklusInDerVerkettungLiefertNullUndHaengtNichtAuf() throws Exception {
        Welt w = welt();
        probe(w, PV1, 12400);
        // B = PV1, A = Baustein(B) — bis hierher keine Kette im Kreis: A = 12,4 kW.
        UUID b = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Teil-PV", term(w, PV1))), 201).get("id").asText());
        UUID a = UUID.fromString(ok(ruf(w, HttpMethod.POST, "/api/v1/messstellen/berechnet",
                anlegen("Gesamt-PV", mterm(b))), 201).get("id").asText());
        assertThat(ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + a + "/wert", null), 200)
                .get("wert").asDouble()).isEqualTo(12.4);

        // Den Kreis kann die Anlege-Schnittstelle nicht bilden (der neue Knoten existiert noch
        // nicht, wenn er referenziert würde) — er entstünde erst über einen künftigen Bearbeiten-
        // Weg. Wir erzeugen den DB-Zustand direkt und beweisen: die Rechnung hält NICHT auf,
        // sondern liefert ehrlich null (die Frische-Grenze der Kette greift über den Besucht-Riegel).
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 1, 'messstelle', ?, '+', 1)",
                w.mandant(), b, a);

        JsonNode wertA = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + a + "/wert", null), 200);
        assertThat(wertA.get("wert").isNull()).as("der Kreis A->B->A liefert null, nicht eine Endlosschleife").isTrue();
        assertThat(wertA.get("unvollstaendig").asBoolean()).isTrue();
        // Auch der Verlauf terminiert und bleibt leer/ehrlich (kein Bucket ist vollständig).
        JsonNode verlaufA = ok(ruf(w, HttpMethod.GET, "/api/v1/messstellen/" + a + "/verlauf", null), 200);
        for (JsonNode p : verlaufA.get("punkte")) {
            assertThat(p.get("wert").isNull()).isTrue();
        }
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID anlage, UUID box, UUID komponente) {}

    /** Ein Kundenbereich mit einer Anlage, einer Box und einer Komponente, die PV1..PV3 liest. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Gesamtwert-Probe #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage #" + nr + "', now()) RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                + "created_at) VALUES (?, ?, ?, 'Box', 'claimed', now()) RETURNING id",
                UUID.class, t, anlage, "E-" + nr);
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

    private static final AtomicInteger SEQ = new AtomicInteger();

    /** Ein frischer GUTER Sample-Wert (W) für einen Kanal. */
    private void probe(Welt w, String pointKey, double wattr) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, "
                + "device_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, "
                + "edge_sequence, aggregation_kind, long_term_cadence_s) VALUES (now(), now(), ?, ?, ?, ?, "
                + "?, ?, 'good', '2026.09.11.1', ?, 'gauge', 900)",
                w.mandant(), w.anlage(), w.box(), pointKey, wattr, wattr, SEQ.incrementAndGet());
    }

    /** Ein 15-min-Rollup-Bucket (Momentanwert → avg_numeric) für einen Kanal. */
    private void rollup(Welt w, String pointKey, Instant bucket, double wattr) {
        root.update("INSERT INTO device_measurement_rollup_15m (bucket, tenant_id, site_id, device_id, "
                + "point_key, aggregation_kind, avg_numeric, last_numeric, sample_count, catalog_version) "
                + "VALUES (?, ?, ?, ?, ?, 'gauge', ?, ?, 1, '2026.09.11.1') ON CONFLICT DO NOTHING",
                java.sql.Timestamp.from(bucket), w.mandant(), w.anlage(), w.box(), pointKey, wattr, wattr);
    }

    // ================================================================ das Gerüst

    private static Map<String, Object> term(Welt w, String pointKey) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messkanal");
        t.put("entity_id", w.komponente().toString());
        t.put("point_key", pointKey);
        t.put("vorzeichen", "+");
        return t;
    }

    /** Ein Messkanal-Term mit gesetztem AP-08-Haken „gilt als Erzeugung". */
    private static Map<String, Object> termHaken(Welt w, String pointKey) {
        Map<String, Object> t = term(w, pointKey);
        t.put("gilt_als_erzeugung", true);
        return t;
    }

    /** Schaltet einen weiteren Kanal der Komponente als beobachtet ein (wie in {@link #welt()}). */
    private void selektion(Welt w, String pointKey) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, "
                + "changed_by, apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, "
                + "true, 60, 1, now(), '2026.09.11.1', 'test', 'pending_edge', 'energy_counter', "
                + "'fifteen_minute') ON CONFLICT DO NOTHING", w.mandant(), w.anlage(), w.box(),
                w.komponente(), pointKey);
    }

    /** Ein Baustein-Term: eine andere Messstelle als Eingang. */
    private static Map<String, Object> mterm(UUID quellMessstelle) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("eingang_art", "messstelle");
        t.put("quell_messstelle_id", quellMessstelle.toString());
        t.put("vorzeichen", "+");
        return t;
    }

    @SafeVarargs
    private static Map<String, Object> anlegen(String name, Map<String, Object>... terme) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("name", name);
        a.put("terme", List.of(terme));
        return a;
    }

    private record Antwort(int status, JsonNode body) {}

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
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
