package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import java.util.Set;
import java.util.UUID;

/**
 * Regeln des Regel-Baukastens als Logik des Kerns (Steuerlogik Stufe 6, Zusammenführen; Vertrag
 * {@code docs/contracts/v2/steuerlogik.md}). Die Aktivierung fragt vor jeder Änderung, ob und wie eine Regel im Kern
 * läuft, und schreibt das Ergebnis in derselben Transaktion; der Satz auf {@code v2/flows} lässt das Node-RED-Artefakt
 * einer Regel genau dann weg, wenn ihre Übersetzung scharf an die Box geht.
 *
 * <p>Auf Edge Light und Edge Industrie (Go-Kern) gibt es für eine Regel keinen alten Weg: dort läuft sie nur so, oder die Aktivierung hält mit
 * Grund an. Auf der Docker-Box entscheidet der Steuerweg der Anlage (ab Werk der alte Weg).
 */
public interface RegelnImKern {

    /** Ein ehrlicher Halt der Aktivierung, wie {@link FlowActivationService.ActivationOutcome#refused}. */
    record Halt(String reason, String message) {}

    /** Was eine Aktivierung für den Kern vorbereitet hat; {@link #halt()} != null hält sie an, bevor sich etwas ändert. */
    interface Vorbereitet {
        Halt halt();
    }

    /**
     * Vor der Aktivierung, ohne etwas zu ändern: übersetzen, prüfen, das Artefakt bauen lassen.
     *
     * @param goKern die Box-Art des Gateways, wenn es den Go-Kern trägt ({@code BoxArt.istGoKern}), sonst {@code null}
     */
    Vorbereitet bereite(UUID siteId, FlowVersionRow version, JsonNode document, UUID gateway, String goKern);

    /** Nach der Aktivierung, in ihrer Transaktion: die Übersetzung anlegen oder eine veraltete stilllegen. */
    void schreibe(UUID siteId, Vorbereitet vorbereitet);

    /** Die Regel wurde ausgeschaltet: ihre Übersetzung hört mit ihr auf. In der Transaktion des Aufrufers. */
    void stillgelegt(UUID siteId, UUID flowId);

    /**
     * Die Flows, deren Übersetzung scharf an diese Box geht - ihr Node-RED-Artefakt bleibt aus dem Satz: Regeln und,
     * seit dem dritten Teil, die generierten Verbraucherregeln der Steuerarten.
     */
    Set<UUID> ersetzt(UUID siteId, UUID gateway);

    /**
     * Vor jedem Satz (Stufe 6, dritter Teil): die Übersetzungen der Steuerarten und des Heizstab-Reglers auf den
     * Stand ihrer Quellen bringen; eine, die sich nicht neu übersetzen lässt, wird stillgelegt und der alte Weg führt.
     */
    default void vorDemSatz(UUID siteId) {}
}
