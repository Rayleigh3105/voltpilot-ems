package com.voltpilot.api.verbraucher;

import com.voltpilot.api.verbraucher.RanglisteProjektion.Kandidat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Die SCHREIB-Haelfte der Rangliste (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §5, Captain-Entscheid E3) - die Inverse
 * von {@link RanglisteProjektion#liste}.
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - das
 * {@code Tagesprotokoll}/{@code FleetPflege}-Muster. Sie entscheidet nichts
 * ueber die Anlage; sie uebersetzt die gewuenschte Reihenfolge in die drei
 * Tatsachen, die die Maschine schon kennt:
 *
 * <ul>
 *   <li>{@code consumer_profile.default_service_rank} = die Position
 *       (1-basiert ueber die Geraete). Der Optimierer ordnet damit die
 *       PFLICHTEN innerhalb seiner Stufe 1 ({@code co_solver._requirement_order}) -
 *       der Schreibpfad hat bis P4 gefehlt, die Spalte trug seit ihrer
 *       Migration den Kommentar „set only after a detected conflict".</li>
 *   <li>{@code consumer_profile.storage_relation}: ueber dem Speicher =
 *       {@code consumer_first}, darunter = {@code storage_first} (der
 *       Praeferenz-Epsilon des Co-Optimierers). Damit entfaellt die frueher je
 *       Geraet gestellte D6-Pflichtfrage.</li>
 *   <li>{@code site_charging_config.storage_priority} +
 *       {@code site_charge_point_priority}: steht mindestens eine Saeule ueber
 *       dem Speicher, ist es {@code auto_vor_speicher} und die Vorrang-MENGE
 *       sind genau diese Saeulen.</li>
 * </ul>
 *
 * <p><b>⚠ PFLICHTEN GEHEN IMMER VOR DER RANGLISTE, und das ist eine Eigenschaft
 * dessen, was hier NICHT geschrieben wird.</b> Die Ableitung fasst
 * ausschliesslich die vier Felder oben an - keine Anforderung, keine Policy,
 * keine Stufe. Der Optimierer deckt in Stufe 1 zuerst jede Pflicht und benutzt
 * den Rang nur, um die Pflichten UNTEREINANDER zu ordnen (D2,
 * {@code co_solver.py}); die Rangliste kann eine Pflicht also weder aufheben
 * noch verschieben.
 *
 * <p><b>⚠ Was NICHT ausdrueckbar ist, wird auch nicht behauptet.</b> Eine
 * OCPP-Saeule hat kein {@code consumer_profile} (Konzept §1.2 S3), ihre
 * Position kann also nur „ueber" oder „unter" dem Speicher sein - der
 * Ganzzahl-Rang je Saeule ist Paket P6. Deshalb stehen gleichrangige Saeulen in
 * der Liste als EINE Zeile (siehe {@link RanglisteProjektion}), und deshalb
 * bleibt die Vorrang-Menge UNANGETASTET, solange keine Saeule oben steht: die
 * Liste macht dann gar keine Aussage ueber sie, und ein Loeschen naehme dem
 * Kunden seine Vorrang-Wahl aus der Ladepark-Kapsel.
 */
public final class RanglisteAbleitung {

    /** Ein Platz, wie ihn der Kunde geschickt hat - flach, ein Geraet je Eintrag. */
    public record Wunsch(String art, UUID entityId) {}

    /**
     * Was in die Maschine geschrieben wird.
     *
     * @param rang             je Komponente MIT Profil ihre 1-basierte Position
     * @param storageRelation  je Komponente MIT Profil {@code consumer_first} /
     *                         {@code storage_first}
     * @param storagePriority  die anlagenweite Speicher-Frage;
     *                         {@code null} = die Anlage hat keine Saeule, es
     *                         gibt nichts zu sagen
     * @param vorrangKennungen die Vorrang-Menge; {@code null} = NICHT anfassen
     *                         (siehe Klassen-Doku)
     */
    public record Ableitung(Map<UUID, Integer> rang, Map<UUID, String> storageRelation,
            String storagePriority, List<String> vorrangKennungen) {}

    private RanglisteAbleitung() {}

    /**
     * Prueft den Wunsch gegen die Anlage. Leer = in Ordnung; sonst deutsche
     * Saetze, und dann wird NICHTS geschrieben (die Haus-Regel: alles pruefen,
     * bevor das Erste geschrieben wird).
     */
    public static List<String> pruefe(List<Wunsch> wunsch, List<Kandidat> kandidaten,
            boolean hatSpeicher) {
        List<String> fehler = new ArrayList<>();
        if (wunsch == null || wunsch.isEmpty()) {
            fehler.add("Die Reihenfolge darf nicht leer sein.");
            return fehler;
        }
        Set<UUID> bekannt = new LinkedHashSet<>();
        for (Kandidat k : kandidaten) {
            bekannt.add(k.entityId());
        }
        Set<UUID> gesehen = new LinkedHashSet<>();
        int speicher = 0;
        for (Wunsch w : wunsch) {
            if (w == null || w.art() == null) {
                fehler.add("Jeder Eintrag der Reihenfolge braucht eine Art.");
                continue;
            }
            if (RanglisteProjektion.ART_SPEICHER.equals(w.art())) {
                speicher++;
                continue;
            }
            if (!RanglisteProjektion.ART_LADEPUNKT.equals(w.art())
                    && !RanglisteProjektion.ART_VERBRAUCHER.equals(w.art())) {
                fehler.add("Unbekannte Art „" + w.art() + "\" in der Reihenfolge. Möglich sind "
                        + "„speicher\", „ladepunkt\" und „verbraucher\".");
                continue;
            }
            if (w.entityId() == null) {
                fehler.add("Ein Gerät in der Reihenfolge braucht seine Kennung.");
                continue;
            }
            if (!bekannt.contains(w.entityId())) {
                fehler.add("Das Gerät " + w.entityId() + " gehört nicht zu dieser Anlage.");
                continue;
            }
            if (!gesehen.add(w.entityId())) {
                fehler.add("Das Gerät " + w.entityId() + " steht mehrfach in der Reihenfolge.");
            }
        }
        if (speicher > 1) {
            fehler.add("Der Speicher steht mehrfach in der Reihenfolge.");
        }
        if (hatSpeicher && speicher == 0 && fehler.isEmpty()) {
            fehler.add("Die Reihenfolge muss den Speicher enthalten - er entscheidet, welche "
                    + "Geräte vor ihm bedient werden.");
        }
        return List.copyOf(fehler);
    }

    /**
     * Die Ableitung. Setzt einen von {@link #pruefe} abgenommenen Wunsch voraus.
     *
     * <p><b>⚠ Nicht genannte Geraete landen UNTEN</b> (Captain-Entscheid E3
     * „neue Verbraucher unten") statt in einer Ablehnung: zwischen dem Lesen
     * der Liste und dem Speichern kann eine Saeule dazugekommen sein, und ein
     * Rennen darf keine Bedienung kosten. Ein Speicher-Eintrag ohne Speicher
     * wird ignoriert - dann gibt es kein Oben und Unten.
     */
    public static Ableitung ableiten(List<Wunsch> wunsch, List<Kandidat> kandidaten,
            boolean hatSpeicher) {
        Map<UUID, Kandidat> nachId = new LinkedHashMap<>();
        for (Kandidat k : kandidaten) {
            nachId.put(k.entityId(), k);
        }

        List<UUID> oben = new ArrayList<>();
        List<UUID> unten = new ArrayList<>();
        Set<UUID> gesehen = new LinkedHashSet<>();
        boolean nachSpeicher = false;
        for (Wunsch w : wunsch) {
            if (w == null || w.art() == null) {
                continue;
            }
            if (RanglisteProjektion.ART_SPEICHER.equals(w.art())) {
                nachSpeicher = hatSpeicher;
                continue;
            }
            Kandidat k = w.entityId() == null ? null : nachId.get(w.entityId());
            if (k == null || !gesehen.add(k.entityId())) {
                continue;
            }
            (nachSpeicher ? unten : oben).add(k.entityId());
        }
        for (Kandidat k : kandidaten) {
            if (gesehen.add(k.entityId())) {
                unten.add(k.entityId());
            }
        }

        Map<UUID, Integer> rang = new LinkedHashMap<>();
        Map<UUID, String> relation = new HashMap<>();
        List<String> obenSaeulen = new ArrayList<>();
        boolean hatSaeule = false;
        int pos = 1;
        for (UUID id : oben) {
            Kandidat k = nachId.get(id);
            hatSaeule |= saeule(k);
            if (k.rankbar()) {
                rang.put(id, pos);
                relation.put(id, RanglisteProjektion.RELATION_CONSUMER_FIRST);
            } else if (saeule(k)) {
                obenSaeulen.add(k.chargePointId());
            }
            pos++;
        }
        if (hatSpeicher) {
            pos++;
        }
        for (UUID id : unten) {
            Kandidat k = nachId.get(id);
            hatSaeule |= saeule(k);
            if (k.rankbar()) {
                rang.put(id, pos);
                // ⚠ Ohne Speicher gibt es kein „darunter": alles ist
                // `consumer_first` (die Vorgabe der Spalte). Ein `storage_first`
                // waere eine Aussage ueber einen Speicher, den es nicht gibt -
                // und stuende still im Weg, sobald einer dazukommt.
                relation.put(id, hatSpeicher ? RanglisteProjektion.RELATION_STORAGE_FIRST
                        : RanglisteProjektion.RELATION_CONSUMER_FIRST);
            }
            pos++;
        }

        String storagePriority = null;
        List<String> vorrang = null;
        // ⚠ OHNE SPEICHER sagt die Liste zur Speicher-Frage GAR NICHTS - dann
        // steht jede Saeule zwangslaeufig „oben", und das als
        // `auto_vor_speicher` zu speichern waere eine Antwort auf eine Frage,
        // die niemand gestellt hat (und wuerde die Vorrang-Wahl der
        // Ladepark-Kapsel ueberschreiben).
        if (hatSpeicher && hatSaeule) {
            // Die Vorrang-MENGE wird nur angefasst, wenn die Liste wirklich
            // etwas ueber sie sagt: steht keine Saeule oben, liest die
            // Projektion sie gar nicht (dann sind alle Saeulen unten), und ein
            // Loeschen naehme dem Kunden nur seine Ladepark-Wahl.
            if (obenSaeulen.isEmpty()) {
                storagePriority = RanglisteProjektion.STORAGE_VOR_AUTO;
            } else {
                storagePriority = RanglisteProjektion.AUTO_VOR_SPEICHER;
                vorrang = List.copyOf(obenSaeulen);
            }
        }
        return new Ableitung(Map.copyOf(rang), Map.copyOf(relation), storagePriority, vorrang);
    }

    /** Eine OCPP-Saeule: ein Ladepunkt ohne Profil, der eine Kennung traegt. */
    private static boolean saeule(Kandidat k) {
        return !k.rankbar() && RanglisteProjektion.ART_LADEPUNKT.equals(k.art())
                && k.chargePointId() != null;
    }
}
