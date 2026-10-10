package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KostenstelleProzessRepository.Art;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.web.dto.ProzessMessstellenDto;
import com.voltpilot.api.web.dto.ProzessMessstellenDto.Antwort;
import com.voltpilot.api.web.dto.ProzessMessstellenDto.Hinweis;
import com.voltpilot.api.web.dto.ProzessMessstellenDto.Messstelle;
import com.voltpilot.api.web.dto.ProzessMessstellenDto.Verweis;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * AP-16 P4: liest die Messstellen eines Prozesses und prüft die Quell-Messstellen seiner berechneten
 * Messstellen. Die Prüfung ist ein Hinweis; sie schreibt und rechnet nichts um.
 */
@Service
public class ProzessMessstellenService {
    private final KostenstelleProzessRepository prozesse;
    private final BewertungMengenRepository mengen;
    private final MessstelleRepository messstellen;
    private final MessstelleFormelFassungRepository fassungen;
    private final MessstelleFormelTermRepository terme;
    private final VerteilungRepository verteilungen;
    private final RechtPruefung rechte;

    public ProzessMessstellenService(KostenstelleProzessRepository prozesse, BewertungMengenRepository mengen,
            MessstelleRepository messstellen, MessstelleFormelFassungRepository fassungen,
            MessstelleFormelTermRepository terme, VerteilungRepository verteilungen, RechtPruefung rechte) {
        this.prozesse = prozesse;
        this.mengen = mengen;
        this.messstellen = messstellen;
        this.fassungen = fassungen;
        this.terme = terme;
        this.verteilungen = verteilungen;
        this.rechte = rechte;
    }

