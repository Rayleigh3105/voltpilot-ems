package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.GemeinsameSteuerungHerzschlag.Block;
import com.voltpilot.api.repo.BoxMetrikRepository;
import com.voltpilot.api.repo.BoxMetrikRepository.Box;
import com.voltpilot.api.repo.BoxMetrikRepository.Mitglied;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * AP-15 IP-11 (NW-9): die Box-Sicht der Überwachung — je Box, was sie fährt und was sie hält, damit
 * der Ausfall EINER Box nicht lautlos bleibt (Meilenstein M2). Die acht Regeln baut das gitops-Repo
 * (Teil B); die Übergabe steht in docs/rollout/gemeinsame-steuerung-metriken.md.
 *
 * <p><b>Das Muster ist {@link UemsMetricsCollector}:</b> gesammelt wird im eigenen Takt, ein Scrape
 * führt nie SQL aus; jedes Alter rechnet der Scrape aus dem gesammelten Zeitpunkt und wächst darum
 * zwischen zwei Sammel-Läufen weiter. Labels sind die internen Kennungen {@code tenant}, {@code site},
 * {@code device} — nie ein Name.
 *
 * <p><b>Bestandsschutz.</b> Reihen gibt es nur für Boxen mit Bezug ({@link BoxMetrikRepository});
 * ohne eine solche Box ist der Export byte-gleich wie vorher. Am Schalter
 * {@code voltpilot.metrics.uems.enabled} hängt der Sammler wie die übrigen UEMS-Metriken. Den
 * Dauerläufer-Kundenbereich nimmt er bewusst NICHT aus: {@link Dauerlaeufer} wirkt nur auf die
 * Flottenkennzahlen, und die Alarm-Übung (NW-9) findet genau dort statt.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true",
        matchIfMissing = true)
public class GemeinsameSteuerungMetrikSammler {

    private static final Logger log = LoggerFactory.getLogger(GemeinsameSteuerungMetrikSammler.class);

    /**
     * Alter des jüngsten gültigen Status-Herzschlags (Cloud-Ankunft, {@code device_status_seen_at});
     * fehlt bei {@code zustand="nie"}. Die Namen sind der Vertrag mit Teil B und stehen wörtlich so
     * hier, wie sie im Scrape stehen.
     */
    public static final String HERZSCHLAG_ALTER = "voltpilot_uems_box_herzschlag_age_seconds";

    /** Begleiter zu {@link #HERZSCHLAG_ALTER}: 1 für den aktiven Zustand {@code bekannt} | {@code nie}. */
    public static final String HERZSCHLAG_ZUSTAND = "voltpilot_uems_box_herzschlag_zustand";

    /** Alter (ab Erzeugung) des jüngsten VERÖFFENTLICHTEN Plans 2.0 dieser Box; fehlt, wenn nie. */
    public static final String PLAN_VEROEFFENTLICHT_ALTER = "voltpilot_uems_box_plan_veroeffentlicht_age_seconds";

    /** Alter (ab Erzeugung) des jüngsten ANGENOMMENEN Plans 2.0 dieser Box; fehlt, wenn nie. */
    public static final String PLAN_ANGENOMMEN_ALTER = "voltpilot_uems_box_plan_angenommen_age_seconds";

    /**
     * 1, wenn die Box {@code plan_quittung} in {@code supports[]} meldet, sonst 0. Eine alte Box ohne
     * die Fähigkeit behält „angenommen“ leer — eine Regel darf daraus keinen Alarm machen.
     */
    public static final String PLAN_QUITTUNG_GEMELDET = "voltpilot_uems_box_plan_quittung_gemeldet";

    /**
     * 1 für die aktive Stufe je gesendeter Richtung ({@code richtung}, {@code stufe}), aus dem
     * Herzschlag-Block. Eine Richtung, die die Box nicht sendet, hat keine Reihe.
     */
    public static final String WAECHTER_STUFE = "voltpilot_uems_box_waechter_stufe";

