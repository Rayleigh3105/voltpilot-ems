package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.time.Duration;
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
    /** Der Speicher-Kanal des Referenzgeräts — {@code charge_discharge}, also „Laden / Entladen“. */
    private static final String SPEICHER = "deye.hybrid_3p.battery.battery-power";

    private static VerbrauchRegeln.Rohwert roh(String zeit, String wert) {
        return new VerbrauchRegeln.Rohwert(Instant.parse(zeit), new BigDecimal(wert), true);
    }

    private static ViertelstundenTeile.Anteil anteil(String zeit, String p, String n) {
        return new ViertelstundenTeile.Anteil(Instant.parse(zeit),
                p == null ? null : new BigDecimal(p), n == null ? null : new BigDecimal(n));
    }

    /** Der Wortschatz: die Spalte kennt Vorzeichen, das WORT kommt aus der Richtung des Kanals. */
    /** Der Kanal, an dem die Regel hängt, ist wirklich ein Zwei-Richtungs-Kanal des Katalogs. */
    @Test
    void derSpeicherKanalFuehrtZweiRichtungen() {
        assertThat(Richtungspaar.zweiRichtungen(KATALOG, SPEICHER)).isTrue();
        assertThat(Richtungspaar.woerter(KATALOG, SPEICHER))
                .containsEntry(MessstelleRegeln.ANTEIL_POSITIV, "Laden");
    }

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
     * Der Anteil entsteht JE ROHWERT und vor jeder Verdichtung (AP-08 E15/M5) — das ist der Grund,
     * warum er in der Viertelstunde gebildet wird und nicht am Tag: eine Reihe, die innerhalb EINER
     * Viertelstunde von Laden auf Entladen wechselt, hat beide Anteile, obwohl ihre Energie nur
     * EINE Zahl mit EINEM Vorzeichen ist. Genau diese Zahl fiele einer Summe über
     * Viertelstunden-Vorzeichen zum Opfer.
     */
    @Test
    void derAnteilTrenntJeRohwert_auchInnerhalbEinerViertelstunde() {
        // 5 min +12 kW, 5 min −12 kW, 5 min +12 kW: die Energie der Viertelstunde ist NICHT null,
        // und beide Anteile sind es auch nicht.
        List<VerbrauchRegeln.Rohwert> werte = List.of(
                roh("2026-10-01T00:00:00Z", "12"),
                roh("2026-10-01T00:05:00Z", "-12"),
                roh("2026-10-01T00:10:00Z", "12"),
                roh("2026-10-01T00:15:00Z", "12"));
        BigDecimal[] paar = Richtungspaar.jeRohwert(KATALOG, SPEICHER, "gauge", true, werte,
                Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-01T00:15:00Z"), Duration.ofMinutes(5));
        assertThat(paar).as("ein Zwei-Richtungs-Kanal aus integrierter Leistung hat ein Paar").isNotNull();
        assertThat(paar[0]).as("Laden").isPositive();
        assertThat(paar[1]).as("Entladen - genau das, was eine Vorzeichen-Summe verloere").isPositive();
    }

    /** Ohne Integrations-Bindung gibt es gar keine Energie (E5) — also auch keinen Anteil. */
    @Test
    void ohneIntegrationGibtEsKeinenAnteil() {
        assertThat(Richtungspaar.jeRohwert(KATALOG, SPEICHER, "gauge", false, List.of(),
                Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-01T00:15:00Z"), Duration.ofMinutes(5)))
                .isNull();
    }

    /** Ein Zählerstand hat keine Vorzeichen-Teile: die Menge ist ein Zuwachs zweier Stände. */
    @Test
    void einZaehlerstandBekommtKeinPaar() {
        assertThat(ViertelstundeRegeln.regelWort("counter")).isEqualTo("zaehlerstand");
        assertThat(Richtungspaar.jeRohwert(KATALOG, SPEICHER, "counter", true, List.of(),
                Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-01T00:15:00Z"), Duration.ofMinutes(5)))
                .isNull();
    }

    /**
     * Ab der Tages-Ebene wird nur noch SUMMIERT: die Anteile stehen gespeichert je Viertelstunde.
     * Fehlt EINER, fehlt er der ganzen Periode — unbekannt ist keine Null.
     */
    @Test
    void derTagSummiertNurNoch() {
        List<ViertelstundenTeile.Anteil> drei = List.of(
                anteil("2026-10-01T00:00:00Z", "4", "1"),
                anteil("2026-10-01T00:15:00Z", "2.5", "0.5"),
                anteil("2026-10-01T00:30:00Z", "1", "3"));
        BigDecimal[] paar = Richtungspaar.ausTeilen(drei, VON, BIS);
        assertThat(paar[0]).isEqualByComparingTo("7.5");
        assertThat(paar[1]).isEqualByComparingTo("4.5");

        List<ViertelstundenTeile.Anteil> mitLuecke = List.of(
                anteil("2026-10-01T00:00:00Z", "4", "1"),
                new ViertelstundenTeile.Anteil(Instant.parse("2026-10-01T00:15:00Z"), null, null));
        assertThat(Richtungspaar.ausTeilen(mitLuecke, VON, BIS)).isNull();
        assertThat(Richtungspaar.ausTeilen(List.of(), VON, BIS)).as("keine Viertelstunde, keine Aussage").isNull();
    }

    /** Die Regel am einzelnen Wert: {@code max(0, P)} bzw. {@code max(0, −P)}, beide als Betrag. */
    @Test
    void derAnteilEinesWertsIstSeinBetragInEinerRichtung() {
        assertThat(VerbrauchRegeln.anteilDesWerts(new BigDecimal("4"), MessstelleRegeln.ANTEIL_POSITIV))
                .isEqualByComparingTo("4");
        assertThat(VerbrauchRegeln.anteilDesWerts(new BigDecimal("4"), MessstelleRegeln.ANTEIL_NEGATIV))
                .isEqualByComparingTo("0");
        assertThat(VerbrauchRegeln.anteilDesWerts(new BigDecimal("-3"), MessstelleRegeln.ANTEIL_NEGATIV))
                .isEqualByComparingTo("3");
        assertThat(VerbrauchRegeln.anteilDesWerts(null, MessstelleRegeln.ANTEIL_POSITIV))
                .as("kein Wert bleibt kein Wert").isNull();
    }

    /** Ein Kanal ohne zwei Richtungen sagt nichts — {@code null}, nie 0. */
    @Test
    void ohneZweiRichtungenGibtEsKeineAussage() {
        assertThat(Richtungspaar.jeRohwert(KATALOG, null, "gauge", true, List.of(), VON, BIS, Duration.ofMinutes(5)))
                .isNull();
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
