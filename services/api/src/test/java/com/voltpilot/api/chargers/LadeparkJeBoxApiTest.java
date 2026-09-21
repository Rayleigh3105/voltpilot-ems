package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.LadeparkJeBox;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.LadeparkRahmenDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.WallboxDto;
import com.voltpilot.api.web.dto.FahrzeugDto.VehicleProfileDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.invocation.Invocation;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-15 IP-16 — Rangliste und Ladepark über Boxen (P6, W6, E4 = A), gegen eine echte Datenbank.
 *
 * <p>R3: die Box Verwaltung bekommt IHREN Ausschnitt der Rangliste (sechs Ladepunkte, Ränge der Anlage) und — wie
 * jede Box — die Netzgrenze der Anlage; ihr Anteil (77 kW) reist nur im Anteils-Dokument (Y1, IP-19 rechnet
 * min(heute, Anteil)). Die Box Halle 1 behält, was sie heute bekäme. Eine Anteils-Änderung löst kein Ladepark-Dokument
 * aus, eine Grenzblatt-Änderung erreicht beide Boxen. W6: Umsortieren lässt beide Dokumente reisen, die
 * Anteile bleiben. R14: unscharf bleibt die 422 „zweite Box für Ladepunkte“; scharf fällt sie, angehalten bleibt sie
 * für eine NEUE Box, die Ladepunkte an der zweiten Box verwaisen aber nicht. NW-6/R22: ohne scharfe oder angehaltene
 * Gemeinsame Steuerung ist das Dokument Byte für Byte das von heute (Paarbeweis mit und ohne IP-16-Bohne).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LadeparkJeBoxApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Instant FEST = Instant.parse("2027-06-15T08:00:00Z");
    private static final List<String> VERWALTUNG = List.of("AHR-LP-02", "AHR-LP-03", "AHR-LP-04", "AHR-LP-05",
            "AHR-LP-06", "AHR-LP-07");

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
    ChargingConfigService ladepark;

    @Autowired
    LadeparkJeBox verbund;

    @MockBean
    ChargingConfigPublisher publisher;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    /** AN-1 mit Box Halle 1 (E-1) und Box Verwaltung (E-4); Rahmen 550 kW, keine Bindung (Netzgrenze = Rahmen). */
    private record Welt(UUID mandant, UUID an1, UUID halle1, UUID verwaltung) {}

    /** Eine Zustellung: Box und die Felder des Dokuments, wie sie der Publisher bekam. */
    private record Zustellung(UUID box, Double grenze, List<String> vorrang, List<AllowedChargePointDto> saeulen,
            Integer speicherRang, byte[] bytes) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void zustellungGelingt() {
        when(publisher.publish(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(Instant.class))).thenReturn(true);
    }

    @AfterEach
    void aufraeumen() {
        ladepark.verbundLesen(verbund);
        TenantContext.clear();
    }

    // ============================================================================ R3

    /** R3: Box Verwaltung — sechs Ladepunkte in der Reihenfolge der Anlage; die Grenze ist die der Anlage. */
    @Test
    void r3DieBoxVerwaltungBekommtIhrenAusschnittDieBoxHalle1BleibtWieHeute() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        verbund(w, "anteile_aktiv", 77.0);

        List<Zustellung> z = republish(w);

        assertThat(z).extracting(Zustellung::box).containsExactlyInAnyOrder(w.halle1(), w.verwaltung());
        Zustellung vw = an(z, w.verwaltung());
        assertThat(vw.grenze()).as("Netzgrenze der Anlage; der Anteil 77 kW reist nur im Anteils-Dokument")
                .isEqualTo(550.0);
        assertThat(vw.saeulen()).extracting(AllowedChargePointDto::chargePointId)
                .containsExactlyInAnyOrderElementsOf(VERWALTUNG);
        assertThat(reihenfolge(vw.saeulen())).as("Reihenfolge = Reihenfolge der Anlage")
                .containsExactly("AHR-LP-02", "AHR-LP-03", "AHR-LP-04", "AHR-LP-05", "AHR-LP-06", "AHR-LP-07");
        assertThat(vw.saeulen()).extracting(AllowedChargePointDto::rank).containsExactly(1, 2, 4, 5, 6, 7);
        assertThat(vw.vorrang()).containsExactly("AHR-LP-02", "AHR-LP-03");
        assertThat(vw.speicherRang()).as("der Speicher bleibt EIN Eintrag der Anlage").isEqualTo(3);

        Zustellung h1 = an(z, w.halle1());
        assertThat(h1.grenze()).as("führende Box: Netzgrenze wie heute").isEqualTo(550.0);
        assertThat(h1.saeulen()).as("keine Säule der Verwaltung an Box Halle 1").isEmpty();
        assertThat(h1.vorrang()).isEmpty();
        assertThat(h1.speicherRang()).isEqualTo(3);
    }

    // ============================================================================ W6

    /** W6: der Kunde sortiert um — beide Dokumente reisen, Reihenfolge je Box = die neue der Anlage, Anteile bleiben. */
    @Test
    void w6NachDemUmsortierenReisenBeideDokumenteInDerNeuenReihenfolgeUndDerAnteilBleibt() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        verbund(w, "anteile_aktiv", 77.0);
        String anteileVorher = anteile(w);
        clearInvocations(publisher);

        Map<String, Integer> neu = new LinkedHashMap<>();
        neu.put("AHR-LP-07", 1);
        neu.put("AHR-LP-06", 2);
        neu.put("AHR-LP-05", 3);
        neu.put("AHR-LP-04", 5);
        neu.put("AHR-LP-03", 6);
        neu.put("AHR-LP-02", 7);
        TenantContext.set(w.mandant());
        ladepark.saveRangliste(w.an1(), null, null, neu, 4, "Jonas Wendlinger");
        TenantContext.clear();

        List<Zustellung> z = zustellungen(w);
        assertThat(z).extracting(Zustellung::box).containsExactlyInAnyOrder(w.halle1(), w.verwaltung());
        Zustellung vw = an(z, w.verwaltung());
        assertThat(reihenfolge(vw.saeulen())).containsExactly("AHR-LP-07", "AHR-LP-06", "AHR-LP-05", "AHR-LP-04",
                "AHR-LP-03", "AHR-LP-02");
        assertThat(vw.grenze()).isEqualTo(550.0);
        assertThat(an(z, w.halle1()).speicherRang()).isEqualTo(4);
        assertThat(anteile(w)).as("Anteile werden nie aus der Rangliste abgeleitet").isEqualTo(anteileVorher);
    }

    // ============================================================================ 422 je Stufe

    /** R14: unscharf (geprüft) bleibt die 422 „zweite Box für Ladepunkte“. */
    @Test
    void r14UnscharfBleibtDie422() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        verbund(w, "geprueft", 77.0);

        assertThatThrownBy(() -> anbinden(w, "HL-01", w.halle1()))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                    assertThat(e.getReason()).contains("Eine zweite Box für Ladepunkte ist erst mit der gemeinsamen");
                });
    }

    /** Scharf fällt die 422: die Säule an Box Halle 1 reist nur in IHREM Dokument, nicht an die Verwaltung. */
    @Test
    void scharfFaelltDie422UndDieNeueSaeuleReistNurAnIhreBox() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        verbund(w, "anteile_aktiv", 77.0);
        clearInvocations(publisher);

        anbinden(w, "HL-01", w.halle1());

        List<Zustellung> z = zustellungen(w);
        assertThat(z).extracting(Zustellung::box).containsExactly(w.halle1());
        assertThat(z.get(0).saeulen()).extracting(AllowedChargePointDto::chargePointId).containsExactly("HL-01");
    }

    /** Eine Box, die in der Gemeinsamen Steuerung nicht mitmacht (T6: sie liest), bekommt keine Ladepunkte. */
    @Test
    void eineLesendeBoxBekommtAuchScharfKeineLadepunkte() throws Exception {
        Welt w = welt();
        verbund(w, "anteile_aktiv", 77.0);
        UUID lesebox = box(w.mandant(), w.an1(), "lesebox-" + NR.incrementAndGet());

        assertThatThrownBy(() -> anbinden(w, "HL-02", lesebox))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                    assertThat(e.getReason()).contains("liest in der Gemeinsamen Steuerung nur");
                });
    }

    /**
     * Angehalten (§3.9/§5.5: die Anteile bleiben in Kraft): die Ladepunkte an Box Verwaltung werden weiter je Box
     * bedient — nicht verwaist wie bei zwei belegten Boxen ohne Gemeinsame Steuerung —, eine NEUE Box bleibt abgelehnt.
     */
    @Test
    void angehaltenBleibenDieLadepunkteBedientUndEineNeueZweiteBoxAbgelehnt() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        melden(w, w.halle1(), "HL-01", null);
        verbund(w, "angehalten", 77.0);

        List<Zustellung> z = republish(w);
        assertThat(z).extracting(Zustellung::box).containsExactlyInAnyOrder(w.halle1(), w.verwaltung());
        assertThat(an(z, w.verwaltung()).saeulen()).hasSize(6);
        assertThat(an(z, w.halle1()).saeulen()).extracting(AllowedChargePointDto::chargePointId)
                .containsExactly("HL-01");

        root.update("DELETE FROM device_charge_point WHERE device_id = ?", w.halle1());
        root.update("DELETE FROM site_charge_point_allowlist WHERE charge_point_id = 'HL-01'");
        assertThatThrownBy(() -> anbinden(w, "HL-03", w.halle1()))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                    assertThat(e.getReason()).contains("ist angehalten");
                });
        anbinden(w, "AHR-LP-08", w.verwaltung());
    }

    // ============================================================================ Anstoß je Box

    /** Der Anteil der Verwaltung ändert sich (Übergang auf 60 kW gesendet): KEIN neues Ladepark-Dokument (Y1). */
    @Test
    void eineAnteilsAenderungLoestKeinLadeparkDokumentAus() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        UUID v = verbund(w, "anteile_aktiv", 77.0);
        republish(w);
        clearInvocations(publisher);

        dokument(w, v, 2, 60.0);
        root.update("UPDATE steuerungsverbund_mitglied SET gesendet_revision = 2 WHERE device_id = ?",
                w.verwaltung());
        TenantContext.set(w.mandant());
        try {
            assertThat(ladepark.netzgrenzeNachziehen(w.mandant(), w.an1())).isFalse();
        } finally {
            TenantContext.clear();
        }
        assertThat(zustellungen(w)).isEmpty();
    }

    /** Eine Grenzblatt-Fassung (Bezug 500 kW) am gebundenen Netzanschluss erreicht BEIDE Boxen, danach ist es still. */
    @Test
    void eineGrenzblattAenderungErreichtBeideBoxen() throws Exception {
        Welt w = welt();
        verwaltungMeldetIhreSaeulen(w);
        verbund(w, "anteile_aktiv", 77.0);
        UUID st1 = standort(w);
        String anschluesse = "/api/v1/standorte/" + st1 + "/netzanschluesse";
        Map<String, Object> na = new LinkedHashMap<>();
        na.put("kennzeichen", "NA-1");
        na.put("name", "Übergabestation NA-1");
        na.put("malo", "47110000001");
        na.put("netzbetreiber", "Netzgesellschaft Ahrental (fiktiv)");
        na.put("anschluss_kva", 630);
        na.put("vereinbart_kw", 550);
        na.put("messung", "RLM");
        String na1 = ruf(w, HttpMethod.POST, anschluesse, na, 201).get("id").asText();
        Map<String, Object> fassung = new LinkedHashMap<>();
        fassung.put("gueltig_ab", heute().minusDays(1).toString());
        fassung.put("einspeisegrenze_kw", null);
        fassung.put("bezugsgrenze_kw", 500);
        ruf(w, HttpMethod.POST, anschluesse + "/" + na1 + "/grenzen", fassung, 201);
        clearInvocations(publisher);

        ruf(w, HttpMethod.POST, anschluesse + "/" + na1 + "/anlagen",
                Map.of("anlage_id", w.an1().toString(), "gueltig_ab", heute().minusDays(30).toString()), 201);

        List<Zustellung> z = zustellungen(w);
        assertThat(z).extracting(Zustellung::box).containsExactlyInAnyOrder(w.halle1(), w.verwaltung());
        assertThat(z).extracting(Zustellung::grenze).containsOnly(500.0);
        clearInvocations(publisher);
        TenantContext.set(w.mandant());
        try {
            assertThat(ladepark.netzgrenzeNachziehen(w.mandant(), w.an1())).as("an alle zugestellt = still").isFalse();
        } finally {
            TenantContext.clear();
        }
        assertThat(zustellungen(w)).isEmpty();
    }

    // ============================================================================ NW-6 / R22

    /**
     * Paarbeweis: Ein-Box-Anlage ohne Gemeinsame Steuerung und Zwei-Box-Anlage mit Gemeinsamer Steuerung in S2 — das
     * Dokument ist mit IP-16 Byte für Byte dasselbe wie ohne (dieselben Empfänger, dieselben Felder).
     */
    @Test
    void nw6OhneScharfeGemeinsameSteuerungIstDasDokumentByteGleich() throws Exception {
        Welt eine = welt();
        root.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = now() WHERE id = ?", eine.verwaltung());
        melden(eine, eine.halle1(), "HL-01", 1);
        paar(eine, "Ein-Box-Anlage");

        Welt zwei = welt();
        verwaltungMeldetIhreSaeulen(zwei);
        verbund(zwei, "geprueft", 77.0);
        paar(zwei, "Zwei-Box-Anlage, Gemeinsame Steuerung geprüft");

        Welt ohne = welt();
        verwaltungMeldetIhreSaeulen(ohne);
        paar(ohne, "Zwei-Box-Anlage ohne Gemeinsame Steuerung");
    }

    private void paar(Welt w, String fall) throws Exception {
        ladepark.verbundLesen(null);
        List<Zustellung> vorher = republish(w);
        ladepark.verbundLesen(verbund);
        List<Zustellung> nachher = republish(w);
        assertThat(vorher).as(fall).isNotEmpty();
        assertThat(nachher).as(fall).hasSameSizeAs(vorher);
        for (int i = 0; i < vorher.size(); i++) {
            assertThat(nachher.get(i).box()).as(fall).isEqualTo(vorher.get(i).box());
            assertThat(nachher.get(i).bytes()).as(fall).isEqualTo(vorher.get(i).bytes());
        }
    }

    // ============================================================================ Gerüst

    private List<Zustellung> republish(Welt w) {
        clearInvocations(publisher);
        TenantContext.set(w.mandant());
        try {
            ladepark.republishForSite(w.mandant(), w.an1());
        } finally {
            TenantContext.clear();
        }
        return zustellungen(w);
    }

    private void anbinden(Welt w, String id, UUID box) {
        TenantContext.set(w.mandant());
        try {
            ladepark.admit(w.an1(), id, null, 22.0, 1, null, null, null, box, "Jonas Wendlinger");
        } finally {
            TenantContext.clear();
        }
    }

    @SuppressWarnings("unchecked")
    private List<Zustellung> zustellungen(Welt w) {
        List<Zustellung> z = new ArrayList<>();
        for (Invocation i : mockingDetails(publisher).getInvocations()) {
            if (!i.getMethod().getName().equals("publish") || !w.an1().equals(i.getArgument(1))) {
                continue;
            }
            byte[] bytes = ChargingConfigPublisher.document(i.getArgument(0), i.getArgument(1), i.getArgument(2),
                    i.getArgument(3), i.getArgument(4), i.getArgument(5), i.getArgument(6), i.getArgument(7),
                    i.getArgument(8), (LadeparkRahmenDto) i.getArgument(9), i.getArgument(10),
                    (List<WallboxDto>) i.getArgument(11), (List<VehicleProfileDto>) i.getArgument(12), FEST);
            List<AllowedChargePointDto> saeulen = i.getArgument(7);
            z.add(new Zustellung(i.getArgument(2), i.getArgument(3), i.getArgument(4),
                    saeulen == null ? List.of() : saeulen, i.getArgument(10), bytes));
        }
        return z;
    }

    private static Zustellung an(List<Zustellung> z, UUID box) {
        return z.stream().filter(x -> x.box().equals(box)).findFirst().orElseThrow();
    }

    private static List<String> reihenfolge(List<AllowedChargePointDto> saeulen) {
        return saeulen.stream().sorted(Comparator.comparing(AllowedChargePointDto::rank))
                .map(AllowedChargePointDto::chargePointId).toList();
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "IP-16 #" + nr);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID halle1 = box(t, an1, "ip16-halle1-" + nr);
        UUID verwaltung = box(t, an1, "ip16-verwaltung-" + nr);
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw, storage_rank) "
                + "VALUES (?, ?, 550, 3)", an1, t);
        return new Welt(t, an1, halle1, verwaltung);
    }

    private static UUID box(UUID t, UUID site, String ref) {
        UUID id = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, ?, 'claimed')",
                id, t, site, ref);
        return id;
    }

    /** R3: die sechs Säulen der Verwaltung, zugelassen, gemeldet, gerankt (Speicher auf Rang 3), zwei mit Vorrang. */
    private void verwaltungMeldetIhreSaeulen(Welt w) {
        int[] raenge = {1, 2, 4, 5, 6, 7};
        for (int i = 0; i < VERWALTUNG.size(); i++) {
            melden(w, w.verwaltung(), VERWALTUNG.get(i), raenge[i]);
        }
        for (String id : List.of("AHR-LP-02", "AHR-LP-03")) {
            root.update("INSERT INTO site_charge_point_priority (site_id, charge_point_id, tenant_id) VALUES (?,?,?)",
                    w.an1(), id, w.mandant());
        }
    }

    private void melden(Welt w, UUID box, String id, Integer rang) {
        root.update("INSERT INTO site_charge_point_allowlist (site_id, charge_point_id, tenant_id, rated_kw, "
                + "connectors) VALUES (?, ?, ?, 22, 1)", w.an1(), id, w.mandant());
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, reported_at) "
                + "VALUES (?, ?, ?, ?, now())", box, id, w.mandant(), w.an1());
        if (rang != null) {
            root.update("INSERT INTO site_charge_point_rank (site_id, charge_point_id, tenant_id, rank) "
                    + "VALUES (?, ?, ?, ?)", w.an1(), id, w.mandant(), rang);
        }
    }

    /** Die Gemeinsame Steuerung V-1: Halle 1 führt, Verwaltung steuert mit; Dokument Revision 1 gesendet+quittiert. */
    private UUID verbund(Welt w, String stufe, double anteilVerwaltung) {
        UUID v = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche) "
                + "VALUES (?, ?, ?, 1) RETURNING id", UUID.class, w.mandant(), w.an1(), stufe);
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', '192.168.10.20', '{1}', 10) "
                + "RETURNING id", UUID.class, w.mandant(), w.an1());
        dokument(w, v, 1, anteilVerwaltung);
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                + "rolle, data_source_id, gueltig_ab, gesendet_epoche, gesendet_revision, gesendet_am, "
                + "quittiert_epoche, quittiert_revision, quittiert_am, created_by) VALUES (?, ?, ?, ?, 'fuehrt', ?, "
                + "TIMESTAMPTZ '2026-01-01T00:00:00Z', 1, 1, now(), 1, 1, now(), 'test')",
                w.mandant(), v, w.an1(), w.halle1(), dq);
        root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                + "rolle, gueltig_ab, gesendet_epoche, gesendet_revision, gesendet_am, quittiert_epoche, "
                + "quittiert_revision, quittiert_am, created_by) VALUES (?, ?, ?, ?, 'steuert_mit', "
                + "TIMESTAMPTZ '2026-01-01T00:00:00Z', 1, 1, now(), 1, 1, now(), 'test')",
                w.mandant(), v, w.an1(), w.verwaltung());
        return v;
    }

    private void dokument(Welt w, UUID v, long revision, double anteilVerwaltung) {
        String anteile = "{\"einspeisung\":{\"" + w.halle1() + "\":40.0,\"" + w.verwaltung() + "\":60.0},"
                + "\"bezug\":{\"" + w.halle1() + "\":0.0,\"" + w.verwaltung() + "\":" + anteilVerwaltung + "}}";
        root.update("INSERT INTO steuerungsverbund_anteile (tenant_id, steuerungsverbund_id, site_id, epoche, "
                + "revision, schritt, verteilbar_einspeisung_kw, verteilbar_bezug_kw, anteile, anlass, created_by) "
                + "VALUES (?, ?, ?, 1, ?, 'ziel', 100, ?, ?::jsonb, 'scharfschalten', 'test')",
                w.mandant(), v, w.an1(), revision, anteilVerwaltung, anteile);
    }

    private static LocalDate heute() {
        return LocalDate.now(BERLIN);
    }

    /** Standort ST-1 der Anlage (für den Netzanschluss und „heute am Standort“). */
    private static UUID standort(Welt w) {
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, w.mandant());
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id",
                UUID.class, w.mandant(), u);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                w.mandant(), w.an1(), st1, heute().minusDays(60));
        return st1;
    }

    private JsonNode ruf(Welt w, HttpMethod methode, String pfad, Object body, int status) throws Exception {
        MvcResult r = mvc.perform(request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-jonas-" + w.mandant());
                    j.claim("preferred_username", "Jonas Wendlinger");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(body))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(status);
        return MAPPER.readTree(text.isEmpty() ? "null" : text);
    }

    private static String anteile(Welt w) {
        return root.queryForObject("SELECT string_agg(anteile::text, '|' ORDER BY revision) FROM "
                + "steuerungsverbund_anteile WHERE site_id = ?", String.class, w.an1());
    }
}
