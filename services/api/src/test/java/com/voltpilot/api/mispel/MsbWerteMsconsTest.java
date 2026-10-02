package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;

/** MSCONS-Lastgänge des Messstellenbetreibers lesen (MiSpeL MP-15b): rein, ohne Datenbank. */
class MsbWerteMsconsTest {

    private static final String ZP = "DE0001234567890000000000000000002";
    private static final String ZP_NEU = "DE0001234567890000000000000000003";

    @Test
    void einMonatMit2976ViertelstundenLueckeUndZaehlerwechselErgibtDieselbenWerteWieDieCsv() {
        YearMonth dez = YearMonth.of(2026, 12);
        String mscons = MsbBeispiel.mscons(dez, List.of(ZP, ZP_NEU), "bezug", 0.300, "abgabe", 0.200,
                LocalDate.of(2026, 12, 15), LocalDate.of(2026, 12, 3));
        MsbWerteMscons.Gelesen g = MsbWerteMscons.lesen(mscons);

        assertThat(g.version()).isEqualTo("2.5");
        assertThat(g.werte().stream().filter(w -> w.richtung().equals("bezug")).count()).isEqualTo(2976);
        // Abgabe am 03.12. 10–12 Uhr: vier Viertelstunden fehlen, vier sind Ersatzwerte — acht Lücken.
        assertThat(g.werte().stream().filter(w -> w.richtung().equals("abgabe")).count()).isEqualTo(2976 - 8);
        assertThat(g.uebergangen()).isEqualTo(4);
        assertThat(g.werte().get(0).beginn()).isEqualTo(Instant.parse("2026-11-30T23:00:00Z"));
        assertThat(g.werte().get(0).kwh()).isEqualByComparingTo("0.300");
        // Zählerwechsel zum 15.12. (Ortszeit): der alte Zählpunkt bis 14.12. 23:45, der neue ab 15.12. 00:00.
        Map<String, List<Instant>> jeZp = g.werte().stream().filter(w -> w.richtung().equals("bezug"))
                .collect(Collectors.groupingBy(MsbWerteCsv.Wert::zaehlpunkt,
                        Collectors.mapping(MsbWerteCsv.Wert::beginn, Collectors.toList())));
        assertThat(jeZp.get(ZP)).hasSize(14 * 96).last().isEqualTo(Instant.parse("2026-12-14T22:45:00Z"));
        assertThat(jeZp.get(ZP_NEU)).hasSize(17 * 96).first().isEqualTo(Instant.parse("2026-12-14T23:00:00Z"));
        assertThat(jeZp.get(ZP_NEU)).last().isEqualTo(Instant.parse("2026-12-31T22:45:00Z"));

        // Dieselben Viertelstunden wie die CSV des Gegenstücks aus MP-15.
        List<MsbWerteCsv.Wert> csv = MsbWerteCsv.lesen(MsbBeispiel.csv(dez, List.of(ZP, ZP_NEU), "bezug", 0.300,
                "abgabe", 0.200, LocalDate.of(2026, 12, 15), LocalDate.of(2026, 12, 3)));
        assertThat(schluessel(g.werte())).isEqualTo(schluessel(csv));
    }

    @Test
    void derTagDerZeitumstellungImOktoberHat100Viertelstunden() {
        List<MsbWerteCsv.Wert> w = MsbWerteMscons.lesen(MsbBeispiel.msconsTag(LocalDate.of(2026, 10, 25), ZP, false))
                .werte();
        List<Instant> bezug = beginne(w, "bezug");
        assertThat(bezug).hasSize(100).doesNotHaveDuplicates();
        assertThat(bezug.get(0)).isEqualTo(Instant.parse("2026-10-24T22:00:00Z"));
        assertThat(bezug.get(99)).isEqualTo(Instant.parse("2026-10-25T22:45:00Z"));
        assertThat(beginne(w, "abgabe")).hasSize(100);
        // Dieselbe Datei in Ortszeit: 02:00–03:00 kommt zweimal vor, mit ?+02 und ?+01 — dieselben Viertelstunden.
        assertThat(MsbWerteMscons.lesen(MsbBeispiel.msconsTag(LocalDate.of(2026, 10, 25), ZP, true)).werte())
                .isEqualTo(w);
    }

