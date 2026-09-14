package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.uems.MessstelleWerteRegeln.Abgelehnt;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Grund;
import com.voltpilot.api.uems.WertVersionenRegeln.Fassung;
import com.voltpilot.api.uems.WertVersionenRegeln.Schluessel;
import com.voltpilot.api.uems.WertVersionenRegeln.VersionGibtEsNicht;
import com.voltpilot.api.uems.WertVersionenRegeln.Wahl;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln der Versionen im Lese-Modell (UEMS AP-08 IP-18) — mit den Kennungen, Namen und Zeitpunkten von F21
 * aus dem Referenzunternehmen Ahrenberg: EW-2026-0003 am 06.11. 11:20 eingetragen, am 20.11. 15:10 von Ines
 * Kaltenbach zurückgenommen („Profil aus Netzbetreiber-Lastgang verfügbar“) und durch EW-2026-0005 ersetzt.
 */
class WertVersionenRegelnTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Instant EINGETRAGEN = Instant.parse("2026-11-06T10:20:00Z");
    private static final Instant ZURUECK = Instant.parse("2026-11-20T14:10:00Z");
    private static final Instant ERSETZT = Instant.parse("2026-11-20T14:11:00Z");
    private static final List<Fassung> F21 = List.of(
            new Fassung("EW-2026-0003", 1, "wirksam", EINGETRAGEN),
            new Fassung("EW-2026-0003", 2, "zurueckgenommen", ZURUECK),
            new Fassung("EW-2026-0005", 1, "wirksam", ERSETZT));

    // ======================================================================= Welche Version

    @Test
    void ohneAngabeDieNeuesteMitAngabeGenauDieseUndVersionEinsImmer() {
        assertThat(WertVersionenRegeln.wahl(List.of(2, 3), null)).isEqualTo(new Wahl(3, 3));
        assertThat(WertVersionenRegeln.wahl(List.of(2, 3), 1)).isEqualTo(new Wahl(1, 3));
        assertThat(WertVersionenRegeln.wahl(List.of(2, 3), 2)).isEqualTo(new Wahl(2, 3));
        // Eine Periode ohne Korrektur hat genau eine Version.
        assertThat(WertVersionenRegeln.wahl(List.of(), null)).isEqualTo(new Wahl(1, 1));
    }

    /** Falle 1: Version 5, wo es drei gibt, ist nie leer und nie stillschweigend die höchste. */
    @Test
    void eineVersionDieEsNichtGibtIstNichtGespeichertUndNieDieHoechste() {
        Wahl w = WertVersionenRegeln.wahl(List.of(2, 3), 5);
        assertThat(w.gespeichert()).isFalse();
        assertThat(w.hoechste()).isEqualTo(3);
        assertThat(WertVersionenRegeln.wahl(List.of(), 2).gespeichert()).isFalse();
        assertThatThrownBy(() -> WertVersionenRegeln.pruefeVorhanden(5, 3))
                .isInstanceOfSatisfying(VersionGibtEsNicht.class, e -> {
                    assertThat(e.version()).isEqualTo(5);
                    assertThat(e.hoechste()).isEqualTo(3);
                    assertThat(e.getMessage()).isEqualTo(
                            "Version 5 gibt es für diesen Zeitraum nicht — die neueste ist Version 3.");
                });
        WertVersionenRegeln.pruefeVorhanden(3, 3);
        WertVersionenRegeln.pruefeVorhanden(1, 1);
        WertVersionenRegeln.pruefeVorhanden(null, 1);
    }

    @Test
    void eineSpaetereVersionIstAbZweiUndEineAngefragteAbEins() {
        assertThatThrownBy(() -> WertVersionenRegeln.wahl(List.of(1), null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> WertVersionenRegeln.wahl(List.of(), 0)).isInstanceOf(IllegalArgumentException.class);
    }

    // ================================================================= Welche Entscheidungen

    /** F21 Version 2: der Ersatzwert wirkt neu — seine eintragende Fassung ist die Entscheidung. */
    @Test
    void versionZweiIstDerEingetrageneErsatzwert() {
        assertThat(WertVersionenRegeln.entscheidungen(List.of(), List.of("EW-2026-0003"),
                new Schluessel("EW-2026-0003", 1), F21, Instant.parse("2026-11-06T10:25:00Z")))
                .containsExactly(new Schluessel("EW-2026-0003", 1));
    }

    /**
     * F21 Version 3: Widerruf und bessere Methode vor demselben Lauf sind EINE Version — sie besteht aus BEIDEN
     * Entscheidungen in der Reihenfolge, in der sie getroffen wurden, auch wenn der Anlass nur eine davon nennt.
     */
    @Test
    void versionDreiNenntWiderrufUndErsatzInIhrerReihenfolge() {
        Instant gebildet = Instant.parse("2026-11-20T14:15:00Z");
        List<Schluessel> erwartet = List.of(new Schluessel("EW-2026-0003", 2), new Schluessel("EW-2026-0005", 1));
        assertThat(WertVersionenRegeln.entscheidungen(List.of("EW-2026-0003"), List.of("EW-2026-0005"),
                new Schluessel("EW-2026-0003", 2), F21, gebildet)).containsExactlyElementsOf(erwartet);
        assertThat(WertVersionenRegeln.entscheidungen(List.of("EW-2026-0003"), List.of("EW-2026-0005"),
                new Schluessel("EW-2026-0005", 1), F21, gebildet)).containsExactlyElementsOf(erwartet);
    }

    /** Der Widerruf allein: Version 3 hat die Zahlen von Version 1 — und genau die Rücknahme als Entscheidung. */
    @Test
    void derWiderrufAlleinIstDieRuecknahme() {
        assertThat(WertVersionenRegeln.entscheidungen(List.of("EW-2026-0003"), List.of(),
                new Schluessel("EW-2026-0003", 2), F21.subList(0, 2), Instant.parse("2026-11-20T14:12:00Z")))
                .containsExactly(new Schluessel("EW-2026-0003", 2));
    }

    /** Eine Korrektur wirkt mit ihrer Freigabe; eine spätere Rücknahme gehört einer späteren Version. */
    @Test
    void eineKorrekturWirktMitIhrerFreigabeUndNichtMitEinerSpaeterenFassung() {
        List<Fassung> k = List.of(
                new Fassung("K-2027-0002", 1, "vorschlag", Instant.parse("2027-01-24T08:00:00Z")),
                new Fassung("K-2027-0002", 2, "freigegeben", Instant.parse("2027-01-25T09:05:00Z")),
                new Fassung("K-2027-0002", 3, "zurueckgenommen", Instant.parse("2027-02-01T09:00:00Z")));
        assertThat(WertVersionenRegeln.entscheidungen(List.of(), List.of("K-2027-0002"),
                new Schluessel("K-2027-0002", 2), k, Instant.parse("2027-01-25T09:10:00Z")))
                .containsExactly(new Schluessel("K-2027-0002", 2));
        assertThat(WertVersionenRegeln.entscheidungen(List.of("K-2027-0002"), List.of(),
                new Schluessel("K-2027-0002", 3), k, Instant.parse("2027-02-01T09:05:00Z")))
                .containsExactly(new Schluessel("K-2027-0002", 3));
    }

    /** Ohne lesbare Fassung bleibt der Anlass stehen — die Historie sagt dann, dass die Fassung fehlt. */
    @Test
    void derAnlassStehtImmerDa() {
        assertThat(WertVersionenRegeln.entscheidungen(List.of("K-2026-0009"), List.of("EW-2026-0010"),
                new Schluessel("EW-2026-0010", 1), List.of(), Instant.parse("2026-12-01T00:00:00Z")))
                .containsExactly(new Schluessel("EW-2026-0010", 1));
    }

    // =========================================================================== Warum

    /** Falle 3: das „warum“ ist der Text des Menschen zu DIESER Fassung — fehlt er, bleibt er leer, nie erfunden. */
    @Test
    void dasWarumIstDerTextDieserFassungUndFehltEhrlich() {
        assertThat(WertVersionenRegeln.begruendung(1, "Box-Tausch nach Defekt; Energiekarte hat weitergezählt", null))
                .isEqualTo("Box-Tausch nach Defekt; Energiekarte hat weitergezählt");
        assertThat(WertVersionenRegeln.begruendung(2, "Box-Tausch nach Defekt", "Profil aus Netzbetreiber-Lastgang "
                + "verfügbar")).isEqualTo("Profil aus Netzbetreiber-Lastgang verfügbar");
        // Eine Freigabe ohne Grund: die Begründung der anlegenden Fassung ist NICHT ihr Grund.
        assertThat(WertVersionenRegeln.begruendung(2, "Nachlieferung nach Endgültigkeit", null)).isNull();
        assertThat(WertVersionenRegeln.begruendung(2, null, "  ")).isNull();
        assertThat(WertVersionenRegeln.Vorgang.aus("K-2027-0002").wort()).isEqualTo("korrektur");
        assertThat(WertVersionenRegeln.Vorgang.aus("EW-2026-0003").wort()).isEqualTo("ersatzwert");
    }

    // ================================================================ Anfrage der Historie

    @Test
    void dieHistorieGiltGenauEinerGespeichertenPeriode() {
        assertThatThrownBy(() -> MessstelleWerteRegeln.historieForm("stunde", "2026-11-03", "2026-11-03"))
                .isInstanceOfSatisfying(Abgelehnt.class, e -> {
                    assertThat(e.ablehnung().feld()).isEqualTo("raster");
                    assertThat(e.ablehnung().grund()).isEqualTo(Grund.RASTER_OHNE_VERSIONEN);
                });
        MessstelleWerteRegeln.Zeitraum zwei = MessstelleWerteRegeln.zeitraum(
                MessstelleWerteRegeln.historieForm("tag", "2026-11-03", "2026-11-04"), BERLIN);
        assertThatThrownBy(() -> MessstelleWerteRegeln.einePeriode(zwei))
                .isInstanceOfSatisfying(Abgelehnt.class, e -> {
                    assertThat(e.ablehnung().feld()).isEqualTo("bis");
                    assertThat(e.ablehnung().grund()).isEqualTo(Grund.NICHT_GENAU_EINE_PERIODE);
                });
        MessstelleWerteRegeln.Zeitraum einer = MessstelleWerteRegeln.zeitraum(
                MessstelleWerteRegeln.historieForm("tag", "2026-11-03", "2026-11-03"), BERLIN);
        assertThat(MessstelleWerteRegeln.einePeriode(einer).von()).isEqualTo(Instant.parse("2026-11-02T23:00:00Z"));
    }
}
