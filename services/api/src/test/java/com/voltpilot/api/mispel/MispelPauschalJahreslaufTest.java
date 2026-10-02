package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelPauschalService.Lauf;
import com.voltpilot.api.mispel.MispelPauschalService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-25 gegen die Datenbank: der Jahreslauf der Pauschaloption über ein ganzes Kalenderjahr und über zwei
 * Rumpfjahre, gespeichert mit Nachweis und Prüfsumme.
 *
 * <p>Eine Anlage hat ab 01.01.2027 den Zweirichtungszähler Z1 (MS-01 Bezug, MS-02 Abgabe, Werte des
 * Messstellenbetreibers) und den Förderweg „Marktprämie mit Pauschaloption“ mit AW-Regel {@code viertelstunde}; die
 * AW-Liste der ÜNB und die Spotpreise DE-LU decken das Jahr (AW¼ &gt; 0, SP¼ = 5 ct/kWh). Der Ersatz-Leser liefert die
 * Viertelstunden eines Vektorfalls aus {@code mispel-pauschal-vectors.json} und sonst 0 kWh — der Lauf über das ganze
 * Jahr (35 040 Viertelstunden) rechnet darum genau die Jahreswerte des Vektors: Beispielrechnung 2 (A2 S. 14) und die
 * beiden Rumpfjahre des BNetzA-Beispiels (A2 S. 55–56). Die Pauschaloption gilt hier ab 01.01.2027
 * ({@code voltpilot.mispel.pauschaloption-ab}); vorher bliebe jeder Lauf {@code vorlaeufig}.
 *
 * <p>Zählerrollen, Förderweg, AW-Liste, Spotpreise, Speicherung, RLS und CHECKs laufen echt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class MispelPauschalJahreslaufTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final int JAHR = 2027;
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final Map<String, BigDecimal> P1_8_10 = Map.of("Pinst", BigDecimal.valueOf(8), "SKinst",
            BigDecimal.TEN);

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
        registry.add("voltpilot.mispel.pauschaloption-ab", () -> "2027-01-01");
    }

    @MockBean
    EntityRegistryPublisher registryPublisher;

    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MispelPauschalService dienst;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /** Nach Flyway (der Spring-Kontext migriert erst beim ersten Test), idempotent. */
    private static void marktdaten() {
        // Marktdaten ohne Mandant: die AW-Liste der ÜNB und die Spotpreise DE-LU für das ganze Jahr (MP-7).
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2026-12-31T23:00Z'::timestamptz, '2027-12-31T22:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        root.update("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "SELECT g, 'DE-LU', 'PT15M', 50, 'EUR', 'test' FROM generate_series('2026-12-31T23:00Z'::timestamptz, "
                + "'2027-12-31T22:45Z', INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private record Welt(UUID mandant, UUID anlage) {}

    /** Ersatz-Leser: die Viertelstunden eines Vektorfalls, sonst 0 kWh; {@code ohne} fehlt. */
    private static final class Leser extends MispelZaehlerLeser {
        private final Map<Instant, Map<String, BigDecimal>> werte = new HashMap<>();
        private final Set<Instant> ohne = new HashSet<>();

        Leser(JsonNode fall) {
            super(null);
            for (JsonNode q : fall.get("viertelstunden")) {
                Map<String, BigDecimal> m = new LinkedHashMap<>();
                m.put("MS-01", q.get("Z1NB¼").decimalValue());
                m.put("MS-02", q.get("Z1NE¼").decimalValue());
                werte.put(OffsetDateTime.parse(q.get("beginn").asText()).toInstant(), m);
            }
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                if (!ohne.contains(t)) {
                    BigDecimal w = werte.getOrDefault(t, Map.of()).getOrDefault(kennzeichen, BigDecimal.ZERO);
                    out.put(t, new Menge(w, true));
                }
            }
            return out;
        }
    }

    private static JsonNode fall(String name) throws Exception {
        JsonNode doc = MAPPER.readTree(Files.readString(MispelPauschalVectorsTest.VECTORS));
        for (JsonNode f : doc.get("faelle")) {
            if (f.get("name").asText().equals(name)) {
                return f;
            }
        }
        throw new IllegalStateException("Vektorfall fehlt: " + name);
    }

    private static void wieVektor(Map<String, Bruch> ist, JsonNode soll) {
        java.util.List<String> nummern = new java.util.ArrayList<>();
        soll.fieldNames().forEachRemaining(nummern::add);
        assertThat(ist.keySet()).containsExactlyElementsOf(nummern);
        nummern.forEach(nr -> assertThat(ist.get(nr).compareTo(MispelPauschalRechenwerkTest.exakt(soll.get(nr))))
                .as(nr + " = " + ist.get(nr) + ", soll " + soll.get(nr)).isZero());
    }

    @Test
    void ganzesJahrWieBeispielrechnungZwei() throws Exception {
        JsonNode vektor = fall("bnetza-beispielrechnung-2-hohe-einspeisung");
        Welt w = welt("messstellenbetreiber", "marktpraemie_pauschal");
        Leser leser = new Leser(vektor);
        dienst.leserSetzen(leser);
        dienst.uhrStellen(Clock.fixed(Instant.parse("2028-02-01T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());

        Lauf a = dienst.jahreslauf(w.anlage(), JAHR, Vorgaben.von("P1", P1_8_10));
        assertThat(a.neu()).isTrue();
        assertThat(a.gruende()).isEmpty();
        assertThat(a.zeile().stand()).isEqualTo("endgueltig");
        assertThat(a.zeile().wertequelle()).isEqualTo("messstellenbetreiber");
        assertThat(a.zeile().viertelstundenErwartet()).isEqualTo(365 * 96);
        assertThat(a.zeile().viertelstundenGerechnet()).isEqualTo(365 * 96);
        assertThat(a.zeile().tagVon()).isEqualTo(LocalDate.of(2027, 1, 1));
        assertThat(a.zeile().tagBis()).isEqualTo(LocalDate.of(2027, 12, 31));
        assertThat(a.ergebnis().jahre()).containsOnlyKeys("2027");
        wieVektor(a.ergebnis().jahre().get("2027"), vektor.get("erwartet").get("jahre").get("2027"));
        assertThat(a.ergebnis().jahre().get("2027").get("(P10)").text()).isEqualTo("1500");

        // Gespeichert: Nachweis als Text, Prüfsumme über genau diese Bytes, Version, Zähler und Spalten darin.
        Map<String, Object> zeile = root.queryForMap("SELECT * FROM mispel_pauschal_jahr WHERE tenant_id = ?",
                w.mandant());
        String nachweis = (String) zeile.get("nachweis");
        assertThat(zeile.get("pruefsumme")).isEqualTo(MispelAbgrenzungService.sha256(nachweis));
        assertThat(zeile.get("rechenwerk_version")).isEqualTo("MP-25/1");
        assertThat(zeile.get("jahr")).isEqualTo(2027);
        JsonNode n = MAPPER.readTree(nachweis);
        assertThat(n.path("schluessel").asText()).isEqualTo("2027");
        assertThat(n.path("zeitraum").path("von").asText()).isEqualTo("2027-01-01T00:00+01:00");
        assertThat(n.path("zeitraum").path("bis").asText()).isEqualTo("2028-01-01T00:00+01:00");
        assertThat(n.path("aw_regeln").path("AW¼").asText()).isEqualTo("viertelstunde");
        assertThat(n.path("zaehler").size()).isEqualTo(2);
        assertThat(n.path("spalten").toString()).isEqualTo("[\"beginn\",\"Z1NB¼\",\"Z1NE¼\",\"AW¼ > 0\",\"SP¼\","
                + "\"(P5)¼\",\"(P6)¼\",\"(P12)¼\",\"(P13)¼\"]");
        assertThat(n.path("eingaenge_und_viertelstundenwerte").size()).isEqualTo(365 * 96);
        assertThat(n.path("eingaenge_und_viertelstundenwerte").get(0).toString())
                .isEqualTo("[\"2027-01-01T00:00+01:00\",\"0\",\"0\",true,\"5\",\"1\",\"0\",\"1\",\"0\"]");
        assertThat(n.path("jahreswerte").path("2027").path("(P8)").asText()).isEqualTo("1680");

        // Derselbe Lauf noch einmal: gleiche Prüfsumme, keine neue Fassung.
        Lauf b = dienst.jahreslauf(w.anlage(), JAHR, Vorgaben.von("P1", P1_8_10));
        assertThat(b.neu()).isFalse();
        assertThat(zeilen(w)).isEqualTo(1);

        // Eine fehlende Viertelstunde ist eine Lücke: neue Fassung, vorläufig, eine Viertelstunde weniger, nie als Null.
        leser.ohne.add(Instant.parse("2027-03-20T10:00:00Z"));
        Lauf c = dienst.jahreslauf(w.anlage(), JAHR, Vorgaben.von("P1", P1_8_10));
        assertThat(c.zeile().fassung()).isEqualTo(2);
        assertThat(c.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(c.zeile().viertelstundenGerechnet()).isEqualTo(365 * 96 - 1);
        assertThat(c.gruende()).containsExactly("luecken");
        leser.ohne.clear();

        // Ein Jahr, das noch läuft, bleibt vorläufig.
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-11-01T08:00:00Z"), ZoneOffset.UTC));
        assertThat(dienst.jahreslauf(w.anlage(), JAHR, Vorgaben.von("P1", P1_8_10)).gruende())
                .containsExactly("zeitraum_offen");

        // Ein fremder Mandant sieht keinen Lauf.
        Welt fremd = welt("messstellenbetreiber", "marktpraemie_pauschal");
        TenantContext.set(fremd.mandant());
        assertThat(dienst.laeufe(w.anlage(), JAHR)).isEmpty();
        TenantContext.set(w.mandant());
        assertThat(dienst.laeufe(w.anlage(), JAHR)).hasSize(3);
    }

    /** Zwei Rumpfjahre (A2 S. 55–56): der Änderungstag 16.05. zählt zum ersten, je Rumpfjahr eigene Stammdaten. */
    @Test
    void zweiRumpfjahreWieBnetzaBeispiel() throws Exception {
        JsonNode vektor = fall("bnetza-rumpfjahre-zweiter-speicher-am-16-mai");
        Welt w = welt("geraet", "marktpraemie_pauschal");
        dienst.leserSetzen(new Leser(vektor));
        dienst.uhrStellen(Clock.fixed(Instant.parse("2028-02-01T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());

        Lauf erstes = dienst.jahreslauf(w.anlage(), JAHR, new Vorgaben("P1", P1_8_10, Set.of(), null,
                LocalDate.of(2027, 1, 1), LocalDate.of(2027, 5, 16), null));
        Lauf zweites = dienst.jahreslauf(w.anlage(), JAHR, new Vorgaben("P1", Map.of("Pinst", BigDecimal.valueOf(8),
                "SKinst", BigDecimal.valueOf(15)), Set.of(), null, LocalDate.of(2027, 5, 17), null, null));
        // 136 Tage mit dem 23-Stunden-Tag 28.03.; 229 Tage mit dem 25-Stunden-Tag 31.10.
        assertThat(erstes.zeile().viertelstundenErwartet()).isEqualTo(136 * 96 - 4);
        assertThat(zweites.zeile().viertelstundenErwartet()).isEqualTo(229 * 96 + 4);
        assertThat(erstes.ergebnis().jahre()).containsOnlyKeys("2027-01-01/2027-05-16");
        assertThat(zweites.ergebnis().jahre()).containsOnlyKeys("2027-05-17/2027-12-31");
        wieVektor(erstes.ergebnis().jahre().get("2027-01-01/2027-05-16"),
                vektor.get("erwartet").get("jahre").get("2027-01-01/2027-05-16"));
        wieVektor(zweites.ergebnis().jahre().get("2027-05-17/2027-12-31"),
                vektor.get("erwartet").get("jahre").get("2027-05-17/2027-12-31"));
        // Gerätewerte halten den Lauf vorläufig (E4 = C).
        assertThat(erstes.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(erstes.gruende()).containsExactly("wertequelle_geraet");
        assertThat(dienst.laeufe(w.anlage(), JAHR)).extracting(z -> z.tagVon().toString())
                .containsExactly("2027-01-01", "2027-05-17");

        // Die Datenbank hält E4 = C selbst: endgültig auf Gerätewerten scheitert am CHECK.
        assertThatThrownBy(() -> root.update("INSERT INTO mispel_pauschal_jahr (tenant_id, site_id, jahr, tag_von, "
                + "tag_bis, zeitraum_von, zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme) VALUES (?, ?, "
                + "2027, '2027-01-01', '2027-12-31', '2026-12-31T23:00Z', '2027-12-31T23:00Z', 9, 'P1', 'endgueltig', "
                + "'geraet', 1, 1, 'MP-25/1', '1.0', '{}', ?)", w.mandant(), w.anlage(), "0".repeat(64)))
                .hasMessageContaining("mispel_pauschal_jahr_endgueltig_chk");
        // Ein Rumpfjahr liegt in seinem Kalenderjahr.
        assertThatThrownBy(() -> root.update("INSERT INTO mispel_pauschal_jahr (tenant_id, site_id, jahr, tag_von, "
                + "tag_bis, zeitraum_von, zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme) VALUES (?, ?, "
                + "2027, '2027-06-01', '2028-01-31', '2027-05-31T22:00Z', '2028-01-31T23:00Z', 9, 'P1', 'vorlaeufig', "
                + "'geraet', 1, 1, 'MP-25/1', '1.0', '{}', ?)", w.mandant(), w.anlage(), "0".repeat(64)))
                .hasMessageContaining("mispel_pauschal_jahr_tage_chk");
    }

    @Test
    void lehntAbOhnePauschaloptionOderMitZaehlerFuerAnlageEins() {
        TenantContext.clear();
        Welt abgrenzung = welt("messstellenbetreiber", "marktpraemie_abgrenzung");
        dienst.leserSetzen(new Leser(MAPPER.createObjectNode().set("viertelstunden", MAPPER.createArrayNode())));
        TenantContext.set(abgrenzung.mandant());
        assertThatThrownBy(() -> dienst.jahreslauf(abgrenzung.anlage(), JAHR, Vorgaben.von("P1", P1_8_10)))
                .isInstanceOf(MispelPauschalAbgelehnt.class)
                .hasMessageContaining("nicht „Marktprämie mit Pauschaloption“");

        Welt pauschal = welt("messstellenbetreiber", "marktpraemie_pauschal");
        TenantContext.set(pauschal.mandant());
        // P5 braucht den Zähler ZW (A2 S. 45–46) — die Zählerrollen kennen ihn noch nicht.
        assertThatThrownBy(() -> dienst.jahreslauf(pauschal.anlage(), JAHR, Vorgaben.von("P5", P1_8_10)))
                .isInstanceOf(MispelPauschalAbgelehnt.class).hasMessageContaining("ZWNE");
        // Ein Speicherzähler Z2 ab dem 01.03.: Messwerte für Anlage 1 schließen die Pauschaloption aus (A2 S. 22).
        UUID ms3 = messstelle(pauschal.mandant(), "MS-03", "Laden");
        stellung(pauschal.mandant(), pauschal.anlage(), ms3, "Speicher", "2027-03-01");
        rolle(pauschal.mandant(), ms3, "Z2", "DE0001234567890000000000000000002", "messstellenbetreiber", "2027-03-01");
        assertThatThrownBy(() -> dienst.jahreslauf(pauschal.anlage(), JAHR, Vorgaben.von("P1", P1_8_10)))
                .isInstanceOf(MispelPauschalAbgelehnt.class).hasMessageContaining("Anlage 2 S. 22");
        assertThat(root.queryForObject("SELECT count(*) FROM mispel_pauschal_jahr WHERE tenant_id IN (?, ?)",
                Integer.class, abgrenzung.mandant(), pauschal.mandant())).isZero();
    }

    // ------------------------------------------------------------------ die Welt

    private static int zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM mispel_pauschal_jahr WHERE tenant_id = ?", Integer.class,
                w.mandant());
    }

    /** Netzzähler MS-01/MS-02 (Z1 ab 01.01.2027) und der Förderweg ab 01.01.2027. */
    private static Welt welt(String wertequelle, String foerderweg) {
        marktdaten();
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Jahreslauf #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Haus P', "
                + "'2026-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP25-" + nr);
        UUID netz = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, "
                + "'grid-meter', 'grid-meter', 'grid-meter', ?, false, 'modbus_tcp', "
                + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'"
                + "::jsonb, '2026-12-01') RETURNING id", UUID.class, t, anlage, box);
        UUID ms1 = messstelle(t, "MS-01", "Bezug");
        UUID ms2 = messstelle(t, "MS-02", "Abgabe");
        stellung(t, anlage, ms1, "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms2, "Hauptzähler", "2027-01-01");
        quelle(t, box, ms1, "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms2, "Abgabe", netz, "sunspec.model_203.totwhexp");
        rolle(t, ms1, "Z1", "DE0001234567890000000000000000001", wertequelle, "2027-01-01");
        rolle(t, ms2, "Z1", "DE0001234567890000000000000000001", wertequelle, "2027-01-01");
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, "
                + "aw_regel, gueltig_ab, created_by) VALUES (?, ?, ?, ?, false, 'viertelstunde', '2027-01-01', 'test')",
                t, anlage, foerderweg, "marktpraemie_abgrenzung".equals(foerderweg) ? "A1" : null);
        return new Welt(t, anlage);
    }

    private static UUID messstelle(UUID t, String kz, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kz, kz, richtung);
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung, String ab) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?::date)", t, ms, anlage, stellung, ab);
    }

    private static void quelle(UUID t, UUID box, UUID ms, String richtung, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, '2027-01-01'::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2027-01-01'::timestamptz, false, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente,
                geraet, kanal);
    }

    private static void rolle(UUID t, UUID ms, String rolle, String zp, String wertequelle, String ab) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Netze Musterstadt GmbH', 'eichrechtskonform', '2034-12-31', ?, ?::date)", t, ms, rolle, zp,
                wertequelle, ab);
    }
}
