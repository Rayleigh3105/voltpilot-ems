package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.BoxMetrikRepository;
import com.voltpilot.api.repo.BoxMetrikRepository.Box;
import com.voltpilot.api.repo.BoxMetrikRepository.Mitglied;
import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository.ArbeitslisteStand;
import com.voltpilot.api.repo.UemsMetricsRepository.MesskundeEingang;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mock.env.MockEnvironment;

/**
 * AP-15 IP-11 (NW-9): die Box-Metriken aus dem ECHTEN Scrape-Rumpf — das SQL ist hier weggeattrappt,
 * es steht in {@code GemeinsameSteuerungMetrikDbTest}. Geprüft wird, woran eine Regel von Teil B
 * hängt: Name, Labels, und wann eine Zeile FEHLT; dazu der Bestandsschutz — ohne betroffene Box und
 * mit abgeschaltetem Schalter ist der Export byte-gleich wie vorher.
 */
class GemeinsameSteuerungMetrikScrapeTest {

    private static final Instant JETZT = Instant.parse("2027-06-15T10:20:00Z");
    private static final Clock UHR = Clock.fixed(JETZT, ZoneOffset.UTC);
    private static final UUID TENANT = UUID.fromString("15000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("15000000-0000-0000-0000-000000000002");
    private static final UUID HALLE1 = UUID.fromString("15000000-0000-0000-0000-0000000000e1");
    private static final UUID VERWALTUNG = UUID.fromString("15000000-0000-0000-0000-0000000000e4");
    private static final String LABELS_HALLE1 =
            "{device=\"" + HALLE1 + "\",site=\"" + SITE + "\",tenant=\"" + TENANT + "\"}";

    /** Zählt jede Abfrage und merkt sich die Boxen mit Block — die Naht für „ein Scrape fragt nie“. */
    private static final class Attrappe extends BoxMetrikRepository {
        final AtomicInteger abfragen = new AtomicInteger();
        final AtomicReference<Collection<UUID>> mitBlock = new AtomicReference<>();
        private final List<Box> boxen;

        Attrappe(List<Box> boxen) {
            super(null);
            this.boxen = boxen;
        }

        @Override
        public List<Box> boxen(Collection<UUID> mitBlock) {
            abfragen.incrementAndGet();
            this.mitBlock.set(mitBlock);
            return boxen;
        }
    }

    /**
     * R11 zum Zeitpunkt 10:20: Halle 1 hat Plan 10:15 angenommen; Verwaltung hat 10:15 veröffentlicht
     * bekommen, aber nur 10:00 angenommen, und seit dem Start dieses Prozesses keinen Herzschlag.
     */
    private static final List<Box> R11 = List.of(
            new Box(HALLE1, TENANT, SITE, JETZT.minusSeconds(20), true,
                    Instant.parse("2027-06-15T10:15:00Z"), Instant.parse("2027-06-15T10:15:00Z")),
            new Box(VERWALTUNG, TENANT, SITE, null, true,
                    Instant.parse("2027-06-15T10:15:00Z"), Instant.parse("2027-06-15T10:00:00Z")));

    private static GemeinsameSteuerungHerzschlag halterMitHalle1(String einspeisung) throws Exception {
        GemeinsameSteuerungHerzschlag halter = new GemeinsameSteuerungHerzschlag();
        halter.merke(HALLE1, new ObjectMapper().readTree(
                "{\"plan_id\":\"" + UUID.randomUUID() + "\",\"waechter\":{\"einspeisung\":\"" + einspeisung + "\"}}"));
        return halter;
    }

    private static String scrape(PrometheusMeterRegistry registry, GemeinsameSteuerungMetrikSammler sammler) {
        sammler.collect();
        return registry.scrape();
    }

    @Test
    void eineBoxMitPlan20UndQuittungMeldetAlleWerte() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        GemeinsameSteuerungHerzschlag halter = halterMitHalle1("sicherheitskappe");
        Attrappe repo = new Attrappe(R11);

        String scrape = scrape(registry, new GemeinsameSteuerungMetrikSammler(repo, halter, registry, UHR));

        assertThat(repo.mitBlock.get()).as("die Boxen mit Block gehen in die Abfrage").containsExactly(HALLE1);
        assertThat(scrape).contains("voltpilot_uems_box_herzschlag_age_seconds" + LABELS_HALLE1 + " 20.0");
        assertThat(scrape).contains(
                "voltpilot_uems_box_herzschlag_zustand{device=\"" + HALLE1 + "\",site=\"" + SITE
                        + "\",tenant=\"" + TENANT + "\",zustand=\"bekannt\"} 1.0");
        assertThat(scrape).contains("voltpilot_uems_box_plan_veroeffentlicht_age_seconds" + LABELS_HALLE1 + " 300.0");
        assertThat(scrape).contains("voltpilot_uems_box_plan_angenommen_age_seconds" + LABELS_HALLE1 + " 300.0");
        assertThat(scrape).contains("voltpilot_uems_box_plan_quittung_gemeldet" + LABELS_HALLE1 + " 1.0");
        assertThat(scrape).contains("voltpilot_uems_box_waechter_stufe{device=\"" + HALLE1
                + "\",richtung=\"einspeisung\",site=\"" + SITE + "\",stufe=\"sicherheitskappe\",tenant=\""
                + TENANT + "\"} 1.0");
        assertThat(scrape).contains("voltpilot_uems_box_waechter_stufe{device=\"" + HALLE1
                + "\",richtung=\"einspeisung\",site=\"" + SITE + "\",stufe=\"regelt\",tenant=\""
                + TENANT + "\"} 0.0");
        assertThat(scrape).as("bezug sendet die Box nicht - keine erfundene Reihe").doesNotContain("richtung=\"bezug\"");
    }