    @Test
    void derTagDerZeitumstellungImMaerzHat92Viertelstunden() {
        List<MsbWerteCsv.Wert> w = MsbWerteMscons.lesen(MsbBeispiel.msconsTag(LocalDate.of(2027, 3, 28), ZP, false))
                .werte();
        List<Instant> bezug = beginne(w, "bezug");
        assertThat(bezug).hasSize(92).doesNotHaveDuplicates();
        assertThat(bezug.get(0)).isEqualTo(Instant.parse("2027-03-27T23:00:00Z"));
        assertThat(bezug.get(91)).isEqualTo(Instant.parse("2027-03-28T21:45:00Z"));
        assertThat(MsbWerteMscons.lesen(MsbBeispiel.msconsTag(LocalDate.of(2027, 3, 28), ZP, true)).werte())
                .isEqualTo(w);
    }

    @Test
    void eineNachrichtOhneUnaMitFreigabezeichenEinheitUndBlindarbeit() {
        // Vorgabe-Trennzeichen ohne UNA, alles in einer Zeile, ?+ und ?: im Text, Blindarbeit wird übergangen.
        String datei = "UNB+UNOC:3+9900000000003:500+9900000000010:500+261102:0605+R1++TL'"
                + "UNH+M1+MSCONS:D:04B:UN:2.4c'BGM+7+MSI1+9'DTM+137:202611020605?+00:303'"
                + "NAD+MS+9900000000003::293'CTA+IC+:Stadtwerke Muster ?+ Co?'s'UNS+D'NAD+DP'"
                + "LOC+172+" + ZP + "'DTM+163:202610312300?+00:303'DTM+164:202611302300?+00:303'"
                + "LIN+1'PIA+5+1-1?:3.29.0:SRW'QTY+220:0.040:KVR'DTM+163:202610312300?+00:303'"
                + "DTM+164:202610312315?+00:303'"
                + "LIN+2'PIA+5+1-1?:1.29.0:SRW'QTY+220:1.250:KWH'DTM+163:202610312300?+00:303'"
                + "DTM+164:202610312315?+00:303'QTY+220:0:KWH'DTM+163:202610312315?+00:303'"
                + "DTM+164:202610312330?+00:303'STS+Z33++Z84'"
                + "UNT+25+M1'UNZ+1+R1'";
        MsbWerteMscons.Gelesen g = MsbWerteMscons.lesen(datei);
        assertThat(g.version()).isEqualTo("2.4c");
        assertThat(g.werte()).containsExactly(
                new MsbWerteCsv.Wert(ZP, "bezug", Instant.parse("2026-10-31T23:00:00Z"), new BigDecimal("1.250")),
                new MsbWerteCsv.Wert(ZP, "bezug", Instant.parse("2026-10-31T23:15:00Z"), new BigDecimal("0")));
        assertThat(g.uebergangen()).isZero();
        // Ein Dezimalkomma aus UNA.
        String komma = "UNA:+,? '" + datei.replace("1.250", "1,250").replace("0.040", "0,040");
        assertThat(MsbWerteMscons.lesen(komma).werte().get(0).kwh()).isEqualByComparingTo("1.25");
    }

    @Test
    void dasFormatErkenntDerImportAmAnfangDerDatei() {
        assertThat(MsbWerteMscons.istEdifact(bytes("UNA:+.? 'UNB+UNOC:3'"))).isTrue();
        assertThat(MsbWerteMscons.istEdifact(bytes("UNB+UNOC:3+…'"))).isTrue();
        assertThat(MsbWerteMscons.istEdifact(bytes("﻿\r\n  UNA:+.? '"))).isTrue();
        assertThat(MsbWerteMscons.istEdifact(bytes("zeitstempel;zaehlpunkt;richtung;kwh\n"))).isFalse();
        assertThat(MsbWerteMscons.istEdifact(bytes("# UNB\nzeitstempel;zaehlpunkt;richtung;kwh\n"))).isFalse();
        assertThat(MsbWerteMscons.istEdifact(bytes("UN"))).isFalse();
    }

