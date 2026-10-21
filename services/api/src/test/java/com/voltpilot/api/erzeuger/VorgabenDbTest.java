package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AnteilVerlustRepository;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS EZ-7 gegen die echte Datenbank, als Laufzeitrolle {@code voltpilot_app} unter RLS: der Vorgaben-Läufer leitet
 * aus gespeicherten Werten einer Gore-Steuerung (Simulator-Fall E1) die Netzbetreiber-Vorgabe ab — genau datiert,
 * mit Schätzung aus der PV-Prognose —, ein zweiter Lauf ändert nichts, ein späterer setzt nahtlos fort und meldet
 * die weiteren Wechsel einer Datenlücke; die Routen lesen Chronik, Detail, Zählung, heute und CSV, ein fremder
 * Mandant sieht nichts, und beide Protokoll-Tabellen behalten zehn Jahre.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class VorgabenDbTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "vorgaben_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "vorgaben_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "vorgaben_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "vorgaben_admin_pw");
    }

    @Autowired AnlagensteuerungService anlagen;
    @Autowired VorgabenService vorgaben;
    @Autowired VorgabenLaufRepository laufRepo;
    @Autowired PlatformTransactionManager transaktionen;
    @Autowired ObjectMapper json;
    @Autowired ForecastModelService modelle;
    @Autowired AnteilVerlustRepository prognosen;
    @Autowired OptimizerDiagnosticsService preise;
    @Autowired HistoryRepository boerse;
    @Autowired @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc;
    @Autowired JdbcTemplate appJdbc;
    static JdbcTemplate root;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    record Welt(UUID tenant, UUID site, UUID box, UUID quelle) {}

    private static Welt welt(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?, 'Gore') RETURNING id",
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

    private static <T> T als(UUID tenant, Supplier<T> was) {
        TenantContext.set(tenant);
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private VorgabenLaeufer laeufer() {
        return new VorgabenLaeufer(adminJdbc, laufRepo, transaktionen, json, modelle, prognosen, preise, boerse);
    }

    /** Eine Gore-Steuerung (PV, drei Wechselrichter), deren Bindung seit drei Stunden gilt. */
    private AnlagensteuerungDto.Anlagensteuerung gore(Welt w) {
        List<AnlagensteuerungDto.NeueEinheit> einheiten = new ArrayList<>();
        for (int te = 1; te <= 3; te++) {
            einheiten.add(new AnlagensteuerungDto.NeueEinheit(te, "pv_wechselrichter", "WR " + te, null, null,
                    new BigDecimal("125"), null));
        }
        AnlagensteuerungDto.Anlagensteuerung s = als(w.tenant(), () -> anlagen.anlegen(w.site(),
                new AnlagensteuerungDto.Anlegen(w.quelle(), 1, "Anlagensteuerung Gore", "WAGO", "PFC200 750-8212",
                        null, null, null, "pv", null, null, null, null, einheiten, null), "sub-einrichter"));
        // Die Wechselgrenze (uems_wechsel_grenze) lässt nur künftige Wechsel berichtigen; der Test datiert die
        // Bindung zurück, damit es schon gespeicherte Werte gibt — ohne Trigger, in derselben Sitzung.
        root.execute("SET session_replication_role = replica; UPDATE geraet_komponente "
                + "SET gueltig_ab = gueltig_ab - interval '3 hours' WHERE geraet_id = '" + s.geraetId() + "'; "
                + "SET session_replication_role = origin");
        return s;
    }

    /** Gore E1: Netzbetreiber 60 % über Fernwirktechnik, bindet; drei Wechselrichter folgen. */
    private static Map<String, Number> goreBild() {
        Map<String, Number> w = new LinkedHashMap<>();
        w.put("erzeuger.a.a_gueltig", 9);
        w.put("erzeuger.a.p_erzeugung_w", 158400);
        w.put("erzeuger.a.p_installiert_kw", 265);
        w.put("erzeuger.nb.n_kanal", 3);
        w.put("erzeuger.nb.n_bits", 7);
        w.put("erzeuger.nb.n_p_prozent", 60.0);
        w.put("erzeuger.nb.n_seit_s", 340);
        w.put("erzeuger.nb.n_zaehler", 17);
        w.put("erzeuger.dv.d_kanal", 0);
        w.put("erzeuger.dv.d_bits", 0);
        w.put("erzeuger.wirkung.quelle_p", 1);
        w.put("erzeuger.wirkung.s_bits", 3);
        w.put("erzeuger.wirkung.p_grenze_w", 159000);
        for (int te = 1; te <= 3; te++) {
            w.put("erzeuger.te[" + te + "].t_zustand", 3);
            w.put("erzeuger.te[" + te + "].t_bits", 3);
            w.put("erzeuger.te[" + te + "].t_nenn_kw", 125);
            w.put("erzeuger.te[" + te + "].t_p_ist_w", 52800);
            w.put("erzeuger.te[" + te + "].t_p_soll_w", 53000);
        }
        return w;
    }

    private static Map<String, Number> mit(Map<String, Number> basis, Object... paare) {
        Map<String, Number> w = new LinkedHashMap<>(basis);
        for (int i = 0; i < paare.length; i += 2) {
            w.put((String) paare[i], (Number) paare[i + 1]);
        }
        return w;
    }

    /** Eine Lesung als Proben der Komponente; Prozent und cos φ roh mit Faktor wie im Katalog. */
    private static void lesung(Welt w, UUID entity, Instant t, Map<String, Number> werte) {
        List<Object[]> zeilen = new ArrayList<>();
        werte.forEach((punkt, wert) -> {
            BigDecimal decoded = new BigDecimal(wert.toString());
            BigDecimal raw = punkt.endsWith("n_p_prozent") ? decoded.movePointRight(1) : decoded;
            zeilen.add(new Object[] {Timestamp.from(t), w.tenant(), w.site(), w.box(), entity, punkt, raw, decoded});
        });
        root.batchUpdate("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                + "aggregation_kind, long_term_cadence_s) VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, 'good', "
                + "'2026.10.21.1', 1, 'gauge', 300)", zeilen);
    }

    @Test
    void derLaeuferLeitetGoreAbIstIdempotentSetztFortUndDieRoutenLesenEs() {
        Welt w = welt("Vorgaben-Gore");
        AnlagensteuerungDto.Anlagensteuerung s = gore(w);
        UUID entity = s.entityId();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.MINUTES).minus(60, ChronoUnit.MINUTES);
        // Die PV-Prognose der Anlage: 200 kW, ausgegeben am Vortag.
        for (int v = -2; v < 9; v++) {
            Instant slot = t0.truncatedTo(ChronoUnit.HOURS).plus(15L * v, ChronoUnit.MINUTES);
            root.update("INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min, "
                    + "method) VALUES (?, ?, ?, 'pv', 'pv-physical', 200, ?, 1440, 'test')", Timestamp.from(slot),
                    w.tenant(), w.site(), Timestamp.from(slot.minus(1, ChronoUnit.DAYS)));
        }
        // Fünf Minuten 60 %, dann hebt der Netzbetreiber auf 100 % an (n_zaehler 17 → 18, n_seit_s ab 0).
        Map<String, Number> frei = mit(goreBild(), "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0,
                "erzeuger.nb.n_zaehler", 18, "erzeuger.wirkung.quelle_p", 0, "erzeuger.a.p_erzeugung_w", 162000);
        for (int sek = 0; sek < 600; sek += 5) {
            Map<String, Number> bild = sek < 300 ? mit(goreBild(), "erzeuger.nb.n_seit_s", 340 + sek)
                    : mit(frei, "erzeuger.nb.n_seit_s", sek - 300);
            lesung(w, entity, t0.plusSeconds(sek), bild);
        }

        VorgabenLaeufer laeufer = laeufer();
        laeufer.lauf(Instant.now());

        ErzeugerVorgabenDto.Chronik c1 = als(w.tenant(), () -> vorgaben.chronik(w.site(), null, null, null, null));
        assertThat(c1.vorgaben()).singleElement().satisfies(v -> {
            assertThat(v.urheber()).isEqualTo("netzbetreiber");
            assertThat(v.art()).isEqualTo("p_begrenzung");
            assertThat(v.teNr()).isNull();
            assertThat(v.beginn().toInstant()).isEqualTo(t0.minusSeconds(340));
            assertThat(v.beginnGenau()).isTrue();
            assertThat(v.ende().toInstant()).isEqualTo(t0.plusSeconds(300));
            assertThat(v.endeGenau()).isTrue();
            assertThat(v.vorgabeProzent()).isEqualByComparingTo("60");
            assertThat(v.vorgabeW()).isEqualByComparingTo("159000");
            assertThat(v.kanal()).isEqualTo("fernwirktechnik");
            assertThat(v.bindung()).isEqualTo("bindend");
            assertThat(v.zaehlerBeginn()).isEqualTo(17);
            assertThat(v.zaehlerEnde()).isEqualTo(18);
            assertThat(v.methode()).isEqualTo("pv_prognose");
            // (200 − 158,4) kW über die 300 s, in denen der Netzbetreiber band.
            assertThat(v.energieKwh()).isEqualByComparingTo("3.467");
            // Dieselbe Grundlage wie die Erlösanzeige: Eigenverbrauch ohne Inbetriebnahme = Börsenpreis je
            // Viertelstunde (die Dev-Seeds legen ihn für DE-LU an).
            assertThat(v.wertEur()).isEqualByComparingTo(erwarteterWert(t0, 300, 200000 - 158400));
            assertThat(v.unvollstaendig()).as("vor der ersten Lesung fehlt, was geschah").isTrue();
        });
        assertThat(c1.verarbeitetBis().toInstant()).isEqualTo(t0.plusSeconds(595));
        UUID erste = c1.vorgaben().get(0).id();

        // Ein zweiter Lauf ohne neue Werte ändert nichts.
        laeufer.lauf(Instant.now());
        assertThat(root.queryForObject("SELECT count(*) FROM erzeuger_vorgabe WHERE site_id = ?", Integer.class,
                w.site())).isEqualTo(1);

        // Weiter: ab 11 min begrenzt der Netzbetreiber auf 50 %, ab 12 min fehlen acht Minuten, danach ist die
        // Grenze aufgehoben und n_zaehler steht vier weiter — drei Wechsel sah niemand.
        for (int sek = 600; sek < 720; sek += 5) {
            Map<String, Number> bild = sek < 660 ? mit(frei, "erzeuger.nb.n_seit_s", sek - 300)
                    : mit(goreBild(), "erzeuger.nb.n_p_prozent", 50.0, "erzeuger.nb.n_seit_s", sek - 660,
                            "erzeuger.nb.n_zaehler", 19);
            lesung(w, entity, t0.plusSeconds(sek), bild);
        }
        for (int sek = 1200; sek < 1260; sek += 5) {
            lesung(w, entity, t0.plusSeconds(sek), mit(frei, "erzeuger.nb.n_seit_s", sek - 1170,
                    "erzeuger.nb.n_zaehler", 23));
        }
        laeufer.lauf(Instant.now());

        ErzeugerVorgabenDto.Chronik c2 = als(w.tenant(), () -> vorgaben.chronik(w.site(), null, null, null, null));
        assertThat(c2.vorgaben()).hasSize(2);
        assertThat(c2.vorgaben().get(0).id()).isEqualTo(erste);
        ErzeugerVorgabenDto.Vorgabe zweite = c2.vorgaben().get(1);
        assertThat(zweite.beginn().toInstant()).isEqualTo(t0.plusSeconds(660));
        assertThat(zweite.vorgabeProzent()).isEqualByComparingTo("50");
        // Das Ende liegt in der Lücke: genau aus n_seit_s, aber unvollständig belegt.
        assertThat(zweite.ende().toInstant()).isEqualTo(t0.plusSeconds(1170));
        assertThat(zweite.endeGenau()).isTrue();
        assertThat(zweite.unvollstaendig()).isTrue();
        assertThat(c2.luecken()).singleElement().satisfies(l -> {
            assertThat(l.urheber()).isEqualTo("netzbetreiber");
            assertThat(l.beginn().toInstant()).isEqualTo(t0.plusSeconds(715));
            assertThat(l.ende().toInstant()).isEqualTo(t0.plusSeconds(1200));
            assertThat(l.weitereWechsel()).isEqualTo(3);
            assertThat(l.zaehlerVorher()).isEqualTo(19);
            assertThat(l.zaehlerNachher()).isEqualTo(23);
        });

        // Detail: Rohsignale am Beginn und Ende in der Sprache des Bilds, dazu die Proben ihres Zeitraums.
        ErzeugerVorgabenDto.Detail d = als(w.tenant(), () -> vorgaben.detail(w.site(), erste));
        assertThat(d.rohBeginn()).filteredOn(r -> r.feld().equals("n_bits")).singleElement()
                .satisfies(r -> assertThat(r.bits()).extracting(AnlagensteuerungDto.Bit::wort)
                        .containsExactly("vorgabe_gueltig", "verbindung_steht", "wirkleistung_begrenzt"));
        assertThat(d.rohEnde()).filteredOn(r -> r.feld().equals("quelle_p")).singleElement()
                .satisfies(r -> assertThat(r.wort()).isEqualTo("keine_grenze"));
        assertThat(d.signale()).isNotEmpty();
        assertThat(d.signale()).allSatisfy(x -> assertThat(x.pointKey()).startsWith("erzeuger."));

        // Zählung je Tag und „heute“ (nur, wenn die Werte heute in Berlin liegen — nicht kurz nach Mitternacht).
        LocalDate tag = t0.atZone(VorgabenAbleitung.ZONE).toLocalDate();
        boolean einTag = t0.minusSeconds(340).atZone(VorgabenAbleitung.ZONE).toLocalDate().equals(tag)
                && t0.plusSeconds(1260).atZone(VorgabenAbleitung.ZONE).toLocalDate().equals(tag);
        ErzeugerVorgabenDto.Zaehlung z = als(w.tenant(), () -> vorgaben.zaehlung(w.site(), "tag", tag.toString(),
                tag.toString()));
        assertThat(z.abschnitte()).singleElement().satisfies(a -> {
            assertThat(a.gruppen()).singleElement().satisfies(g -> {
                assertThat(g.urheber()).isEqualTo("netzbetreiber");
                assertThat(g.anzahl()).isEqualTo(2);
                if (einTag) {
                    // 340 s vor t0 bis 300 s danach, dann 660 s bis 1170 s.
                    assertThat(g.dauerS()).isEqualTo(640 + 510);
                }
                assertThat(g.energieKwh()).isNotNull();
            });
            assertThat(a.jeUrheber()).singleElement().satisfies(u -> assertThat(u.anzahl()).isEqualTo(2));
        });
        if (einTag && tag.equals(LocalDate.now(VorgabenAbleitung.ZONE))) {
            ErzeugerVorgabenDto.Heute h = als(w.tenant(), () -> vorgaben.heute(w.site()));
            assertThat(h.jeUrheber()).singleElement().satisfies(u -> {
                assertThat(u.urheber()).isEqualTo("netzbetreiber");
                assertThat(u.anzahl()).isEqualTo(2);
            });
            assertThat(h.laufend()).isEmpty();
        }

        // CSV: BOM, deutsche Kopfzeile, de-DE-Zahlen.
        String csv = new String(als(w.tenant(), () -> vorgaben.csv(w.site(), null, null)), StandardCharsets.UTF_8);
        assertThat(csv).startsWith(VorgabenCsv.BOM + "Urheber;Art;Einheit;");
        assertThat(csv).contains("Netzbetreiber;Wirkleistung begrenzt;ganze Anlage;").contains(";Datenlücke;")
                .contains(";3,467;PV-Prognose der Anlage;");

        // Ein fremder Mandant sieht die Anlage nicht (404), ohne Mandant liefert die Tabelle nichts.
        Welt fremd = welt("Vorgaben-Fremd");
        assertThatThrownBy(() -> als(fremd.tenant(), () -> vorgaben.chronik(w.site(), null, null, null, null)))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThatThrownBy(() -> als(fremd.tenant(), () -> vorgaben.detail(fremd.site(), erste)))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThat(appJdbc.queryForObject("SELECT count(*) FROM erzeuger_vorgabe", Integer.class)).isZero();
        assertThat(appJdbc.queryForObject("SELECT count(*) FROM erzeuger_vorgabe_lauf", Integer.class)).isZero();
    }

    /** Σ je 5-s-Stück: Energie × Börsenpreis seiner Viertelstunde (ct/kWh = €/MWh ÷ 10), in Euro. */
    private static BigDecimal erwarteterWert(Instant von, int sekunden, int watt) {
        double ct = 0;
        for (int s = 0; s < sekunden; s += 5) {
            Instant t = von.plusSeconds(s);
            long e = t.getEpochSecond();
            Instant slot = Instant.ofEpochSecond(e - Math.floorMod(e, 900));
            BigDecimal eurMwh = root.queryForObject("SELECT price_eur_mwh FROM day_ahead_prices "
                    + "WHERE bidding_zone = 'DE-LU' AND resolution = 'PT15M' AND ts = ?", BigDecimal.class,
                    Timestamp.from(slot));
            ct += watt * 5 / 3_600_000.0 * eurMwh.doubleValue() / 10.0;
        }
        return BigDecimal.valueOf(ct / 100.0).setScale(2, java.math.RoundingMode.HALF_UP);
    }

    @Test
    void beideProtokollTabellenBehaltenZehnJahreOhneKompression() {
        for (String tabelle : List.of("erzeuger_vorgabe", "erzeuger_vorgabe_luecke")) {
            assertThat(root.queryForObject("SELECT config->>'drop_after' FROM timescaledb_information.jobs "
                    + "WHERE proc_name = 'policy_retention' AND hypertable_name = ?", String.class, tabelle))
                    .as(tabelle).isEqualTo("3653 days");
            assertThat(root.queryForObject("SELECT compression_enabled FROM timescaledb_information.hypertables "
                    + "WHERE hypertable_name = ?", Boolean.class, tabelle)).as(tabelle).isFalse();
        }
        for (String tabelle : List.of("erzeuger_vorgabe", "erzeuger_vorgabe_luecke", "erzeuger_vorgabe_lauf")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, tabelle)).as(tabelle).isTrue();
        }
    }
}
