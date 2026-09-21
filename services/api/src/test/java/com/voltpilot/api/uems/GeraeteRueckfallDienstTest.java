package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Herkunft;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Rueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
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
 * Der am Gerät hinterlegte Rückfall je Komponente (UEMS AP-15 IP-6, {@code V20260921150000}) gegen die echte
 * Datenbank: wer/wann, eine neue Angabe hebt die alte auf, dieselbe schreibt nichts; die Lese-Funktion nimmt den
 * hinterlegten Wert vor dem Katalog und ohne beides die Nennleistung (Bestand: eine Komponente ohne Angabe verhält
 * sich wie heute — niemand liest sie außer dieser Regel); RLS + {@code FORCE}, enge Rechte, Offboarding. Keine Route
 * (Folgepunkt IP-5/IP-24).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class GeraeteRueckfallDienstTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

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
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
    }

    @Autowired
    GeraeteRueckfallDienst dienst;

    @Autowired
    JdbcTemplate app;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID saeule, UUID wechselrichter, UUID ohneFamilie) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void ohneMandant() {
        TenantContext.clear();
    }

    @Test
    void hinterlegenMitWerUndWannEineNeueHebtDieAlteAufDieselbeSchreibtNichts() {
        Welt w = welt();
        TenantContext.set(w.mandant());
        Angabe vorgabe = new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal("4.1"), 60);
        GeraeteRueckfallRepository.Zeile erste = dienst.hinterlegen(w.saeule(), Grenzart.BEZUG, vorgabe,
                "gespeicherter Vorgabewert 6 A dreiphasig", "installateur@ahrenberg.test");
        assertThat(erste.eingetragenVon()).isEqualTo("installateur@ahrenberg.test");
        assertThat(erste.eingetragenAm()).isNotNull();
        assertThat(erste.aufgehobenAm()).isNull();
        assertThat(erste.rueckfallKw()).isEqualByComparingTo("4.1");

        GeraeteRueckfallRepository.Zeile nochmal = dienst.hinterlegen(w.saeule(), Grenzart.BEZUG,
                new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal("4.100"), 60),
                "gespeicherter Vorgabewert 6 A dreiphasig", "jemand@anders.test");
        assertThat(nochmal.id()).as("dieselbe Angabe schreibt nichts").isEqualTo(erste.id());
        assertThat(zeilen(w)).isEqualTo(1);

        dienst.hinterlegen(w.saeule(), Grenzart.BEZUG, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT,
                new BigDecimal("3.5"), 60), null, "betreiber@voltpilot.test");
        assertThat(zeilen(w)).isEqualTo(2);
        List<GeraeteRueckfallRepository.Zeile> verlauf = dienst.verlauf(w.saeule());
        assertThat(verlauf).hasSize(2);
        assertThat(verlauf.get(0).rueckfallKw()).isEqualByComparingTo("3.5");
        assertThat(verlauf.get(0).aufgehobenAm()).isNull();
        assertThat(verlauf.get(1).aufgehobenAm()).as("die alte ist aufgehoben, nicht überschrieben").isNotNull();
        assertThat(verlauf.get(1).rueckfallKw()).isEqualByComparingTo("4.1");

        Rueckfall r = dienst.rueckfall(w.saeule(), Grenzart.BEZUG, new BigDecimal("22"));
        assertThat(r.kw()).isEqualByComparingTo("3.5");
        assertThat(r.herkunft()).isEqualTo(Herkunft.AM_GERAET);
        assertThat(r.nachS()).isEqualTo(60);
    }

    @Test
    void nachEinemGeraeteTauschGiltDerAlteWertNichtMehr() {
        Welt w = welt();
        UUID alt = einbau(w, "WR-1", Instant.parse("2026-01-01T00:00:00Z"));
        TenantContext.set(w.mandant());
        GeraeteRueckfallRepository.Zeile z = dienst.hinterlegen(w.wechselrichter(), Grenzart.EINSPEISUNG,
                new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal("40"), 60), null, "installateur@a.test");
        assertThat(z.geraet()).isEqualTo(alt);
        assertThat(dienst.rueckfall(w.wechselrichter(), Grenzart.EINSPEISUNG, new BigDecimal("100")).kw())
                .isEqualByComparingTo("40");

        // Tausch: der alte Einbau endet, ein neuer speist dieselbe Komponente
        Instant tausch = Instant.now().minusSeconds(60);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", Timestamp.from(tausch), alt);
        UUID neu = einbau(w, "WR-2", tausch);
        Rueckfall danach = dienst.rueckfall(w.wechselrichter(), Grenzart.EINSPEISUNG, new BigDecimal("100"));
        assertThat(danach.kw()).as("der Wert steckt im alten Gerät").isEqualByComparingTo("100");
        assertThat(danach.herkunft()).isEqualTo(Herkunft.KATALOG);

        // dieselbe Angabe am neuen Gerät ist eine NEUE Angabe
        GeraeteRueckfallRepository.Zeile amNeuen = dienst.hinterlegen(w.wechselrichter(), Grenzart.EINSPEISUNG,
                new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal("40"), 60), null, "installateur@a.test");
        assertThat(amNeuen.geraet()).isEqualTo(neu);
        assertThat(amNeuen.id()).isNotEqualTo(z.id());
        assertThat(dienst.rueckfall(w.wechselrichter(), Grenzart.EINSPEISUNG, new BigDecimal("100")).kw())
                .isEqualByComparingTo("40");
        assertThat(zeilen(w)).isEqualTo(2);
    }

    @Test
    void bestandOhneAngabeZaehltMitNennleistungUndSchreibtNichts() {
        Welt w = welt();
        TenantContext.set(w.mandant());
        // Katalog: OCPP ist steuerbar, sagt aber `unbekannt` → Nennleistung
        Rueckfall saeule = dienst.rueckfall(w.saeule(), Grenzart.BEZUG, new BigDecimal("22"));
        assertThat(saeule.rueckfall()).isEqualTo(GeraeteRueckfall.UNBEKANNT);
        assertThat(saeule.herkunft()).isEqualTo(Herkunft.KATALOG);
        assertThat(saeule.kw()).isEqualByComparingTo("22");
        // SunSpec: jedes Modell spannt die Familie auf, alle sagen `unbekannt`
        Rueckfall pv = dienst.rueckfall(w.wechselrichter(), Grenzart.EINSPEISUNG, new BigDecimal("60"));
        assertThat(pv.herkunft()).isEqualTo(Herkunft.KATALOG);
        assertThat(pv.kw()).isEqualByComparingTo("60");
        // ohne Familie und ohne Katalog-Eintrag der Richtung: keine Angabe, unbekannt
        Rueckfall ohne = dienst.rueckfall(w.ohneFamilie(), Grenzart.EINSPEISUNG, new BigDecimal("15"));
        assertThat(ohne.herkunft()).isEqualTo(Herkunft.OHNE_ANGABE);
        assertThat(ohne.kw()).isEqualByComparingTo("15");
        assertThat(dienst.rueckfall(w.saeule(), Grenzart.EINSPEISUNG, BigDecimal.ZERO).herkunft())
                .isEqualTo(Herkunft.OHNE_ANGABE);
        assertThat(zeilen(w)).as("Lesen legt keine Zeile an").isZero();
    }

    @Test
    void einFremderKundenbereichSiehtWederKomponenteNochAngabe() {
        Welt a = welt();
        Welt b = welt();
        TenantContext.set(a.mandant());
        dienst.hinterlegen(a.wechselrichter(), Grenzart.EINSPEISUNG,
                new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal("40"), 60), null, "installateur@a.test");
        TenantContext.set(b.mandant());
        assertThatThrownBy(() -> dienst.rueckfall(a.wechselrichter(), Grenzart.EINSPEISUNG, BigDecimal.TEN))
                .isInstanceOf(GeraeteRueckfallDienst.KomponenteFehlt.class);
        assertThatThrownBy(() -> dienst.hinterlegen(a.wechselrichter(), Grenzart.EINSPEISUNG,
                new Angabe(GeraeteRueckfall.LAEUFT_FREI, null, null), null, "fremd@b.test"))
                .isInstanceOf(GeraeteRueckfallDienst.KomponenteFehlt.class);
        assertThat(app.queryForObject("SELECT count(*) FROM komponente_geraete_rueckfall", Long.class)).isZero();
        assertThatThrownBy(() -> app.update("INSERT INTO komponente_geraete_rueckfall (tenant_id, entity_id, richtung, "
                + "rueckfall, created_by) VALUES (?, ?, 'bezug', 'unbekannt', 'x')", a.mandant(), a.saeule()))
                .as("WITH CHECK").isInstanceOf(Exception.class);
        assertThat(zeilen(a)).isEqualTo(1);
    }

    @Test
    void tabelleIstMandantendichtEngBerechtigtUndDasOffboardingRaeumtSieAb() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'komponente_geraete_rueckfall'", Boolean.class)).isTrue();
        assertThat(recht(APP_USER, "SELECT")).isTrue();
        assertThat(recht(APP_USER, "INSERT")).isTrue();
        assertThat(recht(APP_USER, "DELETE")).as("eine Angabe wird aufgehoben, nie gelöscht").isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'komponente_geraete_rueckfall', "
                + "'aufgehoben_am', 'UPDATE')", Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'komponente_geraete_rueckfall', "
                + "'rueckfall_kw', 'UPDATE')", Boolean.class, APP_USER)).isFalse();
        // die Form: eine Zahl nur bei faellt_auf_wert, wer nie leer
        Welt w = welt();
        assertThatThrownBy(() -> root.update("INSERT INTO komponente_geraete_rueckfall (tenant_id, entity_id, "
                + "richtung, rueckfall, rueckfall_kw, created_by) VALUES (?, ?, 'bezug', 'laeuft_frei', 10, 'x')",
                w.mandant(), w.saeule())).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> root.update("INSERT INTO komponente_geraete_rueckfall (tenant_id, entity_id, "
                + "richtung, rueckfall, created_by) VALUES (?, ?, 'bezug', 'faellt_auf_wert', 'x')",
                w.mandant(), w.saeule())).isInstanceOf(Exception.class);
        assertThatThrownBy(() -> root.update("INSERT INTO komponente_geraete_rueckfall (tenant_id, entity_id, "
                + "richtung, rueckfall, created_by) VALUES (?, ?, 'bezug', 'unbekannt', ' ')",
                w.mandant(), w.saeule())).isInstanceOf(Exception.class);

        TenantContext.set(w.mandant());
        dienst.hinterlegen(w.saeule(), Grenzart.BEZUG, new Angabe(GeraeteRueckfall.UNBEKANNT, null, null), null,
                "installateur@w.test");
        TenantContext.clear();
        assertThat(zeilen(w)).isEqualTo(1);
        new TenantRepository(new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), ADMIN_USER,
                ADMIN_PW))).offboard(w.mandant());
        assertThat(zeilen(w)).isZero();
    }

    // ================================================================ Hilfen

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Rückfall #" + nr);
        UUID an = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Verwaltung') RETURNING id",
                UUID.class, t);
        return new Welt(t, komponente(t, an, "wallbox", "ocpp16"), komponente(t, an, "pv-generation", "sunspec"),
                komponente(t, an, "load", null));
    }

    /** Ein Wechselrichter-Einbau, der die PV-Komponente der Welt ab {@code ab} speist. */
    private static UUID einbau(Welt w, String kennzeichen, Instant ab) {
        UUID an = root.queryForObject("SELECT site_id FROM measurement_point WHERE id = ?", UUID.class,
                w.wechselrichter());
        UUID geraet = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, eingebaut_am) VALUES (?, ?, 'GR-11', ?, 'wechselrichter', ?) RETURNING id", UUID.class,
                w.mandant(), an, kennzeichen, Timestamp.from(ab));
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, gueltig_ab, entity_id) VALUES (?,?,?,?)",
                w.mandant(), geraet, Timestamp.from(ab), w.wechselrichter());
        return geraet;
    }

    private static UUID komponente(UUID t, UUID an, String rolle, String familie) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, family) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, t, an, rolle, familie);
    }

    private static long zeilen(Welt w) {
        return root.queryForObject("SELECT count(*) FROM komponente_geraete_rueckfall WHERE tenant_id = ?",
                Long.class, w.mandant());
    }

    private static boolean recht(String rolle, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, 'komponente_geraete_rueckfall', ?)",
                Boolean.class, rolle, recht));
    }
}
