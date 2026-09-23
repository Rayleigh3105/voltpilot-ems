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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
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
        return liste(repo.jeEinsatz(einsatzId));
    }
    /**
     * Alle Messbedarfe, deren Energieeinsatz die Anfrage sieht; mit {@code standort} nur die, deren strukturierter Ort
     * heute an diesem Standort hängt. Ein Bedarf nur mit Ort-Wortlaut hat keinen Standort (der Wortlaut bleibt Wortlaut).
     * Ein unbekannter oder nicht lesbarer Standort ist 404.
     */
    public Liste alle(UUID standort) {
        if (standort != null) {
            if (!repo.standortSichtbar(standort)) throw EnergieeinsatzAbgelehnt.fehlt();
            rechte.pruefenLesen(RechtZiel.STANDORT, standort, EnergieeinsatzAbgelehnt::fehlt);
        }
        Map<UUID, Boolean> sichtbar = new HashMap<>();
        Liste alle = liste(repo.alle().stream().filter(b -> sichtbar.computeIfAbsent(b.einsatzId(),
                id -> einsaetze.finde(id).map(this::lesbar).orElse(false))).toList());
        if (standort == null) return alle;
        return new Liste(alle.messbedarfe().stream()
                .filter(b -> b.ortZiel() != null && standort.equals(b.ortZiel().standortId())).toList());
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
            UUID id=repo.anlegen(einsatzId,felder(wortlaut,a.ort(),a.groesse(),a.frist(),a.ortId(),
                    a.messgroesse(),a.richtung()),wer);
            melde("messbedarf_erfasst", repo.finde(id).orElseThrow().kennzeichen(), null);
            return dto(repo.finde(id).orElseThrow());
        });
    }
    public Bedarf bearbeiten(UUID einsatzId, UUID id, Bearbeiten a, ProtokollAkteur wer) {
        return tx.execute(s -> {
            bedarf(einsatzId,id); String wortlaut=pflicht(a.wortlaut(),"wortlaut_fehlt",
                    "Bitte beschreiben Sie, was gemessen werden soll.");
            var f=felder(wortlaut,a.ort(),a.groesse(),a.frist(),a.ortId(),a.messgroesse(),a.richtung());
            berichtsBelege.pruefeObjekt(id, BelegeImWeg.Gegenstand.MESSBEDARF);
            offen(repo.bearbeiten(id,f,wer));
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
        if (!lesbar(e)) throw EnergieeinsatzAbgelehnt.fehlt();
        return e;
    }
    private boolean lesbar(EnergieeinsatzRepository.Zeile e) {
        return rechte.lesbar(RechtZiel.UNTERNEHMEN,null) || einsaetze.messstellen(e.prozessId(), heute())
                .stream().anyMatch(m -> rechte.lesbar(RechtZiel.MESSSTELLE,m));
    }
    /**
     * Wortlaut und Struktur des Bedarfs. Fehlt der Wortlaut zu einer Struktur, entsteht er daraus — der Ort als
     * Kurzzeichen („G-1“), die Größe als „Wirkenergie · Bezug“ —, damit Bericht und Messabdeckung, die den Wortlaut
     * lesen, dasselbe zeigen wie bisher. Die Größe prüft der Katalog der Messstelle.
     */
    private MessbedarfRepository.Felder felder(String wortlaut, String ortText, String groesseText, LocalDate frist,
            UUID ortId, String messgroesse, String richtung) {
        String ort=text(ortText); UUID standortId=null, ortZiel=null;
        if (ortId!=null) {
            var o=repo.ortRef(ortId).orElseThrow(MessbedarfService::ortUnbekannt);
            boolean standort="standort".equals(o.art());
            rechte.pruefenLesen(standort?RechtZiel.STANDORT:RechtZiel.ORT,ortId,MessbedarfService::ortUnbekannt);
            if (standort) standortId=ortId; else ortZiel=ortId;
            if (ort==null) ort=o.kurzzeichen();
        }
        String g=text(messgroesse), r=text(richtung), groesse=text(groesseText);
        if (r!=null && g==null) throw groesseUngueltig();
        if (g!=null) {
            var eintrag=MessstelleRegeln.GROESSEN_KATALOG.stream().filter(k -> k.groesse().equals(g)).findFirst()
                    .orElseThrow(MessbedarfService::groesseUngueltig);
            if (r!=null && !eintrag.richtungen().contains(r)) throw groesseUngueltig();
            if (groesse==null) groesse=r==null?g:g+" · "+r;
        }
        return new MessbedarfRepository.Felder(wortlaut,ort,groesse,frist,standortId,ortZiel,g,r);
    }
    private static EnergieeinsatzAbgelehnt ortUnbekannt() {
        return abgelehnt("ort_unbekannt","Diesen Ort gibt es hier nicht. Bitte wählen Sie einen Standort, ein Gebäude oder einen Bereich.");
    }
    private static EnergieeinsatzAbgelehnt groesseUngueltig() {
        return abgelehnt("groesse_ungueltig","Diese Größe oder Richtung kennt der Katalog der Messstellen nicht.");
    }
    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs()
                .map(UnternehmenRepository.Unternehmen::zeitzone).orElse("Europe/Berlin")));
    }
    private MessbedarfRepository.Zeile bedarf(UUID einsatzId, UUID id) {
        einsatz(einsatzId);
        return repo.finde(id).filter(b -> b.einsatzId().equals(einsatzId)).orElseThrow(EnergieeinsatzAbgelehnt::fehlt);
    }
    private Liste liste(List<MessbedarfRepository.Zeile> zeilen) {
        var standorte=repo.standorteDerOrte(zeilen.stream().map(MessbedarfRepository.Zeile::ortId)
                .filter(java.util.Objects::nonNull).collect(Collectors.toSet()), heute());
        return new Liste(zeilen.stream().map(b -> dto(b,standorte)).toList());
    }
    private Bedarf dto(MessbedarfRepository.Zeile b) {
        return dto(b,b.ortId()==null?Map.of():repo.standorteDerOrte(Set.of(b.ortId()),heute()));
    }
    private Bedarf dto(MessbedarfRepository.Zeile b, Map<UUID,MessbedarfRepository.StandortRef> standorte) {
        OrtZiel ort=null;
        if (b.standortId()!=null) ort=new OrtZiel(b.standortId(),"standort",b.standortKurzzeichen(),b.standortName(),
                b.standortId(),b.standortName());
        else if (b.ortId()!=null) {
            var s=standorte.get(b.ortId());
            ort=new OrtZiel(b.ortId(),b.ortArt(),b.ortKurzzeichen(),b.ortName(),s==null?null:s.id(),s==null?null:s.name());
        }
        return new Bedarf(b.id(),b.kennzeichen(),b.einsatzId(),b.wortlaut(),b.ort(),b.groesse(),b.frist(),b.zustand(),
                b.messstelleId()==null?null:new Messstelle(b.messstelleId(),b.messstelleKennzeichen(),b.messstelleName()),
                b.begruendung(),b.akteur(),b.createdAt(),b.updatedAt(),ort,b.messgroesse(),b.richtung());
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
