package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.voltpilot.api.repo.HistoryRepository.CoverageRow;
import com.voltpilot.api.repo.HistoryRepository.GapRun;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

/**
 * Die Ereignis-Spur (F6) als reiner Unit-Test - kein Spring, keine DB, läuft
 * also immer. Sie beantwortet die Frage, die die Historie bisher offen ließ:
 * <em>warum</em> bricht dieser Balken ein?
 */
class EreignisseTest {

    /** Der 15.07.2026 in Berliner Zeit (Sommerzeit, UTC+2). */
    private static final HistoryRange.Window TAG =
            HistoryRange.DAY.window(LocalDate.parse("2026-07-15"));

    private static Instant t(String uhrzeit) {
        return Instant.parse("2026-07-15T" + uhrzeit + ":00Z");
    }

    private static ValueSlot slot(String uhrzeit, String value) {
        return new ValueSlot(t(uhrzeit), value == null ? null : new BigDecimal(value));
    }

    /** Aufeinanderfolgende Viertelstunden ab {@code startMinuteOfDayUtc}. */
    private static List<ValueSlot> lauf(Instant start, int slots, String value) {
        List<ValueSlot> out = new ArrayList<>();
        IntStream.range(0, slots).forEach(i -> out.add(new ValueSlot(
                start.plus(Duration.ofMinutes(15L * i)),
                value == null ? null : new BigDecimal(value))));
        return out;
    }

    private static CoverageRow row(String firstIn, String lastIn, String siteLast) {
        return new CoverageRow(t("00:00"), siteLast == null ? null : t(siteLast), 96,
                firstIn == null ? null : t(firstIn),
                lastIn == null ? null : t(lastIn), 0);
    }

    /** Der Abdeckungs-Block, wie ihn der Service für diesen Tag rechnet. */
    private static HistoryCoverageDto coverage(String expectedFrom, String expectedTo) {
        return new HistoryCoverageDto(t("00:00"), t("22:00"), t(expectedFrom), t(expectedTo),
                96, 96, 0, 15);
    }

    private static List<HistoryEventDto> build(List<ValueSlot> negativePrices,
            List<ValueSlot> curtail, List<ValueSlot> gridLimits, List<ValueSlot> gridCharges,
            List<GapRun> gaps, CoverageRow row, HistoryCoverageDto coverage) {
        return build(negativePrices, List.of(), curtail, gridLimits, gridCharges, gaps, row,
                coverage);
    }

    /** Wie oben, mit expliziten § 51a-„keine Vergütung"-Slots (Scheibe S4). */
    private static List<HistoryEventDto> build(List<ValueSlot> negativePrices,
            List<ValueSlot> keineVerguetung, List<ValueSlot> curtail, List<ValueSlot> gridLimits,
            List<ValueSlot> gridCharges, List<GapRun> gaps, CoverageRow row,
            HistoryCoverageDto coverage) {
        return Ereignisse.build(HistoryRange.DAY, negativePrices, keineVerguetung, curtail,
                gridLimits, gridCharges, gaps, row, coverage);
    }

    // ---- Fenster ---------------------------------------------------------------

    @Test
    void aufeinanderfolgendeSlotsWerdenEinFensterUndEineLueckeTrenntSie() {
        List<ValueSlot> slots = new ArrayList<>(lauf(t("10:00"), 4, "-30"));
        // 11:00 fehlt (Preis war positiv) -> zweites Fenster ab 11:15.
        slots.addAll(lauf(t("11:15"), 2, "-50"));

        List<Ereignisse.Run> runs = Ereignisse.runs(slots);

        assertThat(runs).hasSize(2);
        assertThat(runs.get(0).from()).isEqualTo(t("10:00"));
        assertThat(runs.get(0).to()).isEqualTo(t("11:00"));
        assertThat(runs.get(0).slots()).isEqualTo(4);
        assertThat(runs.get(1).from()).isEqualTo(t("11:15"));
        assertThat(runs.get(1).to()).isEqualTo(t("11:45"));
    }

