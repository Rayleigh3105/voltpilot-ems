package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtAenderungRepository.Kandidat;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/**
 * WELCHE Einträge des Orts-Journals zum Protokoll eines STANDORTS gehören (UEMS AP-02 IP-14,
 * §4.4: „Der Standort zeigt zusätzlich die Einträge seiner Gebäude, Bereiche und
 * Anlagen-Zuordnungen"). Rein, ohne Spring: der Dienst reicht Ortsbaum, Anlagen-Zuordnungen und
 * Kandidaten herein, hier fällt nur das Urteil — gelesen, gefiltert und geseitet wird danach wie in
 * jedem anderen Protokoll ({@link AenderungsprotokollRepository#fuerOrtEintraege}).
 *
 * <ul>
 *   <li>Die eigenen Einträge des Standorts — darunter „Anlage zugeordnet" und „Anlage zieht um",
 *       die der Umzug (IP-11) an beiden Standorten schreibt, und das Löschen eines Kindes.</li>
 *   <li>Ein Gebäude oder Bereich mit den Einträgen aus der Zeit, in der es AN DIESEM STANDORT hing:
 *       am Tag seines „gilt ab" — oder am Vortag, damit ein Umzug bei BEIDEN Standorten steht.
 *       Hing es an beiden Tagen nirgends (archiviert), zählt der letzte Tag, an dem es hing. Der
 *       Weg hinauf ist {@link OrtsbaumAbleitung#pfadAm}, dieselbe Ableitung wie die Verortung
 *       einer Messstelle.</li>
 *   <li>Die Einträge einer Anlage nach derselben Regel über ihre Zuordnungen — außer denen, die
 *       ein Umzug schon am Standort selbst geschrieben hat (dieselbe Anlage, dieselbe
 *       Transaktion): ein Umzug steht nur EINMAL da.</li>
 * </ul>
 */
final class OrtProtokollUmfang {

    private OrtProtokollUmfang() {}

    static Set<Long> desStandorts(Ortsbaum baum, List<AnlageStandortRepository.Zuordnung> anlagenZuordnungen,
            UUID standortId, List<Kandidat> kandidaten) {
        String standort = standortId.toString();
        Map<String, List<Intervall>> anlagen = new HashMap<>();
        for (AnlageStandortRepository.Zuordnung z : anlagenZuordnungen) {
            anlagen.computeIfAbsent(z.siteId().toString(), k -> new ArrayList<>()).add(new Intervall(
                    z.gueltigAb(), z.gueltigBis(), z.standortId().toString(), z.aufgehoben()));
        }
        Set<String> amStandortGeschrieben = new HashSet<>();
        for (Kandidat k : kandidaten) {
            if ("standort".equals(k.objektArt()) && k.objektId().equals(standortId) && k.anlageId() != null) {
                amStandortGeschrieben.add(k.anlageId() + "@" + k.eingetragenAm());
            }
        }

        Set<Long> ids = new LinkedHashSet<>();
        for (Kandidat k : kandidaten) {
            String kz = k.objektId().toString();
            boolean gehoert = switch (k.objektArt()) {
                case "standort" -> k.objektId().equals(standortId);
                case "gebaeude", "bereich" -> hingDort(standort, tag -> OrtsbaumAbleitung.pfadAm(baum, kz, tag).standort(),
                        baum.ort(kz).map(OrtsbaumAbleitung.Ort::intervalle).orElse(List.of()), k.giltAb());
                case "anlage" -> {
                    List<Intervall> iv = anlagen.getOrDefault(kz, List.of());
                    yield !amStandortGeschrieben.contains(kz + "@" + k.eingetragenAm())
                            && hingDort(standort, tag -> elternAm(iv, tag), iv, k.giltAb());
                }
                default -> false;
            };
            if (gehoert) {
                ids.add(k.id());
            }
        }
        return ids;
    }

    /**
     * Hing das Objekt am Tag des Eintrags oder am Vortag an diesem Standort? Hing es an keinem der
     * beiden Tage irgendwo, zählt der letzte Tag seines letzten beendeten Intervalls davor.
     */
    private static boolean hingDort(String standort, Function<LocalDate, String> standortAm,
            List<Intervall> intervalle, LocalDate tag) {
        String amTag = standortAm.apply(tag);
        String amVortag = standortAm.apply(tag.minusDays(1));
        if (standort.equals(amTag) || standort.equals(amVortag)) {
            return true;
        }
        if (amTag != null || amVortag != null) {
            return false;
        }
        return intervalle.stream()
                .filter(i -> !i.aufgehoben() && i.bis() != null && i.bis().isBefore(tag))
                .max(Comparator.comparing(Intervall::bis))
                .map(i -> standort.equals(standortAm.apply(i.bis())))
                .orElse(false);
    }

    private static String elternAm(List<Intervall> intervalle, LocalDate tag) {
        Intervall i = OrtsbaumAbleitung.intervallAm(intervalle, tag);
        return i == null ? null : i.eltern();
    }
}
