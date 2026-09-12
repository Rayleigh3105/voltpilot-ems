package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.measurement.MeasurementHistoryService.Datum;
import com.voltpilot.api.measurement.MeasurementHistoryService.Herkunft;
import com.voltpilot.api.measurement.MeasurementHistoryService.History;
import com.voltpilot.api.measurement.MeasurementHistoryService.Marker;
import com.voltpilot.api.measurement.MeasurementSelectionRepository;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der LESEPFAD der Messdatenstrecke (UEMS AP-07 IP-14) gegen eine echte TimescaleDB — die
 * Stelle, an der alles, was seit PR 691 in die Datenbank geschrieben wurde, zum ersten Mal
 * GELESEN wird.
 *
 * <p><b>Der Mangel, den das Paket behebt</b> (Abnahmefälle A2 und A7 des Reports): ein Zeitraum
 * jenseits der Rohdaten-Aufbewahrung bekam bis hierher einen Fehler (HTTP 400 „keine echten
 * Rohdaten") oder eine leere Kurve — obwohl die Viertelstunden- und Tageswerte die Frage
 * beantworten können. Danach bekommt er WERTE und die Antwort sagt, woraus sie gebildet ist.
 *
 * <p><b>Die Beispielwelt</b> ist Ahrenberg (docs/contracts/v2/uems-referenzunternehmen.json):
 * Standort AN-2, Box Halle 2, Komponente K-5 (Unterzähler Spritzguss, Zählerstand) mit den
 * Viertelstundenwerten des 20.10.2026 und Tageswerten darum herum; die Rohwerte dieses Tages
 * sind per Retention weg (im Test: sie werden gar nicht erst gesät, das ist derselbe Zustand
 * wie nach dem Chunk-Drop). Die Uhr steht auf dem 19.01.2027 — 91 Tage später, genau A7.
 *
 * <p><b>Die zweite Reihe K-6</b> beweist den Bestandsschutz von der anderen Seite: sie hat
 * KEINE Viertelstundenwerte, aber die bestehende 15-Minuten-Verdichtung der Box. Ihr
 * Jahresverlauf muss weiter aus der Verdichtung kommen — der Rückfall ERSETZT nichts, was heute
 * schon antwortet.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsLesepfadTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** A7: „Rohwert MS-06 20.10.2026 10:15:00; heute 19.01.2027." */
    private static final Instant JETZT = Instant.parse("2027-01-19T10:00:00Z");
    /** Die Rohdaten-Frist dieser Uhr: 90 Tage davor. */
    private static final Instant ROH_GRENZE = Instant.parse("2026-10-21T10:00:00Z");

    /** Der 20.10.2026 in der Zeitzone des Standorts (Europe/Berlin, damals UTC+2). */
    private static final Instant TAG_VON = Instant.parse("2026-10-19T22:00:00Z");
    private static final Instant TAG_BIS = Instant.parse("2026-10-20T22:00:00Z");

    /** Ein Zeitraum INNERHALB der Frist — hier muss jede Antwort zeichengleich bleiben. */
    private static final Instant FRISCH_VON = Instant.parse("2027-01-18T00:00:00Z");
    private static final Instant FRISCH_BIS = Instant.parse("2027-01-18T01:00:00Z");

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000001");
    private static final UUID FREMD = UUID.fromString("4e0e0000-0000-0000-0000-000000000002");

    /** Ein echter Katalogpunkt (Zählerstand), damit der Verlauf seine Wertart wirklich auflöst. */
    private static final String KANAL = "deye.hybrid_1p.meter.today-energy";
    private static final String KANAL_BESTAND = "deye.hybrid_1p.meter.today-battery-charge";

    /**
     * Die je Wert GESPEICHERTE Katalogfassung — bewusst eine ALTE, nie die heutige. Sie muss
     * sich vom Laufzeitstand des Katalogs unterscheiden, sonst bewiese der Export-Test nichts
     * (der Laufzeitstand ist heute {@code 2026.08.26.3}, siehe
     * {@code catalog/measurement-points/RUNTIME_VERSION}).
     */
    private static final String KATALOG_DAMALS = "2026.06.02.1";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static MeasurementHistoryService verlauf;
    private static MeasurementCatalog katalog;

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    @BeforeAll
    static void bauen() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        stammdaten();
        rohwerte();
        viertelstunden();
        tageswerte();
        bestandsVerdichtung();
        ereignisse();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        katalog = new MeasurementCatalog(new ObjectMapper());
        verlauf = new MeasurementHistoryService(app, katalog,
                new MeasurementSelectionRepository(app), new SpeicherklasseHistorie(app),
                Clock.fixed(JETZT, ZoneOffset.UTC));
        TenantContext.set(KB);
    }

    @AfterAll
    static void aufraeumen() {
        TenantContext.clear();
    }

    // ====================================================== A7: der Wert nach 91 Tagen

    /**
     * A7, der Kern des Pakets: ein Zeitraum jenseits der Rohdaten-Frist liefert WERTE statt
     * eines Fehlers — und sagt, woraus sie gebildet sind.
     */
    @Test
    void a7_einZeitraumJenseitsDerFristLiefertWerteStattEinesFehlers() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        assertThat(h.data()).as("der Verlauf des 20.10.2026 zeigt 96 Viertelstundenwerte")
                .hasSize(96);
        assertThat(h.meta().quelle()).isEqualTo("viertelstunde");
        assertThat(h.meta().rawAvailable()).as("die Rohwerte sind planmäßig weg").isFalse();
        assertThat(h.meta().rohGrenze()).isEqualTo(ROH_GRENZE);
        assertThat(h.meta().quelleErklaerung()).contains("Viertelstundenwerte").contains("90 Tage");
        assertThat(h.meta().bucketSeconds()).as("das Raster der Antwort ist die Viertelstunde")
                .isEqualTo(900);
        assertThat(h.data().get(0).time()).isEqualTo(TAG_VON);
    }

    /**
     * Dieselbe Frage mit {@code representation=raw}: bis hierher HTTP 400. Jetzt dieselbe
     * Antwort aus der Speicherklasse, mit {@code rawAvailable=false} statt eines Fehlers.
     */
    @Test
    void a7_dieRohwertAbfrageJenseitsDerFristWirftNichtMehr() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "raw");
        assertThat(h.data()).hasSize(96);
        assertThat(h.meta().rawAvailable()).isFalse();
        assertThat(h.meta().representation()).isEqualTo("raw");
        assertThat(h.meta().quelle()).isEqualTo("viertelstunde");
    }

    /**
     * INNERHALB der Frist bleibt der Fehler stehen: er sagt dort etwas Wahres — Rohwerte werden
     * noch aufbewahrt, für diesen Messwert sind keine da. Das ist der Bestandsschutz der
     * bestehenden Fläche, nicht ein vergessener Zweig.
     */
    @Test
    void innerhalbDerFristBleibtDerFehlerStehen() {
        assertThatThrownBy(() -> frei(KANAL_BESTAND, Instant.parse("2027-01-18T00:00:00Z"),
                Instant.parse("2027-01-18T01:00:00Z"), "raw"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("keine echten Rohdaten");
    }

    // ================================================= A2: der lange Auswertungsumfang

    /**
     * A2: „Verlauf, Export, Tageswert … liefern für jede Viertelstunde Wert, Abdeckung,
     * Qualitätszähler, Gerät + Einbau, Fassung, Box, Zustand, nachgeliefert, Version".
     */
    @Test
    void a2_jedeViertelstundeTraegtIhreHerkunft() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        assertThat(h.data()).allSatisfy(d -> assertThat(d.herkunft()).isNotNull());

        Datum voll = h.data().get(0);
        Herkunft k = voll.herkunft();
        assertThat(k.quelle()).isEqualTo("viertelstunde");
        assertThat(k.wertart()).isEqualTo("counter");
        assertThat(k.erhalten()).isEqualTo(15);
        assertThat(k.erwartet()).isEqualTo(15);
        assertThat(k.abdeckungProzent()).isEqualTo(100);
        assertThat(k.nGood()).isEqualTo(15);
        assertThat(k.nUncertain()).isZero();
        assertThat(k.zustand()).isEqualTo("endgueltig");
        assertThat(k.version()).isEqualTo(1);
        assertThat(k.endgueltigAb()).isEqualTo(TAG_VON.plus(Duration.ofMinutes(10095)));
        assertThat(k.nachgeliefert()).isZero();
        assertThat(k.zustellart()).isEqualTo("direkt");
        assertThat(k.geraetEinbau()).isEqualTo(IDS.get("EINBAU"));
        assertThat(k.box()).isEqualTo(IDS.get("BOX"));
        assertThat(k.fassung()).isEqualTo(1L);
        assertThat(k.rolle()).isEqualTo("fuehrend");
        assertThat(k.katalogVersion()).isEqualTo(KATALOG_DAMALS);
        assertThat(voll.value()).as("die Menge der Viertelstunde (AP-08 IP-2)")
                .isEqualByComparingTo("0.600");
    }

    /**
     * Eine Lücke ist nie eine Null (§4.9 Nr. 5): die unvollständige Viertelstunde 10:15–10:30
     * trägt keine Menge, eine Abdeckung unter 100 und den Lücken-Marker.
     */
    @Test
    void a2_eineUnvollstaendigeViertelstundeBehauptetKeineMenge() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        Datum luecke = h.data().stream()
                .filter(d -> d.time().equals(Instant.parse("2026-10-20T08:15:00Z")))
                .findFirst().orElseThrow();
        assertThat(luecke.value()).as("keine bildbare Menge — und nie eine erfundene 0").isNull();
        assertThat(luecke.gap()).isTrue();
        assertThat(luecke.herkunft().erhalten()).isEqualTo(10);
        assertThat(luecke.herkunft().erwartet()).isEqualTo(15);
        assertThat(luecke.herkunft().abdeckungProzent()).isEqualTo(66);
    }

    /** Eine nachgelieferte Viertelstunde sagt es: Anzahl, Zustellart und letzte Eingangszeit. */
    @Test
    void a2_eineNachgelieferteViertelstundeSagtEs() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        Datum spaet = h.data().stream()
                .filter(d -> d.time().equals(Instant.parse("2026-10-20T09:00:00Z")))
                .findFirst().orElseThrow();
        assertThat(spaet.herkunft().nachgeliefert()).isEqualTo(4);
        assertThat(spaet.herkunft().zustellart()).isEqualTo("gemischt");
        assertThat(spaet.herkunft().letzteEingangszeit())
                .isEqualTo(Instant.parse("2026-10-20T12:00:00Z"));
    }

    // ==================================================== Die Marken: Sprünge erklärbar

    /**
     * Die sechs Ereignisarten des Auftrags erscheinen als Marken — gebündelt, mit Anzahl, und
     * die Übergabe findet über die DATENQUELLE her, weil sie am Vertrag keine Komponente
     * nennen darf (§4.8).
     */
    @Test
    void dieMarkenErklaerenDieSpruenge() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        List<String> arten = h.markers().stream().map(Marker::kind).distinct().sorted().toList();
        assertThat(arten).contains("data_gap", "counter_reset", "device_boundary", "handover",
                "duplicate_conflict", "late_arrival");
        assertThat(arten).as("nur die sechs Arten des Verlaufs, nie das ganze Vokabular")
                .doesNotContain("rejected", "sequence_gap");

        Marker luecke = h.markers().stream().filter(m -> m.kind().equals("data_gap"))
                .findFirst().orElseThrow();
        assertThat(luecke.time()).isEqualTo(Instant.parse("2026-10-20T08:15:00Z"));
        assertThat(luecke.until()).isEqualTo(Instant.parse("2026-10-20T08:25:00Z"));
        assertThat(luecke.label()).isEqualTo("Datenlücke");

        Marker doppelt = h.markers().stream()
                .filter(m -> m.kind().equals("duplicate_conflict")).findFirst().orElseThrow();
        assertThat(doppelt.count()).as("zwei Meldungen, EINE gebündelte Marke").isEqualTo(2);
        assertThat(doppelt.label()).isEqualTo("Doppelte Zustellung mit abweichendem Wert (2×)");

        assertThat(h.markers()).as("die Marken stehen in der Zeit")
                .isSortedAccordingTo(java.util.Comparator.comparing(Marker::time));
    }

    /**
     * Die Fortschreibung eines Ereignisses (append-only, gleiche {@code ereignis_id}, hier die
     * geschlossene Lücke) ist KEIN zweites Ereignis — und der Bestands-Spiegel aus {@code
     * device_measurement_event} steht nicht ein zweites Mal daneben.
     *
     * <p>Der Spiegel kann die Reihe schon von der Datenbank her nicht erreichen: {@code
     * messreihe_ereignis_bestand_chk} verbietet ihm jeden Reihen- und Quellen-Bezug. Die
     * ausdrückliche Bedingung {@code NOT aus_bestand} im Leser hält das fest, falls der
     * Spiegel je einen bekommt — beides zusammen ist der Beweis, nicht eines allein.
     */
    @Test
    void wederFortschreibungNochBestandsSpiegelZaehlenDoppelt() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        List<Marker> luecken = h.markers().stream()
                .filter(m -> m.kind().equals("data_gap")).toList();
        assertThat(luecken).as("eine Lücke, zwei Meldungen, ein Spiegel — EINE Marke").hasSize(1);
        assertThat(luecken.get(0).count()).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis "
                + "WHERE art = 'data_gap'", Long.class)).as("drei Zeilen stehen wirklich da")
                .isEqualTo(3L);
    }

    // ================================================================ Der Export

    /**
     * Der Export-Spaltentest: die sieben Spalten und die zehn Kopfzeilen von vorher stehen
     * unverändert, dahinter die Herkunfts-Spalten — und die je Wert GESPEICHERTE
     * Katalogfassung, nicht die heutige.
     */
    @Test
    void derExportTraegtDieHerkunftUndDieGespeicherteKatalogfassung() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        String csv = new String(verlauf.csv(h), StandardCharsets.UTF_8);
        List<String> zeilen = List.of(csv.split("\n"));

        assertThat(zeilen.subList(0, 10)).as("die zehn Kopfzeilen von vorher, in ihrer Reihenfolge")
                .allMatch(z -> z.startsWith("# "))
                .element(6).asString().startsWith("# catalog_version=");
        String kopf = zeilen.stream().filter(z -> z.startsWith("#")).reduce("", (a, b) -> a + b);
        assertThat(kopf).contains("# quelle=\"viertelstunde\"")
                .contains("# raw_available=false")
                .contains("# roh_grenze=\"2026-10-21T10:00:00Z\"")
                .contains("# catalog_version_gespeichert=\"" + KATALOG_DAMALS + "\"");

        String spalten = zeilen.stream().filter(z -> z.startsWith("time,")).findFirst().orElseThrow();
        assertThat(spalten).as("ein bestehender Empfänger liest die ersten sieben weiter")
                .startsWith("time,value,min,max,text,sample_count,gap,");
        assertThat(spalten).contains(",quelle,wertart,abdeckung_prozent,erhalten,erwartet,")
                .contains(",n_good,n_uncertain,n_invalid,n_stale,n_device_error,")
                .contains(",zustand,endgueltig_ab,version,nachgeliefert,zustellart,")
                .contains(",geraet_einbau,geraet_einbau_2,box,box_2,fassung,katalog_version,rolle,")
                .endsWith(",stand_anfang,stand_ende");

        String erste = zeilen.stream().filter(z -> z.startsWith("2026-10-19T22:00:00Z"))
                .findFirst().orElseThrow();
        assertThat(erste).contains("\"viertelstunde\"").contains("\"counter\"")
                .contains("\"endgueltig\"").contains("\"fuehrend\"")
                .contains("\"" + KATALOG_DAMALS + "\"")
                .contains(IDS.get("EINBAU").toString()).contains(IDS.get("BOX").toString());
        assertThat(erste).as("die HEUTIGE Fassung steht nie in der Zeile")
                .doesNotContain(katalog.version());
        assertThat(katalog.version()).as("die Probe lebt nur, wenn beide Fassungen verschieden sind")
                .isNotEqualTo(KATALOG_DAMALS);
    }

    /** Eine Zahl, die es nicht gibt, bleibt LEER — nie eine 0 (Hausregel „Ehrlichkeit der Zahlen"). */
    @Test
    void derExportErfindetKeineZahl() {
        History h = frei(KANAL, TAG_VON, TAG_BIS, "decoded");
        String csv = new String(verlauf.csv(h), StandardCharsets.UTF_8);
        String luecke = List.of(csv.split("\n")).stream()
                .filter(z -> z.startsWith("2026-10-20T08:15:00Z")).findFirst().orElseThrow();
        // time,value,… — der zweite Wert ist die Menge und ist leer, nicht 0.
        assertThat(luecke.split(",", -1)[1]).isEmpty();
        assertThat(luecke).contains(",66,10,15,");
    }

    // ============================================== Der Bestandsschutz der Kundenfläche

    /**
     * Ein Zeitraum INNERHALB der Frist bleibt Zeichen für Zeichen die Antwort von vorher: die
     * Rohwerte selbst, ihre Zahlen, ihr Raster und die sieben Spalten des Exports. Der
     * Fingerabdruck friert die Projektion der BESTEHENDEN Felder ein — ändert sich einer von
     * ihnen, fällt dieser Test.
     */
    @Test
    void innerhalbDerFristIstDieFlaecheZeichengleich() {
        History h = frei(KANAL, FRISCH_VON, FRISCH_BIS, "decoded");
        assertThat(h.meta().quelle()).isEqualTo("roh");
        assertThat(h.meta().rawAvailable()).isTrue();
        assertThat(h.meta().bucketSeconds()).isEqualTo(300);
        assertThat(h.meta().aggregationKind()).isEqualTo("counter");
        assertThat(h.data()).as("zwei 5-Minuten-Fenster über sechs Minutenwerten").hasSize(2);
        assertThat(h.data().get(0).time()).isEqualTo(Instant.parse("2027-01-18T00:00:00Z"));
        assertThat(h.data().get(0).value()).as("positive Differenzen wie vorher")
                .isEqualByComparingTo("4.0");
        assertThat(h.data().get(0).sampleCount()).isEqualTo(5);
        assertThat(h.data().get(1).time()).isEqualTo(Instant.parse("2027-01-18T00:05:00Z"));
        assertThat(h.data().get(1).value()).isEqualByComparingTo("1.0");
        assertThat(fingerabdruck(h)).isEqualTo(FINGERABDRUCK_INNERHALB);
    }

    /**
     * Der Rohwert-Weg trägt jetzt AUCH seine Herkunft — additiv. Was es am Rohwert nicht gibt
     * (Abdeckung, Zustand, Qualitätszähler außer den guten), bleibt leer statt geraten.
     */
    @Test
    void derRohwertWegTraegtSeineHerkunftUndBehauptetNichtsDarueberHinaus() {
        Herkunft k = frei(KANAL, FRISCH_VON, FRISCH_BIS, "decoded").data().get(0).herkunft();
        assertThat(k.quelle()).isEqualTo("roh");
        assertThat(k.wertart()).isEqualTo("counter");
        assertThat(k.geraetEinbau()).isEqualTo(IDS.get("EINBAU"));
        assertThat(k.box()).isEqualTo(IDS.get("BOX"));
        assertThat(k.fassung()).isEqualTo(2L);
        assertThat(k.katalogVersion()).isEqualTo("2027.01.05.1");
        assertThat(k.rolle()).isEqualTo("fuehrend");
        assertThat(k.zustellart()).isEqualTo("direkt");
        assertThat(k.erhalten()).isEqualTo(5);
        assertThat(k.nGood()).isEqualTo(5);
        assertThat(k.erwartet()).as("die erwartete Häufigkeit kennt erst die Viertelstunde").isNull();
        assertThat(k.abdeckungProzent()).isNull();
        assertThat(k.zustand()).isNull();
        assertThat(k.nInvalid()).isNull();
        assertThat(k.standAnfang()).isNull();
    }

    /**
     * Der Rückfall ERSETZT nichts: die Reihe K-6 hat keine Viertelstundenwerte, aber die
     * bestehende 15-Minuten-Verdichtung — ihr Jahresverlauf kommt weiter von dort, auch wenn
     * er weit jenseits der Rohdaten-Frist beginnt.
     */
    @Test
    void derRueckfallErsetztNichtsWasHeuteSchonAntwortet() {
        History h = frei(KANAL_BESTAND, Instant.parse("2026-08-01T00:00:00Z"), JETZT, "decoded");
        assertThat(h.meta().quelle()).isEqualTo("rollup_15m");
        assertThat(h.data()).isNotEmpty();
        assertThat(h.data().get(0).herkunft())
                .as("die Verdichtung der Box trägt keine Herkunft — leer statt erfunden").isNull();
        assertThat(h.meta().rawAvailable()).isFalse();
        assertThat(h.meta().rohGrenze()).as("die Frist steht trotzdem in der Antwort")
                .isEqualTo(ROH_GRENZE);
    }

    /**
     * Ein Zeitraum über 90 Tage fällt auf die TAGESKLASSE zurück — und ein Zählerstand bleibt
     * dort ohne Kurvenwert: die Tagesmenge bildet AP-08 IP-5 aus den Periodenständen, sie wird
     * hier nicht erfunden. Anfangs- und Endstand reisen stattdessen in der Herkunft mit.
     */
    @Test
    void ueberNeunzigTageTraegtDieTagesklasseUndErfindetKeineTagesmenge() {
        History h = frei(KANAL, Instant.parse("2026-09-15T00:00:00Z"), JETZT, "decoded");
        assertThat(h.meta().quelle()).isEqualTo("tag");
        assertThat(h.data()).hasSize(3);
        Datum tag = h.data().get(0);
        assertThat(tag.value()).as("keine geratene Tagesmenge").isNull();
        assertThat(tag.herkunft().standAnfang()).isEqualByComparingTo("1000.000");
        assertThat(tag.herkunft().standEnde()).isEqualByComparingTo("1057.600");
        assertThat(tag.herkunft().erhalten()).isEqualTo(1430);
        assertThat(tag.herkunft().erwartet()).isEqualTo(1440);
        assertThat(tag.herkunft().abdeckungProzent()).as("nie auf 100 gerundet").isEqualTo(99);
        assertThat(tag.herkunft().zustand()).isEqualTo("endgueltig");
    }

    /**
     * Die Marken stehen auf JEDEM Weg, nicht nur im Rückfall: ein Gerätewechsel von gestern ist
     * genau der Sprung, der eine Erklärung braucht. Das ist die EINE Stelle, an der dieses
     * Paket ein bestehendes Feld anreichert — die Kurve selbst bleibt, was sie war (hier: leer,
     * weil für den 17.01. keine Rohwerte gesät sind, und der Rückfall greift innerhalb der
     * Frist nicht).
     */
    @Test
    void auchInnerhalbDerFristErklaertEineMarkeDenSprung() {
        History h = frei(KANAL, Instant.parse("2027-01-17T00:00:00Z"),
                Instant.parse("2027-01-17T23:59:00Z"), "decoded");
        assertThat(h.meta().quelle()).isEqualTo("roh");
        assertThat(h.data()).as("die Kurve bleibt, was sie war").isEmpty();
        assertThat(h.markers()).singleElement().satisfies(m -> {
            assertThat(m.kind()).isEqualTo("device_boundary");
            assertThat(m.label()).isEqualTo("Gerät gewechselt");
            assertThat(m.time()).isEqualTo(Instant.parse("2027-01-17T12:00:00Z"));
        });
    }

    // =========================================================== Der Mandantenzaun

    /** Ein fremdes Gerät ist 404, nie 403 — und niemals ein fremder Wert. */
    @Test
    void derZaunStehtUeberDemGanzenLesepfad() {
        TenantContext.set(FREMD);
        try {
            assertThatThrownBy(() -> frei(KANAL, TAG_VON, TAG_BIS, "decoded"))
                    .isInstanceOf(ResponseStatusException.class)
                    .hasMessageContaining("404")
                    .hasMessageContaining("nicht gefunden");
            assertThat(app.queryForObject("SELECT count(*) FROM messreihe_viertelstunde",
                    Long.class)).isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM messreihe_tag", Long.class))
                    .isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM messreihe_ereignis", Long.class))
                    .isZero();
        } finally {
            TenantContext.set(KB);
        }
    }

    /** Der Lesepfad liest NUR — die App darf in keine der Speicherklassen schreiben. */
    @Test
    void derLesepfadSchreibtNichts() {
        assertThatThrownBy(() -> app.update("UPDATE messreihe_viertelstunde SET version = 9"))
                .hasMessageContaining("messreihe_viertelstunde");
        assertThatThrownBy(() -> app.update("UPDATE messreihe_tag SET version = 9"))
                .hasMessageContaining("messreihe_tag");
    }

    // ================================================================= Hilfen

    private static final String FINGERABDRUCK_INNERHALB =
            "eee0728052422fa2438ba6a97b751654";

    /**
     * Die Projektion der BESTEHENDEN Felder — die neuen Felder sind bewusst NICHT darin, sonst
     * bewiese der Fingerabdruck nichts über den Bestand.
     */
    private static String fingerabdruck(History h) {
        StringBuilder s = new StringBuilder();
        s.append(h.meta().pointKey()).append('|').append(h.meta().label()).append('|')
                .append(h.meta().unit()).append('|').append(h.meta().aggregationKind()).append('|')
                .append(h.meta().semanticStatus()).append('|').append(h.meta().catalogVersion())
                .append('|').append(h.meta().representation()).append('|')
                .append(h.meta().rawAvailable()).append('|').append(h.meta().from()).append('|')
                .append(h.meta().to()).append('|').append(h.meta().bucketSeconds()).append('|')
                .append(h.meta().aggregationExplanation()).append('\n');
        for (Datum d : h.data()) {
            s.append(d.time()).append(',').append(d.value()).append(',').append(d.minimum())
                    .append(',').append(d.maximum()).append(',').append(d.text()).append(',')
                    .append(d.sampleCount()).append(',').append(d.gap()).append('\n');
        }
        for (Marker m : h.markers()) {
            s.append(m.time()).append(',').append(m.kind()).append(',').append(m.label())
                    .append('\n');
        }
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5")
                    .digest(s.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static History frei(String kanal, Instant von, Instant bis, String darstellung) {
        return verlauf.history(IDS.get("BOX"), kanal, "free", von, bis, darstellung, null, null);
    }

    // ========================================================= Aufbau der Beispielwelt

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich B')", FREMD);
        IDS.put("AN2", uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB));
        IDS.put("BOX", uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, 'VP-BOX-HALLE-2', 'claimed') RETURNING id", KB, IDS.get("AN2")));
        IDS.put("DQ", uuid("INSERT INTO data_source (tenant_id, site_id, kennzeichen, name, "
                + "protokoll, adresse, kadenz_s) VALUES (?, ?, 'DQ-4', 'WAGO Halle 2', "
                + "'modbus_tcp', '10.0.0.9:502/1', 60) RETURNING id", KB, IDS.get("AN2")));

        IDS.put("K5", komponente("K-5 Unterzähler Spritzguss", KANAL, IDS.get("DQ")));
        IDS.put("K6", komponente("K-6 Bestandsreihe", KANAL_BESTAND, null));
        // Der Einbau des Zählers Z-5a: die Herkunft, die je Wert mitreist (AP-04).
        IDS.put("EINBAU", root.queryForObject("SELECT geraet_id FROM geraet_komponente "
                + "WHERE entity_id = ? AND gueltig_bis IS NULL", UUID.class, IDS.get("K5")));
    }

    private static UUID komponente(String name, String kanal, UUID datenquelle) {
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                        + "entity_type, device_id, communication, connection_json, data_source_id, "
                        + "created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                        + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?, "
                        + "'2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN2"), name, IDS.get("BOX"), datenquelle);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "entity_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, retention_class, "
                        + "long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                        + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', "
                        + "'energy_counter', 'fifteen_minute')",
                KB, IDS.get("AN2"), IDS.get("BOX"), entity, kanal);
        return entity;
    }

    /**
     * Rohwerte gibt es NUR innerhalb der Frist — der 20.10.2026 hat keine mehr. Das ist
     * derselbe Zustand wie nach dem Chunk-Drop der Retention (A2: „Simulation: Chunk-Drop").
     */
    private static void rohwerte() {
        BigDecimal stand = new BigDecimal("5000.0");
        for (int i = 0; i < 6; i++) {
            Instant t = Instant.parse("2027-01-18T00:00:00Z").plusSeconds(60L * i);
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                            + "site_id, device_id, point_key, raw_numeric, decoded_numeric, quality, "
                            + "catalog_version, edge_sequence, aggregation_kind, entity_id, "
                            + "device_install_id, applied_revision, value_kind, role, delivery, "
                            + "delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', '2027.01.05.1', ?, "
                            + "'counter', ?, ?, 2, 'counter', 'fuehrend', 'direkt', 5)",
                    Timestamp.from(t), Timestamp.from(t.plusSeconds(5)), KB, IDS.get("AN2"),
                    IDS.get("BOX"), KANAL, stand.doubleValue(), stand.doubleValue(), 4000L + i,
                    IDS.get("K5"), IDS.get("EINBAU"));
            stand = stand.add(new BigDecimal("1.0"));
        }
    }

    /** Die 96 Viertelstunden des 20.10.2026 — der Tag, dessen Rohwerte weg sind. */
    private static void viertelstunden() {
        BigDecimal stand = new BigDecimal("1000.000");
        for (int i = 0; i < 96; i++) {
            Instant beginn = TAG_VON.plusSeconds(900L * i);
            boolean loch = beginn.equals(Instant.parse("2026-10-20T08:15:00Z"));
            boolean spaet = beginn.equals(Instant.parse("2026-10-20T09:00:00Z"));
            int erhalten = loch ? 10 : 15;
            BigDecimal menge = loch ? null : new BigDecimal("0.600");
            BigDecimal ende = stand.add(new BigDecimal("0.600"));
            root.update("INSERT INTO messreihe_viertelstunde (intervall_beginn, tenant_id, "
                            + "entity_id, messkanal, site_id, wertart, stand_anfang, stand_anfang_zeit, "
                            + "stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, "
                            + "letzter_zeit, erhalten, erwartet, abdeckung_prozent, kadenz_s, "
                            + "kadenz_herkunft, n_good, geraet_einbau, box, fassung, katalog, rolle, "
                            + "zustand, endgueltig_ab, version, n_nachgeliefert, letzte_eingangszeit, "
                            + "zustellart, menge, menge_zustand, faktor) VALUES (?, ?, ?, ?, ?, "
                            + "'counter', ?, ?, ?, ?, ?, ?, ?, ?, ?, 15, ?, 60, 'auswahl', ?, ?, ?, 1, "
                            + "?, 'fuehrend', 'endgueltig', ?, 1, ?, ?, ?, ?, ?, 1)",
                    Timestamp.from(beginn), KB, IDS.get("K5"), KANAL, IDS.get("AN2"),
                    stand, Timestamp.from(beginn), ende, Timestamp.from(beginn.plusSeconds(840)),
                    stand, Timestamp.from(beginn), ende, Timestamp.from(beginn.plusSeconds(840)),
                    erhalten, loch ? 66 : 100, erhalten, IDS.get("EINBAU"), IDS.get("BOX"),
                    KATALOG_DAMALS, Timestamp.from(beginn.plus(Duration.ofMinutes(10095))),
                    spaet ? 4 : 0, Timestamp.from(spaet ? Instant.parse("2026-10-20T12:00:00Z")
                            : beginn.plusSeconds(900)),
                    spaet ? "gemischt" : "direkt", menge, loch ? "unvollständig" : "vollständig");
            stand = ende;
        }
    }

    /** Drei Tageswerte um den 20.10.2026 — die Klasse eines Zeitraums über 90 Tage. */
    private static void tageswerte() {
        String[] tage = {"2026-10-19", "2026-10-20", "2026-10-21"};
        Instant[] beginne = {Instant.parse("2026-10-18T22:00:00Z"), TAG_VON,
                Instant.parse("2026-10-20T22:00:00Z")};
        BigDecimal stand = new BigDecimal("1000.000");
        for (int i = 0; i < 3; i++) {
            BigDecimal ende = stand.add(new BigDecimal("57.600"));
            root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, site_id, "
                            + "zeitzone, zeitzone_herkunft, beginn, ende, stunden, slots_erwartet, "
                            + "slots_vorhanden, slots_endgueltig, wertart, stand_anfang, stand_ende, "
                            + "erster_wert, letzter_wert, erhalten, erwartet, abdeckung_prozent, "
                            + "n_good, geraet_einbau, box, fassung, katalog, rolle, zustand, "
                            + "endgueltig_ab, version, n_nachgeliefert, letzte_eingangszeit, "
                            + "zustellart) VALUES (CAST(? AS date), ?, ?, ?, ?, 'Europe/Berlin', "
                            + "'standort', ?, ?, 24, 96, 96, 96, 'counter', ?, ?, ?, ?, 1430, 1440, "
                            + "99, 1430, ?, ?, 1, ?, 'fuehrend', 'endgueltig', ?, 1, 0, ?, 'direkt')",
                    tage[i], KB, IDS.get("K5"), KANAL, IDS.get("AN2"),
                    Timestamp.from(beginne[i]), Timestamp.from(beginne[i].plusSeconds(86400)),
                    stand, ende, stand, ende, IDS.get("EINBAU"), IDS.get("BOX"), KATALOG_DAMALS,
                    Timestamp.from(beginne[i].plusSeconds(86400).plus(Duration.ofDays(7))),
                    Timestamp.from(beginne[i].plusSeconds(86400)));
            stand = ende;
        }
    }

    /** Die BESTEHENDE 15-Minuten-Verdichtung der Box für die Reihe K-6 — Bestandsschutz. */
    private static void bestandsVerdichtung() {
        for (int i = 0; i < 40; i++) {
            Instant bucket = Instant.parse("2026-08-01T00:00:00Z").plus(Duration.ofDays(4L * i));
            root.update("INSERT INTO device_measurement_rollup_15m (bucket, tenant_id, site_id, "
                            + "device_id, point_key, aggregation_kind, avg_numeric, min_numeric, "
                            + "max_numeric, last_numeric, sample_count, positive_delta, "
                            + "catalog_version) "
                            + "VALUES (?, ?, ?, ?, ?, 'counter', 5, 4, 6, ?, 15, 2, '2026.09.11.1')",
                    Timestamp.from(bucket), KB, IDS.get("AN2"), IDS.get("BOX"), KANAL_BESTAND,
                    100.0 + i);
        }
    }

    /**
     * Die Ereignisse des 20.10.2026 — je Art eine, dazu eine FORTSCHREIBUNG derselben Lücke,
     * zwei Doppelzustellungen, ein Bestands-Spiegel und ein {@code rejected}, das nie im
     * Verlauf erscheinen darf.
     */
    private static void ereignisse() {
        UUID luecke = UUID.randomUUID();
        ereignis(luecke, "data_gap", "writer", "2026-10-20T08:15:00Z", "2026-10-20T08:15:00Z",
                null, Map.of("box", IDS.get("BOX").toString(), "komponente", IDS.get("K5").toString()),
                KANAL, "{\"erkannt_aus\":\"kadenz\"}", IDS.get("BOX"), null, IDS.get("K5"), false);
        // Fortschreibung: dieselbe Lücke, jetzt geschlossen — EIN Ereignis, nicht zwei.
        ereignis(luecke, "data_gap", "writer", "2026-10-20T08:15:00Z", "2026-10-20T08:15:00Z",
                "2026-10-20T08:25:00Z",
                Map.of("box", IDS.get("BOX").toString(), "komponente", IDS.get("K5").toString()),
                KANAL, "{\"erkannt_aus\":\"kadenz\"}", IDS.get("BOX"), null, IDS.get("K5"), false);

        ereignis(UUID.randomUUID(), "counter_reset", "writer", "2026-10-20T10:00:00Z", null, null,
                Map.of("komponente", IDS.get("K5").toString()), KANAL,
                "{\"stand_alt\":1083415.2,\"stand_neu\":0.0}", null, null, IDS.get("K5"), false);
        ereignis(UUID.randomUUID(), "device_boundary", "kunde", "2026-10-20T11:00:00Z", null, null,
                Map.of("komponente", IDS.get("K5").toString()), null,
                "{\"anlass\":\"zaehlerwechsel\",\"einbau_alt\":\"Z-5a\",\"einbau_neu\":\"Z-5b\","
                        + "\"eingetragen_am\":\"2026-10-20T11:05:00Z\"}",
                null, null, IDS.get("K5"), false);
        ereignis(UUID.randomUUID(), "late_arrival", "writer", "2026-10-20T12:00:00Z",
                "2026-10-20T12:00:00Z", "2026-10-20T12:15:00Z",
                Map.of("komponente", IDS.get("K5").toString()), KANAL,
                "{\"eingangszeit\":\"2026-11-12T09:02:00Z\",\"anzahl\":4}", null, null,
                IDS.get("K5"), false);
        for (int i = 0; i < 2; i++) {
            ereignis(UUID.randomUUID(), "duplicate_conflict", "writer",
                    "2026-10-20T13:0" + i + ":00Z", null, null,
                    Map.of("box", IDS.get("BOX").toString(), "komponente",
                            IDS.get("K5").toString()),
                    KANAL, "{\"messzeit\":\"2026-10-20T13:00:00Z\",\"gespeicherter_wert\":1.0,"
                            + "\"abgewiesener_wert\":1.1,\"sequenzen\":[1,2]}",
                    IDS.get("BOX"), null, IDS.get("K5"), false);
        }
        // Die Übergabe hängt an der DATENQUELLE und darf gar keine Komponente nennen (§4.8).
        ereignis(UUID.randomUUID(), "handover", "cloud", "2026-10-20T14:00:00Z",
                "2026-10-20T14:00:00Z", "2026-10-20T14:01:00Z",
                Map.of("datenquelle", IDS.get("DQ").toString()), null,
                "{\"anlass\":\"zustaendigkeitswechsel\",\"box_alt\":\"Halle 1\","
                        + "\"box_neu\":\"Halle 2\"}", null, IDS.get("DQ"), null, false);
        // Ein Gerätewechsel INNERHALB der Frist (17.01.2027) — bewusst AUSSERHALB des
        // Fingerabdruck-Fensters des 18.01., damit beide Proben getrennt bleiben.
        ereignis(UUID.randomUUID(), "device_boundary", "kunde", "2027-01-17T12:00:00Z", null, null,
                Map.of("komponente", IDS.get("K5").toString()), null,
                "{\"anlass\":\"zaehlerwechsel\",\"einbau_alt\":\"Z-5b\","
                        + "\"einbau_neu\":\"Z-5c\",\"eingetragen_am\":\"2027-01-17T12:05:00Z\"}",
                null, null, IDS.get("K5"), false);
        // Nie im Verlauf: eine Ablehnung der Datenannahme.
        ereignis(UUID.randomUUID(), "rejected", "datenannahme", "2026-10-20T15:00:00Z", null, null,
                Map.of("box", IDS.get("BOX").toString()), null,
                "{\"strom\":\"measurements\",\"grund\":\"schema_verletzt\"}", IDS.get("BOX"),
                null, null, false);
        // Der Bestands-Spiegel aus device_measurement_event — er steht schon im alten
        // Marker-Weg und darf nicht ein zweites Mal auftauchen. Seine Form ist vom CHECK
        // `messreihe_ereignis_bestand_chk` vorgeschrieben: NUR die Box, kein Reihen-Bezug.
        ereignis(UUID.randomUUID(), "data_gap", "box", "2026-10-20T08:15:00Z", null, null,
                Map.of("box", IDS.get("BOX").toString()), null,
                "{\"erkannt_aus\":\"verdraengung\"}", IDS.get("BOX"), null, null, true);
    }

    private static void ereignis(UUID ereignisId, String art, String urheber, String zeit,
            String von, String bis, Map<String, String> kennungen, String messkanal,
            String nutzlast, UUID box, UUID quelle, UUID entity, boolean ausBestand) {
        StringBuilder k = new StringBuilder("{");
        kennungen.forEach((s, v) -> k.append(k.length() > 1 ? "," : "")
                .append('"').append(s).append("\":\"").append(v).append('"'));
        k.append('}');
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, "
                        + "von, bis, site_id, kennungen, device_id, data_source_id, entity_id, "
                        + "messkanal, nutzlast, aus_bestand) "
                        + "VALUES (?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?::jsonb,?)",
                Timestamp.from(Instant.parse(zeit)), KB, ereignisId, art, urheber,
                von == null ? null : Timestamp.from(Instant.parse(von)),
                bis == null ? null : Timestamp.from(Instant.parse(bis)), IDS.get("AN2"),
                k.toString(), box, quelle, entity, messkanal, nutzlast, ausBestand);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