    /**
     * Revision des zuletzt an die Box gesendeten Anteils-Dokuments, Label {@code epoche} (die Revision
     * steigt nur innerhalb einer Epoche). Quelle {@code steuerungsverbund_mitglied.gesendet_*} (IP-4);
     * <b>leer, bis IP-7 sendet</b>.
     */
    public static final String ANTEILE_REVISION_GESENDET = "voltpilot_uems_box_anteile_revision_gesendet";

    /** Revision der von der Box quittierten Anteile, wie oben; <b>leer, bis IP-7 die Quittung empfängt</b>. */
    public static final String ANTEILE_REVISION_QUITTIERT = "voltpilot_uems_box_anteile_revision_quittiert";

    /**
     * Alter des zuletzt gesendeten Anteils-Dokuments, solange die Box es nicht quittiert hat
     * (gesendet (Epoche, Revision) über quittiert, oder nie quittiert); fehlt, wenn bestätigt oder nie
     * gesendet. Die Regel {@code AnteileNichtBestaetigt} braucht damit keinen Vergleich über Epochen.
     */
    public static final String ANTEILE_UNBESTAETIGT_ALTER = "voltpilot_uems_box_anteile_unbestaetigt_age_seconds";

    /**
     * 1 für die Rolle der jetzt gültigen Mitgliedschaft ({@code rolle} = {@code fuehrt} |
     * {@code steuert_mit}), Label {@code stufe} = Stufe der Gemeinsamen Steuerung. Aus der erklärten
     * Mitgliedschaft (IP-4), nicht aus dem Herzschlag — eine stumme führende Box sendet keinen.
     */
    public static final String ROLLE = "voltpilot_uems_box_rolle";

    /** Die Rollen eines Mitglieds ({@code liest} ist keines, T6). */
    static final List<String> ROLLEN = List.of("fuehrt", "steuert_mit");

    private final BoxMetrikRepository repo;
    private final GemeinsameSteuerungHerzschlag herzschlag;
    private final Clock uhr;
    private final MultiGauge herzschlagAlter;
    private final MultiGauge herzschlagZustand;
    private final MultiGauge veroeffentlichtAlter;
    private final MultiGauge angenommenAlter;
    private final MultiGauge quittungGemeldet;
    private final MultiGauge waechterStufe;
    private final MultiGauge rolle;
    private final MultiGauge revisionGesendet;
    private final MultiGauge revisionQuittiert;
    private final MultiGauge unbestaetigtAlter;
    private GemeinsameSteuerungUhrMetrik uhrMetrik;
    private boolean failing;

    void uhrMetrik(GemeinsameSteuerungUhrMetrik uhrMetrik) {
        this.uhrMetrik = uhrMetrik;
    }

    @Autowired
    public GemeinsameSteuerungMetrikSammler(BoxMetrikRepository repo, GemeinsameSteuerungHerzschlag herzschlag,
            MeterRegistry registry, GemeinsameSteuerungUhrMetrik uhrMetrik) {
        this(repo, herzschlag, registry, Clock.systemUTC());
        this.uhrMetrik = uhrMetrik;
    }

