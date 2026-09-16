package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeResult.OpResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.StringJoiner;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * Die Datenquellen-Schnittstelle (UEMS AP-06 IP-3) gegen die echte Sicherheitskette, die echte
 * RLS und TimescaleDB — per MockMvc, die Anmeldung setzt {@code jwt()} (kein Keycloak nötig).
 *
 * <p>Der Prüfnachweis des Konzepts (AP-06 §8 IP-3): Anlegen mit automatischem DQ-n,
 * Eindeutigkeit je Box, gleiche Adresse an zwei Boxen erlaubt (A4), Steuerquelle-Wechsel 409
 * mit Grund (A13), Urheber im Protokoll — dazu A3 hin und zurück, A11, A8, rückwirkend, fremder
 * Kundenbereich 404. Die 21 Fälle der Familie {@code antrag} aus
 * {@code docs/contracts/v2/data-source-vectors.json} laufen als Eingänge DURCH die Schnittstelle
 * — anlegen, von der Box prüfen, zuweisen — und müssen Urteil, Grund, Satz, Hinweis und die
 * Zeiträume danach genau so liefern wie die reinen Regeln.
 *
 * <p>Die Beispielwelt ist allein das Referenzunternehmen ({@code uems-referenzunternehmen.json}):
 * Anlagen, Boxen (Name, Seriennummer, Heimat), Quellen und ihre Zeiträume kommen mit ihren
 * Kennzeichen und Werten aus der Datei. Jeder Test spielt in einem eigenen Kundenbereich.
 *
 * <p>Die Box antwortet über einen Stellvertreter von {@link ProbeService#probeBox}; dass die
 * Frage wirklich an GENAU diese Box geht, beweist {@code ProbeServiceBoxTest}. Die Uhr des
 * Dienstes stellt der Test ({@link Uhr}), damit die „jetzt“-Zeitpunkte der Fälle gelten.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class DatenquelleApiTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    /** Die Gründe-Tabelle der Schnittstelle: je Grund des Vertrags genau ein HTTP-Status. */
    private static final Map<String, Integer> STATUS_JE_GRUND = Map.ofEntries(
            Map.entry("protokoll_unbekannt", 400),
            Map.entry("keine_volle_minute", 422),
            Map.entry("rueckwirkend", 422),
            Map.entry("leerer_zeitraum", 422),
            Map.entry("steuerquelle", 409),
            Map.entry("spaeterer_wechsel_geplant", 409),
            Map.entry("schon_zustaendig", 409),
            Map.entry("ueberschneidung", 409),
            Map.entry("adresse_an_box_vergeben", 409),
            Map.entry("netzlage_fehlt", 409),
            Map.entry("nur_ein_leser", 409),
            Map.entry("vergleich_bestaetigen", 409),
            Map.entry("pruefung_fehlt", 409),
            Map.entry("pruefung_gescheitert", 409));

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
        // Die echte Kette mit OIDC AN (die Vorgabe); die Anmeldung setzt jwt() — der Decoder
        // wird nie gefragt, darum zeigt er ins Leere.
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    /** Die Uhr, die der Test stellt — {@link DatenquelleService} nimmt sie statt der Systemuhr. */
    static final class Uhr extends Clock {
        private volatile Instant jetzt = Instant.now();

        void stelle(String zeitpunkt) {
            jetzt = OffsetDateTime.parse(zeitpunkt).toInstant();
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return jetzt;
        }
    }

    static final Uhr UHR = new Uhr();

    @TestConfiguration
    static class DieUhrDesTests {
        @Bean
        Uhr datenquellenTestUhr() {
            return UHR;
        }
    }

    @MockBean
    ProbeService probes;

    @MockBean
    DatenquelleBudgetService budgets;

    @Autowired
    MockMvc mvc;

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        vektoren = MAPPER.readTree(V2.resolve("data-source-vectors.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        reset(probes, budgets);
        TenantContext.clear();
    }

    // ============================================================ Vektor-Fälle

    /** Die Fälle der Familie {@code antrag} — Eingänge der Schnittstelle, Urteil wie die Regeln. */
    @TestFactory
    Stream<DynamicTest> dieFamilieAntragLaeuftDurchDieSchnittstelle() {
        List<JsonNode> faelle = StreamSupport.stream(vektoren.get("cases").spliterator(), false)
                .filter(f -> "antrag".equals(f.get("familie").asText())).toList();
        assertThat(faelle).hasSize(21);
        return faelle.stream().map(f -> DynamicTest.dynamicTest(f.get("name").asText(), () -> spiele(f)));
    }

    private void spiele(JsonNode fall) throws Exception {
        reset(probes);
        JsonNode in = fall.get("input");
        JsonNode antrag = in.get("antrag");
        JsonNode erwartet = fall.get("expected");
        assertThat(in.get("zeitzone").asText()).isEqualTo(DatenquelleService.ZONE.getId());

        Welt w = new Welt("Probe " + fall.get("name").asText());
        for (JsonNode b : in.get("boxen")) {
            w.box(b.get("kennzeichen").asText());
            assertThat(referenzBox(b.get("kennzeichen").asText()).get("name").asText())
                    .isEqualTo(b.get("name").asText());
        }
        for (JsonNode q : in.get("quellen")) {
            w.quelle(q);
        }
        Wer wer = plattform(w.mandant);
        UUID ziel = w.box(antrag.get("box").asText());
        JsonNode pruefung = antrag.get("pruefung");
        boolean bestaetigt = antrag.get("vergleich_bestaetigt").asBoolean();
        String jetzt = in.get("jetzt").asText();
        int zeitraeumeVorher = anzahl(w, "data_source_assignment");

        UUID quelle;
        UUID anlage;
        if ("anlegen".equals(antrag.get("art").asText())) {
            // Die neue Quelle hängt in der Heimat-Anlage der Ziel-Box.
            anlage = w.anlage(referenzBox(antrag.get("box").asText()).get("heimat_anlage").asText());
            UHR.stelle(pruefung.isNull() ? jetzt : pruefung.get("zeitpunkt").asText());
            JsonNode k = antrag.get("kandidat");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("name", "Kandidat " + fall.get("name").asText());
            body.put("protokoll", k.get("protokoll").asText());
            body.put("adresse", k.get("adresse").asText());
            body.put("geraete_ids", ganzzahlen(k.get("geraete_ids")));
            body.put("netz", k.get("netz").isNull() ? null : k.get("netz").asText());
            body.put("mehrere_leser", k.get("mehrere_leser").asBoolean());
            body.put("kadenz_s", 60);
            body.put("device_id", ziel);
            body.put("vergleich_bestaetigt", bestaetigt);
            Antwort angelegt = ruf(wer, HttpMethod.POST, basis(anlage), body);
            if (angelegt.status() != 201) {
                // Abgelehnt, BEVOR ein Entwurf entsteht, den diese Box nie lesen dürfte.
                abgelehntWieDerFall(fall, angelegt);
                assertThat(anzahl(w, "data_source")).isEqualTo(in.get("quellen").size());
                assertThat(anzahl(w, "data_source_assignment")).isEqualTo(zeitraeumeVorher);
                return;
            }
            quelle = UUID.fromString(angelegt.body().get("id").asText());
        } else {
            quelle = w.quellen.get(antrag.get("quelle").asText());
            anlage = w.anlage(w.quelleAnlage.get(antrag.get("quelle").asText()));
        }

        if (!pruefung.isNull()) {
            UHR.stelle(pruefung.get("zeitpunkt").asText());
            UUID pruefBox = w.box(pruefung.get("box").asText());
            antwortet(pruefBox, pruefung.get("ergebnis").asText());
            Antwort geprueft = ruf(wer, HttpMethod.POST, basis(anlage) + "/" + quelle + "/reachability-check",
                    Map.of("device_id", pruefBox, "unit_id", 1, "register", 0));
            assertThat(geprueft.status()).as(geprueft.body().toString()).isEqualTo(200);
            assertThat(geprueft.body().get("ergebnis").asText()).isEqualTo(pruefung.get("ergebnis").asText());
            assertThat(geprueft.body().get("gewertet").asBoolean()).isTrue();
        }

        UHR.stelle(jetzt);
        Map<String, Object> zuweisen = new LinkedHashMap<>();
        zuweisen.put("device_id", ziel);
        zuweisen.put("effective_from", antrag.get("effective_from").asText());
        zuweisen.put("vergleich_bestaetigt", bestaetigt);
        Antwort a = ruf(wer, HttpMethod.POST, basis(anlage) + "/" + quelle + "/assignments", zuweisen);
        if ("erlaubt".equals(erwartet.get("urteil").asText())) {
            assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
            assertThat(a.body().get("urteil").asText()).isEqualTo("erlaubt");
            assertThat(a.body().get("text").asText()).isEqualTo(erwartet.get("text").asText());
            assertThat(textOderNull(a.body().get("hinweis"))).isEqualTo(textOderNull(erwartet.get("hinweis")));
            boolean vergleich = erwartet.get("vergleichsquelle").asBoolean();
            assertThat(a.body().get("vergleichsquelle").asBoolean()).isEqualTo(vergleich);
            assertThat(a.body().at("/datenquelle/vergleichsquelle").asBoolean())
                    .as("die Kennzeichnung ist gespeichert").isEqualTo(vergleich);
            assertThat(zeitraeume(a.body().at("/datenquelle/zeitraeume"), w))
                    .isEqualTo(zeitraeumeDesFalls(erwartet.get("zeitraeume")));
        } else {
            abgelehntWieDerFall(fall, a);
            assertThat(anzahl(w, "data_source_assignment")).as("nichts geschrieben").isEqualTo(zeitraeumeVorher);
        }
    }

    private static void abgelehntWieDerFall(JsonNode fall, Antwort a) {
        JsonNode e = fall.get("expected");
        String grund = e.get("grund").asText();
        assertThat(a.status()).as(a.body().toString()).isEqualTo(STATUS_JE_GRUND.get(grund));
        assertThat(a.body().get("code").asText()).isEqualTo(grund);
        assertThat(a.body().get("message").asText()).isEqualTo(e.get("text").asText());
        assertThat(a.body().get("urteil").asText()).isEqualTo(e.get("urteil").asText());
    }

    @Test
    void jederGrundDesVertragsHatGenauEinenStatus() {
        assertThat(Arrays.stream(Grund.values()).map(Grund::code).toList())
                .containsExactlyInAnyOrderElementsOf(STATUS_JE_GRUND.keySet());
        for (Grund g : Grund.values()) {
            assertThat(DatenquelleAbgelehnt.status(g)).as(g.code()).isEqualTo(STATUS_JE_GRUND.get(g.code()));
        }
    }

    @Test
    void a10Budget422TraegtRechnungUndZweiAuswegeUndLaesstDenBestandUnberuehrt() throws Exception {
        Welt w = new Welt("Ahrenberg A10");
        JsonNode ref = referenzQuelle("DQ-3");
        UUID dq3 = w.saeen("DQ-3", ref.get("anlage").asText(), ref.get("protokoll").asText(),
                adresseAusReferenz(ref), ganzzahlen(ref.get("geraete_ids")), ref.get("netz").asText(),
                false, ref.get("steuerquelle").asBoolean(), 10, List.of());
        UUID e1 = w.box("E-1");
        UUID e2 = w.box("E-2");
        UUID halle1 = w.anlage("AN-1");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        UHR.stelle("2026-10-01T00:00:00+02:00");
        antwortet(e1, "ok");
        assertThat(ruf(jonas, HttpMethod.POST, basis(halle1) + "/" + dq3 + "/reachability-check",
                Map.of("device_id", e1, "unit_id", 1, "register", 0)).status()).isEqualTo(200);

        var source = new com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate("DQ-3", "modbus_tcp", 8, 10,
                List.of(new com.voltpilot.api.measurement.MeasurementBudget.SourceRequest(4, 400)));
        var belegt = new com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate("Bestand", "modbus_tcp", 66, 60,
                List.of(new com.voltpilot.api.measurement.MeasurementBudget.SourceRequest(22, 400)));
        var e2Belegt = new com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate("Bestand E2", "modbus_tcp", 3, 60,
                List.of(new com.voltpilot.api.measurement.MeasurementBudget.SourceRequest(1, 400)));
        DatenquelleBudget.Ablehnung rechnung = DatenquelleBudget.pruefe("DQ-3", source, e1, List.of(
                new DatenquelleBudget.BoxStand(e1, "Box Halle 1", List.of(belegt)),
                new DatenquelleBudget.BoxStand(e2, "Box Halle 2", List.of(e2Belegt))));
        when(budgets.pruefe(eq(dq3), eq(e1), any(Instant.class))).thenReturn(rechnung);
        int quellenVorher = anzahl(w, "data_source");
        int zeitraeumeVorher = anzahl(w, "data_source_assignment");

        Antwort ab = ruf(jonas, HttpMethod.POST, basis(halle1) + "/" + dq3 + "/assignments",
                Map.of("device_id", e1));

        assertThat(ab.status()).as(ab.body().toString()).isEqualTo(422);
        assertThat(ab.body().get("code").asText()).isEqualTo("budget_ueberschritten");
        assertThat(ab.body().at("/rechnung/quelle/last/requests_per_minute").asDouble()).isEqualTo(24);
        assertThat(ab.body().at("/rechnung/quelle/takt_s").asInt()).isEqualTo(10);
        assertThat(ab.body().at("/rechnung/quelle/anfragen/0/anfragen_je_takt").asInt()).isEqualTo(4);
        assertThat(ab.body().at("/rechnung/quelle/anfragen/0/kosten_ms_je_anfrage").asInt()).isEqualTo(400);
        assertThat(ab.body().at("/rechnung/box_nachher/requests_per_minute").asDouble()).isEqualTo(46);
        assertThat(ab.body().at("/rechnung/auswege/takt_s").asInt()).isEqualTo(60);
        assertThat(ab.body().at("/rechnung/auswege/takt").asText()).isEqualTo("Takt 60 s wählen");
        assertThat(ab.body().at("/rechnung/auswege/andere_box").asText())
                .isEqualTo("Box Halle 2 wählen (29 Anfragen/min frei)");
        assertThat(anzahl(w, "data_source")).isEqualTo(quellenVorher);
        assertThat(anzahl(w, "data_source_assignment")).isEqualTo(zeitraeumeVorher);
    }

    // ============================================================ Anlegen (Lindach)

    /**
     * AP-06 §5 Neukunde: am 15.10.2026 legt Jonas (Kundenadministrator) die beiden Lindacher
     * Quellen an — sie bekommen DQ-6 und DQ-7, weil DQ-1 … DQ-5 im Kundenbereich schon vergeben
     * sind; prüft von Box Lindach, weist zu. Danach stehen genau die Zuständigkeiten der
     * Referenz in der Datenbank, und jeder Schritt steht mit Urheber im Protokoll.
     */
    @Test
    void anlegenVergibtDq6UndDq7UndSchreibtJedenSchrittMitUrheber() throws Exception {
        Instant stand = OffsetDateTime.parse("2026-10-15T00:00:00+02:00").toInstant();
        Welt w = new Welt("Ahrenberg Lindach");
        for (String kz : List.of("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5")) {
            w.quelleAusReferenz(kz, stand);
        }
        UUID lindach = w.anlage("AN-3");
        UUID boxLindach = w.box("E-3");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        UHR.stelle("2026-10-15T00:00:20+02:00");

        for (String kz : List.of("DQ-6", "DQ-7")) {
            JsonNode ref = referenzQuelle(kz);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("name", ref.get("hinweis").asText());
            body.put("protokoll", "modbus_tcp");
            body.put("adresse", " " + ref.get("adresse").asText() + " ");   // ohne Port, mit Leerzeichen
            body.put("geraete_ids", ganzzahlen(ref.get("geraete_ids")));
            body.put("netz", ref.get("netz").asText());
            body.put("kadenz_s", ref.get("kadenz_s").asInt());
            body.put("device_id", boxLindach);
            Antwort angelegt = ruf(jonas, HttpMethod.POST, basis(lindach), body);
            assertThat(angelegt.status()).as(angelegt.body().toString()).isEqualTo(201);
            JsonNode q = angelegt.body();
            assertThat(q.get("kennzeichen").asText()).isEqualTo(kz);
            assertThat(q.get("adresse").asText()).as("normalisiert").isEqualTo(adresseAusReferenz(ref));
            assertThat(q.get("anlage").asText()).isEqualTo(lindach.toString());
            assertThat(q.get("zustaendige_box").isNull()).as("Entwurf: noch liest keine Box").isTrue();
            assertThat(q.get("zeitraeume")).isEmpty();
            UUID id = UUID.fromString(q.get("id").asText());

            antwortet(boxLindach, "ok");
            Antwort geprueft = ruf(jonas, HttpMethod.POST, basis(lindach) + "/" + id + "/reachability-check",
                    Map.of("device_id", boxLindach, "unit_id", 1, "register", 0));
            assertThat(geprueft.status()).isEqualTo(200);
            assertThat(geprueft.body().get("text").asText())
                    .isEqualTo("Box Lindach erreicht " + adresseAusReferenz(ref));

            Antwort zugewiesen = ruf(jonas, HttpMethod.POST, basis(lindach) + "/" + id + "/assignments",
                    Map.of("device_id", boxLindach));
            assertThat(zugewiesen.status()).as(zugewiesen.body().toString()).isEqualTo(201);
            // „jetzt“ = 00:00:20 → auf die Minute abgerundet: genau der Beginn der Referenz.
            assertThat(zugewiesen.body().get("text").asText()).isEqualTo("Ab 15.10.2026 00:00 liest Box Lindach");
            assertThat(zeitraeume(zugewiesen.body().at("/datenquelle/zeitraeume"), w))
                    .isEqualTo(referenzZeitraeume(kz, null));
            assertThat(zugewiesen.body().at("/datenquelle/zustaendige_box/name").asText()).isEqualTo("Box Lindach");
        }

        JsonNode liste = ruf(jonas, HttpMethod.GET, basis(lindach), null).body();
        assertThat(liste.get("datenquellen")).extracting(q -> q.get("kennzeichen").asText())
                .containsExactly("DQ-6", "DQ-7");

        UUID dq6 = UUID.fromString(liste.at("/datenquellen/0/id").asText());
        JsonNode protokoll = ruf(jonas, HttpMethod.GET, basis(lindach) + "/" + dq6 + "/history", null).body();
        assertThat(protokoll.get("eintraege")).extracting(e -> e.get("art").asText())
                .containsExactly("zustaendigkeit_begonnen", "erreichbarkeit_geprueft", "angelegt");
        for (JsonNode e : protokoll.get("eintraege")) {
            assertThat(e.get("urheber")).isEqualTo(MAPPER.readTree(
                    "{\"name\":\"Jonas Wendlinger\",\"rolle\":\"kundenadministrator\",\"art\":\"kunde\"}"));
        }
        JsonNode begonnen = protokoll.at("/eintraege/0");
        assertThat(begonnen.at("/box/name").asText()).isEqualTo("Box Lindach");
        assertThat(begonnen.get("alt").isNull()).isTrue();
        assertThat(begonnen.at("/neu/ab").asText()).isEqualTo("2026-10-14T22:00:00Z");
        assertThat(Instant.parse(begonnen.get("gilt_ab").asText())).isEqualTo(Instant.parse("2026-10-14T22:00:00Z"));
        assertThat(protokoll.at("/eintraege/1/ergebnis").asText()).isEqualTo("ok");
        assertThat(protokoll.at("/eintraege/2/neu/kennzeichen").asText()).isEqualTo("DQ-6");
    }

    // ============================================================ A3 · A11 · A13

    /**
     * A3 mit A11 davor: am 09.04.2027 09:00 scheitert die Prüfung von Box Halle 2 (neu) — der
     * Wechsel wird nicht angelegt, DQ-3 bleibt ohne Unterbrechung bei Box Halle 1; nach der Route
     * besteht sie, der Wechsel für den 10.04.2027 07:30 wird geplant und am 10.04. der Rückweg
     * für den 12.04.2027 16:00. Danach stehen genau die drei Zeiträume der Referenz in der
     * Datenbank, und das Protokoll der Quelle trägt beide Wechsel.
     */
    @Test
    void a7EdgeWechselLaesstMessstellenGebundenUndTraegtDieBoxJeMesszeit() throws Exception {
        Welt w = new Welt("Ahrenberg A3");
        UUID dq3 = w.quelleAusReferenz("DQ-3", OffsetDateTime.parse("2027-04-09T09:00:00+02:00").toInstant());
        UUID halle1 = w.anlage("AN-1");
        UUID e1 = w.box("E-1");
        UUID e2neu = w.box("E-2′");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        String pfad = basis(halle1) + "/" + dq3;

        // A7 beginnt mit vier Messstellen an DQ-3. Der Box-Wechsel darf weder diese Bindungen
        // anfassen noch einen Messstellen-Eintrag erzeugen. Die Writer-Abnahme
        // WriterPipeTest#derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel beweist separat, dass
        // der Writer dieselbe Zuständigkeit zur Messzeit nachschlägt; hier läuft ihre echte
        // AP-06-Schreibroute und die gemeinsame Datenbankform zusammen.
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, control, communication, connection_json, created_at) VALUES "
                + "(?, ?, 'modbus-generic', 'DQ-3 Zähler', 'modbus-generic', ?, false, true, '{}'::jsonb, now()) "
                + "RETURNING id", UUID.class, w.mandant, halle1, e1);
        // Der Bestands-Trigger leitet aus der Komponente bereits Gerät und Speisung ab; A7 hängt
        // nur die vorhandene DQ-3 daran, statt einen zweiten Geräteweg zu erfinden.
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE tenant_id = ? "
                + "AND entity_id = ? AND gueltig_bis IS NULL", UUID.class, w.mandant, komponente);
        root.update("UPDATE geraet SET data_source_id = ?, geraete_id = 1 WHERE id = ?", dq3, geraet);
        for (int n = 5; n <= 8; n++) {
            UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, "
                    + "medium, groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', "
                    + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class,
                    w.mandant, "MS-0" + n, "Messstelle " + n);
            root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                    + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, "
                    + "eingetragen_am, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, "
                    + "'counter', 'zaehlerstand', 'fuehrend', '2024-03-12T00:00:00Z', true, "
                    + "'2027-04-09T07:00:00Z', 'Bestandsübernahme', 'voltpilot')",
                    w.mandant, messstelle, komponente, geraet, "energy_kwh_ms0" + n);
        }
        List<Map<String, Object>> bindungenVorher = root.queryForList("SELECT id, messstelle_id, entity_id, "
                + "geraet_id, kanal, gueltig_ab, gueltig_bis FROM messstelle_quelle WHERE tenant_id = ? "
                + "ORDER BY messstelle_id", w.mandant);
        assertThat(bindungenVorher).hasSize(4);
        assertThat(anzahl(w, "messstelle_aenderung")).isZero();

        // A11: vor der Route.
        UHR.stelle("2027-04-09T09:00:00+02:00");
        antwortet(e2neu, "unreachable");
        Antwort gescheitert = ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1, "register", 0));
        assertThat(gescheitert.status()).isEqualTo(200);
        assertThat(gescheitert.body().get("gewertet").asBoolean()).isTrue();
        assertThat(gescheitert.body().get("text").asText())
                .isEqualTo("Box Halle 2 (neu) erreicht 192.168.10.31:502 nicht — Netz/VLAN prüfen (Bogen D1/D2)");
        Antwort abgelehnt = ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e2neu, "effective_from", "2027-04-10T07:30:00+02:00"));
        assertThat(abgelehnt.status()).isEqualTo(409);
        assertThat(abgelehnt.body().get("code").asText()).isEqualTo("pruefung_gescheitert");
        assertThat(ruf(jonas, HttpMethod.GET, pfad, null).body().at("/zustaendige_box/name").asText())
                .isEqualTo("Box Halle 1");

        // Die Route ist freigegeben: die Prüfung besteht, der Wechsel wird geplant.
        UHR.stelle("2027-04-09T15:10:00+02:00");
        antwortet(e2neu, "ok");
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1, "register", 0)).status()).isEqualTo(200);
        Antwort hin = ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e2neu, "effective_from", "2027-04-10T07:30:00+02:00"));
        assertThat(hin.status()).as(hin.body().toString()).isEqualTo(201);
        assertThat(hin.body().get("text").asText()).isEqualTo("Ab 10.04.2027 07:30 liest Box Halle 2 (neu)");
        assertThat(hin.body().at("/datenquelle/zustaendige_box/name").asText())
                .as("geplant: bis 07:30 liest weiter Box Halle 1").isEqualTo("Box Halle 1");

        // Am 10.04. um 07:45 der Rückweg für den 12.04. 16:00 — geprüft von Box Halle 1.
        UHR.stelle("2027-04-10T07:45:00+02:00");
        antwortet(e1, "ok");
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e1, "unit_id", 1, "register", 0)).status()).isEqualTo(200);
        Antwort zurueck = ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e1, "effective_from", "2027-04-12T16:00:00+02:00"));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(201);
        assertThat(zurueck.body().get("text").asText()).isEqualTo("Ab 12.04.2027 16:00 liest Box Halle 1");
        assertThat(zurueck.body().at("/datenquelle/zustaendige_box/name").asText()).isEqualTo("Box Halle 2 (neu)");

        // Genau die Zuständigkeiten der Referenz — beendet und neu begonnen, nie überschrieben.
        assertThat(zeitraeume(zurueck.body().at("/datenquelle/zeitraeume"), w))
                .isEqualTo(referenzZeitraeume("DQ-3", null));
        assertThat(anzahl(w, "data_source_assignment")).isEqualTo(3);

        JsonNode eintraege = ruf(jonas, HttpMethod.GET, pfad + "/history", null).body().get("eintraege");
        assertThat(eintraege).extracting(e -> e.get("art").asText()).containsExactly(
                "zustaendigkeit_gewechselt", "erreichbarkeit_geprueft", "zustaendigkeit_gewechselt",
                "erreichbarkeit_geprueft", "erreichbarkeit_geprueft");
        assertThat(eintraege).extracting(e -> textOderNull(e.get("ergebnis")))
                .containsExactly(null, "ok", null, "ok", "unreachable");
        JsonNode zweiter = eintraege.get(0);
        assertThat(zweiter.at("/alt/box_name").asText()).isEqualTo("Box Halle 2 (neu)");
        assertThat(zweiter.at("/neu/box_name").asText()).isEqualTo("Box Halle 1");
        assertThat(Instant.parse(zweiter.get("gilt_ab").asText()))
                .isEqualTo(OffsetDateTime.parse("2027-04-12T16:00:00+02:00").toInstant());
        JsonNode erster = eintraege.get(2);
        assertThat(erster.at("/alt/box_name").asText()).isEqualTo("Box Halle 1");
        assertThat(erster.at("/neu/box_name").asText()).isEqualTo("Box Halle 2 (neu)");
        assertThat(erster.at("/neu/ab").asText()).isEqualTo("2027-04-10T05:30:00Z");

        assertThat(root.queryForList("SELECT id, messstelle_id, entity_id, geraet_id, kanal, gueltig_ab, "
                + "gueltig_bis FROM messstelle_quelle WHERE tenant_id = ? ORDER BY messstelle_id", w.mandant))
                .as("A7: alle vier Quellenbindungen bleiben bytegleich").isEqualTo(bindungenVorher);
        assertThat(anzahl(w, "messstelle_aenderung"))
                .as("A7: ein Box-Wechsel ist kein Ereignis der Messstelle").isZero();

        Instant vorWechsel = OffsetDateTime.parse("2027-04-10T07:29:00+02:00").toInstant();
        Instant nachWechsel = OffsetDateTime.parse("2027-04-10T07:31:00+02:00").toInstant();
        UUID boxVorher = zustaendigeBox(dq3, vorWechsel);
        UUID boxNachher = zustaendigeBox(dq3, nachWechsel);
        assertThat(boxVorher).isEqualTo(e1);
        assertThat(boxNachher).isEqualTo(e2neu);
        for (Object[] wert : List.of(
                new Object[] {vorWechsel, boxVorher, 1001L, 312400.0},
                new Object[] {nachWechsel, boxNachher, 1002L, 312401.0})) {
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind, entity_id, applied_revision, value_kind, role, delivery, delay_s, "
                    + "device_install_id) VALUES (?, ?, ?, ?, ?, 'energy_kwh_ms05', ?, ?, 'good', '2026.09.11.1', ?, "
                    + "'counter', ?, 1, 'counter', 'fuehrend', 'direkt', 0, ?)",
                    java.sql.Timestamp.from((Instant) wert[0]), java.sql.Timestamp.from((Instant) wert[0]),
                    w.mandant, halle1, wert[1], wert[3], wert[3], wert[2], komponente, geraet);
        }
        assertThat(root.queryForList("SELECT s.time, d.name AS box FROM device_measurement_sample s "
                + "JOIN device d ON d.id = s.device_id WHERE s.tenant_id = ? AND s.entity_id = ? "
                + "ORDER BY s.time", w.mandant, komponente))
                .extracting(z -> z.get("box"))
                .as("A7: eine box-unabhängige Reihe, Herkunft je Wert aus der Zuständigkeit zur Messzeit")
                .containsExactly("Box Halle 1", "Box Halle 2 (neu)");
    }

    private static UUID zustaendigeBox(UUID datenquelle, Instant messzeit) {
        return root.queryForObject("SELECT device_id FROM data_source_assignment WHERE data_source_id = ? "
                + "AND effective_from <= ? AND (effective_to IS NULL OR ? < effective_to)", UUID.class,
                datenquelle, java.sql.Timestamp.from(messzeit), java.sql.Timestamp.from(messzeit));
    }

    /**
     * Benannte Lücke des Vertrags: ein Wechsel GENAU zum Beginn eines geplanten Zeitraums ist für
     * {@code pruefeAntrag} kein „späterer Wechsel“ (nicht davor) und kein „schon zuständig“ (eine
     * andere Box) — erlaubt ließe er den geplanten Zeitraum LEER zurück. Die Speicher-Regel des
     * Vertrags ({@code pruefeZeitraum}) lehnt ihn ab, bevor die Datenbank es muss; die Rücknahme
     * eines geplanten Wechsels ist IP-12.
     */
    @Test
    void einWechselGenauZumBeginnDesGeplantenLaesstKeinenLeerenZeitraumZurueck() throws Exception {
        Welt w = new Welt("Ahrenberg Lücke");
        UUID dq3 = w.quelleAusReferenz("DQ-3", OffsetDateTime.parse("2027-04-09T09:00:00+02:00").toInstant());
        UUID halle1 = w.anlage("AN-1");
        UUID e1 = w.box("E-1");
        UUID e2neu = w.box("E-2′");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        String pfad = basis(halle1) + "/" + dq3;
        UHR.stelle("2027-04-09T15:10:00+02:00");
        antwortet(e2neu, "ok");
        ruf(jonas, HttpMethod.POST, pfad + "/reachability-check", Map.of("device_id", e2neu, "unit_id", 1, "register", 0));
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e2neu, "effective_from", "2027-04-10T07:30:00+02:00")).status()).isEqualTo(201);

        antwortet(e1, "ok");
        ruf(jonas, HttpMethod.POST, pfad + "/reachability-check", Map.of("device_id", e1, "unit_id", 1, "register", 0));
        Antwort a = ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e1, "effective_from", "2027-04-10T07:30:00+02:00"));

        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().get("code").asText()).isEqualTo("leerer_zeitraum");
        assertThat(a.body().get("message").asText()).isEqualTo(Grund.LEERER_ZEITRAUM.text());
        assertThat(anzahl(w, "data_source_assignment")).isEqualTo(2);
    }

    /**
     * A13: DQ-1 trägt die steuernde Komponente von AN-1 — ihr Wechsel zu Box Halle 2 (neu) wird
     * mit dem Grund {@code steuerquelle} abgelehnt, auch mit bestandener Prüfung; nichts ist
     * geschrieben. Und der Umweg über das Formular ist zu: die Steuerquelle lässt sich nach der
     * ersten Box nicht abschalten.
     */
    @Test
    void a13DieSteuerquelleWechseltNicht409MitGrund() throws Exception {
        Welt w = new Welt("Ahrenberg A13");
        UUID dq1 = w.quelleAusReferenz("DQ-1", OffsetDateTime.parse("2027-04-20T10:00:00+02:00").toInstant());
        UUID halle1 = w.anlage("AN-1");
        UUID e2neu = w.box("E-2′");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        String pfad = basis(halle1) + "/" + dq1;

        UHR.stelle("2027-04-20T09:55:00+02:00");
        antwortet(e2neu, "ok");
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1, "register", 0)).status()).isEqualTo(200);
        UHR.stelle("2027-04-20T10:00:00+02:00");
        Antwort a = ruf(jonas, HttpMethod.POST, pfad + "/assignments", Map.of("device_id", e2neu));

        assertThat(a.status()).isEqualTo(409);
        assertThat(a.body().get("code").asText()).isEqualTo("steuerquelle");
        assertThat(a.body().get("urteil").asText()).isEqualTo("abgelehnt");
        assertThat(a.body().get("message").asText())
                .isEqualTo("Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln");
        assertThat(zeitraeume(ruf(jonas, HttpMethod.GET, pfad, null).body().get("zeitraeume"), w))
                .isEqualTo(referenzZeitraeume("DQ-1", null));
        JsonNode eintraege = ruf(jonas, HttpMethod.GET, pfad + "/history", null).body().get("eintraege");
        assertThat(eintraege).extracting(e -> e.get("art").asText()).containsExactly("erreichbarkeit_geprueft");

        JsonNode q = ruf(jonas, HttpMethod.GET, pfad, null).body();
        Map<String, Object> ohneSteuerquelle = bearbeitung(q);
        ohneSteuerquelle.put("name", "Wechselrichter K-1 mit Speicher");
        ohneSteuerquelle.put("steuerquelle", false);
        Antwort umweg = ruf(jonas, HttpMethod.PUT, pfad, ohneSteuerquelle);
        assertThat(umweg.status()).isEqualTo(409);
        assertThat(umweg.body().get("code").asText()).isEqualTo("weg_fest");
        assertThat(umweg.body().get("felder")).extracting(JsonNode::asText).containsExactly("steuerquelle");
    }

    // ============================================================ Prüfung

    /**
     * Die Prüfung geht an GENAU die gewählte Box — hier Box Halle 2 (neu) mit Heimat AN-2 für
     * eine Quelle aus AN-1 (E7) — und liest die Adresse der QUELLE; ein Host aus der Anfrage wird
     * nicht angenommen. Schweigt die Box, zählt nichts und nichts steht im Protokoll.
     */
    @Test
    void diePruefungGehtAnGenauDieGewaehlteBoxMitDerAdresseDerQuelle() throws Exception {
        Welt w = new Welt("Ahrenberg Prüfung");
        UUID dq3 = w.quelleAusReferenz("DQ-3", OffsetDateTime.parse("2027-04-09T09:00:00+02:00").toInstant());
        UUID halle1 = w.anlage("AN-1");
        UUID e2neu = w.box("E-2′");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        String pfad = basis(halle1) + "/" + dq3;
        UHR.stelle("2027-04-09T09:00:00+02:00");

        when(probes.probeBox(eq(e2neu), anyList(), any())).thenReturn(Optional.empty());
        Antwort still = ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 3, "register", 30775, "data_type", "s32"));
        assertThat(still.status()).isEqualTo(200);
        assertThat(still.body().get("ergebnis").asText()).isEqualTo("box_meldet_sich_nicht");
        assertThat(still.body().get("gewertet").asBoolean()).isFalse();
        assertThat(still.body().get("text").asText()).isEqualTo("Box Halle 2 (neu) meldet sich nicht");
        assertThat(still.body().get("antwort").isNull()).isTrue();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<ProbeRequest.Op>> schritte = ArgumentCaptor.forClass(List.class);
        verify(probes).probeBox(eq(e2neu), schritte.capture(), eq("sub-jonas-wendlinger"));
        assertThat(schritte.getValue()).containsExactly(new ProbeRequest.Op("erreichbarkeit",
                "192.168.10.31", 502, 3, "holding", 30775, "s32", null, null, null));
        assertThat(ruf(jonas, HttpMethod.GET, pfad + "/history", null).body().get("eintraege")).isEmpty();
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e2neu, "effective_from", "2027-04-10T07:30:00+02:00")).body().get("code").asText())
                .isEqualTo("pruefung_fehlt");

        clearInvocations(probes);
        Antwort mitHost = ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1, "register", 0, "host", "192.168.20.10"));
        assertThat(mitHost.status()).isEqualTo(400);
        assertThat(mitHost.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(mitHost.body().get("feld").asText()).isEqualTo("host");
        Antwort ohneRegister = ruf(jonas, HttpMethod.POST, pfad + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1));
        assertThat(ohneRegister.body().get("feld").asText()).isEqualTo("register");
        verify(probes, never()).probeBox(any(), anyList(), any());

        // Für eine OCPP-Station kennt der Prüf-Kanal keinen Lese-Schritt — benannt, nie geraten.
        UUID dq5 = w.quelleAusReferenz("DQ-5", OffsetDateTime.parse("2027-04-09T09:00:00+02:00").toInstant());
        Antwort ocpp = ruf(jonas, HttpMethod.POST, basis(w.anlage("AN-2")) + "/" + dq5 + "/reachability-check",
                Map.of("device_id", e2neu, "unit_id", 1, "register", 0));
        assertThat(ocpp.status()).isEqualTo(422);
        assertThat(ocpp.body().get("code").asText()).isEqualTo("pruefung_nicht_moeglich");
    }

    // ============================================================ Bearbeiten · Urheber

    /**
     * Bearbeiten schreibt nur, was sich ändert, mit Urheber — der Kunde als Kundenadministrator,
     * der Plattform-Admin (Mandanten-Umschalter) als VoltPilot. Die Adresse ändert sich im
     * Entwurf; nach der ersten Box bleibt der Weg ({@code weg_fest}), Name und Netz nicht.
     */
    @Test
    void bearbeitenSchreibtNurDasGeaenderteMitUrheberUndDerWegBleibtNachDerErstenBox() throws Exception {
        Welt w = new Welt("Ahrenberg Bearbeiten");
        UUID halle2 = w.anlage("AN-2");
        UUID e2neu = w.box("E-2′");
        Wer jonas = kunde(w.mandant, "Jonas Wendlinger");
        Wer betrieb = plattform(w.mandant);
        UHR.stelle("2027-05-03T08:00:00+02:00");

        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("name", "Multi-Zähler-Gateway UV Halle 2");
        neu.put("protokoll", "modbus_tcp");
        neu.put("adresse", "192.168.20.41:502");
        neu.put("geraete_ids", List.of(2, 1));
        neu.put("netz", "VLAN 20 „Produktion“ 192.168.20.0/24");
        neu.put("kadenz_s", 60);
        JsonNode q = ruf(jonas, HttpMethod.POST, basis(halle2), neu).body();
        assertThat(q.get("geraete_ids")).extracting(JsonNode::asInt).containsExactly(1, 2);
        String pfad = basis(halle2) + "/" + q.get("id").asText();

        // Im Entwurf darf der Weg sich ändern (ein Tippfehler in der Adresse).
        Map<String, Object> korrigiert = bearbeitung(q);
        korrigiert.put("adresse", "192.168.20.42");
        Antwort k = ruf(betrieb, HttpMethod.PUT, pfad, korrigiert);
        assertThat(k.status()).as(k.body().toString()).isEqualTo(200);
        assertThat(k.body().get("adresse").asText()).isEqualTo("192.168.20.42:502");

        antwortet(e2neu, "ok");
        ruf(jonas, HttpMethod.POST, pfad + "/reachability-check", Map.of("device_id", e2neu, "unit_id", 1, "register", 0));
        assertThat(ruf(jonas, HttpMethod.POST, pfad + "/assignments", Map.of("device_id", e2neu)).status()).isEqualTo(201);

        Map<String, Object> andereAdresse = bearbeitung(k.body());
        andereAdresse.put("adresse", "192.168.20.43:502");
        Antwort fest = ruf(jonas, HttpMethod.PUT, pfad, andereAdresse);
        assertThat(fest.status()).isEqualTo(409);
        assertThat(fest.body().get("code").asText()).isEqualTo("weg_fest");
        assertThat(fest.body().get("felder")).extracting(JsonNode::asText).containsExactly("adresse");

        Map<String, Object> umbenannt = bearbeitung(k.body());
        umbenannt.put("name", "Gateway UV Halle 2");
        umbenannt.put("netz", "VLAN 20 „Produktion“ 192.168.20.0/24 (Route zu VLAN 10)");
        assertThat(ruf(jonas, HttpMethod.PUT, pfad, umbenannt).status()).isEqualTo(200);
        // Dieselbe Darstellung noch einmal: nichts ändert sich, nichts wird protokolliert.
        assertThat(ruf(jonas, HttpMethod.PUT, pfad, umbenannt).status()).isEqualTo(200);

        JsonNode eintraege = ruf(jonas, HttpMethod.GET, pfad + "/history", null).body().get("eintraege");
        assertThat(eintraege).extracting(e -> e.get("art").asText()).containsExactly("bearbeitet",
                "zustaendigkeit_begonnen", "erreichbarkeit_geprueft", "bearbeitet", "angelegt");
        JsonNode umbenennung = eintraege.get(0);
        assertThat(umbenennung.get("alt")).isEqualTo(MAPPER.readTree("{\"name\":\"Multi-Zähler-Gateway UV Halle 2\","
                + "\"netz\":\"VLAN 20 „Produktion“ 192.168.20.0/24\"}"));
        assertThat(umbenennung.get("urheber")).isEqualTo(MAPPER.readTree(
                "{\"name\":\"Jonas Wendlinger\",\"rolle\":\"kundenadministrator\",\"art\":\"kunde\"}"));
        JsonNode korrektur = eintraege.get(3);
        assertThat(korrektur.get("neu")).isEqualTo(MAPPER.readTree("{\"adresse\":\"192.168.20.42:502\"}"));
        assertThat(korrektur.get("urheber")).isEqualTo(MAPPER.readTree(
                "{\"name\":\"admin\",\"rolle\":\"voltpilot_betrieb\",\"art\":\"voltpilot\"}"));

        Antwort fremdesFeld = ruf(jonas, HttpMethod.POST, pfad + "/assignments",
                Map.of("device_id", e2neu, "pruefung", Map.of("ergebnis", "ok")));
        assertThat(fremdesFeld.status()).isEqualTo(400);
        assertThat(fremdesFeld.body().get("feld").asText()).isEqualTo("pruefung");
    }

    // ============================================================ Zaun

    /** Eine fremde Anlage, Quelle oder Box ist 404 — nie 403, und nie wird eine Box gefragt. */
    @Test
    void einFremderKundenbereichSiehtNichtsUndErreichtKeineBox() throws Exception {
        Welt a = new Welt("Ahrenberg Zaun");
        UUID dq3 = a.quelleAusReferenz("DQ-3", OffsetDateTime.parse("2027-04-09T09:00:00+02:00").toInstant());
        UUID halle1 = a.anlage("AN-1");
        UUID e1 = a.box("E-1");
        Welt b = new Welt("Kundenbereich B");
        UUID anlageB = b.anlage("AN-2");
        UUID boxB = b.box("E-2′");
        Wer kundeB = kunde(b.mandant, "Kunde B");
        Wer jonas = kunde(a.mandant, "Jonas Wendlinger");
        UHR.stelle("2027-04-09T09:00:00+02:00");
        antwortet(e1, "ok");
        antwortet(boxB, "ok");

        for (Antwort r : List.of(
                ruf(kundeB, HttpMethod.GET, basis(halle1), null),
                ruf(kundeB, HttpMethod.GET, basis(halle1) + "/" + dq3, null),
                ruf(kundeB, HttpMethod.GET, basis(anlageB) + "/" + dq3, null),
                ruf(kundeB, HttpMethod.GET, basis(anlageB) + "/" + dq3 + "/history", null),
                ruf(kundeB, HttpMethod.PUT, basis(anlageB) + "/" + dq3, Map.of("name", "x", "protokoll",
                        "modbus_tcp", "adresse", "192.168.10.31:502", "kadenz_s", 60)),
                ruf(kundeB, HttpMethod.POST, basis(anlageB) + "/" + dq3 + "/reachability-check",
                        Map.of("device_id", boxB, "unit_id", 1, "register", 0)),
                ruf(kundeB, HttpMethod.POST, basis(anlageB) + "/" + dq3 + "/assignments", Map.of("device_id", boxB)),
                ruf(kundeB, HttpMethod.POST, basis(halle1), Map.of("name", "x", "protokoll", "modbus_tcp",
                        "adresse", "192.168.10.99", "kadenz_s", 60)),
                // Die eigene Quelle an einer FREMDEN Box: die Box ist nicht da.
                ruf(jonas, HttpMethod.POST, basis(halle1) + "/" + dq3 + "/reachability-check",
                        Map.of("device_id", boxB, "unit_id", 1, "register", 0)),
                ruf(jonas, HttpMethod.POST, basis(halle1) + "/" + dq3 + "/assignments", Map.of("device_id", boxB)),
                ruf(jonas, HttpMethod.POST, basis(halle1), Map.of("name", "x", "protokoll", "modbus_tcp",
                        "adresse", "192.168.10.99", "kadenz_s", 60, "device_id", boxB)))) {
            assertThat(r.status()).as(r.body().toString()).isEqualTo(404);
        }
        verify(probes, never()).probeBox(any(), anyList(), any());
        assertThat(anzahl(a, "data_source")).isEqualTo(1);
        assertThat(anzahl(a, "data_source_aenderung")).isZero();
    }

    /** Das Protokoll ist append-only und hinter dem Zaun — an der Datenbankgrenze, nicht per Konvention. */
    @Test
    void dasProtokollIstAppendOnlyUndHinterDemZaun() throws Exception {
        Welt w = new Welt("Ahrenberg Protokoll");
        UUID halle2 = w.anlage("AN-2");
        UHR.stelle("2027-05-03T08:00:00+02:00");
        JsonNode q = ruf(kunde(w.mandant, "Jonas Wendlinger"), HttpMethod.POST, basis(halle2), Map.of("name",
                "Netzzähler Halle 2", "protokoll", "modbus_tcp", "adresse", "192.168.20.30", "kadenz_s", 10)).body();
        UUID quelle = UUID.fromString(q.get("id").asText());

        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'data_source_aenderung'", Boolean.class)).isTrue();
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(
                new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
        TenantContext.set(w.mandant);
        assertThat(app.queryForObject("SELECT count(*) FROM data_source_aenderung WHERE data_source_id = ?",
                Integer.class, quelle)).isEqualTo(1);
        assertThatThrownBy(() -> app.update("UPDATE data_source_aenderung SET actor_name = 'x'"))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> app.update("DELETE FROM data_source_aenderung"))
                .rootCause().hasMessageContaining("permission denied");
        TenantContext.set(UUID.randomUUID());
        assertThat(app.queryForObject("SELECT count(*) FROM data_source_aenderung", Integer.class)).isZero();
        TenantContext.clear();
        assertThatThrownBy(() -> root.update("DELETE FROM data_source_aenderung WHERE data_source_id = ?", quelle))
                .rootCause().hasMessageContaining("audit rows are append-only");
    }

    // ============================================================ Gerüst

    /** Wer ruft: Kunde (Mandant im Token) oder Plattform-Admin mit gewähltem Kundenbereich. */
    private record Wer(String sub, String name, boolean plattform, UUID kundenbereich) {}

    private static Wer kunde(UUID kundenbereich, String name) {
        return new Wer("sub-" + name.toLowerCase().replace(' ', '-'), name, false, kundenbereich);
    }

    private static Wer plattform(UUID kundenbereich) {
        return new Wer("sub-admin", "admin", true, kundenbereich);
    }

    private record Antwort(int status, JsonNode body) {}

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    if (wer.plattform()) {
                        j.claim("preferred_username", wer.name());
                    } else {
                        j.claim("name", wer.name());
                        j.claim("tenant_id", wer.kundenbereich().toString());
                    }
                }).authorities(wer.plattform()
                        ? List.of(new SimpleGrantedAuthority("ROLE_platform-admin")) : List.of()))
                .contentType(MediaType.APPLICATION_JSON);
        if (wer.plattform()) {
            anfrage.header("X-Tenant-Id", wer.kundenbereich().toString());
        }
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    private static String basis(UUID anlage) {
        return "/api/v1/sites/" + anlage + "/data-sources";
    }

    /** Die Box antwortet auf den Lese-Schritt mit „ok“ oder einer Fehlerklasse. */
    private void antwortet(UUID box, String ergebnis) {
        OpResult zeile = "ok".equals(ergebnis)
                ? new OpResult("erreichbarkeit", true, 1.0, List.of(1), 1.0, null, null)
                : new OpResult("erreichbarkeit", false, null, null, null, ergebnis, "Satz der Box");
        when(probes.probeBox(eq(box), anyList(), any()))
                .thenReturn(Optional.of(new ProbeResult("a1b2c3d4e5f60718", null, null, List.of(zeile))));
    }

    /** Die volle Darstellung der bearbeitbaren Felder aus einer Antwort. */
    private static Map<String, Object> bearbeitung(JsonNode q) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", textOderNull(q.get("name")));
        m.put("protokoll", q.get("protokoll").asText());
        m.put("adresse", q.get("adresse").asText());
        m.put("geraete_ids", ganzzahlen(q.get("geraete_ids")));
        m.put("netz", textOderNull(q.get("netz")));
        m.put("mehrere_leser", q.get("mehrere_leser").asBoolean());
        m.put("steuerquelle", q.get("steuerquelle").asBoolean());
        m.put("kadenz_s", q.get("kadenz_s").asInt());
        return m;
    }

    /** Zeiträume einer Antwort als „Box · ab · bis“ mit den Kennzeichen der Referenz. */
    private static List<String> zeitraeume(JsonNode zs, Welt w) {
        List<String> r = new ArrayList<>();
        for (JsonNode z : zs) {
            r.add(zeile(w.boxKennzeichen.get(UUID.fromString(z.at("/box/id").asText())),
                    Instant.parse(z.get("effective_from").asText()),
                    z.get("effective_to").isNull() ? null : Instant.parse(z.get("effective_to").asText())));
        }
        return r;
    }

    private static List<String> zeitraeumeDesFalls(JsonNode zs) {
        List<String> r = new ArrayList<>();
        for (JsonNode z : zs) {
            r.add(zeile(z.get("box").asText(), OffsetDateTime.parse(z.get("effective_from").asText()).toInstant(),
                    z.get("effective_to").isNull() ? null
                            : OffsetDateTime.parse(z.get("effective_to").asText()).toInstant()));
        }
        return r;
    }

    /** Die Zuständigkeiten einer Quelle laut Referenz; {@code stand}: nur, was bis dahin begonnen hat. */
    private static List<String> referenzZeitraeume(String kz, Instant stand) {
        List<String> r = new ArrayList<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if (!"datenquelle_box".equals(z.get("art").asText()) || !kz.equals(z.get("von").asText())) {
                continue;
            }
            Instant ab = OffsetDateTime.parse(z.get("gueltig_ab").asText()).toInstant();
            Instant bis = z.get("gueltig_bis").isNull() ? null
                    : OffsetDateTime.parse(z.get("gueltig_bis").asText()).toInstant();
            if (stand != null && !ab.isBefore(stand)) {
                continue;
            }
            // Ein Ende, das zum Stand noch nicht eingetreten war, schrieb erst der spätere Wechsel.
            r.add(zeile(z.get("nach").asText(), ab, stand != null && bis != null && bis.isAfter(stand) ? null : bis));
        }
        return r;
    }

    private static String zeile(String box, Instant ab, Instant bis) {
        return box + " · " + ab + " · " + bis;
    }

    private static String textOderNull(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<Integer> ganzzahlen(JsonNode a) {
        List<Integer> r = new ArrayList<>();
        a.forEach(n -> r.add(n.asInt()));
        return r;
    }

    private static int anzahl(Welt w, String tabelle) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Integer.class, w.mandant);
    }

    private static JsonNode referenzBox(String kz) {
        return eines(referenz.get("boxen"), kz);
    }

    private static JsonNode referenzQuelle(String kz) {
        return eines(referenz.get("datenquellen"), kz);
    }

    private static JsonNode eines(JsonNode liste, String kz) {
        for (JsonNode n : liste) {
            if (kz.equals(n.get("kennzeichen").asText())) {
                return n;
            }
        }
        throw new AssertionError(kz + " steht nicht im Referenzunternehmen");
    }

    /** Wie {@code UemsDatenquelleMigrationTest}: Host:Port, bei OCPP die Stations-Kennung selbst. */
    private static String adresseAusReferenz(JsonNode q) {
        if ("ocpp".equals(q.get("protokoll").asText())) {
            return q.get("adresse").asText();
        }
        return q.get("adresse").asText() + ":" + q.get("port").asInt();
    }

    /**
     * Ein Kundenbereich mit Anlagen, Boxen und Quellen des Referenzunternehmens — gesät am
     * Schreibweg vorbei (als Datenbank-Eigentümer): die Vergangenheit schreibt die Schnittstelle
     * nie, sie beginnt frühestens jetzt.
     */
    private final class Welt {
        final UUID mandant;
        final Map<String, UUID> anlagen = new HashMap<>();
        final Map<String, UUID> boxen = new HashMap<>();
        final Map<UUID, String> boxKennzeichen = new HashMap<>();
        final Map<String, UUID> quellen = new HashMap<>();
        final Map<String, String> quelleAnlage = new HashMap<>();

        Welt(String name) {
            mandant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                    name + " #" + NR.incrementAndGet());
        }

        UUID anlage(String kz) {
            return anlagen.computeIfAbsent(kz, k -> root.queryForObject(
                    "INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, mandant,
                    eines(referenz.get("anlagen"), k).get("name").asText()));
        }

        UUID box(String kz) {
            UUID id = boxen.get(kz);
            if (id != null) {
                return id;
            }
            JsonNode b = referenzBox(kz);
            id = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status) "
                    + "VALUES (?, ?, ?, ?, 'claimed') RETURNING id", UUID.class, mandant,
                    anlage(b.get("heimat_anlage").asText()), b.get("seriennummer").asText() + "#" + NR.incrementAndGet(),
                    b.get("name").asText());
            boxen.put(kz, id);
            boxKennzeichen.put(id, kz);
            return id;
        }

        /** Eine Quelle, wie ein Vektor-Fall sie beschreibt, mit ihren Zeiträumen. */
        UUID quelle(JsonNode q) {
            String kz = q.get("kennzeichen").asText();
            List<Object[]> zs = new ArrayList<>();
            for (JsonNode z : q.get("zeitraeume")) {
                zs.add(new Object[] {z.get("box").asText(), OffsetDateTime.parse(z.get("effective_from").asText()),
                        z.get("effective_to").isNull() ? null : OffsetDateTime.parse(z.get("effective_to").asText())});
            }
            JsonNode ref = referenzQuelle(kz);
            return saeen(kz, q.get("anlage").asText(), q.get("protokoll").asText(), q.get("adresse").asText(),
                    ganzzahlen(ref.get("geraete_ids")), q.get("netz").isNull() ? null : q.get("netz").asText(),
                    q.get("mehrere_leser").asBoolean(), q.get("steuerquelle").asBoolean(),
                    ref.get("kadenz_s").asInt(), zs);
        }

        /** Eine Quelle der Referenz mit den Zuständigkeiten, die zum Stand begonnen hatten. */
        UUID quelleAusReferenz(String kz, Instant stand) {
            JsonNode ref = referenzQuelle(kz);
            List<Object[]> zs = new ArrayList<>();
            for (String zeile : referenzZeitraeume(kz, stand)) {
                String[] t = zeile.split(" · ");
                zs.add(new Object[] {t[0], Instant.parse(t[1]).atOffset(ZoneOffset.UTC),
                        "null".equals(t[2]) ? null : Instant.parse(t[2]).atOffset(ZoneOffset.UTC)});
            }
            return saeen(kz, ref.get("anlage").asText(), ref.get("protokoll").asText(), adresseAusReferenz(ref),
                    ganzzahlen(ref.get("geraete_ids")), ref.get("netz").asText(), false,
                    ref.get("steuerquelle").asBoolean(), ref.get("kadenz_s").asInt(), zs);
        }

        private UUID saeen(String kz, String anlageKz, String protokoll, String adresse, List<Integer> geraeteIds,
                String netz, boolean mehrereLeser, boolean steuerquelle, int kadenz, List<Object[]> zs) {
            StringJoiner ids = new StringJoiner(",", "{", "}");
            geraeteIds.forEach(i -> ids.add(String.valueOf(i)));
            UUID id = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                    + "adresse, geraete_ids, netz, mehrere_leser, steuerquelle, kadenz_s) "
                    + "VALUES (?, ?, ?, ?, ?, ?::integer[], ?, ?, ?, ?) RETURNING id", UUID.class, mandant,
                    anlage(anlageKz), kz, protokoll, adresse, ids.toString(), netz, mehrereLeser, steuerquelle, kadenz);
            for (Object[] z : zs) {
                root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, "
                        + "adresse, effective_from, effective_to) VALUES (?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)",
                        mandant, id, box((String) z[0]), protokoll, adresse, z[1], z[2]);
            }
            quellen.put(kz, id);
            quelleAnlage.put(kz, anlageKz);
            return id;
        }
    }
}
