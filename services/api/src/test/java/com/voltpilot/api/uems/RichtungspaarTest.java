package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Regel hinter dem Richtungspaar (UEMS, Folgepaket zu AP-12 IP-5): eine Reihe, deren
 * Katalogkanal zwei Flussrichtungen in EINER Größe führt, speichert neben der Netto-Menge ihre
 * beiden Anteile — damit ein Bericht sie ABSCHREIBEN kann, statt sie neu zu rechnen
 * ({@code bericht.md} EW3). Ohne Docker: die Regel ist eine reine Funktion.
 */
class RichtungspaarTest {

    private static final MeasurementCatalog KATALOG = new MeasurementCatalog(new ObjectMapper());
    private static final Instant VON = Instant.parse("2026-10-01T00:00:00Z");
    private static final Instant BIS = Instant.parse("2026-10-01T01:00:00Z");

    /** Eine Viertelstunde mit ihrer vorzeichenbehafteten Menge. */
    private static VerbrauchRegeln.Werteteil viertelstunde(String beginn, String menge) {
        Instant von = Instant.parse(beginn);
        return new VerbrauchRegeln.Werteteil(
                new VerbrauchRegeln.Teilperiode(von, von.plusSeconds(900), null, null, null, null, null),
                menge == null ? null : new BigDecimal(menge), null, 0, false);
    }

    private static final List<VerbrauchRegeln.Werteteil> STUNDE = List.of(
            viertelstunde("2026-10-01T00:00:00Z", "4"),
            viertelstunde("2026-10-01T00:15:00Z", "-3"),
            viertelstunde("2026-10-01T00:30:00Z", "2.5"),
            viertelstunde("2026-10-01T00:45:00Z", "-1.5"));

    /** Der Wortschatz: die Spalte kennt Vorzeichen, das WORT kommt aus der Richtung des Kanals. */
    @Test
    void jedeRichtungHatIhreBeidenWoerter() {
        assertThat(MessstelleRegeln.RICHTUNGSPAAR.get("charge_discharge"))
                .containsEntry(MessstelleRegeln.ANTEIL_POSITIV, "Laden")
                .containsEntry(MessstelleRegeln.ANTEIL_NEGATIV, "Entladen");
        assertThat(MessstelleRegeln.RICHTUNGSPAAR.get("import_export"))
                .containsEntry(MessstelleRegeln.ANTEIL_POSITIV, "Bezug")
                .containsEntry(MessstelleRegeln.ANTEIL_NEGATIV, "Abgabe");
    }

    /**
     * Regel 7 bleibt, wie sie war: eine QUELLENBINDUNG darf {@code charge_discharge} weiterhin
     * nicht mit einem Anteil belegen. Das Richtungspaar der Verdichtung ist ein anderes Vokabular
     * und ändert an der Bindung nichts (MessstelleRegeln.ANTEIL_RICHTUNGEN).
     */
    @Test
    void dieBindungBleibtUnberuehrt() {
        assertThat(MessstelleRegeln.ANTEIL_RICHTUNGEN).containsOnlyKeys("import_export");
        assertThat(MessstelleRegeln.RICHTUNGSPAAR).containsOnlyKeys("import_export", "charge_discharge");
    }

    /**
     * ⚠ Der Befund, der den zweiten Schnitt aufhält: im gepackten Katalog (2026.09.16.1) trägt
     * JEDER Kanal mit zwei Richtungen {@code active_power} in W — einen Momentanwert; keiner ist
     * eine Intervallmenge. Seine Menge entsteht durch Integration der Leistung, und der Anteil
     * wäre die Integration von {@code max(0, P)} über die ROHWERTE. Auf dieser Ebene ist die
     * Viertelstunde schon zu EINER Energie verdichtet — ein Vorzeichenwechsel innerhalb einer
     * Viertelstunde wäre verloren. Darum sagt die Regel für einen Momentanwert lieber nichts, als
     * eine Näherung in einen Nachweis zu schreiben.
     */
    @Test
    void einMomentanwertBekommtKeinPaar() {
        assertThat(ViertelstundeRegeln.regelWort("gauge")).isEqualTo("momentanwert");
        assertThat(Richtungspaar.ausTeilen(KATALOG, "battery.active_power", "gauge", STUNDE, VON, BIS)).isNull();
    }

    /** Ein Zählerstand hat keine Vorzeichen-Teile: die Menge ist ein Zuwachs zweier Stände. */
    @Test
    void einZaehlerstandBekommtKeinPaar() {
        assertThat(ViertelstundeRegeln.regelWort("counter")).isEqualTo("zaehlerstand");
        assertThat(Richtungspaar.ausTeilen(KATALOG, "battery.active_power", "counter", STUNDE, VON, BIS)).isNull();
    }

    /** Die Zerlegung einer Intervallmenge: Σ max(0, Teil) und Σ max(0, −Teil), beide als Betrag. */
    @Test
    void dieAnteileSindDieBetraegeDerBeidenVorzeichen() {
        BigDecimal positiv = BigDecimal.ZERO;
        BigDecimal negativ = BigDecimal.ZERO;
        for (VerbrauchRegeln.Werteteil w : STUNDE) {
            positiv = positiv.add(VerbrauchRegeln.anteilDesWerts(w.summe(), MessstelleRegeln.ANTEIL_POSITIV));
            negativ = negativ.add(VerbrauchRegeln.anteilDesWerts(w.summe(), MessstelleRegeln.ANTEIL_NEGATIV));
        }
        assertThat(positiv).isEqualByComparingTo("6.5");
        assertThat(negativ).isEqualByComparingTo("4.5");
        // Und die Netto-Menge bleibt, was sie war — das Paar tritt neben sie, nie an ihre Stelle.
        assertThat(positiv.subtract(negativ)).isEqualByComparingTo("2.0");
    }

    /** Ein Kanal ohne zwei Richtungen sagt nichts — {@code null}, nie 0. */
    @Test
    void ohneZweiRichtungenGibtEsKeineAussage() {
        assertThat(Richtungspaar.ausTeilen(KATALOG, null, "intervallmenge", STUNDE, VON, BIS)).isNull();
        assertThat(Richtungspaar.zweiRichtungen(KATALOG, null)).isFalse();
    }

    /** Fehlt EIN Teil seinen Anteil, fehlt er der ganzen Periode (die Summe des Jahres). */
    @Test
    void eineLueckeMachtDieGanzeSummeUnbekannt() {
        Richtungspaar.Summe s = new Richtungspaar.Summe();
        s.nimm(new BigDecimal("7900"), new BigDecimal("7100"));
        assertThat(s.fertig()).isNotNull();
        s.nimm(null, null);
        assertThat(s.fertig()).as("ein Monat ohne Paar macht das Jahr unbekannt").isNull();
    }

    /** Ohne einen einzigen Teil gibt es keine Summe — eine leere Periode ist nicht 0/0. */
    @Test
    void ohneTeileGibtEsKeineSumme() {
        assertThat(new Richtungspaar.Summe().fertig()).isNull();
    }
}
