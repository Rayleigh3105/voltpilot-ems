package com.voltpilot.api.entities;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Map;
import java.util.UUID;

/**
 * Anbindungen, die eine Entität erst beim Zusammensetzen des Pushs für EINE Box bekommt (UEMS EZ-21): Treiber und
 * Pin einer Anlagensteuerung hängen an der Datenquelle (Adresse, Port, Geräte-ID) und daran, ob die empfangende Box
 * sie versteht — beides kennt {@link EntityRegistryService#composePush} nicht selbst. Die Umsetzung liegt beim
 * Fachpaket ({@code erzeuger.AnlagensteuerungQuelle}); ohne sie bleibt der Push, wie er ist.
 */
public interface PushAnbindungen {

    /**
     * Die Anbindung einer Entität im Push an diese Box. {@code driver == null} heißt: diese Box versteht die
     * Anbindung nicht — die Entität reist dann ohne Pin und ohne Treiber, genau wie vor EZ-21.
     */
    record Anbindung(String edgeSourceId, ObjectNode driver) {
        public static Anbindung keine() {
            return new Anbindung(null, null);
        }
    }

    /** Je Entität der Anlage, die eine Anbindung hat, die für {@code box}; leer = nichts zu ändern. */
    Map<UUID, Anbindung> fuerBox(UUID siteId, UUID box);
}
