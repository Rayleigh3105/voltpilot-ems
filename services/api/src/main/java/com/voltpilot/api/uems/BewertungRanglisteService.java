package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BewertungMengenLeser.*;
import com.voltpilot.api.web.dto.BewertungRanglisteDto.*;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.math.MathContext;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** IP-9/IP-10: liest vorhandene Werte und urteilt; dieselbe RLS und Messstellen-Sichtbarkeit wie IP-4. */
@Service
public class BewertungRanglisteService {
    private final BewertungUmfangService umfang;
    private final UnternehmenRepository unternehmen;
    private final EnergieeinsatzRepository einsaetze;
    private final BewertungMengenRepository mengen;
    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final MessstelleWerteService werte;
    private final BilanzService bilanzen;
    private final RechtPruefung rechte;
    private final BewertungKriterienService kriterien;
    public BewertungRanglisteService(BewertungUmfangService umfang, UnternehmenRepository unternehmen,
            EnergieeinsatzRepository einsaetze, BewertungMengenRepository mengen, MessstelleRepository messstellen,
            MessstelleZuordnungRepository zuordnungen, MessstelleWerteService werte, BilanzService bilanzen,
            RechtPruefung rechte, BewertungKriterienService kriterien) {
        this.umfang=umfang; this.unternehmen=unternehmen; this.einsaetze=einsaetze; this.mengen=mengen;
        this.messstellen=messstellen; this.zuordnungen=zuordnungen; this.werte=werte; this.bilanzen=bilanzen;
        this.rechte=rechte; this.kriterien=kriterien;
    }
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    public Rangliste lesen(LocalDate von,LocalDate bis) {
        if (von==null || bis==null || von.isAfter(bis) || von.getDayOfMonth()!=1 || bis.getDayOfMonth()!=bis.lengthOfMonth())
            throw new BewertungUmfangAbgelehnt(400,"zeitraum_ungueltig","Bitte wählen Sie ganze Kalendermonate mit Anfang und Ende.");
        var u=umfang.lesen(null,bis);
        var unternehmenId=unternehmen.desKundenbereichs().orElseThrow(BewertungUmfangAbgelehnt::fehlt).id();
        var anlagenIds=u.anlagenImUmfang().stream().map(a -> a.id()).collect(Collectors.toSet());
        var standorte=u.standorte().stream().map(s -> s.id()).collect(Collectors.toSet());
        u.ausschluesse().stream().filter(a -> a.art().equals("standort")).forEach(a -> standorte.remove(a.verweis()));
        var traeger=u.traeger().stream().map(t -> t.name()).collect(Collectors.toSet());
        var anlagen = new ArrayList<AnlagenEingang>();
        if (traeger.contains("Strom")) for (var a : u.anlagenImUmfang()) {
            var monate=new ArrayList<BilanzDto.Bilanz>();
            for (YearMonth m=YearMonth.from(von); !m.isAfter(YearMonth.from(bis)); m=m.plusMonths(1))
                monate.add(bilanzen.bilanz(a.id(),"monat",m.atDay(1),ids -> rechte.alleLesbar(RechtZiel.MESSSTELLE,ids)));
            anlagen.add(new AnlagenEingang(a.id(),a.name(),List.copyOf(monate)));
        }
        var cache=new HashMap<UUID,MessstellenEingang>();
        var zeilen=new ArrayList<EinsatzEingang>();
        for (var e : einsaetze.jeUnternehmen(unternehmenId)) {
            if (!traeger.contains(e.traeger()) || e.gueltigBis()!=null
                    || mengen.prozessAusgeschlossen(u.id(),e.prozessId())) continue;
            var ids=mengen.messstellen(e.prozessId(),bis);
            if (u.teilansicht() && ids.stream().noneMatch(id -> rechte.lesbar(RechtZiel.MESSSTELLE,id))) continue;
            var ms=new ArrayList<MessstellenEingang>();
            for (var id : ids) {
                if (!rechte.lesbar(RechtZiel.MESSSTELLE,id)) continue;
                var m=messstellen.finde(id).orElse(null);
                if (m==null || !m.art().equals("gemessen") || m.archiviertAm()!=null || !m.medium().equals(e.traeger())) continue;
                var stellungen=MessstelleService.wirksam(zuordnungen.stellungen(id)).stream()
                        .filter(s -> !s.gueltigAb().isAfter(bis) && (s.gueltigBis()==null || !s.gueltigBis().isBefore(bis))).toList();
                UUID anlage=stellungen.stream().map(s -> s.siteId()).filter(anlagenIds::contains).findFirst().orElse(null);
                if (m.medium().equals("Strom") && !stellungen.isEmpty() && anlage==null) continue;
                boolean imOrt=mengen.imStandortUmfang(id,bis,standorte);
                if (anlage==null && !imOrt) continue;
                var gelesen=cache.get(id);
                if (gelesen==null) {
                    var w=werte.werte(m.kennzeichen(),"monat",von.toString(),bis.toString(),null);
                    gelesen=new MessstellenEingang(id,m.kennzeichen(),anlage,m.medium(),m.art(),true,false,w,
                            w.werte().stream().map(mengen::ersatz).toList());
                    cache.put(id,gelesen);
                }
                ms.add(gelesen);
            }
            zeilen.add(new EinsatzEingang(e.id(),e.kennzeichen(),e.name(),e.prozessId(),e.traeger(),List.copyOf(ms)));
        }
        var basis=BewertungMengenLeser.lesen(von,bis,u.id(),u.fassung(),u.teilansicht(),traeger.contains("Strom"),anlagen,zeilen);
        return urteilen(basis,anlagen,zeilen,kriterien.lesen());
    }

