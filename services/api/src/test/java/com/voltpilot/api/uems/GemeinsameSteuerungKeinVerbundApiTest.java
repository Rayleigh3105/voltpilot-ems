package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeResult.OpResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.BoxMetrikRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.DokumentZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.context.annotation.Bean;
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
 * Die zweite Hälfte der Abnahme von AP-15 über die echte Kette (IP-8, NW-5, T1–T6): wo KEINE Gemeinsame Steuerung ist,
 * entsteht auch keine. R21 — eine Box, die nur liest, wird kein Mitglied: kein Eintrag in der Gemeinsamen Steuerung,
 * keine Metrik-Reihe, kein Anteil, kein Dokument. T6 Rückrichtung — in einer scharfen Anlage wechselt die Box des
 * Netzzählers, eines Messpunkts oder einer Steuerquelle eines Mitglieds nicht als einfacher Zuständigkeitswechsel
 * (409 {@code gemeinsame_steuerung_aendern}); ohne Gemeinsame Steuerung und vor dem Scharfschalten bleibt der
 * Zuständigkeitswechsel, wie er war. R20 (fremde Anlage abgelehnt) steht in {@link GemeinsameSteuerungApiTest}.
 *
 * <p>Die Welt ist Ahrenberg aus der Referenzdatei 1.5 wie dort: AN-1 „Halle 1“ an NA-1 mit Box Halle 1 (E-1, führt am
 * Netzzähler DQ-2, liest die Steuerquelle DQ-1 und den Unterzähler DQ-3) und Box Verwaltung (E-4, steuert mit am
 * Abgangszähler DQ-10); AN-2 „Halle 2“ an NA-2 desselben Standorts mit Box Halle 2 (E-2). Scharf gestellt wird über die
 * Naht {@link SteuerungsverbundNachweise} (Spion für Fähigkeit, Sprungprobe und Signal; die Auslegung rechnet IP-7
 * echt aus den Geräten, Rückfällen und dem Vorbehalt von R1) und die echte Route der Plattform — dabei rollt IP-7 den
 * Zweischritt aus, und der {@link Draht} fängt jedes Anteils-Dokument. Die Box antwortet auf die Erreichbarkeitsprüfung
 * über einen Stellvertreter von {@link ProbeService#probeBox}, damit ein Zuständigkeitswechsel an nichts anderem
 * scheitert als an der Regel, um die es geht.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GemeinsameSteuerungKeinVerbundApiTest {

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

    /** Der Draht im Test: jedes Anteils-Dokument je Topic (IP-7, Y1) — gesendet wird erst nach dem Commit. */
    @TestConfiguration
    static class Draht {
        static final List<String> TOPICS = java.util.Collections.synchronizedList(new ArrayList<>());

        @Bean
        VerbundAnteileVersand testVersand() {
            return (topic, nutzlast) -> TOPICS.add(topic);
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    BoxMetrikRepository boxMetriken;

    @Autowired
    SteuerungsverbundAnteilRepository anteile;

    @Autowired
    GeraeteRueckfallDienst rueckfaelle;

    @SpyBean
    SteuerungsverbundNachweiseHeute nachweise;

    @MockBean
    ProbeService probes;

    @MockBean
    DatenquelleBudgetService budgets;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID an1, UUID an2, UUID e1, UUID e4, UUID e2, UUID dq1, UUID dq2, UUID dq3,
            UUID dq10) {
        String pfad() {
            return "/api/v1/sites/" + an1 + "/gemeinsame-steuerung";
        }

        String admin() {
            return "/api/v1/admin/sites/" + an1 + "/gemeinsame-steuerung";
        }

        String quelle(UUID dq) {
            return "/api/v1/sites/" + an1 + "/data-sources/" + dq;
        }
    }

    private record Antwort(int status, JsonNode body) {
        String code() {
            return body.path("code").asText();
        }
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    // ============================================================================ R21: Lesen macht kein Mitglied

    /**
     * R21: Box Halle 2 (E-2, Heimat AN-2) liest den Unterzähler DQ-3 aus AN-1 (AP-00 E7). Auch nachdem AN-1 scharf ist
     * und IP-7 die Anteile ausgerollt hat, kennt die Gemeinsame Steuerung von AN-1 sie nicht: kein Mitglied, kein Anteil
     * in der Tabelle, kein Anteils-Dokument auf ihrem Topic, keine Metrik-Reihe — Box Halle 1 und Box Verwaltung
     * bekommen ihres. AN-2 bekommt keine Gemeinsame Steuerung (R20). Und weil DQ-3 weder Messpunkt noch Steuerquelle
     * eines Mitglieds ist, geht sie in der scharfen Anlage wie jede Quelle zurück an E-1.
     */
    @Test
    void r21LesenMachtKeinMitglied() throws Exception {
        Welt w = welt();
        root.update("UPDATE data_source_assignment SET device_id = ? WHERE data_source_id = ?", w.e2(), w.dq3());
        scharf(w);

        JsonNode zustand = kunde(w, get(w.pfad())).body();
        assertThat(zustand.path("zustand").asText()).isEqualTo("anteile_aktiv");
        List<String> mitglieder = new ArrayList<>();
        zustand.path("mitglieder").forEach(m -> mitglieder.add(m.path("box_id").asText()));
        assertThat(mitglieder).containsExactlyInAnyOrder(w.e1().toString(), w.e4().toString());
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_mitglied WHERE device_id = ?",
                Long.class, w.e2())).as("nie ein Mitglied").isZero();

        List<DokumentZeile> dokumente = dokumente(w);
        assertThat(dokumente).as("IP-7 hat ausgerollt").isNotEmpty();
        for (DokumentZeile d : dokumente) {
            assertThat(d.tabelle().boxen()).as("Anteile nur für Mitglieder")
                    .containsExactlyInAnyOrder(w.e1().toString(), w.e4().toString());
        }
        assertThat(Draht.TOPICS).as("Anteils-Dokument an beide Mitglieder").contains(
                VerbundAnteileDokument.topic(w.mandant(), w.an1(), w.e1()),
                VerbundAnteileDokument.topic(w.mandant(), w.an1(), w.e4()));
        assertThat(Draht.TOPICS).as("keines an Box Halle 2").noneMatch(t -> t.contains(w.e2().toString()));
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund WHERE site_id = ?", Long.class,
                w.an2())).as("R20: AN-2 bleibt ohne Gemeinsame Steuerung").isZero();

        List<UUID> mitReihe = new ArrayList<>();
        boxMetriken.boxen(List.of()).stream().filter(b -> w.mandant().equals(b.tenantId()))
                .forEach(b -> mitReihe.add(b.deviceId()));
        assertThat(mitReihe).as("Metrik-Reihen nur für Mitglieder").containsExactlyInAnyOrder(w.e1(), w.e4());

        antwortet(w.e1());
        assertThat(pruefen(w, w.dq3(), w.e1()).status()).isEqualTo(200);
        Antwort zurueck = kunde(w, post(w.quelle(w.dq3()) + "/assignments").content(ziel(w.e1())));
        assertThat(zurueck.status()).as(zurueck.body().toString()).isEqualTo(201);
        assertThat(leser(w.dq3())).isEqualTo(w.e1());
    }

    // ============================================================================ T6 Rückrichtung

    /**
     * T6 (R21 Schritt 3): in der scharfen Anlage wechseln der Netzzähler DQ-2, der Messpunkt DQ-10 und die Steuerquelle
     * DQ-1 ihre Box nicht als Zuständigkeitswechsel — auch nicht, wenn die Prüfung der Ziel-Box bestanden ist, und auch
     * nicht angehalten (die Anteile sind in Kraft). Nichts wird geschrieben. Erst die Änderung der Gemeinsamen Steuerung
     * (hier: Box Verwaltung verlässt sie) gibt DQ-10 frei.
     */
    @Test
    void t6NetzzaehlerMesspunktUndSteuerquelleWechselnInScharferAnlageNurAlsAenderung() throws Exception {
        Welt w = welt();
        scharf(w);
        antwortet(w.e1());
        antwortet(w.e4());
        assertThat(pruefen(w, w.dq2(), w.e4()).status()).isEqualTo(200);
        assertThat(pruefen(w, w.dq10(), w.e1()).status()).isEqualTo(200);
        assertThat(pruefen(w, w.dq1(), w.e4()).status()).isEqualTo(200);
        long zeitraeume = zeitraeume(w);
        long protokoll = protokoll(w);

        gesperrt(w, w.dq2(), w.e4(), "DQ-2");
        gesperrt(w, w.dq10(), w.e1(), "DQ-10");
        gesperrt(w, w.dq1(), w.e4(), "DQ-1");

        assertThat(kunde(w, post(w.pfad() + "/anhalten")).status()).isEqualTo(200);
        gesperrt(w, w.dq2(), w.e4(), "DQ-2");
        gesperrt(w, w.dq10(), w.e1(), "DQ-10");
        assertThat(zeitraeume(w)).as("abgelehnt = nichts geschrieben").isEqualTo(zeitraeume);
        assertThat(protokoll(w)).isEqualTo(protokoll);
        assertThat(leser(w.dq2())).isEqualTo(w.e1());

        Antwort ohneE4 = kunde(w, put(w.pfad()).content("{\"mitglieder\":[{\"box_id\":\"" + w.e1()
                + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\"" + w.dq2() + "\"}]}"));
        assertThat(ohneE4.status()).as(ohneE4.body().toString()).isEqualTo(200);
        Antwort frei = kunde(w, post(w.quelle(w.dq10()) + "/assignments").content(ziel(w.e1())));
        assertThat(frei.status()).as(frei.body().toString()).isEqualTo(201);
        assertThat(leser(w.dq10())).isEqualTo(w.e1());
    }

    /**
     * Bestand: ohne Gemeinsame Steuerung wechselt der Netzzähler wie heute (201, Protokoll {@code
     * zustaendigkeit_gewechselt}) — und ebenso vor dem Scharfschalten (S1): dort sagt die Gemeinsame Steuerung danach
     * nur, was fehlt. Genau das verhindert die Sperre ab S3.
     */
    @Test
    void ohneScharfeGemeinsameSteuerungWechseltDerNetzzaehlerWieHeute() throws Exception {
        Welt ohne = welt();
        antwortet(ohne.e4());
        assertThat(pruefen(ohne, ohne.dq2(), ohne.e4()).status()).isEqualTo(200);
        Antwort a = kunde(ohne, post(ohne.quelle(ohne.dq2()) + "/assignments").content(ziel(ohne.e4())));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        assertThat(a.body().path("urteil").asText()).isEqualTo("erlaubt");
        assertThat(leser(ohne.dq2())).isEqualTo(ohne.e4());
        assertThat(root.queryForList("SELECT art FROM data_source_aenderung WHERE data_source_id = ? ORDER BY id",
                String.class, ohne.dq2())).contains("zustaendigkeit_gewechselt");

        Welt beobachtet = welt();
        einrichten(beobachtet);
        assertThat(stufe(beobachtet)).isEqualTo("beobachtet");
        antwortet(beobachtet.e4());
        assertThat(pruefen(beobachtet, beobachtet.dq2(), beobachtet.e4()).status()).isEqualTo(200);
        Antwort b = kunde(beobachtet, post(beobachtet.quelle(beobachtet.dq2()) + "/assignments")
                .content(ziel(beobachtet.e4())));
        assertThat(b.status()).as(b.body().toString()).isEqualTo(201);
        JsonNode fehlt = kunde(beobachtet, get(beobachtet.pfad())).body().path("fehlt");
        List<String> woerter = new ArrayList<>();
        fehlt.forEach(f -> woerter.add(f.path("wort").asText()));
        assertThat(woerter).contains("fuehrende_box_misst_nicht");
    }

    /**
     * IP-26 (T6): in einer Anlage mit eingerichteter Gemeinsamer Steuerung führt der Wechsel der Steuerquelle nicht mehr
     * auf die AP-06-Sperre {@code steuerquelle} („…erst mit der gemeinsamen Steuerung“ — die gibt es hier schon),
     * sondern auf „Gemeinsame Steuerung ändern“: schon in S1, wo IP-8 den Netzzähler noch einfach wechseln lässt.
     * Ohne Gemeinsame Steuerung ist die Antwort Byte für Byte die alte; die erste Box einer NEUEN Steuerquelle ist kein
     * Wechsel (so entstehen DQ-8/DQ-9 an Box Verwaltung, Ahrenberg 1.5).
     */
    @Test
    void ip26SteuerquelleWechseltInEingerichteterAnlageNurUeberGemeinsameSteuerungAendern() throws Exception {
        Welt ohne = welt();
        antwortet(ohne.e4());
        assertThat(pruefen(ohne, ohne.dq1(), ohne.e4()).status()).isEqualTo(200);
        Antwort alt = kunde(ohne, post(ohne.quelle(ohne.dq1()) + "/assignments").content(ziel(ohne.e4())));
        assertThat(alt.status()).isEqualTo(409);
        assertThat(alt.body().toString()).as("Bestand wortgleich").isEqualTo("{\"code\":\"steuerquelle\","
                + "\"message\":\"Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln\","
                + "\"urteil\":\"abgelehnt\",\"grund\":\"steuerquelle\","
                + "\"satz\":\"Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln\"}");

        Welt w = welt();
        einrichten(w);
        assertThat(stufe(w)).isEqualTo("beobachtet");
        antwortet(w.e4());
        assertThat(pruefen(w, w.dq1(), w.e4()).status()).isEqualTo(200);
        long zeitraeume = zeitraeume(w);
        long protokoll = protokoll(w);
        gesperrt(w, w.dq1(), w.e4(), "DQ-1");
        assertThat(zeitraeume(w)).as("abgelehnt = nichts geschrieben").isEqualTo(zeitraeume);
        assertThat(protokoll(w)).isEqualTo(protokoll);
        assertThat(leser(w.dq1())).isEqualTo(w.e1());

        UUID dq8 = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, steuerquelle, kadenz_s) VALUES (?, ?, 'DQ-8', 'modbus_tcp', '10.0.4.21:502', '{1}', "
                + "true, 10) RETURNING id", UUID.class, w.mandant(), w.an1());
        assertThat(pruefen(w, dq8, w.e4()).status()).isEqualTo(200);
        Antwort neu = kunde(w, post(w.quelle(dq8) + "/assignments").content(ziel(w.e4())));
        assertThat(neu.status()).as("anlegen ist kein Wechsel: " + neu.body()).isEqualTo(201);
        assertThat(leser(dq8)).isEqualTo(w.e4());
    }

    /**
     * Ein zurückgenommener geplanter Wechsel des Netzzählers steht nach seinem Beginn neben dem wieder geöffneten
     * Vorgänger (die Exklusion gilt nur für nicht zurückgenommene). Er liest nie: die Gemeinsame Steuerung sieht weiter
     * E-1 am Netzzähler, und die T6-Sperre urteilt über denselben Leser.
     */
    @Test
    void zurueckgenommenerWechselDesNetzzaehlersLiestNie() throws Exception {
        Welt w = welt();
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from, zurueckgenommen_am, zurueckgenommen_von) SELECT tenant_id, id, ?, protokoll, "
                + "adresse, date_trunc('minute', now()) - interval '1 hour', now() - interval '2 hours', 'test' "
                + "FROM data_source WHERE id = ?", w.e4(), w.dq2());
        Antwort e = einrichten(w);
        List<String> woerter = new ArrayList<>();
        e.body().path("fehlt").forEach(f -> woerter.add(f.path("wort").asText()));
        assertThat(woerter).doesNotContain("fuehrende_box_misst_nicht");
        assertThat(kunde(w, get(w.pfad())).status()).isEqualTo(200);
        allesDa(w);
        Antwort s = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(200);
        antwortet(w.e4());
        assertThat(pruefen(w, w.dq2(), w.e4()).status()).isEqualTo(200);
        gesperrt(w, w.dq2(), w.e4(), "DQ-2");
    }

    // ============================================================================ Gerüst

    private void gesperrt(Welt w, UUID dq, UUID box, String kennzeichen) throws Exception {
        Antwort a = kunde(w, post(w.quelle(dq) + "/assignments").content(ziel(box)));
        assertThat(a.status()).as(kennzeichen + " " + a.body()).isEqualTo(409);
        assertThat(a.code()).isEqualTo("gemeinsame_steuerung_aendern");
        assertThat(a.body().path("kennzeichen").asText()).isEqualTo(kennzeichen);
        assertThat(a.body().path("anlage").asText()).as("der Weg: die Gemeinsame Steuerung dieser Anlage")
                .isEqualTo(w.an1().toString());
        assertThat(a.body().path("message").asText()).isEqualTo(kennzeichen
                + " gehört zur Gemeinsamen Steuerung — ihre Box wechselt nur über „Gemeinsame Steuerung ändern“");
    }

    /** Ahrenberg wie in {@link GemeinsameSteuerungApiTest}, dazu DQ-1 (Steuerquelle) und DQ-3 (Unterzähler) an E-1. */
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Kein Verbund #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                t, u);
        UUID an1 = anlage(t, st1, "Werk Ahrenberg – Halle 1");
        UUID an2 = anlage(t, st1, "Werk Ahrenberg – Halle 2");
        UUID na1 = netzanschluss(t, st1, "NA-1", 630, 550);
        UUID na2 = netzanschluss(t, st1, "NA-2", 250, 200);
        binden(t, an1, na1);
        binden(t, an2, na2);
        root.update("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, einspeisegrenze_kw, "
                + "bezugsgrenze_kw, created_by) VALUES (?, ?, DATE '2024-01-01', 100, 550, 'test')", t, na1);
        UUID e1 = box(t, an1, "E-1-kv-" + nr);
        UUID e4 = box(t, an1, "E-4-kv-" + nr);
        UUID e2 = box(t, an2, "E-2-kv-" + nr);
        UUID dq1 = quelle(t, an1, "DQ-1", "10.0.1.1:502", true, e1);
        UUID dq2 = quelle(t, an1, "DQ-2", "10.0.1.2:502", false, e1);
        UUID dq3 = quelle(t, an1, "DQ-3", "192.168.10.31:502", false, e1);
        UUID dq10 = quelle(t, an1, "DQ-10", "10.0.4.10:502", false, e4);
        return new Welt(t, an1, an2, e1, e4, e2, dq1, dq2, dq3, dq10);
    }

    private static UUID anlage(UUID t, UUID st, String name) {
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, t,
                name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)", t,
                site, st, LocalDate.parse("2024-01-01"));
        return site;
    }

    private static UUID netzanschluss(UUID t, UUID st, String kennzeichen, int kva, int kw) {
        return root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, "
                + "anschluss_kva, vereinbart_kw, messung) VALUES (?, ?, ?, ?, ?, ?, 'RLM') RETURNING id", UUID.class, t,
                st, kennzeichen, "Übergabestation " + kennzeichen, kva, kw);
    }

    private static void binden(UUID t, UUID site, UUID na) {
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", t, site, na);
    }

    private static UUID box(UUID t, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, site, ref);
    }

    private static UUID quelle(UUID t, UUID site, String kennzeichen, String adresse, boolean steuerquelle, UUID box) {
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, steuerquelle, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', ?, 10) RETURNING id",
                UUID.class, t, site, kennzeichen, adresse, steuerquelle);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, date_trunc('minute', now()) - interval '1 day' "
                + "FROM data_source WHERE id = ?", box, dq);
        return dq;
    }

    /** E-1 führt am Netzzähler DQ-2, E-4 steuert mit am Abgangszähler DQ-10 (V-1). */
    private Antwort einrichten(Welt w) throws Exception {
        Antwort a = kunde(w, put(w.pfad()).content("{\"mitglieder\":[{\"box_id\":\"" + w.e1()
                + "\",\"rolle\":\"fuehrt\",\"messpunkt_id\":\"" + w.dq2() + "\"},{\"box_id\":\"" + w.e4()
                + "\",\"rolle\":\"steuert_mit\",\"messpunkt_id\":\"" + w.dq10() + "\"}]}"));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a;
    }

    /** Einrichten, alle Nachweise über die Naht, die Plattform schaltet scharf: S3 (und IP-7 rollt die Anteile aus). */
    private void scharf(Welt w) throws Exception {
        einrichten(w);
        allesDa(w);
        Antwort s = plattform(w, post(w.admin() + "/scharfschalten"));
        assertThat(s.status()).as(s.body().toString()).isEqualTo(200);
        assertThat(stufe(w)).isEqualTo("anteile_aktiv");
    }

    /**
     * Fähigkeit, Sprungprobe und Signal an beiden Boxen über den Spion; die Auslegung rechnet IP-7 echt aus den Geräten
     * von R1 (Einspeisung: E-1 K-1 100 kW → 40, E-4 K-12 60 kW läuft frei; Bezug: E-1 Speicher 100 → 0, E-4 sechs
     * Ladepunkte je 22 → 4,1; Vorbehalt 473) an der Grenze von NA-1 (100 / 550).
     */
    private void allesDa(Welt w) {
        doReturn(true).when(nachweise).faehigkeit(any());
        doReturn(true).when(nachweise).sprungprobe(any(), any());
        doReturn(true).when(nachweise).vorgabeSignal(any(), any());
        UUID verbund = root.queryForObject("SELECT id FROM steuerungsverbund WHERE site_id = ?", UUID.class, w.an1());
        TenantContext.set(w.mandant());
        try {
            anteile.vorbehaltSetzen(verbund, BigDecimal.ZERO, new BigDecimal("473"), "betreiber@voltpilot.test");
            geraet(w, verbund, w.e1(), "pv-generation", Grenzart.EINSPEISUNG, "100", "40");
            geraet(w, verbund, w.e1(), "battery-hybrid", Grenzart.BEZUG, "100", "0");
            geraet(w, verbund, w.e4(), "pv-generation", Grenzart.EINSPEISUNG, "60", null);
            for (int i = 0; i < 6; i++) {
                geraet(w, verbund, w.e4(), "wallbox", Grenzart.BEZUG, "22", "4.1");
            }
        } finally {
            TenantContext.clear();
        }
    }

    private void geraet(Welt w, UUID verbund, UUID box, String rolle, Grenzart richtung, String nenn,
            String rueckfall) {
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, created_at) "
                + "VALUES (?, ?, ?, '2026-01-01T00:00:00Z') RETURNING id", UUID.class, w.mandant(), w.an1(), rolle);
        anteile.geraetEintragen(w.mandant(), verbund, box, k, richtung, new BigDecimal(nenn), true, null, "test");
        if (rueckfall != null) {
            rueckfaelle.hinterlegen(k, richtung, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal(rueckfall),
                    60), null, "installateur@ahrenberg.test");
        }
    }

    private List<DokumentZeile> dokumente(Welt w) {
        UUID verbund = root.queryForObject("SELECT id FROM steuerungsverbund WHERE site_id = ?", UUID.class, w.an1());
        TenantContext.set(w.mandant());
        try {
            return anteile.dokumente(verbund);
        } finally {
            TenantContext.clear();
        }
    }

    /** Die Box besteht die Erreichbarkeitsprüfung. */
    private void antwortet(UUID box) {
        when(probes.probeBox(eq(box), anyList(), any())).thenReturn(Optional.of(new ProbeResult("a1b2c3d4e5f60718",
                null, null, List.of(new OpResult("erreichbarkeit", true, 1.0, List.of(1), 1.0, null, null)))));
    }

    private Antwort pruefen(Welt w, UUID dq, UUID box) throws Exception {
        return kunde(w, post(w.quelle(dq) + "/reachability-check")
                .content("{\"device_id\":\"" + box + "\",\"unit_id\":1,\"register\":0}"));
    }

    private static String ziel(UUID box) {
        return "{\"device_id\":\"" + box + "\"}";
    }

    /** Die Box, die die Quelle jetzt liest (zurückgenommene Zeiträume lesen nie). */
    private static UUID leser(UUID dq) {
        return root.queryForObject("SELECT device_id FROM data_source_assignment WHERE data_source_id = ? "
                + "AND zurueckgenommen_am IS NULL AND effective_from <= now() "
                + "AND (effective_to IS NULL OR effective_to > now())", UUID.class, dq);
    }

    private static long zeitraeume(Welt w) {
        return root.queryForObject("SELECT count(*) FROM data_source_assignment WHERE tenant_id = ?", Long.class,
                w.mandant());
    }

    private static long protokoll(Welt w) {
        return root.queryForObject("SELECT count(*) FROM data_source_aenderung WHERE tenant_id = ?", Long.class,
                w.mandant());
    }

    private static String stufe(Welt w) {
        return root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE site_id = ?", String.class, w.an1());
    }

    private Antwort kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    private Antwort plattform(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return ruf(r.header("X-Tenant-Id", w.mandant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))));
    }

    private Antwort ruf(MockHttpServletRequestBuilder r) throws Exception {
        MvcResult res = mvc.perform(r.contentType(MediaType.APPLICATION_JSON)).andReturn();
        String text = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(res.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
