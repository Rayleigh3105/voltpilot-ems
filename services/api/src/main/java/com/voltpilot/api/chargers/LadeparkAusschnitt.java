package com.voltpilot.api.chargers;

import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.WallboxDto;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Der Ausschnitt der Rangliste, der im Ladepark-Dokument EINER Box reist (UEMS AP-15 IP-16, Regel P6, Auflösung W6).
 *
 * <p>Eine Rangliste je ANLAGE; je Box reist nur, was IHRE Ladepunkte betrifft — in UNVERÄNDERTER Reihenfolge: die Liste
 * wird gefiltert, nie neu sortiert, und jeder Rang behält seine Zahl aus der Anlage. Anteile werden nie aus der Rangliste
 * abgeleitet (W6). Zu einer Box gehört ein Ladepunkt, den SIE gemeldet hat ({@code device_charge_point}, der physische
 * Beleg); ein Ladepunkt ohne Meldung gehört zur führenden Box, dem Empfänger von heute (G7: der Ladepark gehört an die
 * führende Box). Eine Wallbox gehört zur Box ihrer Entität; ohne steuernde Box ebenso zur führenden.
 *
 * <p>Was die Anlage als EINE Aussage trifft, reist in jedem Ausschnitt ganz: der Rang des Speichers (er bleibt EIN
 * Eintrag, W6/E7, und setzt für jede Säule die Grenze „über/unter dem Speicher“), die Grabsteine (eine Rücknahme muss
 * jede Box erreichen, die die Kennung kennen könnte), Rahmen, Quellen-Wahl und Fahrzeug-Profile.
 */
final class LadeparkAusschnitt {

    private LadeparkAusschnitt() {}

    /**
     * @param fuehrt       ob die Box die Anlage führt (sie bekommt, was keine Box gemeldet hat)
     * @param eigene       die Ladepunkte, die DIESE Box gemeldet hat
     * @param gemeldet     die Ladepunkte, die IRGENDEINE steuernde Box der Anlage gemeldet hat
     */
    static boolean gehoertZu(String chargePointId, boolean fuehrt, Set<String> eigene, Set<String> gemeldet) {
        return eigene.contains(chargePointId) || fuehrt && !gemeldet.contains(chargePointId);
    }

    /** Die Vorrang-Liste der Box: gefiltert, Reihenfolge der Anlage. {@code null} bleibt {@code null} (PATCH). */
    static List<String> vorrang(List<String> anlage, boolean fuehrt, Set<String> eigene, Set<String> gemeldet) {
        return anlage == null ? null
                : anlage.stream().filter(id -> gehoertZu(id, fuehrt, eigene, gemeldet)).toList();
    }

    /** Die Säulen der Box mit ihren Rängen aus der Anlage. */
    static List<AllowedChargePointDto> saeulen(List<AllowedChargePointDto> anlage, boolean fuehrt, Set<String> eigene,
            Set<String> gemeldet) {
        return anlage == null ? null
                : anlage.stream().filter(c -> gehoertZu(c.chargePointId(), fuehrt, eigene, gemeldet)).toList();
    }

    /**
     * Die Wallboxen der Box. Eine LEERE Liste reist mit („keine nimmt an dieser Box teil“), {@code null} bleibt
     * {@code null}.
     *
     * @param eigene    Wallbox-Entitäten an DIESER Box
     * @param zugeordnet Wallbox-Entitäten an IRGENDEINER steuernden Box
     */
    static List<WallboxDto> wallboxen(List<WallboxDto> anlage, boolean fuehrt, Collection<UUID> eigene,
            Collection<UUID> zugeordnet) {
        return anlage == null ? null
                : anlage.stream().filter(w -> eigene.contains(w.entityId())
                        || fuehrt && !zugeordnet.contains(w.entityId())).toList();
    }
}
