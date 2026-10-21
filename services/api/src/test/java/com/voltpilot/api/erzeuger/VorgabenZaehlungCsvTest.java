package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.erzeuger.VorgabenRepository.LueckeZeile;
import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: die Zählung je Tag/Monat ({@link VorgabenZaehlung}) und „Vorgaben als CSV“ ({@link VorgabenCsv})
 * der UEMS-EZ-7-Vorgaben — über Mitternacht an beiden Tagen, Dauer nur mit dem Anteil, Energie je Tag, unbekannt
 * leer statt 0, de-DE-Zahlen mit Semikolon.
 */
class VorgabenZaehlungCsvTest {

    private static final UUID GERAET = UUID.fromString("00000000-0000-0000-0000-0000000000e7");
    private static final LocalDate TAG1 = LocalDate.parse("2026-10-21");
    private static final LocalDate TAG2 = LocalDate.parse("2026-10-22");

    private static Instant berlin(String lokal) {
        return java.time.LocalDateTime.parse(lokal).atZone(VorgabenAbleitung.ZONE).toInstant();
    }

    private static Zeile vorgabe(String urheber, String art, Integer teNr, String beginn, String ende,
            String gesehenBis, BigDecimal energie, Map<String, BigDecimal> jeTag, BigDecimal wert) {
        return new Zeile(UUID.randomUUID(), GERAET, teNr, urheber, art, berlin(beginn), true,
                ende == null ? null : berlin(ende), ende != null, berlin(gesehenBis), new BigDecimal("60.00"),
                new BigDecimal("159000"), new BigDecimal("158400"), new BigDecimal("200000"), energie,
                energie == null ? null : "pv_prognose", jeTag, wert, "fernwirktechnik", "bindend", false, false, 17, 18,
                List.of(), Map.of(), Map.of(), teNr == null ? null : "WR " + teNr);
    }

    @Test
    void ueberMitternachtZaehltEineVorgabeAnBeidenTagenMitIhremAnteil() {
        Zeile nacht = vorgabe("netzbetreiber", "p_begrenzung", null, "2026-10-21T23:00:00", "2026-10-22T01:00:00",
                "2026-10-22T01:00:00", new BigDecimal("3.000"),
                Map.of("2026-10-21", new BigDecimal("1.000"), "2026-10-22", new BigDecimal("2.000")),
                new BigDecimal("0.30"));
        Instant b1 = TAG1.atStartOfDay(VorgabenAbleitung.ZONE).toInstant();
        Instant b2 = TAG2.atStartOfDay(VorgabenAbleitung.ZONE).toInstant();
        Instant b3 = TAG2.plusDays(1).atStartOfDay(VorgabenAbleitung.ZONE).toInstant();

        ErzeugerVorgabenDto.Gruppe tag1 = VorgabenZaehlung.gruppen(List.of(nacht), b1, b2, TAG1, TAG1).get(0);
        ErzeugerVorgabenDto.Gruppe tag2 = VorgabenZaehlung.gruppen(List.of(nacht), b2, b3, TAG2, TAG2).get(0);
        assertThat(tag1.anzahl()).isEqualTo(1);
        assertThat(tag2.anzahl()).isEqualTo(1);
        assertThat(tag1.dauerS()).isEqualTo(3600);
        assertThat(tag2.dauerS()).isEqualTo(3600);
        assertThat(tag1.energieKwh()).isEqualByComparingTo("1");
        assertThat(tag2.energieKwh()).isEqualByComparingTo("2");
        assertThat(tag1.wertEur()).isEqualByComparingTo("0.10");
        assertThat(tag2.wertEur()).isEqualByComparingTo("0.20");
        // Der Monat sieht sie einmal, ganz.
        ErzeugerVorgabenDto.Gruppe monat = VorgabenZaehlung.gruppen(List.of(nacht), b1, b3, TAG1, TAG2).get(0);
        assertThat(monat.anzahl()).isEqualTo(1);
        assertThat(monat.dauerS()).isEqualTo(7200);
        assertThat(monat.energieKwh()).isEqualByComparingTo("3");
    }

