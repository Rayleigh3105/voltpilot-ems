package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.UemsLaeuferMelder.Eintrag;
import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.repo.UemsMetricsRepository.ArbeitslisteStand;
import com.voltpilot.api.repo.UemsMetricsRepository.MesskundeEingang;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * AP-14 IP-9: die Betriebsüberwachung des UEMS (§3.5) — Verarbeitung, Läufer, Wächter über den
 * Wächter, Dateneingang je Messkunde, Übernahme.
 *
 * <p><b>Das Muster ist {@link DbStorageMetricsCollector}: gesammelt wird im eigenen Takt, ein
 * Prometheus-Scrape führt NIEMALS SQL aus.</b> Was der Scrape ausrechnet, ist ausschließlich
 * Arithmetik auf dem zuletzt gesammelten Zeitpunkt — darum wächst jedes Alter zwischen zwei
 * Sammel-Läufen weiter und steht nicht still. Genau das macht auch einen ausgefallenen SAMMLER
 * sichtbar, ohne dass es dafür eine eigene Metrik bräuchte: die Alter laufen weiter, die Regeln
 * feuern.
 *
 * <p><b>Nie ein Kundenname.</b> Das einzige Label mit Kundenbezug ist {@code tenant} und trägt die
 * INTERNE Kennung (UUID) — dieselbe Regel wie bei {@code voltpilot_db_table_bytes}.
 * {@code UemsMetricsExportTest} liest den ganzen Export zurück und belegt es.
 *
 * <p><b>Die Kardinalität ist klein und gewollt:</b> drei Arbeitslisten, dreizehn Läufer, ein Wert je
 * Messkunden-Kundenbereich. Keine Anlage, keine Box, keine Messstelle als Label.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true",
        matchIfMissing = true)
