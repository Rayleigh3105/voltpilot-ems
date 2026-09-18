package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository.ArbeitslisteStand;
import com.voltpilot.api.repo.UemsMetricsRepository.MesskundeEingang;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/**
 * AP-14 IP-9: jede Metrik der UEMS-Betriebsüberwachung (§3.5) aus dem ECHTEN Scrape-Rumpf gelesen —
 * das SQL ist hier bewusst wegattrappt, es steht in {@code UemsMetricsDbTest}.
 *
 * <p>Geprüft wird je Metrik genau das, woran eine Alarm-Regel des gitops-Repos (IP-10) hängt: der
 * NAME, die Labels, und wann eine Zeile FEHLT — ein abgeschalteter oder seit dem Start nie gelaufener
 * Läufer darf keinen Alterswert und damit keinen Daueralarm „steht“ erzeugen, und ein Messkunde ohne
 * jeden Messwert ist trotzdem sichtbar.
 */
class UemsMetricsScrapeTest {

    private static final Instant JETZT = Instant.parse("2026-09-18T12:00:00Z");
    private static final Clock UHR = Clock.fixed(JETZT, ZoneOffset.UTC);
    private static final UUID MESSKUNDE = UUID.fromString("71000000-0000-0000-0000-000000000009");
    private static final UUID OHNE_WERTE = UUID.fromString("71000000-0000-0000-0000-000000000010");

    /** Zählt jede Abfrage — die Naht für „ein Scrape löst keine Abfrage aus“. */
    private static final class ZaehlendesRepo extends UemsMetricsRepository {
        final AtomicInteger abfragen = new AtomicInteger();
        private final List<ArbeitslisteStand> listen;
        private final List<MesskundeEingang> messkunden;

        ZaehlendesRepo(List<ArbeitslisteStand> listen, List<MesskundeEingang> messkunden) {
            super(null);
            this.listen = listen;
            this.messkunden = messkunden;
        }

        @Override
        public List<ArbeitslisteStand> arbeitslisten() {
            abfragen.incrementAndGet();
            return listen;
        }

        @Override
        public List<MesskundeEingang> messkundenEingaenge() {
            abfragen.incrementAndGet();
            return messkunden;
        }
    }

    private static final List<ArbeitslisteStand> LISTEN = List.of(
            new ArbeitslisteStand("viertelstunde", 7L, JETZT.minusSeconds(1800)),
            new ArbeitslisteStand("tag", 0L, null),
            new ArbeitslisteStand("periode", 3L, JETZT.minusSeconds(60)));

    private static final List<MesskundeEingang> MESSKUNDEN = List.of(
            new MesskundeEingang(MESSKUNDE, JETZT.minusSeconds(120)),
            new MesskundeEingang(OHNE_WERTE, null));

    private record Aufbau(PrometheusMeterRegistry registry, UemsLaeuferMelder melder,
            UemsMetricsCollector sammler, ZaehlendesRepo repo) {

        String scrape() {
            sammler.collect();
            return registry.scrape();
        }
    }

