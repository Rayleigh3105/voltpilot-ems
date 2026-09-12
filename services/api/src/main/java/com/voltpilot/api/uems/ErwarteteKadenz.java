package com.voltpilot.api.uems;

import java.time.Instant;
import java.util.Collection;
import java.util.Map;
import java.util.UUID;

/**
 * Die eingetragene Kadenz-Fassung eines MESSKANALS zu einem Zeitpunkt (UEMS AP-07 IP-10) — die
 * schmale Tür, durch die der Mess-Plan-Publisher an die neue Wahrheit kommt, ohne die
 * Messstellen-Welt zu kennen.
 *
 * <p><b>Ein Messkanal, nicht eine Bindung.</b> Die Box liest ein Ziel EINMAL; welche Messstelle
 * daran hängt, ist ihr gleich. Lesen mehrere Bindungen denselben Messkanal (die führende und eine
 * Vergleichsbindung), gilt für den Draht die SCHNELLSTE ihrer Fassungen — dieselbe Regel, mit der
 * der Publisher seit je zwei Komponenten auf einem Punkt zusammenlegt: „der Kastenwunsch ist der
 * konservative". Die Beobachtung je Größe fragt dagegen nach IHRER Bindung
 * ({@link QuelleKadenzRepository#jeBindung}).
 *
 * <p>Leer heißt: keine Fassung — dann gilt die Vorgabe-Kette von {@link KadenzRegeln#wirksam}, also
 * genau die Ableitung von vor diesem Paket.
 */
public interface ErwarteteKadenz {

    /** Ein Messkanal: Komponente + Kanalname ({@code point_key} bzw. Slug des Selbstbaus). */
    record Messkanal(UUID entityId, String kanal) {}

    /**
     * Die zum {@code zeitpunkt} geltenden Fassungen dieser Messkanäle, je Kanal die schnellste.
     * Ein Kanal ohne Fassung fehlt in der Karte — nie eine geratene Zahl.
     */
    Map<Messkanal, Integer> fassungenJeKanal(Collection<Messkanal> kanaele, Instant zeitpunkt);

    /** Die Auskunft, die nie eine Fassung kennt — der Stand vor IP-10 (für Tests und Bausteine). */
    ErwarteteKadenz KEINE = (kanaele, zeitpunkt) -> Map.of();
}