public class UemsMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(UemsMetricsCollector.class);

    /**
     * Die Metrik-NAMEN sind der Vertrag mit den Alarm-Regeln des gitops-Repos (IP-10) und stehen
     * wörtlich so hier, wie sie im Scrape stehen sollen — ohne Micrometer-{@code baseUnit}, damit die
     * Namenskonvention nichts anhängt. {@code UemsMetricsScrapeTest} liest sie aus dem ECHTEN
     * Scrape-Rumpf zurück; eine Umbenennung bricht dort, nicht erst in der Alarm-Regel.
     */
    public static final String ARBEITSLISTE_ALTER = "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds";

    /** Siehe {@link #ARBEITSLISTE_ALTER}. */
    public static final String ARBEITSLISTE_OFFEN = "voltpilot_uems_arbeitsliste_offen";

    /** Siehe {@link #ARBEITSLISTE_ALTER}. */
    public static final String LAEUFER_ALTER = "voltpilot_uems_laeufer_letzter_lauf_age_seconds";

    /**
     * Der Begleiter zu {@link #LAEUFER_ALTER}, nach dem Muster von
     * {@code voltpilot_site_telemetry_state}: 1 für den aktiven Zustand
     * {@code gelaufen} | {@code nie} | {@code aus}. Ohne ihn kann eine Regel „steht“ nicht von „ist
     * abgeschaltet“ und „lief seit dem Neustart noch nie“ unterscheiden — und ein abgeschalteter
     * Läufer soll gerade KEINEN Daueralarm erzeugen.
     */
    public static final String LAEUFER_ZUSTAND = "voltpilot_uems_laeufer_zustand";

    /** Siehe {@link #ARBEITSLISTE_ALTER}. */
    public static final String MESSWERT_ALTER = "voltpilot_uems_kundenbereich_letzter_messwert_age_seconds";

    /**
     * Der Begleiter zu {@link #MESSWERT_ALTER}: 1 für den aktiven Zustand {@code bekannt} |
     * {@code nie}. Ein frisch eingerichteter Messkunde, bei dem noch NIE etwas ankam, hat kein Alter
     * — ohne diese Zeile wäre er für die Regel {@code VoltPilotMesskundeOhneMesswerte} unsichtbar,
     * und das ist genau der Fall, den die Schicht „Dateneingang“ finden soll.
     */
    public static final String MESSWERT_ZUSTAND = "voltpilot_uems_kundenbereich_messwert_zustand";

    /** Der Läufer hat seit dem Start dieses Prozesses mindestens einmal fertig gemeldet. */
    public static final String GELAUFEN = "gelaufen";
    /** Der Läufer ist an, hat aber seit dem Start dieses Prozesses noch nie fertig gemeldet. */
    public static final String NIE = "nie";
    /** Der Läufer ist abgeschaltet — er kann nicht „stehen“. */
    public static final String AUS = "aus";
    /** Beim Messkunden ist schon einmal etwas angekommen. */
    public static final String BEKANNT = "bekannt";

    private final UemsMetricsRepository repo;
    private final UemsLaeuferMelder melder;
    private final Environment umgebung;
    private final Clock uhr;
    private final MultiGauge arbeitslisteAlter;
    private final MultiGauge arbeitslisteOffen;
    private final MultiGauge laeuferAlter;
    private final MultiGauge laeuferZustand;
    private final MultiGauge messwertAlter;
    private final MultiGauge messwertZustand;
    private boolean failing;

    /**
     * <b>Dieser Konstruktor MUSS {@code @Autowired} tragen</b> — bei mehreren Konstruktoren und keiner
     * Markierung kann Spring keinen wählen und sucht einen parameterlosen; genau daran ist schon
     * {@code BrokerAuthzReloader} beim Start abgestürzt (und dieser hier beim ersten Lauf von
     * {@code UemsMetricsEndpointE2eTest}).
     */
    @Autowired
    public UemsMetricsCollector(UemsMetricsRepository repo, UemsLaeuferMelder melder,
            Environment umgebung, MeterRegistry registry) {
        this(repo, melder, umgebung, registry, Clock.systemUTC());
    }

    /** Test-Naht mit steuerbarer Uhr. */
    UemsMetricsCollector(UemsMetricsRepository repo, UemsLaeuferMelder melder, Environment umgebung,
            MeterRegistry registry, Clock uhr) {
        this.repo = repo;
        this.melder = melder;
        this.umgebung = umgebung;
        this.uhr = uhr;
        this.arbeitslisteAlter = MultiGauge.builder(ARBEITSLISTE_ALTER)
                .description("Alter des aeltesten offenen Eintrags je Arbeitsliste, ueber alle"
                        + " Kundenbereiche; fehlt, wenn die Liste leer ist")
                .register(registry);
        this.arbeitslisteOffen = MultiGauge.builder(ARBEITSLISTE_OFFEN)
                .description("Offene Eintraege je Arbeitsliste, ueber alle Kundenbereiche")
                .register(registry);
        this.laeuferAlter = MultiGauge.builder(LAEUFER_ALTER)
                .description("Alter des letzten beendeten Laufs; fehlt, wenn der Laeufer aus ist oder"
                        + " seit dem Start nie lief - siehe voltpilot_uems_laeufer_zustand")
                .register(registry);
        this.laeuferZustand = MultiGauge.builder(LAEUFER_ZUSTAND)
                .description("1 fuer den aktiven Zustand: gelaufen | nie | aus")
                .register(registry);
        this.messwertAlter = MultiGauge.builder(MESSWERT_ALTER)
                .description("Alter des juengsten Mess-EINGANGS je Kundenbereich mit aktiver Funktion"
                        + " Messen; fehlt, wenn nie - siehe voltpilot_uems_kundenbereich_messwert_zustand")
                .register(registry);
        this.messwertZustand = MultiGauge.builder(MESSWERT_ZUSTAND)
                .description("1 fuer den aktiven Zustand: bekannt | nie")
                .register(registry);
    }

    /**
     * Ein Sammel-Lauf. Der Takt ist der billige 60-Sekunden-Takt von
     * {@link DbHealthMetricsCollector}, nicht der tägliche der Speicherklassen: die Schwellen aus
     * §3.5 liegen bei 15 und 30 Minuten, und die zwei Abfragen sind klein.
     */
    @Scheduled(fixedDelayString = "${voltpilot.metrics.uems.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.uems.initial-delay-ms:20000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("uems metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("uems metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("uems metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Sammelt einen Stand; paket-sichtbar für die Scrape- und DB-Tests. */
    void collect() {
        arbeitslisten();
        laeufer();
        messkunden();
    }

    private void arbeitslisten() {
        List<ArbeitslisteStand> staende = repo.arbeitslisten();
        List<MultiGauge.Row<?>> alter = new ArrayList<>(staende.size());
        List<MultiGauge.Row<?>> offen = new ArrayList<>(staende.size());
        for (ArbeitslisteStand s : staende) {
            Tags tags = Tags.of("liste", s.liste());
            offen.add(MultiGauge.Row.of(tags, s.offen()));
            // Eine leere Liste hat keinen aeltesten Eintrag - und kein Alter 0, das ein "frisch
            // abgearbeitet" vortaeuschen wuerde. `offen = 0` sagt bereits alles.
            if (s.aeltester() != null) {
                alter.add(MultiGauge.Row.of(tags, s.aeltester(), this::alterSekunden));
            }
        }
        arbeitslisteAlter.register(alter, true);
        arbeitslisteOffen.register(offen, true);
    }

    private void laeufer() {
        List<MultiGauge.Row<?>> alter = new ArrayList<>(UemsLaeuferMelder.KATALOG.size());
        List<MultiGauge.Row<?>> zustaende = new ArrayList<>(UemsLaeuferMelder.KATALOG.size() * 3);
        for (Eintrag e : UemsLaeuferMelder.KATALOG) {
            boolean an = angeschaltet(e);
            Instant letzter = an ? melder.letzterLauf(e.label()).orElse(null) : null;
            String zustand = !an ? AUS : letzter == null ? NIE : GELAUFEN;
            for (String moeglich : List.of(GELAUFEN, NIE, AUS)) {
                zustaende.add(MultiGauge.Row.of(
                        Tags.of("laeufer", e.label(), "zustand", moeglich),
                        moeglich.equals(zustand) ? 1d : 0d));
            }
            if (letzter != null) {
                alter.add(MultiGauge.Row.of(Tags.of("laeufer", e.label()), letzter, this::alterSekunden));
            }
        }
        laeuferAlter.register(alter, true);
        laeuferZustand.register(zustaende, true);
    }

    /**
     * Ein Läufer ist AN, wenn keine seiner Eigenschaften ausdrücklich {@code false} steht — dieselbe
     * Lesart wie {@code @ConditionalOnProperty(..., matchIfMissing = true)} an den Läufern selbst.
     * Der Struktur-Läufer hängt an zweien und ist aus, sobald eine aus ist.
     */
    private boolean angeschaltet(Eintrag e) {
        for (String schalter : e.schalter()) {
            if (!umgebung.getProperty(schalter, Boolean.class, Boolean.TRUE)) {
                return false;
            }
        }
        return true;
    }

    private void messkunden() {
        List<MesskundeEingang> eingaenge = repo.messkundenEingaenge();
        List<MultiGauge.Row<?>> alter = new ArrayList<>(eingaenge.size());
        List<MultiGauge.Row<?>> zustaende = new ArrayList<>(eingaenge.size() * 2);
        for (MesskundeEingang m : eingaenge) {
            Tags tags = Tags.of("tenant", m.tenantId().toString());
            boolean bekannt = m.zuletzt() != null;
            zustaende.add(MultiGauge.Row.of(tags.and("zustand", BEKANNT), bekannt ? 1d : 0d));
            zustaende.add(MultiGauge.Row.of(tags.and("zustand", NIE), bekannt ? 0d : 1d));
            if (bekannt) {
                alter.add(MultiGauge.Row.of(tags, m.zuletzt(), this::alterSekunden));
            }
        }
        messwertAlter.register(alter, true);
        messwertZustand.register(zustaende, true);
        log.debug("uems metrics collected: {} Messkunden-Kundenbereich(e)", eingaenge.size());
    }

    /** Das Alter zum SCRAPE-Zeitpunkt, aus dem gesammelten Zeitpunkt — reine Arithmetik, kein SQL. */
    private double alterSekunden(Instant zeitpunkt) {
        return Math.max(0L, Duration.between(zeitpunkt, uhr.instant()).getSeconds());
    }
}
