package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessbedarfDto;
import com.voltpilot.api.web.dto.MessbedarfDto.*;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** P1/P2: eine Person plant; eingelöst wird nur durch eine eingerichtete Messstelle im Zaun. */
@Service
public class MessbedarfService {
    private final MessbedarfRepository repo;
    private final EnergieeinsatzRepository einsaetze;
    private final UnternehmenRepository unternehmen;
    private final MessstelleRepository messstellen;
    private final MessstelleService messstelleService;
    private final MessreiheEreignisRepository ereignisse;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final BerichtsBelege berichtsBelege;

    public MessbedarfService(MessbedarfRepository repo, EnergieeinsatzRepository einsaetze,
            UnternehmenRepository unternehmen,
            MessstelleRepository messstellen, MessstelleService messstelleService,
            MessreiheEreignisRepository ereignisse, RechtPruefung rechte, ObjectMapper json,
            PlatformTransactionManager tm, BerichtsBelege berichtsBelege) {
        this.repo=repo; this.einsaetze=einsaetze; this.unternehmen=unternehmen; this.messstellen=messstellen;
        this.messstelleService=messstelleService; this.ereignisse=ereignisse;
        this.rechte=rechte; this.json=json; this.tx=new TransactionTemplate(tm);
        this.berichtsBelege=berichtsBelege;
    }

    public Liste liste(UUID einsatzId) {
        einsatz(einsatzId);
        return new Liste(repo.jeEinsatz(einsatzId).stream().map(this::dto).toList());
    }
    public MessbedarfDto.Protokoll protokoll(UUID einsatzId, UUID id) {
        bedarf(einsatzId,id);
        return new MessbedarfDto.Protokoll(repo.aenderungen(id).stream().map(a -> new MessbedarfDto.Aenderung(
                a.id(),a.art(),baum(a.alt()),baum(a.neu()),a.akteur(),a.zeit())).toList());
    }
    public Bedarf anlegen(UUID einsatzId, Anlegen a, ProtokollAkteur wer) {
        return tx.execute(s -> {
            einsatz(einsatzId); String wortlaut=pflicht(a.wortlaut(),"wortlaut_fehlt",
                    "Bitte beschreiben Sie, was gemessen werden soll.");
            UUID id=repo.anlegen(einsatzId,wortlaut,text(a.ort()),text(a.groesse()),a.frist(),wer);
            melde("messbedarf_erfasst", repo.finde(id).orElseThrow().kennzeichen(), null);
            return dto(repo.finde(id).orElseThrow());
        });
    }
    public Bedarf bearbeiten(UUID einsatzId, UUID id, Bearbeiten a, ProtokollAkteur wer) {
        return tx.execute(s -> {
            bedarf(einsatzId,id); String wortlaut=pflicht(a.wortlaut(),"wortlaut_fehlt",
                    "Bitte beschreiben Sie, was gemessen werden soll.");
            berichtsBelege.pruefeObjekt(id, BelegeImWeg.Gegenstand.MESSBEDARF);
            offen(repo.bearbeiten(id,wortlaut,text(a.ort()),text(a.groesse()),a.frist(),wer));
            return dto(repo.finde(id).orElseThrow());
        });
    }
    public Bedarf einloesen(UUID einsatzId, UUID id, Einloesen a, ProtokollAkteur wer) {
        return tx.execute(s -> {
            var b=bedarf(einsatzId,id);
            berichtsBelege.pruefeObjekt(id, BelegeImWeg.Gegenstand.MESSBEDARF);
            if (a.messstelleId()==null) throw abgelehnt("messstelle_fehlt","Bitte wählen Sie eine Messstelle.");
            if (messstellen.finde(a.messstelleId()).isEmpty()) throw EnergieeinsatzAbgelehnt.fehlt();
            rechte.pruefenLesen(RechtZiel.MESSSTELLE,a.messstelleId(),EnergieeinsatzAbgelehnt::fehlt);
            var m=messstelleService.eine(a.messstelleId());
            if (!m.fehlt().isEmpty() || "archiviert".equals(m.lebenszyklus()))
                throw abgelehnt("messstelle_nicht_eingerichtet",
                        "Der Messbedarf kann nur durch eine eingerichtete Messstelle eingelöst werden.");
            offen(repo.einloesen(id,a.messstelleId(),wer));
            melde("messbedarf_eingeloest",b.kennzeichen(),m.kennzeichen());
            return dto(repo.finde(id).orElseThrow());
        });
    }
    public Bedarf verwerfen(UUID einsatzId, UUID id, Verwerfen a, ProtokollAkteur wer) {
        return tx.execute(s -> {
            bedarf(einsatzId,id);
            berichtsBelege.pruefeObjekt(id, BelegeImWeg.Gegenstand.MESSBEDARF);
            String grund=pflicht(a.begruendung(),"begruendung_fehlt",
                    "Bitte begründen Sie, warum der Messbedarf verworfen wird.");
            offen(repo.verwerfen(id,grund,wer));
            return dto(repo.finde(id).orElseThrow());
        });
    }

