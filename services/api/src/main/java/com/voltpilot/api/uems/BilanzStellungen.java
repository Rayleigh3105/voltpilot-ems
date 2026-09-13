package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Die Stellungen des Mandanten so, wie {@link BilanzAbleitung#restAusStellung} sie liest (AP-10 IP-9,
 * E3): je wirksamem Stellungs-Intervall eine {@link BilanzAbleitung.StellungZeile} mit den Merkmalen der
 * Messstelle, die die Rolle braucht (Richtung der Hauptgröße, Art, Medium). Schlüssel sind die
 * Kennzeichen, die Anlage ist die ID der {@code site} als Text.
 *
 * <p>Diese Klasse liest nur und rechnet nichts: welche Messstelle an einem Tag zufließt, abfließt oder
 * zugeordnet ist, sagt allein die Regel. Zwei Lesezüge (Messstellen, Stellungen) für den ganzen Mandanten.
 */
@Component
public class BilanzStellungen {

    /** Die Stellungen und die Messstellen, über die sie aufgelöst werden (Kennzeichen → Messstelle). */
    public record Stand(List<BilanzAbleitung.StellungZeile> zeilen, Map<String, Messstelle> nachKennzeichen) {

        /** Die Fassung des Rests von {@code hauptzaehler} an einem Tag — die Regel, nicht nachgebaut. */
        public BilanzAbleitung.RestFassung rest(String hauptzaehler, LocalDate tag) {
            return BilanzAbleitung.restAusStellung(hauptzaehler, tag, zeilen);
        }
    }

    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository zuordnungen;

    public BilanzStellungen(MessstelleRepository messstellen, MessstelleZuordnungRepository zuordnungen) {
        this.messstellen = messstellen;
        this.zuordnungen = zuordnungen;
    }

    public Stand lesen() {
        Map<UUID, Messstelle> nachId = new LinkedHashMap<>();
        Map<String, Messstelle> nachKennzeichen = new LinkedHashMap<>();
        for (Messstelle m : messstellen.alle()) {
            nachId.put(m.id(), m);
            nachKennzeichen.put(m.kennzeichen(), m);
        }
        return new Stand(zeilen(nachId, MessstelleService.wirksam(zuordnungen.stellungenAlle())),
                nachKennzeichen);
    }

    /** Die Zeilen der Regel aus gelesenen Stellungen — auch für einen Zug, der sie schon hat (Register). */
    static List<BilanzAbleitung.StellungZeile> zeilen(Map<UUID, Messstelle> nachId,
            List<MessstelleZuordnungRepository.StellungZeile> wirksam) {
        List<BilanzAbleitung.StellungZeile> out = new ArrayList<>();
        for (MessstelleZuordnungRepository.StellungZeile s : wirksam) {
            Messstelle m = nachId.get(s.messstelleId());
            if (m == null) {
                continue;
            }
            Messstelle von = s.unterzaehlerVon() == null ? null : nachId.get(s.unterzaehlerVon());
            out.add(new BilanzAbleitung.StellungZeile(m.kennzeichen(), s.siteId().toString(), s.stellung(),
                    m.hauptgroesse().richtung(), m.art(), m.medium(),
                    von == null ? s.unterzaehlerVonKennzeichen() : von.kennzeichen(), s.gueltigAb(),
                    s.gueltigBis()));
        }
        // Die Reihenfolge der Terme folgt der der Zeilen (die Regel): nach Kennzeichen, dann Beginn — stabil.
        out.sort(java.util.Comparator.comparing(BilanzAbleitung.StellungZeile::messstelle)
                .thenComparing(BilanzAbleitung.StellungZeile::ab, java.util.Comparator.nullsFirst(
                        java.util.Comparator.naturalOrder())));
        return List.copyOf(out);
    }
}
