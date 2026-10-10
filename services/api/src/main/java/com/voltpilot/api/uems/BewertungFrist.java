package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AP-16 S5/S6 (IP-24): die Frist der energetischen Bewertung — beim Abruf abgeleitet, nie geschrieben (kein Läufer, kein
 * Ereignis). Frist = Tag der Freigabe des jüngsten gültigen Stands (Zone des Berichts) + {@code wiedervorlage_monate}; ab
 * diesem Tag ist die Überprüfung fällig (am Tag selbst „seit 0 Tagen“). Die Wiedervorlage wirkt beim nächsten Abruf — sie
 * ist eine Eigenschaft der Bewertung, kein Teil des eingefrorenen Stands.
 *
 * <p>Gibt ein Stand einer anderen Bewertung desselben Unternehmens später frei, ist diese Bewertung abgelöst (R10 Schritt 3):
 * keine Frist mehr, lesbar bleibt sie. Die Uhr kommt immer von außen ({@code heute}); hier liest nichts die Rechneruhr.
 */
public final class BewertungFrist {

    private BewertungFrist() {}

    /** Der Stand, an dem die Frist hängt, und — nur bei einer abgelösten Bewertung — ihr Nachfolger. */
    public record Frist(int standNr, LocalDate standVom, int wiedervorlageMonate, LocalDate faelligAm, boolean faellig,
            Integer faelligSeitTagen, String abgeloestDurch) {}

    /** Der jüngste Stand einer Bewertung — Grundlage der Ablösung. */
    public record BewertungStand(String kennung, int nr, Instant freigegebenAm) {}

    /** Die Frist am Tag {@code heute}; {@code abgeloestDurch} ≠ {@code null} = keine Frist, nichts fällig. */
    public static Frist ableiten(int standNr, LocalDate standVom, int wiedervorlageMonate, LocalDate heute,
            String abgeloestDurch) {
        if (abgeloestDurch != null) {
            return new Frist(standNr, standVom, wiedervorlageMonate, null, false, null, abgeloestDurch);
        }
        LocalDate faelligAm = standVom.plusMonths(wiedervorlageMonate);
        boolean faellig = !heute.isBefore(faelligAm);
        return new Frist(standNr, standVom, wiedervorlageMonate, faelligAm, faellig,
                faellig ? Math.toIntExact(ChronoUnit.DAYS.between(faelligAm, heute)) : null, null);
    }

    /** Eine verantwortliche Person und ihre wesentlichen Einsätze (S6). */
    public record Verantwortung(String name, List<String> einsaetze) {}

    /**
     * S6: die Verantwortlichen der WESENTLICHEN Einsätze, je Person einmal, in der Reihenfolge ihres ersten Einsatzes. Ein
     * wesentlicher Einsatz ohne verantwortliche Person steht nicht hier, sondern in {@link #ohneVerantwortliche}.
     */
    public static List<Verantwortung> verantwortliche(List<BerichtRepository.EinsatzLage> lage) {
        Map<String, List<String>> je = new LinkedHashMap<>();
        for (BerichtRepository.EinsatzLage e : lage) {
            if (e.wesentlich() && e.verantwortlichName() != null) {
                je.computeIfAbsent(e.verantwortlichName(), n -> new ArrayList<>()).add(e.kennzeichen());
            }
        }
        return je.entrySet().stream().map(x -> new Verantwortung(x.getKey(), List.copyOf(x.getValue()))).toList();
    }

    public static List<String> ohneVerantwortliche(List<BerichtRepository.EinsatzLage> lage) {
        return lage.stream().filter(e -> e.wesentlich() && e.verantwortlichName() == null)
                .map(BerichtRepository.EinsatzLage::kennzeichen).toList();
    }

    /**
     * Die Bewertung, die {@code kennung} ablöst: die mit dem spätesten jüngsten Stand unter allen nicht archivierten
     * Bewertungen desselben Unternehmens — {@code null}, wenn {@code kennung} selbst diese ist. Gleichstand: die höhere
     * Kennung gilt (eine feste Reihenfolge, nie zwei gültige).
     */
    public static String abgeloestDurch(String kennung, List<BewertungStand> staende) {
        BewertungStand gueltig = null;
        for (BewertungStand s : staende) {
            if (gueltig == null || s.freigegebenAm().isAfter(gueltig.freigegebenAm())
                    || (s.freigegebenAm().equals(gueltig.freigegebenAm()) && s.kennung().compareTo(gueltig.kennung()) > 0)) {
                gueltig = s;
            }
        }
        return gueltig == null || gueltig.kennung().equals(kennung) ? null : gueltig.kennung();
    }
}