    @Test
    void fehlerNennenGrundUndSegment() {
        String gut = MsbBeispiel.msconsTag(LocalDate.of(2026, 11, 2), ZP, false);
        // Segmente: UNB 1, UNH 2, … LOC 12, DTM 13/14, RFF 15, LIN 16, PIA 17, QTY 18, DTM 19, DTM 20, QTY 21 …
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("MSCONS:D:04B:UN:2.5", "UTILMD:D:11A:UN:S2.1")),
                "nachrichtentyp", 2, "UTILMD-Nachricht");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace(":2.5'", ":2.4b'")), "version", 2, "2.4b");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.substring(0, gut.indexOf("QTY+220", gut.length() / 2) + 5)), "unvollstaendig", null,
                "abgeschnitten");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("UNZ+1+MSB4711'\n", "")), "unvollstaendig", 0, "ohne UNZ");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("UNT\\+\\d+", "UNT+7")), "unvollstaendig", null,
                "UNT nennt 7 Segmente");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("DTM\\+164:202611012315", "DTM+164:202611020000")),
                "intervall", 18, "keine Viertelstunde");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("QTY\\+220:0.250", "QTY+220:0.250:KWT")), "einheit",
                18, "KWT");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("QTY\\+220:0.250", "QTY+220:-0.250")), "kwh", 18,
                "nie negativ");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("LOC+172+" + ZP, "LOC+172+51238696788")), "zaehlpunkt", 12,
                "Marktlokation");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("202611012300\\?\\+00:303'\nDTM\\+164:202611012315",
                "202611012300:203'\nDTM+164:202611012315")), "zeitstempel", 19, "303");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replaceFirst("QTY\\+220:0.250'\nDTM\\+163:202611012300",
                "QTY+220:0.250'\nDTM+163:202611012307")), "zeitstempel", 18, "kein Beginn einer Viertelstunde");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("1-1?:1.29.0", "1-1?:3.29.0")
                .replace("1-1?:2.29.0", "1-1?:4.29.0")), "obis", 0, "1-1:3.29.0, 1-1:4.29.0");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("QTY+220:", "QTY+67:")), "kein_wahrer_wert", 0,
                "nur 192 Ersatz");
        abgelehnt(() -> MsbWerteMscons.lesen(gut.replace("LIN+2'\nPIA+5+1-1?:2.29.0", "LIN+2'\nPIA+5+1-1?:1.29.0")),
                "doppelt", null, "zweimal");
        abgelehnt(() -> MsbWerteMscons.lesen(" \n"), "leer", 0, "leer");
    }

    // ------------------------------------------------------------------ Hilfen

    private static void abgelehnt(ThrowingCallable lesen, String grund, Integer segment, String satz) {
        assertThatThrownBy(lesen).isInstanceOfSatisfying(MsbWerteCsv.Ungueltig.class, e -> {
            assertThat(e.grund()).as(e.getMessage()).isEqualTo(grund);
            if (segment != null) {
                assertThat(e.zeile()).as(e.getMessage()).isEqualTo(segment);
            }
            assertThat(e.getMessage()).contains(satz);
        });
    }

    private static List<Instant> beginne(List<MsbWerteCsv.Wert> w, String richtung) {
        return w.stream().filter(x -> x.richtung().equals(richtung)).map(MsbWerteCsv.Wert::beginn).toList();
    }

    /** Zählpunkt, Richtung, Beginn und Menge (ohne Nachkommanullen) je Wert — unabhängig von der Reihenfolge. */
    private static java.util.Set<String> schluessel(List<MsbWerteCsv.Wert> w) {
        Function<MsbWerteCsv.Wert, String> k = x -> x.zaehlpunkt() + "|" + x.richtung() + "|" + x.beginn() + "|"
                + x.kwh().stripTrailingZeros().toPlainString();
        return w.stream().map(k).collect(Collectors.toCollection(HashSet::new));
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