    private static Aufbau aufbau(String... schalter) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        MockEnvironment umgebung = new MockEnvironment();
        for (int i = 0; i < schalter.length; i += 2) {
            umgebung.setProperty(schalter[i], schalter[i + 1]);
        }
        UemsLaeuferMelder melder = new UemsLaeuferMelder(registry);
        melder.uhrStellen(UHR);
        ZaehlendesRepo repo = new ZaehlendesRepo(LISTEN, MESSKUNDEN);
        return new Aufbau(registry, melder,
                new UemsMetricsCollector(repo, melder, umgebung, registry, UHR), repo);
    }

    // --- (1) Arbeitslisten ---------------------------------------------------------------------

    @Test
    void arbeitslisteMeldetOffeneZahlUndAlterDesAeltestenEintrags() {
        String scrape = aufbau().scrape();

        assertThat(scrape).contains("voltpilot_uems_arbeitsliste_offen{liste=\"viertelstunde\"} 7.0");
        assertThat(scrape).contains("voltpilot_uems_arbeitsliste_offen{liste=\"tag\"} 0.0");
        assertThat(scrape).contains("voltpilot_uems_arbeitsliste_offen{liste=\"periode\"} 3.0");
        assertThat(scrape).contains(
                "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste=\"viertelstunde\"} 1800.0");
        assertThat(scrape).contains(
                "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste=\"periode\"} 60.0");
    }

    @Test
    void eineLeereArbeitslisteHatKeinAlterStattAlterNull() {
        String scrape = aufbau().scrape();

        // Alter 0 hiesse "gerade eben eingetragen" - eine leere Liste sagt `offen = 0`, sonst nichts.
        assertThat(scrape).doesNotContain(
                "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste=\"tag\"}");
    }

    // --- (2) Läufer ----------------------------------------------------------------------------

    @Test
    void einGelaufenerLaeuferMeldetAlterUndZustandGelaufen() {
        Aufbau a = aufbau();
        a.melder().gelaufen(UemsLaeuferMelder.VIERTELSTUNDE);

        String scrape = a.scrape();

        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"viertelstunde\"} 0.0");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"viertelstunde\",zustand=\"gelaufen\"} 1.0");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"viertelstunde\",zustand=\"nie\"} 0.0");
    }

    @Test
    void einSeitDemStartNieGelaufenerLaeuferErfindetKeinAlterNull() {
        String scrape = aufbau().scrape();

        assertThat(scrape).doesNotContain(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"kaskade\"}");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"kaskade\",zustand=\"nie\"} 1.0");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"kaskade\",zustand=\"gelaufen\"} 0.0");
    }

    @Test
    void einAbgeschalteterLaeuferExportiertKeinAlterUndKannNichtStehen() {
        Aufbau a = aufbau("voltpilot.uems.ersatzwert.enabled", "false");
        a.melder().gelaufen(UemsLaeuferMelder.ERSATZWERT);

        String scrape = a.scrape();

        assertThat(scrape).doesNotContain(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"ersatzwert\"}");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"ersatzwert\",zustand=\"aus\"} 1.0");
    }

    @Test
    void derStrukturLaeuferIstAusSobaldEinerSeinerBeidenSchalterAusIst() {
        String scrape = aufbau("voltpilot.uems.berichte.enabled", "false").scrape();

        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"bericht_struktur\",zustand=\"aus\"} 1.0");
    }

    @Test
    void derLueckenMelderTraegtGenauDenLabelWertDerRegel() {
        Aufbau a = aufbau();
        a.melder().gelaufen(UemsLaeuferMelder.LUECKEN);

        // VoltPilotLueckenMelderSteht haengt Zeichen fuer Zeichen an diesem Label-Wert.
        assertThat(a.scrape()).contains(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"luecken\"} 0.0");
    }

    @Test
    void derFehlerzaehlerStehtVonAnfangAnAufNullUndZaehltDann() {
        Aufbau a = aufbau();
        assertThat(a.scrape()).contains("voltpilot_uems_laeufer_fehler_total{laeufer=\"luecken\"} 0.0");

        a.melder().fehler(UemsLaeuferMelder.LUECKEN);
        a.melder().fehler(UemsLaeuferMelder.LUECKEN);

        assertThat(a.scrape()).contains("voltpilot_uems_laeufer_fehler_total{laeufer=\"luecken\"} 2.0");
    }

    @Test
    void jederLaeuferDesKatalogsHatGenauEinenAktivenZustand() {
        String scrape = aufbau().scrape();

        for (UemsLaeuferMelder.Eintrag e : UemsLaeuferMelder.KATALOG) {
            assertThat(scrape).as("Fehlerzaehler von %s", e.label())
                    .contains("voltpilot_uems_laeufer_fehler_total{laeufer=\"" + e.label() + "\"} 0.0");
            long aktiv = scrape.lines()
                    .filter(l -> l.startsWith("voltpilot_uems_laeufer_zustand{laeufer=\"" + e.label() + "\","))
                    .filter(l -> l.endsWith(" 1.0")).count();
            assertThat(aktiv).as("genau ein aktiver Zustand von %s", e.label()).isEqualTo(1);
        }
    }

    // --- (3) Dateneingang je Messkunde ---------------------------------------------------------

    @Test
    void derMesskundeMeldetDasAlterSeinesJuengstenEingangsUnterSeinerInternenKennung() {
        String scrape = aufbau().scrape();

        assertThat(scrape).contains("voltpilot_uems_kundenbereich_letzter_messwert_age_seconds{tenant=\""
                + MESSKUNDE + "\"} 120.0");
        assertThat(scrape).contains("voltpilot_uems_kundenbereich_messwert_zustand{tenant=\""
                + MESSKUNDE + "\",zustand=\"bekannt\"} 1.0");
    }

    @Test
    void einMesskundeOhneJedenMesswertHatKeinAlterBleibtAberSichtbar() {
        String scrape = aufbau().scrape();

        assertThat(scrape).doesNotContain("voltpilot_uems_kundenbereich_letzter_messwert_age_seconds{tenant=\""
                + OHNE_WERTE + "\"}");
        assertThat(scrape).contains("voltpilot_uems_kundenbereich_messwert_zustand{tenant=\""
                + OHNE_WERTE + "\",zustand=\"nie\"} 1.0");
    }

    // --- (4) Bestands-Läufer -------------------------------------------------------------------

    @Test
    void dieBestandsLaeuferZaehlenKundenbereicheJeErgebnisUndMeldenZugleichIhrenLauf() {
        Aufbau a = aufbau();
        a.melder().bestandGelaufen(UemsLaeuferMelder.BESTAND_STANDORT, 5, 1);
        a.melder().bestandGelaufen(UemsLaeuferMelder.BESTAND_FUNKTION, 5, 0);

        String scrape = a.scrape();

        assertThat(scrape).contains("voltpilot_uems_bestandslaeufer_total{ergebnis=\"erledigt\","
                + "laeufer=\"bestand_standort\"} 4.0");
        assertThat(scrape).contains("voltpilot_uems_bestandslaeufer_total{ergebnis=\"fehler\","
                + "laeufer=\"bestand_standort\"} 1.0");
        // Auch ohne Fehler steht die Reihe da - eine fehlende Reihe ist fuer eine Regel nicht 0.
        assertThat(scrape).contains("voltpilot_uems_bestandslaeufer_total{ergebnis=\"fehler\","
                + "laeufer=\"bestand_funktion\"} 0.0");
        assertThat(scrape).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"bestand_standort\",zustand=\"gelaufen\"} 1.0");
    }

    // --- (5) Melden darf nie einen Lauf brechen ------------------------------------------------

    @Test
    void derStummeMelderUndEinUnbekannterLaeuferWerfenNie() {
        // Genau die zwei Lagen, in denen ein Laeufer sonst mitten im Lauf abbraeche: ein direkt
        // gebauter Laeufer ohne Spring (STUMM) und ein Label, das im Katalog fehlt.
        UemsLaeuferMelder.STUMM.gelaufen(UemsLaeuferMelder.VIERTELSTUNDE);
        UemsLaeuferMelder.STUMM.fehler(UemsLaeuferMelder.VIERTELSTUNDE);
        UemsLaeuferMelder.STUMM.bestandGelaufen(UemsLaeuferMelder.BESTAND_RECHTE, 1, 0);

        Aufbau a = aufbau();
        a.melder().gelaufen("gibt-es-nicht");
        a.melder().fehler("gibt-es-nicht");

        // Und der unbekannte Laeufer erscheint auch nicht im Export - der Katalog bleibt die Liste.
        assertThat(a.scrape()).doesNotContain("gibt-es-nicht");
    }

    // --- (6) Die zwei Zusagen des Musters ------------------------------------------------------

    @Test
    void keinScrapeLoestEineAbfrageAus() {
        Aufbau a = aufbau();
        a.sammler().collect();
        int nachEinemSammeln = a.repo().abfragen.get();

        for (int i = 0; i < 5; i++) {
            a.registry().scrape();
        }

        assertThat(nachEinemSammeln).isEqualTo(2);
        assertThat(a.repo().abfragen.get()).as("fuenf Scrapes, keine weitere Abfrage")
                .isEqualTo(nachEinemSammeln);
    }

    @Test
    void keinKundenNameKeineMailKeineSeriennummerInIrgendeinerUemsZeile() {
        Aufbau a = aufbau();
        a.melder().gelaufen(UemsLaeuferMelder.LUECKEN);
        a.melder().bestandGelaufen(UemsLaeuferMelder.BESTAND_RECHTE, 2, 0);

        List<String> uems = a.scrape().lines()
                .filter(l -> l.startsWith("voltpilot_uems_")).toList();

        assertThat(uems).isNotEmpty();
        for (String zeile : uems) {
            assertThat(zeile).as("Label-Namen der Zeile %s", zeile)
                    .doesNotContain("name=").doesNotContain("kunde=").doesNotContain("email=")
                    .doesNotContain("mail=").doesNotContain("serial=").doesNotContain("seriennummer=")
                    .doesNotContain("adresse=").doesNotContain("anlage=").doesNotContain("box=");
        }
        // Das EINZIGE Label mit Kundenbezug ist die interne Kennung.
        assertThat(uems).anyMatch(l -> l.contains("tenant=\"" + MESSKUNDE + "\""));
    }
}
