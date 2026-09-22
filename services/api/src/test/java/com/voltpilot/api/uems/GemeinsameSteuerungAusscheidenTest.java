package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Ergebnis;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
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
 * Ausscheiden eines Mitglieds aus der Gemeinsamen Steuerung gegen die echte Datenbank (Konzept §5.5, I3/I4, G3–G5, V5,
 * R12; V20260922160000): Ahrenberg AN-1 (R1/R3: Einspeisung 40/60, Bezug 0/77). Übergang = die ausscheidende Box auf
 * den Rückfall ihrer Geräte, die anderen bleiben; Ziel erst nach ihrer Quittung (Rückfall bleibt reserviert) oder nach
 * der Bestätigung des Betreibers, dass ihre Geräte vom Netz sind (nichts reserviert); ohne beides steht der Übergang.
 * Dazu die führende Box (409), das Abmelden einer Mitglieds-Box, nie scharf (sofort) und der Bestand ohne Verbund (I6).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class GemeinsameSteuerungAusscheidenTest {

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

    /** Der Draht im Test: jede Nutzlast je Topic. */
    @TestConfiguration
    static class Draht {
        static final List<Map.Entry<String, byte[]>> GESENDET = new ArrayList<>();

        @Bean
        VerbundAnteileVersand testVersand() {
            return (topic, nutzlast) -> {
                synchronized (GESENDET) {
                    GESENDET.add(Map.entry(topic, nutzlast));
                }
                return true;
            };
        }
    }

    @Autowired
    SteuerungsverbundAnteilDienst dienst;
    @Autowired
    SteuerungsverbundRepository verbuende;
    @Autowired
    SteuerungsverbundAnteilRepository anteile;
    @Autowired
    GeraeteRueckfallDienst rueckfaelle;
    @Autowired
    ObjectMapper mapper;
    @Autowired
    GemeinsameSteuerungService steuerung;
    @Autowired
    GemeinsameSteuerungBoxStand boxStand;
    @Autowired
    GemeinsameSteuerungAusscheiden ausscheiden;
    @Autowired
    TransactionTemplate tx;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final ProtokollAkteur BETREIBER = new ProtokollAkteur("sub-betrieb", "Betrieb",
            "voltpilot_betrieb", "voltpilot");
    private static final ProtokollAkteur KUNDE = new ProtokollAkteur("sub-ka", "Frau Ahrens", "kundenadministrator",
            "kunde");

    private record Welt(UUID mandant, UUID anlage, UUID verbund, UUID e1, UUID e4) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void leer() {
        synchronized (Draht.GESENDET) {
            Draht.GESENDET.clear();
        }
    }

    @AfterEach
    void ohneMandant() {
        TenantContext.clear();
    }

    /**
     * R1/R3 mit steuerbaren Geräten an E-4 (Rückfall 0 in beiden Richtungen): der Übergang nimmt E-4 auf 0/0, E-1
     * bleibt 40/0; erst nach der Quittung von E-4 bekommt E-1 den Rest nach G4 — 100/77. E-4 behält ihr letztes Dokument
     * (0/0, V5), ihre Mitgliedschaft endet, nichts wird gelöscht; der Vorbehalt bleibt (nichts zu reservieren).
     */
    @Test
    void ausscheidenInS3UebergangAufNullZielErstNachIhrerQuittung() throws Exception {
        Welt w = scharf(ahrenberg(true));
        TenantContext.set(w.mandant());
        GemeinsameSteuerungDto.Zustand z = steuerung.ausscheiden(w.anlage(), w.e4(), KUNDE);
        GemeinsameSteuerungDto.Mitglied e4 = z.mitglieder().stream().filter(m -> m.boxId().equals(w.e4()))
                .findFirst().orElseThrow();
        assertThat(e4.ausscheiden().wartetAuf()).isEqualTo(GemeinsameSteuerungDto.Ausscheiden.WARTET_AUF_BOX);
        Ergebnis u = letztes(w);
        assertThat(u.dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(u.dokument().revision()).isEqualTo(3);
        assertThat(u.dokument().anlass()).isEqualTo("ausscheiden");
        assertThat(u.dokument().verengteBoxen()).containsExactly(w.e4().toString());
        assertThat(kw(u, Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("0");
        assertThat(kw(u, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("0");
        assertThat(kw(u, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("40");
        assertThat(kw(u, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0");
        assertThat(topics()).as("der Übergang geht an beide").containsExactlyInAnyOrder(
                VerbundAnteileDokument.topic(w.mandant(), w.anlage(), w.e1()),
                VerbundAnteileDokument.topic(w.mandant(), w.anlage(), w.e4()));

        // E-1 quittiert den Übergang: E-4 steht aus — nichts wird erweitert (R12)
        quittung(w, w.e1(), 1, 3);
        assertThat(letztes(w).dokument().revision()).isEqualTo(3);
        TenantContext.set(w.mandant());
        GemeinsameSteuerungDto.BoxStand blattE4 = boxStand.blatt(w.anlage()).boxen().stream()
                .filter(b -> b.boxId().equals(w.e4())).findFirst().orElseThrow();
        assertThat(blattE4.ausscheiden().wartetAuf()).isEqualTo("box");

        leer();
        quittung(w, w.e4(), 1, 3);
        Ergebnis ziel = letztes(w);
        assertThat(ziel.dokument().schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(ziel.dokument().revision()).isEqualTo(4);
        assertThat(ziel.dokument().tabelle().boxen()).containsExactly(w.e1().toString());
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("100");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("77");
        assertThat(topics()).as("die ausgeschiedene Box bekommt nichts mehr — sie hält 0/0 (V5)")
                .containsExactly(VerbundAnteileDokument.topic(w.mandant(), w.anlage(), w.e1()));
        TenantContext.set(w.mandant());
        assertThat(steuerung.lesen(w.anlage()).mitglieder()).extracting(GemeinsameSteuerungDto.Mitglied::boxId)
                .containsExactly(w.e1());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.BEZUG)).isEqualByComparingTo("473");
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_mitglied WHERE device_id = ? "
                + "AND gueltig_bis IS NOT NULL", Integer.class, w.e4())).as("zeitgültig beendet, nicht gelöscht")
                .isEqualTo(1);
        assertThat(root.queryForList("SELECT grund FROM steuerungsverbund_aenderung WHERE steuerungsverbund_id = ? "
                + "AND art = 'mitglied_ausgeschieden' ORDER BY id", String.class, w.verbund()))
                .containsExactly("ausscheiden_begonnen", "quittung");
        // jedes Dokument, das je ging, besteht die Prüfung der Box (IP-2) — auch E-4 mit eigenem Anteil 0
        for (Map.Entry<String, byte[]> e : alleGesendet()) {
            VerbundAnteileDokument.Gelesen g = VerbundAnteileDokument.lesen(mapper, e.getKey(), e.getValue());
            assertThat(SteuerungsverbundAnteile.dokumentPruefen(g.identitaet(), null, g.dokument()).urteil())
                    .isEqualTo(SteuerungsverbundVokabular.DokumentUrteil.ANGENOMMEN);
        }
    }

    /**
     * R1/R3 wie gebaut (E-4: Erzeuger läuft frei 60 kW, sechs Ladepunkte mit Rückfall 4,1): E-4 fällt auf ihren
     * Rückfall 60/24,6 — sie kann nie weniger zusagen, als ihre Geräte ohne sie tun. Quittiert sie, bleibt der Rückfall
     * im Vorbehalt reserviert und E-1 bekommt nur den Rest: 40/52,4.
     */
    @Test
    void ausscheidenMitQuittungReserviertDenRueckfallIhrerGeraete() throws Exception {
        Welt w = scharf(ahrenberg(false));
        TenantContext.set(w.mandant());
        steuerung.ausscheiden(w.anlage(), w.e4(), KUNDE);
        Ergebnis u = letztes(w);
        assertThat(kw(u, Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("60");
        assertThat(kw(u, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("24.6");
        assertThat(kw(u, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("40");
        assertThat(kw(u, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0");
        assertThat(u.dokument().ziel().anteile().get(Grenzart.BEZUG).get(w.e1().toString()))
                .isEqualByComparingTo("52.4");
        quittung(w, w.e1(), 1, 3);
        quittung(w, w.e4(), 1, 3);
        Ergebnis ziel = letztes(w);
        assertThat(ziel.dokument().revision()).isEqualTo(4);
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("40");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("52.4");
        TenantContext.set(w.mandant());
        SteuerungsverbundAnteilRepository.Vorbehalt vb = anteile.vorbehalt(w.verbund());
        assertThat(vb.kw().get(Grenzart.EINSPEISUNG)).isEqualByComparingTo("60");
        assertThat(vb.kw().get(Grenzart.BEZUG)).isEqualByComparingTo("497.6");
        // Summe am Anschluss auch bei stummer E-4: 40 + 60 ≤ 100 · 52,4 + 24,6 + 473 ≤ 550
    }

    /**
     * Die Box ist tot: ihre Quittung bleibt aus, der Übergang steht, E-1 bekommt nichts (R12) — bis der Betreiber
     * bestätigt, dass ihre Geräte vom Netz sind (I4). Dann Ziel ohne ihre Quittung, nichts reserviert: 100/77.
     */
    @Test
    void quittungBleibtAusUebergangStehtBetreiberBestaetigtVomNetz() throws Exception {
        Welt w = scharf(ahrenberg(false));
        TenantContext.set(w.mandant());
        steuerung.ausscheiden(w.anlage(), w.e4(), KUNDE);
        quittung(w, w.e1(), 1, 3);
        TenantContext.set(w.mandant());
        assertThat(dienst.anteileAendern(w.anlage(), BETREIBER).grund())
                .isEqualTo(SteuerungsverbundAnteilDienst.Grund.ZWEISCHRITT_LAEUFT);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(letztes(w).dokument().revision()).isEqualTo(3);

        TenantContext.set(w.mandant());
        steuerung.ausscheidenBestaetigen(w.anlage(), w.e4(), BETREIBER);
        Ergebnis ziel = letztes(w);
        assertThat(ziel.dokument().schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("100");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("77");
        TenantContext.set(w.mandant());
        assertThat(anteile.vorbehalt(w.verbund()).kw().get(Grenzart.EINSPEISUNG)).isEqualByComparingTo("0");
        assertThat(steuerung.lesen(w.anlage()).mitglieder()).hasSize(1);
        assertThatThrownBy(() -> steuerung.ausscheidenBestaetigen(w.anlage(), w.e4(), BETREIBER))
                .isInstanceOf(GemeinsameSteuerungAbgelehnt.class)
                .extracting(e -> ((GemeinsameSteuerungAbgelehnt) e).code()).isEqualTo("kein_mitglied");
    }

    /** Die führende Box scheidet nicht aus, solange E-4 mitsteuert; eine fremde Box ist kein Mitglied; ein Übergang läuft. */
    @Test
    void fuehrendeBoxBleibtUndZweischrittLaeuft() throws Exception {
        Welt w = ahrenberg(false);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(code(() -> steuerung.ausscheiden(w.anlage(), w.e1(), KUNDE))).isEqualTo("fuehrende_box_bleibt");
        assertThat(code(() -> steuerung.ausscheiden(w.anlage(), UUID.randomUUID(), KUNDE))).isEqualTo("kein_mitglied");
        assertThat(code(() -> steuerung.ausscheiden(w.anlage(), w.e4(), KUNDE))).as("der Übergang des Scharfschaltens")
                .isEqualTo("zweischritt_laeuft");
        TenantContext.set(w.mandant());
        assertThat(verbuende.ausscheidende(w.verbund(), Instant.now())).isEmpty();
        assertThat(code(() -> steuerung.ausscheidenBestaetigen(w.anlage(), w.e4(), BETREIBER)))
                .isEqualTo("scheidet_nicht_aus");
    }

    /**
     * Abmelden einer Mitglieds-Box ({@code DELETE /api/v1/devices/{id}} ruft {@link GemeinsameSteuerungAusscheiden
     * #beimAusbau}): sie scheidet aus und wartet auf VoltPilot — auch eine Quittung schließt nicht ab; erst die
     * Bestätigung des Betreibers. Die führende Box wird nicht abgemeldet (409).
     */
    @Test
    void abmeldenEinerMitgliedsBoxWartetAufDenBetreiber() throws Exception {
        Welt w = scharf(ahrenberg(true));
        TenantContext.set(w.mandant());
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> ausscheiden.beimAusbau(w.e1(), null)))
                .isInstanceOf(BoxKonflikt.class).hasMessageContaining("fuehrende_box_bleibt");
        tx.executeWithoutResult(s -> ausscheiden.beimAusbau(w.e4(), null));
        TenantContext.set(w.mandant());
        GemeinsameSteuerungDto.Mitglied e4 = steuerung.lesen(w.anlage()).mitglieder().stream()
                .filter(m -> m.boxId().equals(w.e4())).findFirst().orElseThrow();
        assertThat(e4.ausscheiden().wartetAuf()).isEqualTo(GemeinsameSteuerungDto.Ausscheiden.WARTET_AUF_VOLTPILOT);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        quittung(w, w.e1(), 1, 3);
        quittung(w, w.e4(), 1, 3);
        assertThat(letztes(w).dokument().revision()).as("abgemeldet: nur der Betreiber schließt ab").isEqualTo(3);
        TenantContext.set(w.mandant());
        steuerung.ausscheidenBestaetigen(w.anlage(), w.e4(), BETREIBER);
        Ergebnis ziel = letztes(w);
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("100");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("77");
        assertThat(root.queryForList("SELECT grund FROM steuerungsverbund_aenderung WHERE steuerungsverbund_id = ? "
                + "AND art = 'mitglied_ausgeschieden' ORDER BY id", String.class, w.verbund()))
                .containsExactly("ausscheiden_begonnen", "geraete_vom_netz", "geraete_vom_netz");
    }

    /** Nie scharf (kein Dokument): die Mitgliedschaft endet sofort, kein Topic. Bestand ohne Verbund: nichts (I6). */
    @Test
    void nieScharfEndetSofortUndBestandOhneVerbundMerktNichts() throws Exception {
        Welt w = ahrenberg(false);
        TenantContext.set(w.mandant());
        steuerung.ausscheiden(w.anlage(), w.e4(), KUNDE);
        TenantContext.set(w.mandant());
        assertThat(steuerung.lesen(w.anlage()).mitglieder()).extracting(GemeinsameSteuerungDto.Mitglied::boxId)
                .containsExactly(w.e1());
        assertThat(topics()).isEmpty();
        assertThat(anteile.dokumente(w.verbund())).isEmpty();

        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Bestand') RETURNING id", UUID.class);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Bestand') RETURNING id",
                UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, s, "bestand-" + NR.incrementAndGet());
        TenantContext.set(t);
        tx.executeWithoutResult(x -> ausscheiden.beimAusbau(box, null));
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_aenderung WHERE tenant_id = ?",
                Integer.class, t)).isZero();
        assertThat(topics()).isEmpty();
    }

    // ------------------------------------------------------------------ Welt

    /** S3 wie gebaut: Scharfschalten (Epoche 1), Übergang → Quittung E-1 → Ziel (rev 2), beide quittieren. */
    private Welt scharf(Welt w) {
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        quittung(w, w.e1(), 1, 1);
        quittung(w, w.e1(), 1, 2);
        quittung(w, w.e4(), 1, 2);
        TenantContext.set(w.mandant());
        verbuende.stufeSetzen(w.verbund(), Stufe.ANTEILE_AKTIV);
        Ergebnis ziel = letztes(w);
        assertThat(ziel.dokument().revision()).isEqualTo(2);
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("40");
        assertThat(kw(ziel, Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("60");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0");
        assertThat(kw(ziel, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77");
        leer();
        return w;
    }

    /**
     * AN-1 in S1: E-1 führt (PV 100 kW, Rückfall 40; Speicher 100 kW, Rückfall 0), E-4 steuert mit (PV 60 kW, sechs
     * Ladepunkte je 22 kW). {@code steuerbar}: E-4-Geräte fallen auf 0 zurück — sonst läuft der Erzeuger frei (Rückfall
     * 60) und jeder Ladepunkt fällt auf 4,1 kW (24,6).
     */
    private Welt ahrenberg(boolean steuerbar) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Ahrenberg #" + nr);
        UUID an = root.queryForObject("INSERT INTO site (tenant_id, name, max_feed_in_kw) VALUES (?, 'Halle 1', 100) "
                + "RETURNING id", UUID.class, t);
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?, ?, 550)", an, t);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an, "e1-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an, "e4-" + nr);
        UUID dq2 = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', ?, '{1}', 10) RETURNING id", UUID.class,
                t, an, "10.1." + nr + ".2:502");
        TenantContext.set(t);
        UUID v = verbuende.einrichten(t, an, "test");
        verbuende.stufeSetzen(v, Stufe.BEOBACHTET);
        Instant ab = Instant.parse("2026-01-01T00:00:00Z");
        verbuende.mitgliedAufnehmen(t, v, e1, Rolle.FUEHRT, dq2, ab, null, "test");
        verbuende.mitgliedAufnehmen(t, v, e4, Rolle.STEUERT_MIT, null, ab, null, "test");
        Welt w = new Welt(t, an, v, e1, e4);
        anteile.vorbehaltSetzen(v, BigDecimal.ZERO, new BigDecimal("473"), "betreiber@voltpilot.test");
        geraet(w, e1, "pv-generation", Grenzart.EINSPEISUNG, "100", "40");
        geraet(w, e1, "battery-hybrid", Grenzart.BEZUG, "100", "0");
        geraet(w, e4, "pv-generation", Grenzart.EINSPEISUNG, "60", steuerbar ? "0" : null);
        for (int i = 0; i < 6; i++) {
            geraet(w, e4, "wallbox", Grenzart.BEZUG, "22", steuerbar ? "0" : "4.1");
        }
        TenantContext.clear();
        return w;
    }

    private void geraet(Welt w, UUID box, String rolle, Grenzart richtung, String nenn, String rueckfall) {
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, created_at) "
                + "VALUES (?, ?, ?, '2026-01-01T00:00:00Z') RETURNING id", UUID.class, w.mandant(), w.anlage(), rolle);
        anteile.geraetEintragen(w.mandant(), w.verbund(), box, k, richtung, new BigDecimal(nenn), true, null, "test");
        if (rueckfall != null) {
            rueckfaelle.hinterlegen(k, richtung, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal(rueckfall),
                    60), null, "installateur@ahrenberg.test");
        }
    }

    private void quittung(Welt w, UUID box, long epoche, long revision) {
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", dienst,
                mapper);
        TenantContext.clear();
        listener.handle(VerbundAnteileDokument.resultTopic(w.mandant(), w.anlage(), box),
                ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + w.mandant() + "\",\"site_id\":\"" + w.anlage()
                        + "\",\"device_id\":\"" + box + "\",\"epoche\":" + epoche + ",\"revision\":" + revision
                        + ",\"urteil\":\"angenommen\",\"ts\":\"2027-10-20T09:00:05Z\"}")
                        .getBytes(StandardCharsets.UTF_8), Instant.now());
    }

    private static String code(Runnable r) {
        try {
            r.run();
        } catch (GemeinsameSteuerungAbgelehnt e) {
            return e.code();
        }
        return null;
    }

    private Ergebnis letztes(Welt w) {
        TenantContext.set(w.mandant());
        return new Ergebnis(null, anteile.dokumente(w.verbund()).get(0), List.of());
    }

    private static BigDecimal kw(Ergebnis e, Grenzart r, UUID box) {
        return e.dokument().tabelle().anteile().get(r).get(box.toString());
    }

    private List<String> topics() {
        synchronized (Draht.GESENDET) {
            return Draht.GESENDET.stream().map(Map.Entry::getKey).toList();
        }
    }

    private List<Map.Entry<String, byte[]>> alleGesendet() {
        synchronized (Draht.GESENDET) {
            return List.copyOf(Draht.GESENDET);
        }
    }
}
