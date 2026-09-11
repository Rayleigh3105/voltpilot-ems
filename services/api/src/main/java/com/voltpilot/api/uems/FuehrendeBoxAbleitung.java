package com.voltpilot.api.uems;

import com.voltpilot.api.uems.DatenquelleRegeln.Fuehrung;
import com.voltpilot.api.uems.DatenquelleRegeln.FuehrungsGrund;
import java.util.List;

/**
 * Die führende Box einer Anlage, so wie ein Dienst sie braucht: EINE Box oder EIN benannter
 * Grund, warum keine führt (UEMS AP-06 IP-5, E3 = A; Prosa in
 * {@code docs/contracts/v2/data-source-assignment.md} §8).
 *
 * <p>Die Vorrang-Reihenfolge gespeichert → Box des Speichers → einzige Box steht allein in
 * {@link DatenquelleRegeln#fuehrung}; hier kommen nur zwei Dinge dazu, die ein Dienst mit echten
 * Boxen braucht und die Sätze der Fläche nicht:
 *
 * <ol>
 *   <li>Eine gespeicherte Wahl gilt nur, wenn die Box in DIESER Anlage angemeldet ist
 *       ({@code boxen}: angemeldet, nicht ausgebaut). Sonst führt keine Box
 *       ({@code gespeichert_nicht_in_anlage}) — nie still eine andere, auch nicht die einzige.
 *   <li>„Keine“ wird zweigeteilt: {@code keine_wahl} (mehrere Boxen, keine gewählt — der Kunde
 *       wählt) und {@code keine_box} (die Anlage hat gar keine Box — es gibt nichts zu wählen).
 * </ol>
 *
 * <p>Die Box des Speichers wird genommen wie bis IP-5 von der Einzel-Gateway-Weiche: ohne
 * Anmelde-Prüfung, weil die Verknüpfung ihr eigener Weg setzt (Speicher-Auto-Link, Batterie-Editor)
 * und ein Bestandskunde nichts merken darf. Rein; gepinnt von
 * {@code docs/contracts/v2/lead-device-vectors.json}.
 */
public final class FuehrendeBoxAbleitung {

    private FuehrendeBoxAbleitung() {}

    /** Das geschlossene Vokabular: drei Wege zu einer Box, drei benannte Gründe für keine. */
    public enum Grund {
        GESPEICHERT("gespeichert", true),
        SPEICHER("speicher", true),
        EINZIGE("einzige", true),
        KEINE_WAHL("keine_wahl", false),
        KEINE_BOX("keine_box", false),
        GESPEICHERT_NICHT_IN_ANLAGE("gespeichert_nicht_in_anlage", false);

        private final String code;
        private final boolean bestimmt;

        Grund(String code, boolean bestimmt) {
            this.code = code;
            this.bestimmt = bestimmt;
        }

        public String code() {
            return code;
        }

        /** Ob dieser Grund eine Box nennt. */
        public boolean bestimmt() {
            return bestimmt;
        }

        static Grund aus(FuehrungsGrund grund) {
            return switch (grund) {
                case GESPEICHERT -> GESPEICHERT;
                case SPEICHER -> SPEICHER;
                case EINZIGE -> EINZIGE;
                case KEINE_WAHL -> KEINE_WAHL;
            };
        }
    }

    /** Die führende Box, oder {@code null} und der benannte Grund. */
    public record Ergebnis<B>(B box, Grund grund) {

        public Ergebnis {
            if ((box != null) != grund.bestimmt()) {
                throw new IllegalArgumentException("Box " + box + " passt nicht zum Grund " + grund.code());
            }
        }
    }

    /**
     * @param boxen       die in der Anlage angemeldeten, nicht ausgebauten Boxen, in
     *                    Anmelde-Reihenfolge
     * @param speicherBox die Box, die den primären Speicher liest, oder {@code null}
     * @param gespeichert die ausdrücklich gewählte Box ({@code site.lead_device_id}), oder
     *                    {@code null}
     */
    public static <B> Ergebnis<B> ableiten(List<B> boxen, B speicherBox, B gespeichert) {
        if (gespeichert != null && !boxen.contains(gespeichert)) {
            return new Ergebnis<>(null, Grund.GESPEICHERT_NICHT_IN_ANLAGE);
        }
        Fuehrung<B> fuehrung = DatenquelleRegeln.fuehrung(boxen, speicherBox, gespeichert);
        if (fuehrung.box() == null && boxen.isEmpty()) {
            return new Ergebnis<>(null, Grund.KEINE_BOX);
        }
        return new Ergebnis<>(fuehrung.box(), Grund.aus(fuehrung.grund()));
    }
}