    /** Test-Naht mit steuerbarer Uhr. */
    GemeinsameSteuerungMetrikSammler(BoxMetrikRepository repo, GemeinsameSteuerungHerzschlag herzschlag,
            MeterRegistry registry, Clock uhr) {
        this.repo = repo;
        this.herzschlag = herzschlag;
        this.uhr = uhr;
        this.herzschlagAlter = MultiGauge.builder(HERZSCHLAG_ALTER)
                .description("Alter des juengsten Status-Herzschlags je Box mit Plan 2.0; fehlt, wenn nie"
                        + " - siehe voltpilot_uems_box_herzschlag_zustand")
                .register(registry);
        this.herzschlagZustand = MultiGauge.builder(HERZSCHLAG_ZUSTAND)
                .description("1 fuer den aktiven Zustand: bekannt | nie")
                .register(registry);
        this.veroeffentlichtAlter = MultiGauge.builder(PLAN_VEROEFFENTLICHT_ALTER)
                .description("Alter ab Erzeugung des juengsten veroeffentlichten Plans 2.0; fehlt, wenn nie")
                .register(registry);
        this.angenommenAlter = MultiGauge.builder(PLAN_ANGENOMMEN_ALTER)
                .description("Alter ab Erzeugung des juengsten angenommenen Plans 2.0; fehlt, wenn nie")
                .register(registry);
        this.quittungGemeldet = MultiGauge.builder(PLAN_QUITTUNG_GEMELDET)
                .description("1, wenn die Box plan_quittung meldet; sonst bleibt angenommen ohne Alarm leer")
                .register(registry);
        this.waechterStufe = MultiGauge.builder(WAECHTER_STUFE)
                .description("1 fuer die aktive Waechter-Stufe je gesendeter Richtung, aus dem Herzschlag-Block")
                .register(registry);
        this.rolle = MultiGauge.builder(ROLLE)
                .description("1 fuer die Rolle der jetzt gueltigen Mitgliedschaft; stufe = Stufe der Gemeinsamen Steuerung")
                .register(registry);
        this.revisionGesendet = MultiGauge.builder(ANTEILE_REVISION_GESENDET)
                .description("Revision des zuletzt gesendeten Anteils-Dokuments je Epoche; fehlt, wenn nie")
                .register(registry);
        this.revisionQuittiert = MultiGauge.builder(ANTEILE_REVISION_QUITTIERT)
                .description("Revision der zuletzt quittierten Anteile je Epoche; fehlt, wenn nie")
                .register(registry);
        this.unbestaetigtAlter = MultiGauge.builder(ANTEILE_UNBESTAETIGT_ALTER)
                .description("Alter des gesendeten, noch nicht quittierten Anteils-Dokuments; fehlt, wenn bestaetigt")
                .register(registry);
    }

