package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.voltpilot.api.uems.BewertungMengenLeser.*;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class BewertungMengenLeserTest {
    @Test void teilmonatMitZahlBleibtUnvollstaendigUndErsatzIstTeilDerMenge() {
        var m=messstelle(List.of(wert("100","unvollständig"),wert("50","vollständig")),List.of(new BigDecimal("5"),BigDecimal.ZERO));
        var e=lesen(List.of(m)).einsaetze().getFirst();
        assertThat(e.menge()).isEqualTo("150");
        assertThat(e.zustand()).isEqualTo("unvollständig");
        assertThat(e.ersatz()).isEqualTo("5");
        assertThat(e.ersatzProzent()).isEqualTo("3.3");
    }
    @Test void unbekannteErsatzmengeWirdNichtZurNullUndFehlenderMonatBleibtSichtbar() {
        var m=messstelle(List.of(wert("100","mit Ersatzwert"),wert(null,"keine Werte")),Arrays.asList(null,null));
        var e=lesen(List.of(m)).einsaetze().getFirst();
        assertThat(e.menge()).isEqualTo("100");
        assertThat(e.zustand()).isEqualTo("unvollständig");
        assertThat(e.ersatz()).isNull();
        assertThat(e.ersatzProzent()).isNull();
        assertThat(e.messstellen().getFirst().monatswerte().werte()).hasSize(2);
    }
    @Test void keinMesspunktIstKeineNullUndNullNennerHatKeinenAnteil() {
        var a=lesen(List.of());
        assertThat(a.nenner().anlagen()).isEqualTo("0 von 0");
        assertThat(a.nenner().wert()).isEqualTo("0");
        assertThat(a.einsaetze().getFirst().menge()).isNull();
        assertThat(a.einsaetze().getFirst().zustand()).isEqualTo("keine Werte");
        assertThat(a.einsaetze().getFirst().rang()).isNull();
        assertThat(a.einsaetze().getFirst().anteilProzent()).isNull();
    }
    private static com.voltpilot.api.web.dto.BewertungRanglisteDto.Rangliste lesen(List<MessstellenEingang> ms) {
        return BewertungMengenLeser.lesen(LocalDate.of(2026,10,1),LocalDate.of(2026,11,30),null,null,false,true,List.of(),
                List.of(new EinsatzEingang(UUID.randomUUID(),"EE-1","Einsatz",UUID.randomUUID(),"Strom",ms)));
    }
    private static MessstellenEingang messstelle(List<MessstelleWerteDto.Wert> werte,List<BigDecimal> ersatz) {
        UUID id=UUID.randomUUID();
        var m=new MessstelleWerteDto.Messstelle(id,"MS-1","Messung","gemessen","Wirkenergie","Bezug","kWh","Zählerstand");
        return new MessstellenEingang(id,"MS-1",null,"Strom","gemessen",true,false,
                new MessstelleWerteDto.Werte(m,"monat","2026-10-01","2026-11-30","Europe/Berlin","standort",null,List.of(),werte,null),ersatz);
    }
    private static MessstelleWerteDto.Wert wert(String menge,String zustand) {
        return new MessstelleWerteDto.Wert("2026-10-01T00:00:00+02:00","2026-11-01T00:00:00+01:00","Oktober",745L,null,
                menge==null?null:new BigDecimal(menge),null,null,null,zustand,List.of(),null,null,null,"endgueltig",null,1,null,null,null,List.of(),null,1);
    }
}
