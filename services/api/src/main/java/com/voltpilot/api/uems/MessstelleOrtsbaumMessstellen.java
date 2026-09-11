package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Die Messstellen im Ortsbaum (AP-04 IP-7) — der gefüllte Haken {@link OrtsbaumMessstellen}:
 * je Messstelle des Kundenbereichs ihr Zustand und ihre Ort-Intervalle aus
 * {@code messstelle_ort}, die Eltern als Kurzzeichen des Orts bzw. {@code U}. Damit kennt die
 * Archiv-Sperre eines Standorts (und mit IP-5 eines Gebäudes oder Bereichs) die aktiven
 * Messstellen in seinem Teilbaum.
 *
 * <p>Der Zustand ist der Lebenszyklus der Messstellen-Antwort ({@link MessstelleService#lebenszyklus}),
 * nie eine zweite Ableitung. Die Anlage ist die der Stellung, die HEUTE gilt — sie liest nur die
 * Folgen-Karte (AP-10).
 */
@Component
public class MessstelleOrtsbaumMessstellen implements OrtsbaumMessstellen {

    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final Clock uhr = Clock.systemUTC();

    public MessstelleOrtsbaumMessstellen(MessstelleRepository messstellen, MessstelleZuordnungRepository zuordnungen) {
        this.messstellen = messstellen;
        this.zuordnungen = zuordnungen;
    }

    @Override
    public List<OrtsbaumAbleitung.Messstelle> messstellen() {
        Map<UUID, List<OrtZeile>> orte = new HashMap<>();
        zuordnungen.orteAlle().forEach(z -> orte.computeIfAbsent(z.messstelleId(), k -> new ArrayList<>()).add(z));
        Map<UUID, List<StellungZeile>> stellungen = new HashMap<>();
        zuordnungen.stellungenAlle()
                .forEach(z -> stellungen.computeIfAbsent(z.messstelleId(), k -> new ArrayList<>()).add(z));
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(uhr.instant(), MessstelleService.ZEITZONE);
        LocalDate heute = jetzt.toLocalDate();
        List<OrtsbaumAbleitung.Messstelle> out = new ArrayList<>();
        for (Messstelle m : messstellen.alle()) {
            List<OrtZeile> eigene = orte.getOrDefault(m.id(), List.of());
            String lebenszyklus =
                    MessstelleService.lebenszyklus(m, MessstelleService.ortVorhanden(eigene), jetzt).lebenszyklus();
            String anlage = stellungen.getOrDefault(m.id(), List.of()).stream()
                    .filter(s -> !s.aufgehoben() && s.deckt(heute))
                    .map(s -> s.siteId().toString())
                    .findFirst().orElse(null);
            out.add(new OrtsbaumAbleitung.Messstelle(m.kennzeichen(), anzeigename(m), anlage,
                    ObjektZustand.valueOf(lebenszyklus.toUpperCase(Locale.ROOT)), intervalle(eigene)));
        }
        return List.copyOf(out);
    }

    /** Die Ort-Intervalle in der Sprache des Ortsbaums: Eltern = Kurzzeichen bzw. „U“. */
    static List<Intervall> intervalle(List<OrtZeile> zeilen) {
        return zeilen.stream()
                .map(z -> new Intervall(z.gueltigAb(), z.gueltigBis(), z.kennzeichen(), z.aufgehoben()))
                .toList();
    }

    /** Der Name, mit dem ein Satz sie nennt („MS-06 Spritzguss SG01–SG06“) — auch als Entwurf ohne Namen. */
    static String anzeigename(Messstelle m) {
        return m.name() == null ? "(noch ohne Namen)" : m.name();
    }
}
