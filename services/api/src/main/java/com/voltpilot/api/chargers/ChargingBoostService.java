package com.voltpilot.api.chargers;

import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.command.CommandLog;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
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

    /** Die ZWEITE Richtung („Laden pausieren", P3b) - und ihre Rücknahme. */
    static final String EVENT_PAUSE = "laden_pausiert";

    static final String EVENT_PAUSE_ENDE = "laden_pausiert_beendet";

    private final Geltungsbereich geltungsbereich;
    private final DeviceChargerStatusRepository chargers;
    private final CommandLogRepository commandLog;
    private final ObjectProvider<ChargingBoostPublisher> publisher;

    public ChargingBoostService(Geltungsbereich geltungsbereich, DeviceChargerStatusRepository chargers,
            CommandLogRepository commandLog, ObjectProvider<ChargingBoostPublisher> publisher) {
        this.geltungsbereich = geltungsbereich;
        this.chargers = chargers;
        this.commandLog = commandLog;
        this.publisher = publisher;
    }

    /**
     * Die zwei Richtungen desselben Mechanismus (Konzept §4.6, Entscheid E5).
     *
     * <p>Sie sind Geschwister, keine zwei Mechanismen: derselbe Transport, dasselbe
     * {@code requested_at}-Fenster, dieselbe Bindung an EINEN Ladevorgang, dieselbe
     * Rücknahme („Automatik fortsetzen"). Nur die Wirkung unterscheidet sich.
     */
    public enum Action {
        /** „Jetzt voll laden": von der Quellen-Politik befreit, Netzstrom erlaubt. */
        VOLL,
        /** „Laden pausieren": GENAU dieser Ladevorgang wird auf 0 kW gedeckelt. */
        PAUSE;

        /** ABWESEND = {@link #VOLL} - die Kompatibilitäts-Zusage des ganzen Pakets. */
        public static Action of(String raw) {
            if (raw == null || raw.isBlank() || "voll".equals(raw)) {
                return VOLL;
            }
            if ("pause".equals(raw)) {
                return PAUSE;
            }
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Art des Eingriffs \"" + raw + "\". Erlaubt sind \"voll\" und \"pause\".");
        }
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
            boolean cancel, Action action, String actor) {
        geltungsbereich.requireSite(siteId);
        ChargePointDto point = point(siteId, chargePointId);
        ChargeConnectorDto connector = connector(point, connectorId);
        // ⚠ Nur ein LAUFENDER Ladevorgang lässt sich übersteuern. Eine Zusage
        // über ein Fahrzeug, das nicht da ist, wäre erfunden - und genau
        // dieselbe Ablehnung spricht die Box, wenn der Wagen inzwischen weg ist.
        // ⚠ Beide Richtungen übersteuern einen LAUFENDEN Ladevorgang - eine Zusage
        // über ein Fahrzeug, das nicht da ist, wäre in beiden Fällen erfunden.
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
                wanted, cancel, action == Action.PAUSE, actor, now)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "VoltPilot kann Ihre Ladesäule gerade nicht erreichen. Bitte gleich noch "
                            + "einmal versuchen - an Ihrer Anlage ändert sich dadurch nichts.");
        }
        record(siteId, point, connectorId, cancel, action, now, actor);
        return new BoostResult(point.chargePointId(), connectorId, !cancel, now,
                note(cancel, action));
    }

    /** Der Satz, den die Fläche zurückmeldet - je Richtung sein eigener. */
    private static String note(boolean cancel, Action action) {
        if (cancel) {
            return "Für diesen Ladevorgang gilt wieder Ihre Überschuss-Priorität.";
        }
        if (action == Action.PAUSE) {
            // ⚠ Der Satz nennt AUCH, was NICHT passiert: die Pause gilt diesem
            // einen Ladevorgang, jeder andere lädt unverändert weiter.
            return "Dieser Ladevorgang pausiert. Alle anderen Ladepunkte laden unverändert "
                    + "weiter; Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten "
                    + "wie bisher.";
        }
        return "Dieser Ladevorgang lädt jetzt mit voller verfügbarer Leistung - auch "
                + "mit Netzstrom. Anschlussgrenze, Sicherheitsabstand und "
                + "Ausfall-Schutz gelten unverändert weiter.";
    }

    /**
     * Der Beleg im Ladepunkt-Strom des Kommando-Verlaufs. NIE werfend: der
     * Verlauf ist die Kür, die erteilte Freigabe die Pflicht - und sie ist zu
     * diesem Zeitpunkt bereits hinausgegangen.
     */
    private void record(UUID siteId, ChargePointDto point, int connectorId, boolean cancel,
            Action action, Instant at, String actor) {
        try {
            // Der Urheber im Akteur-Vokabular (AP-03 IP-7): „Jetzt voll laden" ist ein Handeingriff.
            commandLog.appendEvent(siteId, point.deviceId(), point.entityId(),
                    CommandLog.STREAM_LADEPUNKT, eventKind(cancel, action), at, at,
                    ProtokollAkteur.angemeldetAls(actor).orElse(null));
        } catch (RuntimeException e) {
            log.warn("charging boost not recorded in the command log (site {} charge point {}): {}",
                    siteId, point.chargePointId(), e.getMessage());
        }
    }

    /**
     * Das Wort der Papier-Spur. Es folgt der GESENDETEN Richtung, auch bei einer
     * Rücknahme: „Jetzt voll laden beendet" über einer Pause wäre eine
     * Falschaussage im Kommando-Verlauf, und die Box kann uns nicht sagen, was
     * gerade lief.
     */
    static String eventKind(boolean cancel, Action action) {
        if (action == Action.PAUSE) {
            return cancel ? EVENT_PAUSE_ENDE : EVENT_PAUSE;
        }
        return cancel ? EVENT_BOOST_ENDE : EVENT_BOOST;
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
