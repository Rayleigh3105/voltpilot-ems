package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Schaltspur (vp-schalten-3s) gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app} unter RLS, mit dem
 * ECHTEN Verbraucher-Zuhörer: ein Herzschlag einer Box vor der Schaltspur (nur Zustand) bestätigt oder hält den
 * Wunsch, eine Box mit Schaltspur füllt ihre eigenen Zeitpunkte, ein neuer Tipp ersetzt den alten, das Portal meldet
 * einmal, ein fremder Mandant sieht nichts, und die Liste ist nur für die Plattform-Administration.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class SchaltSpurDbTest {

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "spur_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "spur_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "spur_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "spur_admin_pw");
    }

    @Autowired SchaltSpur spur;
    @Autowired DeviceRepository devices;
    @Autowired ConsumerRuntimeStatusRepository store;
    @Autowired ConsumerRequirementLedgerWriter ledger;
    @Autowired com.voltpilot.api.rules.RuleEventWriter ruleEvents;
    @Autowired com.voltpilot.api.command.CommandLogWriter commandLog;
    @Autowired MockMvc mvc;
    @MockitoBean EntityRegistryPublisher registryPublisher;
    @MockitoBean ProbeService probes;
    static JdbcTemplate root;
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID stab) {}

    private Welt welt(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id, name) VALUES (?, 'Zuhause') RETURNING id",
                UUID.class, t);
        UUID box = UUID.randomUUID();
        root.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES (?, ?, ?, ?, 'edge')",
                box, t, site, "edge-spur-" + box.toString().substring(0, 8));
        UUID stab = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "capabilities) VALUES (?, ?, 'heating-rod', 'Heizstab', 'heating-rod', '{\"measure\":[],"
                + "\"actuate\":[{\"command\":\"setpoint_kw\"}]}'::jsonb) RETURNING id", UUID.class, t, site);
        root.update("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw, "
                + "levels_kw) VALUES (?, ?, ?, 'stepped', 4.5, '[0, 1.5, 3.0, 4.5]'::jsonb)", stab, t, site);
        return new Welt(t, site, box, stab);
    }

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private ConsumerRuntimeStatusListener listener() {
        ConsumerRuntimeStatusListener l = new ConsumerRuntimeStatusListener("tcp://unused", "", "", devices, store,
                ledger, ruleEvents, commandLog);
        l.schaltSpur(spur);
        return l;
    }

    /** Ein Herzschlag mit dem Heizstab-Eintrag {@code eintrag} (ohne äußere Klammern). */
    private void herzschlag(Welt w, String eintrag) {
        String body = "{\"tenant_id\":\"" + w.tenant() + "\",\"site_id\":\"" + w.site() + "\",\"device_id\":\""
                + w.box() + "\",\"ts\":\"" + Instant.now() + "\",\"consumers\":{\"" + w.stab() + "\":{" + eintrag
                + "}}}";
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status",
                body.getBytes(StandardCharsets.UTF_8));
    }

    private static String stufe(int befohlen, String an) {
        return "\"stage\":{\"commanded\":" + befohlen + ",\"confirmed\":" + (an.isEmpty() ? 0 : an.split(",").length)
                + ",\"outputs_on\":[" + an + "],\"at\":\"" + Instant.now() + "\"}";
    }

    private SchaltSpur.Neu gesendet(Welt w, String art, BigDecimal wert, List<Integer> ausgaenge) {
        return als(w.tenant(), () -> {
            SchaltSpur.Neu n = spur.beginnen(w.site(), w.stab(), art, "setpoint_kw", wert, ausgaenge, Instant.now());
            spur.gesendet(n, w.box(), Instant.now(), true, null);
            return n;
        });
    }

    private SchaltSpurRepository.Zeile zeile(Welt w, UUID id) {
        return als(w.tenant(), () -> spur.liste(w.site(), w.stab())).stream()
                .filter(z -> z.id().equals(id)).findFirst().orElseThrow();
    }

    @Test
    void eineBoxVorDerSchaltspurBestaetigtUeberIhrenZustand() {
        Welt w = welt("Spur alt");
        SchaltSpur.Neu n = gesendet(w, "stop", BigDecimal.ZERO, null);
        assertThat(n.requestId()).isEqualTo("override:" + w.stab() + ":" + n.id());

        herzschlag(w, "\"state\":\"running_optimized\",\"confirmed\":true," + stufe(1, "0"));
        SchaltSpurRepository.Zeile offen = zeile(w, n.id());
        assertThat(offen.ersteMeldung()).isNotNull();
        assertThat(offen.ergebnis()).isEqualTo("offen");
        assertThat(offen.boxEmpfangen()).as("eine alte Box meldet keine eigenen Zeitpunkte").isNull();

        herzschlag(w, "\"state\":\"waiting\",\"confirmed\":true," + stufe(0, ""));
        SchaltSpurRepository.Zeile fertig = zeile(w, n.id());
        assertThat(fertig.ergebnis()).isEqualTo("bestaetigt");
        assertThat(fertig.bestaetigt()).isAfterOrEqualTo(fertig.ersteMeldung());
        assertThat(fertig.ersteMeldung()).as("nur der erste Herzschlag zählt").isEqualTo(offen.ersteMeldung());
    }

    @Test
    void eineMindestlaufzeitHaeltDenWunschUndSpaeterIstErBestaetigt() {
        Welt w = welt("Spur gehalten");
        SchaltSpur.Neu n = gesendet(w, "stop", BigDecimal.ZERO, null);

        herzschlag(w, "\"state\":\"running_manual\",\"reason_code\":\"guard_min_on\",\"confirmed\":true,"
                + stufe(1, "0"));
        SchaltSpurRepository.Zeile gehalten = zeile(w, n.id());
        assertThat(gehalten.ergebnis()).isEqualTo("gehalten");
        assertThat(gehalten.grund()).isEqualTo("guard_min_on");
        assertThat(gehalten.gehalten()).isNotNull();

        herzschlag(w, "\"state\":\"waiting\",\"confirmed\":true," + stufe(0, ""));
        SchaltSpurRepository.Zeile fertig = zeile(w, n.id());
        assertThat(fertig.ergebnis()).isEqualTo("bestaetigt");
        assertThat(fertig.gehalten()).isEqualTo(gehalten.gehalten());
        assertThat(fertig.grund()).isEqualTo("guard_min_on");
    }

    @Test
    void eineBoxMitSchaltspurMeldetIhreEigenenZeitpunkte() {
        Welt w = welt("Spur neu");
        SchaltSpur.Neu n = gesendet(w, "start", new BigDecimal("1.5"), List.of(1));
        String trace = "\"trace\":{\"request_id\":\"" + n.requestId() + "\",\"received_at\":\"2026-11-27T10:00:00.010Z\","
                + "\"admitted_at\":\"2026-11-27T10:00:00.012Z\",\"written_at\":\"2026-11-27T10:00:00.180Z\","
                + "\"read_back_at\":\"2026-11-27T10:00:00.240Z\",\"outcome\":\"written\"}";

        herzschlag(w, "\"state\":\"running_manual\",\"confirmed\":true," + stufe(1, "1") + "," + trace);

        SchaltSpurRepository.Zeile z = zeile(w, n.id());
        assertThat(z.ergebnis()).isEqualTo("bestaetigt");
        assertThat(z.boxEmpfangen()).isEqualTo(Instant.parse("2026-11-27T10:00:00.010Z"));
        assertThat(z.boxEntschieden()).isEqualTo(Instant.parse("2026-11-27T10:00:00.012Z"));
        assertThat(z.boxGeschrieben()).isEqualTo(Instant.parse("2026-11-27T10:00:00.180Z"));
        assertThat(z.boxZurueckgelesen()).isEqualTo(Instant.parse("2026-11-27T10:00:00.240Z"));
        assertThat(z.boxGemeldet()).isNotNull();
        assertThat(z.boxUrteil()).isEqualTo("written");
        assertThat(z.ausgaenge()).containsExactly(1);
    }

    @Test
    void einFremderTraceUndEinNeuerTippAendernNichtsAnDerAltenSpur() {
        Welt w = welt("Spur ersetzt");
        SchaltSpur.Neu alt = gesendet(w, "start", new BigDecimal("1.5"), List.of(0));
        herzschlag(w, "\"state\":\"running_optimized\",\"confirmed\":true," + stufe(1, "2")
                + ",\"trace\":{\"request_id\":\"override:fremd\",\"received_at\":\"2026-11-27T10:00:00Z\"}");
        assertThat(zeile(w, alt.id()).boxEmpfangen()).isNull();

        SchaltSpur.Neu neu = gesendet(w, "stop", BigDecimal.ZERO, null);
        assertThat(zeile(w, alt.id()).ergebnis()).isEqualTo("ersetzt");
        herzschlag(w, "\"state\":\"waiting\",\"confirmed\":true," + stufe(0, ""));
        assertThat(zeile(w, alt.id()).ergebnis()).isEqualTo("ersetzt");
        assertThat(zeile(w, neu.id()).ergebnis()).isEqualTo("bestaetigt");
    }

    @Test
    void dasPortalMeldetEinmalUndEinFremderMandantSiehtNichts() {
        Welt w = welt("Spur Portal");
        Welt fremd = welt("Spur fremd");
        SchaltSpur.Neu n = gesendet(w, "stop", BigDecimal.ZERO, null);

        assertThat(als(w.tenant(), () -> spur.portal(w.site(), w.stab(), n.id(), 180, 2400))).isTrue();
        assertThat(als(w.tenant(), () -> spur.portal(w.site(), w.stab(), n.id(), 9, 9))).isTrue();
        SchaltSpurRepository.Zeile z = zeile(w, n.id());
        assertThat(z.portalAntwortMs()).isEqualTo(180);
        assertThat(z.portalSichtbarMs()).isEqualTo(2400);

        assertThat(als(fremd.tenant(), () -> spur.liste(w.site(), w.stab()))).isEmpty();
        assertThat(als(fremd.tenant(), () -> spur.portal(w.site(), w.stab(), n.id(), 1, 1))).isFalse();
    }

    @Test
    void jeVerbraucherBleibenDieJuengstenZwanzig() {
        Welt w = welt("Spur Rest");
        for (int i = 0; i < SchaltSpurRepository.JE_VERBRAUCHER + 3; i++) {
            gesendet(w, "stop", BigDecimal.ZERO, null);
        }
        assertThat(als(w.tenant(), () -> spur.liste(w.site(), w.stab()))).hasSize(SchaltSpurRepository.JE_VERBRAUCHER);
        assertThat(root.queryForObject("SELECT count(*) FROM schaltspur WHERE entity_id = ?", Integer.class, w.stab()))
                .isEqualTo(SchaltSpurRepository.JE_VERBRAUCHER);
    }

    @Test
    void dieListeIstNurFuerDiePlattformAdministration() throws Exception {
        Welt w = welt("Spur Route");
        SchaltSpur.Neu n = gesendet(w, "stop", BigDecimal.ZERO, null);
        String pfad = "/api/v1/admin/sites/" + w.site() + "/consumers/" + w.stab() + "/schaltspuren";

        var antwort = mvc.perform(get(pfad).header("X-Tenant-Id", w.tenant().toString())
                        .with(jwt().authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode liste = JSON.readTree(antwort);
        assertThat(liste).hasSize(1);
        assertThat(liste.get(0).path("id").asText()).isEqualTo(n.id().toString());
        assertThat(liste.get(0).path("requestId").asText()).isEqualTo(n.requestId());
        assertThat(liste.get(0).path("gesendet").isNull()).isFalse();

        mvc.perform(get(pfad).with(jwt().jwt(j -> j.claim("tenant_id", w.tenant().toString()))
                        .authorities(new SimpleGrantedAuthority("ROLE_user"))))
                .andExpect(status().isForbidden());
    }
}