    private static Rangliste urteilen(Rangliste basis,List<AnlagenEingang> anlagen,List<EinsatzEingang> eingaenge,
            com.voltpilot.api.web.dto.BewertungKriterienDto.Fassung fassung) {
        int monate=(int)ChronoUnit.MONTHS.between(YearMonth.from(basis.von()),YearMonth.from(basis.bis()))+1;
        var w=fassung.werte();
        var regeln=new BewertungRegeln.Kriterien(w.get("K1").asText(),w.get("K2").asText(),w.get("K3").asText(),
                w.get("K5").asText(),w.get("K6").asText(),w.get("K7").asInt(),w.get("K8").asText(),w.get("mindest_monate").asInt());
        var roh=eingaenge.stream().collect(Collectors.toMap(EinsatzEingang::kennzeichen,x->x));
        var nenner=new BewertungRegeln.Nenner(basis.nenner().wert(),basis.nenner().vorhanden(),
                basis.nenner().gesamt(),basis.nenner().zustand());
        var herkunftNenner=new HerkunftNenner(basis.nenner().wert(),basis.nenner().anlagen(),bilanzwerte(anlagen));
        var strom=gruppe(basis.einsaetze(),"Strom",nenner,monate,regeln,roh,herkunftNenner,basis.von(),basis.bis(),fassung.fassung());
        var weitere=new ArrayList<Einsatz>();
        for (var g:basis.weitereTraeger().stream().collect(Collectors.groupingBy(Einsatz::traeger,LinkedHashMap::new,Collectors.toList())).entrySet())
            weitere.addAll(gruppe(g.getValue(),g.getKey(),nenner,monate,regeln,roh,null,basis.von(),basis.bis(),fassung.fassung()).einsaetze());
        return new Rangliste(basis.von(),basis.bis(),basis.umfangId(),basis.umfangFassung(),basis.teilansicht(),monate,
                new KriterienGrundlage(fassung.fassung(),fassung.werte()),new StandUrteil(strom.K7(),strom.K8()),
                basis.nenner(),basis.zugeordnet(),basis.rest(),basis.abdeckungProzent(),basis.zustand(),basis.anlagen(),
                strom.einsaetze(),List.copyOf(weitere));
    }

    private record Gruppe(List<Einsatz> einsaetze,String K7,String K8) {}
    @SuppressWarnings("unchecked")
    private static Gruppe gruppe(List<Einsatz> basis,String traeger,BewertungRegeln.Nenner nenner,int monate,
            BewertungRegeln.Kriterien kriterien,Map<String,EinsatzEingang> roh,HerkunftNenner herkunftNenner,
            LocalDate von,LocalDate bis,int kriterienFassung) {
        var datenlage=new HashMap<String,Datenlage>();
        var regelEingaenge=new ArrayList<BewertungRegeln.Einsatz>();
        for (var e:basis) {
            var d=datenlage(roh.get(e.kennzeichen()),von,bis);
            datenlage.put(e.kennzeichen(),d);
            regelEingaenge.add(new BewertungRegeln.Einsatz(e.kennzeichen(),e.menge(),d.roh(),
                    prozentRoh(e.ersatz(),e.menge()),null));
        }
        var result=BewertungRegeln.urteil(new BewertungRegeln.RanglisteEingang(nenner,traeger,monate,regelEingaenge,kriterien));
        var urteile=((List<Map<String,Object>>)result.get("einsaetze")).stream()
                .collect(Collectors.toMap(x->(String)x.get("kennung"),x->x));
        var aus=new ArrayList<Einsatz>();
        for (var e:basis) {
            var x=urteile.get(e.kennzeichen());
            var urteil=new Urteil((String)x.get("K1"),(String)x.get("K2"),(String)x.get("K3"),(String)x.get("K5"),(String)x.get("K6"));
            String vorschlag=(String)x.get("vorschlag");
            var h=new HerkunftEntwurf(zeitraum(von,bis),kriterienFassung,herkunftEingaenge(roh.get(e.kennzeichen())),
                    traeger.equals("Strom") ? herkunftNenner : null,urteil,vorschlag);
            aus.add(new Einsatz(e.id(),e.kennzeichen(),e.name(),e.prozessId(),e.traeger(),e.einheit(),e.menge(),e.zustand(),
                    e.ersatz(),e.ersatzProzent(),datenlage.get(e.kennzeichen()).anzeige(),e.anteilProzent(),
                    (String)x.get("kumuliert_zugeordnet_prozent"),e.anteilZustand(),(Integer)x.get("rang"),urteil,vorschlag,h,e.messstellen()));
        }
        return new Gruppe(List.copyOf(aus),(String)result.get("K7"),(String)result.get("K8"));
    }

