package com.voltpilot.api.uems;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Welche Entität einer Anlage in welchen Registry-Push gehört (UEMS AP-06 IP-6, E3 = A, E4 = A,
 * W7): jede Box bekommt ihren EIGENEN vollständigen Sollbestand aus genau den Entitäten, deren
 * Datenquelle sie ZUM ZEITPUNKT liest; die Anlagen-Rollen stehen nur im Push der führenden Box.
 * Prosa: {@code docs/contracts/v2/data-source-assignment.md} §8 „Der Push je Box (IP-6)“.
 *
 * <p>Die Regel, in Prüfreihenfolge:
 *
 * <ol>
 *   <li>Ohne führende Box gibt es keinen Push, auch keinen je Box — wie bis IP-5, nie geraten:
 *       jede Entität ist {@code keine_fuehrende_box}. Die Anlagen-Summe hätte keinen Ort, und ein
 *       Push je Box nähme sie der Box, die sie heute bildet.
 *   <li>Trägt KEINE Entität eine Datenquelle (der Stand jeder Bestandsanlage, bis die
 *       Vorschlagsliste bestätigt ist), bekommt die führende Box alles — der eine Push von vorher,
 *       {@link Verteilung#jeBox()} ist {@code false}.
 *   <li>Eine Anlagen-Rolle ({@link #ANLAGEN_ROLLEN}) gehört der führenden Box. Liest ihre Quelle zum
 *       Zeitpunkt eine ANDERE Box, bekommt sie keine ({@code anlagen_rolle_an_anderer_box}): die
 *       führende Box läse sonst eine fremde Quelle, die andere Box bildete eine Anlagen-Summe. Liest
 *       ihre Quelle keine Box: {@code quelle_ohne_zustaendige_box}.
 *   <li>Eine Entität ohne Datenquelle gehört der führenden Box — sie liest sie heute.
 *   <li>Eine Entität mit Datenquelle gehört der Box, die die Quelle zum Zeitpunkt liest
 *       ({@link DatenquelleRegeln#zustaendigeBox}, halboffen auf die Minute). Liest sie keine:
 *       {@code quelle_ohne_zustaendige_box}. Liest sie eine Box, die weder in der Anlage angemeldet
 *       noch ihre führende Box ist: {@code box_ausserhalb_der_anlage} — der Push reist unter dem
 *       Topic DIESER Anlage, und den Anlagen-übergreifenden Fall schaltet erst IP-7 frei.
 * </ol>
 *
 * <p>Einen Push bekommen: die führende Box (immer), jede Box mit mindestens einer Entität, und jede
 * Box der Anlage, für die schon ein Soll aufgezeichnet ist — sie bekommt ihre Vollmenge, auch eine
 * leere, damit sie eine Quelle, die sie nicht mehr liest, sicher vergisst. Die Reihenfolge: führende
 * Box zuerst, dann die Boxen der Anlage in Anmelde-Reihenfolge; je Box die Entitäten in der
 * Reihenfolge der Eingabe.
 *
 * <p>Disjunkt ist die Verteilung durch Bau: jede Entität wird genau EINMAL entschieden — einer Box
 * zugeteilt oder mit Grund ausgelassen. {@code PushJeBoxTest} beweist es erschöpfend über alle
 * kleinen Welten. Rein; kennt weder Datenbank noch Uhr.
 */
public final class PushJeBox {

    private PushJeBox() {}

    /**
     * Die Anlagen-Rollen: aus den Stammdaten der ANLAGE komponiert und auf genau EINER Box gefaltet
     * — Netz-Summe, Haus-Summe, Speicher. Ein Erzeuger oder ein selbst gebauter Speicher ist eine
     * Komponente mit eigener Quelle und folgt ihr.
     */
    public static final Set<String> ANLAGEN_ROLLEN = Set.of("grid-meter", "house-load", "battery-hybrid");

    /** Warum eine Entität in keinem Push steht — geschlossen, nie geraten. */
    public enum Grund {
        KEINE_FUEHRENDE_BOX("keine_fuehrende_box"),
        QUELLE_OHNE_ZUSTAENDIGE_BOX("quelle_ohne_zustaendige_box"),
        ANLAGEN_ROLLE_AN_ANDERER_BOX("anlagen_rolle_an_anderer_box"),
        BOX_AUSSERHALB_DER_ANLAGE("box_ausserhalb_der_anlage");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Eine v2-Entität der Anlage: Kennung, Typ und ihre Datenquelle ({@code null} = keine). */
    public record Entitaet(UUID id, String entityType, UUID quelle) {}

    /** Eine Entität, die in keinem Push steht, und warum. */
    public record Auslass(UUID entitaet, Grund grund) {}

    /**
     * Das Ergebnis: je Box (in Zustell-Reihenfolge) die Kennungen ihrer Entitäten, dazu die
     * ausgelassenen. {@code jeBox} ist {@code false} auf dem Bestandsweg (keine Datenquelle).
     */
    public record Verteilung(boolean jeBox, Map<UUID, List<UUID>> boxen, List<Auslass> ausgelassen) {

        public Verteilung {
            Map<UUID, List<UUID>> kopie = new LinkedHashMap<>();
            boxen.forEach((box, ids) -> kopie.put(box, List.copyOf(ids)));
            boxen = Collections.unmodifiableMap(kopie);
            ausgelassen = List.copyOf(ausgelassen);
        }
    }

    /**
     * @param entitaeten      die v2-Entitäten der Anlage, in Push-Reihenfolge
     * @param fuehrend        die führende Box ({@code LeadDeviceService}), oder {@code null}
     * @param boxenDerAnlage  die in der Anlage angemeldeten, nicht ausgebauten Boxen, in
     *                        Anmelde-Reihenfolge
     * @param zustaendigkeiten alle Zeiträume der Datenquellen, die in {@code entitaeten} vorkommen
     * @param zeitpunkt       der Zeitpunkt des Pushs
     * @param boxenMitSoll    die Boxen, für die diese Anlage schon ein Soll aufgezeichnet hat
     */
    public static Verteilung verteilen(List<Entitaet> entitaeten, UUID fuehrend, List<UUID> boxenDerAnlage,
            List<ZustaendigkeitRepository.Zeitraum> zustaendigkeiten, Instant zeitpunkt,
            Collection<UUID> boxenMitSoll) {
        boolean jeBox = entitaeten.stream().anyMatch(e -> e.quelle() != null);
        if (fuehrend == null) {
            List<Auslass> alle = new ArrayList<>();
            for (Entitaet e : entitaeten) {
                alle.add(new Auslass(e.id(), Grund.KEINE_FUEHRENDE_BOX));
            }
            return new Verteilung(jeBox, Map.of(), alle);
        }
        Map<UUID, List<UUID>> boxen = new LinkedHashMap<>();
        boxen.put(fuehrend, new ArrayList<>());
        if (!jeBox) {
            for (Entitaet e : entitaeten) {
                boxen.get(fuehrend).add(e.id());
            }
            return new Verteilung(false, boxen, List.of());
        }

        Set<UUID> inDerAnlage = new LinkedHashSet<>(boxenDerAnlage);
        inDerAnlage.add(fuehrend);
        Map<UUID, List<DatenquelleRegeln.Zeitraum>> zeitraeume = new HashMap<>();
        for (ZustaendigkeitRepository.Zeitraum z : zustaendigkeiten) {
            zeitraeume.computeIfAbsent(z.dataSourceId(), k -> new ArrayList<>()).add(
                    new DatenquelleRegeln.Zeitraum(z.deviceId().toString(), z.effectiveFrom(), z.effectiveTo()));
        }

        Map<UUID, UUID> ziel = new LinkedHashMap<>();
        List<Auslass> ausgelassen = new ArrayList<>();
        for (Entitaet e : entitaeten) {
            UUID liest = e.quelle() == null ? null : liest(zeitraeume, e.quelle(), zeitpunkt);
            Grund grund = null;
            UUID box = null;
            if (ANLAGEN_ROLLEN.contains(e.entityType())) {
                if (e.quelle() == null || fuehrend.equals(liest)) {
                    box = fuehrend;
                } else {
                    grund = liest == null ? Grund.QUELLE_OHNE_ZUSTAENDIGE_BOX : Grund.ANLAGEN_ROLLE_AN_ANDERER_BOX;
                }
            } else if (e.quelle() == null) {
                box = fuehrend;
            } else if (liest == null) {
                grund = Grund.QUELLE_OHNE_ZUSTAENDIGE_BOX;
            } else if (!inDerAnlage.contains(liest)) {
                grund = Grund.BOX_AUSSERHALB_DER_ANLAGE;
            } else {
                box = liest;
            }
            if (box != null) {
                ziel.put(e.id(), box);
            } else {
                ausgelassen.add(new Auslass(e.id(), grund));
            }
        }

        Set<UUID> mitEntitaeten = new HashSet<>(ziel.values());
        Set<UUID> mitSoll = new HashSet<>(boxenMitSoll);
        for (UUID box : boxenDerAnlage) {
            if (!box.equals(fuehrend) && (mitEntitaeten.contains(box) || mitSoll.contains(box))) {
                boxen.put(box, new ArrayList<>());
            }
        }
        ziel.forEach((id, box) -> boxen.get(box).add(id));
        return new Verteilung(true, boxen, ausgelassen);
    }

    private static UUID liest(Map<UUID, List<DatenquelleRegeln.Zeitraum>> zeitraeume, UUID quelle, Instant t) {
        String box = DatenquelleRegeln.zustaendigeBox(zeitraeume.getOrDefault(quelle, List.of()), t);
        return box == null ? null : UUID.fromString(box);
    }
}
