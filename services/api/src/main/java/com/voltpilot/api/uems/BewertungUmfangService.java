package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BewertungUmfangDto.*;
import com.voltpilot.api.uems.BewertungUmfangRepository.Fassung;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** U1: neue Fassung und Protokoll unter derselben Unternehmenssperre, keine Mengenbildung. */
@Service
public class BewertungUmfangService {
    private static final List<String> TRAEGER = BewertungRegeln.TRAEGER;
    private final BewertungUmfangRepository repo;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    public BewertungUmfangService(BewertungUmfangRepository repo, UnternehmenRepository unternehmen, RechtPruefung rechte) {
        this.repo=repo; this.unternehmen=unternehmen; this.rechte=rechte;
    }
    @Transactional(readOnly = true)
    public Umfang lesen(LocalDate am) {
        var u = unternehmen.desKundenbereichs().orElseThrow(BewertungUmfangAbgelehnt::fehlt);
        LocalDate tag = am == null ? LocalDate.now(ZoneId.of(u.zeitzone())) : am;
        var f = repo.fassungen(u.id()).stream().filter(x -> !x.inhalt().gueltigAb().isAfter(tag)).findFirst().orElse(null);
        return darstellen(u.id(), f, tag);
    }
    @Transactional(readOnly = true)
    public Historie historie() {
        UUID u = unternehmen.desKundenbereichs().orElseThrow(BewertungUmfangAbgelehnt::fehlt).id();
        var sichtbar = repo.standorte(u).stream().map(BewertungUmfangRepository.StandortZeile::id).collect(java.util.stream.Collectors.toSet());
        boolean ganz = rechte.lesbar(RechtZiel.UNTERNEHMEN,null);
        if (!ganz && sichtbar.isEmpty()) throw BewertungUmfangAbgelehnt.fehlt();
        return new Historie(repo.fassungen(u).stream()
                .filter(f -> ganz || f.inhalt().standortIds().stream().anyMatch(sichtbar::contains))
                .map(f -> darstellen(u,f,f.inhalt().gueltigAb())).toList());
    }
    @Transactional
    public Umfang speichern(Speichern eingabe, ProtokollAkteur wer) {
        UUID u = unternehmen.sperren().orElseThrow(BewertungUmfangAbgelehnt::fehlt);
        Speichern neu = pruefen(eingabe);
        Fassung vorher = repo.fassungen(u).stream().findFirst().orElse(null);
        if (vorher != null && normalisieren(vorher.inhalt()).equals(neu)) return darstellen(u,vorher,neu.gueltigAb());
        if (vorher != null && neu.gueltigAb().isBefore(vorher.inhalt().gueltigAb()))
            throw fehler("gueltig_ab_ungueltig","Bitte wählen Sie einen Tag ab dem Beginn der letzten Fassung.");
        pruefenVerweise(neu,u);
        UUID id = repo.anlegen(u,vorher,neu,wer);
        return darstellen(u,repo.fassungen(u).stream().filter(f -> f.id().equals(id)).findFirst().orElseThrow(),neu.gueltigAb());
    }
    private Speichern pruefen(Speichern e) {
        if (e == null || e.gueltigAb() == null || e.standortIds() == null || e.traeger() == null || e.ausschluesse() == null)
            throw BewertungUmfangAbgelehnt.anfrage();
        if (e.traeger().isEmpty() || e.traeger().stream().anyMatch(t -> t == null || !TRAEGER.contains(t)))
            throw fehler("traeger_unbekannt","Bitte wählen Sie mindestens einen verfügbaren Träger.");
        if (e.standortIds().stream().anyMatch(java.util.Objects::isNull))
            throw fehler("standort_unbekannt","Bitte wählen Sie Standorte Ihres Unternehmens.");
        Set<String> gesehen = new HashSet<>();
        for (Ausschluss a : e.ausschluesse()) {
            if (a == null || a.art() == null || !Set.of("standort","anlage","prozess").contains(a.art()) || a.verweis() == null)
                throw fehler("ausschluss_ungueltig","Bitte prüfen Sie den ausgeschlossenen Standort, die Anlage oder den Prozess.");
            if (a.begruendung() == null || a.begruendung().isBlank())
                throw fehler("begruendung_fehlt","Bitte begründen Sie jeden Ausschluss.");
            if (!gesehen.add(a.art()+a.verweis()))
                throw fehler("ausschluss_ungueltig","Bitte prüfen Sie den ausgeschlossenen Standort, die Anlage oder den Prozess.");
        }
        return normalisieren(e);
    }
    private void pruefenVerweise(Speichern e,UUID u) {
        var standorte = repo.standorte(u).stream().map(BewertungUmfangRepository.StandortZeile::id).toList();
        if (!standorte.containsAll(e.standortIds()))
            throw fehler("standort_unbekannt","Bitte wählen Sie Standorte Ihres Unternehmens.");
        for (Ausschluss a : e.ausschluesse()) if (!repo.verweisVorhanden(a,u))
            throw fehler("ausschluss_ungueltig","Bitte prüfen Sie den ausgeschlossenen Standort, die Anlage oder den Prozess.");
    }
    private Speichern normalisieren(Speichern e) {
        return new Speichern(e.gueltigAb(),e.standortIds().stream().distinct().sorted().toList(),
                e.traeger().stream().distinct().sorted(Comparator.comparingInt(TRAEGER::indexOf)).toList(),e.ausschluesse().stream()
                .map(a -> new Ausschluss(a.art(),a.verweis(),a.begruendung().strip()))
                .sorted(Comparator.comparing(Ausschluss::art).thenComparing(Ausschluss::verweis)).toList(),
                e.begruendung() == null || e.begruendung().isBlank() ? null : e.begruendung().strip());
    }
    private Umfang darstellen(UUID u,Fassung f,LocalDate am) {
        var sichtbar = repo.standorte(u);
        boolean ganz = rechte.lesbar(RechtZiel.UNTERNEHMEN,null);
        var e = f == null ? new Speichern(null,sichtbar.stream().map(BewertungUmfangRepository.StandortZeile::id).toList(),
                List.of("Strom"),List.of(),null) : f.inhalt();
        var standorte = sichtbar.stream().filter(s -> e.standortIds().contains(s.id())).toList();
        if (!ganz && standorte.isEmpty()) throw BewertungUmfangAbgelehnt.fehlt();
        var ausschluesse = e.ausschluesse().stream().filter(a -> ganz || switch(a.art()) {
            case "standort" -> sichtbar.stream().anyMatch(s -> s.id().equals(a.verweis()));
            case "anlage" -> repo.anlageSichtbar(a.verweis());
            default -> false;
        }).toList();
        var orte = standorte.stream().map(s -> {
            List<Anlage> anlagen = ausgeschlossen(e,"standort",s.id()) ? List.of() : repo.anlagen(s.id(),am).stream()
                    .filter(a -> !ausgeschlossen(e,"anlage",a.id())).toList();
            return new Standort(s.id(),s.name(),anlagen,anlagen.size());
        }).toList();
        var anlagen = orte.stream().flatMap(s -> s.anlagenImUmfang().stream()).distinct().toList();
        return new Umfang(f == null ? null : f.id(),f == null ? null : f.nummer(),e.gueltigAb(),am,orte,
                e.traeger().stream().map(t -> new Traeger(t,t.equals("Strom"))).toList(),ausschluesse,anlagen,anlagen.size(),
                e.traeger().contains("Strom") ? "Strom" : null,e.begruendung(),f == null ? null : f.akteur(),
                f == null ? null : f.createdAt(),f == null ? null : f.aufgehobenAm(),!ganz);
    }
    private static boolean ausgeschlossen(Speichern e,String art,UUID id) {
        return e.ausschluesse().stream().anyMatch(a -> a.art().equals(art) && a.verweis().equals(id));
    }
    private static BewertungUmfangAbgelehnt fehler(String code,String text) { return new BewertungUmfangAbgelehnt(422,code,text); }
}
