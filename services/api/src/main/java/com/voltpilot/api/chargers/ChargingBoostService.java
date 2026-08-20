package com.voltpilot.api.chargers;

import com.voltpilot.api.command.CommandLog;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargeConnectorDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargePointDto;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Jetzt voll laden": die Übersteuerung der Überschuss-Priorität für GENAU EINEN
 * laufenden Ladevorgang (OCPP-Lastmanagement Stufe 4, Mockups §2b).
 *
 * <p><b>Es ist ein ZWEITER TRIGGER, kein zweiter Mechanismus.</b> Der Umschlag
 * mündet auf der Box in {@code Agent.OcppBoost} - genau die Methode, die die
 * {@code :8484}-Taste ruft. Es gibt damit keinen zweiten Weg zu übersteuern, den
 * man später getrennt absichern müsste (die Portal-Apply-Doktrin).
 *
 * <p><b>Sie schlägt die ÖKONOMIE, nie die PHYSIK.</b> Sie nimmt einen Ladevorgang
 * von der Quellen-Politik aus, damit er auch Netzstrom ziehen darf.
 * Anschlussgrenze, Sicherheitsabstand, §14a, Mindestleistung, Vorrang und das in
 * der Säule hinterlegte Ausfall-Profil binden ihn danach unverändert - und die
 * Priorität ALLER ANDEREN Ladevorgänge bleibt, wie sie ist. Genau das verspricht
 * die Folgenliste des Dialogs, und genau das kann diese Klasse nicht brechen:
 * sie sendet einen Wunsch, sie rechnet keine Grenze.
 *
 * <p><b>⚠ Erst VERÖFFENTLICHEN, dann protokollieren</b> (die Reihenfolge des
 * Register-Schreibens): die Nachricht IST die Freigabe. Geht sie nicht hinaus,
 * darf kein Beleg entstehen, der eine Übersteuerung behauptet, die es nie gab.
 */
@Service
public class ChargingBoostService {

    private static final Logger log = LoggerFactory.getLogger(ChargingBoostService.class);

    /** Der Vertrags-Deckel (4 h). Ein größerer Wunsch wird GEKLEMMT, nie abgelehnt. */
    static final int MAX_MINUTES = 240;

    /** Das Punkt-Ereignis des Ladepunkt-Stroms. */
    static final String EVENT_BOOST = "voll_laden_erteilt";

    /** Und seine Rücknahme. */
    static final String EVENT_BOOST_ENDE = "voll_laden_zurueckgenommen";

    private final SiteRepository sites;
    private final DeviceChargerStatusRepository chargers;
    private final CommandLogRepository commandLog;
    private final ObjectProvider<ChargingBoostPublisher> publisher;

    public ChargingBoostService(SiteRepository sites, DeviceChargerStatusRepository chargers,
            CommandLogRepository commandLog, ObjectProvider<ChargingBoostPublisher> publisher) {
        this.sites = sites;
        this.chargers = chargers;
        this.commandLog = commandLog;
        this.publisher = publisher;
    }

    /** Das Ergebnis, so wie die Fläche es rendert. */
    public record BoostResult(String chargePointId, int connectorId, boolean active,
            Instant requestedAt, String note) {}

    /**
     * Erteilt (oder nimmt zurück) die Übersteuerung.
     *
     * @param minutes gewünschte Dauer; null = der Deckel. Ein größerer Wert wird
     *                geklemmt - der Deckel ist eine Zusage, keine Falle.
     */
    public BoostResult boost(UUID siteId, String chargePointId, int connectorId, Integer minutes,
            boolean cancel, String actor) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        ChargePointDto point = point(siteId, chargePointId);
        ChargeConnectorDto connector = connector(point, connectorId);
        // ⚠ Nur ein LAUFENDER Ladevorgang lässt sich übersteuern. Eine Zusage
        // über ein Fahrzeug, das nicht da ist, wäre erfunden - und genau
        // dieselbe Ablehnung spricht die Box, wenn der Wagen inzwischen weg ist.
        if (!cancel && !connector.charging()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "An diesem Stecker läuft gerade kein Ladevorgang.");
        }
        Integer wanted = minutes == null ? null : Math.min(Math.max(minutes, 1), MAX_MINUTES);

        ChargingBoostPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "VoltPilot kann Ihre Ladesäule gerade nicht erreichen. Bitte gleich noch "
                            + "einmal versuchen - an Ihrer Anlage ändert sich dadurch nichts.");
        }
        UUID tenantId = TenantContext.get();
        Instant now = Instant.now();
        if (!pub.publish(tenantId, siteId, point.deviceId(), point.chargePointId(), connectorId,
                wanted, cancel, actor, now)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "VoltPilot kann Ihre Ladesäule gerade nicht erreichen. Bitte gleich noch "
                            + "einmal versuchen - an Ihrer Anlage ändert sich dadurch nichts.");
        }
        record(siteId, point, connectorId, cancel, now);
        return new BoostResult(point.chargePointId(), connectorId, !cancel, now,
                cancel ? "Für diesen Ladevorgang gilt wieder Ihre Überschuss-Priorität."
                        : "Dieser Ladevorgang lädt jetzt mit voller verfügbarer Leistung - auch "
                                + "mit Netzstrom. Anschlussgrenze, Sicherheitsabstand und "
                                + "Ausfall-Schutz gelten unverändert weiter.");
    }

    /**
     * Der Beleg im Ladepunkt-Strom des Kommando-Verlaufs. NIE werfend: der
     * Verlauf ist die Kür, die erteilte Freigabe die Pflicht - und sie ist zu
     * diesem Zeitpunkt bereits hinausgegangen.
     */
    private void record(UUID siteId, ChargePointDto point, int connectorId, boolean cancel,
            Instant at) {
        try {
            commandLog.appendEvent(siteId, point.deviceId(), point.entityId(),
                    CommandLog.STREAM_LADEPUNKT, cancel ? EVENT_BOOST_ENDE : EVENT_BOOST, at, at);
        } catch (RuntimeException e) {
            log.warn("charging boost not recorded in the command log (site {} charge point {}): {}",
                    siteId, point.chargePointId(), e.getMessage());
        }
    }

    private ChargePointDto point(UUID siteId, String chargePointId) {
        String wanted = chargePointId == null ? "" : chargePointId.trim();
        for (ChargePointDto c : chargers.forSite(siteId).chargers()) {
            if (c.chargePointId().equals(wanted)) {
                return c;
            }
        }
        throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Diese Anlage kennt keine Ladesäule \"" + wanted + "\".");
    }

    private ChargeConnectorDto connector(ChargePointDto point, int connectorId) {
        for (ChargeConnectorDto con : point.connectors()) {
            if (con.connectorId() == connectorId) {
                return con;
            }
        }
        throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Diese Ladesäule hat keinen Stecker " + connectorId + ".");
    }
}