    private EnergieeinsatzRepository.Zeile einsatz(UUID id) {
        var e=einsaetze.finde(id).orElseThrow(EnergieeinsatzAbgelehnt::fehlt);
        if (!(rechte.lesbar(RechtZiel.UNTERNEHMEN,null) || einsaetze.messstellen(e.prozessId(), heute())
                .stream().anyMatch(m -> rechte.lesbar(RechtZiel.MESSSTELLE,m)))) throw EnergieeinsatzAbgelehnt.fehlt();
        return e;
    }
    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs()
                .map(UnternehmenRepository.Unternehmen::zeitzone).orElse("Europe/Berlin")));
    }
    private MessbedarfRepository.Zeile bedarf(UUID einsatzId, UUID id) {
        einsatz(einsatzId);
        return repo.finde(id).filter(b -> b.einsatzId().equals(einsatzId)).orElseThrow(EnergieeinsatzAbgelehnt::fehlt);
    }
    private Bedarf dto(MessbedarfRepository.Zeile b) {
        return new Bedarf(b.id(),b.kennzeichen(),b.einsatzId(),b.wortlaut(),b.ort(),b.groesse(),b.frist(),b.zustand(),
                b.messstelleId()==null?null:new Messstelle(b.messstelleId(),b.messstelleKennzeichen(),b.messstelleName()),
                b.begruendung(),b.akteur(),b.createdAt(),b.updatedAt());
    }
    private void melde(String art,String bedarf,String messstelle) {
        ObjectNode e=json.createObjectNode().put("ereignis_id",UUID.randomUUID().toString()).put("art",art)
                .put("zeitpunkt",Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()).put("messbedarf",bedarf);
        if (messstelle!=null) e.put("messstelle",messstelle);
        var r=ereignisse.anhaengen(TenantContext.get(),null,EreignisVokabular.Urheber.KUNDE,e,null,null);
        if (r.ausgang()==MessreiheEreignisRepository.Ausgang.VERWORFEN)
            throw new IllegalStateException("Messbedarf-Ereignis verworfen: "+r);
    }
    private JsonNode baum(String s) { try { return s==null?null:json.readTree(s); }
        catch (JsonProcessingException e) { throw new IllegalStateException("Protokoll nicht lesbar",e); } }
    private static void offen(boolean ok) { if(!ok) throw new EnergieeinsatzAbgelehnt(409,"messbedarf_abgeschlossen",
            "Dieser Messbedarf ist bereits eingelöst oder verworfen."); }
    private static String pflicht(String s,String code,String msg) { String t=text(s); if(t==null) throw abgelehnt(code,msg); return t; }
    private static String text(String s) { return s==null||s.isBlank()?null:s.strip(); }
    private static EnergieeinsatzAbgelehnt abgelehnt(String code,String msg) {
        return new EnergieeinsatzAbgelehnt(422,code,msg); }
}