    @Test
    void jeUrheberVereinigtUeberlappendeArtenUndLaesstEinheitenAus() {
        Zeile begrenzt = vorgabe("netzbetreiber", "p_begrenzung", null, "2026-10-21T10:00:00", "2026-10-21T12:00:00",
                "2026-10-21T12:00:00", new BigDecimal("5"), Map.of("2026-10-21", new BigDecimal("5")), null);
        Zeile cosphi = vorgabe("netzbetreiber", "q_vorgabe", null, "2026-10-21T11:00:00", "2026-10-21T13:00:00",
                "2026-10-21T13:00:00", null, Map.of(), null);
        // Läuft noch: belegt bis zur letzten Lesung, in der sie galt.
        Zeile abruf = vorgabe("direktvermarkter", "dv_aktivierung", null, "2026-10-21T14:00:00", null,
                "2026-10-21T14:30:00", null, Map.of(), null);
        Zeile einheit = vorgabe("direktvermarkter", "dv_aktivierung", 1, "2026-10-21T14:00:00", null,
                "2026-10-21T14:30:00", null, Map.of(), null);
        Instant b = TAG1.atStartOfDay(VorgabenAbleitung.ZONE).toInstant();
        Instant e = TAG2.atStartOfDay(VorgabenAbleitung.ZONE).toInstant();
        List<Zeile> alle = List.of(abruf, cosphi, einheit, begrenzt);

        List<ErzeugerVorgabenDto.JeUrheber> je = VorgabenZaehlung.jeUrheber(alle, b, e, TAG1, TAG1);
        assertThat(je).extracting(ErzeugerVorgabenDto.JeUrheber::urheber)
                .containsExactly("netzbetreiber", "direktvermarkter");
        assertThat(je.get(0).anzahl()).isEqualTo(2);
        assertThat(je.get(0).dauerS()).as("10–13 Uhr, die Überlappung einmal").isEqualTo(3 * 3600);
        assertThat(je.get(0).energieKwh()).isEqualByComparingTo("5");
        assertThat(je.get(1).anzahl()).as("die Einheit zählt nicht beim Urheber").isEqualTo(1);
        assertThat(je.get(1).dauerS()).isEqualTo(1800);
        assertThat(je.get(1).energieKwh()).as("keine Schätzung bekannt: leer, nie 0").isNull();

        List<ErzeugerVorgabenDto.Gruppe> gruppen = VorgabenZaehlung.gruppen(alle, b, e, TAG1, TAG1);
        assertThat(gruppen).extracting(g -> g.urheber() + "/" + g.art() + "/" + g.teNr()).containsExactly(
                "netzbetreiber/p_begrenzung/null", "netzbetreiber/q_vorgabe/null",
                "direktvermarkter/dv_aktivierung/null", "direktvermarkter/dv_aktivierung/1");
        assertThat(gruppen.get(1).ohneSchaetzung()).isEqualTo(1);
    }

    @Test
    void dieCsvSprichtDeutschMitDezimalkommaUndLaesstUnbekanntesLeer() {
        Zeile gore = vorgabe("netzbetreiber", "p_begrenzung", null, "2026-10-21T10:00:00", "2026-10-21T10:05:40",
                "2026-10-21T10:05:35", new BigDecimal("0.116"), Map.of("2026-10-21", new BigDecimal("0.116")),
                new BigDecimal("0.01"));
        Zeile nichtBereit = new Zeile(UUID.randomUUID(), GERAET, 2, "anlage", "nicht_bereit",
                berlin("2026-10-21T11:00:00"), false, null, false, berlin("2026-10-21T11:10:00"), null, null, null, null,
                null, null, Map.of(), null, "relais_ma", null, true, false, null, null,
                List.of("gasspeicher_leer", "wartung"), Map.of(), Map.of(), "Motor 2; Smartblock");
        LueckeZeile luecke = new LueckeZeile(UUID.randomUUID(), GERAET, "netzbetreiber", berlin("2026-10-21T10:30:00"),
                berlin("2026-10-21T10:40:00"), 3, false, 17, 21);

        List<String> zeilen = VorgabenCsv.zeilen(List.of(nichtBereit, gore), List.of(luecke));

        assertThat(zeilen.get(0)).startsWith("Urheber;Art;Einheit;Beginn;");
        assertThat(zeilen).hasSize(4);
        assertThat(zeilen).filteredOn(z -> !z.contains("\""))
                .allSatisfy(z -> assertThat(z.split(";", -1).length).isEqualTo(VorgabenCsv.SPALTEN.size()));
        assertThat(zeilen.get(1)).isEqualTo("Netzbetreiber;Wirkleistung begrenzt;ganze Anlage;"
                + "2026-10-21T10:00:00+02:00;ja;2026-10-21T10:05:40+02:00;ja;nein;340;60;159;158,4;200;0,116;"
                + "PV-Prognose der Anlage;0,01;Fernwirktechnik;bindend;nein;nein;17;18;;");
        assertThat(zeilen.get(2)).isEqualTo("Netzbetreiber;Datenlücke;ganze Anlage;2026-10-21T10:30:00+02:00;;"
                + "2026-10-21T10:40:00+02:00;;nein;600;;;;;;;;;;;nein;17;21;;3");
        // Läuft: Ende leer, Dauer bis zur letzten Lesung; ein Semikolon im Namen steht in Anführungszeichen.
        assertThat(zeilen.get(3)).isEqualTo("Anlage selbst;nicht bereit;\"Einheit 2 · Motor 2; Smartblock\";"
                + "2026-10-21T11:00:00+02:00;nein;;;ja;600;;;;;;;;Relais und mA;;ja;nein;;;"
                + "Gasspeicher leer, Wartung;");

        byte[] datei = VorgabenCsv.datei(List.of(gore), List.of());
        String text = new String(datei, StandardCharsets.UTF_8);
        assertThat(text).startsWith(VorgabenCsv.BOM + "Urheber;").endsWith(VorgabenCsv.ZEILENENDE);
    }

    @Test
    void zahlenOhneTausenderpunktUndUngerundet() {
        assertThat(VorgabenCsv.zahl(new BigDecimal("1234567.890"))).isEqualTo("1234567,89");
        assertThat(VorgabenCsv.zahl(BigDecimal.ZERO.setScale(3))).isEqualTo("0");
        assertThat(VorgabenCsv.zahl(null)).isEmpty();
        assertThat(VorgabenCsv.kw(new BigDecimal("159000"))).isEqualTo("159");
        assertThat(VorgabenCsv.kw(new BigDecimal("45"))).isEqualTo("0,045");
    }
}