    @Test
    void dauerWirdNieAls0StdGeschrieben() {
        assertThat(Ereignisse.dauer(Duration.ofMinutes(45))).isEqualTo("45 Min");
        assertThat(Ereignisse.dauer(Duration.ofMinutes(120))).isEqualTo("2 Std");
        assertThat(Ereignisse.dauer(Duration.ofMinutes(255))).isEqualTo("4 Std 15 Min");
        assertThat(Ereignisse.dauer(Duration.ZERO)).isEqualTo("0 Min");
    }

    // ---- die vier Slot-Arten ----------------------------------------------------

    @Test
    void negativePreiseWerdenEinFensterMitDemTiefstenPreis() {
        List<HistoryEventDto> events = build(lauf(t("11:00"), 16, "-53"), List.of(), List.of(),
                List.of(), List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("negativpreis");
            assertThat(e.start()).isEqualTo(t("11:00"));
            assertThat(e.end()).isEqualTo(t("15:00"));
            // -53 EUR/MWh = -5,3 ct/kWh, und die Zeit steht NICHT im Text (die
            // trägt die Oberfläche zeitraumgerecht davor).
            assertThat(e.text()).isEqualTo("Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh");
            // Die eine Zahl steht zusätzlich als Feld - ungerundet, in ct/kWh.
            assertThat(e.value()).isEqualByComparingTo("-5.3");
            assertThat(e.unit()).isEqualTo("ct/kWh");
            assertThat(e.planned()).isFalse();
            assertThat(e.minutes()).isEqualTo(240);
            assertThat(e.count()).isEqualTo(1);
            assertThat(e.days()).isEqualTo(1);
            assertThat(e.facts()).isEmpty();
        });
    }

    @Test
    void keineVerguetungTraegtKeineZahlNurDieDauer() {
        // § 51a (Konzept vp-fahrplan-eigenverbrauch-konzept §4.7/§9, Scheibe S4):
        // dieselbe Zonen-Lage wie oben, aber getrennt von „negativpreis" - kein
        // echter negativer Satz, also keine Zahl im Ereignis.
        List<HistoryEventDto> events = build(List.of(), lauf(t("10:00"), 19, "-40"), List.of(),
                List.of(), List.of(), List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("keine-verguetung");
            assertThat(e.start()).isEqualTo(t("10:00"));
            assertThat(e.text()).isEqualTo("Keine Vergütung (§ 51a EEG): 4 Std 45 Min");
            assertThat(e.value()).isNull();
            assertThat(e.unit()).isNull();
            assertThat(e.planned()).isFalse();
        });
    }

    @Test
    void negativpreisUndKeineVerguetungBleibenGetrenntAuchAmSelbenTag() {
        List<HistoryEventDto> events = build(lauf(t("06:00"), 4, "-20"),
                lauf(t("10:00"), 19, "-40"), List.of(), List.of(), List.of(), List.of(), null, null);

        assertThat(events).extracting(HistoryEventDto::type)
                .containsExactly("negativpreis", "keine-verguetung");
    }

    @Test
    void abregelungSagtDassSieGeplantIstUndNennnDieEnergie() {
        // 8 Viertelstunden x 12 kW x 0,25 h = 24 kWh.
        List<HistoryEventDto> events = build(List.of(), lauf(t("11:00"), 8, "12"), List.of(),
                List.of(), List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("abregelung");
            assertThat(e.text()).isEqualTo("PV-Abregelung eingeplant: 2 Std (24,0 kWh)");
            assertThat(e.value()).isEqualByComparingTo("24");
            assertThat(e.unit()).isEqualTo("kWh");
            // Aus dem Fahrplan, nicht gemessen - die Oberfläche sagt „geplant".
            assertThat(e.planned()).isTrue();
        });
    }

    @Test
    void netzgrenzeNenntDieNiedrigsteGemeldeteGrenze() {
        List<ValueSlot> slots = List.of(slot("08:00", "10"), slot("08:15", "4.2"),
                slot("08:30", "7"));

        List<HistoryEventDto> events =
                build(List.of(), List.of(), slots, List.of(), List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("netzgrenze");
            assertThat(e.text())
                    .isEqualTo("Netzgrenze gemeldet (§ 14a): 45 Min, höchstens 4,2 kW");
            assertThat(e.value()).isEqualByComparingTo("4.2");
            assertThat(e.unit()).isEqualTo("kW");
        });
    }

    @Test
    void netzladenSummiertDieAusDemNetzGeladeneEnergie() {
        List<HistoryEventDto> events = build(List.of(), List.of(), List.of(),
                lauf(t("02:00"), 6, "0.85"), List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("netzladen");
            assertThat(e.text())
                    .isEqualTo("Speicher aus dem Netz geladen: 1 Std 30 Min (ca. 5,1 kWh)");
            assertThat(e.value()).isEqualByComparingTo("5.1");
            assertThat(e.unit()).isEqualTo("kWh");
            assertThat(e.planned()).isFalse();
        });
    }

    @Test
    void netzladenUnterEinerHalbenKilowattstundeJeFensterIstKeinEreignis() {
        // 2 x 0,05 kWh = 0,1 kWh: der Fall „02.10. Netzladen 15 Min (ca. 0,1 kWh)"
        // aus dem Konzept - er erklärt keinen Balken. Genau 0,5 kWh zählt.
        List<ValueSlot> slots = new ArrayList<>(lauf(t("02:00"), 2, "0.05"));
        slots.addAll(lauf(t("04:00"), 2, "0.25"));

        List<HistoryEventDto> events =
                build(List.of(), List.of(), List.of(), slots, List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.start()).isEqualTo(t("04:00"));
            assertThat(e.value()).isEqualByComparingTo("0.5");
        });
    }

    @Test
    void dieNetzgrenzeWirdNurFuerTagUndWocheAusgewertet() {
        // Die Regel selbst ist der Zwilling von historieEreignisse.ts spurHinweis:
        // ohne sie läse sich das Fehlen eines Markers als „keine Netzgrenze".
        assertThat(Ereignisse.evaluatesGridLimit(HistoryRange.DAY)).isTrue();
        assertThat(Ereignisse.evaluatesGridLimit(HistoryRange.WEEK)).isTrue();
        assertThat(Ereignisse.evaluatesGridLimit(HistoryRange.MONTH)).isFalse();
        assertThat(Ereignisse.evaluatesGridLimit(HistoryRange.YEAR)).isFalse();
    }

    // ---- Fehlstellen ------------------------------------------------------------

    @Test
    void innenUndRandLueckenEntstehenAusDenselbenZahlenWieDerAbdeckungsSatz() {
        // Gemessen 01:00 bis 20:00, dazwischen ein Loch 08:00-10:15; die Anlage
        // hat SPÄTER wieder gemessen (siteLast > lastInWindow), also ist der
        // Schluss-Rand eine Lücke, kein stilles Gerät.
        CoverageRow row = new CoverageRow(t("00:00"), Instant.parse("2026-07-20T10:00:00Z"), 70,
                t("01:00"), t("20:00"), 1);
        HistoryCoverageDto coverage = coverage("00:00", "22:00");
        List<GapRun> gaps = List.of(new GapRun(t("08:00"), t("10:15")));

        List<HistoryEventDto> events =
                build(List.of(), List.of(), List.of(), List.of(), gaps, row, coverage);

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::start,
                        HistoryEventDto::end)
                .containsExactly(
                        tuple("datenluecke", t("00:00"), t("01:00")),
                        tuple("datenluecke", t("08:00"), t("10:15")),
                        tuple("datenluecke", t("20:15"), t("22:00")));
        assertThat(events.get(1).text()).isEqualTo("Datenlücke: 2 Std 15 Min ohne Messwerte");
        // Eine Lücke hat keine eigene Zahl - ihre Zahl ist die Dauer.
        assertThat(events.get(1).value()).isNull();
        assertThat(events.get(1).unit()).isNull();
        assertThat(events.get(1).minutes()).isEqualTo(135);
    }

    @Test
    void einAbbruchOhneSpaetereMessungIstEinStillesGeraet() {
        // lastInWindow == siteLast: die Anlage hat danach NIRGENDS mehr gemessen.
        CoverageRow row = row("00:00", "14:00", "14:00");

        List<HistoryEventDto> events = build(List.of(), List.of(), List.of(), List.of(),
                List.of(), row, coverage("00:00", "22:00"));

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.type()).isEqualTo("geraet-still");
            assertThat(e.start()).isEqualTo(t("14:15"));
            assertThat(e.text()).isEqualTo("Keine Messwerte mehr - das Gerät meldet sich nicht");
        });
    }

    @Test
    void ohneEineEinzigeMessungImZeitraumIstDerGanzeZeitraumEineLuecke() {
        CoverageRow row = new CoverageRow(t("00:00"), Instant.parse("2026-07-20T10:00:00Z"), 0,
                null, null, 0);

        List<HistoryEventDto> events = build(List.of(), List.of(), List.of(), List.of(),
                List.of(), row, coverage("00:00", "22:00"));

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::start,
                        HistoryEventDto::end)
                .containsExactly(tuple("datenluecke", t("00:00"), t("22:00")));
    }

    @Test
    void ohneAbdeckungWirdKeineLueckeBehauptetAberMarktEreignisseBleiben() {
        // Eine Anlage, die noch nie gemessen hat: eine „Datenlücke" wäre eine
        // Behauptung über etwas, das es nie gab - die Börsenpreise gab es sehr wohl.
        List<HistoryEventDto> events = build(lauf(t("11:00"), 4, "-10"), List.of(), List.of(),
                List.of(), List.of(new GapRun(t("08:00"), t("09:00"))), null, null);

        assertThat(events).extracting(HistoryEventDto::type).containsExactly("negativpreis");
    }

    // ---- Reihenfolge + Obergrenze ------------------------------------------------

    @Test
    void dieSpurIstChronologischUndKappteZuVieleFensterBeiDenLaengsten() {
        // 30 einzelne Netzlade-Viertelstunden (je durch eine Lücke getrennt) plus
        // EIN langes Fenster: das lange muss überleben, gekappt wird der Schwanz.
        List<ValueSlot> netzladen = new ArrayList<>(lauf(t("00:00"), 8, "1"));
        for (int i = 0; i < 30; i++) {
            netzladen.add(new ValueSlot(t("06:00").plus(Duration.ofMinutes(30L * i)),
                    new BigDecimal("1")));
        }
        List<ValueSlot> preise = lauf(t("03:00"), 2, "-5");

        List<HistoryEventDto> events =
                build(preise, List.of(), List.of(), netzladen, List.of(), null, null);

        assertThat(events).hasSize(Ereignisse.MAX_PER_TYPE + 1);
        assertThat(events).isSortedAccordingTo(
                java.util.Comparator.comparing(HistoryEventDto::start));
        assertThat(events.get(0).type()).isEqualTo("netzladen");
        assertThat(events.get(0).end()).isEqualTo(t("02:00"));
        assertThat(events).filteredOn(e -> e.type().equals("negativpreis")).hasSize(1);
    }

    @Test
    void dasFensterDesTagesIstBerlinerZeit() {
        // Nur zur Absicherung, dass die Testzeiten sinnvoll liegen: der Berliner
        // 15.07. beginnt um 22:00 UTC des Vortags.
        assertThat(TAG.from()).isEqualTo(Instant.parse("2026-07-14T22:00:00Z"));
        assertThat(TAG.to()).isEqualTo(Instant.parse("2026-07-15T22:00:00Z"));
    }

    // ---- Abendverkauf ----------------------------------------------------------

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** Ein Zeitpunkt der Nacht 04./05.09.2026 (Sommerzeit, UTC+2). */
    private static Instant n(String isoUtc) {
        return Instant.parse("2026-09-" + isoUtc + ":00Z");
    }

    private static Ereignisse.VerkaufSlotWert verkauf(String isoUtc, String kwh, String ct) {
        return new Ereignisse.VerkaufSlotWert(n(isoUtc), new BigDecimal(kwh),
                ct == null ? null : new BigDecimal(ct));
    }

    /** Die vier Verkaufs-Viertelstunden 19:45-20:45 Berlin, 13,7 kWh zu 13,6-13,9 ct. */
    private static List<Ereignisse.VerkaufSlotWert> abendVerkauf() {
        return List.of(
                verkauf("04T17:45", "3.425", "13.6"),
                verkauf("04T18:00", "3.425", "13.7"),
                verkauf("04T18:15", "3.425", "13.8"),
                verkauf("04T18:30", "3.425", "13.9"));
    }

    @Test
    void derAbendverkaufErzaehltDenVerkaufUndDieNachtDieIhmFolgte() {
        HistoryEventDto e = Ereignisse.abendverkauf(abendVerkauf(),
                new BigDecimal("52"), new BigDecimal("65"),
                n("05T00:45"), new BigDecimal("13.6"), new BigDecimal("3.40"),
                n("05T05:00"), BERLIN);

        assertThat(e).isNotNull();
        assertThat(e.type()).isEqualTo("abendverkauf");
        // start = erster Verkaufs-Slot, end = letzter + eine Viertelstunde.
        assertThat(e.start()).isEqualTo(n("04T17:45"));
        assertThat(e.end()).isEqualTo(n("04T18:45"));
        assertThat(e.text()).isEqualTo(
                "Abendverkauf 19:45 bis 20:45 · 13,7 kWh zu 13,6 bis 13,9 ct (1,88 €)."
                        + " Prognose für die Nacht 52 kWh, gemessen 65 kWh (+25 %)."
                        + " Speicher leer um 02:45; Netzbezug bis 07:00 13,6 kWh (3,40 €).");
        assertThat(e.value()).isEqualByComparingTo("13.7");
        assertThat(e.unit()).isEqualTo("kWh");
        assertThat(e.planned()).isTrue();
        // Dieselben Fakten als Liste - die Oberfläche zeigt sie statt des Absatzes.
        assertThat(e.facts()).extracting(HistoryEventDto.Fact::label, HistoryEventDto.Fact::value)
                .containsExactly(
                        tuple("Preis", "13,6 bis 13,9 ct/kWh"),
                        tuple("Erlös", "1,88 €"),
                        tuple("Nachtlast Prognose", "52 kWh"),
                        tuple("Nachtlast gemessen", "65 kWh (+25 %)"),
                        tuple("Speicher leer", "02:45"),
                        tuple("Netzbezug bis 07:00", "13,6 kWh (3,40 €)"));
    }

    @Test
    void ohneVerkaufOderUnterEinerKilowattstundeGibtEsKeinEreignis() {
        assertThat(Ereignisse.abendverkauf(List.of(), null, null, null, null, null,
                n("05T05:00"), BERLIN)).isNull();
        // 4 x 0,125 kWh = 0,5 kWh - ein halbes Kilowatt erklärt keine Nacht.
        List<Ereignisse.VerkaufSlotWert> winzig = abendVerkauf().stream()
                .map(s -> new Ereignisse.VerkaufSlotWert(s.slot(), new BigDecimal("0.125"),
                        s.ctKwh()))
                .toList();
        assertThat(Ereignisse.abendverkauf(winzig, new BigDecimal("52"), new BigDecimal("65"),
                n("05T00:45"), new BigDecimal("13.6"), new BigDecimal("3.40"),
                n("05T05:00"), BERLIN)).isNull();
    }

    @Test
    void einFehlenderFaktLaesstSeinenSatzWegStattIhnZuSchaetzen() {
        // Weder Prognose noch Boden noch Nachtbezug: NUR der Verkauf bleibt.
        HistoryEventDto nur = Ereignisse.abendverkauf(abendVerkauf(),
                null, null, null, null, null, n("05T05:00"), BERLIN);
        assertThat(nur.text()).isEqualTo(
                "Abendverkauf 19:45 bis 20:45 · 13,7 kWh zu 13,6 bis 13,9 ct (1,88 €).");
        // Ein fehlender Fakt fehlt auch in der Liste.
        assertThat(nur.facts()).extracting(HistoryEventDto.Fact::label)
                .containsExactly("Preis", "Erlös");

        // Der Speicher wurde NICHT leer -> kein Boden-Satz, der Bezug bleibt.
        HistoryEventDto ohneBoden = Ereignisse.abendverkauf(abendVerkauf(),
                new BigDecimal("52"), new BigDecimal("65"), null,
                new BigDecimal("13.6"), null, n("05T05:00"), BERLIN);
        assertThat(ohneBoden.text()).doesNotContain("Speicher leer")
                .endsWith("Netzbezug bis 07:00 13,6 kWh.");

        // Ohne einen einzigen Preis nennt der Text keinen - und keinen Erlös.
        List<Ereignisse.VerkaufSlotWert> preislos = abendVerkauf().stream()
                .map(s -> new Ereignisse.VerkaufSlotWert(s.slot(), s.kwh(), null))
                .toList();
        assertThat(Ereignisse.abendverkauf(preislos, null, null, null, null, null,
                n("05T05:00"), BERLIN).text())
                .isEqualTo("Abendverkauf 19:45 bis 20:45 · 13,7 kWh.");
    }

    @Test
    void einEinzigerPreisWirdNichtAlsSpanneGeschrieben() {
        List<Ereignisse.VerkaufSlotWert> gleich = abendVerkauf().stream()
                .map(s -> new Ereignisse.VerkaufSlotWert(s.slot(), s.kwh(), new BigDecimal("13.6")))
                .toList();
        assertThat(Ereignisse.abendverkauf(gleich, null, null, null, null, null,
                n("05T05:00"), BERLIN).text())
                .startsWith("Abendverkauf 19:45 bis 20:45 · 13,7 kWh zu 13,6 ct (1,86 €).");
    }

    // ---- Bündel ab der Woche ---------------------------------------------------

    private static List<HistoryEventDto> build(HistoryRange range, List<ValueSlot> negativePrices,
            List<ValueSlot> curtail, List<ValueSlot> gridCharges, List<GapRun> gaps,
            CoverageRow row, HistoryCoverageDto coverage) {
        return Ereignisse.build(range, negativePrices, List.of(), curtail, List.of(), gridCharges,
                gaps, row, coverage);
    }

    /** Ein Zeitpunkt im Juli 2026 (UTC, Berlin = UTC+2). */
    private static Instant juli(int tag, String uhrzeit) {
        return Instant.parse(String.format("2026-07-%02dT%s:00Z", tag, uhrzeit));
    }

    @Test
    void imMonatWerdenDieFensterEinesTagesJeArtEinEreignis() {
        // Zwei Netzlade-Fenster am 15.07. (1,2 und 1,0 kWh), eines am 16.07.
        List<ValueSlot> netzladen = new ArrayList<>(lauf(juli(15, "00:15"), 2, "0.6"));
        netzladen.addAll(lauf(juli(15, "02:00"), 2, "0.5"));
        netzladen.addAll(lauf(juli(16, "01:00"), 4, "0.5"));

        List<HistoryEventDto> events = build(HistoryRange.MONTH, List.of(), List.of(), netzladen,
                List.of(), null, null);

        assertThat(events).hasSize(2);
        assertThat(events.get(0)).satisfies(e -> {
            assertThat(e.type()).isEqualTo("netzladen");
            assertThat(e.start()).isEqualTo(juli(15, "00:15"));
            assertThat(e.end()).isEqualTo(juli(15, "02:30"));
            assertThat(e.count()).isEqualTo(2);
            assertThat(e.days()).isEqualTo(1);
            // Die Dauer ist die SUMME der Fenster, nicht start bis end.
            assertThat(e.minutes()).isEqualTo(60);
            assertThat(e.value()).isEqualByComparingTo("2.2");
            assertThat(e.text()).isEqualTo("Speicher aus dem Netz geladen: 2×, zusammen 1 Std (ca. 2,2 kWh)");
        });
        assertThat(events.get(1).count()).isEqualTo(1);
        assertThat(events.get(1).text()).isEqualTo("Speicher aus dem Netz geladen: 1 Std (ca. 2,0 kWh)");
    }

    @Test
    void derTagEinesBuendelsIstDerBerlinerTag() {
        // 22:30 UTC am 14.07. ist 00:30 Berlin am 15.07. - gehört zum 15.,
        // zusammen mit dem Fenster um 10:00 UTC.
        List<ValueSlot> preise = new ArrayList<>(lauf(juli(14, "22:30"), 2, "-10"));
        preise.addAll(lauf(juli(15, "10:00"), 2, "-20"));

        List<HistoryEventDto> events = build(HistoryRange.WEEK, preise, List.of(), List.of(),
                List.of(), null, null);

        assertThat(events).singleElement().satisfies(e -> {
            assertThat(e.count()).isEqualTo(2);
            assertThat(e.value()).isEqualByComparingTo("-2");
            assertThat(e.text()).isEqualTo("Negative Börsenpreise: 2×, zusammen 1 Std, bis -2,0 ct/kWh");
        });
    }

    @Test
    void imMonatWirdNichtGekapptSondernJederTagGezeigt() {
        // 30 Tage mit negativen Preisen - mehr als MAX_PER_TYPE. Im Tag würde
        // gekappt, im Monat steht JEDER Tag da (das war der Befund im Sommer).
        List<ValueSlot> preise = new ArrayList<>();
        for (int tag = 1; tag <= 30; tag++) {
            preise.addAll(lauf(juli(tag, "11:00"), 4, "-5"));
        }

        List<HistoryEventDto> events = build(HistoryRange.MONTH, preise, List.of(), List.of(),
                List.of(), null, null);

        assertThat(events).hasSize(30).allSatisfy(e -> assertThat(e.count()).isEqualTo(1));
        assertThat(30).isGreaterThan(Ereignisse.MAX_PER_TYPE);
    }

    @Test
    void imJahrZaehltDerServerJeMonatUndArt() {
        // Juli: drei Tage, am 05.07. zwei Fenster; August: ein Tag.
        List<ValueSlot> preise = new ArrayList<>(lauf(juli(5, "10:00"), 4, "-24"));
        preise.addAll(lauf(juli(5, "14:00"), 2, "-3"));
        preise.addAll(lauf(juli(12, "11:00"), 8, "-121"));
        preise.addAll(lauf(juli(26, "10:00"), 4, "-87"));
        preise.addAll(lauf(Instant.parse("2026-08-02T11:00:00Z"), 4, "-12"));
        // Abregelung im Juli an zwei Tagen (Plan, kW je Viertelstunde).
        List<ValueSlot> abregelung = new ArrayList<>(lauf(juli(6, "09:00"), 4, "8"));
        abregelung.addAll(lauf(juli(26, "09:00"), 4, "10"));

        List<HistoryEventDto> events = build(HistoryRange.YEAR, preise, abregelung, List.of(),
                List.of(), null, null);

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::count,
                        HistoryEventDto::days)
                .containsExactly(
                        tuple("negativpreis", 4, 3),
                        tuple("abregelung", 2, 2),
                        tuple("negativpreis", 1, 1));
        HistoryEventDto juliPreise = events.get(0);
        assertThat(juliPreise.value()).isEqualByComparingTo("-12.1");
        assertThat(juliPreise.minutes()).isEqualTo(270);
        assertThat(juliPreise.text())
                .isEqualTo("Negative Börsenpreise: an 3 Tagen, zusammen 4 Std 30 Min, bis -12,1 ct/kWh");
        HistoryEventDto juliAbregelung = events.get(1);
        assertThat(juliAbregelung.value()).isEqualByComparingTo("18");
        assertThat(juliAbregelung.planned()).isTrue();
        assertThat(juliAbregelung.text())
                .isEqualTo("PV-Abregelung eingeplant: an 2 Tagen, zusammen 2 Std (18,0 kWh)");
    }

    @Test
    void imMonatWerdenAuchLueckenJeTagGebuendeltDasStilleGeraetBleibtEinzeln() {
        HistoryCoverageDto monat = new HistoryCoverageDto(juli(1, "00:00"), juli(20, "10:00"),
                juli(1, "00:00"), juli(31, "22:00"), 2976, 2900, 3, 15);
        // Gemessen bis 20.07. 10:00, danach nichts mehr (siteLast == lastInWindow).
        CoverageRow row = new CoverageRow(juli(1, "00:00"), juli(20, "10:00"), 2900,
                juli(1, "00:00"), juli(20, "10:00"), 2);
        List<GapRun> gaps = List.of(
                new GapRun(juli(9, "06:00"), juli(9, "07:00")),
                new GapRun(juli(9, "09:00"), juli(9, "10:15")));

        List<HistoryEventDto> events = build(HistoryRange.MONTH, List.of(), List.of(), List.of(),
                gaps, row, monat);

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::count,
                        HistoryEventDto::minutes)
                .containsExactly(
                        tuple("datenluecke", 2, 135L),
                        tuple("geraet-still", 1, Duration.between(juli(20, "10:15"),
                                juli(31, "22:00")).toMinutes()));
        assertThat(events.get(0).text()).isEqualTo("Datenlücke: 2×, zusammen 2 Std 15 Min ohne Messwerte");
    }
}
