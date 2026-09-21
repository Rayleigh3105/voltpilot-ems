package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Ergebnis;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Grund;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
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
 * Anteils-Ableitung und Zweischritt gegen die echte Datenbank (UEMS AP-15 IP-7, V20260921190000): R12 als Ablauf
 * (Übergang an alle, Zielstand erst nach der Quittung der verengten Box, ohne sie bleibt der Übergang), A18
 * (Rückspielen erkannt → keine Änderung ohne neue Epoche; „alt“ nur aus dem Herzschlag), die Stufe S1 als erste
 * Stufe mit Dokument (LA2), Bestand ohne Verbund ohne jedes Topic, RLS + FORCE und enge Rechte, Offboarding.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class SteuerungsverbundAnteilDienstTest {

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

    /**
     * Der Draht im Test: jede Nutzlast je Topic. Die wirksamen Anteile kommen aus der ECHTEN Quelle
     * {@link WirksameAnteileAusHerzschlag} (IP-17), gefüttert mit dem Herzschlag-Block, den die Box sendet.
     */
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
    WirksameAnteileAusHerzschlag herzschlag;
    @Autowired
    GemeinsameSteuerungBoxStand boxStand;
    @Autowired
    AnlageGrenzen grenzen;
    @Autowired
    ObjectProvider<VerbundAnteileVersand> versand;
    @Autowired
    ObjectProvider<WirksameAnteileQuelle> herzschlagQuelle;
    @Autowired
    GemeinsameSteuerungService steuerung;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static final ProtokollAkteur BETREIBER = new ProtokollAkteur("sub-betrieb", "Betrieb",
            "voltpilot_betrieb", "voltpilot");

    private record Welt(UUID mandant, UUID anlage, UUID verbund, UUID e1, UUID e4, UUID mitgliedE1,
            UUID mitgliedE4) {}

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

    @Test
    void r12ZweischrittUebergangAnAlleZielErstNachDerQuittungDerVerengtenBox() throws Exception {
        Welt w = ahrenberg(Stufe.BEOBACHTET);
        TenantContext.set(w.mandant());

        // LA2: schon in S1 verengt der erste Schritt (neue Epoche); „alt“ = führende die ganze Grenze, E-4 ihr Rückfall
        Ergebnis s1 = dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(s1.veroeffentlicht()).isTrue();
        assertThat(s1.dokument().epoche()).isEqualTo(1);
        assertThat(s1.dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(s1.dokument().verengteBoxen()).containsExactly(w.e1().toString());
        assertThat(s1.gesendetAn()).containsExactlyInAnyOrder(w.e1(), w.e4());
        assertThat(kw(s1, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("40.0");
        assertThat(kw(s1, Grenzart.BEZUG, w.e4())).as("E-4 am Bezug erst ihr Rückfall").isEqualByComparingTo("24.6");
        assertThat(topics()).containsExactlyInAnyOrder(VerbundAnteileDokument.topic(w.mandant(), w.anlage(), w.e1()),
                VerbundAnteileDokument.topic(w.mandant(), w.anlage(), w.e4()));

        quittung(w, w.e1(), 1, 1, "angenommen", null, null);
        Ergebnis ziel1 = letztes(w);
        assertThat(ziel1.dokument().schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(ziel1.dokument().revision()).isEqualTo(2);
        assertThat(kw(ziel1, Grenzart.BEZUG, w.e4())).isEqualByComparingTo("77.0");
        quittung(w, w.e1(), 1, 2, "angenommen", null, null);
        quittung(w, w.e4(), 1, 2, "angenommen", null, null);

        // R12: zweiter Wechselrichter 30 kW an E-4 (läuft frei), K-1 bekommt 10 kW → 10/90
        TenantContext.set(w.mandant());
        UUID k12b = komponente(w, "pv-generation");
        anteile.geraetEintragen(w.mandant(), w.verbund(), w.e4(), k12b, Grenzart.EINSPEISUNG, new BigDecimal("30"),
                true, "zweiter Wechselrichter", "kunde@ahrenberg.test");
        rueckfaelle.hinterlegen(k1(w), Grenzart.EINSPEISUNG, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT,
                new BigDecimal("10"), 60), null, "installateur@ahrenberg.test");
        leer();
        Ergebnis r12 = dienst.anteileAendern(w.anlage(), BETREIBER);
        assertThat(r12.veroeffentlicht()).isTrue();
        assertThat(r12.dokument().epoche()).as("eine Änderung setzt keine neue Epoche").isEqualTo(1);
        assertThat(r12.dokument().revision()).isEqualTo(3);
        assertThat(kw(r12, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("10.0");
        assertThat(kw(r12, Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("60.0");
        assertThat(summe(r12, Grenzart.EINSPEISUNG)).isEqualByComparingTo("70.0");
        assertThat(topics()).as("der Übergang geht an alle").hasSize(2);
        assertThat(dienst.anteileAendern(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.ZWEISCHRITT_LAEUFT);

        // fehlt die Quittung von E-1, bleibt 10/60 — auch wenn E-4 quittiert
        quittung(w, w.e4(), 1, 3, "angenommen", null, null);
        assertThat(letztes(w).dokument().revision()).isEqualTo(3);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        // IP-24: das Betreiber-Blatt sieht den Übergangsstand „1 von 2“ und wartet auf E-1 — kein Zielstand
        TenantContext.set(w.mandant());
        GemeinsameSteuerungDto.Zweischritt uebergang = boxStand.blatt(w.anlage()).zweischritt();
        assertThat(uebergang.schritt()).isEqualTo("uebergang");
        assertThat(uebergang.revision()).isEqualTo(3);
        assertThat(uebergang.bestaetigt()).containsExactly(w.e4());
        assertThat(uebergang.wartetAuf()).containsExactly(w.e1());
        GemeinsameSteuerungDto.BoxStand e4 = boxStand.blatt(w.anlage()).boxen().stream()
                .filter(b -> b.boxId().equals(w.e4())).findFirst().orElseThrow();
        assertThat(e4.anteile().gesendet().revision()).isEqualTo(3);
        assertThat(e4.anteile().quittiert().revision()).isEqualTo(3);
        // IP-23-Folge: der Kunde sieht je Box, was sie QUITTIERT hat — E-4 den Übergangswert 60, E-1 (rev 3 nur
        // gesendet) weiter ihren Zielstand 40 aus rev 2, nicht die gesendeten 10
        Map<UUID, GemeinsameSteuerungDto.WirksameAnteile> kunde = new java.util.HashMap<>();
        steuerung.lesen(w.anlage()).mitglieder().forEach(m -> kunde.put(m.boxId(), m.wirksameAnteile()));
        assertThat(kunde.get(w.e4()).einspeisungKw()).isEqualByComparingTo("60.0");
        assertThat(kunde.get(w.e1()).einspeisungKw()).isEqualByComparingTo("40.0");
        assertThat(kunde.get(w.e4()).bezugKw()).isEqualByComparingTo("77.0");

        quittung(w, w.e1(), 1, 3, "angenommen", null, null);
        TenantContext.set(w.mandant());
        GemeinsameSteuerungDto.Zweischritt ziel = boxStand.blatt(w.anlage()).zweischritt();
        assertThat(ziel.schritt()).as("der Zielstand erst, wenn die api ihn veröffentlicht").isEqualTo("ziel");
        assertThat(ziel.revision()).isEqualTo(4);
        assertThat(ziel.wartetAuf()).as("gesendet, noch nicht quittiert").containsExactlyInAnyOrder(w.e1(), w.e4());
        Ergebnis r12ziel = letztes(w);
        assertThat(r12ziel.dokument().revision()).isEqualTo(4);
        assertThat(kw(r12ziel, Grenzart.EINSPEISUNG, w.e1())).isEqualByComparingTo("10.0");
        assertThat(kw(r12ziel, Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("90.0");
        assertThat(summe(r12ziel, Grenzart.EINSPEISUNG)).isEqualByComparingTo("100.0");

        // jedes Dokument, das je ging, hält die Summe unter verteilbar (die Box prüft es selbst, IP-2)
        for (Map.Entry<String, byte[]> e : Draht.GESENDET) {
            VerbundAnteileDokument.Gelesen g = VerbundAnteileDokument.lesen(mapper, e.getKey(), e.getValue());
            assertThat(SteuerungsverbundAnteile.dokumentPruefen(g.identitaet(), null, g.dokument()).urteil())
                    .isEqualTo(SteuerungsverbundVokabular.DokumentUrteil.ANGENOMMEN);
        }
        TenantContext.set(w.mandant());
        assertThat(anteile.dokumente(w.verbund())).extracting(SteuerungsverbundAnteilRepository.DokumentZeile::anlass)
                .containsExactly("zielstand", "aendern", "zielstand", "scharfschalten");
    }

    @Test
    void a18RueckspielenErkanntKeineAenderungOhneNeueEpocheAltNurAusDemHerzschlag() throws Exception {
        Welt w = ahrenberg(Stufe.ANTEILE_AKTIV);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        quittung(w, w.e1(), 1, 1, "angenommen", null, null);
        quittung(w, w.e1(), 1, 2, "angenommen", null, null);
        quittung(w, w.e4(), 1, 2, "angenommen", null, null);

        // Die Box meldet einen Stand über allem, was diese Datenbank je gemacht hat → zurückgespielt
        quittung(w, w.e1(), 1, 2, "abgelehnt", "revision_aelter", "{\"epoche\":1,\"revision\":9}");
        TenantContext.set(w.mandant());
        assertThat(anteile.rueckgespieltErkannt(w.verbund())).isPresent();
        leer();
        assertThat(dienst.anteileAendern(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.RUECKGESPIELT);
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).grund())
                .as("ohne wirksame Anteile aus dem Herzschlag kein neues Scharfschalten")
                .isEqualTo(Grund.WIRKSAME_ANTEILE_UNBEKANNT);
        assertThat(Draht.GESENDET).isEmpty();
        assertThat(verbuende.derAnlage(w.anlage()).orElseThrow().epoche()).isEqualTo(1);

        // Der Herzschlag meldet, was die Boxen WIRKSAM halten (hier 10/90 aus dem verlorenen Stand) — der Block, wie
        // ihn die Box sendet (IP-17); nur eine Richtung ist „unbekannt“, nicht null
        herzschlag.merke(w.anlage(), w.e1(), mapper.readTree("""
                {"rolle":"fuehrt","anteile_epoche":1,"anteile_revision":9,"anteile_kw":{"einspeisung":10.0}}"""));
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).grund())
                .as("eine Richtung fehlt im Herzschlag").isEqualTo(Grund.WIRKSAME_ANTEILE_UNBEKANNT);
        herzschlag.merke(w.anlage(), w.e1(), mapper.readTree("""
                {"plan_id":"4711aaaa-0000-4000-8000-000000004711","rolle":"fuehrt","anteile_epoche":1,
                 "anteile_revision":9,"anteile_kw":{"einspeisung":10.0,"bezug":0.0}}"""));
        herzschlag.merke(UUID.randomUUID(), w.e4(), mapper.readTree("""
                {"rolle":"steuert_mit","anteile_epoche":1,"anteile_revision":9,
                 "anteile_kw":{"einspeisung":90.0,"bezug":77.0}}"""));
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).grund())
                .as("der Herzschlag einer Box von einem anderen Standort zählt nicht").isEqualTo(
                        Grund.WIRKSAME_ANTEILE_UNBEKANNT);
        herzschlag.merke(w.anlage(), w.e4(), mapper.readTree("""
                {"rolle":"steuert_mit","anteile_epoche":1,"anteile_revision":9,
                 "anteile_kw":{"einspeisung":90.0,"bezug":77.0}}"""));
        Ergebnis neu = dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(neu.veroeffentlicht()).isTrue();
        assertThat(neu.dokument().epoche()).isEqualTo(2);
        assertThat(neu.dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(kw(neu, Grenzart.EINSPEISUNG, w.e1())).as("min(10 wirksam, 40 neu)").isEqualByComparingTo("10.0");
        assertThat(kw(neu, Grenzart.EINSPEISUNG, w.e4())).as("min(90 wirksam, 60 neu)").isEqualByComparingTo("60.0");
        assertThat(neu.dokument().verengteBoxen()).containsExactly(w.e4().toString());
        assertThat(anteile.rueckgespieltErkannt(w.verbund())).as("nur das Scharfschalten hebt die Marke").isEmpty();
        // IP-17: jedes Dokument nennt die Rolle der Box seines Topics
        synchronized (Draht.GESENDET) {
            for (Map.Entry<String, byte[]> e : Draht.GESENDET) {
                String erwartet = e.getKey().contains(w.e1().toString()) ? "fuehrt" : "steuert_mit";
                assertThat(mapper.readTree(e.getValue()).path("rolle").asText()).as(e.getKey()).isEqualTo(erwartet);
            }
            assertThat(Draht.GESENDET).hasSize(2);
        }
    }

    @Test
    void s0UndAuslegungPasstNichtVeroeffentlichenNichtsUndDieNahtFuerIp5() throws Exception {
        Welt w = ahrenberg(Stufe.ERKLAERT);
        TenantContext.set(w.mandant());
        assertThat(dienst.auslegungPasst(w.anlage())).isTrue();
        assertThat(dienst.eingaenge(w.anlage())).containsKeys(Grenzart.EINSPEISUNG, Grenzart.BEZUG);
        SteuerungsverbundRepository.RegelStand rs = verbuende.regelStand(w.anlage(), Instant.now(),
                java.time.LocalDate.now()).orElseThrow();
        assertThat(SteuerungsverbundRegeln.pruefen(rs.verbund(), rs.quellen(), dienst.eingaenge(w.anlage()))
                .befunde()).noneMatch(b -> b.ablehnung() == SteuerungsverbundVokabular.Ablehnung.AUSLEGUNG_PASST_NICHT);
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.STUFE_ZU_FRUEH);

        verbuende.stufeSetzen(w.verbund(), Stufe.BEOBACHTET);
        root.update("UPDATE site SET max_feed_in_kw = 70 WHERE id = ?", w.anlage()); // R2 ohne Rückfallwert an K-12
        assertThat(dienst.auslegungPasst(w.anlage())).isFalse();
        assertThat(dienst.ableiten(w.anlage()).orElseThrow().auslegung().get(Grenzart.EINSPEISUNG).urteil())
                .isEqualTo(SteuerungsverbundVokabular.AuslegungUrteil.AUSLEGUNG_PASST_NICHT);
        assertThat(dienst.anteileScharfschalten(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.AUSLEGUNG_PASST_NICHT);
        assertThat(Draht.GESENDET).isEmpty();
        assertThat(verbuende.derAnlage(w.anlage()).orElseThrow().epoche()).isZero();
    }

    @Test
    void nahtZuIp5AuslegungUndAusrollenInDerEpocheDesScharfschaltens() throws Exception {
        Welt w = ahrenberg(Stufe.GEPRUEFT);
        TenantContext.set(w.mandant());
        java.time.LocalDate heute = java.time.LocalDate.now(java.time.ZoneId.of("Europe/Berlin"));
        var eingang = dienst.auslegungFuer(w.anlage(), List.of(w.e1(), w.e4()), heute);
        assertThat(eingang).isPresent();
        assertThat(eingang.get().get(Grenzart.BEZUG).vorbehaltKw()).isEqualByComparingTo("473");
        assertThat(dienst.auslegungFuer(w.anlage(), List.of(), heute)).isEmpty();
        anteile.vorbehaltSetzen(w.verbund(), BigDecimal.ZERO, null, "betreiber@voltpilot.test");
        assertThat(dienst.auslegungFuer(w.anlage(), List.of(w.e1(), w.e4()), heute))
                .as("ohne Vorbehalt am Bezug nicht rechenbar — unbekannt ist nicht passt").isEmpty();
        anteile.vorbehaltSetzen(w.verbund(), BigDecimal.ZERO, new BigDecimal("473"), "betreiber@voltpilot.test");

        assertThat(dienst.anteileAusrollen(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.NOCH_NICHT_SCHARF);
        long epoche = verbuende.epocheErhoehen(w.verbund()).orElseThrow(); // so setzt IP-5 sie beim Scharfschalten
        Ergebnis e = dienst.anteileAusrollen(w.anlage(), BETREIBER);
        assertThat(e.veroeffentlicht()).isTrue();
        assertThat(e.dokument().epoche()).as("keine zweite Epoche").isEqualTo(epoche);
        assertThat(verbuende.derAnlage(w.anlage()).orElseThrow().epoche()).isEqualTo(epoche);
        assertThat(dienst.anteileAusrollen(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.UNVERAENDERT);
    }

    @Test
    void bestandOhneVerbundKeinDokumentKeinTopic() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bestand #" + nr);
        UUID an = root.queryForObject("INSERT INTO site (tenant_id, name, max_feed_in_kw) VALUES (?, 'Bestand', 70) "
                + "RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an, "bestand-" + nr);
        TenantContext.set(t);
        assertThat(dienst.anteileScharfschalten(an, BETREIBER).grund()).isEqualTo(Grund.KEIN_VERBUND);
        assertThat(dienst.anteileAendern(an, BETREIBER).grund()).isEqualTo(Grund.KEIN_VERBUND);
        assertThat(dienst.eingaenge(an)).isEmpty();
        assertThat(dienst.auslegungPasst(an)).isFalse();
        assertThat(dienst.erneutSenden(an)).isEmpty();
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", dienst,
                mapper);
        assertThat(listener.handle(VerbundAnteileDokument.resultTopic(t, an, box), ergebnis(t, an, box, 1, 1,
                "angenommen", null, null), Instant.now())).isFalse();
        assertThat(Draht.GESENDET).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_anteile WHERE tenant_id = ?",
                Long.class, t)).isZero();
    }

    @Test
    void rlsForceEngeRechteUndOffboarding() {
        for (String tabelle : List.of("steuerungsverbund_geraet", "steuerungsverbund_anteile")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, tabelle)).as(tabelle).isTrue();
            assertThat(recht(APP_USER, tabelle, "DELETE")).as(tabelle).isFalse();
            assertThat(recht(APP_USER, tabelle, "INSERT")).as(tabelle).isTrue();
        }
        assertThat(recht(APP_USER, "steuerungsverbund_anteile", "UPDATE")).as("Dokumente nur anhängen").isFalse();

        Welt w = ahrenberg(Stufe.BEOBACHTET);
        Welt fremd = ahrenberg(Stufe.BEOBACHTET);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(anteile.dokumente(fremd.verbund())).as("RLS: ein fremder Verbund ist unsichtbar").isEmpty();
        TenantContext.clear();
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(w.mandant());
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_anteile WHERE tenant_id = ?",
                Long.class, w.mandant())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_geraet WHERE tenant_id = ?",
                Long.class, w.mandant())).isZero();
    }

    // ------------------------------------------------------------------ Welt

    /** AN-1 mit E-1 (führt, K-1 100 kW → 40, K-2 100 kW → 0) und E-4 (steuert mit, K-12 60 kW frei, 6 × 22 → 4,1). */
    // ============================================================ AP-15 IP-30 (NW-4): Ausfälle am Zweischritt

    /**
     * A5/R7 einseitig stumm: E-4 soll am Bezug enger werden (77 → 47 kW), damit E-1 30 kW bekommt — E-4 ist stumm und
     * quittiert nichts. E-1 quittiert ihren Übergang, bekommt aber nie mehr als vorher (0 kW), es gibt keinen
     * Zielstand und keine zweite Änderung; das einzige, was E-4 bekommt, ist das retained Übergangsdokument.
     */
    @Test
    void a5EinseitigStummDieVerengteBoxQuittiertNichtDieAndereWirdNieErweitert() throws Exception {
        Welt w = zielstandQuittiert();
        UUID akku = root.queryForObject("SELECT entity_id FROM steuerungsverbund_geraet WHERE device_id = ? "
                + "AND richtung = 'bezug'", UUID.class, w.e1());
        TenantContext.set(w.mandant());
        rueckfaelle.hinterlegen(akku, Grenzart.BEZUG, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT,
                new BigDecimal("30"), 60), null, "installateur@ahrenberg.test");
        leer();

        Ergebnis u = dienst.anteileAendern(w.anlage(), BETREIBER);
        assertThat(u.veroeffentlicht()).isTrue();
        assertThat(u.dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(u.dokument().verengteBoxen()).containsExactly(w.e4().toString());
        assertThat(kw(u, Grenzart.BEZUG, w.e1())).as("Übergang: E-1 bleibt bei 0").isEqualByComparingTo("0.0");
        assertThat(kw(u, Grenzart.BEZUG, w.e4())).as("Übergang: E-4 schon eng").isEqualByComparingTo("47.0");
        assertThat(u.gesendetAn()).containsExactlyInAnyOrder(w.e1(), w.e4());

        quittung(w, w.e1(), 1, 3, "angenommen", null, null);
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().revision()).as("kein Zielstand ohne E-4").isEqualTo(3);
        assertThat(kw(letztes(w), Grenzart.BEZUG, w.e1())).isEqualByComparingTo("0.0");
        assertThat(dienst.anteileAendern(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.ZWEISCHRITT_LAEUFT);
        assertThat(quittiert(w.e4())).as("E-4 hält weiter ihren Zielstand von Revision 2").containsExactly(1L, 2L);
        assertThat(topics()).as("nach dem Übergang geht nichts mehr auf den Draht").hasSize(2);
    }

    /**
     * A10/R12 hängender Zweischritt über einen Neustart der api: drei Tage später, mit einem neuen Dienst ohne
     * Gedächtnis (alles steht in der Datenbank), steht der Übergang noch — kein Zeitablauf macht ihn zum Zielstand.
     * Eine späte Quittung einer ALTEN Revision (E-1 hatte Revision 2 nie quittiert) zählt nicht; erst die Quittung
     * des Übergangs selbst bringt den Zielstand. Erneut zugestellt wird genau der Übergang.
     */
    @Test
    void a10HaengenderZweischrittUeberstehtDenNeustartUndEineAlteQuittungZaehltNicht() throws Exception {
        Welt w = ahrenberg(Stufe.ANTEILE_AKTIV);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        quittung(w, w.e1(), 1, 1, "angenommen", null, null);
        quittung(w, w.e4(), 1, 2, "angenommen", null, null);
        TenantContext.set(w.mandant());
        rueckfaelle.hinterlegen(k1(w), Grenzart.EINSPEISUNG, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT,
                new BigDecimal("10"), 60), null, "installateur@ahrenberg.test");
        anteile.geraetEintragen(w.mandant(), w.verbund(), w.e4(), komponente(w, "pv-generation"), Grenzart.EINSPEISUNG,
                new BigDecimal("30"), true, "zweiter Wechselrichter", "kunde@ahrenberg.test");
        Ergebnis u = dienst.anteileAendern(w.anlage(), BETREIBER);
        assertThat(u.dokument().revision()).isEqualTo(3);
        assertThat(u.dokument().verengteBoxen()).containsExactly(w.e1().toString());

        // Neustart: neuer Dienst, neuer Listener, die Uhr drei Tage weiter
        SteuerungsverbundAnteilDienst neu = new SteuerungsverbundAnteilDienst(verbuende, anteile, rueckfaelle, grenzen,
                versand, herzschlagQuelle, mapper,
                Clock.fixed(Instant.now().plus(Duration.ofDays(3)), ZoneOffset.UTC));
        leer();
        TenantContext.set(w.mandant());
        assertThat(neu.anteileAendern(w.anlage(), BETREIBER).grund()).isEqualTo(Grund.ZWEISCHRITT_LAEUFT);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);

        quittung(neu, w, w.e1(), 1, 2, "angenommen");
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().revision()).as("Revision 2 ist nicht der Übergang").isEqualTo(3);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(Draht.GESENDET).isEmpty();

        TenantContext.set(w.mandant());
        List<UUID> erneut = neu.erneutSenden(w.anlage());
        assertThat(erneut).containsExactlyInAnyOrder(w.e1(), w.e4());
        synchronized (Draht.GESENDET) {
            for (Map.Entry<String, byte[]> e : Draht.GESENDET) {
                assertThat(mapper.readTree(e.getValue()).path("revision").asLong()).as(e.getKey()).isEqualTo(3);
            }
        }

        quittung(neu, w, w.e1(), 1, 3, "angenommen");
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().revision()).isEqualTo(4);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(kw(letztes(w), Grenzart.EINSPEISUNG, w.e4())).isEqualByComparingTo("90.0");
    }

    /**
     * Epoche nach dem Rückspielen (A18-Folge): die Cloud steht nach dem erneuten Scharfschalten in Epoche 2; eine
     * verspätete Quittung aus dem verlorenen Stand (Epoche 1, Revision 9 — ein Dokument, das diese Datenbank nie
     * gespeichert hat) ist keine Quittung: kein Zielstand, kein Quittungs-Stand, keine erneute Rückspiel-Marke.
     * Die Box bekommt ihr Dokument über die retained Nachricht bzw. {@code erneutSenden} noch einmal.
     */
    @Test
    void epocheNachRueckspielenEineQuittungDerAltenEpocheIstKeineQuittung() throws Exception {
        Welt w = ahrenberg(Stufe.ANTEILE_AKTIV);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        quittung(w, w.e1(), 1, 1, "angenommen", null, null);
        quittung(w, w.e1(), 1, 2, "angenommen", null, null);
        quittung(w, w.e4(), 1, 2, "angenommen", null, null);
        quittung(w, w.e1(), 1, 2, "abgelehnt", "revision_aelter", "{\"epoche\":1,\"revision\":9}");
        herzschlag.merke(w.anlage(), w.e1(), mapper.readTree("""
                {"rolle":"fuehrt","anteile_epoche":1,"anteile_revision":9,"anteile_kw":{"einspeisung":10.0,"bezug":0.0}}"""));
        herzschlag.merke(w.anlage(), w.e4(), mapper.readTree("""
                {"rolle":"steuert_mit","anteile_epoche":1,"anteile_revision":9,
                 "anteile_kw":{"einspeisung":90.0,"bezug":77.0}}"""));
        TenantContext.set(w.mandant());
        Ergebnis e2 = dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        assertThat(e2.dokument().epoche()).isEqualTo(2);
        assertThat(e2.dokument().verengteBoxen()).containsExactly(w.e4().toString());
        long revision = e2.dokument().revision();

        // E-4 meldet verspätet ihren alten Stand an
        quittung(w, w.e4(), 1, 9, "angenommen", null, null);
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().revision()).as("kein Zielstand").isEqualTo(revision);
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.UEBERGANG);
        assertThat(quittiert(w.e4())).as("der alte Stand zählt nicht als Quittung").containsExactly(1L, 2L);
        assertThat(anteile.rueckgespieltErkannt(w.verbund())).isEmpty();

        leer();
        TenantContext.set(w.mandant());
        assertThat(dienst.erneutSenden(w.anlage())).contains(w.e4());
        synchronized (Draht.GESENDET) {
            assertThat(Draht.GESENDET).allSatisfy(x -> assertThat(epocheRevision(x.getValue()))
                    .containsExactly(2L, revision));
        }

        quittung(w, w.e4(), 2, revision, "angenommen", null, null);
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.ZIEL);
        assertThat(letztes(w).dokument().epoche()).isEqualTo(2);
    }

    /** Ahrenberg in S3 mit Zielstand (Revision 2), beide quittiert. */
    private Welt zielstandQuittiert() {
        Welt w = ahrenberg(Stufe.ANTEILE_AKTIV);
        TenantContext.set(w.mandant());
        dienst.anteileScharfschalten(w.anlage(), BETREIBER);
        quittung(w, w.e1(), 1, 1, "angenommen", null, null);
        quittung(w, w.e1(), 1, 2, "angenommen", null, null);
        quittung(w, w.e4(), 1, 2, "angenommen", null, null);
        TenantContext.set(w.mandant());
        assertThat(letztes(w).dokument().schritt()).isEqualTo(Schritt.ZIEL);
        return w;
    }

    private void quittung(SteuerungsverbundAnteilDienst d, Welt w, UUID box, long epoche, long revision,
            String urteil) {
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", d, mapper);
        TenantContext.clear();
        assertThat(listener.handle(VerbundAnteileDokument.resultTopic(w.mandant(), w.anlage(), box),
                ergebnis(w.mandant(), w.anlage(), box, epoche, revision, urteil, null, null), Instant.now())).isTrue();
    }

    private static List<Long> quittiert(UUID box) {
        Map<String, Object> m = root.queryForMap("SELECT quittiert_epoche, quittiert_revision FROM "
                + "steuerungsverbund_mitglied WHERE device_id = ? AND aufgehoben_am IS NULL", box);
        return java.util.Arrays.asList((Long) m.get("quittiert_epoche"), (Long) m.get("quittiert_revision"));
    }

    private List<Long> epocheRevision(byte[] nutzlast) {
        try {
            JsonNode n = mapper.readTree(nutzlast);
            return List.of(n.path("epoche").asLong(), n.path("revision").asLong());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private Welt ahrenberg(Stufe stufe) {
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
                t, an, "10.0." + nr + ".2:502");
        TenantContext.set(t);
        UUID v = verbuende.einrichten(t, an, "test");
        verbuende.stufeSetzen(v, stufe);
        Instant ab = Instant.parse("2026-01-01T00:00:00Z");
        UUID m1 = verbuende.mitgliedAufnehmen(t, v, e1, Rolle.FUEHRT, dq2, ab, null, "test");
        UUID m4 = verbuende.mitgliedAufnehmen(t, v, e4, Rolle.STEUERT_MIT, null, ab, null, "test");
        Welt w = new Welt(t, an, v, e1, e4, m1, m4);
        anteile.vorbehaltSetzen(v, BigDecimal.ZERO, new BigDecimal("473"), "betreiber@voltpilot.test");
        geraet(w, e1, "pv-generation", Grenzart.EINSPEISUNG, "100", "40");
        geraet(w, e1, "battery-hybrid", Grenzart.BEZUG, "100", "0");
        geraet(w, e4, "pv-generation", Grenzart.EINSPEISUNG, "60", null);
        for (int i = 0; i < 6; i++) {
            geraet(w, e4, "wallbox", Grenzart.BEZUG, "22", "4.1");
        }
        TenantContext.clear();
        return w;
    }

    private void geraet(Welt w, UUID box, String rolle, Grenzart richtung, String nenn, String rueckfall) {
        UUID k = komponente(w, rolle);
        anteile.geraetEintragen(w.mandant(), w.verbund(), box, k, richtung, new BigDecimal(nenn), true, null, "test");
        if (rueckfall != null) {
            rueckfaelle.hinterlegen(k, richtung, new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, new BigDecimal(rueckfall),
                    60), null, "installateur@ahrenberg.test");
        }
    }

    private static UUID komponente(Welt w, String rolle) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, created_at) "
                + "VALUES (?, ?, ?, '2026-01-01T00:00:00Z') RETURNING id", UUID.class, w.mandant(), w.anlage(), rolle);
    }

    private static UUID k1(Welt w) {
        return root.queryForObject("SELECT entity_id FROM steuerungsverbund_geraet WHERE device_id = ? "
                + "AND richtung = 'einspeisung' ORDER BY created_at, id LIMIT 1", UUID.class, w.e1());
    }

    private void quittung(Welt w, UUID box, long epoche, long revision, String urteil, String grund, String wirksam) {
        VerbundAnteileResultListener listener = new VerbundAnteileResultListener("tcp://nie:1883", "", "", dienst,
                mapper);
        TenantContext.clear();
        assertThat(listener.handle(VerbundAnteileDokument.resultTopic(w.mandant(), w.anlage(), box),
                ergebnis(w.mandant(), w.anlage(), box, epoche, revision, urteil, grund, wirksam), Instant.now()))
                .isTrue();
    }

    private static byte[] ergebnis(UUID t, UUID s, UUID box, long epoche, long revision, String urteil, String grund,
            String wirksam) {
        return ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + t + "\",\"site_id\":\"" + s + "\",\"device_id\":\""
                + box + "\",\"epoche\":" + epoche + ",\"revision\":" + revision + ",\"urteil\":\"" + urteil + "\""
                + (grund == null ? "" : ",\"grund\":\"" + grund + "\"")
                + (wirksam == null ? "" : ",\"wirksam\":" + wirksam)
                + ",\"ts\":\"2027-10-20T09:00:05Z\"}").getBytes(StandardCharsets.UTF_8);
    }

    private Ergebnis letztes(Welt w) {
        TenantContext.set(w.mandant());
        return new Ergebnis(null, anteile.dokumente(w.verbund()).get(0), List.of());
    }

    private static BigDecimal kw(Ergebnis e, Grenzart r, UUID box) {
        return e.dokument().tabelle().anteile().get(r).get(box.toString());
    }

    private static BigDecimal summe(Ergebnis e, Grenzart r) {
        return e.dokument().tabelle().anteile().get(r).values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private List<String> topics() {
        synchronized (Draht.GESENDET) {
            return Draht.GESENDET.stream().map(Map.Entry::getKey).toList();
        }
    }

    private static boolean recht(String rolle, String tabelle, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                tabelle, recht));
    }

    @SuppressWarnings("unused")
    private JsonNode json(byte[] b) throws Exception {
        return mapper.readTree(b);
    }
}