    private record Datenlage(String roh,String anzeige) {}
    private static Datenlage datenlage(EinsatzEingang e,LocalDate von,LocalDate bis) {
        if (e==null || e.messstellen().isEmpty()) return new Datenlage(null,null);
        var jeMessstelle=new ArrayList<Map<LocalDate,String>>();
        for (var m:e.messstellen()) {
            var tage=new HashMap<LocalDate,String>();
            for (LocalDate datum=von;!datum.isAfter(bis);datum=datum.plusDays(1)) if (!tage.containsKey(datum)) {
                LocalDate gesucht=datum;
                var monat=m.werte().werte().stream().filter(x->YearMonth.from(tag(x.von())).equals(YearMonth.from(gesucht))).findFirst();
                if (monat.isPresent() && monat.get().zustand()!=null) tage.put(datum,monat.get().zustand());
            }
            jeMessstelle.add(tage);
        }
        int gesamt=0,vollstaendig=0;
        for (LocalDate tag=von;!tag.isAfter(bis);tag=tag.plusDays(1)) {
            gesamt++;
            LocalDate datum=tag;
            if (jeMessstelle.stream().allMatch(t->"vollständig".equals(t.get(datum)))) vollstaendig++;
        }
        return new Datenlage(prozentRoh(Integer.toString(vollstaendig),Integer.toString(gesamt)),
                BewertungRegeln.prozent(BigDecimal.valueOf(vollstaendig),BigDecimal.valueOf(gesamt)));
    }
    private static LocalDate tag(String wert) { return LocalDate.parse(wert.substring(0,10)); }
    private static String prozentRoh(String teil,String ganzes) {
        if (teil==null || ganzes==null || new BigDecimal(ganzes).signum()<=0) return null;
        return new BigDecimal(teil).multiply(BigDecimal.valueOf(100)).divide(new BigDecimal(ganzes),MathContext.DECIMAL128)
                .stripTrailingZeros().toPlainString();
    }
    private static String zeitraum(LocalDate von,LocalDate bis) {
        var a=YearMonth.from(von); var b=YearMonth.from(bis);
        return a.equals(b) ? a.toString() : a+"/"+b;
    }
    private static List<HerkunftEingang> herkunftEingaenge(EinsatzEingang e) {
        if (e==null) return List.of();
        var aus=new ArrayList<HerkunftEingang>();
        for (var m:e.messstellen()) for (var w:m.werte().werte())
            aus.add(new HerkunftEingang(m.kennzeichen(),w.von(),w.bis(),text(w.menge()),w.version(),w.zustand()));
        return List.copyOf(aus);
    }
    private static List<Bilanzwert> bilanzwerte(List<AnlagenEingang> anlagen) {
        var aus=new ArrayList<Bilanzwert>();
        for (var a:anlagen) for (var b:a.monate()) for (var h:b.hauptzaehler()) for (var abschnitt:h.abschnitte()) for (var w:abschnitt.werte()) {
            BigDecimal zufluss=fluss(w.zufluss()),abfluss=fluss(w.abfluss());
            String wert=zufluss==null || abfluss==null ? null : text(zufluss.subtract(abfluss));
            var eing=w.eingaenge().stream().map(x->new BilanzEingang(x.messstelle(),text(x.menge()),x.version(),x.zustand())).toList();
            String zustand=wert==null ? "unvollständig" : eing.stream().anyMatch(x->"mit Ersatzwert".equals(x.zustand())) ? "mit Ersatzwert" : "vollständig";
            int version=eing.stream().mapToInt(BilanzEingang::version).max().orElse(1);
            aus.add(new Bilanzwert(a.name(),w.von(),w.bis(),wert,version,zustand,eing));
        }
        return List.copyOf(aus);
    }
    private static BigDecimal fluss(BilanzDto.Summe s) {
        if (s.gesamt()==0) return BigDecimal.ZERO;
        return s.mitWerten()!=s.gesamt() || "unvollständig".equals(s.zustand()) ? null : s.menge();
    }
    private static String text(BigDecimal n) { return n==null ? null : n.stripTrailingZeros().toPlainString(); }
}