    /** Derselbe Takt wie {@link UemsMetricsCollector}: die Schwellen der Regeln liegen bei 5 und 30 min. */
    @Scheduled(fixedDelayString = "${voltpilot.metrics.uems.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.uems.initial-delay-ms:20000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("box metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("box metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("box metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Sammelt einen Stand; paket-sichtbar für die Scrape- und DB-Tests. */
    void collect() {
        List<Box> boxen = repo.boxen(herzschlag.boxen());
        List<MultiGauge.Row<?>> hAlter = new ArrayList<>(boxen.size());
        List<MultiGauge.Row<?>> hZustand = new ArrayList<>(boxen.size() * 2);
        List<MultiGauge.Row<?>> vAlter = new ArrayList<>(boxen.size());
        List<MultiGauge.Row<?>> aAlter = new ArrayList<>(boxen.size());
        List<MultiGauge.Row<?>> quittung = new ArrayList<>(boxen.size());
        List<MultiGauge.Row<?>> stufen = new ArrayList<>();
        List<MultiGauge.Row<?>> rollen = new ArrayList<>();
        List<MultiGauge.Row<?>> gesendet = new ArrayList<>();
        List<MultiGauge.Row<?>> quittiert = new ArrayList<>();
        List<MultiGauge.Row<?>> unbestaetigt = new ArrayList<>();
        Map<UUID, Long> uhrereignisse = new LinkedHashMap<>();
        for (Box b : boxen) {
            uhrereignisse.put(b.deviceId(), b.uhrereignisse());
            Tags tags = Tags.of("tenant", b.tenantId().toString(), "site", b.siteId().toString(),
                    "device", b.deviceId().toString());
            boolean bekannt = b.herzschlag() != null;
            hZustand.add(MultiGauge.Row.of(tags.and("zustand", UemsMetricsCollector.BEKANNT), bekannt ? 1d : 0d));
            hZustand.add(MultiGauge.Row.of(tags.and("zustand", UemsMetricsCollector.NIE), bekannt ? 0d : 1d));
            if (bekannt) {
                hAlter.add(MultiGauge.Row.of(tags, b.herzschlag(), this::alterSekunden));
            }
            if (b.veroeffentlicht() != null) {
                vAlter.add(MultiGauge.Row.of(tags, b.veroeffentlicht(), this::alterSekunden));
            }
            if (b.angenommen() != null) {
                aAlter.add(MultiGauge.Row.of(tags, b.angenommen(), this::alterSekunden));
            }
            quittung.add(MultiGauge.Row.of(tags, b.quittiert() ? 1d : 0d));
            Mitglied m = b.mitglied();
            if (m != null) {
                for (String r : ROLLEN) {
                    rollen.add(MultiGauge.Row.of(tags.and("rolle", r, "stufe", m.stufe()), r.equals(m.rolle()) ? 1d : 0d));
                }
                if (m.gesendetRevision() != null) {
                    gesendet.add(MultiGauge.Row.of(tags.and("epoche", String.valueOf(m.gesendetEpoche())),
                            m.gesendetRevision().doubleValue()));
                }
                if (m.quittiertRevision() != null) {
                    quittiert.add(MultiGauge.Row.of(tags.and("epoche", String.valueOf(m.quittiertEpoche())),
                            m.quittiertRevision().doubleValue()));
                }
                if (unbestaetigt(m)) {
                    unbestaetigt.add(MultiGauge.Row.of(tags, m.gesendetAm(), this::alterSekunden));
                }
            }
            Block block = herzschlag.block(b.deviceId());
            if (block != null) {
                for (String richtung : GemeinsameSteuerungHerzschlag.RICHTUNGEN) {
                    String aktiv = block.waechter().get(richtung);
                    if (aktiv == null) {
                        continue;
                    }
                    for (String stufe : GemeinsameSteuerungHerzschlag.WAECHTER_STUFEN) {
                        stufen.add(MultiGauge.Row.of(tags.and("richtung", richtung, "stufe", stufe),
                                stufe.equals(aktiv) ? 1d : 0d));
                    }
                }
            }
        }
        herzschlagAlter.register(hAlter, true);
        herzschlagZustand.register(hZustand, true);
        veroeffentlichtAlter.register(vAlter, true);
        angenommenAlter.register(aAlter, true);
        quittungGemeldet.register(quittung, true);
        waechterStufe.register(stufen, true);
        rolle.register(rollen, true);
        revisionGesendet.register(gesendet, true);
        revisionQuittiert.register(quittiert, true);
        unbestaetigtAlter.register(unbestaetigt, true);
        if (uhrMetrik != null) {
            uhrMetrik.uhrereignisse(uhrereignisse);
        }
        log.debug("box metrics collected: {} Box(en) mit Bezug", boxen.size());
    }

    /** Gesendet und (noch) nicht quittiert: nie quittiert, oder (Epoche, Revision) der Quittung darunter. */
    static boolean unbestaetigt(Mitglied m) {
        if (m.gesendetRevision() == null || m.gesendetAm() == null) {
            return false;
        }
        if (m.quittiertRevision() == null) {
            return true;
        }
        long ge = m.gesendetEpoche() == null ? 0L : m.gesendetEpoche();
        long qe = m.quittiertEpoche() == null ? 0L : m.quittiertEpoche();
        return qe < ge || (qe == ge && m.quittiertRevision() < m.gesendetRevision());
    }

    /** Das Alter zum SCRAPE-Zeitpunkt, aus dem gesammelten Zeitpunkt — reine Arithmetik, kein SQL. */
    private double alterSekunden(Instant zeitpunkt) {
        return Math.max(0L, Duration.between(zeitpunkt, uhr.instant()).getSeconds());
    }
}
