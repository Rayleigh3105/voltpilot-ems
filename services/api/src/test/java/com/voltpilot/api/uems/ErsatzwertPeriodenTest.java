package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ersatzwert;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

class ErsatzwertPeriodenTest {
    @TestFactory
    List<DynamicTest> vektoren() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode v : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("ersatzwert_perioden")) {
            tests.add(DynamicTest.dynamicTest(v.path("name").asText(), () -> {
                JsonNode b = v.path("basis"), soll = v.path("expected");
                Ergebnis basis = new Ergebnis(zahl(b.get("menge")), null, null, null, null,
                        b.path("zustand").asText(), 15, 15, ganz(b.get("abdeckung_prozent")), saetze(b.get("kennzeichen")));
                List<ErsatzwertPerioden.Beitrag> beitraege = new ArrayList<>();
                for (JsonNode e : v.path("beitraege")) beitraege.add(new ErsatzwertPerioden.Beitrag(
                        zeit(e,"von"),zeit(e,"bis"),zahl(e.get("vorher")),zahl(e.get("nachher")),
                        saetze(e.get("vorher_kennzeichen")),saetze(e.get("nachher_kennzeichen")),
                        e.path("kennung").asText(),e.path("methode").asText()));
                Ergebnis ist = ErsatzwertPerioden.anwenden(basis,zeit(v,"von"),zeit(v,"bis"),beitraege);
                VerbrauchVectorsTest.zahl(v.path("why").asText(),soll.get("menge"),ist.menge());
                assertThat(ist.zustand()).isEqualTo(soll.path("zustand").asText());
                assertThat(ist.kennzeichen()).isEqualTo(saetze(soll.get("kennzeichen")));
                assertThat(ist.abdeckungProzent()).isEqualTo(ganz(soll.get("abdeckung_prozent")));
                assertThat(ist.erhalten()).isEqualTo(basis.erhalten());
                assertThat(ist.erwartet()).isEqualTo(basis.erwartet());
            }));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(9);
        return tests;
    }

    @Test
    void auswahlAllerBisherigenViertelstundenBleibtExaktGleich() throws Exception {
        JsonNode datei = VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS);
        for (JsonNode v : datei.path("ersatzwerte")) {
            JsonNode reihe = VerbrauchErsatzwertVectorsTest.reiheDesFalls(datei,v.path("fall").asText());
            List<Ersatzwert> eingang = VerbrauchErsatzwertVectorsTest.ersatzwerte(reihe,v,null);
            ZoneId zone = ZoneId.of(reihe.path("zeitzone").asText());
            if (eingang.stream().anyMatch(e -> ErsatzwertPerioden.periodenBetrag(e,zone))) continue;
            String regel = reihe.path("wertart").asText(), einheit = reihe.path("einheit").asText();
            assertThat(ErsatzwertPerioden.geltende(eingang,regel,einheit,Map.of(),zone)).as(v.path("name").asText())
                    .isEqualTo(VerbrauchRegeln.geltende(eingang,regel,einheit,Map.of()));
        }
    }

    @Test
    void monatsbetragHatKeineAnteileUndBlockiertUeberlappendeErsatzwerte() {
        Ersatzwert oktober = eingabe("EW-2026-9999","2026-09-30T22:00:00Z","2026-10-31T23:00:00Z");
        Ersatzwert spaeter = eingabe("EW-2026-10000","2026-10-20T08:00:00Z","2026-10-20T08:15:00Z");
        var g = ErsatzwertPerioden.geltende(List.of(spaeter,oktober),"intervallmenge","kWh",Map.of(),ZoneId.of("Europe/Berlin"));
        assertThat(g.gelten()).hasSize(1);
        assertThat(g.gelten().get(0).ersatzwert()).isEqualTo(oktober);
        assertThat(g.gelten().get(0).anteile()).isEmpty();
        assertThat(g.abgelehnt()).containsEntry(spaeter.kennung(),"ueberschneidet_ersatzwert");
    }

    @Test
    void mehrAlsEinKalendermonatBleibtAbgelehnt() {
        var e = eingabe("EW-2026-0001","2026-09-30T22:00:00Z","2026-11-01T23:00:00Z");
        var g = ErsatzwertPerioden.geltende(List.of(e),"intervallmenge","kWh",Map.of(),ZoneId.of("Europe/Berlin"));
        assertThat(g.abgelehnt()).containsEntry(e.kennung(),"betrag_fuer_mehrere_viertelstunden");
    }

    private static Ersatzwert eingabe(String k,String v,String b) {
        return new Ersatzwert(k,"wert_eingeben",Instant.parse(v),Instant.parse(b),"wirksam",null,null,null,null,
                new BigDecimal("2304"),"kWh",null,null,null);
    }
    private static BigDecimal zahl(JsonNode n) { return n == null || n.isNull() ? null : n.decimalValue(); }
    private static Integer ganz(JsonNode n) { return n == null || n.isNull() ? null : n.asInt(); }
    private static Instant zeit(JsonNode n,String feld) { return java.time.OffsetDateTime.parse(n.path(feld).asText()).toInstant(); }
    private static List<String> saetze(JsonNode n) { List<String> s=new ArrayList<>(); n.forEach(x->s.add(x.asText())); return s; }
}
