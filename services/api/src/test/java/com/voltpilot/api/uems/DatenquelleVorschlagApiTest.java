package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * Die Vorschlagsliste der Bestands-Übernahme (UEMS AP-06 IP-4) gegen die echte Sicherheitskette,
 * die echte RLS und TimescaleDB — per MockMvc, die Anmeldung setzt {@code jwt()}.
 *
 * <p>Die Abnahme des Konzepts (AP-06 §8 IP-4 und A12): „Fixture Anlage Halle 1 → genau DQ-1…DQ-3;
 * Demo-Anlagen unverändert“ — bis zur Bestätigung ändert sich kein Push, keine Flow-Aktivierung,
 * keine Zeile; nach der Bestätigung dieselben Pushes wie vorher. Dazu A9 (zweite Box: Vorschläge je
 * Box, die führende Box bleibt), die Übernahme selbst (Quelle, Zuständigkeit ab Reihenbeginn,
 * Komponenten- und Geräte-Verweis, EIN Protokoll-Eintrag je Quelle), Idempotenz, die 409er und der
 * fremde Kundenbereich.
 *
 * <p>Die Beispielwelt ist das Referenzunternehmen ({@code uems-referenzunternehmen.json}): Anlage
 * AN-1, Box E-1 und die Komponenten K-1, K-3 … K-7 kommen mit Namen, Adressen, Geräte-IDs, Takten
 * und Zeitpunkten aus der Datei; erwartet wird, was die Datei über DQ-1 … DQ-3 sagt. Zwei Dinge
 * zeigt die Datenbank anders als die Referenz, beide benannt: K-1 und der über ihn gemeldete
 * Speicher K-2 sind EINE Zeile ({@code battery-hybrid}), und die PV des Hybrid-Wechselrichters ist
 * ein komponiertes Geschwister an seiner Box — beide gehören zu DQ-1. Der Wechselrichter wird über
 * den generischen Modbus-Treiber mit SunSpec-Karte gelesen ({@code modbus_tcp}, Referenz DQ-1).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class DatenquelleVorschlagApiTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final List<String> HALLE_1 = List.of("DQ-1", "DQ-2", "DQ-3");

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

    /** Die Zustellung an die Box — der Beweis „dieselben Pushes“ liest, was ankäme. */
    @MockBean
    EntityRegistryPublisher registryPublisher;

    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;

    @Autowired
    EntityRegistryService registry;

    @Autowired
    FlowActivationService flows;

    @Autowired
    LeadDeviceService fuehrung;

    private static JsonNode referenz;
    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        reset(registryPublisher, flowPublisher);
    }

    // ================================================================ A12: Halle 1

    /** „Fixture Anlage Halle 1 → genau DQ-1…DQ-3“ — mit den Werten der Referenz. */
    @Test
    void halle1WirdGenauDq1BisDq3() throws Exception {
        Welt w = halle1("Halle 1 · Liste");
        UUID an1 = w.anlagen.get("AN-1");
        Antwort a = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null);
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        JsonNode liste = a.body();

        // Die führende Box ist automatisch Box Halle 1 — die Box des Speichers (A12).
        assertThat(liste.at("/fuehrende_box/id").asText()).isEqualTo(w.boxen.get("E-1").toString());
        assertThat(liste.at("/fuehrende_box/name").asText()).isEqualTo(referenzBox("E-1").get("name").asText());
        assertThat(liste.get("fuehrung").asText()).isEqualTo("speicher");
        assertThat(liste.get("ausgelassen")).isEmpty();

        JsonNode vorschlaege = liste.get("vorschlaege");
        assertThat(kennzeichen(vorschlaege)).containsExactlyElementsOf(HALLE_1);
        for (JsonNode v : vorschlaege) {
            String dq = v.get("kennzeichen").asText();
            JsonNode rq = referenzQuelle(dq);
            assertThat(v.at("/box/id").asText()).as(dq).isEqualTo(w.boxen.get("E-1").toString());
            assertThat(v.get("protokoll").asText()).as(dq).isEqualTo(rq.get("protokoll").asText());
            assertThat(v.get("adresse").asText()).as(dq)
                    .isEqualTo(rq.get("adresse").asText() + ":" + rq.get("port").asInt());
            assertThat(v.get("geraete_ids")).as(dq).isEqualTo(rq.get("geraete_ids"));
            assertThat(v.get("kadenz_s").asInt()).as(dq).isEqualTo(rq.get("kadenz_s").asInt());
            assertThat(v.get("steuerquelle").asBoolean()).as(dq).isEqualTo(rq.get("steuerquelle").asBoolean());
            assertThat(Instant.parse(v.get("ab").asText())).as(dq).isEqualTo(reihenbeginn(dq));
            assertThat(ids(v.get("komponenten"))).as(dq).isEqualTo(w.komponentenDer(dq));
            assertThat(v.get("grund").isNull()).as(dq).isTrue();
            assertThat(v.get("text").asText()).as(dq).isEqualTo("Ab 12.03.2024 00:00 liest Box Halle 1");
        }
        // Die Komponenten tragen ihre Kundennamen aus der Referenz.
        assertThat(vorschlaege.get(2).at("/komponenten/0/name").asText())
                .isEqualTo(referenzKomponente("K-4").get("name").asText());
    }

    /**
     * A12: bis zur Bestätigung ändert sich nichts — keine Zeile, kein Registry-Push, keine
     * Flow-Aktivierung, keine führende Box; und nach der Bestätigung: dieselben Pushes an dieselbe
     * Box wie vorher.
     *
     * <p><b>Was „dieselben" heißt</b> — A12 sagt wörtlich „gleiche Pushes wie vorher (Vollmenge =
     * alle Quellen dieser Box)": die Klammer nennt das Maß, nämlich dieselbe MENGE. Nichts fällt
     * weg, nichts wandert zu einer anderen Box. Das entschiedene AP-06-Konzept führt dazu EINE
     * additive Ausnahme (Verträge, additiv): „Registry-Push: unverändertes Schema, neue Regel WAS je
     * Box hineingehört (Zuständigkeit) + optional {@code data_source_id} je Entität (alte Box
     * überliest)". Seit PR 939 (AP-06 IP-13, stabiles DQ-Kennzeichen im Quellen-Herzschlag) trägt
     * der Push dieses Feld, sobald eine Quelle zugeordnet ist.
     *
     * <p>Der Vergleich bleibt deshalb STRENG: {@link #ohneQuellkennzeichen} nimmt genau dieses eine
     * Feld heraus — alles andere wird weiter Zeichen für Zeichen verglichen — und der Test prüft das
     * Feld anschließend ausdrücklich. Kein generisches „unbekannte Felder ignorieren".
     */
    @Test
    void bisZurBestaetigungAendertSichNichtsUndDanachDieselbenPushes() throws Exception {
        Welt w = halle1("Halle 1 · Pushes");
        UUID an1 = w.anlagen.get("AN-1");
        Stand vorher = stand(w, an1);
        assertThat(vorher.registry()).as("der Push trägt die Komponenten").contains("192.168.10.31");
        assertThat(vorher.registryBox()).isEqualTo(w.boxen.get("E-1"));
        assertThat(vorher.flowBox()).isEqualTo(w.boxen.get("E-1"));
        String abdruck = fingerabdruck();

        Antwort liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null);
        assertThat(liste.status()).isEqualTo(200);
        assertThat(fingerabdruck()).as("das GET schreibt nichts").isEqualTo(abdruck);
        assertThat(stand(w, an1)).as("nach dem GET").isEqualTo(vorher);

        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste.body()));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(200);
        assertThat(u.body().get("neu").asInt()).isEqualTo(3);
        assertThat(fingerabdruck()).isNotEqualTo(abdruck);

        Stand nachher = stand(w, an1);
        assertThat(nachher.ohneQuellKennzeichen())
                .as("nach der Übernahme: dieselben Pushes an dieselbe Box")
                .isEqualTo(vorher.ohneQuellKennzeichen());

        // Die EINE entschiedene Differenz, ausdrücklich geprüft statt ignoriert: jede Entität einer
        // übernommenen Quelle trägt danach deren stabiles DQ-Kennzeichen, vorher trägt es keine.
        assertThat(vorher.quellKennzeichen()).as("vor der Bestätigung trägt keine Entität das Feld").isEmpty();
        for (String dq : HALLE_1) {
            for (UUID k : w.komponentenDer(dq)) {
                assertThat(nachher.quellKennzeichen().get(k)).as(dq + " an " + k).isEqualTo(dq);
            }
        }
        // Keine Entität bleibt ohne Kennzeichen, und es taucht kein fremdes auf - die zusammengesetzte
        // Entität (der producer des Hybrid-Wechselrichters) erbt das Kennzeichen ihres Erzeugers.
        assertThat(nachher.quellKennzeichen().keySet()).isEqualTo(entitaeten(nachher.registry()));
        assertThat(Set.copyOf(nachher.quellKennzeichen().values())).isEqualTo(Set.copyOf(HALLE_1));
    }

    /** Die Übernahme schreibt Quelle, Zuständigkeit ab Reihenbeginn, beide Verweise und EIN Protokoll. */
    @Test
    void dieUebernahmeSchreibtQuelleZustaendigkeitVerweiseUndProtokoll() throws Exception {
        Welt w = halle1("Halle 1 · Übernahme");
        UUID an1 = w.anlagen.get("AN-1");
        UUID e1 = w.boxen.get("E-1");
        Antwort liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null);
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste.body()));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(200);
        assertThat(u.body().get("neu").asInt()).isEqualTo(3);
        assertThat(u.body().get("unveraendert").asInt()).isZero();

        JsonNode quellen = u.body().get("datenquellen");
        assertThat(kennzeichen(quellen)).containsExactlyElementsOf(HALLE_1);
        for (JsonNode q : quellen) {
            String dq = q.get("kennzeichen").asText();
            JsonNode rq = referenzQuelle(dq);
            UUID id = UUID.fromString(q.get("id").asText());
            assertThat(q.get("name").isNull()).as("eine Quelle aus dem Bestand trägt nur ihr Kennzeichen").isTrue();
            assertThat(q.get("anlage").asText()).isEqualTo(an1.toString());
            assertThat(q.get("adresse").asText()).isEqualTo(rq.get("adresse").asText() + ":" + rq.get("port").asInt());
            assertThat(q.get("kadenz_s").asInt()).isEqualTo(rq.get("kadenz_s").asInt());
            assertThat(q.get("steuerquelle").asBoolean()).isEqualTo(rq.get("steuerquelle").asBoolean());
            assertThat(q.get("mehrere_leser").asBoolean()).isFalse();
            assertThat(q.get("netz").isNull()).isTrue();
            // Zuständig ist die heutige Box — ab Reihenbeginn, offen.
            assertThat(q.at("/zustaendige_box/id").asText()).isEqualTo(e1.toString());
            assertThat(q.get("zeitraeume")).hasSize(1);
            assertThat(Instant.parse(q.at("/zeitraeume/0/effective_from").asText())).isEqualTo(reihenbeginn(dq));
            assertThat(q.at("/zeitraeume/0/effective_to").isNull()).isTrue();
            // Die Komponenten und die Geräte ihrer laufenden Speisung zeigen auf die Quelle.
            assertThat(new HashSet<>(root.queryForList("SELECT id FROM measurement_point WHERE data_source_id = ?",
                    UUID.class, id))).as(dq).isEqualTo(w.komponentenDer(dq));
            assertThat(root.queryForList("SELECT DISTINCT g.kennzeichen FROM geraet g WHERE g.data_source_id = ? "
                    + "ORDER BY 1", String.class, id)).as(dq).isEqualTo(w.geraeteDer(dq));
            // EIN Eintrag je Quelle, mit Urheber, gilt ab Reihenbeginn.
            Antwort p = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/" + id + "/history", null);
            assertThat(p.body().get("eintraege")).hasSize(1);
            JsonNode e = p.body().at("/eintraege/0");
            assertThat(e.get("art").asText()).isEqualTo("aus_bestand_uebernommen");
            assertThat(e.at("/box/id").asText()).isEqualTo(e1.toString());
            assertThat(Instant.parse(e.get("gilt_ab").asText())).isEqualTo(reihenbeginn(dq));
            assertThat(e.at("/neu/kennzeichen").asText()).isEqualTo(dq);
            assertThat(e.at("/neu/komponenten")).hasSize(w.komponentenDer(dq).size());
            assertThat(e.at("/urheber/name").asText()).isEqualTo("Jonas Wendlinger");
            assertThat(e.at("/urheber/art").asText()).isEqualTo("kunde");
        }
        // Danach ist die Liste leer — nichts mehr ohne Quelle.
        Antwort danach = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null);
        assertThat(danach.body().get("vorschlaege")).isEmpty();
        assertThat(danach.body().get("ausgelassen")).isEmpty();
    }

    /** Ein zweiter Aufruf legt nichts an — und nennt dieselben Quellen. */
    @Test
    void einZweiterAufrufLegtNichtsAn() throws Exception {
        Welt w = halle1("Halle 1 · zweimal");
        UUID an1 = w.anlagen.get("AN-1");
        Map<String, Object> body = alle(ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body());
        Antwort erst = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", body);
        String abdruck = fingerabdruck();
        Antwort zweit = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", body);
        assertThat(zweit.status()).as(zweit.body().toString()).isEqualTo(200);
        assertThat(zweit.body().get("neu").asInt()).isZero();
        assertThat(zweit.body().get("unveraendert").asInt()).isEqualTo(3);
        assertThat(ids(zweit.body().get("datenquellen"))).isEqualTo(ids(erst.body().get("datenquellen")));
        assertThat(fingerabdruck()).isEqualTo(abdruck);
    }

    /** Hat eine Komponente inzwischen auf anderem Weg eine Quelle, ist die Bestätigung 409 — nichts geschrieben. */
    @Test
    void eineInzwischenVersorgteKomponenteIst409() throws Exception {
        Welt w = halle1("Halle 1 · versorgt");
        UUID an1 = w.anlagen.get("AN-1");
        JsonNode liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body();
        // Zwischen Liste und Bestätigung hängt jemand K-3 an eine von Hand angelegte Quelle.
        UUID vonHand = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, kadenz_s) VALUES (?, ?, 'DQ-40', 'modbus_tcp', '192.168.10.30:502', 10) RETURNING id",
                UUID.class, w.mandant, an1);
        root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", vonHand, w.komponenten.get("K-3"));
        String abdruck = fingerabdruck();

        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(409);
        assertThat(u.body().get("code").asText()).isEqualTo("komponente_hat_quelle");
        assertThat(u.body().get("message").asText()).contains("DQ-40").contains("neu laden");
        assertThat(texte(u.body().get("komponenten"))).containsExactly(w.komponenten.get("K-3").toString());
        assertThat(texte(u.body().get("datenquellen"))).containsExactly("DQ-40");
        assertThat(fingerabdruck()).as("alles oder nichts").isEqualTo(abdruck);
    }

    /** Bestätigt wird nur, was gezeigt wurde: ein anderer Zuschnitt ist 409 {@code vorschlag_geaendert}. */
    @Test
    void einGeaenderterVorschlagIst409() throws Exception {
        Welt w = halle1("Halle 1 · geändert");
        UUID an1 = w.anlagen.get("AN-1");
        JsonNode dq3 = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body().at("/vorschlaege/2");
        List<String> ohneK7 = new ArrayList<>(texte(ids(dq3.get("komponenten"))));
        ohneK7.remove(w.komponenten.get("K-7").toString());
        String abdruck = fingerabdruck();
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", Map.of("vorschlaege",
                List.of(Map.of("device_id", dq3.at("/box/id").asText(), "protokoll", "modbus_tcp", "adresse",
                        dq3.get("adresse").asText(), "komponenten", ohneK7))));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(409);
        assertThat(u.body().get("code").asText()).isEqualTo("vorschlag_geaendert");
        assertThat(u.body().get("adresse").asText()).isEqualTo("192.168.10.31:502");
        assertThat(fingerabdruck()).isEqualTo(abdruck);
    }

    /**
     * Liest die Box eine Adresse schon als andere Quelle (angelegt über die Schnittstelle), sperrt
     * das den Vorschlag mit dem Grund und Satz des Vertrags — die Liste sagt es, die Bestätigung
     * ist 409.
     */
    @Test
    void eineVergebeneAdresseSperrtDenVorschlag() throws Exception {
        Welt w = halle1("Halle 1 · vergeben");
        UUID an1 = w.anlagen.get("AN-1");
        UUID e1 = w.boxen.get("E-1");
        UUID vonHand = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, kadenz_s) VALUES (?, ?, 'DQ-41', 'modbus_tcp', '192.168.10.30:502', 10) RETURNING id",
                UUID.class, w.mandant, an1);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) VALUES (?, ?, ?, 'modbus_tcp', '192.168.10.30:502', '2026-09-01T08:00:00Z')",
                w.mandant, vonHand, e1);

        JsonNode liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body();
        JsonNode dq2 = liste.at("/vorschlaege/1");
        assertThat(dq2.get("adresse").asText()).isEqualTo("192.168.10.30:502");
        assertThat(dq2.get("grund").asText()).isEqualTo("adresse_an_box_vergeben");
        assertThat(dq2.get("text").asText())
                .isEqualTo("Diese Adresse liest Box Halle 1 bereits als DQ-41 — Gerät dort hinzufügen?");
        // Die übrigen bleiben übernehmbar; DQ-41 ist belegt, die Nummern laufen darum weiter.
        assertThat(kennzeichen(liste.get("vorschlaege"))).containsExactly("DQ-1", "DQ-2", "DQ-3");
        assertThat(liste.at("/vorschlaege/0/grund").isNull()).isTrue();

        String abdruck = fingerabdruck();
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(409);
        assertThat(u.body().get("code").asText()).isEqualTo("adresse_an_box_vergeben");
        assertThat(fingerabdruck()).isEqualTo(abdruck);
    }

    /**
     * „Gerät dort hinzufügen?" (Messen-Assistent Schritt 2, 21.09.2026): die gesperrte Zeile nennt die von
     * Hand angelegte Quelle als {@code ziel}, sobald sie alle Geräte-IDs des Vorschlags trägt; die
     * Bestätigung MIT {@code datenquelle_id} hängt die Komponenten daran — ein anderes Ziel ist 409
     * {@code vorschlag_geaendert}, ein zweiter Aufruf unverändert. Keine neue Quelle, keine neue Zuständigkeit.
     */
    @Test
    void eineVergebeneAdresseNimmtDieGeraeteNachBestaetigungAuf() throws Exception {
        Welt w = halle1("Halle 1 · hinzufügen");
        UUID an1 = w.anlagen.get("AN-1");
        UUID e1 = w.boxen.get("E-1");
        UUID vonHand = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, kadenz_s) VALUES (?, ?, 'DQ-41', 'modbus_tcp', '192.168.10.30:502', 10) RETURNING id",
                UUID.class, w.mandant, an1);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) VALUES (?, ?, ?, 'modbus_tcp', '192.168.10.30:502', '2026-09-01T08:00:00Z')",
                w.mandant, vonHand, e1);

        // Ohne die Geräte-IDs des Vorschlags beschreibt DQ-41 diese Geräte nicht — kein Ziel.
        JsonNode dq2 = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body().at("/vorschlaege/1");
        assertThat(dq2.get("grund").asText()).isEqualTo("adresse_an_box_vergeben");
        assertThat(dq2.get("ziel").isNull()).isTrue();
        List<Integer> ids = new ArrayList<>();
        dq2.get("geraete_ids").forEach(i -> ids.add(i.asInt()));
        root.update(con -> {
            var ps = con.prepareStatement("UPDATE data_source SET geraete_ids = ? WHERE id = ?");
            ps.setArray(1, con.createArrayOf("integer", ids.toArray()));
            ps.setObject(2, vonHand);
            return ps;
        });

        dq2 = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body().at("/vorschlaege/1");
        assertThat(dq2.at("/ziel/id").asText()).isEqualTo(vonHand.toString());
        assertThat(dq2.at("/ziel/kennzeichen").asText()).isEqualTo("DQ-41");
        Map<String, Object> zeile = new LinkedHashMap<>();
        zeile.put("device_id", dq2.at("/box/id").asText());
        zeile.put("protokoll", dq2.get("protokoll").asText());
        zeile.put("adresse", dq2.get("adresse").asText());
        zeile.put("komponenten", texte(ids(dq2.get("komponenten"))));

        String abdruck = fingerabdruck();
        zeile.put("datenquelle_id", UUID.randomUUID().toString());
        Antwort falsch = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen",
                Map.of("vorschlaege", List.of(zeile)));
        assertThat(falsch.status()).as(falsch.body().toString()).isEqualTo(409);
        assertThat(falsch.body().get("code").asText()).isEqualTo("vorschlag_geaendert");
        assertThat(fingerabdruck()).isEqualTo(abdruck);

        zeile.put("datenquelle_id", vonHand.toString());
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen",
                Map.of("vorschlaege", List.of(zeile)));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(200);
        assertThat(u.body().get("neu").asInt()).isZero();
        assertThat(u.body().get("angehaengt").asInt()).isEqualTo(1);
        assertThat(u.body().at("/datenquellen/0/kennzeichen").asText()).isEqualTo("DQ-41");
        int zahl = dq2.get("komponenten").size();
        assertThat(root.queryForObject("SELECT count(*) FROM measurement_point WHERE data_source_id = ?",
                Integer.class, vonHand)).isEqualTo(zahl);
        assertThat(root.queryForObject("SELECT count(*) FROM data_source WHERE site_id = ?", Integer.class, an1))
                .as("keine zweite Quelle").isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM data_source_assignment WHERE data_source_id = ?",
                Integer.class, vonHand)).as("keine neue Zuständigkeit").isEqualTo(1);

        Antwort nochmal = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen",
                Map.of("vorschlaege", List.of(zeile)));
        assertThat(nochmal.status()).isEqualTo(200);
        assertThat(nochmal.body().get("unveraendert").asInt()).isEqualTo(1);
        assertThat(nochmal.body().get("angehaengt").asInt()).isZero();
    }

    @Test
    void gleicheAdresseAnAndererBoxBrauchtAusserhalbDesBestandsAssistentenEineNetzlage() throws Exception {
        Welt w = halle1("Halle 1 · Doppel-Lesen");
        UUID an1 = w.anlagen.get("AN-1");
        UUID andereBox = w.boxErfunden("Vergleichs-Box", an1, "2026-08-01T08:00:00+02:00");
        UUID bestehend = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                + "adresse, netz, mehrere_leser, kadenz_s) VALUES (?, ?, 'DQ-41', 'modbus_tcp', "
                + "'192.168.10.30:502', '192.168.10.0/24', true, 10) RETURNING id",
                UUID.class, w.mandant, an1);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) VALUES (?, ?, ?, 'modbus_tcp', '192.168.10.30:502', '2026-09-01T08:00:00Z')",
                w.mandant, bestehend, andereBox);

        JsonNode liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body();
        JsonNode dq2 = liste.at("/vorschlaege/1");
        assertThat(dq2.get("grund").asText()).isEqualTo("netzlage_fehlt");
        assertThat(dq2.get("text").asText()).contains("erst das Netz beider Quellen eintragen");

        Antwort uebernahme = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste));
        assertThat(uebernahme.status()).isEqualTo(409);
        assertThat(uebernahme.body().get("grund").asText()).isEqualTo("netzlage_fehlt");
        assertThat(uebernahme.body().get("satz").asText()).contains("erst das Netz beider Quellen eintragen");
    }

    // ================================================================ A9: zweite Box

    /**
     * A9: eine zusätzliche Lese-Box in AN-1. Gruppiert wird je Box — was Box Halle 1 liest, bleibt
     * DQ-1 … DQ-3; was die zweite liest, wird eine eigene Quelle mit IHREM Reihenbeginn. Die
     * führende Box bleibt Box Halle 1 (Speicher-Box). Seit IP-6 (Push je Box) bekommt die Lese-Box nach
     * der Bestätigung ihren EIGENEN Registry-Push mit genau ihrer Quelle; Box Halle 1 liest K-96 nicht mehr.
     */
    @Test
    void a9ZweiteBoxVorschlaegeJeBoxDieFuehrendeBleibt() throws Exception {
        Welt w = halle1("Halle 1 · A9");
        UUID an1 = w.anlagen.get("AN-1");
        // Erfunden (A9: „eine zusätzliche Lese-Box wird in AN-1 verbunden“): Box und ein Zähler dahinter.
        UUID lese = w.boxErfunden("Lese-Box Halle 1", an1, "2026-08-03T10:15:30+02:00");
        UUID kantine = w.komponente("K-96", an1, "modbus-generic", lese, "modbus_tcp", null,
                "{\"ip\":\"192.168.10.50\",\"port\":502,\"unit_id\":1,\"interval_s\":10}", false,
                "Unterzähler Kantine", Instant.parse("2026-08-03T08:10:00Z"));

        JsonNode liste = ruf(w.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body();
        assertThat(liste.get("fuehrung").asText()).isEqualTo("speicher");
        assertThat(liste.at("/fuehrende_box/id").asText()).isEqualTo(w.boxen.get("E-1").toString());
        JsonNode vs = liste.get("vorschlaege");
        assertThat(kennzeichen(vs)).containsExactly("DQ-1", "DQ-2", "DQ-3", "DQ-4");
        for (int i = 0; i < 3; i++) {
            assertThat(vs.get(i).at("/box/id").asText()).isEqualTo(w.boxen.get("E-1").toString());
        }
        JsonNode dq4 = vs.get(3);
        assertThat(dq4.at("/box/id").asText()).isEqualTo(lese.toString());
        assertThat(dq4.at("/box/name").asText()).isEqualTo("Lese-Box Halle 1");
        assertThat(ids(dq4.get("komponenten"))).containsExactly(kantine);
        // Die Komponente stand vor der Box in der Anlage: gelesen hat die Box erst ab ihrer Ankunft,
        // auf die nächste volle Minute.
        assertThat(dq4.get("ab").asText()).isEqualTo("2026-08-03T08:16:00Z");

        TenantContext.set(w.mandant);
        assertThat(fuehrung.fuehrendeBox(an1).box()).isEqualTo(w.boxen.get("E-1"));
        TenantContext.clear();
        Stand vorher = stand(w, an1);
        assertThat(vorher.registryBox()).isEqualTo(w.boxen.get("E-1"));
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", alle(liste));
        assertThat(u.body().get("neu").asInt()).as(u.body().toString()).isEqualTo(4);
        assertThat(u.body().at("/datenquellen/3/zustaendige_box/id").asText()).isEqualTo(lese.toString());
        // Kein Verbund: die führende Box und die Flow-Aktivierung bleiben Box Halle 1. Aber seit IP-6 geht
        // der Registry-Push je Box — die Lese-Box bekommt genau K-96, Box Halle 1 alles andere.
        Stand nachher = stand(w, an1);
        assertThat(vorher.registryPushes()).isEqualTo(1);
        assertThat(nachher.registryPushes()).isEqualTo(2);
        assertThat(nachher.registryBox()).isEqualTo(w.boxen.get("E-1"));
        assertThat(nachher.flow()).isEqualTo(vorher.flow());
        assertThat(nachher.flowBox()).isEqualTo(vorher.flowBox());
        assertThat(nachher.fuehrend()).isEqualTo(vorher.fuehrend());
        assertThat(nachher.fuehrungsGrund()).isEqualTo(vorher.fuehrungsGrund());
        Map<UUID, Set<UUID>> jeBox = entitaetenJeBox(w, an1);
        Set<UUID> ohneKantine = new HashSet<>(entitaeten(vorher.registry()));
        assertThat(ohneKantine.remove(kantine)).as("vor der Bestätigung las Box Halle 1 auch K-96").isTrue();
        assertThat(jeBox.keySet()).containsExactly(w.boxen.get("E-1"), lese);
        assertThat(jeBox.get(w.boxen.get("E-1"))).isEqualTo(ohneKantine);
        assertThat(jeBox.get(lese)).containsExactly(kantine);
    }

    // ================================================================ benannt ausgelassen

    /**
     * Jeder Bestands-Transport bekommt seine Quelle — auch Deye über den Datenlogger
     * ({@code solarman_v5}, nach AP-06 Soll-Regel 8) und die Ladestation (OCPP); was keinen lesbaren Weg
     * hat, steht benannt unter {@code ausgelassen}, nie geraten. Testaufbau (nicht aus der
     * Referenz): zwei Boxen, keine gewählt, kein Speicher.
     */
    @Test
    void jederBestandsTransportBekommtSeineQuelleDerRestStehtBenanntAusgelassen() throws Exception {
        Welt w = new Welt("Testaufbau Werkstatt");
        UUID site = w.anlageErfunden("Werkstatt");
        UUID x = w.boxErfunden("Box Werkstatt", site, "2026-06-01T09:00:00+02:00");
        UUID y = w.boxErfunden("Box Lager", site, "2026-06-01T09:05:00+02:00");
        Instant t = Instant.parse("2026-06-02T08:00:00Z");
        UUID deye = w.komponente("deye", site, "battery-hybrid", x, "solarman_v5", "hybrid_3p",
                "{\"ip\":\"192.168.0.28\",\"port\":8899,\"serial\":\"2985159064\",\"mb_slave_id\":1,"
                        + "\"power_scale\":10,\"interval_s\":10}", true, "Deye-Hybrid", t);
        UUID pv = w.komponente("pv", site, "producer", x, null, null, null, false, null, t.plusSeconds(1));
        // Ein zweiter Hybrid, dessen Anschluss noch nicht eingetragen ist — mit seinem Geschwister.
        UUID lager = w.komponente("lager", site, "battery-hybrid", y, null, null, null, false, "Hybrid Lager",
                t.plusSeconds(2));
        UUID lagerPv = w.komponente("lager-pv", site, "producer", y, null, null, null, false, null, t.plusSeconds(3));
        UUID stab = w.komponente("stab", site, "heating-rod", x, null, null, null, false, "Heizstab", t.plusSeconds(4));
        // Die Rückwand: ein Transport, den keine Vorlage und kein Treiber trägt.
        UUID fremd = w.komponente("fremd", site, "generic-load", x, "opc_ua", null,
                "{\"ip\":\"192.168.0.60\",\"port\":4840}", false, "Kältemaschine", t.plusSeconds(5));
        UUID zaehler = w.komponente("zaehler", site, "grid-meter", null, "modbus_tcp", null,
                "{\"ip\":\"192.168.0.40\",\"port\":502,\"unit_id\":1}", false, "Netzzähler", t.plusSeconds(6));
        UUID saeule = w.komponente("saeule", site, "ev-charger", null, null, null, null, false, "Wallbox Hof",
                t.plusSeconds(7));
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, entity_id, "
                + "reported_at) VALUES (?, 'WB-HOF-01', ?, ?, ?, now())", x, w.mandant, site, saeule);

        JsonNode liste = ruf(w.jonas, HttpMethod.GET, basis(site) + "/vorschlag", null).body();
        assertThat(liste.get("fuehrung").asText()).isEqualTo("keine_wahl");
        assertThat(liste.get("fuehrende_box").isNull()).isTrue();
        JsonNode vs = liste.get("vorschlaege");
        assertThat(kennzeichen(vs)).containsExactly("DQ-1", "DQ-2");
        // Deye über den Datenlogger: das eigene Wort, Host:Port/Seriennummer, die Slave-ID als Geräte-ID —
        // und das PV-Geschwister in derselben Quelle.
        assertThat(vs.at("/0/protokoll").asText()).isEqualTo("solarman_v5");
        assertThat(vs.at("/0/adresse").asText()).isEqualTo("192.168.0.28:8899/2985159064");
        assertThat(vs.at("/0/geraete_ids").toString()).isEqualTo("[1]");
        assertThat(vs.at("/0/kadenz_s").asInt()).isEqualTo(10);
        assertThat(vs.at("/0/steuerquelle").asBoolean()).isTrue();
        assertThat(vs.at("/0/box/id").asText()).isEqualTo(x.toString());
        assertThat(ids(vs.get(0).get("komponenten"))).containsExactlyInAnyOrder(deye, pv);
        // Die Station liest die Box, an deren Zentrale sie hängt — ihre Kennung ist die Adresse.
        assertThat(vs.at("/1/protokoll").asText()).isEqualTo("ocpp");
        assertThat(vs.at("/1/adresse").asText()).isEqualTo("WB-HOF-01");
        assertThat(vs.at("/1/box/id").asText()).isEqualTo(x.toString());
        assertThat(vs.at("/1/kadenz_s").isNull()).as("nicht erhoben — nie eine Vorgabe").isTrue();

        JsonNode aus = liste.get("ausgelassen");
        assertThat(ids(aus, "komponente")).containsExactly(lager, lagerPv, stab, fremd, zaehler);
        assertThat(texte(aus, "grund")).containsExactly("keine_adresse", "anker_ohne_vorschlag", "keine_adresse",
                "protokoll_unbekannt", "keine_box");
        assertThat(aus.at("/1/anker/id").asText()).isEqualTo(lager.toString());
        assertThat(aus.at("/1/text").asText())
                .isEqualTo("Wird über „Hybrid Lager“ gelesen — dafür gibt es hier keinen Vorschlag");
        assertThat(aus.at("/3/protokoll").asText()).isEqualTo("opc_ua");
        assertThat(aus.at("/3/text").asText())
                .isEqualTo("Für dieses Protokoll gibt es noch keine Datenquelle — neue Protokolle kommen nur über"
                        + " den Katalog");
        assertThat(aus.at("/4/text").asText())
                .isEqualTo("Keine Box liest diese Komponente — ohne Box gibt es keine Datenquelle vorzuschlagen");

        // Die Bestätigung schreibt die Deye-Quelle mit ihrem eigenen Wort (CHECK geweitet, V20260911270000).
        Antwort u = ruf(w.jonas, HttpMethod.POST, basis(site) + "/vorschlag/uebernehmen", alle(liste));
        assertThat(u.status()).as(u.body().toString()).isEqualTo(200);
        assertThat(u.body().get("neu").asInt()).isEqualTo(2);
        assertThat(u.body().at("/datenquellen/0/protokoll").asText()).isEqualTo("solarman_v5");
        assertThat(u.body().at("/datenquellen/0/adresse").asText()).isEqualTo("192.168.0.28:8899/2985159064");
        assertThat(u.body().at("/datenquellen/1/protokoll").asText()).isEqualTo("ocpp");
    }

    // ================================================================ Demo-Anlagen, Zaun, Anfrage

    /** A12 „Demo-Anlagen unverändert“: die Liste jeder gesäten Anlage schreibt nichts. */
    @Test
    void demoAnlagenBleibenUnveraendert() throws Exception {
        List<Map<String, Object>> demo = root.queryForList("SELECT s.id, s.tenant_id FROM site s JOIN tenant t "
                + "ON t.id = s.tenant_id WHERE position('#' IN t.name) = 0 ORDER BY s.created_at, s.id");
        assertThat(demo).as("die Dev-Saat trägt Anlagen").isNotEmpty();
        String abdruck = fingerabdruck();
        for (Map<String, Object> s : demo) {
            Antwort a = ruf(plattform((UUID) s.get("tenant_id")), HttpMethod.GET,
                    basis((UUID) s.get("id")) + "/vorschlag", null);
            assertThat(a.status()).as(s + " " + a.body()).isEqualTo(200);
        }
        assertThat(fingerabdruck()).isEqualTo(abdruck);
        assertThat(root.queryForObject("SELECT count(*) FROM data_source d JOIN tenant t ON t.id = d.tenant_id "
                + "WHERE position('#' IN t.name) = 0", Integer.class)).isZero();
    }

    /** Eine fremde Anlage ist 404, nie 403 — und nichts wird geschrieben. */
    @Test
    void fremderKundenbereichIst404() throws Exception {
        Welt a = halle1("Halle 1 · Zaun");
        Welt b = new Welt("Fremd");
        UUID an1 = a.anlagen.get("AN-1");
        Map<String, Object> body = alle(ruf(a.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).body());
        String abdruck = fingerabdruck();
        assertThat(ruf(b.jonas, HttpMethod.GET, basis(an1) + "/vorschlag", null).status()).isEqualTo(404);
        assertThat(ruf(b.jonas, HttpMethod.POST, basis(an1) + "/vorschlag/uebernehmen", body).status()).isEqualTo(404);
        assertThat(fingerabdruck()).isEqualTo(abdruck);
    }

    /** Die Anfrage wird streng gelesen: leer, ein fremdes Feld, eine Komponente doppelt — 400. */
    @Test
    void eineUnvollstaendigeAnfrageIst400() throws Exception {
        Welt w = halle1("Halle 1 · Anfrage");
        UUID an1 = w.anlagen.get("AN-1");
        String pfad = basis(an1) + "/vorschlag/uebernehmen";
        Antwort leer = ruf(w.jonas, HttpMethod.POST, pfad, Map.of("vorschlaege", List.of()));
        assertThat(leer.status()).isEqualTo(400);
        assertThat(leer.body().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(leer.body().get("feld").asText()).isEqualTo("vorschlaege");
        Antwort fremd = ruf(w.jonas, HttpMethod.POST, pfad, Map.of("vorschlaege", List.of(), "kennzeichen", "DQ-1"));
        assertThat(fremd.body().get("feld").asText()).isEqualTo("kennzeichen");
        UUID k4 = w.komponenten.get("K-4");
        Map<String, Object> v = Map.of("device_id", w.boxen.get("E-1"), "protokoll", "modbus_tcp", "adresse",
                "192.168.10.31:502", "komponenten", List.of(k4));
        Antwort doppelt = ruf(w.jonas, HttpMethod.POST, pfad, Map.of("vorschlaege", List.of(v, v)));
        assertThat(doppelt.status()).isEqualTo(400);
        assertThat(doppelt.body().get("feld").asText()).isEqualTo("vorschlaege[1].komponenten");
    }

    // ================================================================ Gerüst

    /** Was eine Box erreicht: Registry-Push und Flow-Aktivierung (ohne ihre Zeitstempel), und wer führt. */
    private record Stand(String registry, UUID registryBox, int registryPushes, String flow, UUID flowBox,
            UUID fuehrend, String fuehrungsGrund, Map<UUID, String> quellKennzeichen) {

        /**
         * Fuer den Vergleich vorher/nachher: alles AUSSER dem einen Feld, das AP-06 als additiv
         * entschieden hat. Das Feld selbst wird nicht ignoriert, sondern ausdruecklich geprueft.
         */
        Stand ohneQuellKennzeichen() {
            return new Stand(registry, registryBox, registryPushes, flow, flowBox, fuehrend, fuehrungsGrund,
                    Map.of());
        }
    }

    private Stand stand(Welt w, UUID anlage) throws Exception {
        reset(registryPublisher, flowPublisher);
        when(registryPublisher.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        when(flowPublisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
        TenantContext.set(w.mandant);
        try {
            LeadDeviceService.FuehrendeBox f = fuehrung.fuehrendeBox(anlage);
            registry.pushRegistryBestEffort(anlage);
            flows.republishForSite(anlage);
            ArgumentCaptor<UUID> rBox = ArgumentCaptor.forClass(UUID.class);
            ArgumentCaptor<byte[]> rPush = ArgumentCaptor.forClass(byte[].class);
            // Seit IP-6 geht der Registry-Push je Box: der Stand trägt den Push an die FÜHRENDE Box und zählt,
            // wie viele Boxen einen bekamen.
            verify(registryPublisher, atLeastOnce()).publishRegistry(eq(w.mandant), eq(anlage), rBox.capture(),
                    rPush.capture());
            int fuehrende = rBox.getAllValues().indexOf(f.box());
            ArgumentCaptor<UUID> fBox = ArgumentCaptor.forClass(UUID.class);
            ArgumentCaptor<byte[]> fPush = ArgumentCaptor.forClass(byte[].class);
            verify(flowPublisher).publishDeployment(eq(w.mandant), eq(anlage), fBox.capture(), fPush.capture());
            Map<UUID, String> quellKennzeichen = new LinkedHashMap<>();
            String registryPush = ohneQuellkennzeichen(rPush.getAllValues().get(fuehrende), quellKennzeichen,
                    "revision", "published_at");
            return new Stand(registryPush,
                    rBox.getAllValues().get(fuehrende), rBox.getAllValues().size(),
                    ohne(fPush.getValue(), "deployed_at"), fBox.getValue(), f.box(), f.grund().code(),
                    quellKennzeichen);
        } finally {
            TenantContext.clear();
        }
    }

    /** Seit IP-6: je Box (in Zustell-Reihenfolge) die Entitäten ihres Registry-Pushs. */
    private Map<UUID, Set<UUID>> entitaetenJeBox(Welt w, UUID anlage) throws Exception {
        reset(registryPublisher);
        when(registryPublisher.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        TenantContext.set(w.mandant);
        try {
            registry.pushRegistryBestEffort(anlage);
        } finally {
            TenantContext.clear();
        }
        ArgumentCaptor<UUID> box = ArgumentCaptor.forClass(UUID.class);
        ArgumentCaptor<byte[]> push = ArgumentCaptor.forClass(byte[].class);
        verify(registryPublisher, atLeastOnce()).publishRegistry(eq(w.mandant), eq(anlage), box.capture(),
                push.capture());
        Map<UUID, Set<UUID>> out = new LinkedHashMap<>();
        for (int i = 0; i < box.getAllValues().size(); i++) {
            out.put(box.getAllValues().get(i),
                    entitaeten(new String(push.getAllValues().get(i), StandardCharsets.UTF_8)));
        }
        return out;
    }

    private static Set<UUID> entitaeten(String push) throws IOException {
        Set<UUID> out = new HashSet<>();
        MAPPER.readTree(push).get("entities").forEach(e -> out.add(UUID.fromString(e.get("entity_id").asText())));
        return out;
    }

    /**
     * Nimmt GENAU das eine Feld aus dem Registry-Push, das AP-06 als additiv entschieden hat -
     * {@code entities[].driver.data_source_id} - und reicht es ueber {@code senke} zur
     * ausdruecklichen Pruefung heraus. Alles andere bleibt im Vergleich: Entitaeten-Menge,
     * Reihenfolge, Adressen, Kadenz, Register, Treiber-Parameter. Kein generisches
     * "unbekannte Felder ignorieren".
     *
     * <p>Den Treiber-Behaelter selbst entfernt die Methode nur, wenn er NACH dem Herausnehmen leer
     * ist: fuer eine Entitaet ohne eigenen Treiber legt ihn erst das Kennzeichen an (siehe
     * {@code EntityRegistryService}, {@code d.has("driver") ? ... : d.putObject("driver")}).
     */
    private static String ohneQuellkennzeichen(byte[] push, Map<UUID, String> senke, String... zeitstempel)
            throws IOException {
        ObjectNode n = (ObjectNode) MAPPER.readTree(push);
        for (String z : zeitstempel) {
            assertThat(n.has(z)).as(z).isTrue();
            n.remove(z);
        }
        for (JsonNode e : n.path("entities")) {
            ObjectNode entitaet = (ObjectNode) e;
            JsonNode treiber = entitaet.get("driver");
            if (treiber == null || !treiber.has("data_source_id")) {
                continue;
            }
            senke.put(UUID.fromString(entitaet.get("entity_id").asText()),
                    ((ObjectNode) treiber).remove("data_source_id").asText());
            if (treiber.isEmpty()) {
                entitaet.remove("driver");
            }
        }
        return n.toString();
    }

    private static String ohne(byte[] push, String... zeitstempel) throws IOException {
        ObjectNode n = (ObjectNode) MAPPER.readTree(push);
        for (String z : zeitstempel) {
            assertThat(n.has(z)).as(z).isTrue();
            n.remove(z);
        }
        return n.toString();
    }

    /** Alles, was die Übernahme schreiben könnte — über ALLE Kundenbereiche. */
    private static String fingerabdruck() {
        return root.queryForObject("""
                SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
                    SELECT 'ds:' || id::text || ':' || kennzeichen FROM data_source
                    UNION ALL SELECT 'dsa:' || id::text || ':' || effective_from::text || ':'
                        || coalesce(effective_to::text, '') FROM data_source_assignment
                    UNION ALL SELECT 'dsae:' || id::text FROM data_source_aenderung
                    UNION ALL SELECT 'mp:' || id::text || ':' || coalesce(data_source_id::text, '')
                        FROM measurement_point
                    UNION ALL SELECT 'g:' || id::text || ':' || coalesce(data_source_id::text, '') FROM geraet
                    UNION ALL SELECT 'seq:' || tenant_id::text || ':' || naechste_nummer
                        FROM data_source_kennzeichen_seq
                    UNION ALL SELECT 'lead:' || id::text || ':' || coalesce(lead_device_id::text, '') FROM site
                ) t(x)
                """, String.class);
    }

    /** Die Bestätigung von allem, was die Liste zeigt — genau so, wie sie es zeigt. */
    private static Map<String, Object> alle(JsonNode liste) {
        List<Map<String, Object>> v = new ArrayList<>();
        for (JsonNode x : liste.get("vorschlaege")) {
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("device_id", x.at("/box/id").asText());
            b.put("protokoll", x.get("protokoll").asText());
            b.put("adresse", x.get("adresse").asText());
            b.put("komponenten", texte(ids(x.get("komponenten"))));
            v.add(b);
        }
        return Map.of("vorschlaege", v);
    }

    private static List<String> kennzeichen(JsonNode arr) {
        return texte(arr, "kennzeichen");
    }

    private static List<String> texte(JsonNode arr, String feld) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.get(feld).asText()));
        return out;
    }

    private static List<String> texte(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> texte(Set<UUID> ids) {
        return ids.stream().map(UUID::toString).sorted().toList();
    }

    private static Set<UUID> ids(JsonNode arr) {
        Set<UUID> out = new HashSet<>();
        arr.forEach(n -> out.add(UUID.fromString((n.isObject() ? n.get("id") : n).asText())));
        return out;
    }

    private static List<UUID> ids(JsonNode arr, String feld) {
        List<UUID> out = new ArrayList<>();
        arr.forEach(n -> out.add(UUID.fromString(n.at("/" + feld + "/id").asText())));
        return out;
    }

    /** Der Beginn der ersten Zuständigkeit der Quelle in der Referenz — ihr Reihenbeginn. */
    private static Instant reihenbeginn(String dq) {
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("datenquelle_box".equals(z.get("art").asText()) && dq.equals(z.get("von").asText())) {
                return OffsetDateTime.parse(z.get("gueltig_ab").asText()).toInstant();
            }
        }
        throw new AssertionError(dq + " hat keine Zuständigkeit in der Referenz");
    }

    private static JsonNode referenzBox(String kz) {
        return eines(referenz.get("boxen"), kz);
    }

    private static JsonNode referenzQuelle(String kz) {
        return eines(referenz.get("datenquellen"), kz);
    }

    private static JsonNode referenzKomponente(String kz) {
        return eines(referenz.get("komponenten"), kz);
    }

    private static JsonNode eines(JsonNode liste, String kz) {
        for (JsonNode n : liste) {
            if (kz.equals(n.get("kennzeichen").asText())) {
                return n;
            }
        }
        throw new AssertionError(kz + " steht nicht im Referenzunternehmen");
    }

    /** Wer ruft: Kunde (Mandant im Token) oder Plattform-Admin mit gewähltem Kundenbereich. */
    private record Wer(String sub, String name, boolean plattform, UUID kundenbereich) {}

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
        return new Antwort(r.getResponse().getStatus(),
                text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    private static String basis(UUID anlage) {
        return "/api/v1/sites/" + anlage + "/data-sources";
    }

    /**
     * Anlage AN-1 aus der Referenz in einem eigenen Kundenbereich: Box Halle 1 mit dem Speicher,
     * K-1 (mit K-2) komponiert an der Box samt PV-Geschwister, der Netzzähler K-3 und die vier
     * Unterzähler K-4 … K-7 hinter dem Gateway — Adresse, Geräte-ID und Takt je aus DQ-1 … DQ-3.
     */
    private Welt halle1(String name) {
        Welt w = new Welt(name);
        UUID an1 = w.anlage("AN-1");
        UUID e1 = w.box("E-1");
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                + "device_id) VALUES (?, ?, 'battery', 200, 100, 100, ?)", w.mandant, an1, e1);
        int n = 0;
        for (String k : List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = referenzKomponente(k);
            JsonNode geraet = eines(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = referenzQuelle(geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt())
                    .put("interval_s", quelle.get("kadenz_s").asInt());
            boolean wechselrichter = "K-1".equals(k);
            String art = wechselrichter ? "battery-hybrid" : "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            // Reihenfolge der Referenz: dieselbe Minute, je eine Sekunde später.
            Instant ab = OffsetDateTime.parse(komponente.get("in_betrieb_ab").asText()).toInstant().plusSeconds(n++);
            w.komponente(k, an1, art, wechselrichter ? e1 : null, "modbus_tcp", wechselrichter ? "sunspec" : null,
                    verbindung.toString(), wechselrichter, komponente.get("name").asText(), ab);
            w.quelleDer.put(k, quelle.get("kennzeichen").asText());
            if (wechselrichter) {
                w.komponente("K-1/PV", an1, "producer", e1, null, null, null, false, null, ab.plusMillis(500));
                w.quelleDer.put("K-1/PV", quelle.get("kennzeichen").asText());
            }
        }
        return w;
    }

    /** Ein Kundenbereich mit Anlagen, Boxen und Komponenten — gesät am Schreibweg vorbei (als Eigentümer). */
    private final class Welt {
        final UUID mandant;
        final Wer jonas;
        final Map<String, UUID> anlagen = new LinkedHashMap<>();
        final Map<String, UUID> boxen = new LinkedHashMap<>();
        final Map<String, UUID> komponenten = new LinkedHashMap<>();
        final Map<String, String> quelleDer = new LinkedHashMap<>();

        Welt(String name) {
            mandant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                    name + " #" + NR.incrementAndGet());
            jonas = new Wer("sub-jonas-" + mandant, "Jonas Wendlinger", false, mandant);
        }

        UUID anlage(String kz) {
            return anlagen.computeIfAbsent(kz, k -> root.queryForObject(
                    "INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, mandant,
                    eines(referenz.get("anlagen"), k).get("name").asText()));
        }

        UUID anlageErfunden(String name) {
            return root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                    mandant, name);
        }

        UUID box(String kz) {
            JsonNode b = referenzBox(kz);
            UUID id = boxErfunden(b.get("name").asText(), anlage(b.get("heimat_anlage").asText()),
                    b.get("in_betrieb_ab").asText());
            boxen.put(kz, id);
            return id;
        }

        UUID boxErfunden(String name, UUID anlage, String seit) {
            return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                    + "created_at) VALUES (?, ?, ?, ?, 'claimed', ?::timestamptz) RETURNING id", UUID.class, mandant,
                    anlage, "VP-TEST-" + NR.incrementAndGet(), name, seit);
        }

        UUID komponente(String kz, UUID anlage, String art, UUID box, String communication, String family,
                String verbindung, boolean steuerbar, String name, Instant ab) {
            UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, control, communication, family, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz) RETURNING id", UUID.class,
                    mandant, anlage, art, name, art, box, steuerbar, communication, family, verbindung, ab.toString());
            komponenten.put(kz, id);
            return id;
        }

        Set<UUID> komponentenDer(String dq) {
            Set<UUID> s = new HashSet<>();
            quelleDer.forEach((k, q) -> {
                if (q.equals(dq)) {
                    s.add(komponenten.get(k));
                }
            });
            return s;
        }

        /** Die Geräte (GR-n) der laufenden Speisung der Komponenten einer Quelle. */
        List<String> geraeteDer(String dq) {
            List<String> ids = new ArrayList<>(texte(komponentenDer(dq)));
            return root.queryForList("SELECT DISTINCT g.kennzeichen FROM geraet_komponente v JOIN geraet g "
                    + "ON g.id = v.geraet_id WHERE v.entity_id::text = ANY(?::text[]) AND v.gueltig_bis IS NULL "
                    + "ORDER BY 1", String.class, "{" + String.join(",", ids) + "}");
        }
    }
}
