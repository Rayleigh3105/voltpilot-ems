package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BewertungMengenLeser.*;
import com.voltpilot.api.web.dto.BewertungRanglisteDto.Rangliste;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** IP-9: liest vorhandene Werte; dieselbe RLS und Messstellen-Sichtbarkeit wie IP-4. */
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
    public BewertungRanglisteService(BewertungUmfangService umfang, UnternehmenRepository unternehmen,
            EnergieeinsatzRepository einsaetze, BewertungMengenRepository mengen, MessstelleRepository messstellen,
            MessstelleZuordnungRepository zuordnungen, MessstelleWerteService werte, BilanzService bilanzen, RechtPruefung rechte) {
        this.umfang=umfang; this.unternehmen=unternehmen; this.einsaetze=einsaetze; this.mengen=mengen;
        this.messstellen=messstellen; this.zuordnungen=zuordnungen; this.werte=werte; this.bilanzen=bilanzen; this.rechte=rechte;
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
        return BewertungMengenLeser.lesen(von,bis,u.id(),u.fassung(),u.teilansicht(),traeger.contains("Strom"),anlagen,zeilen);
    }
}
