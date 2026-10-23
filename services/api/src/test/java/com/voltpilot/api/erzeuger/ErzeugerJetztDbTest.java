package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.web.ErzeugerJetztController;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.web.dto.ErzeugerJetztDto;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import java.io.IOException;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS EZ-23 gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app} unter RLS, in der Form von Gore (PV,
 * drei Growatt-Wechselrichter an einer WAGO, Werte erst ab 10:40): ohne Steuerung 204, mit Steuerung immer 200 — ohne
 * Werte ohne Zahlen, mit Werten unter den Punktnamen des Portals und den Wechseln seit Mitternacht. Die Antwort trägt
 * in der Serialisierung des API genau die Felder von {@code ErzeugerJetzt} aus {@code api.ts}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class ErzeugerJetztDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "erzeuger_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "erzeuger_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "erzeuger_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "erzeuger_admin_pw");
    }

    @Autowired AnlagensteuerungService steuerungen;
    @Autowired AnlagensteuerungRepository repo;
    @Autowired ErzeugerJetztService service;
    @Autowired ObjectMapper json;
    @MockBean EntityRegistryPublisher registryPublisher;
    static JdbcTemplate root;

    @BeforeAll static void start() throws IOException {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        ErzeugerJetztVertragTest.lade();
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID quelle) {}

    private static Welt welt(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Neue Halle') RETURNING id",
                UUID.class, tenant);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, supports, "
                + "supports_reported_at) VALUES (?, ?, ?, '[\"erzeuger_registerbild\"]'::jsonb, now()) RETURNING id",
                UUID.class, tenant, site, "edge-" + name.toLowerCase().replaceAll("[^a-z0-9]", ""));
        UUID quelle = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-1', 'modbus_tcp', '192.168.1.50:503', '{1}', 5) RETURNING id",
                UUID.class, tenant, site);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT d.tenant_id, d.id, ?, d.protokoll, d.adresse, "
                + "date_trunc('minute', now()) - interval '1 day' FROM data_source d WHERE d.id = ?", box, quelle);
        return new Welt(tenant, site, box, quelle);
    }

    /** Gore: drei Growatt-Wechselrichter an der WAGO, wie sie die Einrichtung anlegt. */
    private AnlagensteuerungDto.Anlagensteuerung gore(Welt w) {
        List<AnlagensteuerungDto.NeueEinheit> einheiten = List.of(
                new AnlagensteuerungDto.NeueEinheit(1, "pv_wechselrichter", "WR 1", "Growatt MAX 125KTL3-X LV", null,
                        new BigDecimal("125"), null),
                new AnlagensteuerungDto.NeueEinheit(2, "pv_wechselrichter", "WR 2", null, null, null, null),
                new AnlagensteuerungDto.NeueEinheit(3, "pv_wechselrichter", "WR 3", null, "Growatt MAX 125KTL3-X",
                        new BigDecimal("125"), null));
        return als(w.tenant(), () -> steuerungen.anlegen(w.site(), new AnlagensteuerungDto.Anlegen(w.quelle(), 1,
                "Anlagensteuerung Gore", "WAGO", "PFC200 750-8212", null, null, null, "pv", null, null, null, null,
                einheiten, null), "sub-einrichter"));
    }

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static <T> T alsMit(Zugriff zugriff, Supplier<T> was) {
        ZugriffContext.set(zugriff);
        try {
            return als(zugriff.kundenbereich(), was);
        } finally {
            ZugriffContext.clear();
        }
    }

    @Test
    void ohneAnlagensteuerung204UndEineFremdeOderUmzaeunteAnlage404() {
        Welt w = welt("Jetzt-Ohne");
        assertThat(als(w.tenant(), () -> service.jetzt(w.site()))).isEmpty();
        ErzeugerJetztController controller = new ErzeugerJetztController(service);
        assertThat(als(w.tenant(), () -> controller.jetzt(w.site())).getStatusCode().value()).isEqualTo(204);

        gore(w);
        assertThat(als(w.tenant(), () -> controller.jetzt(w.site())).getStatusCode().value()).isEqualTo(200);

        Welt fremd = welt("Jetzt-Fremd");
        assertThatThrownBy(() -> als(fremd.tenant(), () -> service.jetzt(w.site())))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        Zugriff ohneStandort = new Zugriff("sub-zaun", Konto.BENUTZER, w.tenant(), Zugang.KONTO, List.of(),
                Instant.now());
        assertThatThrownBy(() -> alsMit(ohneStandort, () -> service.jetzt(w.site())))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
    }

    @Test
    void goreOhneWerte200OhneZahlen() {
        Welt w = welt("Jetzt-Leer");
        AnlagensteuerungDto.Anlagensteuerung s = gore(w);

        ErzeugerJetztDto.Jetzt j = als(w.tenant(), () -> service.jetzt(w.site())).orElseThrow();
        assertThat(j.steuerung()).isEqualTo(new ErzeugerJetztDto.Steuerung(s.geraetId(), "Anlagensteuerung Gore"));
        assertThat(j.netzbetreiber()).isNull();
        assertThat(j.direktvermarkter()).isNull();
        assertThat(j.einheiten()).extracting(ErzeugerJetztDto.Einheit::teNr, ErzeugerJetztDto.Einheit::art,
                ErzeugerJetztDto.Einheit::typName, ErzeugerJetztDto.Einheit::bezeichnung).containsExactly(
                        org.assertj.core.groups.Tuple.tuple(1, "pv", "Growatt MAX 125KTL3-X LV", "WR 1"),
                        org.assertj.core.groups.Tuple.tuple(2, "pv", null, "WR 2"),
                        org.assertj.core.groups.Tuple.tuple(3, "pv", "Growatt MAX 125KTL3-X", "WR 3"));
        assertThat(j.einheiten().get(1).nennKw()).as("nicht erhoben, nie 0").isNull();
        assertThat(j.werte()).as("22 Punkte der Anlage + 3 × 6 je Einheit").hasSize(22 + 3 * 6)
                .containsKeys("erzeuger.anlage.p_nvp_w", "erzeuger.nb.bits", "erzeuger.te3.p_ist_w")
                .allSatisfy((k, v) -> assertThat(v).as(k).isEqualTo(new ErzeugerJetztDto.Wert(null, null, null)));
        assertThat(j.wechselHeute()).containsOnlyKeys(ErzeugerJetztService.WECHSEL).allSatisfy((k, v) ->
                assertThat(v).as(k).singleElement().satisfies(x -> assertThat(x.wert()).isNull()));
    }

    @Test
    void goreNachDemBoxUpdateLiefertWerteUnterDenNamenDesPortalsUndDieWechselSeitMitternacht() throws Exception {
        Welt w = welt("Jetzt-Gore");
        AnlagensteuerungDto.Anlagensteuerung s = gore(w);
        als(w.tenant(), () -> steuerungen.namenAusBild(s.geraetId(), new AnlagensteuerungDto.NamenAusBild(
                "Bayernwerk Netz", "Next Kraftwerke", null), "sub-einrichter"));
        UUID e = s.entityId();

        // 23.10.2026 wie bei Gore: die Steuerung liefert ab 10:40; gestern um 23:59:30 kam noch eine Vorgabe-Lesung.
        Instant mitternacht = LocalDate.now(ErzeugerJetztService.ZONE).atStartOfDay(ErzeugerJetztService.ZONE)
                .toInstant();
        Instant ab = mitternacht.plusSeconds(10 * 3600 + 40 * 60);
        Instant jetzt = ab.plusSeconds(10 * 60);
        reihe(w, e, "erzeuger.nb.n_bits", 0b011, mitternacht.minusSeconds(30), mitternacht.minusSeconds(30));
        reihe(w, e, "erzeuger.nb.n_bits", 0b001, ab, jetzt);
        reihe(w, e, "erzeuger.wirkung.quelle_p", 3, ab, jetzt);
        reihe(w, e, "erzeuger.wirkung.s_bits", 0b11, ab, jetzt);
        reihe(w, e, "erzeuger.a.a_gueltig", 0b01001, ab, jetzt);
        reihe(w, e, "erzeuger.a.p_nvp_w", 877_100, ab, jetzt);
        reihe(w, e, "erzeuger.a.p_erzeugung_w", 41_000, ab, jetzt);
        reihe(w, e, "erzeuger.a.anlage_zustand", 3, ab, jetzt);
        reihe(w, e, "erzeuger.kopf.te_anzahl", 3, ab, jetzt);
        for (int te = 1; te <= 3; te++) {
            reihe(w, e, "erzeuger.te[" + te + "].t_p_ist_w", 13_000 + te * 100, ab, jetzt);
            reihe(w, e, "erzeuger.te[" + te + "].t_bits", 0b11, ab, jetzt);
            reihe(w, e, "erzeuger.te[" + te + "].t_zustand", 3, ab, jetzt);
        }
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, long_term_cadence_s) VALUES (?, now(), ?, ?, ?, ?, 'erzeuger.nb.n_p_prozent', "
                + "1000, NULL, 'invalid', '2026.09.23.3', 1, 'gauge', 900)", Timestamp.from(jetzt), w.tenant(),
                w.site(), w.box(), e);

        ErzeugerJetztService amVormittag = new ErzeugerJetztService(repo, Clock.fixed(jetzt, ZoneOffset.UTC));
        ErzeugerJetztDto.Jetzt j = als(w.tenant(), () -> amVormittag.jetzt(w.site())).orElseThrow();

        assertThat(j.netzbetreiber()).as("kein Netzanschluss eingetragen: der Name aus dem Bild")
                .isEqualTo("Bayernwerk Netz");
        assertThat(j.direktvermarkter()).isEqualTo("Next Kraftwerke");
        ErzeugerJetztDto.Wert netz = j.werte().get("erzeuger.anlage.p_nvp_w");
        assertThat(netz.wert()).isEqualByComparingTo("877100");
        assertThat(netz.gelesenAm().toInstant()).isEqualTo(jetzt);
        assertThat(netz.qualitaet()).isEqualTo("good");
        assertThat(j.werte().get("erzeuger.anlage.gueltig").wert()).isEqualByComparingTo("9");
        assertThat(j.werte().get("erzeuger.te2.p_ist_w").wert()).isEqualByComparingTo("13200");
        assertThat(j.werte().get("erzeuger.te3.zustand").wert()).isEqualByComparingTo("3");
        assertThat(j.werte().get("erzeuger.dv.p_soll_w")).as("nie geliefert: null, nie 0")
                .isEqualTo(new ErzeugerJetztDto.Wert(null, null, null));
        assertThat(j.werte().get("erzeuger.nb.p_vorgabe_prozent")).as("die Box meldet invalid ohne Zahl")
                .satisfies(x -> {
                    assertThat(x.wert()).isNull();
                    assertThat(x.qualitaet()).isEqualTo("invalid");
                });

        assertThat(j.wechselHeute().get("erzeuger.nb.bits")).as("um Mitternacht 0b011, 120 s nach der Lesung unbekannt, "
                + "ab 10:40 0b001").extracting(x -> x.ab().toInstant(), x -> x.wert() == null ? null : x.wert().intValue())
                .containsExactly(org.assertj.core.groups.Tuple.tuple(mitternacht, 3),
                        org.assertj.core.groups.Tuple.tuple(mitternacht.plusSeconds(90), null),
                        org.assertj.core.groups.Tuple.tuple(ab, 1));
        assertThat(j.wechselHeute().get("erzeuger.wirkung.quelle_p"))
                .extracting(x -> x.ab().toInstant(), x -> x.wert() == null ? null : x.wert().intValue())
                .containsExactly(org.assertj.core.groups.Tuple.tuple(mitternacht, null),
                        org.assertj.core.groups.Tuple.tuple(ab, 3));
        assertThat(j.wechselHeute().get("erzeuger.dv.bits")).singleElement()
                .satisfies(x -> assertThat(x.wert()).isNull());

        // So, wie das API sie schreibt, ist es die Form von ErzeugerJetzt in api.ts.
        JsonNode jn = json.valueToTree(j);
        assertThat(namen(jn)).containsExactlyElementsOf(ErzeugerJetztVertragTest.interfaceFelder("ErzeugerJetzt"));
        assertThat(namen(jn.get("steuerung"))).containsExactlyElementsOf(ErzeugerJetztVertragTest.inlineFelder("steuerung"));
        assertThat(jn.get("steuerung").get("geraetId").isTextual()).isTrue();
        for (JsonNode einheit : jn.get("einheiten")) {
            assertThat(namen(einheit)).containsExactlyElementsOf(ErzeugerJetztVertragTest.inlineFelder("einheiten"));
            assertThat(einheit.get("teNr").isInt()).isTrue();
        }
        jn.get("werte").fields().forEachRemaining(f -> {
            assertThat(namen(f.getValue())).as(f.getKey())
                    .containsExactlyElementsOf(ErzeugerJetztVertragTest.interfaceFelder("ErzeugerWert"));
            JsonNode wert = f.getValue().get("wert");
            assertThat(wert.isNull() || wert.isNumber()).as(f.getKey() + " wert").isTrue();
            JsonNode am = f.getValue().get("gelesenAm");
            assertThat(am.isNull() || Instant.parse(am.asText()) != null).as(f.getKey() + " gelesenAm").isTrue();
        });
        assertThat(jn.get("werte").get("erzeuger.anlage.p_nvp_w").get("gelesenAm").asText())
                .as("ISO-Zeit, wie Date.parse sie liest").isEqualTo(jetzt.toString());
        jn.get("wechselHeute").fields().forEachRemaining(f -> f.getValue().forEach(x -> {
            assertThat(namen(x)).containsExactlyElementsOf(ErzeugerJetztVertragTest.interfaceFelder("ErzeugerWechsel"));
            assertThat(x.get("ab").isTextual()).isTrue();
        }));
    }

    private static List<String> namen(JsonNode o) {
        List<String> out = new ArrayList<>();
        o.fieldNames().forEachRemaining(out::add);
        return out;
    }

    /** Gute Lesungen eines Punkts im 60-s-Takt über {@code [von, bis]} — so schickt die Box jeden Wert (EW-5). */
    private static void reihe(Welt w, UUID entity, String key, long zahl, Instant von, Instant bis) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, entity_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                + "long_term_cadence_s) SELECT t, now(), ?, ?, ?, ?, ?, ?, ?, 'good', '2026.09.23.3', "
                + "extract(epoch FROM t)::bigint, 'gauge', 300 FROM generate_series(CAST(? AS timestamptz), "
                + "CAST(? AS timestamptz), interval '60 seconds') t", w.tenant(), w.site(), w.box(), entity, key, zahl,
                zahl, Timestamp.from(von), Timestamp.from(bis));
    }
}
