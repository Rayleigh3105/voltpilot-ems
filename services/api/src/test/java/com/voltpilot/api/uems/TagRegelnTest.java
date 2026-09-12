package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln der Endgültigkeit und der Tagesgrenze (UEMS AP-07 IP-13) — ohne Datenbank,
 * ohne Spring, ohne Uhr.
 *
 * <p>Die Zahlen der Zeitumstellung sind die des Auftrags: <b>25.10.2026 hat 25 Stunden</b> (100
 * Viertelstunden), <b>28.03.2027 hat 23</b> (92). Sie werden hier nicht nachgerechnet, sondern
 * BESTELLT — {@link TagRegeln#stunden} fragt {@link BezugsPeriode#stundenDesTages}, das
 * {@link VerbrauchRegeln#stunden} fragt (AP-08 IP-1). Dieser Test beweist, dass die Bestellung
 * ankommt.
 */
class TagRegelnTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    // ------------------------------------------------------------- Die Zeitumstellung

    /** Der 25-Stunden-Tag: die Rückstellung am 25.10.2026 macht aus 96 Slots 100. */
    @Test
    void derFuenfundzwanzigStundenTagHatHundertViertelstunden() {
        LocalDate tag = LocalDate.of(2026, 10, 25);
        assertThat(TagRegeln.stunden(tag, BERLIN)).isEqualTo(25);
        assertThat(TagRegeln.slotsErwartet(TagRegeln.stunden(tag, BERLIN))).isEqualTo(100);
        assertThat(TagRegeln.beginn(tag, BERLIN)).isEqualTo(Instant.parse("2026-10-24T22:00:00Z"));
        assertThat(TagRegeln.ende(tag, BERLIN)).isEqualTo(Instant.parse("2026-10-25T23:00:00Z"));
    }

    /** Der 23-Stunden-Tag: die Vorstellung am 28.03.2027 macht aus 96 Slots 92. */
    @Test
    void derDreiundzwanzigStundenTagHatZweiundneunzigViertelstunden() {
        LocalDate tag = LocalDate.of(2027, 3, 28);
        assertThat(TagRegeln.stunden(tag, BERLIN)).isEqualTo(23);
        assertThat(TagRegeln.slotsErwartet(TagRegeln.stunden(tag, BERLIN))).isEqualTo(92);
        assertThat(TagRegeln.beginn(tag, BERLIN)).isEqualTo(Instant.parse("2027-03-27T23:00:00Z"));
        assertThat(TagRegeln.ende(tag, BERLIN)).isEqualTo(Instant.parse("2027-03-28T22:00:00Z"));
    }

    /** Ein gewöhnlicher Tag bleibt 24 Stunden und 96 Viertelstunden. */
    @Test
    void einGewoehnlicherTagHatSechsundneunzig() {
        LocalDate tag = LocalDate.of(2026, 11, 3);
        assertThat(TagRegeln.stunden(tag, BERLIN)).isEqualTo(24);
        assertThat(TagRegeln.slotsErwartet(24)).isEqualTo(96);
    }

    /** Die Stundenzahl kommt WIRKLICH aus der Verbrauchsregel — eine Zählung, nicht zwei. */
    @Test
    void dieStundenzahlKommtAusDerVerbrauchsregel() {
        for (LocalDate tag : new LocalDate[] {
                LocalDate.of(2026, 10, 25), LocalDate.of(2027, 3, 28), LocalDate.of(2026, 11, 3)}) {
            assertThat((long) TagRegeln.stunden(tag, BERLIN))
                    .as(tag.toString())
                    .isEqualTo(VerbrauchRegeln.stunden(
                            TagRegeln.beginn(tag, BERLIN), TagRegeln.ende(tag, BERLIN)))
                    .isEqualTo(BezugsPeriode.stundenDesTages(tag, BERLIN));
        }
    }

    // ------------------------------------------------------------------- Die Zeitzone

    /** Ein Name außerhalb des Vokabulars wird VERWORFEN, nie aufgelöst. */
    @Test
    void eineFremdeZeitzoneWirdVerworfen() {
        assertThat(TagRegeln.zone("Europe/Vienna")).isEqualTo(ZoneId.of("Europe/Vienna"));
        assertThatThrownBy(() -> TagRegeln.zone("America/New_York"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("America/New_York");
    }

    /**
     * Die drei zugelassenen Zonen tragen heute denselben Versatz — die Tagesgrenze kann durch die
     * Wahl also nicht wandern. Gespeichert wird die Zone trotzdem (W10).
     */
    @Test
    void diedreiZugelassenenZonenErgebenDieselbeTagesgrenze() {
        LocalDate tag = LocalDate.of(2026, 10, 25);
        for (String name : TagRegeln.ZONEN) {
            ZoneId z = TagRegeln.zone(name);
            assertThat(TagRegeln.beginn(tag, z)).as(name)
                    .isEqualTo(TagRegeln.beginn(tag, BERLIN));
            assertThat(TagRegeln.stunden(tag, z)).as(name).isEqualTo(25);
        }
    }

    // ------------------------------------------------------------- Der UTC-Tag darüber

    /** Ein UTC-Tag berührt in Mitteleuropa immer genau zwei Ortstage. */
    @Test
    void einUtcTagBeruehrtHoechstensZweiOrtstage() {
        assertThat(TagRegeln.ortstageEinesUtcTages(LocalDate.of(2026, 11, 3), BERLIN))
                .containsExactly(LocalDate.of(2026, 11, 3), LocalDate.of(2026, 11, 4));
        // Und in UTC selbst genau einen — die Regel rechnet, sie behauptet nicht.
        assertThat(TagRegeln.ortstageEinesUtcTages(LocalDate.of(2026, 11, 3), ZoneId.of("UTC")))
                .containsExactly(LocalDate.of(2026, 11, 3));
    }

    // -------------------------------------------------------------------- Die Frist

    /**
     * Die Frist gehört dem INTERVALL: geschlossen ist es 7 Tage nach seinem ENDE — keine Sekunde
     * früher, und ohne dass eine Zeile dafür existieren müsste.
     */
    @Test
    void dieFristGehoertDemIntervallNichtDerZeile() {
        Instant beginn = Instant.parse("2026-11-03T13:00:00Z");
        Instant frist = ViertelstundeRegeln.endgueltigAb(beginn);
        assertThat(frist).isEqualTo(Instant.parse("2026-11-10T13:15:00Z"));
        assertThat(TagRegeln.geschlossen(beginn, frist.minusSeconds(1))).isFalse();
        // Genau auf der Frist IST sie abgelaufen (nicht „nach"): !isAfter.
        assertThat(TagRegeln.geschlossen(beginn, frist)).isTrue();
        assertThat(TagRegeln.geschlossen(beginn, frist.plusSeconds(1))).isTrue();
    }

    /** Die Frist des TAGES ist Tagesende + 7 Tage — dieselbe Spanne, eine Stufe höher. */
    @Test
    void dieFristDesTages() {
        Instant ende = TagRegeln.ende(LocalDate.of(2026, 10, 25), BERLIN);
        assertThat(TagRegeln.endgueltigAb(ende)).isEqualTo(Instant.parse("2026-11-01T23:00:00Z"));
        assertThat(TagRegeln.FRIST).isEqualTo(ViertelstundeRegeln.FRIST);
    }

    // ------------------------------------------------------------------- Der Zustand

    /** Ein Tag mit einer noch vorläufigen Viertelstunde ist selbst vorläufig. */
    @Test
    void einTagMitEinerVorlaeufigenViertelstundeIstVorlaeufig() {
        Instant frist = Instant.parse("2026-11-01T23:00:00Z");
        Instant danach = frist.plusSeconds(1);
        assertThat(TagRegeln.zustand(96, 95, frist, danach)).isEqualTo("vorlaeufig");
        assertThat(TagRegeln.zustand(96, 96, frist, danach)).isEqualTo("endgueltig");
    }

    /**
     * Und ein Tag, dessen Viertelstunden alle endgültig sind, dessen EIGENE Frist aber noch
     * läuft, ist trotzdem vorläufig: bis dahin kann noch eine fehlende Viertelstunde entstehen
     * (eine Lücke hat gar keine Zeile, IP-12).
     */
    @Test
    void vorDerTagesfristBleibtDerTagVorlaeufigAuchWennAlleSlotsEndgueltigSind() {
        Instant frist = Instant.parse("2026-11-01T23:00:00Z");
        assertThat(TagRegeln.zustand(90, 90, frist, frist.minusSeconds(1)))
                .isEqualTo("vorlaeufig");
        assertThat(TagRegeln.zustand(90, 90, frist, frist)).isEqualTo("endgueltig");
    }

    /** Ohne eine einzige Viertelstunde entsteht gar keine Aussage — schon gar keine endgültige. */
    @Test
    void einTagOhneViertelstundeIstNieEndgueltig() {
        assertThat(TagRegeln.zustand(0, 0, Instant.parse("2020-01-01T00:00:00Z"), Instant.now()))
                .isEqualTo("vorlaeufig");
    }
}
