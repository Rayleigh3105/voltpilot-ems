package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelMonatslaufLaeufer.Ergebnis;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
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
import org.springframework.beans.factory.annotation.Qualifier;
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
 * MiSpeL MP-8b: der {@link MispelMonatslaufLaeufer} stößt den Monatslauf je Anlage selbst an — nach Ablauf des
 * Kalendermonats vorläufig, mit den Werten des Messstellenbetreibers endgültig (Anlage 1 S. 14, Abschn. 2.1.4; Tenor
 * S. 28), Formelsatz und AW-Regel aus der Fassung des Förderwegs, die im Monat gilt (MP-5/MP-17), Rumpfmonat nach
 * MP-21 (A1 S. 102–103). Die Mengen sind die des Rechenwerks (MP-8): ein Aufruf des Rechenwerks mit denselben
 * Fallständen hängt keine Fassung an (gleiche Prüfsumme), und (21) ist der Wert der Beispielrechnungen.
 *
 * <p>Gerätewerte liefert ein Ersatz-Leser (die Verdichtungskette ist AP-07/AP-08 und hier nicht Gegenstand); die
 * Werte des Messstellenbetreibers, Zählerrollen, Förderweg, AW-Liste, Speicherung und RLS laufen echt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class MispelMonatslaufLaeuferTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final YearMonth MAERZ = YearMonth.of(2027, 3);
    private static final YearMonth APRIL = YearMonth.of(2027, 4);
    private static final LocalDate RUMPF = LocalDate.of(2027, 3, 15);
    // 17 Tage ab dem 15.03., davon einer mit 23 Stunden (Sommerzeit-Beginn 28.03.2027).
    private static final int RUMPF_VIERTELSTUNDEN = 17 * 96 - 4;
    private static final Instant RUMPF_VON = Instant.parse("2027-03-14T23:00:00Z");
    private static final Instant APRIL_VON = Instant.parse("2027-03-31T22:00:00Z");
    private static final Instant MAI_VON = Instant.parse("2027-04-30T22:00:00Z");
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

    @Autowired
    MispelAbgrenzungRepository laeufe;

    @Autowired
    MispelMonatslaufRepository anlagen;

    @Autowired
    FoerderwegRepository wege;

    @Autowired
    MsbWerteRepository msb;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

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

    private record Welt(UUID mandant, UUID anlage, Map<String, UUID> messstellen) {}

    /** Gerätewerte je Viertelstunde: 0 kWh, außer den beiden der Beispielrechnungen (A1 S. 15–16). */
    private static final class Leser extends MispelZaehlerLeser {
        Leser(MsbWerteRepository msb) {
            super(null, msb);
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(wert(kennzeichen, t), true));
            }
            return out;
        }
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

    private MispelMonatslaufLaeufer laeufer(String heute) {
        Clock uhr = Clock.fixed(Instant.parse(heute), ZoneOffset.UTC);
        dienst.uhrStellen(uhr);
        dienst.leserSetzen(new Leser(msb));
        MispelMonatslaufLaeufer l = new MispelMonatslaufLaeufer(adminJdbc, anlagen, wege, dienst, laeufe);
        l.uhrStellen(uhr);
        return l;
    }

    @Test
    void monatsendeVorlaeufigMsbEndgueltigWechselZumMonatserstenUndRumpfmonat() throws Exception {
        Welt w = welt();
        // Erstmalige Zuordnung der Anlage mit dem neuen Speicher zur Abgrenzungsoption am 15.03. (A1 S. 103) — vorher
        // keine Bestimmung nach Anlage 1, also nur der Rumpfmonat ab dem 15. (A1 S. 102 „vor und/oder nach“).
        fassung(w, "marktpraemie_abgrenzung", "A1", "viertelstunde", "2027-03-15");
        // Die AW-Regel ab April berichtigt (eine neue Fassung zum Monatsersten), und zum 01.05. vorgemerkt der
        // Wechsel zurück in die Ausschließlichkeitsoption (§ 21b Abs. 1 S. 2 EEG, MP-17).
        fassung(w, "marktpraemie_abgrenzung", "A1", "stunden_1", "2027-04-01");
        fassung(w, "marktpraemie_ausschliesslichkeit", null, null, "2027-05-01");
        // Eine zweite Anlage in der Abgrenzungsoption ohne Zähler der Festlegung: das Rechenwerk lehnt ab — die erste
        // Anlage rechnet trotzdem.
        UUID ohneZaehler = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle Z', "
                + "'2026-12-01') RETURNING id", UUID.class, w.mandant());
        fassung(w.mandant(), ohneZaehler, "marktpraemie_abgrenzung", "A1", "viertelstunde", "2027-03-01");
        // Eine dritte in A5: Painst/Pbinst trägt der Förderweg nicht — übersprungen, nie geraten.
        UUID a5 = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle A5', "
                + "'2026-12-01') RETURNING id", UUID.class, w.mandant());
        fassung(w.mandant(), a5, "marktpraemie_abgrenzung", "A5", "viertelstunde", "2027-03-01");

        // Im März: kein Monat ist abgelaufen — nichts zu rechnen.
        Ergebnis vorher = laeufer("2027-03-31T12:00:00Z").lauf();
        assertThat(vorher.neu()).isZero();
        assertThat(zeilen(w)).isZero();

        // 1. Nach Monatsende: der Rumpfmonat ab dem 15.03. vorläufig auf Gerätewerten, Vorgaben aus dem März-Förderweg.
        Ergebnis april = laeufer("2027-04-01T03:17:00Z").lauf();
        assertThat(april.anlagen()).isEqualTo(3);
        assertThat(april.neu()).isEqualTo(1);
        assertThat(april.abgelehnt()).isEqualTo(1);
        assertThat(april.uebersprungen()).isEqualTo(1);
        assertThat(april.gescheitert()).isZero();
        Zeile maerz1 = letzte(w, RUMPF_VON);
        assertThat(maerz1.fassung()).isEqualTo(1);
        assertThat(maerz1.monat()).isEqualTo(MAERZ.atDay(1));
        assertThat(maerz1.formelsatz()).isEqualTo("A1");
        assertThat(maerz1.stand()).isEqualTo(MispelAbgrenzungService.VORLAEUFIG);
        assertThat(maerz1.wertequelle()).isEqualTo(MispelAbgrenzungService.GERAET);
        assertThat(maerz1.viertelstundenErwartet()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        assertThat(maerz1.viertelstundenGerechnet()).isEqualTo(RUMPF_VIERTELSTUNDEN);
        JsonNode n1 = json(maerz1.nachweis());
        assertThat(n1.path("schluessel").asText()).isEqualTo("2027-03/15");
        assertThat(n1.toString()).contains("\"viertelstunde\"").doesNotContain("stunden_1");
        assertThat(n1.path("monatswerte").path("2027-03/15").path("(21)").asText()).isEqualTo("50");
        // Mengen = Rechenwerk: die Monatswerte sind die der Beispielrechnungen, und derselbe Monat direkt über das
        // Rechenwerk (MP-8/MP-21) mit den Fallständen aus dem Förderweg hängt keine Fassung an — gleiche Prüfsumme.
        JsonNode soll = vektorMonat();
        n1.path("monatswerte").path("2027-03/15").fields().forEachRemaining(e -> {
            JsonNode s = soll.get(e.getKey());
            assertThat(s).as(e.getKey()).isNotNull();
            assertThat(e.getValue().isNull()).as(e.getKey()).isEqualTo(s.isNull());
            if (!s.isNull()) {
                assertThat(Bruch.von(s.decimalValue()).compareTo(bruch(e.getValue().asText()))).as(e.getKey()).isZero();
            }
        });
        TenantContext.set(w.mandant());
        List<Lauf> direkt = dienst.monatslaeufe(w.anlage(), MAERZ,
                MispelMonatslaufLaeufer.fallstaende(wege.derAnlage(w.anlage())));
        TenantContext.clear();
        assertThat(direkt).singleElement().satisfies(l -> {
            assertThat(l.neu()).isFalse();
            assertThat(l.zeile().pruefsumme()).isEqualTo(maerz1.pruefsumme());
        });
        assertThat(zeilen(w)).isEqualTo(1);

        // 2. Idempotent: derselbe Takt noch einmal hängt nichts an.
        Ergebnis wieder = laeufer("2027-04-01T04:17:00Z").lauf();
        assertThat(wieder.neu()).isZero();
        assertThat(wieder.unveraendert()).isEqualTo(1);
        assertThat(zeilen(w)).isEqualTo(1);

        // 3. Die Werte des Messstellenbetreibers kommen (MP-15): der Monat wird endgültig, die Mengen bleiben.
        msbWerte(w, RUMPF_VON, APRIL_VON, Instant.parse("2027-04-11T09:00:00Z"));
        Ergebnis msbDa = laeufer("2027-04-12T03:17:00Z").lauf();
        assertThat(msbDa.neu()).isEqualTo(1);
        Zeile maerz2 = letzte(w, RUMPF_VON);
        assertThat(maerz2.fassung()).isEqualTo(2);
        assertThat(maerz2.stand()).isEqualTo(MispelAbgrenzungService.ENDGUELTIG);
        assertThat(maerz2.wertequelle()).isEqualTo(MispelAbgrenzungService.MSB);
        assertThat(json(maerz2.nachweis()).path("monatswerte").path("2027-03/15"))
                .isEqualTo(n1.path("monatswerte").path("2027-03/15"));
        // Endgültig und nichts Neues: der Monat ist nicht mehr fällig.
        Ergebnis ruhig = laeufer("2027-04-13T03:17:00Z").lauf();
        assertThat(ruhig.endgueltig()).isEqualTo(1);
        assertThat(ruhig.neu() + ruhig.unveraendert()).isZero();
        assertThat(zeilen(w)).isEqualTo(2);

        // 4. Nach dem April: der ganze Monat mit der AW-Regel der April-Fassung, vorläufig (keine MSB-Werte); der März
        // bleibt endgültig.
        aw("stunden_1", APRIL_VON, MAI_VON);
        Ergebnis mai = laeufer("2027-05-01T03:17:00Z").lauf();
        assertThat(mai.neu()).isEqualTo(1);
        assertThat(mai.endgueltig()).isEqualTo(1);
        Zeile april1 = letzte(w, APRIL_VON);
        assertThat(april1.monat()).isEqualTo(APRIL.atDay(1));
        assertThat(april1.stand()).isEqualTo(MispelAbgrenzungService.VORLAEUFIG);
        JsonNode n2 = json(april1.nachweis());
        assertThat(n2.path("schluessel").asText()).isEqualTo("2027-04");
        assertThat(n2.toString()).contains("stunden_1");
        assertThat(april1.viertelstundenGerechnet()).isEqualTo(30 * 96);

        // 5. Der zum 01.05. vorgemerkte Wechsel in die Ausschließlichkeitsoption: der Mai ist keine Bestimmung nach
        // Anlage 1 — nach seinem Ende kein Lauf.
        Ergebnis juni = laeufer("2027-06-01T03:17:00Z").lauf();
        assertThat(juni.neu()).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM mispel_abgrenzung_monat WHERE site_id = ? AND monat = ?",
                Integer.class, w.anlage(), LocalDate.of(2027, 5, 1))).isZero();
        assertThat(zeilen(w)).isEqualTo(3);

        // 6. Neue Werte des Messstellenbetreibers nach dem endgültigen Lauf: der März rechnet neu — gleiche Werte, gleiche
        // Prüfsumme, keine neue Fassung.
        msbWerte(w, RUMPF_VON, APRIL_VON, Instant.parse("2027-06-01T09:00:00Z"));
        Ergebnis korrektur = laeufer("2027-06-02T03:17:00Z").lauf();
        assertThat(korrektur.endgueltig()).isZero();
        assertThat(letzte(w, RUMPF_VON).fassung()).isEqualTo(2);

        // Die zweite Anlage hat keinen Lauf; ein fremder Mandant sieht keinen.
        assertThat(root.queryForObject("SELECT count(*) FROM mispel_abgrenzung_monat WHERE site_id = ?",
                Integer.class, ohneZaehler)).isZero();
        TenantContext.set(welt().mandant());
        assertThat(dienst.laeufe(w.anlage(), MAERZ)).isEmpty();
    }

    @Test
    void monateBisZurMitteilungsfristDesVorjahres() {
        // Ab der Festlegung (Oktober 2026), nur abgelaufene Monate.
        assertThat(MispelMonatslaufLaeufer.monate(LocalDate.of(2026, 10, 2))).isEmpty();
        assertThat(MispelMonatslaufLaeufer.monate(LocalDate.of(2027, 1, 1)))
                .containsExactly(YearMonth.of(2026, 10), YearMonth.of(2026, 11), YearMonth.of(2026, 12));
        // Bis 31.05. bleibt das Vorjahr offen (§ 21 Abs. 7 EnFG), ab 01.06. nur das laufende Jahr.
        assertThat(MispelMonatslaufLaeufer.monate(LocalDate.of(2028, 5, 31))).first().isEqualTo(YearMonth.of(2027, 1));
        assertThat(MispelMonatslaufLaeufer.monate(LocalDate.of(2028, 5, 31))).last().isEqualTo(YearMonth.of(2028, 4));
        assertThat(MispelMonatslaufLaeufer.monate(LocalDate.of(2028, 6, 1)))
                .containsExactly(YearMonth.of(2028, 1), YearMonth.of(2028, 2), YearMonth.of(2028, 3),
                        YearMonth.of(2028, 4), YearMonth.of(2028, 5));
    }

    // ---------------------------------------------------------------------------------------------

    private Zeile letzte(Welt w, Instant von) {
        TenantContext.set(w.mandant());
        try {
            return laeufe.letzte(w.anlage(), von).orElseThrow();
        } finally {
            TenantContext.clear();
        }
    }

    private static int zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM mispel_abgrenzung_monat WHERE site_id = ?", Integer.class,
                w.anlage());
    }

    private static JsonNode json(String text) throws Exception {
        return new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).readTree(text);
    }

    private static Bruch bruch(String text) {
        int i = text.indexOf('/');
        return i < 0 ? Bruch.von(new BigDecimal(text))
                : Bruch.von(new BigDecimal(text.substring(0, i))).durch(Bruch.von(new BigDecimal(text.substring(i + 1))));
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

    /** Die Werte des Messstellenbetreibers über {@code [von, bis)} — dieselben Mengen wie am Gerät, je Zählpunkt. */
    private void msbWerte(Welt w, Instant von, Instant bis, Instant importiertAm) {
        TenantContext.set(w.mandant());
        try {
            for (String[] z : List.of(new String[] {"Z1", "MS-01", "MS-02"}, new String[] {"Z2", "MS-03", "MS-04"})) {
                String zp = z[0].equals("Z1") ? ZP1 : ZP2;
                List<MsbWerteCsv.Wert> werte = new ArrayList<>();
                for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                    werte.add(new MsbWerteCsv.Wert(zp, MsbWerteCsv.richtungDerMessstelle(z[1].equals("MS-01") ? "Bezug"
                            : "Laden"), t, wert(z[1], t)));
                    werte.add(new MsbWerteCsv.Wert(zp, MsbWerteCsv.richtungDerMessstelle(z[2].equals("MS-02") ? "Abgabe"
                            : "Entladen"), t, wert(z[2], t)));
                }
                UUID id = msb.anlegen(w.mandant(), w.messstellen().get(z[1]), z[0] + ".csv",
                        UUID.randomUUID().toString().replace("-", "") + "00000000000000000000000000000000",
                        werte, "test").id();
                // Der Import an der Uhr des Tests (die Spalte setzt sonst now() der Datenbank).
                root.update("UPDATE mispel_msb_import SET importiert_am = ? WHERE id = ?",
                        java.sql.Timestamp.from(importiertAm), id);
            }
        } finally {
            TenantContext.clear();
        }
    }

    private static void aw(String regel, Instant von, Instant bis) {
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT ?, g, 'PT15M', true "
                + "FROM generate_series(?::timestamptz, ?::timestamptz - INTERVAL '15 minutes', INTERVAL '15 minutes') g "
                + "ON CONFLICT DO NOTHING", regel, java.sql.Timestamp.from(von), java.sql.Timestamp.from(bis));
    }

    private static void fassung(Welt w, String weg, String formelsatz, String awRegel, String ab) {
        fassung(w.mandant(), w.anlage(), weg, formelsatz, awRegel, ab);
    }

    private static void fassung(UUID t, UUID anlage, String weg, String formelsatz, String awRegel, String ab) {
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
                + "gueltig_ab, created_by) VALUES (?, ?, ?, ?, TRUE, ?, ?::date, 'test')", t, anlage, weg, formelsatz,
                awRegel, ab);
    }

    private static final String ZP1 = "DE0001234567890000000000000000001";
    private static final String ZP2 = "DE0001234567890000000000000000002";

    /** Netzzähler MS-01/MS-02 (Z1 ab 01.01.2027), Speicher MS-03/MS-04 (Z2 ab 15.03.2027), AW-Liste für März. */
    private static Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Monatslauf-Läufer #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle R', "
                + "'2026-12-01') RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP8B-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(t, "MS-01", "Bezug"));
        ms.put("MS-02", messstelle(t, "MS-02", "Abgabe"));
        ms.put("MS-03", messstelle(t, "MS-03", "Laden"));
        ms.put("MS-04", messstelle(t, "MS-04", "Entladen"));
        stellung(t, anlage, ms.get("MS-01"), "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms.get("MS-02"), "Hauptzähler", "2027-01-01");
        stellung(t, anlage, ms.get("MS-03"), "Speicher", "2027-03-15");
        stellung(t, anlage, ms.get("MS-04"), "Speicher", "2027-03-15");
        quelle(t, box, ms.get("MS-01"), "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms.get("MS-02"), "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms.get("MS-03"), "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms.get("MS-04"), "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms.get("MS-01"), "Z1", ZP1, "2027-01-01");
        rolle(t, ms.get("MS-02"), "Z1", ZP1, "2027-01-01");
        rolle(t, ms.get("MS-03"), "Z2", ZP2, "2027-03-15");
        rolle(t, ms.get("MS-04"), "Z2", ZP2, "2027-03-15");
        aw("viertelstunde", Instant.parse("2027-02-28T23:00:00Z"), APRIL_VON);
        return new Welt(t, anlage, ms);
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

    private static void rolle(UUID t, UUID ms, String rolle, String zp, String ab) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Netze Musterstadt GmbH', 'eichrechtskonform', '2034-12-31', 'messstellenbetreiber', ?::date)", t, ms,
                rolle, zp, ab);
    }
}
