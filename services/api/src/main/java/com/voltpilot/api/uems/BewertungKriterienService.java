package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BewertungKriterienDto.*;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** KR1 / R15 / R17: Fassungen, zweite Person und Protokoll atomar; Anstoß erst IP-23. */
@Service
public class BewertungKriterienService {
    private static final ProtokollAkteur VORGABE = new ProtokollAkteur(null,"VoltPilot",null,"voltpilot");
    private final BewertungKriterienRepository repo;
    private final BewertungKriterienVertrag vertrag;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    public BewertungKriterienService(BewertungKriterienRepository repo, BewertungKriterienVertrag vertrag,
            UnternehmenRepository unternehmen, RechtPruefung rechte) {
        this.repo=repo; this.vertrag=vertrag; this.unternehmen=unternehmen; this.rechte=rechte;
    }
    @Transactional(readOnly=true)
    public Fassung lesen() {
        return wirksam(repo.fassungen(sichtbar()));
    }
    @Transactional(readOnly=true)
    public Historie historie() {
        var alle = repo.fassungen(sichtbar());
        return new Historie(alle.isEmpty() ? List.of(vorgabe()) : alle);
    }
    @Transactional
    public Fassung speichern(Speichern e, ProtokollAkteur wer) {
        if (e == null) throw BewertungKriterienAbgelehnt.anfrage();
        String grund = begruendung(e.begruendung());
        var werte = vertrag.pruefen(e.werte());
        UUID u = unternehmen.sperren().orElseThrow(BewertungKriterienAbgelehnt::fehlt);
        var alle = repo.fassungen(u);
        if (alle.stream().anyMatch(f -> f.freigabeStatus().equals("beantragt")))
            throw new BewertungKriterienAbgelehnt(409,"freigabe_offen","Bitte entscheiden Sie zuerst über die beantragte Fassung.");
        LocalDate tag = heute();
        if (alle.isEmpty()) {
            repo.anlegen(u,1,vertrag.vorgabe(),null,VORGABE,false,tag);
            repo.protokoll(u,1,"kriterien_angelegt",null,wer);
            alle = repo.fassungen(u);
        }
        int nummer = alle.getFirst().fassung()+1;
        String alt = repo.schnappschuss(u,wirksam(alle).fassung());
        boolean vieraugen = repo.vieraugen(u);
        if (!vieraugen) repo.aufheben(u);
        repo.anlegen(u,nummer,werte,grund,wer,vieraugen,tag);
        repo.protokoll(u,nummer,"kriterien_geaendert",alt,wer);
        return repo.fassungen(u).getFirst();
    }
    @Transactional
    public Fassung entscheiden(int nummer, boolean freigeben, String grund, ProtokollAkteur wer) {
        UUID u = unternehmen.sperren().orElseThrow(BewertungKriterienAbgelehnt::fehlt);
        var f = repo.fassungen(u).stream().filter(x -> x.fassung() == nummer).findFirst()
                .orElseThrow(BewertungKriterienAbgelehnt::fehlt);
        if (!f.freigabeStatus().equals("beantragt"))
            throw new BewertungKriterienAbgelehnt(409,"bereits_entschieden","Diese Fassung ist bereits entschieden.");
        if (wer.sub().equals(f.akteur().sub()))
            throw new BewertungKriterienAbgelehnt(403,"zweite_person_noetig","Freigabe durch eine zweite Person.");
        String begruendung = freigeben ? (grund == null || grund.isBlank() ? null : grund.strip()) : begruendung(grund);
        String alt = repo.schnappschuss(u,nummer);
        if (freigeben) repo.aufheben(u);
        repo.entscheiden(u,nummer,freigeben,begruendung,wer,heute());
        repo.protokoll(u,nummer,freigeben ? "kriterien_freigegeben" : "kriterien_abgelehnt",alt,wer);
        return repo.fassungen(u).stream().filter(x -> x.fassung() == nummer).findFirst().orElseThrow();
    }
    private UUID sichtbar() {
        UUID u = unternehmen.desKundenbereichs().orElseThrow(BewertungKriterienAbgelehnt::fehlt).id();
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN,null) && !repo.standortSichtbar(u))
            throw BewertungKriterienAbgelehnt.fehlt();
        return u;
    }
    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs().orElseThrow(BewertungKriterienAbgelehnt::fehlt).zeitzone()));
    }
    private Fassung wirksam(List<Fassung> alle) {
        return alle.stream().filter(f -> f.freigabeStatus().equals("freigegeben") && f.aufgehobenAm() == null)
                .findFirst().orElseGet(this::vorgabe);
    }
    private Fassung vorgabe() {
        var werte = vertrag.vorgabe();
        return new Fassung(1,werte,vertrag.kriterien(werte),"Vorgabe",null,null,VORGABE,false,
                "freigegeben",null,null,null,null,null);
    }
    private static String begruendung(String grund) {
        if (grund == null || grund.isBlank())
            throw new BewertungKriterienAbgelehnt(422,"begruendung_fehlt","Bitte begründen Sie die Änderung der Kriterien.");
        return grund.strip();
    }
}
