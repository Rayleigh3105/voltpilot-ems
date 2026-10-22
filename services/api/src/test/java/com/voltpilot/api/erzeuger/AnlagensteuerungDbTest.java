package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.ErzeugerRegisterbilder;
import com.voltpilot.api.measurement.MeasurementPlan;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.ZustellungOhneBroker;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AenderungSatz;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.ErwarteteKadenz;
import com.voltpilot.api.uems.GeraetRepository;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
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
 * UEMS EZ-6 gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app} unter RLS: die Anlagensteuerung
 * entsteht nur an einer Box mit {@code erzeuger_registerbild}, als EIN Gerät mit Einheiten, Fassung und genau einer
 * Komponente; Werte ohne Daten sind „keine_daten“ (nie 0), Namen aus dem Bild belegen nur leere Anzeigen vor, ein
 * fremder Mandant sieht nichts, und der Publisher liest die Fassung.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class AnlagensteuerungDbTest {
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

    @Autowired AnlagensteuerungService service;
    @Autowired ErzeugerRegisterbilder registerbilder;
    @Autowired GeraetRepository geraete;
    @Autowired AnlagensteuerungRepository repo;
    @Autowired AnlagensteuerungMessplan messplan;
    @Autowired MeasurementSelectionService auswahl;
    @Autowired MeasurementSelectionRepository auswahlRepo;
    @Autowired BoxFaehigkeiten faehigkeiten;
    @Autowired ErwarteteKadenz kadenzen;
    static JdbcTemplate root;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID quelle) {}

    private static Welt welt(String name) {
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
        return new Welt(tenant, site, box, quelle);
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

    private static AnlagensteuerungDto.Anlegen gore(Welt w) {
        List<AnlagensteuerungDto.NeueEinheit> einheiten = List.of(
                new AnlagensteuerungDto.NeueEinheit(3, "pv_wechselrichter", "WR 3", null, "Growatt MAX 125KTL3-X",
                        new BigDecimal("125"), null),
                new AnlagensteuerungDto.NeueEinheit(1, "pv_wechselrichter", "WR 1", "Growatt MAX 125KTL3-X LV", null,
                        new BigDecimal("125"), "SEE912345678901"),
                new AnlagensteuerungDto.NeueEinheit(2, "pv_wechselrichter", "WR 2", null, null, null, null));
        return new AnlagensteuerungDto.Anlegen(w.quelle(), 1, "Anlagensteuerung Gore", "WAGO", "PFC200 750-8212",
                null, null, null, "pv", null, List.of(new AnlagensteuerungDto.RseStufe(1, new BigDecimal("60"))),
                null, null, einheiten, null);
    }

    @Test
    void erstMitFaehigkeitEntstehtEineSteuerungMitEinheitenFassungUndGenauEinerKomponente() {
        Welt w = welt("Erzeuger-Gore");
        AnlagensteuerungDto.Liste vorher = als(w.tenant(), () -> service.liste(w.site()));
        assertThat(vorher.einrichtung().moeglich()).isFalse();
        assertThat(vorher.einrichtung().grund()).isEqualTo("box_ohne_faehigkeit");
        assertThat(vorher.steuerungen()).isEmpty();
        // Mischbetrieb: eine Box ohne das Wort bekommt nie eine Steuerung, die sie nicht lesen kann.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.anlegen(w.site(), gore(w), "sub-einrichter")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(409));

        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));
        assertThat(s.datenquelle().unitId()).isEqualTo(1);
        assertThat(s.datenquelle().boxId()).isEqualTo(w.box());
        assertThat(s.hersteller()).isEqualTo("WAGO");
        assertThat(s.fassung().teAnzahl()).isEqualTo(3);
        assertThat(s.fassung().funktionscode()).isEqualTo(4);
        assertThat(s.fassung().wortfolge()).isEqualTo("big");
        assertThat(s.fassung().steuerungKennung()).as("nicht vergeben, nie 0").isNull();
        assertThat(s.fassung().rseStufen()).singleElement()
                .satisfies(r -> assertThat(r.prozent()).isEqualByComparingTo("60"));
        assertThat(s.einheiten()).extracting(AnlagensteuerungDto.Einheit::teNr).containsExactly(1, 2, 3);
        // Ohne Anzeige-Typ belegt der Typname aus dem Bild vor; ein eigener bleibt.
        assertThat(s.einheiten().get(0).typ()).isEqualTo("Growatt MAX 125KTL3-X LV");
        assertThat(s.einheiten().get(2).typ()).isEqualTo("Growatt MAX 125KTL3-X");
        assertThat(s.einheiten().get(1).nennleistungKw()).as("nicht erhoben").isNull();

        // EIN Gerät: der Anlege-Trigger legt für die Komponente kein zweites an.
        assertThat(root.queryForObject("SELECT count(*) FROM geraet WHERE site_id = ?", Integer.class, w.site()))
                .isEqualTo(1);
        assertThat(root.queryForObject("SELECT data_source_id FROM measurement_point WHERE id = ?", UUID.class,
                s.entityId())).isEqualTo(w.quelle());
        assertThat(root.queryForObject("SELECT entity_type FROM measurement_point WHERE id = ?", String.class,
                s.entityId())).isEqualTo("anlagensteuerung");

        // Dieselbe Steuerung zweimal: 409. Lücken in den TE-Nummern: 400.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.anlegen(w.site(), gore(w), "sub-einrichter")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
        AnlagensteuerungDto.Anlegen luecke = new AnlagensteuerungDto.Anlegen(w.quelle(), 1, null, null, null, null,
                null, null, "bhkw", null, null, null, null, List.of(
                        new AnlagensteuerungDto.NeueEinheit(1, null, null, null, null, null, null),
                        new AnlagensteuerungDto.NeueEinheit(3, null, null, null, null, null, null)), null);
        assertThatThrownBy(() -> als(w.tenant(), () -> service.anlegen(w.site(), luecke, "sub-einrichter")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(400));

        AnlagensteuerungDto.Liste nachher = als(w.tenant(), () -> service.liste(w.site()));
        assertThat(nachher.einrichtung().moeglich()).isTrue();
        assertThat(nachher.steuerungen()).singleElement().extracting(AnlagensteuerungDto.Anlagensteuerung::geraetId)
                .isEqualTo(s.geraetId());

        // Der Publisher liest dieselbe laufende Fassung.
        List<Map<String, Object>> bilder = als(w.tenant(), () -> registerbilder.fuer(w.site(), List.of(
                new MeasurementPlan.Entry(s.entityId(), "erzeuger.te[3].t_p_ist_w", 5, null, "x", 90, null, null))));
        assertThat(new ObjectMapper().valueToTree(bilder).toString()).isEqualTo("[{\"entity_id\":\"" + s.entityId()
                + "\",\"basisadresse\":0,\"funktionscode\":4,\"wortfolge\":\"big\",\"te_anzahl\":3,"
                + "\"anlagenart\":\"pv\",\"veraltet_netzpunkt_s\":30}]");

        // Ein fremder Mandant sieht weder Anlage noch Gerät.
        Welt fremd = welt("Erzeuger-Fremd");
        assertThatThrownBy(() -> als(fremd.tenant(), () -> service.liste(w.site())))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThatThrownBy(() -> als(fremd.tenant(), () -> service.einheitAendern(s.geraetId(), 1,
                new AnlagensteuerungDto.EinheitAendern(null, "fremd", null, null, null))))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThat(als(fremd.tenant(), () -> registerbilder.fuer(w.site(), List.of(new MeasurementPlan.Entry(
                s.entityId(), "erzeuger.a.p_nvp_w", 5, null, "x", 90, null, null))))).isEmpty();
    }

    @Test
    void ohneWerteKeineDatenNieNullUndZustaendeSprechenIhrVokabular() {
        Welt w = welt("Erzeuger-Werte");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));

        AnlagensteuerungDto.Werte leer = als(w.tenant(), () -> service.werte(w.site(), s.geraetId()));
        assertThat(leer.stand()).isEqualTo("noch_keine_daten");
        assertThat(leer.werte()).hasSize(26 + 3 * 7)
                .allSatisfy(x -> {
                    assertThat(x.wert()).isNull();
                    assertThat(x.zustand()).isEqualTo("keine_daten");
                });

        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        probe(w, s.entityId(), "erzeuger.a.p_nvp_w", -41230, "good", jetzt, 1);
        probe(w, s.entityId(), "erzeuger.wirkung.quelle_p", 1, "good", jetzt, 2);
        probe(w, s.entityId(), "erzeuger.nb.n_bits", 0b111, "good", jetzt, 3);
        probe(w, s.entityId(), "erzeuger.te[2].t_zustand", 9, "good", jetzt, 4);
        probe(w, s.entityId(), "erzeuger.a.p_erzeugung_w", 41000, "good", jetzt.minusSeconds(600), 5);
        AnlagensteuerungDto.Werte werte = als(w.tenant(), () -> service.werte(w.site(), s.geraetId()));
        assertThat(werte.stand()).isEqualTo("daten");
        Map<String, AnlagensteuerungDto.Wert> je = new java.util.HashMap<>();
        werte.werte().forEach(x -> je.put(x.pointKey(), x));
        assertThat(je.get("erzeuger.a.p_nvp_w").wert()).isEqualByComparingTo("-41230");
        assertThat(je.get("erzeuger.a.p_nvp_w").zustand()).isEqualTo("aktuell");
        assertThat(je.get("erzeuger.a.p_nvp_w").einheit()).isEqualTo("W");
        assertThat(je.get("erzeuger.wirkung.quelle_p").wort()).isEqualTo("netzbetreiber");
        assertThat(je.get("erzeuger.nb.n_bits").bits()).extracting(AnlagensteuerungDto.Bit::wort)
                .containsExactly("vorgabe_gueltig", "verbindung_steht", "wirkleistung_begrenzt");
        assertThat(je.get("erzeuger.te[2].t_zustand").teNr()).isEqualTo(2);
        assertThat(je.get("erzeuger.te[2].t_zustand").wort()).as("außerhalb des Vokabulars: roh, ohne Wort").isNull();
        assertThat(je.get("erzeuger.a.p_erzeugung_w").zustand()).isEqualTo("veraltet");
        assertThat(je.get("erzeuger.te[1].t_p_ist_w").wert()).isNull();
    }

    /**
     * {@code juengste} liest {@code device_measurement_sample} ohne {@code site} (SiteScopeArchitekturTest,
     * UEBER_MESSKOMPONENTE): die Reihe trägt nur den Mandanten-Zaun, den Standort-Zaun bringt die Quelle der
     * {@code entity_id}.
     */
    @Test
    void dieJuengstenWerteGibtEsNurUeberEineSichtbareSteuerung() {
        Welt w = welt("Erzeuger-Zaun");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));
        probe(w, s.entityId(), "erzeuger.a.p_nvp_w", -41230, "good", Instant.now().truncatedTo(ChronoUnit.SECONDS), 1);
        List<String> punkt = List.of("erzeuger.a.p_nvp_w");

        Welt fremd = welt("Erzeuger-Zaun-Fremd");
        assertThat(als(fremd.tenant(), () -> repo.juengste(w.tenant(), s.entityId(), punkt))).singleElement()
                .as("fremder Mandant, selbst mit der richtigen tenant_id und entity_id: RLS")
                .extracting(AnlagensteuerungRepository.Jungster::zeit).isNull();

        Zugriff ohneStandort = new Zugriff("sub-zaun", Konto.BENUTZER, w.tenant(), Zugang.KONTO, List.of(),
                Instant.now());
        assertThat(alsMit(ohneStandort, () -> repo.steuerungen(w.site()))).isEmpty();
        assertThat(alsMit(ohneStandort, () -> repo.steuerung(s.geraetId()))).isEmpty();
        assertThatThrownBy(() -> alsMit(ohneStandort, () -> service.werte(w.site(), s.geraetId())))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThat(alsMit(ohneStandort, () -> repo.juengste(w.tenant(), s.entityId(), punkt))).singleElement()
                .as("die Reihe selbst hat keinen Standort-Zaun: deshalb nur eine entity_id aus STEUERUNG")
                .extracting(AnlagensteuerungRepository.Jungster::zeit).isNotNull();
    }

    @Test
    void programmstandOhneWertUnbekanntUndAelterAlsDieBibliothekWarnt() {
        Welt w = welt("Erzeuger-Programmstand");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));
        assertThat(s.fassung().programmstandSoll()).as("folgt der Bibliothek").isNull();
        assertThat(s.programmstand().zustand()).isEqualTo("unbekannt");
        assertThat(s.programmstand().ist()).as("kein Wert, nie 0").isNull();
        assertThat(s.programmstand().soll()).isEqualTo(Programmstand.BIBLIOTHEK);
        assertThat(s.programmstand().sollQuelle()).isEqualTo("bibliothek");
        assertThat(s.programmstand().warnen()).isFalse();

        Instant jetzt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        probe(w, s.entityId(), Programmstand.PUNKT, 2605, "good", jetzt.minusSeconds(60), 1);
        AnlagensteuerungDto.Programmstand alt = als(w.tenant(), () -> service.liste(w.site())).steuerungen().get(0)
                .programmstand();
        assertThat(alt.zustand()).isEqualTo("aelter");
        assertThat(alt.istText()).isEqualTo("26.05");
        assertThat(alt.warnen()).isTrue();
        assertThat(alt.gemessenAm().toInstant()).isEqualTo(jetzt.minusSeconds(60));

        // Der jüngste Wert zählt: nach dem Einspielen ist die Anlage aktuell.
        probe(w, s.entityId(), Programmstand.PUNKT, Programmstand.BIBLIOTHEK, "good", jetzt, 2);
        AnlagensteuerungDto.Programmstand neu = als(w.tenant(), () -> service.liste(w.site())).steuerungen().get(0)
                .programmstand();
        assertThat(neu.zustand()).isEqualTo("aktuell");
        assertThat(neu.warnen()).isFalse();

        // Ein Soll in der Fassung gilt vor der Bibliothek; ungültig ist 400 vor jedem Schreiben.
        root.update("UPDATE registerbild_fassung SET programmstand_soll = 2701 WHERE geraet_id = ?", s.geraetId());
        AnlagensteuerungDto.Programmstand fassung = als(w.tenant(), () -> service.liste(w.site())).steuerungen()
                .get(0).programmstand();
        assertThat(fassung.zustand()).isEqualTo("aelter");
        assertThat(fassung.sollText()).isEqualTo("27.01");
        assertThat(fassung.sollQuelle()).isEqualTo("fassung");
        assertThatThrownBy(() -> root.update("UPDATE registerbild_fassung SET programmstand_soll = 2613 "
                + "WHERE geraet_id = ?", s.geraetId())).hasMessageContaining("registerbild_fassung_programmstand_chk");
    }

    @Test
    void verlaufNenntJedeKurveDerFassungUndZaehltNurGuteWerteInIhremEimer() {
        Welt w = welt("Erzeuger-Verlauf");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));
        java.time.LocalDate tag = java.time.LocalDate.of(2026, 10, 20);
        Instant mittag = tag.atTime(12, 0).atZone(AnlagensteuerungService.ZONE).toInstant();
        probe(w, s.entityId(), "erzeuger.te[2].t_p_ist_w", 40000, "good", mittag.plusSeconds(60), 1);
        probe(w, s.entityId(), "erzeuger.te[2].t_p_ist_w", 42000, "good", mittag.plusSeconds(120), 2);
        probe(w, s.entityId(), "erzeuger.te[2].t_p_ist_w", 99999, "invalid", mittag.plusSeconds(180), 3);
        probe(w, s.entityId(), "erzeuger.nb.n_p_prozent", 60, "good", mittag.plusSeconds(1200), 4);
        // Der Tag davor und ein Zustand gehören nicht in diese Kurven.
        probe(w, s.entityId(), "erzeuger.te[2].t_p_ist_w", 1, "good", mittag.minus(1, ChronoUnit.DAYS), 5);
        probe(w, s.entityId(), "erzeuger.te[2].t_zustand", 2, "good", mittag.plusSeconds(60), 6);

        AnlagensteuerungDto.Verlauf v = als(w.tenant(), () -> service.verlauf(w.site(), s.geraetId(), "day", tag));
        assertThat(v.range()).isEqualTo("day");
        assertThat(v.bucketMinutes()).isEqualTo(15);
        assertThat(v.kurven()).extracting(AnlagensteuerungDto.Kurve::pointKey)
                .as("jede Kurve der Fassung, auch ohne Eimer; kein Zustand, kein Alter")
                .containsExactlyElementsOf(ErzeugerRegisterbild.kurven(3))
                .contains("erzeuger.a.p_nvp_w", "erzeuger.a.speicher_fuellstand", "erzeuger.nb.n_p_prozent",
                        "erzeuger.dv.d_soll_w", "erzeuger.te[3].t_p_soll_w")
                .doesNotContain("erzeuger.te[2].t_zustand", "erzeuger.a.a_alter_s", "erzeuger.nb.n_cosphi");
        Map<String, AnlagensteuerungDto.Kurve> je = new java.util.HashMap<>();
        v.kurven().forEach(k -> je.put(k.pointKey(), k));
        AnlagensteuerungDto.Kurve ist = je.get("erzeuger.te[2].t_p_ist_w");
        assertThat(ist.teNr()).isEqualTo(2);
        assertThat(ist.einheit()).isEqualTo("W");
        assertThat(ist.eimer()).singleElement().satisfies(e -> {
            assertThat(e.start().toInstant()).isEqualTo(mittag);
            assertThat(e.avg()).isEqualByComparingTo("41000");
            assertThat(e.max()).as("der ungültige Wert zählt nicht").isEqualByComparingTo("42000");
            assertThat(e.last()).isEqualByComparingTo("42000");
            assertThat(e.n()).isEqualTo(2);
        });
        assertThat(je.get("erzeuger.nb.n_p_prozent").eimer()).singleElement()
                .satisfies(e -> assertThat(e.start().toInstant()).isEqualTo(mittag.plusSeconds(900)));
        assertThat(je.get("erzeuger.a.p_nvp_w").eimer()).as("ohne Wert kein Eimer, nie 0").isEmpty();

        AnlagensteuerungDto.Verlauf monat = als(w.tenant(), () -> service.verlauf(w.site(), s.geraetId(), "month",
                tag));
        assertThat(monat.from().toInstant()).isEqualTo(java.time.LocalDate.of(2026, 10, 1)
                .atStartOfDay(AnlagensteuerungService.ZONE).toInstant());
        assertThat(monat.kurven().stream().filter(k -> k.pointKey().equals("erzeuger.te[2].t_p_ist_w")).findFirst()
                .orElseThrow().eimer()).as("Berliner Tage").hasSize(2);

        assertThatThrownBy(() -> als(w.tenant(), () -> service.verlauf(w.site(), s.geraetId(), "quartal", tag)))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(400));
        UUID fremd = welt("Erzeuger-Verlauf-fremd").tenant();
        assertThatThrownBy(() -> als(fremd, () -> service.verlauf(w.site(), s.geraetId(), "day", tag)))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
    }

    @Test
    void namenAusDemBildBelegenNurLeeresVorUndDerNetzbetreiberWirdGemeldet() {
        Welt w = welt("Erzeuger-Namen");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));

        AnlagensteuerungDto.NetzVermarktung leer = als(w.tenant(), () -> service.netzVermarktung(w.site()));
        assertThat(leer.revision()).isEqualTo(1);
        assertThat(leer.netzbetreiber()).as("kein Netzanschluss gebunden").isNull();
        assertThat(leer.hinweise()).isEmpty();

        AnlagensteuerungDto.NetzVermarktung n = als(w.tenant(), () -> service.namenAusBild(s.geraetId(),
                new AnlagensteuerungDto.NamenAusBild("N-ERGIE Netz GmbH", "WVV (Stadtwerke Würzburg)", List.of(
                        new AnlagensteuerungDto.TypAusBild(1, "Growatt Bild-Typ"),
                        new AnlagensteuerungDto.TypAusBild(2, "Growatt Bild-Typ"))), "sub-einrichter"));
        assertThat(n.namenAusBild().netzbetreiber()).isEqualTo("N-ERGIE Netz GmbH");
        assertThat(n.direktvermarkter()).as("leer → vorbelegt").isEqualTo("WVV (Stadtwerke Würzburg)");
        assertThat(n.hinweise()).singleElement().extracting(AnlagensteuerungDto.Hinweis::art)
                .isEqualTo("netzbetreiber_nicht_eingetragen");
        List<AnlagensteuerungDto.Einheit> einheiten = als(w.tenant(), () -> service.liste(w.site()))
                .steuerungen().get(0).einheiten();
        assertThat(einheiten.get(0).typ()).as("vorhandene Anzeige bleibt").isEqualTo("Growatt MAX 125KTL3-X LV");
        assertThat(einheiten.get(0).typBild()).isEqualTo("Growatt Bild-Typ");
        assertThat(einheiten.get(1).typ()).as("leere Anzeige wird vorbelegt").isEqualTo("Growatt Bild-Typ");
        // Eine Einheit, die die Steuerung nicht trägt: nie still umgehängt.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.namenAusBild(s.geraetId(),
                new AnlagensteuerungDto.NamenAusBild(null, null, List.of(new AnlagensteuerungDto.TypAusBild(4, "X"))),
                "sub-einrichter"))).isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(409));

        // Umbenennen ändert nur die Anzeige.
        AnlagensteuerungDto.Einheit umbenannt = als(w.tenant(), () -> service.einheitAendern(s.geraetId(), 2,
                new AnlagensteuerungDto.EinheitAendern("pv_wechselrichter", "Süddach", "Growatt MAX 110KTL3-X",
                        new BigDecimal("110"), null)));
        assertThat(umbenannt.teNr()).isEqualTo(2);
        assertThat(umbenannt.typBild()).isEqualTo("Growatt Bild-Typ");
        assertThat(umbenannt.bezeichnung()).isEqualTo("Süddach");

        // Stammdaten: eine Prozentgrenze nur am statischen Einspeisemanagement, veraltete Revision 409.
        int revision = als(w.tenant(), () -> service.netzVermarktung(w.site())).revision();
        assertThatThrownBy(() -> als(w.tenant(), () -> service.netzVermarktungAendern(w.site(),
                new AnlagensteuerungDto.NetzVermarktungAendern(revision, null, null, "stufen", new BigDecimal("70")),
                "sub-einrichter"))).isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(400));
        AnlagensteuerungDto.NetzVermarktung g = als(w.tenant(), () -> service.netzVermarktungAendern(w.site(),
                new AnlagensteuerungDto.NetzVermarktungAendern(revision, "WVV", "relais_ma", "statisch",
                        new BigDecimal("70")), "sub-einrichter"));
        assertThat(g.revision()).isEqualTo(revision + 1);
        assertThat(g.direktvermarkterKanal()).isEqualTo("relais_ma");
        assertThatThrownBy(() -> als(w.tenant(), () -> service.netzVermarktungAendern(w.site(),
                new AnlagensteuerungDto.NetzVermarktungAendern(revision, "alt", null, null, null),
                "sub-einrichter"))).isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
    }

    @Test
    void ersteStammdatenMitRevisionNullUndEinheitZiehtMitDemControllerUm() {
        Welt w = welt("Erzeuger-Wechsel");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        AnlagensteuerungDto.NetzVermarktung erst = als(w.tenant(), () -> service.netzVermarktungAendern(w.site(),
                new AnlagensteuerungDto.NetzVermarktungAendern(0, null, "keiner", "fernwirk", null), "sub"));
        assertThat(erst.revision()).isEqualTo(2);

        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w), "sub"));
        // Der Controllerwechsel kopiert jedes Teil: die Einheit behält TE-Nr., Art, Nennleistung und MaStR-SEE.
        // Der alte Einbau endet morgen, der neue beginnt dort (ein Einbau je Gerät und Zeitpunkt).
        Instant am = Instant.now().truncatedTo(ChronoUnit.MINUTES).plus(1, ChronoUnit.DAYS);
        root.update("UPDATE geraet SET ausgebaut_am = ? WHERE id = ?", Timestamp.from(am), s.geraetId());
        UUID neu = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, eingebaut_am) SELECT tenant_id, site_id, kennzeichen, kennzeichen || 'b', geraeteart, ? "
                + "FROM geraet WHERE id = ? RETURNING id", UUID.class, Timestamp.from(am), s.geraetId());
        GeraetRepository.Teil einheit = als(w.tenant(), () -> geraete.teileDes(s.geraetId())).stream()
                .filter(t -> Integer.valueOf(1).equals(t.teNr())).findFirst().orElseThrow();
        assertThat(einheit.istKarte()).isFalse();
        UUID kopie = als(w.tenant(), () -> geraete.karteWechseln(w.tenant(), einheit, neu, am, true));
        assertThat(root.queryForMap("SELECT teilart, te_nr, einheit_art, nennleistung_kw, registry_unit_id "
                + "FROM geraet_teil WHERE id = ?", kopie)).containsEntry("teilart", "erzeugungseinheit")
                .containsEntry("te_nr", 1).containsEntry("einheit_art", "pv_wechselrichter")
                .containsEntry("registry_unit_id", "SEE912345678901");
    }

    @Test
    void netzUndVermarktungAusDemAnlegeSchrittBelegtNurLeeres() {
        Welt w = welt("Erzeuger-Erstbelegung");
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", w.box());
        // Der Kunde hat den Direktvermarkter schon gepflegt; das Einspeisemanagement ist noch leer.
        als(w.tenant(), () -> service.netzVermarktungAendern(w.site(),
                new AnlagensteuerungDto.NetzVermarktungAendern(0, "Next Kraftwerke", "modbus", null, null), "sub"));
        AnlagensteuerungDto.Anlegen basis = gore(w);
        AnlagensteuerungDto.Anlegen schief = mitNetz(basis, new AnlagensteuerungDto.NetzVermarktungVorbelegen(
                "WVV", "relais_ma", "stufen", new BigDecimal("70")));
        // Eine Prozentgrenze nur zum statischen Einspeisemanagement - geprüft, bevor etwas entsteht.
        assertThatThrownBy(() -> als(w.tenant(), () -> service.anlegen(w.site(), schief, "sub-einrichter")))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(400));
        assertThat(als(w.tenant(), () -> service.liste(w.site())).steuerungen()).isEmpty();

        als(w.tenant(), () -> service.anlegen(w.site(), mitNetz(basis, new AnlagensteuerungDto.NetzVermarktungVorbelegen(
                "WVV (Stadtwerke Würzburg)", "relais_ma", "stufen", null)), "sub-einrichter"));
        AnlagensteuerungDto.NetzVermarktung nv = als(w.tenant(), () -> service.netzVermarktung(w.site()));
        assertThat(nv.direktvermarkter()).isEqualTo("Next Kraftwerke");
        assertThat(nv.direktvermarkterKanal()).isEqualTo("modbus");
        assertThat(nv.einspeisemanagement()).isEqualTo("stufen");
        assertThat(nv.einspeisemanagementProzent()).isNull();
        assertThat(nv.revision()).isEqualTo(3);
    }

    // ------------------------------------------------------------- EZ-18 Messplan automatisch

    private static void faehig(UUID box) {
        root.update("UPDATE device SET supports = '[\"erzeuger_registerbild\"]'::jsonb, supports_reported_at = now() "
                + "WHERE id = ?", box);
    }

    private static List<Map<String, Object>> zeilen(UUID box, UUID entity) {
        return root.queryForList("SELECT point_key, enabled, cadence_s, desired_revision, changed_by "
                + "FROM device_measurement_selection WHERE device_id = ? AND entity_id = ? ORDER BY desired_revision",
                box, entity);
    }

    private static List<JsonNode> protokoll(Welt w, UUID box) {
        return root.queryForList("SELECT neu::text FROM data_source_aenderung WHERE data_source_id = ? "
                + "AND art = 'messwerte_ausgewaehlt' AND device_id = ? ORDER BY id", String.class, w.quelle(), box)
                .stream().map(t -> {
                    try {
                        return MAPPER.readTree(t);
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }).toList();
    }

    @Test
    void nachDemAnlegenLiestDieZustaendigeBoxDieSteuerungVonAllein() throws Exception {
        Welt w = welt("Erzeuger-Messplan");
        faehig(w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));

        // Jeder Punkt des Bilds für die zuständige Box, an der Komponente, mit dem Takt des Katalogs, je Punkt eine
        // Revision — niemand hat etwas angehakt.
        List<Map<String, Object>> zeilen = zeilen(w.box(), s.entityId());
        assertThat(zeilen).extracting(z -> (String) z.get("point_key"))
                .containsExactlyElementsOf(ErzeugerRegisterbild.punkte(3));
        assertThat(zeilen).allSatisfy(z -> {
            assertThat(z.get("enabled")).isEqualTo(true);
            assertThat(z.get("changed_by")).isEqualTo(MeasurementSelectionService.AUTOMATIK_AKTEUR);
        });
        Map<String, Object> takt = new java.util.HashMap<>();
        zeilen.forEach(z -> takt.put((String) z.get("point_key"), z.get("cadence_s")));
        assertThat(takt.get("erzeuger.a.p_erzeugung_w")).isEqualTo(5);
        assertThat(takt.get("erzeuger.te[2].t_p_ist_w")).isEqualTo(5);
        assertThat(takt.get("erzeuger.te[2].t_e")).isEqualTo(60);
        assertThat(takt.get("erzeuger.kopf.programmstand")).isEqualTo(60);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection_event WHERE device_id = ? "
                + "AND event_kind = 'selection_requested'", Integer.class, w.box())).isEqualTo(47);
        MeasurementSelectionService.State stand = als(w.tenant(), () -> auswahl.state(w.box()));
        assertThat(stand.desiredRevision()).isEqualTo(47);
        assertThat(stand.status()).as("wartet auf die Quittung der Box").isEqualTo("pending_edge");
        assertThat(stand.volumeEstimate().hardRejected()).isFalse();

        // Das Dokument, das der Publisher der Box zustellt: Revision 47, jeder Punkt mit seiner Komponente, und die
        // Parameter des Bilds — ohne sie bliebe jeder Erzeuger-Punkt ungelesen.
        JsonNode dokument = MAPPER.readTree(ZustellungOhneBroker.dokument(auswahlRepo, auswahl, kadenzen, MAPPER,
                w.tenant(), w.box(), faehigkeiten, registerbilder));
        assertThat(dokument.path("revision").asLong()).isEqualTo(47);
        assertThat(dokument.path("selections")).hasSize(47)
                .allSatisfy(e -> assertThat(e.path("entity_id").asText()).isEqualTo(s.entityId().toString()));
        assertThat(dokument.path("erzeuger_registerbilder")).hasSize(1);
        assertThat(dokument.path("erzeuger_registerbilder").get(0).path("entity_id").asText())
                .isEqualTo(s.entityId().toString());
        assertThat(dokument.path("erzeuger_registerbilder").get(0).path("te_anzahl").asInt()).isEqualTo(3);

        // Das Protokoll der Datenquelle nennt es, einmal, mit der Box.
        List<JsonNode> eintraege = protokoll(w, w.box());
        assertThat(eintraege).hasSize(1);
        JsonNode neu = eintraege.get(0);
        assertThat(neu.path("anlass").asText()).isEqualTo("anlegen");
        assertThat(neu.path("gewaehlt").asInt()).isEqualTo(47);
        assertThat(neu.path("ausgelassen")).isEmpty();
        assertThat(AenderungSatz.satz("datenquelle", "messwerte_ausgewaehlt", null, neu, null))
                .isEqualTo("Messwerte für die Box ausgewählt: 47 von 47");
        assertThat(root.queryForObject("SELECT actor_name FROM data_source_aenderung WHERE data_source_id = ? "
                + "AND art = 'messwerte_ausgewaehlt'", String.class, w.quelle())).isEqualTo("Messplan");

        // Eine versorgte Steuerung findet das Nachholen nicht.
        assertThat(messplan.nachholen()).doesNotContain(w.box());
        assertThat(zeilen(w.box(), s.entityId())).hasSize(47);
    }

    @Test
    void nachholenVersorgtEineSteuerungOhneAuswahlEinmalAchtetDieAbwahlUndFolgtDemBoxwechsel() {
        Welt w = welt("Erzeuger-Nachholen");
        faehig(w.box());
        UUID zuweisung = root.queryForObject("SELECT id FROM data_source_assignment WHERE data_source_id = ?",
                UUID.class, w.quelle());
        // Beim Anlegen ist die Übergabe der Quelle offen, es gibt keine ausführende Box — so steht die Steuerung da
        // wie eine, die vor EZ-18 angelegt wurde (Gore): ohne jede Auswahl.
        root.update("INSERT INTO data_source_handover (tenant_id, data_source_id, site_id, assignment_id, reader_id, "
                + "target_id, phase, due_at, event_id) VALUES (?, ?, ?, ?, ?, ?, 'removing', now(), gen_random_uuid())",
                w.tenant(), w.quelle(), w.site(), zuweisung, w.box(), w.box());
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gore(w),
                "sub-einrichter"));
        assertThat(zeilen(w.box(), s.entityId())).isEmpty();
        assertThat(messplan.nachholen()).as("Übergabe offen: wartet auf den nächsten Takt").doesNotContain(w.box());
        assertThat(zeilen(w.box(), s.entityId())).isEmpty();
        assertThat(protokoll(w, w.box())).isEmpty();

        // Die Übergabe ist durch: das Nachholen wählt alle Punkte, genau einmal.
        root.update("UPDATE data_source_handover SET phase = 'active' WHERE data_source_id = ?", w.quelle());
        assertThat(messplan.nachholen()).containsOnlyOnce(w.box());
        assertThat(zeilen(w.box(), s.entityId())).hasSize(47);
        assertThat(protokoll(w, w.box())).singleElement()
                .satisfies(n -> assertThat(n.path("anlass").asText()).isEqualTo("nachholen"));
        assertThat(messplan.nachholen()).doesNotContain(w.box());
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_selection_event WHERE device_id = ?",
                Integer.class, w.box())).isEqualTo(47);

        // Eine Abwahl von Hand bleibt stehen: die Box hat eine Auswahl, das Nachholen fasst sie nicht an.
        als(w.tenant(), () -> auswahl.change(w.box(), s.entityId(), "erzeuger.nb.n_cosphi",
                new MeasurementSelectionService.Change(47, UUID.randomUUID(), false, null),
                new MeasurementSelectionService.Actor("sub-einrichter", "Ines")));
        assertThat(messplan.nachholen()).doesNotContain(w.box());
        assertThat(root.queryForObject("SELECT enabled FROM device_measurement_selection WHERE device_id = ? "
                + "AND entity_id = ? AND point_key = 'erzeuger.nb.n_cosphi'", Boolean.class, w.box(), s.entityId()))
                .isFalse();

        // „Zuständige Box wechseln“: die neue Box hat für die Steuerung keine Auswahl — das Nachholen versorgt sie,
        // sobald sie die Quelle ausführt.
        UUID neueBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, w.tenant(), w.site(), "edge-erzeugernachholenneu");
        faehig(neueBox);
        root.update("UPDATE data_source_assignment SET effective_to = date_trunc('minute', now()) WHERE id = ?",
                zuweisung);
        UUID zweite = root.queryForObject("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, "
                + "protokoll, adresse, effective_from) SELECT d.tenant_id, d.id, ?, d.protokoll, d.adresse, "
                + "date_trunc('minute', now()) FROM data_source d WHERE d.id = ? RETURNING id", UUID.class, neueBox,
                w.quelle());
        root.update("UPDATE data_source_handover SET assignment_id = ?, reader_id = ?, target_id = ? "
                + "WHERE data_source_id = ?", zweite, neueBox, neueBox, w.quelle());
        assertThat(messplan.nachholen()).containsOnlyOnce(neueBox).doesNotContain(w.box());
        assertThat(zeilen(neueBox, s.entityId())).hasSize(47);
        assertThat(protokoll(w, neueBox)).singleElement()
                .satisfies(n -> assertThat(n.path("anlass").asText()).isEqualTo("nachholen"));
        assertThat(messplan.nachholen()).doesNotContain(neueBox);
    }

    @Test
    void reichtDasBudgetNichtWirdNachBildreihenfolgeGewaehltUndDasAusgelasseneProtokolliert() {
        Welt w = welt("Erzeuger-Budget");
        faehig(w.box());
        // Zehn Einheiten: 26 + 10 × 7 Punkte wären 723 Messwerte je Minute, die Grenze ist 600.
        List<AnlagensteuerungDto.NeueEinheit> zehn = IntStream.rangeClosed(1, 10)
                .mapToObj(n -> new AnlagensteuerungDto.NeueEinheit(n, "pv_wechselrichter", "WR " + n, null, null, null,
                        null)).toList();
        AnlagensteuerungDto.Anlegen gross = new AnlagensteuerungDto.Anlegen(w.quelle(), 1, "Große Anlage", null, null,
                null, null, null, "pv", null, null, null, null, zehn, null);
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> service.anlegen(w.site(), gross,
                "sub-einrichter"));

        List<String> gewaehlt = zeilen(w.box(), s.entityId()).stream().map(z -> (String) z.get("point_key")).toList();
        // Bildreihenfolge: alle festen Abschnitte (mit der Erzeugung der Anlage) und die Einheiten 1 … 7 ganz.
        assertThat(gewaehlt).containsAll(ErzeugerRegisterbild.punkte(7)).hasSize(83);
        MeasurementSelectionService.State stand = als(w.tenant(), () -> auswahl.state(w.box()));
        assertThat(stand.volumeEstimate().hardRejected()).isFalse();
        assertThat(stand.volumeEstimate().samplesPerMinute()).isEqualTo(600.0);

        // Nie still nichts: das Protokoll nennt jeden ausgelassenen Punkt mit seinem Grund.
        JsonNode neu = protokoll(w, w.box()).get(0);
        assertThat(neu.path("angefragt").asInt()).isEqualTo(96);
        assertThat(neu.path("gewaehlt").asInt()).isEqualTo(83);
        assertThat(neu.path("ausgelassen")).hasSize(13)
                .allSatisfy(a -> assertThat(a.path("grund").asText()).isEqualTo("budget"));
        assertThat(neu.path("ausgelassen").get(0).path("point_key").asText()).isEqualTo("erzeuger.te[8].t_p_ist_w");
        assertThat(AenderungSatz.satz("datenquelle", "messwerte_ausgewaehlt", null, neu, null))
                .isEqualTo("Messwerte für die Box ausgewählt: 83 von 96, 13 ausgelassen (Messwertbudget)");
        // Und nur einmal: das Nachholen versucht es für diese Box nicht wieder.
        assertThat(messplan.nachholen()).doesNotContain(w.box());
        assertThat(protokoll(w, w.box())).hasSize(1);
    }

    private static AnlagensteuerungDto.Anlegen mitNetz(AnlagensteuerungDto.Anlegen a,
            AnlagensteuerungDto.NetzVermarktungVorbelegen nv) {
        return new AnlagensteuerungDto.Anlegen(a.dataSourceId(), a.unitId(), a.bezeichnung(), a.hersteller(), a.typ(),
                a.basisadresse(), a.funktionscode(), a.wortfolge(), a.anlagenart(), a.steuerungKennung(), a.rseStufen(),
                a.veraltetNetzpunktS(), a.programmstandSoll(), a.einheiten(), nv);
    }

    private static void probe(Welt w, UUID entity, String key, long zahl, String qualitaet, Instant zeit, int seq) {
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, entity_id, "
                + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                + "long_term_cadence_s) VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?, '2026.09.23.3', ?, 'gauge', 300)",
                Timestamp.from(zeit), w.tenant(), w.site(), w.box(), entity, key, zahl, zahl, qualitaet, seq);
    }
}
