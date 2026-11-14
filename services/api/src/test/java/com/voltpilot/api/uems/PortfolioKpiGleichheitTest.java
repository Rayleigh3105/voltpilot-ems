package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.PortfolioKpiRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * B7 (vp-perf2-server): die Portfolio-Kennzahlen lesen die Bilanzen und die vereinbarte Leistung für ALLE Anlagen
 * gebündelt ({@link BilanzService#bilanzen}, {@link NetzanschlussRepository#bindungenDerAnlagen}) statt je Anlage.
 * Das ist nur eine andere Form des Lesens: die alte Orchestrierung (je Anlage zwei {@link BilanzService#bilanz}-Aufrufe
 * und zwei Netzanschluss-Lesungen) steht hier wörtlich als Orakel, und jede Bilanz, jede vereinbarte Leistung und die
 * ganze Antwort müssen gleich sein - die Antwort als JSON Byte für Byte.
 *
 * <p>Die Welt deckt ab, was die Ableitung unterscheidet: Hauptzähler mit Unterzählern und bestätigtem Rest (A),
 * Hauptzählerwechsel und Termwechsel im Monat - Tag-für-Tag-Abschnitte (B), Anlage ohne Messstelle mit künftiger
 * Bindung (C), lückenhafte Werte (D, nicht vollständig), Anlage mit Abrechnung „monat“ (E), Zonen aus dem Standort
 * (Wien) neben Zonen aus dem Unternehmen (Berlin) und ein Standortwechsel zwischen den Stichtagen, beendete, laufende
 * und künftige Bindungen und ein Anschluss ohne vereinbarte Leistung; dazu ein fremder Mandant, der nicht durchsickern
 * darf (RLS).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class PortfolioKpiGleichheitTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String LEISTUNG = "sunspec.model_203.w";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** Berlin 14.11.2026 10:30 - der letzte abgeschlossene Monat ist der Oktober 2026, das Vorjahr der Oktober 2025. */
    private static final Instant JETZT = Instant.parse("2026-11-14T09:30:00Z");

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
    }

    @Autowired PortfolioKpiService service;
    @Autowired BilanzService bilanzService;
    @Autowired MessstelleWerteService werteService;
    @Autowired MessstelleFormelService formelService;
    @Autowired NetzanschlussRepository netzanschluss;
    @Autowired SiteRepository sites;
    @Autowired PortfolioKpiRepository spitzen;
    @Autowired ObjectMapper mapper;

    private static JdbcTemplate root;
    private static final AtomicInteger SEQ = new AtomicInteger();

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        Clock wand = Clock.systemUTC();
        bilanzService.uhrStellen(wand);
        werteService.uhrStellen(wand);
        formelService.uhrStellen(wand);
    }

    @Test
    void gebuendeltSagtJedeBilanzJedeVereinbarteLeistungUndDieAntwortGenauSoWieJeAnlage() throws Exception {
        Welt fremd = welt("Fremd");
        Welt w = welt("Portfolio");
        Clock fest = Clock.fixed(JETZT, ZoneOffset.UTC);
        bilanzService.uhrStellen(fest);
        werteService.uhrStellen(fest);
        formelService.uhrStellen(fest);
        TenantContext.set(w.mandant());

        List<UUID> ids = sites.findAll().stream().map(SiteDto::id).toList();
        assertThat(ids).as("nur die fünf Anlagen des Mandanten, nichts vom fremden")
                .containsExactlyInAnyOrderElementsOf(w.anlagen().values());

        // 1) Jede Bilanz: gebündelt == einzeln, für jede Periode und Stichtage beidseits des Standortwechsels.
        List<LocalDate> tage = List.of(LocalDate.parse("2026-10-15"), LocalDate.parse("2025-10-15"),
                LocalDate.parse("2026-10-21"), LocalDate.parse("2026-11-14"));
        int mitHauptzaehler = 0;
        for (String periode : BilanzService.PERIODEN) {
            Map<UUID, List<BilanzDto.Bilanz>> gebuendelt = bilanzService.bilanzen(ids, periode, tage);
            assertThat(gebuendelt.keySet()).containsExactlyElementsOf(ids);
            for (UUID id : ids) {
                for (int i = 0; i < tage.size(); i++) {
                    BilanzDto.Bilanz einzeln = bilanzService.bilanz(id, periode, tage.get(i));
                    assertThat(gebuendelt.get(id).get(i)).as("%s %s %s", periode, tage.get(i), id)
                            .isEqualTo(einzeln);
                    mitHauptzaehler += einzeln.hauptzaehler().isEmpty() ? 0 : 1;
                }
            }
        }
        assertThat(mitHauptzaehler).as("die Probe rechnet wirklich Hauptzähler").isGreaterThan(20);
        assertThat(zoneDer(bilanzService.bilanz(w.anlagen().get("A"), "monat", tage.get(0))))
                .as("A liegt am Standort Wien").isEqualTo("Europe/Vienna");
        assertThat(zoneDer(bilanzService.bilanz(w.anlagen().get("C"), "monat", tage.get(1))))
                .as("C vor dem Standortwechsel: Zone des Unternehmens").isEqualTo("Europe/Berlin");
        assertThat(zoneDer(bilanzService.bilanz(w.anlagen().get("C"), "monat", tage.get(3))))
                .as("C nach dem Standortwechsel: Wien").isEqualTo("Europe/Vienna");

        // 2) Die vereinbarte Leistung: gebündelt == die alte Kette je Anlage, an Tagen vor/in/nach den Bindungen.
        for (LocalDate am : List.of(LocalDate.parse("2025-06-01"), LocalDate.parse("2026-11-14"),
                LocalDate.parse("2026-12-05"))) {
            Map<UUID, BigDecimal> gebuendelt = service.vereinbartKw(ids, am);
            for (UUID id : ids) {
                assertThat(gebuendelt.get(id)).as("%s %s", am, id).isEqualTo(vereinbartAlt(id, am));
            }
        }
        assertThat(service.vereinbartKw(ids, LocalDate.parse("2026-11-14")))
                .containsOnlyKeys(w.anlagen().get("A"), w.anlagen().get("D"));

        // 3) Die ganze Antwort, als JSON Byte für Byte.
        String neu = mapper.writeValueAsString(service.kpis(JETZT));
        String alt = mapper.writeValueAsString(kpisAlt(JETZT));
        assertThat(neu).isEqualTo(alt);
        PortfolioKpiDto dto = service.kpis(JETZT);
        assertThat(dto.verbrauch().kwh()).as("die Probe trägt Zahlen, keine leere Antwort").isNotNull();
        assertThat(dto.verbrauch().vollstaendig()).as("D ist lückenhaft").isFalse();
        assertThat(dto.kosten().eur()).isNotNull();
        assertThat(dto.lastspitze().vereinbartKw()).isNotNull();

        // Der fremde Mandant sieht seine eigene Welt, nicht die des ersten (gebündelte Lesungen unter RLS).
        TenantContext.set(fremd.mandant());
        List<UUID> fremde = sites.findAll().stream().map(SiteDto::id).toList();
        assertThat(fremde).containsExactlyInAnyOrderElementsOf(fremd.anlagen().values());
        assertThat(mapper.writeValueAsString(service.kpis(JETZT)))
                .isEqualTo(mapper.writeValueAsString(kpisAlt(JETZT)));
    }

    private static String zoneDer(BilanzDto.Bilanz b) {
        return b.zeitzone();
    }

    // ================================================================ das Orakel: die Orchestrierung vor B7, wörtlich

    private PortfolioKpiDto kpisAlt(Instant jetzt) {
        LocalDate heute = LocalDate.ofInstant(jetzt, BERLIN);
        YearMonth aktuell = YearMonth.from(heute).minusMonths(1);
        YearMonth vorjahr = aktuell.minusYears(1);
        List<SiteDto> alle = sites.findAll();
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(
                alle.stream().map(SiteDto::abrechnungLeistung).toList(), heute);
        Map<UUID, PortfolioKpiRepository.Spitze> spJahr = f.brauchtJahr()
                ? spitzen.importSpitzen(f.jahrVon(), jetzt) : Map.of();
        Map<UUID, PortfolioKpiRepository.Spitze> spMonat = f.brauchtMonat()
                ? spitzen.importSpitzen(f.monatVon(), jetzt) : Map.of();
        List<PortfolioKpiService.AnlageKpiRoh> roh = new ArrayList<>();
        for (SiteDto s : alle) {
            PortfolioKpiService.Netzbezug jetztM = PortfolioKpiService.netzbezugAus(
                    bilanzService.bilanz(s.id(), "monat", aktuell.atDay(15)));
            PortfolioKpiService.Netzbezug vorM = PortfolioKpiService.netzbezugAus(
                    bilanzService.bilanz(s.id(), "monat", vorjahr.atDay(15)));
            boolean monat = "monat".equals(s.abrechnungLeistung());
            PortfolioKpiRepository.Spitze sp = (monat ? spMonat : spJahr).get(s.id());
            roh.add(new PortfolioKpiService.AnlageKpiRoh(s.name(), jetztM.kwh(), jetztM.vollstaendig(), vorM.kwh(),
                    PortfolioKpiService.arbeitspreis(s), sp != null ? sp.kw() : null, vereinbartAlt(s.id(), heute),
                    sp != null ? sp.zeitpunkt() : null, monat ? f.monatLabel() : f.jahrLabel()));
        }
        PortfolioKpiDto.Periode periode = new PortfolioKpiDto.Periode(
                aktuell.atDay(1), aktuell.atEndOfMonth(), aktuell.getYear(), aktuell.getMonthValue());
        return PortfolioKpiService.aggregiere(periode, roh, service.datenlage(), service.leitkennzahl());
    }

    private BigDecimal vereinbartAlt(UUID siteId, LocalDate am) {
        return netzanschluss.bindungenDerAnlage(siteId).stream()
                .filter(b -> b.laeuftAm(am))
                .findFirst()
                .flatMap(b -> netzanschluss.finde(b.netzanschlussId()))
                .map(NetzanschlussRepository.Anschluss::vereinbartKw)
                .orElse(null);
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, Map<String, UUID> anlagen, Map<String, UUID> messstellen,
            Map<String, UUID> komponenten, Map<String, UUID> boxen) {}

    private Welt welt(String name) {
        int nr = SEQ.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name + "-Probe #" + nr);
        Welt w = new Welt(t, new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>(), new LinkedHashMap<>());
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, "
                + "'Europe/Berlin') RETURNING id", UUID.class, t, name + " GmbH");
        UUID wien = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, land, "
                + "zeitzone, zustand) VALUES (?, ?, 'Werk Wien', 'ST-1', 'AT', 'Europe/Vienna', 'aktiv') RETURNING id", UUID.class, t,
                unternehmen);
        for (String a : List.of("A", "B", "C", "D", "E")) {
            w.anlagen().put(a, root.queryForObject("INSERT INTO site (tenant_id, name, created_at, tarif_art, "
                    + "tarif_param_ct_kwh, abrechnung_leistung) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, t,
                    name + " Anlage " + a, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                    "A".equals(a) || "D".equals(a) ? "fest" : "ohne", arbeitspreis(a),
                    "E".equals(a) ? "monat" : "jahr"));
        }
        // Zonen: A am Standort Wien, C erst ab 01.11.2026; B, D, E ohne Standort (Zone des Unternehmens).
        standort(w, "A", wien, "2024-01-01");
        standort(w, "C", wien, "2026-11-01");

        // A: Hauptzähler mit zwei Unterzählern und bestätigtem Rest; Vorjahr nur der Hauptzähler.
        UUID a0 = messstelle(w, "MS-A0", "A", "Hauptzähler", null, "2020-01-01");
        messstelle(w, "MS-A1", "A", "Unterzähler", a0, "2020-01-01");
        messstelle(w, "MS-A2", "A", "Unterzähler", a0, "2020-01-01");
        UUID rest = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-AR', 'A nicht zugeordnet', 'berechnet', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, herkunft, "
                + "actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?)", t, rest, a0);
        tageswerte(w, "MS-A0", "2026-10-01", "2026-10-31", 120);
        tageswerte(w, "MS-A1", "2026-10-01", "2026-10-31", 70);
        tageswerte(w, "MS-A2", "2026-10-01", "2026-10-31", 20);
        tageswerte(w, "MS-A0", "2025-10-01", "2025-10-31", 110);

        // B: Hauptzählerwechsel am 11.10., ab dem 20.10. ein Unterzähler - Tag-für-Tag-Abschnitte.
        UUID b0 = messstelle(w, "MS-B0", "B", "Hauptzähler", null, "2020-01-01");
        root.update("UPDATE messstelle_stellung SET gueltig_bis = DATE '2026-10-10' WHERE messstelle_id = ?", b0);
        UUID b9 = messstelle(w, "MS-B9", "B", "Hauptzähler", null, "2026-10-11");
        messstelle(w, "MS-B1", "B", "Unterzähler", b9, "2026-10-20");
        tageswerte(w, "MS-B0", "2026-10-01", "2026-10-10", 90);
        tageswerte(w, "MS-B9", "2026-10-11", "2026-10-31", 95);
        tageswerte(w, "MS-B1", "2026-10-20", "2026-10-31", 30);
        tageswerte(w, "MS-B0", "2025-10-01", "2025-10-31", 80);

        // D: Hauptzähler mit Lücke (nur bis 20.10.) - die Summe ist nicht vollständig.
        messstelle(w, "MS-D0", "D", "Hauptzähler", null, "2020-01-01");
        tageswerte(w, "MS-D0", "2026-10-01", "2026-10-20", 60);

        // Netzanschlüsse (je Anschluss und je Anlage höchstens eine Bindung zugleich): A beendet + laufend,
        // B ohne vereinbarte Leistung, C künftig, D laufend, E keiner.
        UUID na1 = netzanschluss(w, wien, "NA-1", new BigDecimal("250.000"));
        UUID na2 = netzanschluss(w, wien, "NA-2", null);
        UUID na3 = netzanschluss(w, wien, "NA-3", new BigDecimal("400.000"));
        UUID na4 = netzanschluss(w, wien, "NA-4", new BigDecimal("150.000"));
        UUID na5 = netzanschluss(w, wien, "NA-5", new BigDecimal("320.000"));
        bindung(w, "A", na1, "2024-01-01", "2025-12-31");
        bindung(w, "A", na3, "2026-01-01", null);
        bindung(w, "B", na2, "2024-01-01", null);
        bindung(w, "C", na4, "2026-12-01", null);
        bindung(w, "D", na5, "2024-01-01", null);

        // Lastspitzen (15-min-Netzbezug): A und D im Jahresfenster, E im laufenden Monat.
        spitze(w, "A", "2026-11-10T09:00:00Z", 30);
        spitze(w, "D", "2026-03-01T09:00:00Z", 50);
        spitze(w, "E", "2026-11-05T09:00:00Z", 10);
        return w;
    }

    /** Arbeitspreis (ct/kWh): A und D mit festem Tarif, die anderen ohne. */
    private static BigDecimal arbeitspreis(String anlage) {
        return switch (anlage) {
            case "A" -> new BigDecimal("31.5");
            case "D" -> new BigDecimal("28.0");
            default -> null;
        };
    }

    private void standort(Welt w, String anlage, UUID standort, String ab) {
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                w.mandant(), w.anlagen().get(anlage), standort, LocalDate.parse(ab));
    }

    private UUID netzanschluss(Welt w, UUID standort, String kennzeichen, BigDecimal vereinbartKw) {
        return root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, vereinbart_kw, "
                + "messung) VALUES (?, ?, ?, ?, ?, 'RLM') RETURNING id", UUID.class, w.mandant(), standort, kennzeichen,
                "Anschluss " + kennzeichen, vereinbartKw);
    }

    private void bindung(Welt w, String anlage, UUID netzanschluss, String ab, String bis) {
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab, gueltig_bis) "
                + "VALUES (?, ?, ?, ?, ?)", w.mandant(), w.anlagen().get(anlage), netzanschluss, LocalDate.parse(ab),
                bis == null ? null : LocalDate.parse(bis));
    }

    private void spitze(Welt w, String anlage, String bucket, double kwh) {
        root.update("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, n_samples, grid_import_kwh) "
                + "VALUES (?, ?, ?, 180, ?)", Timestamp.from(Instant.parse(bucket)), w.mandant(),
                w.anlagen().get(anlage), kwh);
    }

    /** Box, Komponente, Mess-Selektion beider Kanäle, Messstelle mit Nebengröße, zwei führende Quellen, Stellung. */
    private UUID messstelle(Welt w, String kennzeichen, String anlageKey, String stellung, UUID unterzaehlerVon,
            String ab) {
        UUID t = w.mandant();
        UUID anlage = w.anlagen().get(anlageKey);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-PORTFOLIO-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        for (String kanal : List.of(ENERGIE, LEISTUNG)) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                    + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, kanal, KATALOG);
        }
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, groesse, richtung, einheit, wertart) "
                + "VALUES (?, ?, 'Strom', 'Wirkleistung', 'Bezug', 'kW', 'Momentanwert')", t, messstelle);
        Timestamp beginn = Timestamp.from(Instant.parse(ab + "T00:00:00Z"));
        Timestamp eingetragen = Timestamp.from(Instant.parse(ab + "T00:01:00Z"));
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, beginn, eingetragen);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkleistung','Bezug',?,?,?,'gauge','momentanwert','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, LEISTUNG, beginn, eingetragen);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage, stellung, unterzaehlerVon, LocalDate.parse(ab));
        w.messstellen().put(kennzeichen, messstelle);
        w.komponenten().put(kennzeichen, komponente);
        w.boxen().put(kennzeichen, box);
        return messstelle;
    }

    /** Endgültige, vollständige Tageswerte {@code [von, bis]} (Menge = Grundwert + Tag des Monats), wie BilanzApiTest. */
    private void tageswerte(Welt w, String kennzeichen, String von, String bis, int grundwert) {
        for (LocalDate tag = LocalDate.parse(von); !tag.isAfter(LocalDate.parse(bis)); tag = tag.plusDays(1)) {
            Instant beginn = tag.atStartOfDay(BERLIN).toInstant();
            Instant ende = tag.plusDays(1).atStartOfDay(BERLIN).toInstant();
            String menge = String.valueOf(grundwert + tag.getDayOfMonth());
            int stunden = (int) Duration.between(beginn, ende).toHours(); // 23/25 an den Umstellungstagen
            root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, site_id, zeitzone, "
                    + "zeitzone_herkunft, beginn, ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, "
                    + "stand_anfang, stand_ende, erhalten, erwartet, abdeckung_prozent, n_good, box, rolle, zustand, "
                    + "endgueltig_ab, version, menge, menge_zustand) VALUES (?, ?, ?, ?, (SELECT site_id FROM device "
                    + "WHERE id = ?), 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', 0, ?::numeric, ?, ?, 100, ?, "
                    + "?, 'fuehrend', 'endgueltig', ?, 1, ?::numeric, 'vollständig')",
                    tag, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, w.boxen().get(kennzeichen),
                    Timestamp.from(beginn), Timestamp.from(ende), stunden, stunden * 4, stunden * 4, stunden * 4, menge,
                    stunden * 60, stunden * 60, stunden * 60, w.boxen().get(kennzeichen),
                    Timestamp.from(ende.plus(Duration.ofDays(7))), menge);
        }
    }
}
