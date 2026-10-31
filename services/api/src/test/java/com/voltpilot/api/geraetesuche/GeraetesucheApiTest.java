package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.DataSourceStatusListener;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
 * Die Gerätesuche am Anlagenmodell (Paket 3, API; Vertrag {@code docs/contracts/v2/mqtt-geraetesuche.md}, OpenAPI-Tag
 * {@code geraetesuche}): keine echte Box - der Auftrag geht an einen Versand-Doppelgänger, Zwischenstand und Ergebnis
 * baut der Test aus dem Vertrag und gibt sie dem Listener. Geprüft: die vier Routen mit ihren Ablehnungen und der
 * Anfrage-Kennung, der Listener (Identität, Reihenfolge, genau ein Ergebnis, nichts außerhalb der Netze), der Abgleich
 * mit echten Komponenten, OCPP „klopft an“, Mandanten-Zaun und Rechte der Tabellen, das Protokoll mit der Person und
 * der Läufer nach 30 Tagen (DP-3 A).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GeraetesucheApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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

    @Autowired
    GeraetesucheDienst dienst;

    @Autowired
    KlopftAnSpeicher klopftAn;

    @MockBean
    GeraetesucheVersand versand;

    @Autowired
    DeviceRepository geraete;

    @Autowired
    DeviceDataSourceStatusRepository quellenStatus;

    @Autowired
    BoxFaehigkeiten faehigkeiten;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private GeraetesucheListener listener;

    /** Ein Kundenbereich mit einer Anlage, einer suchfähigen Box und einer Box an einer zweiten Anlage. */
    private record Welt(UUID mandant, UUID anlage, UUID box, UUID andereAnlage, UUID andereBox) {
        String pfad() {
            return "/api/v1/sites/" + anlage + "/geraetesuche";
        }

        String topic(String blatt) {
            return "ems/" + mandant + "/" + anlage + "/" + box + "/v2/" + blatt;
        }
    }

    private record Antwort(int status, JsonNode body, MvcResult roh) {
        String code() {
            return body.path("code").asText();
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void vorbereiten() {
        when(versand.senden(anyString(), any())).thenReturn(true);
        listener = new GeraetesucheListener("tcp://unused", "", "", dienst, MAPPER);
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // ============================================================================ Starten

    @Test
    void startenSendetDenAuftragNichtGespeichertMitFristUndOhneNetze() throws Exception {
        Welt w = welt();
        Antwort a = kunde(w, post(w.pfad()).content(koerper(w.box())));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(202);
        assertThat(a.body().path("zustand").asText()).isEqualTo("wartet");
        assertThat(a.body().path("deviceId").asText()).isEqualTo(w.box().toString());
        assertThat(a.body().path("gestartetVon").path("name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(a.body().path("gruppen")).hasSize(6);
        assertThat(a.body().path("erkenner").isNull()).as("noch kein Ergebnis: unbekannt, nie leer").isTrue();
        assertThat(a.body().path("weitere").path("unbekannt").isNull()).isTrue();
        assertThat(a.body().path("ladesaeulenKlopfenAn").isNull()).as("die Box meldet es (noch) nicht").isTrue();
        List<String> gruppen = new ArrayList<>();
        a.body().path("gruppen").forEach(g -> gruppen.add(g.path("gruppe").asText()));
        assertThat(gruppen).isEqualTo(GeraetesucheVertrag.GRUPPEN);

        ArgumentCaptor<String> topic = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<byte[]> nutzlast = ArgumentCaptor.forClass(byte[].class);
        verify(versand).senden(topic.capture(), nutzlast.capture());
        assertThat(topic.getValue()).isEqualTo(w.topic("geraetesuche"));
        JsonNode auftrag = MAPPER.readTree(nutzlast.getValue());
        assertThat(auftrag.path("aktion").asText()).isEqualTo("starten");
        assertThat(auftrag.path("such_id").asText()).isEqualTo(a.body().path("suchId").asText());
        assertThat(auftrag.path("tenant_id").asText()).isEqualTo(w.mandant().toString());
        assertThat(Duration.between(Instant.parse(auftrag.path("ausgeloest_am").asText()),
                Instant.parse(auftrag.path("gueltig_bis").asText()))).isEqualTo(Duration.ofSeconds(120));
        assertThat(auftrag.has("netze")).isFalse();
        assertThat(auftrag.has("erkenner")).as("fehlt = alle Erkenner der Box").isFalse();

        UUID suchId = UUID.fromString(a.body().path("suchId").asText());
        assertThat(root.queryForList("SELECT art, actor_name, actor_art FROM geraetesuche_protokoll WHERE such_id = ?",
                suchId)).singleElement().satisfies(z -> {
                    assertThat(z.get("art")).isEqualTo("gestartet");
                    assertThat(z.get("actor_name")).isEqualTo("Jonas Wendlinger");
                    assertThat(z.get("actor_art")).isEqualTo("kunde");
                });
    }

    @Test
    void dieAblehnungenNennenIhrenGrundUndSchreibenNichts() throws Exception {
        Welt w = welt();
        // Eine fremde Anlage, eine Box an einer anderen Anlage, eine ausgebaute Box: dieselbe 404.
        Welt fremd = welt();
        assertThat(kunde(w, post("/api/v1/sites/" + fremd.anlage() + "/geraetesuche").content(koerper(fremd.box())))
                .code()).isEqualTo("nicht_gefunden");
        Antwort andere = kunde(w, post(w.pfad()).content(koerper(w.andereBox())));
        assertThat(andere.status()).isEqualTo(404);
        assertThat(andere.code()).isEqualTo("nicht_gefunden");
        // Der Körper nennt nur die Box - kein Mandant, kein Netz.
        Antwort mitMandant = kunde(w, post(w.pfad()).content("{\"deviceId\":\"" + w.box() + "\",\"tenantId\":\""
                + fremd.mandant() + "\"}"));
        assertThat(mitMandant.status()).isEqualTo(400);
        assertThat(mitMandant.code()).isEqualTo("anfrage_ungueltig");
        assertThat(kunde(w, post(w.pfad()).content("{\"deviceId\":\"" + w.box() + "\",\"netze\":[\"10.0.0.0/8\"]}"))
                .code()).isEqualTo("anfrage_ungueltig");
        assertThat(kunde(w, post(w.pfad()).content("kein json")).code()).isEqualTo("anfrage_ungueltig");

        // Die Box meldet die Fähigkeit nicht.
        root.update("UPDATE device SET supports = '[\"data_sources\"]'::jsonb WHERE id = ?", w.box());
        Antwort alt = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(alt.status()).isEqualTo(409);
        assertThat(alt.code()).isEqualTo("nicht_unterstuetzt");
        assertThat(alt.body().path("message").asText()).contains("Update nötig für: Gerätesuche");
        root.update("UPDATE device SET supports = '[\"geraetesuche\"]'::jsonb WHERE id = ?", w.box());

        // Seit 6 Minuten kein Herzschlag.
        Instant zuletzt = Instant.now().minus(Duration.ofMinutes(6)).truncatedTo(java.time.temporal.ChronoUnit.SECONDS);
        root.update("UPDATE device SET device_status_seen_at = ? WHERE id = ?", Timestamp.from(zuletzt), w.box());
        Antwort offline = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(offline.status()).isEqualTo(409);
        assertThat(offline.code()).isEqualTo("box_offline");
        assertThat(Instant.parse(offline.body().path("zuletztGesehen").asText())).isEqualTo(zuletzt);
        root.update("UPDATE device SET device_status_seen_at = now() WHERE id = ?", w.box());

        // Erreicht der Auftrag die Box nicht, ist auch nichts angelegt.
        when(versand.senden(anyString(), any())).thenReturn(false);
        assertThat(kunde(w, post(w.pfad()).content(koerper(w.box()))).code()).isEqualTo("box_offline");
        when(versand.senden(anyString(), any())).thenReturn(true);

        assertThat(zeilen(w)).as("keine Ablehnung legt eine Suche an").isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE site_id = ?", Long.class,
                w.anlage())).isZero();
    }

    /**
     * Die Box ist eben gekoppelt, ihr erster Status-Herzschlag steht noch aus: sie holt ihr Zertifikat alle 10-60 s ab
     * und meldet sich 15 s nach dem Verbinden zum ersten Mal - und genau dann bietet „VoltPilot-Box hinzufügen" den
     * Knopf „Geräte suchen" an. Die Fähigkeiten kommen erst mit diesem Herzschlag; bis dahin ist die Box offline, nicht
     * veraltet (vorher: 409 {@code nicht_unterstuetzt} = „Update nötig für: Gerätesuche", ohne „Erneut suchen").
     * Mit dem ersten Herzschlag einer Edge Light (ihre {@code supports} aus den Vertragsvektoren) beginnt die Suche.
     */
    @Test
    void eineEbenGekoppelteBoxIstBisZumErstenHerzschlagOfflineUndSuchtDanach() throws Exception {
        Welt w = welt();
        // So steht die Box nach DeviceRepository#claim da: nie gehört, nichts gemeldet, keine Fassung bekannt.
        root.update("UPDATE device SET supports = NULL, supports_reported_at = NULL, device_status_seen_at = NULL "
                + "WHERE id = ?", w.box());

        Antwort vorher = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(vorher.status()).as(vorher.body().toString()).isEqualTo(409);
        assertThat(vorher.code()).as("nie gehört heißt offline, nicht Update nötig").isEqualTo("box_offline");
        assertThat(vorher.body().path("zuletztGesehen").asText(null)).isNull();
        assertThat(zeilen(w)).isZero();

        new DataSourceStatusListener("tcp://unused", "", "", geraete, quellenStatus, faehigkeiten)
                .handle("ems/" + w.mandant() + "/" + w.anlage() + "/" + w.box() + "/status",
                        MAPPER.writeValueAsBytes(ersterHerzschlagEinerEdgeLight(w)));

        Antwort nachher = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(nachher.status()).as(nachher.body().toString()).isEqualTo(202);
        assertThat(zeilen(w)).isOne();
    }

    @Test
    void eineSucheJeBoxUndHoechstensSechsJeStunde() throws Exception {
        Welt w = welt();
        Antwort erste = kunde(w, post(w.pfad()).content(koerper(w.box())));
        Antwort zweite = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(zweite.status()).isEqualTo(409);
        assertThat(zweite.code()).isEqualTo("laeuft_schon");
        assertThat(zweite.body().path("suchId").asText()).as("Mitansehen").isEqualTo(erste.body().path("suchId").asText());

        // 30 s ohne Meldung: keine Antwort - dann darf neu gesucht werden.
        dienst.uhrStellen(Clock.offset(Clock.systemUTC(), Duration.ofSeconds(31)));
        Antwort still = kunde(w, get(w.pfad() + "/" + erste.body().path("suchId").asText()));
        assertThat(still.body().path("zustand").asText()).isEqualTo("keine_antwort");
        assertThat(kunde(w, post(w.pfad()).content(koerper(w.box()))).status()).isEqualTo(202);

        // Sechs Starts in der Stunde (eine abgelehnte zählt nicht).
        Instant vor = Instant.now().minus(Duration.ofMinutes(50)).truncatedTo(java.time.temporal.ChronoUnit.MICROS);
        for (int i = 0; i < 4; i++) {
            altesErgebnis(w, vor.plusSeconds(i * 60L), "fertig");
        }
        altesErgebnis(w, vor.plusSeconds(400), "abgelehnt");
        dienst.uhrStellen(Clock.offset(Clock.systemUTC(), Duration.ofSeconds(62)));
        Antwort zuOft = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(zuOft.status()).as(zuOft.body().toString()).isEqualTo(429);
        assertThat(zuOft.code()).isEqualTo("zu_oft");
        assertThat(Instant.parse(zuOft.body().path("wiederAb").asText()))
                .as("die sechstjüngste Suche ist die älteste der vier").isEqualTo(
                        vor.plus(Duration.ofHours(1)).truncatedTo(java.time.temporal.ChronoUnit.MICROS));
        assertThat(zuOft.roh().getResponse().getHeader("Retry-After")).matches("[0-9]+");
    }

    @Test
    void dieAnfrageKennungGibtDieselbeAntwortStattEinerZweitenSuche() throws Exception {
        Welt w = welt();
        Antwort a = kunde(w, post(w.pfad()).header("Idempotency-Key", "gs-knopf-0001").content(koerper(w.box())));
        Antwort b = kunde(w, post(w.pfad()).header("Idempotency-Key", "gs-knopf-0001").content(koerper(w.box())));

        assertThat(a.status()).isEqualTo(202);
        assertThat(b.status()).isEqualTo(202);
        assertThat(b.roh().getResponse().getHeader("Idempotent-Replayed")).isEqualTo("true");
        assertThat(b.body().path("suchId")).isEqualTo(a.body().path("suchId"));
        verify(versand, times(1)).senden(anyString(), any());
        assertThat(zeilen(w)).isOne();
        Antwort anders = kunde(w, post(w.pfad()).header("Idempotency-Key", "gs-knopf-0001")
                .content(koerper(w.andereBox())));
        assertThat(anders.status()).isEqualTo(422);
        assertThat(anders.code()).isEqualTo("anfrage_kennung_anders");
        assertThat(kunde(w, post(w.pfad()).header("Idempotency-Key", "kurz").content(koerper(w.box()))).code())
                .isEqualTo("anfrage_kennung_ungueltig");
    }

    @Test
    void imMandantensprungHandeltDiePlattformUndDasProtokollNenntIhrePerson() throws Exception {
        Welt w = welt();
        Antwort a = plattform(w, post(w.pfad()).content(koerper(w.box())));

        assertThat(a.status()).as(a.body().toString()).isEqualTo(202);
        assertThat(a.body().path("gestartetVon").path("art").asText()).isEqualTo("voltpilot");
        assertThat(a.body().path("gestartetVon").path("rolle").asText()).isEqualTo("voltpilot_betrieb");
        assertThat(root.queryForObject("SELECT actor_name FROM geraetesuche_protokoll WHERE site_id = ?",
                String.class, w.anlage())).isEqualTo("VoltPilot Betrieb");
    }

    // ============================================================================ Box-Meldungen und Abgleich

    @Test
    void zwischenstandUndErgebnisSchreibenDieSucheFortUndGleichenMitDenKomponentenAb() throws Exception {
        Welt w = welt();
        // Der Deye hing an .35 (DHCP hat ihn auf .34 gesetzt), der Heizstab-Shelly an .50 ohne Kennung,
        // an der Adresse der go-e hängt eine Wallbox mit anderer Seriennummer.
        UUID wr = komponente(w, "Wechselrichter Dach", "solarman_v5",
                "{\"ip\":\"192.168.178.35\",\"port\":8899,\"serial\":\"3115580613\",\"mb_slave_id\":1}", null);
        komponente(w, "Heizstab", "shelly_http", "{\"ip\":\"192.168.178.50\",\"channel\":0}", null);
        UUID wallbox = komponente(w, "Wallbox Garage", "goe_http_api", "{\"ip\":\"192.168.178.61\"}", "199001");
        UUID suchId = gestartet(w);

        assertThat(listener.handle(w.topic("geraetesuche-stand"), stand(w, suchId, 1, "geraete_erkennen",
                List.of(deye(w))), Instant.now())).isTrue();
        assertThat(listener.handle(w.topic("geraetesuche-stand"), stand(w, suchId, 1, "geraete_erkennen",
                List.of(deye(w))), Instant.now())).as("doppelt zugestellt").isFalse();
        JsonNode laeuft = kunde(w, get(w.pfad() + "/" + suchId)).body();
        assertThat(laeuft.path("zustand").asText()).isEqualTo("laeuft");
        assertThat(laeuft.path("schritt").asText()).isEqualTo("geraete_erkennen");
        assertThat(laeuft.path("restSekunden").asInt()).isEqualTo(20);
        assertThat(laeuft.path("netze").get(0).path("netz").asText()).isEqualTo("192.168.178.0/24");

        ObjectNode e = ergebnis(w, suchId, "fertig", null,
                List.of(deye(w), shelly(w), goe(w), router(w), mitMac(shelly(w), "192.168.178.51"),
                        ausserhalb(w)));
        assertThat(listener.handle(w.topic("geraetesuche-ergebnis"), bytes(e), Instant.now())).isTrue();
        assertThat(listener.handle(w.topic("geraetesuche-ergebnis"), bytes(e), Instant.now()))
                .as("genau ein Ergebnis je Suche").isFalse();

        JsonNode fertig = kunde(w, get(w.pfad() + "/" + suchId)).body();
        assertThat(fertig.path("zustand").asText()).isEqualTo("fertig");
        assertThat(fertig.path("beendetAm").isNull()).isFalse();
        assertThat(fertig.path("dauerMs").asInt()).isEqualTo(38120);
        assertThat(fertig.path("restSekunden").isNull()).isTrue();
        assertThat(fertig.path("weitere").path("unbekannt").asInt()).isEqualTo(4);
        assertThat(fertig.path("weitere").path("telefonTablet").isNull()).as("nicht gezählt, nie 0").isTrue();
        JsonNode hilfe = gruppe(fertig, "braucht_hilfe");
        assertThat(hilfe).hasSize(2);
        JsonNode deyeFund = fund(fertig, "solarman:3115580613");
        assertThat(deyeFund.path("abgleich").asText()).isEqualTo("adresse_geaendert");
        assertThat(deyeFund.path("komponente").path("id").asText()).isEqualTo(wr.toString());
        assertThat(deyeFund.path("bekannteAdresse").asText()).isEqualTo("192.168.178.35");
        assertThat(deyeFund.path("verbindung").path("serial").asLong()).isEqualTo(3115580613L);
        assertThat(deyeFund.path("vorlagen").toString()).contains("builtin:deye:").doesNotContain("shelly");
        assertThat(fund(fertig, "goe:204117").path("abgleich").asText())
                .isEqualTo("anderes_geraet_an_bekannter_adresse");
        assertThat(fund(fertig, "goe:204117").path("komponente").path("id").asText()).isEqualTo(wallbox.toString());
        assertThat(fund(fertig, "shelly:192.168.178.50:80").path("abgleich").asText())
                .isEqualTo("adresse_bekannt_kennung_offen");
        assertThat(gruppe(fertig, "schon_eingerichtet")).hasSize(1);
        assertThat(gruppe(fertig, "bereit")).hasSize(1); // der zweite Shelly an .51, seine MAC überlesen
        assertThat(fund(fertig, "shelly:192.168.178.51:80").path("vorlagen").toString())
                .contains("builtin:shelly:shelly_http");
        assertThat(gruppe(fertig, "weitere")).hasSize(1);
        assertThat(fertig.toString()).doesNotContainIgnoringCase("aa:bb:cc").doesNotContain("10.9.9.9");
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_fund WHERE such_id = ?", Long.class,
                suchId)).as("der Fund außerhalb der Netze ist nie gespeichert").isEqualTo(5);

        JsonNode protokoll = MAPPER.readTree(root.queryForObject("SELECT zaehler::text FROM geraetesuche_protokoll "
                + "WHERE such_id = ? AND art = 'beendet'", String.class, suchId));
        assertThat(protokoll.path("braucht_hilfe").asInt()).isEqualTo(2);
        assertThat(protokoll.path("bereit").asInt()).isEqualTo(1);
        assertThat(protokoll.path("schon_eingerichtet").asInt()).isEqualTo(1);
        assertThat(protokoll.path("weitere").asInt()).isEqualTo(1);

        JsonNode verlauf = kunde(w, get(w.pfad()).param("deviceId", w.box().toString())).body();
        assertThat(verlauf.path("suchen")).hasSize(1);
        assertThat(verlauf.at("/suchen/0/zaehler/braucht_hilfe").asInt()).isEqualTo(2);
        assertThat(verlauf.at("/suchen/0/zaehler").toString()).doesNotContain("schluessel");
    }

    @Test
    void eineMeldungEinerAnderenBoxOderEinesAnderenMandantenWirdVerworfen() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        UUID suchId = gestartet(w);
        // Dieselbe such_id, aber gemeldet von der anderen Box der Anlage.
        String andereBox = "ems/" + w.mandant() + "/" + w.andereAnlage() + "/" + w.andereBox()
                + "/v2/geraetesuche-ergebnis";
        ObjectNode e = ergebnis(w, suchId, "fertig", null, List.of(deye(w)));
        e.put("site_id", w.andereAnlage().toString()).put("device_id", w.andereBox().toString());
        assertThat(listener.handle(andereBox, bytes(e), Instant.now())).isFalse();
        // Ein Topic, das nicht zur Nutzlast passt.
        assertThat(listener.handle(fremd.topic("geraetesuche-ergebnis"), bytes(ergebnis(w, suchId, "fertig", null,
                List.of())), Instant.now())).isFalse();
        assertThat(kunde(w, get(w.pfad() + "/" + suchId)).body().path("zustand").asText()).isEqualTo("wartet");
        // Ein anderer Mandant sieht die Suche nicht.
        assertThat(kunde(fremd, get("/api/v1/sites/" + w.anlage() + "/geraetesuche/" + suchId)).status())
                .isEqualTo(404);
    }

    @Test
    void abbrechenSendetDieVolleSuchIdUndEineBeendeteSucheBleibt() throws Exception {
        Welt w = welt();
        UUID suchId = gestartet(w);
        clearInvocations(versand);

        Antwort a = kunde(w, delete(w.pfad() + "/" + suchId));
        assertThat(a.status()).isEqualTo(202);
        ArgumentCaptor<byte[]> nutzlast = ArgumentCaptor.forClass(byte[].class);
        verify(versand).senden(anyString(), nutzlast.capture());
        JsonNode auftrag = MAPPER.readTree(nutzlast.getValue());
        assertThat(auftrag.path("aktion").asText()).isEqualTo("abbrechen");
        assertThat(auftrag.path("such_id").asText()).isEqualTo(suchId.toString());
        assertThat(auftrag.has("gueltig_bis")).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE such_id = ? AND art = "
                + "'abbruch'", Long.class, suchId)).isOne();

        listener.handle(w.topic("geraetesuche-ergebnis"), bytes(ergebnis(w, suchId, "abgebrochen", "auf_wunsch",
                List.of(deye(w)))), Instant.now());
        clearInvocations(versand);
        Antwort nochmal = kunde(w, delete(w.pfad() + "/" + suchId));
        assertThat(nochmal.status()).isEqualTo(202);
        assertThat(nochmal.body().path("zustand").asText()).isEqualTo("abgebrochen");
        assertThat(nochmal.body().path("grund").asText()).isEqualTo("auf_wunsch");
        verify(versand, never()).senden(anyString(), any());
        assertThat(kunde(w, delete(w.pfad() + "/" + UUID.randomUUID())).code()).isEqualTo("nicht_gefunden");
    }

    @Test
    void abgewieseneLadesaeulenStehenInDerAntwort() throws Exception {
        Welt w = welt();
        UUID suchId = gestartet(w);
        Instant jetzt = Instant.now();
        klopftAn.merken(w.mandant(), w.box(), MAPPER.readTree("{\"chargers\":[],\"rejected\":[{\"id\":\"CP-HALLE1\","
                + "\"ip\":\"192.168.178.80\",\"first_seen\":\"" + jetzt.minusSeconds(3000) + "\",\"last_seen\":\""
                + jetzt.minusSeconds(30) + "\",\"attempts\":50},{\"id\":\"CP-ALT\",\"first_seen\":\""
                + jetzt.minus(Duration.ofHours(30)) + "\",\"last_seen\":\"" + jetzt.minus(Duration.ofHours(25))
                + "\",\"attempts\":3}]}"), jetzt);

        JsonNode s = kunde(w, get(w.pfad() + "/" + suchId)).body();
        assertThat(s.path("ladesaeulenKlopfenAn")).hasSize(1);
        assertThat(s.at("/ladesaeulenKlopfenAn/0/chargePointId").asText()).isEqualTo("CP-HALLE1");
        assertThat(s.at("/ladesaeulenKlopfenAn/0/ip").asText()).isEqualTo("192.168.178.80");
        assertThat(s.at("/ladesaeulenKlopfenAn/0/versuche").asInt()).isEqualTo(50);
        klopftAn.vergessen(w.box());
        assertThat(kunde(w, get(w.pfad() + "/" + suchId)).body().path("ladesaeulenKlopfenAn").isNull()).isTrue();
    }

    // ============================================================================ Tabellen und Läufer

    @Test
    void dieTabellenTragenMandantenzaunUndDasProtokollIstNurAnfuegend() {
        for (String t : List.of("geraetesuche", "geraetesuche_fund", "geraetesuche_protokoll")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, t)).as(t).isTrue();
            assertThat(root.queryForList("SELECT column_name FROM information_schema.columns WHERE table_name = ?",
                    String.class, t)).as(t + ": keine MAC, kein Hostname")
                    .noneMatch(c -> c.contains("mac") || c.contains("host") || c.contains("name") && !c.startsWith("actor"));
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND permissive = "
                    + "'RESTRICTIVE'", Long.class, t)).as(t + ": Standort-Zaun").isOne();
        }
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'geraetesuche', 'DELETE')", Boolean.class,
                APP_USER)).isFalse();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'geraetesuche_protokoll', 'UPDATE') OR "
                + "has_table_privilege(?, 'geraetesuche_protokoll', 'DELETE')", Boolean.class, APP_USER, APP_USER))
                .isFalse();
    }

    @Test
    void derLaeuferLoeschtSuchenUndFundeNach30TagenUndDasProtokollBleibt() throws Exception {
        Welt w = welt();
        UUID alt = UUID.randomUUID();
        Instant vor31 = Instant.now().minus(Duration.ofDays(31));
        root.update("INSERT INTO geraetesuche (id, tenant_id, site_id, device_id, ausgeloest_am, gueltig_bis, "
                + "actor_name, actor_art, zustand, beendet_am) VALUES (?, ?, ?, ?, ?, ?, 'Jonas', 'kunde', 'fertig', ?)",
                alt, w.mandant(), w.anlage(), w.box(), Timestamp.from(vor31), Timestamp.from(vor31.plusSeconds(120)),
                Timestamp.from(vor31.plusSeconds(40)));
        root.update("INSERT INTO geraetesuche_fund (such_id, tenant_id, site_id, schluessel, erkenner, art, erkennung, "
                + "merkmale, anbindung, ip, port, liest_box_schon, gemeldet_am) VALUES (?, ?, ?, 'goe:1', 'goe', "
                + "'wallbox', 'sicher', '{api_status}', 'uebernehmen', '192.168.178.61', 80, false, ?)", alt,
                w.mandant(), w.anlage(), Timestamp.from(vor31));
        root.update("INSERT INTO geraetesuche_protokoll (tenant_id, site_id, device_id, such_id, art, actor_name, "
                + "actor_art, am) VALUES (?, ?, ?, ?, 'gestartet', 'Jonas', 'kunde', ?)", w.mandant(), w.anlage(),
                w.box(), alt, Timestamp.from(vor31));
        UUID neu = gestartet(w);

        assertThat(dienst.aufraeumen()).isGreaterThanOrEqualTo(1);

        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche WHERE id = ?", Long.class, alt)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_fund WHERE such_id = ?", Long.class, alt))
                .isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche WHERE id = ?", Long.class, neu)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM geraetesuche_protokoll WHERE such_id = ?", Long.class,
                alt)).as("das Protokoll bleibt").isOne();
        assertThatThrownBy(() -> root.queryForObject("SELECT geraetesuche_aufraeumen(now() - interval '1 day')",
                Integer.class)).as("nie jünger als 30 Tage").hasMessageContaining("30 Tagen");
    }

    // ============================================================================ Hilfen

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Gerätesuche #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Haus Weber') RETURNING id",
                UUID.class, t);
        UUID andere = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Garage') RETURNING id",
                UUID.class, t);
        return new Welt(t, anlage, box(t, anlage, "GS-" + nr), andere, box(t, andere, "GS-ANDERE-" + nr));
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, supports, "
                + "supports_reported_at, device_status_seen_at, lan_host, lan_source, lan_seen_at) VALUES (?, ?, ?, "
                + "'[\"geraetesuche\"]'::jsonb, now(), now(), '192.168.178.20', 'schnittstelle', now()) RETURNING id",
                UUID.class, t, site, ref);
    }

    private static UUID komponente(Welt w, String name, String communication, String verbindung, String seriennummer) {
        UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, communication, "
                + "connection_json, device_id) VALUES (?, ?, 'pv-generation', ?, ?, ?::jsonb, ?) RETURNING id",
                UUID.class, w.mandant(), w.anlage(), name, communication, verbindung, w.box());
        if (seriennummer != null) {
            // Jede Komponente bekommt ihr Gerät beim Anlegen (geraet_komponente); hier trägt es die Seriennummer.
            assertThat(root.update("UPDATE geraet SET seriennummer = ? WHERE id = (SELECT geraet_id FROM "
                    + "geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL)", seriennummer, id)).isOne();
        }
        return id;
    }

    private UUID gestartet(Welt w) throws Exception {
        Antwort a = kunde(w, post(w.pfad()).content(koerper(w.box())));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(202);
        return UUID.fromString(a.body().path("suchId").asText());
    }

    /** Eine beendete Suche in der Vergangenheit (für die Grenze je Stunde). */
    private static void altesErgebnis(Welt w, Instant am, String zustand) {
        root.update("INSERT INTO geraetesuche (id, tenant_id, site_id, device_id, ausgeloest_am, gueltig_bis, "
                + "actor_name, actor_art, zustand, grund, beendet_am) VALUES (?, ?, ?, ?, ?, ?, 'Jonas', 'kunde', ?, ?, "
                + "?)", UUID.randomUUID(), w.mandant(), w.anlage(), w.box(), Timestamp.from(am),
                Timestamp.from(am.plusSeconds(120)), zustand, "abgelehnt".equals(zustand) ? "zu_oft" : null,
                Timestamp.from(am.plusSeconds(30)));
    }

    private static long zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM geraetesuche WHERE device_id = ?", Long.class, w.box());
    }

    /** Der Status-Herzschlag einer Edge Light: {@code supports} ohne die Palette-Wörter ({@code box_arten}). */
    private static ObjectNode ersterHerzschlagEinerEdgeLight(Welt w) throws Exception {
        JsonNode vektoren = MAPPER.readTree(Files.readString(Path.of("../../docs/contracts/v2/edge-supports-vectors.json")));
        ObjectNode herzschlag = MAPPER.createObjectNode().put("schema_version", "1.0")
                .put("tenant_id", w.mandant().toString()).put("site_id", w.anlage().toString())
                .put("device_id", w.box().toString()).put("ts", Instant.now().toString()).put("online", true)
                .put("version", "edge-light-ge78a7722b");
        ArrayNode supports = herzschlag.putArray("supports");
        for (JsonNode f : vektoren.path("capabilities")) {
            boolean beideArten = !f.has("box_arten");
            boolean edgeLight = beideArten || f.path("box_arten").toString().contains("\"edge_light\"");
            if (f.path("advertised").asBoolean() && edgeLight) supports.add(f.path("name").asText());
        }
        assertThat(supports.toString()).contains("\"geraetesuche\"").doesNotContain("erzeuger_registerbild");
        return herzschlag;
    }

    private static String koerper(UUID box) {
        return "{\"deviceId\":\"" + box + "\"}";
    }

    private static ObjectNode huelle(Welt w, UUID suchId) {
        return MAPPER.createObjectNode().put("schema_version", "1.0").put("tenant_id", w.mandant().toString())
                .put("site_id", w.anlage().toString()).put("device_id", w.box().toString())
                .put("such_id", suchId.toString()).put("ts", Instant.now().toString());
    }

    private static ArrayNode netze() {
        ArrayNode n = MAPPER.createArrayNode();
        n.addObject().put("rolle", "kundennetz").put("netz", "192.168.178.0/24").put("box_adresse", "192.168.178.20")
                .put("erreichbar", true).put("aktiv", 9);
        return n;
    }

    private static byte[] stand(Welt w, UUID suchId, int nr, String schritt, List<ObjectNode> funde) {
        ObjectNode s = huelle(w, suchId).put("nr", nr).put("schritt", schritt).put("erledigt", 120)
                .put("gesamt", 254).put("rest_s", 20);
        s.set("netze", netze());
        s.putArray("funde").addAll(funde);
        return bytes(s);
    }

    private static ObjectNode ergebnis(Welt w, UUID suchId, String zustand, String grund, List<ObjectNode> funde) {
        ObjectNode e = huelle(w, suchId).put("zustand", zustand).put("dauer_ms", 38120);
        if (grund != null) {
            e.put("grund", grund);
        }
        e.putArray("erkenner").add("solarman").add("shelly").add("goe").add("netztechnik").add("modbus_offen");
        e.set("netze", netze());
        e.putArray("funde").addAll(funde);
        e.putObject("weitere").put("unbekannt", 4);
        return e;
    }

    private static ObjectNode fund(String schluessel, String erkenner, String art, String hersteller,
            String anbindung, String ip, int port, String communication, String... merkmale) {
        ObjectNode f = MAPPER.createObjectNode().put("schluessel", schluessel).put("erkenner", erkenner)
                .put("art", art).put("hersteller", hersteller).put("erkennung", "sicher").put("anbindung", anbindung)
                .put("liest_box_schon", false);
        ArrayNode m = f.putArray("merkmale");
        for (String merkmal : merkmale) {
            m.add(merkmal);
        }
        ObjectNode v = f.putObject("verbindung").put("ip", ip).put("port", port);
        if (communication != null) {
            v.put("communication", communication);
        }
        return f;
    }

    private static ObjectNode deye(Welt w) {
        ObjectNode f = fund("solarman:3115580613", "solarman", "wechselrichter", "deye", "uebernehmen",
                "192.168.178.34", 8899, "solarman_v5", "v5_kopf_seriennummer", "deye_typ_0x0006");
        f.put("familie", "hybrid_3p").put("seriennummer", "2409066698");
        ((ObjectNode) f.path("verbindung")).put("serial", 3115580613L).put("unit_id", 1);
        return f;
    }

    private static ObjectNode shelly(Welt w) {
        return fund("shelly:192.168.178.50:80", "shelly", "schaltaktor", "shelly", "uebernehmen", "192.168.178.50",
                80, "shelly_http", "shelly_endpunkt");
    }

    private static ObjectNode goe(Welt w) {
        return fund("goe:204117", "goe", "wallbox", "go-e", "uebernehmen", "192.168.178.61", 80, "goe_http_api",
                "goe_api_status").put("seriennummer", "204117");
    }

    private static ObjectNode router(Welt w) {
        ObjectNode f = fund("netztechnik:192.168.178.1:80", "netztechnik", "router", "avm", "nur_anzeige",
                "192.168.178.1", 80, null, "http_server_kopf");
        f.put("erkennung", "wahrscheinlich");
        return f;
    }

    /** DP-3 A: eine fehlerhafte Box sendet doch eine MAC - die API überliest das Feld (Fall fund_mit_mac). */
    private static ObjectNode mitMac(ObjectNode f, String ip) {
        f.put("schluessel", "shelly:" + ip + ":80").put("mac", "aa:bb:cc:dd:ee:ff");
        ((ObjectNode) f.path("verbindung")).put("ip", ip);
        return f;
    }

    /** Eine Adresse außerhalb der gemeldeten Netze: der Fund wird überlesen, nie gespeichert. */
    private static ObjectNode ausserhalb(Welt w) {
        return fund("goe:999", "goe", "wallbox", "go-e", "uebernehmen", "10.9.9.9", 80, "goe_http_api",
                "goe_api_status");
    }

    private static byte[] bytes(JsonNode n) {
        return n.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static JsonNode gruppe(JsonNode suche, String name) {
        for (JsonNode g : suche.path("gruppen")) {
            if (name.equals(g.path("gruppe").asText())) {
                return g.path("funde");
            }
        }
        throw new AssertionError(name);
    }

    private static JsonNode fund(JsonNode suche, String schluessel) {
        for (JsonNode g : suche.path("gruppen")) {
            for (JsonNode f : g.path("funde")) {
                if (schluessel.equals(f.path("schluessel").asText())) {
                    return f;
                }
            }
        }
        throw new AssertionError(schluessel + " in " + suche);
    }

    /** Der Kundenadministrator (Token mit Mandant, ohne Plattform-Rolle). */
    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    /** VoltPilot-Betrieb im Mandantensprung ({@code X-Tenant-Id}). */
    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode body;
        try {
            body = text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text);
        } catch (Exception e) {
            body = NullNode.getInstance();
        }
        return new Antwort(res.getResponse().getStatus(), body, res);
    }
}
