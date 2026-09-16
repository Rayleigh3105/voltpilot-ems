package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ImportUebernahmeRepository.Aenderung;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** C6/C7: erneut prüfen unter derselben Mandantensperre wie IP-7, dann alles oder nichts schreiben. */
@Service
public class ImportUebernahmeService {
    private final ImportVorschauService vorschauen;
    private final BezugsgroesseRepository bezuege;
    private final BezugswertRepository werte;
    private final ImportUebernahmeRepository repo;
    private final MessreiheEreignisRepository ereignisse;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;

    public ImportUebernahmeService(ImportVorschauService vorschauen, BezugsgroesseRepository bezuege,
            BezugswertRepository werte, ImportUebernahmeRepository repo, MessreiheEreignisRepository ereignisse,
            RechtPruefung rechte, ObjectMapper json, PlatformTransactionManager manager) {
        this.vorschauen=vorschauen; this.bezuege=bezuege; this.werte=werte; this.repo=repo;
        this.ereignisse=ereignisse; this.rechte=rechte; this.json=json; this.tx=new TransactionTemplate(manager);
    }

    public record Bestaetigung(String vorschau, Map<Integer,String> entscheidungen, String begruendung, String teiluebernahme) {}
    public record Ergebnis(String kennung, String status, int aenderungen, int vorschlaege,
            BezugsdatenRegeln.Zaehler zaehler) {}

    public Ergebnis uebernehmen(byte[] datei, String name, ImportVorschau.Zuordnung zuordnung,
            Bestaetigung anfrage, ProtokollAkteur wer) {
        if (anfrage == null) throw BezugsgroesseAbgelehnt.anfrage("bestaetigung");
        return tx.execute(t -> {
            UUID tenant=TenantContext.get();
            boolean vier=werte.vierAugenGesperrt(tenant);
            bezuege.kundenbereichSperren(tenant);
            var v=vorschauen.vorschau(datei,name,zuordnung);
            if (!ImportVorschau.KENNUNG_GUELTIG.equals(ImportVorschau.kennungPruefen(anfrage.vorschau(),tenant,
                    v.vorschau().ergebnisFingerabdruck(),Instant.now()))) {
                throw BezugsgroesseAbgelehnt.anfrage("vorschau");
            }
            if (v.datei().befund()!=null || v.zeilen().isEmpty()) throw BezugsgroesseAbgelehnt.anfrage("datei");
            Map<Integer,String> entscheidungen=anfrage.entscheidungen()==null ? Map.of() : anfrage.entscheidungen();
            for (var e:entscheidungen.entrySet()) {
                if (e.getValue()==null || !List.of("behalten","ersetzen").contains(e.getValue()) || v.zeilen().stream()
                        .noneMatch(z -> z.nr()==e.getKey() && "konflikt".equals(z.urteil()))) {
                    throw BezugsgroesseAbgelehnt.anfrage("entscheidungen");
                }
            }
            List<String> urteile=new ArrayList<>();
            List<BezugsdatenRegeln.Zeilenurteil> geurteilt=new ArrayList<>();
            List<Aenderung> sofort=new ArrayList<>(), vorschlaege=new ArrayList<>();
            for (var z:v.zeilen()) {
                if (z.bezugsgroesseId()!=null) recht(z.bezugsgroesseId(),"bezugsgroesse.importieren");
                String urteil=z.urteil();
                if ("konflikt".equals(urteil)) urteil="ersetzen".equals(entscheidungen.get(z.nr())) ? "berichtigung" : "uebersprungen";
                urteile.add(urteil);
                geurteilt.add(new BezugsdatenRegeln.Zeilenurteil(urteil,z.befunde().stream().map(BezugsdatenImportDto.Befund::befund).toList()));
                if (!List.of("neu","berichtigung").contains(urteil)) continue;
                UUID id=z.bezugsgroesseId();
                Instant zeit=z.zeitpunkt()==null ? null : z.zeitpunkt().toInstant();
                if (repo.offen(id,z.periodeVon(),zeit) || (z.periodeVon()!=null && werte.offen(tenant,id,z.periodeVon()).isPresent())) gleichzeitig();
                var k=kette(id,z.periodeVon(),zeit);
                int vorher=k.isEmpty() ? 0 : k.getLast().fassung();
                List<String> kennzeichen=new ArrayList<>();
                if (z.befunde().stream().anyMatch(b -> "einheit_umgerechnet".equals(b.befund()))) {
                    kennzeichen.add("umgerechnet aus " + z.geliefert().wert() + " " + z.geliefert().einheit());
                }
                var a=new Aenderung(id,z.periodeVon(),z.periodeBis(),zeit,bezuege.zeitzone(id),vorher,new BigDecimal(z.betrag()),
                        "berichtigung".equals(urteil) ? "berichtigung" : "erstwert",z.nr(),z.geliefert().wert(),z.geliefert().einheit(),kennzeichen);
                if ("berichtigung".equals(urteil)) begruendung(anfrage.begruendung());
                if (vier && "berichtigung".equals(urteil)) vorschlaege.add(a); else sofort.add(a);
            }
            var e=BezugsdatenRegeln.importErgebnis(v.zeilen().size(),v.fruehererImport()!=null,
                    v.fruehererImport()==null ? null : v.fruehererImport().status(),geurteilt);
            if (e.zaehler().abgelehnt()>0 && e.aenderungen()>0 && !Objects.equals(e.bestaetigung(),anfrage.teiluebernahme())) {
                throw BezugsgroesseAbgelehnt.anfrage("teiluebernahme");
            }
            String grund=anfrage.begruendung()==null || anfrage.begruendung().isBlank() ? null : begruendung(anfrage.begruendung());
            String kennung=repo.kennung(tenant);
            repo.importSchreiben(tenant,kennung,v,e,grund,wer,urteile,CsvLeser.lies(datei,zuordnung.csv()).zeilen());
            anwenden(tenant,kennung,sofort,grund,wer,null);
            if (!vorschlaege.isEmpty()) repo.vorschlag(tenant,kennung,grund,false,vorschlaege,wer);
            return new Ergebnis(kennung,e.status(),sofort.size(),vorschlaege.size(),e.zaehler());
        });
    }

