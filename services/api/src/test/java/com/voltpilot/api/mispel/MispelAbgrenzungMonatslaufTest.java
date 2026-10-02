package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Fallstand;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
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
 * MiSpeL MP-8 und MP-21 gegen die Datenbank: der Monatslauf eines Monats mit Speicher-Rumpf und seine Erkennung.
 *
 * <p>Eine Anlage hat ab 01.01.2027 den Zweirichtungszähler Z1 (MS-01 Bezug, MS-02 Abgabe); der Speicher kommt am
 * 15.03.2027 hinzu (Z2: MS-03 Laden, MS-04 Entladen). Der März ist darum kein ganzer Monat A1: der Lauf über den
 * Kalendermonat lehnt ab ({@code zaehler_fehlt}), der Rumpfmonat ab dem 15. (A1 S. 102, Abschn. 11) rechnet die
 * BNetzA-Beispielrechnungen (A1 S. 15–16, Vektorfall {@code bnetza-beispielrechnungen-speichervorrang}, um eine Woche
 * verschoben) und speichert Nachweis und Prüfsumme. Gerätewerte am Speicher halten den Lauf vorläufig (E4 = C); mit
 * Werten des Messstellenbetreibers wird er endgültig. Eine fehlende Viertelstunde ist eine Lücke, keine Null.
 *
 * <p>Die Zählerwerte liefert ein Ersatz-Leser je Viertelstunde (die Verdichtungskette der Messreihen ist AP-07/AP-08
 * und hier nicht Gegenstand); Zählerrollen, AW-Liste, Speicherung, RLS und CHECKs laufen echt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class MispelAbgrenzungMonatslaufTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final YearMonth MAERZ = YearMonth.of(2027, 3);
    private static final LocalDate RUMPF = LocalDate.of(2027, 3, 15);
    // 17 Tage, davon einer mit 23 Stunden (Sommerzeit-Beginn 28.03.2027).
    private static final int RUMPF_VIERTELSTUNDEN = 17 * 96 - 4;
    private static final Instant Q1 = Instant.parse("2027-03-17T11:00:00Z");
    private static final Instant Q2 = Instant.parse("2027-03-17T18:00:00Z");

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

    @MockBean
    EntityRegistryPublisher registryPublisher;

    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MispelAbgrenzungService dienst;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private record Welt(UUID mandant, UUID anlage) {}

    /** Ersatz-Leser: jede Viertelstunde 0 kWh, außer den beiden der Beispielrechnungen; {@code ohne} fehlt. */
    private static final class Leser extends MispelZaehlerLeser {
        private final Set<Instant> ohne = new HashSet<>();

        Leser() {
            super(null);
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                if (!ohne.contains(t)) {
                    out.put(t, new Menge(wert(kennzeichen, t), true));
                }
            }
            return out;
        }

        // A1 S. 15–16: 130 kWh Netzbezug bei 100 kWh Laden; 80 kWh Einspeisung bei 100 kWh Entladen.
        private static BigDecimal wert(String kz, Instant t) {
            if (t.equals(Q1)) {
                return switch (kz) {
                    case "MS-01" -> new BigDecimal("130");
                    case "MS-03" -> new BigDecimal("100");
                    default -> BigDecimal.ZERO;
                };
            }
            if (t.equals(Q2)) {
                return switch (kz) {
                    case "MS-02" -> new BigDecimal("80");
                    case "MS-04" -> new BigDecimal("100");
                    default -> BigDecimal.ZERO;
                };
            }
            return BigDecimal.ZERO;
        }
    }

    @Test
    void monatMitSpeicherRumpf() throws Exception {
        Welt w = welt("geraet");
        Leser leser = new Leser();
        dienst.leserSetzen(leser);
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-04-10T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());

        // Der ganze März: am 01.03. gibt es Z2 noch nicht — der Lauf rechnet nicht und speichert nichts.
        assertThatThrownBy(() -> dienst.monatslauf(w.anlage(), MAERZ, Vorgaben.von("A1", "viertelstunde")))
                .isInstanceOf(MispelAbgrenzungAbgelehnt.class)
                .hasMessageContaining("Z2V, Z2E");
        assertThat(zeilen(w)).isZero();

        // Der Rumpfmonat ab dem 15.: gerechnet wie Beispielrechnungen 1 und 2, vorläufig wegen Gerätewerten am Speicher.
        Vorgaben rumpf = new Vorgaben("A1", "viertelstunde", null, null, Set.of(), RUMPF, null);
        Lauf a = dienst.monatslauf(w.anlage(), MAERZ, rumpf);
        assertThat(a.neu()).isTrue();
        assertThat(a.zeile().fassung()).isEqualTo(1);
        assertThat(a.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(a.zeile().wertequelle()).isEqualTo("geraet");
        assertThat(a.gruende()).containsExactly("wertequelle_geraet");
        assertThat(a.zeile().viertelstundenErwartet()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        assertThat(a.zeile().viertelstundenGerechnet()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        assertThat(a.ergebnis().monate()).containsOnlyKeys("2027-03/15");
        JsonNode soll = vektorMonat();
        a.ergebnis().monate().get("2027-03/15").forEach((nr, b) -> {
            JsonNode s = soll.get(nr);
            assertThat(s).as(nr).isNotNull();
            if (s.isNull()) {
                assertThat(b).as(nr).isNull();
            } else {
                assertThat(b.compareTo(Bruch.von(s.decimalValue()))).as(nr + " = " + b).isZero();
            }
        });
        assertThat(a.ergebnis().monate().get("2027-03/15").get("(21)").text()).isEqualTo("50");

        // Gespeichert: Nachweis als Text, Prüfsumme über genau diese Bytes, Version und Zählerangaben darin.
        Map<String, Object> zeile = root.queryForMap("SELECT * FROM mispel_abgrenzung_monat WHERE tenant_id = ?",
                w.mandant());
        String nachweis = (String) zeile.get("nachweis");
        assertThat(zeile.get("pruefsumme")).isEqualTo(MispelAbgrenzungService.sha256(nachweis));
        assertThat(zeile.get("rechenwerk_version")).isEqualTo("MP-8/1");
        assertThat(zeile.get("monat").toString()).isEqualTo("2027-03-01");
        JsonNode n = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).readTree(nachweis);
        assertThat(n.path("schluessel").asText()).isEqualTo("2027-03/15");
        assertThat(n.path("zeitraum").path("von").asText()).isEqualTo("2027-03-15T00:00+01:00");
        assertThat(n.path("zaehler").size()).isEqualTo(4);
        assertThat(n.path("eingaenge_und_viertelstundenwerte").size()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        assertThat(n.path("monatswerte").path("2027-03/15").path("(18)").asText()).isEqualTo("0.8");

        // Derselbe Lauf noch einmal: gleiche Prüfsumme, keine neue Fassung.
        Lauf b = dienst.monatslauf(w.anlage(), MAERZ, rumpf);
        assertThat(b.neu()).isFalse();
        assertThat(zeilen(w)).isEqualTo(1);

        // Eine fehlende Viertelstunde ist eine Lücke: neue Fassung, eine Viertelstunde weniger, nie als Null.
        leser.ohne.add(Instant.parse("2027-03-20T10:00:00Z"));
        Lauf c = dienst.monatslauf(w.anlage(), MAERZ, rumpf);
        assertThat(c.zeile().fassung()).isEqualTo(2);
        assertThat(c.zeile().viertelstundenGerechnet()).isEqualTo(RUMPF_VIERTELSTUNDEN - 1);
        assertThat(c.gruende()).contains("luecken");
        leser.ohne.clear();

        // Ein fremder Mandant sieht keinen Lauf.
        Welt fremd = welt("geraet");
        TenantContext.set(fremd.mandant());
        assertThat(dienst.laeufe(w.anlage(), MAERZ)).isEmpty();
        TenantContext.set(w.mandant());
        assertThat(dienst.laeufe(w.anlage(), MAERZ)).hasSize(2);
    }

    /** Ersatz-Leser aus einem Vektorfall: jede Viertelstunde 0 kWh, außer denen des Falls (Eingang → Messstelle). */
    private static final class VektorLeser extends MispelZaehlerLeser {
        private final Map<String, Map<Instant, BigDecimal>> werte = new HashMap<>();

        VektorLeser(JsonNode fall, Map<String, String> messstelleJeEingang) {
            super(null);
            for (JsonNode q : fall.get("viertelstunden")) {
                Instant t = OffsetDateTime.parse(q.get("beginn").asText()).toInstant();
                messstelleJeEingang.forEach((eingang, kz) -> werte.computeIfAbsent(kz, k -> new HashMap<>())
                        .put(t, q.get(eingang).decimalValue()));
            }
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(werte.getOrDefault(kennzeichen, Map.of()).getOrDefault(t, BigDecimal.ZERO), true));
            }
            return out;
        }
    }

    /**
     * MP-32: Basisfall A4 — Z2 vor Stromspeicher und Ladepunkt, Z3 am Stromspeicher allein (A1 S. 31–32). Der Lauf
     * liest sechs Zähler, rechnet wie der Vektorfall und speichert den Formelsatz A4 (V20261002224700).
     */
    @Test
    void monatslaufA4MitZ3AmSpeicher() throws Exception {
        Welt w = weltA4();
        JsonNode fall = vektorFall("a4-gesonderte-messung-speicherverluste");
        dienst.leserSetzen(new VektorLeser(fall, Map.of("Z1NB¼", "MS-01", "Z1NE¼", "MS-02", "Z2V¼", "MS-03",
                "Z2E¼", "MS-04", "Z3V¼", "MS-05", "Z3E¼", "MS-06")));
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-07-10T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());

        Lauf a = dienst.monatslauf(w.anlage(), YearMonth.of(2027, 6), Vorgaben.von("A4", "viertelstunde"));
        assertThat(a.zeile().formelsatz()).isEqualTo("A4");
        assertThat(a.zeile().viertelstundenGerechnet()).isEqualTo(30 * 96);
        JsonNode soll = fall.get("erwartet").get("monate").get("2027-06");
        Map<String, Bruch> ist = a.ergebnis().monate().get("2027-06");
        assertThat(ist.keySet()).containsExactlyElementsOf(() -> soll.fieldNames());
        ist.forEach((nr, b) -> assertThat(b.compareTo(Bruch.von(soll.get(nr).decimalValue()))).as(nr + " = " + b).isZero());
        assertThat(root.queryForObject("SELECT formelsatz FROM mispel_abgrenzung_monat WHERE tenant_id = ?",
                String.class, w.mandant())).isEqualTo("A4");
        JsonNode n = new ObjectMapper().readTree((String) root.queryForObject(
                "SELECT nachweis FROM mispel_abgrenzung_monat WHERE tenant_id = ?", String.class, w.mandant()));
        assertThat(n.path("zaehler").size()).isEqualTo(6);
        // Die Komponente hinter Z2 ist kein Ladepunkt der Festlegung (MP-31 kennt nur ev-charger/wallbox mit
        // Fähigkeit): gerechnet wird, aber der Lauf bleibt vorläufig (A1 S. 26 Fn. 21, S. 29–31).
        assertThat(a.gruende()).contains("kein_ladepunkt_der_festlegung");
        assertThat(a.zeile().stand()).isEqualTo("vorlaeufig");
    }

    /** MP-21: der Speicher kommt am 15. hinzu — erkannt aus den Zählerrollen-Fassungen, gerechnet je Rumpfmonat. */
    @Test
    void rumpfmonateAusDemAenderungsprotokollErkannt() {
        Welt w = welt("geraet");
        dienst.leserSetzen(new Leser());
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-04-10T08:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        Vorgaben a1 = Vorgaben.von("A1", "viertelstunde");

        // Vorher nur die EE-Anlage (keine Bestimmung nach Anlage 1), ab dem 15. Speicher mit Z2 und AW-Regel der
        // Förderseite: ein Rumpfmonat.
        List<Fallstand> mitSpeicher = List.of(new Fallstand(LocalDate.of(2027, 1, 1), null, null, null),
                new Fallstand(RUMPF, "speicher_ladepunkt", "A1", a1));
        MispelRumpfmonate.Teilung t = dienst.teilung(w.anlage(), MAERZ, mitSpeicher);
        assertThat(t.rumpfmonate()).extracting(MispelRumpfmonate.Rumpfmonat::schluessel).containsExactly("2027-03/15");
        assertThat(t.rumpfmonate().get(0).bis()).isEqualTo(LocalDate.of(2027, 4, 1));
        assertThat(t.aenderungen()).singleElement().satisfies(a -> {
            assertThat(a.tag()).isEqualTo(RUMPF);
            assertThat(a.wirkung()).containsExactly("fallkonstellation", "messkonzept", "werte");
            assertThat(a.bestimmungsrelevant()).isTrue();
        });
        List<Lauf> laeufe = dienst.monatslaeufe(w.anlage(), MAERZ, mitSpeicher);
        assertThat(laeufe).singleElement().satisfies(l -> {
            assertThat(l.ergebnis().monate()).containsOnlyKeys("2027-03/15");
            assertThat(l.ergebnis().monate().get("2027-03/15").get("(21)").text()).isEqualTo("50");
            assertThat(l.zeile().viertelstundenErwartet()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        });
        assertThat(zeilen(w)).isEqualTo(1);

        // Behauptet der Aufrufer A1 für den ganzen Monat, zeigt das Protokoll der Zähler das neue Messkonzept am 15.:
        // zwei Rumpfmonate, und der erste hat kein Z2 — abgelehnt, bevor etwas gespeichert wird.
        List<Fallstand> ganzA1 = List.of(new Fallstand(LocalDate.of(2027, 1, 1), null, "A1", a1));
        MispelRumpfmonate.Teilung t2 = dienst.teilung(w.anlage(), MAERZ, ganzA1);
        assertThat(t2.rumpfmonate()).extracting(MispelRumpfmonate.Rumpfmonat::schluessel)
                .containsExactly("2027-03/1", "2027-03/15");
        assertThat(t2.aenderungen()).singleElement().satisfies(a -> {
            assertThat(a.anlass()).isEqualTo("messkonzept");
            assertThat(a.wirkung()).containsExactly("messkonzept");
        });
        assertThatThrownBy(() -> dienst.monatslaeufe(w.anlage(), MAERZ, ganzA1))
                .isInstanceOfSatisfying(MispelAbgrenzungAbgelehnt.class,
                        e -> assertThat(e.code()).isEqualTo("zaehler_fehlt"));
        assertThat(zeilen(w)).isEqualTo(1);
    }

    @Test
    void endgueltigNurAufWertenDesMessstellenbetreibers() {
        Welt w = welt("messstellenbetreiber");
        dienst.leserSetzen(new Leser());
        TenantContext.set(w.mandant());
        Vorgaben rumpf = new Vorgaben("A1", "viertelstunde", null, null, Set.of(), RUMPF, null);

        // Vor dem Monatsende bleibt auch ein Lauf auf MSB-Werten vorläufig.
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-03-25T08:00:00Z"), ZoneOffset.UTC));
        Lauf offen = dienst.monatslauf(w.anlage(), MAERZ, rumpf);
        assertThat(offen.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(offen.gruende()).containsExactly("zeitraum_offen");

        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-04-10T08:00:00Z"), ZoneOffset.UTC));
        Lauf fertig = dienst.monatslauf(w.anlage(), MAERZ, rumpf);
        assertThat(fertig.gruende()).isEmpty();
        assertThat(fertig.zeile().stand()).isEqualTo("endgueltig");
        assertThat(fertig.zeile().wertequelle()).isEqualTo("messstellenbetreiber");
        assertThat(fertig.zeile().fassung()).isEqualTo(2);

        // Die Datenbank hält E4 = C selbst: endgültig auf Gerätewerten scheitert am CHECK.
        assertThatThrownBy(() -> root.update("INSERT INTO mispel_abgrenzung_monat (tenant_id, site_id, monat, "
                + "zeitraum_von, zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme) VALUES (?, ?, "
                + "'2027-03-01', '2027-02-28T23:00Z', '2027-03-31T22:00Z', 1, 'A1', 'endgueltig', 'geraet', 1, 1, "
                + "'MP-8/1', '1.0', '{}', ?)", w.mandant(), w.anlage(), "0".repeat(64)))
                .hasMessageContaining("mispel_abgrenzung_monat_endgueltig_chk");
    }

    // ------------------------------------------------------------------ die Welt

    private static JsonNode vektorFall(String name) throws Exception {
        JsonNode doc = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                .readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS));
        for (JsonNode f : doc.get("faelle")) {
            if (f.get("name").asText().equals(name)) {
                return f;
            }
        }
        throw new IllegalStateException("Vektorfall fehlt: " + name);
    }

    /**
     * MP-32, Basisfall A4: Netzzähler MS-01/MS-02 (Z1), Zähler vor Stromspeicher und Ladepunkt MS-03/MS-04 (Z2), am
     * Stromspeicher allein MS-05/MS-06 (Z3), alle ab 01.01.2027; AW-Liste für Juni 2027.
     */
    private static Welt weltA4() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Monatslauf A4 #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle L', "
                + "'2026-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP32-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID ladepunkt = komponente(t, anlage, box, "charging", "charger_power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        String[][] zaehler = {{"MS-01", "Bezug", "Hauptzähler", "Z1", "1"}, {"MS-02", "Abgabe", "Hauptzähler", "Z1", "1"},
                {"MS-03", "Laden", "Speicher", "Z2", "2"}, {"MS-04", "Entladen", "Speicher", "Z2", "2"},
                {"MS-05", "Laden", "Speicher", "Z3", "3"}, {"MS-06", "Entladen", "Speicher", "Z3", "3"}};
        for (String[] z : zaehler) {
            UUID ms = messstelle(t, z[0], z[1]);
            stellung(t, anlage, ms, z[2], "2027-01-01");
            UUID komponente = z[3].equals("Z1") ? netz : z[3].equals("Z2") ? ladepunkt : speicher;
            quelle(t, box, ms, z[1], komponente, z[3].toLowerCase() + "." + z[1].toLowerCase() + "-energy");
            rolle(t, ms, z[3], "DE000123456789000000000000000000" + z[4], "messstellenbetreiber", "2027-01-01");
        }
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2027-05-31T22:00Z'::timestamptz, '2027-06-30T21:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        return new Welt(t, anlage);
    }

    private static JsonNode vektorMonat() throws Exception {
        JsonNode doc = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                .readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS));
        for (JsonNode f : doc.get("faelle")) {
            if (f.get("name").asText().equals("bnetza-beispielrechnungen-speichervorrang")) {
                return f.get("erwartet").get("monate").get("2027-03");
            }
        }
        throw new IllegalStateException("Vektorfall fehlt");
    }

    private static int zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM mispel_abgrenzung_monat WHERE tenant_id = ?", Integer.class,
                w.mandant());
    }

    /** Netzzähler MS-01/MS-02 (Z1 ab 01.01.2027), Speicher MS-03/MS-04 (Z2 ab 15.03.2027), AW-Liste für März. */
    private static Welt welt(String wertequelleSpeicher) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Monatslauf #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle R', "
                + "'2026-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP8-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        UUID ms1 = messstelle(t, "MS-01", "Bezug");
        UUID ms2 = messstelle(t, "MS-02", "Abgabe");
        UUID ms3 = messstelle(t, "MS-03", "Laden");
        UUID ms4 = messstelle(t, "MS-04", "Entladen");
        stellung(t, anlage, ms1, "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms2, "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms3, "Speicher", "2027-03-15");
        stellung(t, anlage, ms4, "Speicher", "2027-03-15");
        quelle(t, box, ms1, "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms2, "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms3, "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms4, "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms1, "Z1", "DE0001234567890000000000000000001", "messstellenbetreiber", "2027-01-01");
        rolle(t, ms2, "Z1", "DE0001234567890000000000000000001", "messstellenbetreiber", "2027-01-01");
        rolle(t, ms3, "Z2", "DE0001234567890000000000000000002", wertequelleSpeicher, "2027-03-15");
        rolle(t, ms4, "Z2", "DE0001234567890000000000000000002", wertequelleSpeicher, "2027-03-15");
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2027-02-28T23:00Z'::timestamptz, '2027-03-31T21:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        return new Welt(t, anlage);
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-12-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
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
