package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.mispel.FoerderwegRepository.Fassung;
import com.voltpilot.api.mispel.MispelPauschalService.Vorgaben;
import com.voltpilot.api.mispel.PauschalVormerkungService.Angaben;
import com.voltpilot.api.mispel.PauschalVormerkungService.Ergebnis;
import com.voltpilot.api.mispel.PauschalVormerkungService.Umsetzung;
import com.voltpilot.api.tenant.TenantContext;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
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
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-27b gegen die Datenbank: der {@link PauschalVormerkungLaeufer} macht aus der Pauschal-Vormerkung „Termin
 * offen“ eine Fassung des Förderwegs, sobald der Tag in {@code voltpilot.mispel.pauschaloption-ab} steht (Vertrag
 * Förderweg § 5a „Umsetzen“; Tenor S. 3 Ziff. 9b).
 *
 * <p><b>Prüfnachweis:</b> ohne Tag nichts; mit Tag eine Fassung „Marktprämie mit Pauschaloption“ zum ersten
 * Monatsersten nach heute und nicht vor dem Tag — nie rückwirkend —, deren erstes Jahr ein Rumpfjahr ist (A2 S. 52–55,
 * Abschn. 9; der Jahreslauf nimmt es an, das Kalenderjahr nicht); die Vormerkung behält ihre Bestätigungen mit Datum
 * und nennt die Fassung; ein zweiter Lauf ändert nichts; bis 30.09.2027 wartet sie ohne Einverständnis (Tenor S. 3
 * Ziff. 9a); eine Anlage, die scheitert, hält die anderen nicht auf und zählt am Melder.
 *
 * <p>Die Dienste werden je Fall mit eigenem Tag und eigener Uhr gebaut (wie {@code FoerderwegApiTest} den
 * Spiegel-Läufer): der Tag ist eine Startvorgabe, und ein Kontext je Tag wäre teuer.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class PauschalVormerkungLaeuferTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final String DV = "Nordstrom Direkt";

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
    JdbcTemplate jdbc;
    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;
    @Autowired
    FoerderwegRepository fassungen;
    @Autowired
    TransactionTemplate transaktion;
    @Autowired
    MispelPauschalService pauschal;

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

    private record Anlage(UUID mandant, UUID id) {}

    /** Förderweg, Vormerkung und Läufer mit dem Tag {@code tag} ("" = keiner) und der Uhr am Tag {@code heute}. */
    private record Dienste(FoerderwegService wege, PauschalVormerkungService vormerkungen,
            PauschalVormerkungLaeufer laeufer, SimpleMeterRegistry meters) {

        double fehler() {
            return meters.find(UemsLaeuferMelder.FEHLER).tag("laeufer", UemsLaeuferMelder.MISPEL_PAUSCHAL_VORMERKUNG)
                    .counter().count();
        }
    }

    // ------------------------------------------------------------------ ohne Tag nichts

    @Test
    void ohneTagUndMitEinemTagHinterDemNaechstenMonatserstenTutDerLaeuferNichts() {
        Anlage a = anlage("9.2");
        vormerken(a, "2027-12-15", "0.8");

        Dienste ohneTag = dienste("", "2028-02-10");
        assertThat(ohneTag.laeufer().lauf()).isZero();
        assertThat(ohneTag.vormerkungen().ziel()).isNull();
        assertThat(alsMandant(a, () -> ohneTag.vormerkungen().umsetzen(a.id())).umsetzung())
                .isEqualTo(Umsetzung.WARTET_TERMIN);

        // Der Tag steht (01.03.2028), aber am 10.01. ist erst der 01.02. vormerkbar (Vertrag § 5): noch nicht.
        Dienste zuFrueh = dienste("2028-03-01", "2028-01-10");
        assertThat(zuFrueh.vormerkungen().ziel()).isNull();
        assertThat(zuFrueh.laeufer().lauf()).isZero();

        assertThat(fassungenDer(a)).isEmpty();
        assertThat(stehend(a)).isEqualTo(1);
        assertThat(ohneTag.fehler() + zuFrueh.fehler()).isZero();
    }

    // ------------------------------------------------------------------ mit Tag: Fassung, Rumpfjahr, Idempotenz

    @Test
    void mitTagWirdDieVormerkungZumMonatserstenEineFassungMitRumpfjahrUndEinZweiterLaufAendertNichts() {
        Anlage a = anlage("9.2");
        vormerken(a, "2027-12-15", "0.8");
        Map<String, Object> vorher = vormerkungsZeile(a);

        Dienste d = dienste("2028-03-01", "2028-02-10");
        assertThat(d.vormerkungen().ziel()).isEqualTo(LocalDate.of(2028, 3, 1));
        assertThat(d.laeufer().lauf()).isGreaterThanOrEqualTo(1);

        List<Fassung> fs = fassungenDer(a);
        assertThat(fs).hasSize(1);
        Fassung f = fs.get(0);
        assertThat(f.angaben().foerderweg()).isEqualTo(FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_PAUSCHAL);
        assertThat(f.gueltigAb()).isEqualTo(LocalDate.of(2028, 3, 1));
        assertThat(f.angaben().formelsatz()).isNull();
        assertThat(f.angaben().einverstaendnis()).isFalse();
        assertThat(f.angaben().direktvermarkter()).isEqualTo(DV);
        assertThat(f.angaben().bilanzkreisGesondert()).isTrue();
        assertThat(root.queryForObject("SELECT created_by FROM site_foerderweg WHERE id = ?", String.class, f.id()))
                .isEqualTo(PauschalVormerkungService.LAEUFER);

        // Die Vormerkung bleibt mit ihren Bestätigungen samt Datum stehen, aufgehoben, und nennt die Fassung.
        Map<String, Object> nachher = vormerkungsZeile(a);
        assertThat(stehend(a)).isZero();
        assertThat(nachher.get("umgesetzt_in")).isEqualTo(f.id());
        assertThat(nachher.get("aufgehoben_am")).isNotNull();
        assertThat(nachher.get("ein_betreiber_bestaetigt_am")).isNotNull()
                .isEqualTo(vorher.get("ein_betreiber_bestaetigt_am"));
        assertThat(nachher.get("steckersolar_dv_bestaetigt_am")).isNotNull()
                .isEqualTo(vorher.get("steckersolar_dv_bestaetigt_am"));
        assertThat((BigDecimal) nachher.get("steckersolar_kwp")).isEqualByComparingTo("0.8");

        // Bis zum Tag ist sie eine datierte Vormerkung (§ 5): die Ansicht von heute zeigt sie, der Förderweg bleibt.
        FoerderwegService.Ansicht heute = alsMandant(a, () -> d.wege().ansicht(a.id(), null));
        assertThat(heute.vormerkung().id()).isEqualTo(f.id());
        assertThat(heute.fassung()).isNull();

        // Rumpfjahr (A2 S. 52–55): 01.03.–31.12.2028 — 306 Tage (P22)R, davon 183 in der Sommerperiode (P19)R;
        // 2028 ist ein Schaltjahr, (P20) = 366. Der Jahreslauf nimmt genau dieses Rumpfjahr an, das Kalenderjahr nicht.
        Ergebnis e = new Ergebnis(Umsetzung.UMGESETZT, f.gueltigAb(), f.id());
        assertThat(e.rumpfjahr()).isTrue();
        assertThat(e.rumpfjahrBis()).isEqualTo(LocalDate.of(2028, 12, 31));
        assertThat(ChronoUnit.DAYS.between(e.gueltigAb(), e.rumpfjahrBis()) + 1).isEqualTo(306);
        assertThat(MispelPauschalRechenwerk.sommertage(e.gueltigAb(), e.rumpfjahrBis())).isEqualTo(183);
        Map<String, BigDecimal> stammdaten = Map.of("Pinst", new BigDecimal("10"), "SKinst", new BigDecimal("10"));
        MispelPauschalAbgelehnt ganzesJahr = catchThrowableOfType(() -> alsMandant(a, () -> pauschal.jahreslauf(a.id(),
                2028, Vorgaben.von("P1", stammdaten))), MispelPauschalAbgelehnt.class);
        assertThat(ganzesJahr.code()).isEqualTo("foerderweg_nicht_pauschal");
        MispelPauschalAbgelehnt rumpfjahr = catchThrowableOfType(() -> alsMandant(a, () -> pauschal.jahreslauf(a.id(),
                2028, new Vorgaben("P1", stammdaten, Set.of(), null, e.gueltigAb(), e.rumpfjahrBis(), null))),
                MispelPauschalAbgelehnt.class);
        assertThat(rumpfjahr.code()).as("der Förderweg trägt jeden Tag des Rumpfjahres; es fehlt nur der Zähler Z1")
                .isEqualTo("zaehler_fehlt");

        // Idempotenz: ein zweiter Lauf ändert nichts.
        d.laeufer().lauf();
        assertThat(fassungenDer(a)).hasSize(1);
        assertThat(root.queryForObject("SELECT count(*) FROM site_pauschal_vormerkung WHERE site_id = ?", Integer.class,
                a.id())).isEqualTo(1);
        assertThat(alsMandant(a, () -> d.vormerkungen().umsetzen(a.id())).umsetzung()).isEqualTo(Umsetzung.KEINE);
        assertThat(d.fehler()).isZero();
    }

    @Test
    void spaetEingetragenerTagGiltAbDemNaechstenMonatserstenNieRueckwirkend() {
        Anlage a = anlage("6");
        vormerken(a, "2027-12-15", "0");

        Dienste d = dienste("2028-03-01", "2028-03-05");
        assertThat(d.vormerkungen().ziel()).isEqualTo(LocalDate.of(2028, 4, 1));
        d.laeufer().lauf();

        List<Fassung> fs = fassungenDer(a);
        assertThat(fs).hasSize(1);
        assertThat(fs.get(0).gueltigAb()).isEqualTo(LocalDate.of(2028, 4, 1));
        // Ohne Steckersolargerät gab es keine zweite Bestätigung — und es kommt keine dazu.
        assertThat(vormerkungsZeile(a).get("steckersolar_dv_bestaetigt_am")).isNull();
        assertThat(d.fehler()).isZero();
    }

    // ------------------------------------------------------------------ Übergangszeit

    @Test
    void inDerUebergangszeitWartetDieVormerkungAufDasEinverstaendnisUndWirdZum1Oktober2027EineFassung() {
        Anlage a = anlage("9.2");
        vormerken(a, "2026-12-15", "0");

        // Tag 01.03.2027: in der Übergangszeit nur mit Einverständnis (Tenor S. 3 Ziff. 9a) — die Vormerkung trägt es nicht.
        Dienste maerz = dienste("2027-03-01", "2027-02-10");
        assertThat(alsMandant(a, () -> maerz.vormerkungen().umsetzen(a.id())))
                .isEqualTo(new Ergebnis(Umsetzung.WARTET_EINVERSTAENDNIS, LocalDate.of(2027, 3, 1), null));
        maerz.laeufer().lauf();
        assertThat(fassungenDer(a)).isEmpty();
        assertThat(stehend(a)).isEqualTo(1);
        assertThat(maerz.fehler()).as("Warten ist kein Fehler").isZero();

        // Am 15.09.2027 ist der 01.10.2027 vormerkbar — der erste Monatserste nach der Übergangszeit.
        Dienste september = dienste("2027-03-01", "2027-09-15");
        september.laeufer().lauf();
        List<Fassung> fs = fassungenDer(a);
        assertThat(fs).hasSize(1);
        assertThat(fs.get(0).gueltigAb()).isEqualTo(LocalDate.of(2027, 10, 1));
        assertThat(fs.get(0).angaben().einverstaendnis()).isFalse();
        // Rumpfjahr 01.10.–31.12.2027: 92 Tage, keiner in der Sommerperiode — (P1)R = 0 (A2 S. 54).
        assertThat(MispelPauschalRechenwerk.sommertage(LocalDate.of(2027, 10, 1), LocalDate.of(2027, 12, 31))).isZero();
        assertThat(september.fehler()).isZero();
    }

    // ------------------------------------------------------------------ Fehler je Anlage

    @Test
    void eineAnlageDieScheitertHaeltDieAnderenNichtAufUndZaehltAmMelder() {
        Anlage gut = anlage("9.2");
        Anlage gross = anlage("9.2");
        Anlage andererWunsch = anlage("9.2");
        Anlage schonPauschal = anlage("9.2");
        for (Anlage a : List.of(gut, gross, andererWunsch, schonPauschal)) {
            vormerken(a, "2027-12-15", "0");
        }
        // Nach der Vormerkung: Aufbau über 30 kWp (Voraussetzung 3, A2 S. 19) …
        root.update("UPDATE asset SET pv_capacity_kwp = 31.5 WHERE site_id = ? AND type = 'pv'", gross.id());
        Dienste d = dienste("2028-03-01", "2028-02-10");
        // … ein anderer Förderweg zum selben Monatsersten vorgemerkt (Vertrag § 5) …
        alsMandant(andererWunsch, () -> {
            d.wege().setzen(andererWunsch.id(), new FoerderwegService.Aendern("marktpraemie_ausschliesslichkeit", null,
                    null, LocalDate.of(2028, 3, 1), null, null, null, null, null, null), "kunde");
            return null;
        });
        // … und einer, der die Pauschaloption nach der Genehmigung schon selbst eingetragen hat.
        UUID eigene = alsMandant(schonPauschal, () -> {
            d.wege().setzen(schonPauschal.id(), new FoerderwegService.Aendern("marktpraemie_pauschal", null, null,
                    LocalDate.of(2028, 3, 1), null, null, null, null, DV, null), "kunde");
            return fassungen.derAnlage(schonPauschal.id()).get(0).id();
        });

        d.laeufer().lauf();

        assertThat(fassungenDer(gut)).singleElement().extracting(Fassung::gueltigAb)
                .isEqualTo(LocalDate.of(2028, 3, 1));
        assertThat(fassungenDer(gross)).isEmpty();
        assertThat(stehend(gross)).isEqualTo(1);
        assertThat(fassungenDer(andererWunsch)).singleElement().extracting(f -> f.angaben().foerderweg())
                .isEqualTo(FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT);
        assertThat(stehend(andererWunsch)).isEqualTo(1);
        assertThat(fassungenDer(schonPauschal)).singleElement().extracting(Fassung::id).isEqualTo(eigene);
        assertThat(vormerkungsZeile(schonPauschal).get("umgesetzt_in")).isEqualTo(eigene);
        assertThat(d.fehler()).as("je gescheiterte Anlage ein Fehler am Melder").isEqualTo(2.0);

        FoerderwegAbgelehnt grenze = catchThrowableOfType(() -> alsMandant(gross,
                () -> d.vormerkungen().umsetzen(gross.id())), FoerderwegAbgelehnt.class);
        assertThat(grenze.code()).isEqualTo("ueber_30_kwp");
        FoerderwegAbgelehnt zweiWuensche = catchThrowableOfType(() -> alsMandant(andererWunsch,
                () -> d.vormerkungen().umsetzen(andererWunsch.id())), FoerderwegAbgelehnt.class);
        assertThat(zweiWuensche.code()).isEqualTo("vormerkung_besteht");

        // Aufräumen: die beiden stehenden Vormerkungen würden sonst in den Läufen der anderen Fälle mitzählen.
        root.update("UPDATE site_pauschal_vormerkung SET aufgehoben_am = now() WHERE site_id IN (?, ?) "
                + "AND aufgehoben_am IS NULL", gross.id(), andererWunsch.id());
    }

    // ------------------------------------------------------------------ Hilfen

    private Dienste dienste(String tag, String heute) {
        FoerderwegService wege = new FoerderwegService(fassungen, transaktion, tag);
        wege.uhrStellen(Clock.fixed(LocalDate.parse(heute).atTime(12, 0).atZone(ZoneId.of("Europe/Berlin"))
                .toInstant(), ZoneOffset.UTC));
        PauschalVormerkungService vormerkungen = new PauschalVormerkungService(jdbc, fassungen, wege, transaktion, tag);
        PauschalVormerkungLaeufer laeufer = new PauschalVormerkungLaeufer(adminJdbc, vormerkungen);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        laeufer.melder(new UemsLaeuferMelder(meters));
        return new Dienste(wege, vormerkungen, laeufer, meters);
    }

    /** Merkt die Pauschaloption mit offenem Termin vor (MP-27), wie es die Route am Tag {@code heute} täte. */
    private void vormerken(Anlage a, String heute, String steckersolarKwp) {
        Dienste ohneTag = dienste("", heute);
        BigDecimal stecker = new BigDecimal(steckersolarKwp);
        alsMandant(a, () -> {
            ohneTag.vormerkungen().vormerken(a.id(), new Angaben(true, stecker, stecker.signum() > 0 ? true : null,
                    DV, true), "kunde@haus-kroeger.test");
            return null;
        });
    }

    private Anlage anlage(String pvKwp) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Vormerkung #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt) "
                + "VALUES (?, ?, 'eigenverbrauch', false) RETURNING id", UUID.class, t, "Haus Kröger " + nr);
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (?, ?, 'pv', ?)", t, s,
                new BigDecimal(pvKwp));
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh) VALUES (?, ?, 'battery', 10)", t, s);
        return new Anlage(t, s);
    }

    private static <T> T alsMandant(Anlage a, Supplier<T> was) {
        TenantContext.set(a.mandant());
        try {
            return was.get();
        } finally {
            TenantContext.clear();
        }
    }

    private List<Fassung> fassungenDer(Anlage a) {
        return alsMandant(a, () -> fassungen.derAnlage(a.id()).stream().filter(f -> !f.aufgehoben()).toList());
    }

    private static int stehend(Anlage a) {
        return root.queryForObject("SELECT count(*) FROM site_pauschal_vormerkung WHERE site_id = ? "
                + "AND aufgehoben_am IS NULL", Integer.class, a.id());
    }

    /** Die jüngste Zeile der Vormerkung (stehend oder umgesetzt). */
    private static Map<String, Object> vormerkungsZeile(Anlage a) {
        Map<String, Object> z = root.queryForMap("SELECT * FROM site_pauschal_vormerkung WHERE site_id = ? "
                + "ORDER BY created_at DESC LIMIT 1", a.id());
        z.replaceAll((k, v) -> v instanceof Timestamp t ? t.toInstant() : v);
        return z;
    }
}
