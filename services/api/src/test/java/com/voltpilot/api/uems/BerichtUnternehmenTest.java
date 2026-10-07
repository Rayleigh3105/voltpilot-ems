package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Was ein Kostenstellen-Posten im Abzug des Unternehmens zitiert (Q6) und welche Verteilungs-Sätze er trägt - aus Tagen
 * oder, an einer Messstelle aus Ablesungen (Messen PR4, Verteilung 1.5), aus Monaten mit ihren Ablesezeiträumen
 * (Prüfung r4 M1). Die Route über Ablesung, Freigabe und Berichtigung prüft {@code BerichtApiTest}.
 */
class BerichtUnternehmenTest {

    private static final LocalDate JAN = LocalDate.parse("2026-01-01");
    private static final LocalDate SILVESTER = LocalDate.parse("2026-12-31");
    private static final BigDecimal HUNDERT = new BigDecimal("1E+2");

    @Test
    void einJahrMitAblesungenZitiertJedenTagSeinerZeitraeume_derMonatOhneAblesungSeinenKalendermonat() {
        KostenstelleEnergieDto.Posten p = posten(List.of(), List.of(
                monat("2026-10", HUNDERT, null, zeitraum("2026-10-01T07:15:00+02:00", "2026-11-02T07:40:00+01:00")),
                monat("2026-11", HUNDERT, null, zeitraum("2026-11-02T07:40:00+01:00", "2026-12-01T00:00:00+01:00")),
                monat("2026-12", HUNDERT, KostenstelleEnergieRegeln.GRUND_KEINE_ABLESUNG)));

        assertThat(saetze(p, JAN, SILVESTER)).as("der 02.11. gehört beiden Zeiträumen, eine Ablesung um 00:00 nicht")
                .containsExactly("2026-10-01…2026-12-31 100");
        assertThat(laeufe(p, JAN, SILVESTER)).containsExactly("2026-10-01…2026-12-31");
    }

    @Test
    void imMonatsberichtNurDieTageDerPeriode_auchWennDerZeitraumDarueberHinausreicht() {
        KostenstelleEnergieDto.Posten p = posten(List.of(), List.of(
                monat("2026-10", new BigDecimal("70"), null,
                        zeitraum("2026-09-28T07:15:00+02:00", "2026-11-02T07:40:00+01:00"))));
        LocalDate von = LocalDate.parse("2026-10-01");
        LocalDate bis = LocalDate.parse("2026-10-31");

        assertThat(saetze(p, von, bis)).containsExactly("2026-10-01…2026-10-31 70");
        assertThat(laeufe(p, von, bis)).containsExactly("2026-10-01…2026-10-31");
    }

    @Test
    void wechseltDerAnteilImAblesezeitraum_zitiertDerBerichtDieTage_ohneSatz() {
        KostenstelleEnergieDto.Posten p = posten(List.of(), List.of(
                monat("2026-10", HUNDERT, null, zeitraum("2026-10-01T07:15:00+02:00", "2026-11-02T07:40:00+01:00")),
                monat("2026-11", null, VerteilungRegeln.GRUND_ANTEIL_WECHSELT,
                        zeitraum("2026-11-02T07:40:00+01:00", "2026-12-01T07:00:00+01:00"))));

        assertThat(saetze(p, JAN, SILVESTER)).as("der Tag der Ablesung trägt den Anteil des Oktobers")
                .containsExactly("2026-10-01…2026-11-02 100");
        assertThat(laeufe(p, JAN, SILVESTER)).containsExactly("2026-10-01…2026-12-01");
    }

    @Test
    void einMonatOhneAnteil_istNichtZitiert() {
        KostenstelleEnergieDto.Posten p = posten(List.of(), List.of(
                monat("2026-10", null, VerteilungRegeln.GRUND_QUELLE_KEINE_WERTE,
                        zeitraum("2026-10-01T00:00:00+02:00", "2026-11-01T00:00:00+01:00"))));

        assertThat(saetze(p, JAN, SILVESTER)).isEmpty();
        assertThat(laeufe(p, JAN, SILVESTER)).isEmpty();
    }

    @Test
    void einPostenAusTagen_bleibtWieVorher_einTagOhneAnteilTrennt() {
        KostenstelleEnergieDto.Posten p = posten(List.of(
                tag("2026-10-01", "30"), tag("2026-10-02", "30"), tag("2026-10-03", null), tag("2026-10-04", "30"),
                tag("2026-10-05", "60")), null);
        LocalDate von = LocalDate.parse("2026-10-01");
        LocalDate bis = LocalDate.parse("2026-10-31");

        assertThat(saetze(p, von, bis)).containsExactly("2026-10-01…2026-10-02 30", "2026-10-04…2026-10-04 30",
                "2026-10-05…2026-10-05 60");
        assertThat(laeufe(p, von, bis)).containsExactly("2026-10-01…2026-10-02", "2026-10-04…2026-10-05");
    }

    // =============================================================================== Hilfen

    private static List<String> saetze(KostenstelleEnergieDto.Posten p, LocalDate von, LocalDate bis) {
        List<String> aus = new ArrayList<>();
        for (Object[] s : BerichtUnternehmen.saetze(BerichtUnternehmen.anteileJeTag(p, von, bis))) {
            aus.add(s[0] + "…" + s[1] + " " + ((BigDecimal) s[2]).stripTrailingZeros().toPlainString());
        }
        return aus;
    }

    private static List<String> laeufe(KostenstelleEnergieDto.Posten p, LocalDate von, LocalDate bis) {
        return BerichtUnternehmen.laeufe(List.copyOf(BerichtUnternehmen.anteileJeTag(p, von, bis).keySet())).stream()
                .map(l -> l[0] + "…" + l[1])
                .toList();
    }

    private static KostenstelleEnergieDto.Posten posten(List<KostenstelleEnergieDto.Tag> tage,
            List<KostenstelleEnergieDto.Monat> monate) {
        return new KostenstelleEnergieDto.Posten(new KostenstelleEnergieDto.MessstelleRef(UUID.randomUUID(), "MS-21",
                "Gas Heizung Verwaltung", "gemessen"), "Volumen", "Bezug", "m³", null, null, null, 1, List.of(),
                List.of(1), List.of(), tage, null, monate);
    }

    private static KostenstelleEnergieDto.Monat monat(String monat, BigDecimal anteil, String grund,
            KostenstelleEnergieDto.Ablesezeitraum... zeitraeume) {
        return new KostenstelleEnergieDto.Monat(monat, List.of(zeitraeume), anteil, null, null, "keine Werte", null, 1,
                grund, null);
    }

    private static KostenstelleEnergieDto.Ablesezeitraum zeitraum(String von, String bis) {
        return new KostenstelleEnergieDto.Ablesezeitraum(von, bis);
    }

    private static KostenstelleEnergieDto.Tag tag(String tag, String anteil) {
        return new KostenstelleEnergieDto.Tag(LocalDate.parse(tag), anteil == null ? null : new BigDecimal(anteil), null,
                null, "keine Werte", null, 1, null, null);
    }
}
