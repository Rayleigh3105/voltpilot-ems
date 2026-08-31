package com.voltpilot.api.verbraucher;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Die INITIALE Rangliste einer Anlage (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §5 + §7.3, Captain-Entscheid E3).
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - das
 * {@code Tagesprotokoll}-Muster. Sie ist in Paket P1 eine reine ANZEIGE:
 * gespeichert wird noch nichts, sortiert wird noch nicht (das ist P4). Was hier
 * entsteht, ist die Vereinigung der drei Halbordnungen, die es HEUTE schon
 * gibt - jede relativ zum Speicher:
 *
 * <ul>
 *   <li>{@code consumer_profile.storage_relation} je Verbraucher
 *       ({@code consumer_first} = ueber dem Speicher, {@code storage_first} =
 *       darunter),</li>
 *   <li>{@code site_charging_config.storage_priority} anlagenweit
 *       ({@code auto_vor_speicher} hebt die VORRANG-Saeulen ueber den
 *       Speicher),</li>
 *   <li>{@code site_charge_point_priority} als die Menge dieser Saeulen, in
 *       ihrer gespeicherten Reihenfolge.</li>
 * </ul>
 *
 * <p><b>⚠ Widersprueche gibt es per Konstruktion nicht</b>, weil jede Quelle
 * nur eine Seite des Speichers besetzt. Und es wird NICHTS erfunden: eine
 * Anlage ohne Speicher bekommt keinen Speicher-Eintrag, ein Verbraucher ohne
 * gepflegte Beziehung gilt als {@code consumer_first} (die Vorgabe der Spalte),
 * und die Vorgabe „Speicher zuerst" ist die der Quellen-Bahn der Box
 * ({@code lastmgmt.NormalizeStorage}).
 */
public final class RanglisteProjektion {

    public static final String ART_SPEICHER = "speicher";
    public static final String ART_LADEPUNKT = "ladepunkt";
    public static final String ART_VERBRAUCHER = "verbraucher";

    public static final String STORAGE_VOR_AUTO = "speicher_vor_auto";
    public static final String AUTO_VOR_SPEICHER = "auto_vor_speicher";

    public static final String RELATION_CONSUMER_FIRST = "consumer_first";
    public static final String RELATION_STORAGE_FIRST = "storage_first";

    /**
     * Ein Kandidat der Liste.
     *
     * @param art             {@link #ART_LADEPUNKT} oder {@link #ART_VERBRAUCHER}
     * @param entityId        die Komponente
     * @param chargePointId   die OCPP-Kennung, wenn es eine gibt (nur darueber
     *                        laesst sich ein Vorrang-Eintrag zuordnen)
     * @param storageRelation {@code consumer_first} / {@code storage_first} /
     *                        {@code null} (= die Vorgabe der Spalte)
     */
    public record Kandidat(String art, UUID entityId, String chargePointId,
            String storageRelation) {}

    /** Ein Platz in der Liste. {@code entityId} ist beim Speicher {@code null}. */
    public record Eintrag(int position, String art, UUID entityId) {}

    private RanglisteProjektion() {}

    /**
     * @param kandidaten          alle Verbraucher + Ladepunkte, in der
     *                            Reihenfolge ihrer Anlage-Erstellung
     * @param hatSpeicher         hat die Anlage einen Speicher? (nur dann gibt
     *                            es einen Speicher-Eintrag)
     * @param storagePriority     {@code speicher_vor_auto} (Vorgabe) /
     *                            {@code auto_vor_speicher} / {@code null}
     * @param priorityChargePoints die Vorrang-Saeulen in gespeicherter Reihenfolge
     */
    public static List<Eintrag> initial(List<Kandidat> kandidaten, boolean hatSpeicher,
            String storagePriority, List<String> priorityChargePoints) {
        boolean autoZuerst = AUTO_VOR_SPEICHER.equals(storagePriority);
        Set<String> vorrang = new LinkedHashSet<>(
                priorityChargePoints == null ? List.of() : priorityChargePoints);

        List<Kandidat> ueber = new ArrayList<>();
        List<Kandidat> unter = new ArrayList<>();

        // 1) Verbraucher ueber dem Speicher (consumer_first ist die Vorgabe).
        for (Kandidat k : kandidaten) {
            if (!ART_LADEPUNKT.equals(k.art()) && !RELATION_STORAGE_FIRST.equals(k.storageRelation())) {
                ueber.add(k);
            }
        }
        // 2) Bei „Auto vor Speicher": die VORRANG-Saeulen, in ihrer gespeicherten
        //    Reihenfolge - nur sie stehen ueber dem Speicher.
        if (autoZuerst) {
            for (String id : vorrang) {
                for (Kandidat k : kandidaten) {
                    if (ART_LADEPUNKT.equals(k.art()) && id.equals(k.chargePointId())) {
                        ueber.add(k);
                    }
                }
            }
        }
        // 4) Die uebrigen Ladepunkte (bei „Speicher vor Auto" sind das alle).
        for (Kandidat k : kandidaten) {
            if (!ART_LADEPUNKT.equals(k.art())) {
                continue;
            }
            if (autoZuerst && k.chargePointId() != null && vorrang.contains(k.chargePointId())) {
                continue;
            }
            unter.add(k);
        }
        // 5) Verbraucher unter dem Speicher.
        for (Kandidat k : kandidaten) {
            if (!ART_LADEPUNKT.equals(k.art()) && RELATION_STORAGE_FIRST.equals(k.storageRelation())) {
                unter.add(k);
            }
        }

        List<Eintrag> out = new ArrayList<>();
        int pos = 1;
        for (Kandidat k : ueber) {
            out.add(new Eintrag(pos++, k.art(), k.entityId()));
        }
        if (hatSpeicher) {
            out.add(new Eintrag(pos++, ART_SPEICHER, null));
        }
        for (Kandidat k : unter) {
            out.add(new Eintrag(pos++, k.art(), k.entityId()));
        }
        return List.copyOf(out);
    }
}