    public Ergebnis status(String kennung) {
        return tx.execute(t -> {
            var f=repo.importFassungen(kennung);
            if (f.isEmpty()) throw BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
            for (UUID id:repo.importZiele(kennung)) recht(id,"bezugsgroesse.importieren");
            var offen=repo.freigabe(kennung);
            int v=offen!=null && "vorschlag".equals(offen.status()) ? offen.auftrag().size() : 0;
            int a=((Number)f.getFirst().get("aenderungen")).intValue();
            return new Ergebnis(kennung,(String)f.getLast().get("status"),a-(offen!=null && !offen.ruecknahme() ? v : 0),v,null);
        });
    }

    public Ergebnis ruecknahme(String kennung,String begruendung,ProtokollAkteur wer) {
        String grund=begruendung(begruendung);
        return tx.execute(t -> {
            UUID tenant=TenantContext.get();
            boolean vier=werte.vierAugenGesperrt(tenant);
            bezuege.kundenbereichSperren(tenant);
            var f=repo.importFassungen(kennung);
            if (f.isEmpty()) throw BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
            for (UUID id:repo.importZiele(kennung)) recht(id,"bezugsgroesse.importieren");
            if ("zurueckgenommen".equals(f.getLast().get("status"))) return new Ergebnis(kennung,"zurueckgenommen",0,0,null);
            var offen=repo.freigabe(kennung);
            if (offen!=null && "vorschlag".equals(offen.status())) gleichzeitig();
            List<Aenderung> a=new ArrayList<>();
            for (UUID id:repo.ziele(kennung)) {
                recht(id,"bezugsgroesse.importieren");
                for (var w:bezuege.werte(id,null,null)) {
                    if (!kennung.equals(w.importKennung()) || "ruecknahme".equals(w.vorgang())) continue;
                    var k=kette(id,w.periodeVon(),w.zeitpunkt());
                    if (k.getLast().fassung()!=w.fassung() || repo.offen(id,w.periodeVon(),w.zeitpunkt())
                            || (w.periodeVon()!=null && werte.offen(tenant,id,w.periodeVon()).isPresent())) gleichzeitig();
                    BigDecimal betrag="berichtigung".equals(w.vorgang()) ? k.stream()
                            .filter(p -> p.fassung()==w.ersetztFassung()).findFirst().orElseThrow().betrag() : null;
                    a.add(new Aenderung(id,w.periodeVon(),w.periodeBis(),w.zeitpunkt(),w.zeitzone(),w.fassung(),betrag,
                            "ruecknahme",w.importZeile(),w.geliefertText(),w.geliefertEinheit(),
                            List.of(betrag==null ? "Import " + kennung + " zurückgenommen" : "Rücknahme der Berichtigung aus " + kennung)));
                }
            }
            if (vier && !a.isEmpty()) repo.vorschlag(tenant,kennung,grund,true,a,wer);
            else {
                anwenden(tenant,kennung,a,grund,wer,null);
                repo.zurueckgenommen(tenant,kennung,grund,wer);
            }
            return new Ergebnis(kennung,vier && !a.isEmpty() ? (String) f.getLast().get("status") : "zurueckgenommen",
                    vier ? 0 : a.size(),vier ? a.size() : 0,null);
        });
    }

