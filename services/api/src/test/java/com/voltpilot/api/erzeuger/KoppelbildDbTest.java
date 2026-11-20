package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.web.dto.KoppelbildDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * PFC200 Stufe 4 gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app} unter RLS: der Herzschlag-Block
 * {@code koppel} landet je Box und Steuerung, ein Schalt-Test geht als {@code koppel_test} mit Verbindung, Kennung und
 * Art hinaus und hinterlegt nur bestanden seinen Beleg, die Freigabe braucht ihn und die bestätigte Wirkung, je
 * Kommando gibt es einen Stellplatz, ein geändertes Angebot lässt die Freigabe fallen - und der Registry-Push trägt die
 * Fähigkeit nur an eine Box mit {@code koppelbild}, ohne Freigabe bleibt er wie vorher.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class KoppelbildDbTest {
    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "koppel_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "koppel_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "koppel_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "koppel_admin_pw");
    }

    @Autowired AnlagensteuerungService steuerungen;
    @Autowired KoppelbildService service;
    @Autowired KoppelbildRepository repo;
    @Autowired AnlagensteuerungQuelle quelle;
    @Autowired DeviceRepository devices;
    @Autowired TransactionTemplate tx;
    @MockitoBean EntityRegistryPublisher registryPublisher;
    @MockitoBean ProbeService probes;
    static JdbcTemplate root;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID quelle, UUID geraet, UUID entity) {}

    private Welt welt(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Gore') RETURNING id",
                UUID.class, tenant);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, "edge-" + name.toLowerCase().replaceAll("[^a-z0-9]", ""));
        UUID quelle = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-1', 'modbus_tcp', '192.168.1.50:503', '{1}', 5) RETURNING id",
                UUID.class, tenant, site);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT d.tenant_id, d.id, ?, d.protokoll, d.adresse, "
                + "date_trunc('minute', now()) - interval '1 day' FROM data_source d WHERE d.id = ?", box, quelle);
        meldet(box, ErzeugerRegisterbild.FAEHIGKEIT, AnlagensteuerungQuelle.FAEHIGKEIT, Koppelbild.FAEHIGKEIT);
        AnlagensteuerungDto.Anlagensteuerung s = als(tenant, () -> steuerungen.anlegen(site,
                new AnlagensteuerungDto.Anlegen(quelle, 1, "Anlagensteuerung Gore", "WAGO", "PFC200 750-8212", null,
                        null, null, "pv", 1042L, null, null, null, List.of(new AnlagensteuerungDto.NeueEinheit(1,
                                "pv_wechselrichter", "WR 1", null, null, new BigDecimal("265"), null)), null),
                "sub-einrichter"));
        return new Welt(tenant, site, box, quelle, s.geraetId(), s.entityId());
    }

    private static void meldet(UUID box, String... woerter) {
        root.update("UPDATE device SET supports = ?::jsonb, supports_reported_at = now() WHERE id = ?",
                MAPPER.valueToTree(List.of(woerter)).toString(), box);
    }

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private KoppelbildStandListener listener() {
        return new KoppelbildStandListener("tcp://unused", "", "", devices, repo, service, quelle, tx);
    }

    private static final String PV = "{\"art\":\"limit_w\",\"ziel\":\"erzeugung_gesamt\",\"nr\":0,\"min\":0,"
            + "\"max\":265000,\"bits\":[\"bereit\"]}";
    private static final String EINSPEISUNG = "{\"art\":\"limit_w\",\"ziel\":\"einspeisung\",\"nr\":0,\"min\":0,"
            + "\"max\":100000,\"bits\":[\"bereit\"]}";

    /** Ein Herzschlag der Box mit dem Block {@code koppel} für die Steuerung und diesen Stellplätzen. */
    private void herzschlag(Welt w, String lage, String plaetze) {
        String body = "{\"tenant_id\":\"" + w.tenant() + "\",\"site_id\":\"" + w.site() + "\",\"device_id\":\""
                + w.box() + "\",\"koppel\":[{\"steuerung\":\"" + w.entity() + "\",\"data_source_id\":\"DQ-1\","
                + "\"lage\":\"" + lage + "\",\"gelesen_at\":\"2026-11-19T21:30:02Z\",\"bibliothek\":\"1.0\","
                + "\"kopf_urteil\":\"angenommen\",\"rest_s\":58,\"q_bits\":[\"fernsteuerung_frei\",\"edge_lebt\"],"
                + "\"angenommen_zaehler\":97,\"abgelehnt_zaehler\":0,\"plaetze\":[" + plaetze + "]}]}";
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status",
                body.getBytes(StandardCharsets.UTF_8));
    }

    private static String platz(int nr, String angebot) {
        return "{\"platz\":" + nr + ",\"angebot\":" + angebot + ",\"test\":false,\"urteil\":\"kein_wunsch\",\"folge\":0}";
    }

    /** Die Antwort der Box auf einen Schalt-Test. */
    private void boxAntwortet(boolean ok, String urteil, String angebot) throws Exception {
        ProbeResult.KoppelAngebot a = angebot == null ? null : angebot(angebot);
        when(probes.koppelTest(any(), any(), any(), any())).thenReturn(new ProbeResult("r1", null, null,
                List.of(ProbeResult.OpResult.ausKoppelTest("stellplatz-1", ok, null, null,
                        new ProbeResult.KoppelTest("bereit", null, "angenommen", a, true, 3, urteil, 200_000L)))));
    }

    private static ProbeResult.KoppelAngebot angebot(String json) throws Exception {
        JsonNode n = MAPPER.readTree(json);
        return new ProbeResult.KoppelAngebot(n.path("art").asText(), n.path("ziel").asText(), n.path("nr").asInt(),
                n.path("min").asLong(), n.path("max").asLong(), List.of("bereit"));
    }

    private KoppelbildDto.Koppelbild bild(Welt w) {
        return als(w.tenant(), () -> service.koppelbild(w.site(), w.geraet()));
    }

    private static KoppelbildDto.Stellplatz stellplatz(KoppelbildDto.Koppelbild b, int nr) {
        return b.stellplaetze().stream().filter(s -> s.platz() == nr).findFirst().orElseThrow();
    }

    /** Die Anlagensteuerung im zuletzt zugestellten Registry-Push an die Box. */
    private JsonNode steuerungImPush(Welt w) throws Exception {
        ArgumentCaptor<byte[]> nutzlast = ArgumentCaptor.forClass(byte[].class);
        verify(registryPublisher, atLeastOnce()).publishRegistry(eq(w.tenant()), eq(w.site()), eq(w.box()),
                nutzlast.capture());
        for (JsonNode e : MAPPER.readTree(nutzlast.getValue()).path("entities")) {
            if (w.entity().toString().equals(e.path("entity_id").asText())) return e;
        }
        throw new AssertionError("keine Anlagensteuerung im Push");
    }

    private void zustellen(Welt w) {
        clearInvocations(registryPublisher);
        als(w.tenant(), () -> {
            quelle.zustellen(w.site());
            return null;
        });
    }

    @Test
    void vomHerzschlagUeberTestUndFreigabeBisZumWegfallDerFreigabe() throws Exception {
        Welt w = welt("Koppel-Weg");
        zustellen(w);
        JsonNode vorher = steuerungImPush(w);
        assertThat(vorher.path("capabilities").path("actuate")).as("nur messen").isEmpty();

        // Der Herzschlag: die Steuerung bietet Stellplatz 1 an.
        herzschlag(w, "bereit", platz(1, PV));
        KoppelbildDto.Koppelbild b = bild(w);
        assertThat(b.unterstuetzt()).isTrue();
        assertThat(b.stand().lage()).isEqualTo("bereit");
        assertThat(b.stand().aktuell()).isTrue();
        assertThat(b.stand().bibliothekVeraltet()).isFalse();
        assertThat(b.stand().fernsteuerungFrei()).isTrue();
        assertThat(b.stand().handOrt()).isFalse();
        KoppelbildDto.Stellplatz p1 = stellplatz(b, 1);
        assertThat(p1.angebot().max()).isEqualTo(265_000);
        assertThat(p1.kommando()).isEqualTo("limit_kw");
        assertThat(p1.freigabe().status()).isEqualTo("offen");
        assertThat(p1.freigabeGrund()).isEqualTo("kein_test");

        // Ohne Test keine Freigabe; ein Testwert außerhalb des Bands wird abgelehnt, nicht geklemmt.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.freigeben(w.geraet(), 1,
                new KoppelbildDto.FreigabeAnfrage(true), "sub-a")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("zuerst");
        assertThatThrownBy(() -> als(w.tenant(), () -> service.testen(w.geraet(), 1,
                new KoppelbildDto.TestAnfrage(300_000L), "sub-a")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verify(probes, never()).koppelTest(any(), any(), any(), any());

        // Ein abgelehnter Test hinterlässt keinen Beleg.
        boxAntwortet(false, "nicht_bereit", PV);
        KoppelbildDto.TestErgebnis nein = als(w.tenant(), () -> service.testen(w.geraet(), 1,
                new KoppelbildDto.TestAnfrage(200_000L), "sub-a"));
        assertThat(nein.ok()).isFalse();
        assertThat(nein.satz()).contains("nicht angenommen", "nicht bereit");
        assertThat(stellplatz(bild(w), 1).freigabeGrund()).isEqualTo("test_nicht_angenommen");

        // Der bestandene Test: Verbindung der Datenquelle, Kennung der Fassung, Art des Angebots.
        boxAntwortet(true, "angenommen", PV);
        KoppelbildDto.TestErgebnis ja = als(w.tenant(), () -> service.testen(w.geraet(), 1,
                new KoppelbildDto.TestAnfrage(200_000L), "sub-a"));
        assertThat(ja.ok()).isTrue();
        assertThat(ja.belegGespeichert()).isTrue();
        assertThat(ja.satz()).startsWith("Die Steuerung hat den Testwert 200,0 kW angenommen.");
        ArgumentCaptor<ProbePublisher.KoppelTestOp> op = ArgumentCaptor.forClass(ProbePublisher.KoppelTestOp.class);
        verify(probes, atLeastOnce()).koppelTest(eq(w.site()), eq(w.entity()), op.capture(), eq("sub-a"));
        assertThat(op.getValue()).isEqualTo(new ProbePublisher.KoppelTestOp("stellplatz-1", "192.168.1.50", 503, 1,
                1042L, 1, "limit_w", 200_000L, 30));
        assertThat(stellplatz(bild(w), 1).freigabe().status()).isEqualTo("getestet");

        // Die Freigabe braucht die bestätigte Wirkung.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.freigeben(w.geraet(), 1,
                new KoppelbildDto.FreigabeAnfrage(false), "sub-a")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        clearInvocations(registryPublisher);
        KoppelbildDto.Koppelbild frei = als(w.tenant(), () -> service.freigeben(w.geraet(), 1,
                new KoppelbildDto.FreigabeAnfrage(true), "sub-a"));
        assertThat(stellplatz(frei, 1).freigabe().status()).isEqualTo("freigegeben");
        assertThat(stellplatz(frei, 1).freigabe().freigegebenVon()).isEqualTo("sub-a");
        JsonNode e = steuerungImPush(w);
        assertThat(e.path("capabilities").path("actuate")).isEqualTo(MAPPER.readTree(
                "[{\"command\":\"limit_kw\",\"platz\":1,\"ziel\":\"erzeugung_gesamt\",\"min\":0.0,\"max\":265.0}]"));
        assertThat(e.path("guards").path("failsafe").path("behavior").asText()).isEqualTo("release");
        // Eine zweite Box der Anlage mit koppelbild, die die Datenquelle nicht liest, bekommt keinen Stellplatz.
        UUID zweite = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, w.tenant(), w.site(), "edge-koppelzweite");
        meldet(zweite, ErzeugerRegisterbild.FAEHIGKEIT, AnlagensteuerungQuelle.FAEHIGKEIT, Koppelbild.FAEHIGKEIT);
        assertThat(als(w.tenant(), () -> quelle.fuerBox(w.site(), zweite)).get(w.entity()).actuate()).isNull();
        assertThat(als(w.tenant(), () -> quelle.fuerBox(w.site(), w.box())).get(w.entity()).actuate()).hasSize(1);
        root.update("DELETE FROM device WHERE id = ?", zweite); // mit zwei Boxen gäbe es keine führende mehr
        assertThat(root.queryForObject("SELECT count(*) FROM consumer_audit_event WHERE entity_id = ? "
                + "AND event_type IN ('switch_tested', 'switch_released')", Integer.class, w.entity())).isEqualTo(3);

        // Ein zweiter Stellplatz mit demselben Kommando: getestet ja, freigegeben nein.
        herzschlag(w, "bereit", platz(1, PV) + "," + platz(2, EINSPEISUNG));
        boxAntwortet(true, "angenommen", EINSPEISUNG);
        als(w.tenant(), () -> service.testen(w.geraet(), 2, new KoppelbildDto.TestAnfrage(50_000L), "sub-a"));
        assertThat(stellplatz(bild(w), 2).freigabeGrund()).isEqualTo("kommando_belegt");
        assertThatThrownBy(() -> als(w.tenant(), () -> service.freigeben(w.geraet(), 2,
                new KoppelbildDto.FreigabeAnfrage(true), "sub-a")))
                .isInstanceOfSatisfying(ResponseStatusException.class, x -> {
                    assertThat(x.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(x.getReason()).contains("Stellplatz 1");
                });

        // Ein unlesbarer Herzschlag lässt die Freigabe stehen (unbekannt ist nicht „weg“).
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status", ("{\"tenant_id\":\""
                + w.tenant() + "\",\"site_id\":\"" + w.site() + "\",\"device_id\":\"" + w.box() + "\",\"koppel\":[{"
                + "\"steuerung\":\"" + w.entity() + "\",\"lage\":\"keine_antwort\"}]}").getBytes(StandardCharsets.UTF_8));
        assertThat(stellplatz(bild(w), 1).freigabe().status()).isEqualTo("freigegeben");

        // Das Anlagenprogramm ändert das Band: die Freigabe fällt, der Push trägt keinen Stellplatz mehr.
        clearInvocations(registryPublisher);
        herzschlag(w, "bereit", platz(1, PV.replace("265000", "250000")) + "," + platz(2, EINSPEISUNG));
        KoppelbildDto.Stellplatz verfallen = stellplatz(bild(w), 1);
        assertThat(verfallen.freigabe().status()).isEqualTo("verfallen");
        assertThat(verfallen.freigabeGrund()).isEqualTo("kein_test");
        JsonNode nachher = steuerungImPush(w);
        assertThat(nachher.path("capabilities")).isEqualTo(vorher.path("capabilities"));
        assertThat(nachher.path("guards")).isEqualTo(vorher.path("guards"));

        // Jetzt ist das Kommando frei: Stellplatz 2 lässt sich freigeben und zurücknehmen (idempotent).
        als(w.tenant(), () -> service.freigeben(w.geraet(), 2, new KoppelbildDto.FreigabeAnfrage(true), "sub-a"));
        assertThat(steuerungImPush(w).path("capabilities").path("actuate").get(0).path("platz").asInt()).isEqualTo(2);
        clearInvocations(registryPublisher);
        KoppelbildDto.Koppelbild zurueck = als(w.tenant(), () -> service.zuruecknehmen(w.geraet(), 2, "sub-a"));
        assertThat(stellplatz(zurueck, 2).freigabe().status()).isEqualTo("offen");
        assertThat(steuerungImPush(w).path("capabilities").path("actuate")).isEmpty();
        clearInvocations(registryPublisher);
        als(w.tenant(), () -> service.zuruecknehmen(w.geraet(), 2, "sub-a"));
        verify(registryPublisher, never()).publishRegistry(any(), any(), any(), any());
    }

    @Test
    void eineBoxOhneKoppelbildBekommtKeinenStellplatzUndKeinenTest() throws Exception {
        Welt w = welt("Koppel-Alt");
        herzschlag(w, "bereit", platz(1, PV));
        boxAntwortet(true, "angenommen", PV);
        als(w.tenant(), () -> service.testen(w.geraet(), 1, new KoppelbildDto.TestAnfrage(100_000L), "sub-a"));
        als(w.tenant(), () -> service.freigeben(w.geraet(), 1, new KoppelbildDto.FreigabeAnfrage(true), "sub-a"));

        meldet(w.box(), ErzeugerRegisterbild.FAEHIGKEIT, AnlagensteuerungQuelle.FAEHIGKEIT);
        zustellen(w);
        JsonNode e = steuerungImPush(w);
        assertThat(e.path("capabilities").path("actuate")).as("eine ältere Box kennt platz nicht").isEmpty();
        assertThat(e.path("guards").path("failsafe").path("behavior").asText()).isEqualTo("measure-only");
        KoppelbildDto.Koppelbild b = bild(w);
        assertThat(b.unterstuetzt()).isFalse();
        assertThat(stellplatz(b, 1).freigabe().status()).isEqualTo("freigegeben");
        assertThatThrownBy(() -> als(w.tenant(), () -> service.testen(w.geraet(), 1,
                new KoppelbildDto.TestAnfrage(100_000L), "sub-a")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        x -> assertThat(x.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void einFremderMandantSiehtNichtsUndEinFremderEintragLandetNicht() {
        Welt w = welt("Koppel-Eigen");
        Welt fremd = welt("Koppel-Fremd");
        herzschlag(w, "bereit", platz(1, PV));
        // Die Box des fremden Mandanten nennt die Steuerung von w: sie ist dort nicht da, der Eintrag fällt weg.
        listener().handle("ems/" + fremd.tenant() + "/" + fremd.site() + "/" + fremd.box() + "/status",
                ("{\"tenant_id\":\"" + fremd.tenant() + "\",\"site_id\":\"" + fremd.site() + "\",\"device_id\":\""
                        + fremd.box() + "\",\"koppel\":[{\"steuerung\":\"" + w.entity() + "\",\"lage\":\"bereit\"}]}")
                        .getBytes(StandardCharsets.UTF_8));
        assertThat(root.queryForObject("SELECT count(*) FROM koppelbild_stand WHERE device_id = ?", Integer.class,
                fremd.box())).isZero();
        assertThatThrownBy(() -> als(fremd.tenant(), () -> service.koppelbild(w.site(), w.geraet())))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        x -> assertThat(x.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThat(als(fremd.tenant(), () -> repo.juengsterStand(w.entity()))).isEmpty();

        // Eine leere Liste leert den Stand der Box; ein Herzschlag ohne Block lässt ihn stehen.
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status",
                ("{\"tenant_id\":\"" + w.tenant() + "\",\"site_id\":\"" + w.site() + "\",\"device_id\":\"" + w.box()
                        + "\"}").getBytes(StandardCharsets.UTF_8));
        assertThat(bild(w).stand()).isNotNull();
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status",
                ("{\"tenant_id\":\"" + w.tenant() + "\",\"site_id\":\"" + w.site() + "\",\"device_id\":\"" + w.box()
                        + "\",\"koppel\":[]}").getBytes(StandardCharsets.UTF_8));
        assertThat(bild(w).stand()).isNull();
        // Kaputte Nutzlast: nie eine Ausnahme.
        listener().handle("ems/" + w.tenant() + "/" + w.site() + "/" + w.box() + "/status",
                "{\"koppel\":[{\"steuerung\":1}]".getBytes(StandardCharsets.UTF_8));
    }
}