    /** R11: der Betreiber sieht „erzeugt 10:15 · angenommen 10:00“ — 900 s Abstand der beiden Alter. */
    @Test
    void r11VeroeffentlichtGegenAngenommenUndNieEinHerzschlag() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);

        String scrape = scrape(registry,
                new GemeinsameSteuerungMetrikSammler(new Attrappe(R11), halterMitHalle1("regelt"), registry, UHR));

        String v = "{device=\"" + VERWALTUNG + "\",site=\"" + SITE + "\",tenant=\"" + TENANT + "\"}";
        assertThat(scrape).contains("voltpilot_uems_box_plan_veroeffentlicht_age_seconds" + v + " 300.0");
        assertThat(scrape).contains("voltpilot_uems_box_plan_angenommen_age_seconds" + v + " 1200.0");
        assertThat(scrape).as("nie ein Herzschlag: kein Alter, aber sichtbar")
                .doesNotContain("voltpilot_uems_box_herzschlag_age_seconds" + v);
        assertThat(scrape).contains("voltpilot_uems_box_herzschlag_zustand{device=\"" + VERWALTUNG + "\",site=\""
                + SITE + "\",tenant=\"" + TENANT + "\",zustand=\"nie\"} 1.0");
        assertThat(scrape).as("ohne Block keine Wächter-Reihe")
                .doesNotContain("voltpilot_uems_box_waechter_stufe{device=\"" + VERWALTUNG);
    }

    @Test
    void eineAlteBoxOhneQuittungMeldetNullUndKeinAngenommen() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        List<Box> alt = List.of(new Box(HALLE1, TENANT, SITE, JETZT.minusSeconds(30), false,
                JETZT.minusSeconds(60), null));

        String scrape = scrape(registry,
                new GemeinsameSteuerungMetrikSammler(new Attrappe(alt), new GemeinsameSteuerungHerzschlag(), registry, UHR));

        assertThat(scrape).contains("voltpilot_uems_box_plan_quittung_gemeldet" + LABELS_HALLE1 + " 0.0");
        assertThat(scrape).doesNotContain("voltpilot_uems_box_plan_angenommen_age_seconds");
    }

    /** Das Alter wächst zwischen zwei Sammel-Läufen weiter — ein Scrape fragt nie die Datenbank. */
    @Test
    void einScrapeFragtNieUndDasAlterWaechstWeiter() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        Clock[] uhr = {UHR};
        Attrappe repo = new Attrappe(R11);
        GemeinsameSteuerungMetrikSammler sammler = new GemeinsameSteuerungMetrikSammler(repo,
                halterMitHalle1("regelt"), registry, new Clock() {
                    @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
                    @Override public Clock withZone(java.time.ZoneId zone) { return this; }
                    @Override public Instant instant() { return uhr[0].instant(); }
                });
        sammler.collect();
        uhr[0] = Clock.offset(UHR, java.time.Duration.ofSeconds(100));

        String scrape = registry.scrape();
        registry.scrape();

        assertThat(repo.abfragen).hasValue(1);
        assertThat(scrape).contains("voltpilot_uems_box_herzschlag_age_seconds" + LABELS_HALLE1 + " 120.0");
    }

    /** Ohne Mitgliedschaft keine Rolle und keine Anteils-Revision — auch nicht als 0. */
    @Test
    void ohneMitgliedschaftKeineRolleUndKeineRevision() throws Exception {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);

        String scrape = scrape(registry,
                new GemeinsameSteuerungMetrikSammler(new Attrappe(R11), halterMitHalle1("regelt"), registry, UHR));

        assertThat(scrape).doesNotContain("voltpilot_uems_box_anteile").doesNotContain("voltpilot_uems_box_rolle");
    }

    /**
     * R12 (A10): Revision 4 gesendet vor 40 min, quittiert ist 3 — die Box hat nicht bestätigt. Die
     * führende Box hat bestätigt und meldet kein Alter.
     */
    @Test
    void einMitgliedMeldetRolleStufeUndUnbestaetigteAnteile() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        Instant gesendet = JETZT.minusSeconds(2400);
        List<Box> boxen = List.of(
                new Box(HALLE1, TENANT, SITE, JETZT.minusSeconds(20), true, null, null,
                        new Mitglied("fuehrt", "anteile_aktiv", 2L, 4L, gesendet, 2L, 4L)),
                new Box(VERWALTUNG, TENANT, SITE, JETZT.minusSeconds(20), true, null, null,
                        new Mitglied("steuert_mit", "anteile_aktiv", 2L, 4L, gesendet, 2L, 3L)));

        String scrape = scrape(registry, new GemeinsameSteuerungMetrikSammler(new Attrappe(boxen),
                new GemeinsameSteuerungHerzschlag(), registry, UHR));

        assertThat(scrape).contains("voltpilot_uems_box_rolle{device=\"" + HALLE1 + "\",rolle=\"fuehrt\",site=\""
                + SITE + "\",stufe=\"anteile_aktiv\",tenant=\"" + TENANT + "\"} 1.0");
        assertThat(scrape).contains("voltpilot_uems_box_rolle{device=\"" + HALLE1 + "\",rolle=\"steuert_mit\",site=\""
                + SITE + "\",stufe=\"anteile_aktiv\",tenant=\"" + TENANT + "\"} 0.0");
        String v = "device=\"" + VERWALTUNG + "\",epoche=\"2\",site=\"" + SITE + "\",tenant=\"" + TENANT + "\"}";
        assertThat(scrape).contains("voltpilot_uems_box_anteile_revision_gesendet{" + v + " 4.0");
        assertThat(scrape).contains("voltpilot_uems_box_anteile_revision_quittiert{" + v + " 3.0");
        assertThat(scrape).contains("voltpilot_uems_box_anteile_unbestaetigt_age_seconds{device=\"" + VERWALTUNG
                + "\",site=\"" + SITE + "\",tenant=\"" + TENANT + "\"} 2400.0");
        assertThat(scrape).as("bestätigt: kein Alter")
                .doesNotContain("voltpilot_uems_box_anteile_unbestaetigt_age_seconds{device=\"" + HALLE1);
    }

    /** Eine neue Epoche mit kleinerer Revision ist trotzdem unbestätigt, solange die alte quittiert ist. */
    @Test
    void unbestaetigtVergleichtEpocheVorRevision() {
        Instant t = JETZT;
        assertThat(GemeinsameSteuerungMetrikSammler.unbestaetigt(new Mitglied("steuert_mit", "anteile_aktiv",
                3L, 1L, t, 2L, 7L))).isTrue();
        assertThat(GemeinsameSteuerungMetrikSammler.unbestaetigt(new Mitglied("steuert_mit", "anteile_aktiv",
                3L, 1L, t, 3L, 1L))).isFalse();
        assertThat(GemeinsameSteuerungMetrikSammler.unbestaetigt(new Mitglied("steuert_mit", "erklaert",
                null, null, null, null, null))).as("nie gesendet").isFalse();
        assertThat(GemeinsameSteuerungMetrikSammler.unbestaetigt(new Mitglied("steuert_mit", "anteile_aktiv",
                0L, 0L, t, null, null))).as("nie quittiert").isTrue();
    }

    // --- Bestandsschutz --------------------------------------------------------------------------

    /**
     * Ohne betroffene Box ist der Export byte-gleich wie vorher: derselbe Aufbau der übrigen
     * UEMS-Metriken, einmal mit und einmal ohne den neuen Sammler, liefert denselben Rumpf.
     */
    @Test
    void ohneBetroffeneBoxIstDerExportByteGleich() {
        String vorher = uemsExport(false);
        String nachher = uemsExport(true);

        assertThat(nachher).isEqualTo(vorher);
        assertThat(nachher).as("die übrigen UEMS-Metriken stehen darin").contains("voltpilot_uems_arbeitsliste_offen");
    }

    private static String uemsExport(boolean mitSammler) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        UemsLaeuferMelder melder = new UemsLaeuferMelder(registry);
        UemsMetricsRepository uems = new UemsMetricsRepository(null) {
            @Override public List<ArbeitslisteStand> arbeitslisten() {
                return List.of(new ArbeitslisteStand("viertelstunde", 0L, null));
            }
            @Override public List<MesskundeEingang> messkundenEingaenge() {
                return List.of();
            }
        };
        new UemsMetricsCollector(uems, melder, new MockEnvironment(), registry, UHR).collect();
        if (mitSammler) {
            new GemeinsameSteuerungMetrikSammler(new Attrappe(List.of()), new GemeinsameSteuerungHerzschlag(),
                    registry, UHR).collect();
        }
        return registry.scrape();
    }

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {
        @Bean
        BoxMetrikRepository boxMetrikRepository() {
            return new Attrappe(List.of());
        }

        @Bean
        PrometheusMeterRegistry registry() {
            return new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, GemeinsameSteuerungHerzschlag.class,
                    GemeinsameSteuerungMetrikSammler.class);

    /** Der vorhandene UEMS-Schalter nimmt Sammler UND Halter; ohne Halter überliest der Zuhörer den Block. */
    @Test
    void derUemsSchalterNimmtSammlerUndHalter() {
        runner.withPropertyValues("voltpilot.metrics.uems.enabled=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(GemeinsameSteuerungMetrikSammler.class);
            assertThat(context).doesNotHaveBean(GemeinsameSteuerungHerzschlag.class);
            assertThat(context.getBean(PrometheusMeterRegistry.class).scrape()).isEmpty();
        });
        // Der Testlauf setzt den Schalter global auf false (surefire) - AN darum ausdrücklich.
        runner.withPropertyValues("voltpilot.metrics.uems.enabled=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(GemeinsameSteuerungMetrikSammler.class);
            assertThat(context).hasSingleBean(GemeinsameSteuerungHerzschlag.class);
        });
    }

    @Test
    void einBlockOhneObjektOderMitFremdemWortErfindetNichts() throws Exception {
        GemeinsameSteuerungHerzschlag halter = new GemeinsameSteuerungHerzschlag();
        ObjectMapper json = new ObjectMapper();

        halter.merke(HALLE1, json.readTree("{\"plan_id\":\"kaputt\",\"waechter\":{\"einspeisung\":\"REGELT\"}}"));
        assertThat(halter.block(HALLE1).planId()).isNull();
        assertThat(halter.block(HALLE1).waechter()).isEmpty();

        halter.merke(HALLE1, json.readTree("[]"));
        assertThat(halter.boxen()).isEqualTo(Set.of());
    }
}