    /** Called inside the existing correction approval transaction, after locking its company setting. */
    public MessreiheKorrekturRepository.Korrektur freigeben(UUID tenant,String kennung,String grund,
            ProtokollAkteur wer,boolean vier,Instant jetzt) {
        bezuege.kundenbereichSperren(tenant);
        var f=repo.freigabe(kennung);
        if (f==null) throw KorrekturFreigabeAbgelehnt.von(KorrekturFreigabeAbgelehnt.Ablehnung.NICHT_GEFUNDEN);
        for (var a:f.auftrag()) recht(a.id(),"korrektur.freigeben");
        var d=KorrekturRechte.entscheiden(wer,KorrekturRechte.KORREKTUR_FREIGEBEN,f.wer().sub(),vier,jetzt);
        if (!d.darf()) throw KorrekturFreigabeAbgelehnt.rechte(d);
        grund=begruendung(grund);
        if (!"vorschlag".equals(f.status())) throw KorrekturFreigabeAbgelehnt.von(KorrekturFreigabeAbgelehnt.Ablehnung.STATUS_PASST_NICHT);
        ProtokollAkteur freigeber=Objects.equals(wer.sub(),f.wer().sub()) ? null : wer;
        anwenden(tenant,kennung,f.auftrag(),f.grund(),f.wer(),freigeber);
        repo.entscheidung(tenant,kennung,f.fassung()+1,"freigegeben",grund,f.ruecknahme(),f.auftrag(),wer);
        if (f.ruecknahme()) repo.zurueckgenommen(tenant,kennung,f.grund(),wer);
        var fassungen=repo.fassungen(tenant,kennung);
        return new MessreiheKorrekturRepository.Korrektur(kennung,null,fassungen.subList(fassungen.size()-2,fassungen.size()));
    }

    private void anwenden(UUID tenant,String kennung,List<Aenderung> auftrag,String grund,ProtokollAkteur wer,ProtokollAkteur freigeber) {
        for (var a:auftrag) {
            var b=bezuege.sperre(a.id()).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            var k=kette(a.id(),a.von(),a.zeitpunkt());
            if ((k.isEmpty() ? 0 : k.getLast().fassung())!=a.vorher() || b.archiviertAm()!=null) gleichzeitig();
            repo.wert(tenant,kennung,a,grund,wer,freigeber,b);
            if (a.vorher()>0) correction(tenant,kennung,a,b.kennzeichen());
        }
    }

    private void correction(UUID tenant,String kennung,Aenderung a,String kennzeichen) {
        var e=json.createObjectNode();
        e.put("ereignis_id",UUID.nameUUIDFromBytes((tenant+":"+kennung+":"+a.id()+":"+a.von()+":"+a.zeitpunkt()+":"+(a.vorher()+1))
                .getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art","correction");
        ZoneId zone=ZoneId.of(a.zone());
        // Ereignisintervalle liegen im gemeinsamen Viertelstundenraster; ein Stand kann minutengenau sein.
        Instant von=a.von()==null ? Instant.ofEpochSecond(Math.floorDiv(a.zeitpunkt().getEpochSecond(),900)*900)
                : a.von().atStartOfDay(zone).toInstant();
        Instant bis=a.bis()==null ? von.plusSeconds(900) : a.bis().plusDays(1).atStartOfDay(zone).toInstant();
        e.put("von",von.toString()); e.put("bis",bis.toString()); e.put("bezugsgroesse",kennzeichen);
        e.put("korrektur",kennung+"/Zeile-"+a.zeile()+"/Fassung-"+(a.vorher()+1)); e.put("import",kennung); e.put("korrektur_art",EreignisVokabular.KORREKTUR_ART_BEZUGSWERT);
        e.put("status","freigegeben"); e.put("fassung_alt",a.vorher()); e.put("fassung_neu",a.vorher()+1);
        var r=ereignisse.anhaengen(tenant,null,EreignisVokabular.Urheber.KUNDE,e,null,null);
        if (r.ausgang()!=MessreiheEreignisRepository.Ausgang.ANGEHAENGT) throw new IllegalStateException("correction: "+r);
    }

    private List<BezugsgroesseRepository.WertZeile> kette(UUID id,LocalDate von,Instant zeit) {
        return bezuege.werte(id,von,von).stream().filter(w -> Objects.equals(w.periodeVon(),von) && Objects.equals(w.zeitpunkt(),zeit)).toList();
    }
    private void recht(UUID id,String aktion) {
        rechte.pruefen(aktion,RechtZiel.BEZUGSGROESSE,id,() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }
    private static String begruendung(String text) {
        String s=text==null ? "" : text.strip();
        if (s.codePointCount(0,s.length())<10) throw BezugsgroesseAbgelehnt.von(Ablehnung.BEGRUENDUNG_ZU_KURZ);
        if (s.codePointCount(0,s.length())>500) throw BezugsgroesseAbgelehnt.von(Ablehnung.BEGRUENDUNG_ZU_LANG);
        return s;
    }
    private static void gleichzeitig() {
        throw KorrekturFreigabeAbgelehnt.von(KorrekturFreigabeAbgelehnt.Ablehnung.GLEICHZEITIG);
    }
}
