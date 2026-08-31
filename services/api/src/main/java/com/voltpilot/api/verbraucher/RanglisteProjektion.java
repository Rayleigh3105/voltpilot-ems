package com.voltpilot.api.verbraucher;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Die Rangliste einer Anlage (Konzept {@code vp-verbrauchsmgmt-konzept-v1} §5 +
 * §7.3, Captain-Entscheid E3) - die LESE-Haelfte.
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - das
 * {@code Tagesprotokoll}-Muster. Es gibt bewusst KEINE Rangliste-Tabelle: die
 * Liste ist eine PROJEKTION auf die drei Halbordnungen, die die Maschine schon
 * kennt, jede relativ zum Speicher (§5, „eine Wahrheit, kein zweites Format"):
 *
 * <ul>
 *   <li>{@code consumer_profile.storage_relation} je Verbraucher
 *       ({@code consumer_first} = ueber dem Speicher, {@code storage_first} =
 *       darunter) plus {@code consumer_profile.default_service_rank} als seine
 *       Position - beides schreibt {@link RanglisteAbleitung} zurueck (P4),</li>
 *   <li>{@code site_charging_config.storage_priority} anlagenweit
 *       ({@code auto_vor_speicher} hebt die VORRANG-Saeulen ueber den
 *       Speicher),</li>
 *   <li>{@code site_charge_point_priority} als die Menge dieser Saeulen.</li>
 * </ul>
 *
 * <p><b>⚠ RANKBAR heisst: es gibt ein {@code consumer_profile}.</b> Nur dort
 * existieren die zwei Spalten, in denen eine Position ueberhaupt stehen kann -
 * die Spalte {@code storage_relation} ist NOT NULL, ein {@code null} in
 * {@link Kandidat#storageRelation()} heisst also genau „diese Komponente hat
 * kein Profil". Eine go-e/Modbus-WALLBOX hat eines (sie ist fuer den Kunden ein
 * Ladepunkt, fuer die Maschine ein Verbraucher) und wird deshalb wie jeder
 * andere Verbraucher platziert; eine komponierte OCPP-Saeule hat keines und
 * folgt der Ladepunkt-Regel.
 *
 * <p><b>⚠ Gleichrangige Ladepunkte sind EINE Zeile</b> (Mockup 1440,
 * Anmerkung 22). Der Grund ist Ehrlichkeit, nicht Platz: fuer Saeulen ohne
 * Profil kann die Cloud heute nur zwei Raenge ausdruecken - „Vorrang" und
 * „Rest" (der Ganzzahl-Rang je Saeule ist Paket P6). Sie einzeln ziehbar zu
 * zeigen hiesse, eine Reihenfolge zu versprechen, die kein Speicher haelt; die
 * Box wechselt zwischen ihnen ohnehin ab ({@code lastmgmt.go} Rotation).
 *
 * <p><b>⚠ Die Positionen zaehlen GERAETE, nicht Zeilen</b> - eine Gruppe aus
 * drei Saeulen auf Platz 6 verbraucht 6, 7 und 8, die naechste Zeile steht auf
 * 9 (so auch im Mockup). Nur so ist die Position einer Zeile dieselbe Zahl, die
 * {@code default_service_rank} traegt.
 *
 * <p>Und es wird NICHTS erfunden: eine Anlage ohne Speicher bekommt keinen
 * Speicher-Eintrag, ein Verbraucher ohne gepflegten Rang steht unten
 * (Captain-Entscheid E3: „neue Verbraucher unten"), und die Vorgabe „Speicher
 * zuerst" ist die der Quellen-Bahn der Box ({@code lastmgmt.NormalizeStorage}).
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
     * @param storageRelation {@code consumer_first} / {@code storage_first} -
     *                        {@code null} heisst „kein {@code consumer_profile}",
     *                        also NICHT einzeln rangierbar (siehe Klassen-Doku)
     * @param rang            {@code consumer_profile.default_service_rank};
     *                        {@code null} = nie gesetzt ⇒ diese Komponente
     *                        steht am Ende ihrer Haelfte
     */
    public record Kandidat(String art, UUID entityId, String chargePointId,
            String storageRelation, Integer rang) {

        /** Traegt diese Komponente ein Profil - also die zwei Rang-Spalten? */
        public boolean rankbar() {
            return storageRelation != null;
        }

        /** Steht sie ueber dem Speicher? Nur fuer rankbare Kandidaten sinnvoll. */
        boolean ueberSpeicher() {
            return !RELATION_STORAGE_FIRST.equals(storageRelation);
        }
    }

    /**
     * Ein Platz in der Liste.
     *
     * @param position    die Position des ERSTEN Mitglieds, 1-basiert ueber die
     *                    Geraete (eine Gruppe verbraucht so viele Plaetze, wie
     *                    sie Mitglieder hat)
     * @param art         {@link #ART_SPEICHER} / {@link #ART_LADEPUNKT} /
     *                    {@link #ART_VERBRAUCHER}
     * @param entityId    die Komponente; {@code null} beim Speicher UND bei
     *                    einer Gruppe aus mehreren Ladepunkten
     * @param mitglieder  die Komponenten dieser Zeile in ihrer Reihenfolge -
     *                    leer beim Speicher, sonst mindestens eine
     */
    public record Eintrag(int position, String art, UUID entityId, List<UUID> mitglieder) {}

    private RanglisteProjektion() {}

    /**
     * Die Liste, wie sie der Kunde sieht - und wie {@link RanglisteAbleitung}
     * sie zurueckliest.
     *
     * <p>Die Normalform ist bindend, weil sie genau das ist, was die Maschine
     * halten kann:
     *
     * <pre>
     *   [rankbare ueber dem Speicher, nach Rang] [Saeulen-Gruppe oben?]
     *   SPEICHER
     *   [Saeulen-Gruppe unten?] [rankbare unter dem Speicher, nach Rang]
     * </pre>
     *
     * @param kandidaten          alle Verbraucher + Ladepunkte, in der
     *                            Reihenfolge ihrer Anlage-Erstellung
     * @param hatSpeicher         hat die Anlage einen Speicher? (nur dann gibt
     *                            es einen Speicher-Eintrag)
     * @param storagePriority     {@code speicher_vor_auto} (Vorgabe) /
     *                            {@code auto_vor_speicher} / {@code null}
     * @param priorityChargePoints die Vorrang-Saeulen
     */
    public static List<Eintrag> liste(List<Kandidat> kandidaten, boolean hatSpeicher,
            String storagePriority, List<String> priorityChargePoints) {
        boolean autoZuerst = AUTO_VOR_SPEICHER.equals(storagePriority);
        Set<String> vorrang = new LinkedHashSet<>(
                priorityChargePoints == null ? List.of() : priorityChargePoints);

        List<Kandidat> obenRankbar = new ArrayList<>();
        List<Kandidat> obenSaeulen = new ArrayList<>();
        List<Kandidat> untenSaeulen = new ArrayList<>();
        List<Kandidat> untenRankbar = new ArrayList<>();

        for (Kandidat k : kandidaten) {
            if (k.rankbar()) {
                (k.ueberSpeicher() ? obenRankbar : untenRankbar).add(k);
                continue;
            }
            if (!ART_LADEPUNKT.equals(k.art())) {
                // Eine Komponente ohne Profil, die kein Ladepunkt ist: es gibt
                // heute keine (der Katalog kennt nur die komponierte Saeule als
                // profillosen steuerbaren Verbraucher). Sie steht oben, wie ein
                // Verbraucher ohne gepflegte Beziehung - nie in einer
                // Saeulen-Gruppe, denn sie ist keine.
                obenRankbar.add(k);
                continue;
            }
            boolean oben = autoZuerst && k.chargePointId() != null
                    && vorrang.contains(k.chargePointId());
            (oben ? obenSaeulen : untenSaeulen).add(k);
        }

        obenRankbar.sort(NACH_RANG);
        untenRankbar.sort(NACH_RANG);

        List<Eintrag> out = new ArrayList<>();
        int[] pos = {1};
        for (Kandidat k : obenRankbar) {
            out.add(einzeln(pos, k));
        }
        gruppe(out, pos, obenSaeulen);
        if (hatSpeicher) {
            out.add(new Eintrag(pos[0]++, ART_SPEICHER, null, List.of()));
        }
        gruppe(out, pos, untenSaeulen);
        for (Kandidat k : untenRankbar) {
            out.add(einzeln(pos, k));
        }
        return List.copyOf(out);
    }

    /**
     * Nach Rang, {@code null} zuletzt - und bei Gleichstand stabil in der
     * Eingabe-Reihenfolge (die der Anlage-Erstellung), weil {@link List#sort}
     * stabil ist. Eine nie gerangte Anlage kommt damit in genau der Ordnung
     * heraus, die sie vor Paket P4 hatte.
     */
    private static final Comparator<Kandidat> NACH_RANG =
            Comparator.comparingInt(k -> k.rang() == null ? Integer.MAX_VALUE : k.rang());

    private static Eintrag einzeln(int[] pos, Kandidat k) {
        return new Eintrag(pos[0]++, k.art(), k.entityId(), List.of(k.entityId()));
    }

    private static void gruppe(List<Eintrag> out, int[] pos, List<Kandidat> saeulen) {
        if (saeulen.isEmpty()) {
            return;
        }
        List<UUID> ids = saeulen.stream().map(Kandidat::entityId).toList();
        // Eine Gruppe aus GENAU EINER Saeule ist keine Gruppe: sie traegt ihre
        // eigene Kennung, damit die Flaeche sie beim Namen nennen kann.
        UUID einzige = ids.size() == 1 ? ids.get(0) : null;
        out.add(new Eintrag(pos[0], ART_LADEPUNKT, einzige, ids));
        pos[0] += ids.size();
    }
}