    @Transactional(readOnly = true)
    public Antwort lesen(UUID prozessId, LocalDate am) {
        var prozess = prozesse.finde(Art.PROZESS, prozessId)
                .orElseThrow(() -> KostenstelleProzessAbgelehnt.von(KostenstelleProzessAbgelehnt.Ablehnung.NICHT_GEFUNDEN));
        List<UUID> ids = mengen.messstellen(prozessId, am);
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN, null)
                && ids.stream().noneMatch(id -> rechte.lesbar(RechtZiel.MESSSTELLE, id))) {
            throw KostenstelleProzessAbgelehnt.von(KostenstelleProzessAbgelehnt.Ablehnung.NICHT_GEFUNDEN);
        }

        var sichtbar = ids.stream().filter(id -> rechte.lesbar(RechtZiel.MESSSTELLE, id))
                .map(messstellen::finde).flatMap(java.util.Optional::stream)
                .sorted(Comparator.comparing(MessstelleRepository.Messstelle::kennzeichen)).toList();
        var gemessen = sichtbar.stream().filter(m -> "gemessen".equals(m.art())).map(ProzessMessstellenService::dto).toList();
        var berechnet = sichtbar.stream().filter(m -> "berechnet".equals(m.art())).map(ProzessMessstellenService::dto).toList();
        var gemessenKennzeichen = gemessen.stream().map(Messstelle::kennzeichen).toList();

        Map<String, MessstelleRepository.Messstelle> summen = new LinkedHashMap<>();
        Map<String, TermZeile> termNachQuelle = new LinkedHashMap<>();
        var regelSummen = new ArrayList<BewertungRegeln.ProzessSumme>();
        for (var summe : sichtbar.stream().filter(m -> "berechnet".equals(m.art())).toList()) {
            summen.put(summe.kennzeichen(), summe);
            var fassung = MessstelleFormelRegeln.fassungAm(
                    fassungen.wirksame(summe.id()).stream().map(MessstelleFormelFassungRepository.FassungZeile::alsRegel).toList(), am)
                    .flatMap(f -> fassungen.wirksame(summe.id()).stream().filter(x -> x.nummer() == f.nummer()).findFirst());
            var regelTerme = new ArrayList<BewertungRegeln.Term>();
            for (var term : fassung.map(f -> terme.derFassung(f.id())).orElse(List.of())) {
                if (term.quellMessstelleId() == null || !rechte.lesbar(RechtZiel.MESSSTELLE, term.quellMessstelleId())) continue;
                var quelle = messstellen.finde(term.quellMessstelleId()).orElse(null);
                if (quelle == null) continue;
                String verteilung = verteilung(term);
                regelTerme.add(new BewertungRegeln.Term(quelle.kennzeichen(), verteilung));
                termNachQuelle.put(schluessel(summe.kennzeichen(), quelle.kennzeichen(), verteilung), term);
            }
            regelSummen.add(new BewertungRegeln.ProzessSumme(summe.kennzeichen(), List.copyOf(regelTerme)));
        }

        var hinweise = BewertungRegeln.prozessSummePasst(gemessenKennzeichen, regelSummen).stream()
                .map(h -> hinweis(h, summen, termNachQuelle, prozessId, am)).filter(java.util.Objects::nonNull).toList();
        return new Antwort(new Verweis(prozess.id(), prozess.kennzeichen(), prozess.name()), am,
                gemessen, berechnet, hinweise);
    }

    private Hinweis hinweis(Map<String, Object> regel, Map<String, MessstelleRepository.Messstelle> summen,
            Map<String, TermZeile> termNachQuelle, UUID prozessId, LocalDate am) {
        String summeKennzeichen = (String) regel.get("summe");
        String quelleKennzeichen = (String) regel.get("messstelle");
        String verteilung = (String) regel.get("verteilung");
        var summe = summen.get(summeKennzeichen);
        var quelle = messstellen.findeNachKennzeichen(quelleKennzeichen).orElse(null);
        var term = termNachQuelle.get(schluessel(summeKennzeichen, quelleKennzeichen, verteilung));
        if (summe == null || quelle == null || term == null) return null;
        var fremdeProzesse = prozesse.zuordnungen(quelle.id()).stream().filter(z -> gilt(z, am))
                .filter(z -> !z.prozessId().equals(prozessId))
                .map(z -> new Verweis(z.prozessId(), z.prozessKennzeichen(), z.prozessName())).toList();
        String anteil = null;
        if (term.verteilungZiel() != null) {
            anteil = verteilungen.zeilen(quelle.id()).stream()
                    .filter(v -> v.kostenstelleId().equals(term.verteilungZiel()) && gilt(v, am))
                    .map(v -> v.anteilProzent().stripTrailingZeros().toPlainString()).findFirst().orElse(null);
        }
        return new Hinweis("prozess_summe_passt", dto(summe), dto(quelle), fremdeProzesse,
                "verteilung".equals(term.eingangArt()), verteilung, anteil);
    }

    private String verteilung(TermZeile term) {
        if (!"verteilung".equals(term.eingangArt()) || term.verteilungZiel() == null) return null;
        return prozesse.finde(Art.KOSTENSTELLE, term.verteilungZiel()).map(KostenstelleProzessRepository.Objekt::kennzeichen)
                .orElse(term.verteilungZiel().toString());
    }

    private static boolean gilt(KostenstelleProzessRepository.Zuordnung z, LocalDate tag) {
        return !z.gueltigAb().isAfter(tag) && (z.gueltigBis() == null || !z.gueltigBis().isBefore(tag));
    }

    private static boolean gilt(VerteilungRepository.Zeile z, LocalDate tag) {
        return !z.gueltigAb().isAfter(tag) && (z.gueltigBis() == null || !z.gueltigBis().isBefore(tag));
    }

    private static Messstelle dto(MessstelleRepository.Messstelle m) {
        return new Messstelle(m.id(), m.kennzeichen(), m.name());
    }

    private static String schluessel(String summe, String quelle, String verteilung) {
        return summe + "\u0000" + quelle + "\u0000" + String.valueOf(verteilung);
    }
}
