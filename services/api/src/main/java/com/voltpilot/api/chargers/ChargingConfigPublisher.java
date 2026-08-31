package com.voltpilot.api.chargers;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.LadeparkRahmenDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.WallboxDto;
import com.voltpilot.api.web.dto.FahrzeugDto.VehicleProfileDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Der Verteilweg der Lastmanagement-Konfiguration: Anschlussgrenze + Vorrang
 * gehen RETAINED (QoS1) auf {@code ems/{t}/{s}/{d}/v2/charging-config} (Kontrakt
 * {@code docs/contracts/mqtt-charging-config.schema.json}).
 *
 * <p><b>Retained ist der ganze Verteilmechanismus</b>, wie bei der
 * OTA-Zuweisung und der Steuerungs-Zertifizierung: hinter NAT gibt es keinen
 * Push, also holt sich eine Box, die beim Speichern offline war, ihre
 * Einstellung beim nächsten Verbindungsaufbau selbst ab. Das Topic liegt im
 * {@code v2/#}-Teilbaum, den die per-Gerät-ACL längst abdeckt (D-2) - KEINE
 * Broker-Änderung.
 *
 * <p><b>Das Dokument ist ein WUNSCH, keine Verteilung.</b> Gerechnet und
 * durchgesetzt wird weiter auf der Box (die Anschlussgrenze ist eine physische
 * Grenze, ihr Wächter darf nicht am WAN hängen - Konzept E1). Es entsteht kein
 * zweiter Verteiler und kein zweiter Schreibpfad auf eine Ladesäule.
 *
 * <p><b>⚠ Ein abwesendes Feld wird WEGGELASSEN, nie als Vorgabe gesendet</b>
 * (PATCH-Semantik des Kontrakts): das Portal besitzt heute nur die
 * Anschlussgrenze und die Vorrang-Wahl, alles andere bleibt Einstellung der Box
 * - ein Dokument, das sie stillschweigend zurücksetzte, wäre ein Datenverlust
 * ohne Absicht. Eine LEERE Vorrang-Liste ist dagegen eine Aussage und reist mit.
 *
 * <p>Best-effort wie jeder Broker-Kontakt hier: eine gespeicherte Grenze wird
 * nie wegen eines Broker-Ausfalls abgelehnt - sie steht in der DB und geht beim
 * nächsten Speichern erneut hinaus. Reitet auf demselben Broker-Schalter wie
 * die Provisionierung, also kein neuer Deployment-Knopf.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ChargingConfigPublisher {

    private static final Logger log = LoggerFactory.getLogger(ChargingConfigPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public ChargingConfigPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** Das Konfigurations-Topic eines Geräts (v2/#-Teilbaum, D-2). */
    public static String configTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/charging-config";
    }

    /**
     * Veröffentlicht die Konfiguration für EIN Gerät.
     *
     * @param gridLimitKw die Anschlussgrenze, oder null = das Portal äußert
     *                    sich nicht und die Box behält ihre eigene Zahl
     * @param priorities  die Vorrang-Säulen (leer = ausdrücklich keine), oder
     *                    null = keine Aussage
     * @param surplusPolicy die Überschuss-Priorität des Kunden, oder null =
     *                    keine Aussage (NIE dasselbe wie „schnell")
     * @param storagePriority wer den Überschuss zuerst bekommt, oder null
     * @param chargePoints die ALLOWLIST - die Box übernimmt jeden Eintrag, den
     *                    sie noch nicht kennt, und ein WEGLASSEN ist kein Löschen
     * @param removedChargePointIds die GRABSTEIN-Liste: die Kennungen, die die
     *                    Box aus ihrer Freigabeliste nehmen soll. Sie reist in
     *                    JEDEM folgenden Dokument mit, nicht einmal
     * @param frame       der Ladepark-RAHMEN (P5/E10), oder null = keine
     *                    Aussage; jedes Feld darin einzeln optional
     * @param storageRank die Position des SPEICHERS in der Rangliste (P6), oder
     *                    null = der Kunde hat nie eine gezogen; dann entscheidet
     *                    allein {@code storagePriority}, wer in den ganzen
     *                    Ueberschuss greifen darf
     * @param wallboxes   die WALLBOXEN, die dem Rahmen beitreten (P6); null =
     *                    keine Aussage und die Box behaelt ihre eigene Liste,
     *                    LEER = „keine Wallbox nimmt teil"
     * @return false, wenn der Broker nicht erreichbar war (best-effort)
     */
    public synchronized boolean publish(UUID tenantId, UUID siteId, UUID deviceId,
            Double gridLimitKw, List<String> priorities, String surplusPolicy,
            String storagePriority, List<AllowedChargePointDto> chargePoints,
            List<String> removedChargePointIds, LadeparkRahmenDto frame, Integer storageRank,
            List<WallboxDto> wallboxes, List<VehicleProfileDto> vehicleProfiles,
            Instant publishedAt) {
        String topic = configTopic(tenantId, siteId, deviceId);
        byte[] payload = document(tenantId, siteId, deviceId, gridLimitKw, priorities,
                surplusPolicy, storagePriority, chargePoints, removedChargePointIds, frame,
                storageRank, wallboxes, vehicleProfiles, publishedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published charging config (grid_limit_kw={}, {} priority stations, "
                    + "{} admitted stations, {} withdrawn) retained to {}",
                    gridLimitKw, priorities == null ? "-" : priorities.size(),
                    chargePoints == null ? 0 : chargePoints.size(),
                    removedChargePointIds == null ? 0 : removedChargePointIds.size(), topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish charging config to {}: {} (best-effort - the next save "
                    + "republishes it)", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Nimmt das Dokument zurück (leere retained Nachricht) - der Unclaim-Pfad:
     * ein Gerät, das niemandem mehr gehört, darf keine Einstellung behalten, die
     * auf dem Broker auf seine Rückkehr wartet (dieselbe Hygiene wie beim
     * Provisionierungs-Config, dem Entity-Push und der OTA-Zuweisung).
     */
    public synchronized boolean clear(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = configTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage(new byte[0]);
            empty.setQos(1);
            empty.setRetained(true);
            connected().publish(topic, empty);
            log.info("cleared retained charging config on {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not clear retained charging config on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Baut das Dokument. Von Hand zusammengesetzt wie die OTA-Umschläge - es ist
     * dieselbe Klasse von Nachricht (eine Einstellung für eine laufende
     * Kundenanlage), und jede Zeichenkette geht durch Jacksons Escaper, damit
     * keine ChargePointId den JSON-Rahmen sprengen kann.
     */
    static byte[] document(UUID tenantId, UUID siteId, UUID deviceId, Double gridLimitKw,
            List<String> priorities, String surplusPolicy, String storagePriority,
            List<AllowedChargePointDto> chargePoints, List<String> removedChargePointIds,
            LadeparkRahmenDto frame, Integer storageRank, List<WallboxDto> wallboxes,
            List<VehicleProfileDto> vehicleProfiles,
            Instant publishedAt) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"schema_version\":\"1.0\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"');
        // ⚠ Abwesend heisst "dazu sagt das Portal nichts" - nie "keine Grenze".
        if (gridLimitKw != null) {
            sb.append(",\"grid_limit_kw\":").append(trim(gridLimitKw));
        }
        if (priorities != null) {
            sb.append(",\"priority_charge_point_ids\":[");
            for (int i = 0; i < priorities.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append('"').append(esc(priorities.get(i))).append('"');
            }
            sb.append(']');
        }
        // ⚠ Stufe 4: dieselbe Regel wie oben - ABWESEND heisst "das Portal
        // aeussert sich nicht" und die Box behaelt ihre Wahl. Es heisst NIE
        // "schnell": das waere eine eigene Aussage des Kunden ("keine
        // Quellen-Politik"), und die beiden zu verschmelzen liesse eine aeltere
        // Cloud ein "Nur Sonnenstrom" still fallen lassen.
        if (surplusPolicy != null && !surplusPolicy.isBlank()) {
            sb.append(",\"surplus_policy\":\"").append(esc(surplusPolicy)).append('"');
        }
        if (storagePriority != null && !storagePriority.isBlank()) {
            sb.append(",\"storage_priority\":\"").append(esc(storagePriority)).append('"');
        }
        // ⚠ P6: die POSITION des Speichers steht NEBEN der anlagenweiten Wahl,
        // nicht an ihrer Stelle - es ist EINE Menge, zweimal gelesen. Fehlt sie
        // (oder fehlt einer Saeule ihr Rang), entscheidet weiter allein
        // `storage_priority`, also exakt wie vor P6.
        if (storageRank != null && storageRank > 0) {
            sb.append(",\"storage_rank\":").append(storageRank.intValue());
        }
        // ⚠ Die Allowlist wird WEGGELASSEN, solange sie leer ist. Abwesend und
        // leer bedeuten der Box hier zwar dasselbe (die Liste fuegt nur hinzu),
        // aber ein leeres Array im Dokument einer Anlage ohne Ladepark waere
        // ein Feld, das eine Aussage vortaeuscht, die niemand getroffen hat.
        if (chargePoints != null && !chargePoints.isEmpty()) {
            sb.append(",\"charge_points\":[");
            for (int i = 0; i < chargePoints.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                appendChargePoint(sb, chargePoints.get(i));
            }
            sb.append(']');
        }
        // ⚠ Die Grabstein-Liste wird ebenso WEGGELASSEN, solange sie leer ist -
        // ein leeres Array behauptete eine Rücknahme, die niemand ausgesprochen
        // hat. Sie reist dafür in JEDEM Dokument mit, solange es sie gibt: das
        // retained Dokument wird als Ganzes ersetzt, also hätte eine nur einmal
        // genannte Löschung eine gerade offline gewesene Box nie erreicht.
        if (removedChargePointIds != null && !removedChargePointIds.isEmpty()) {
            sb.append(",\"removed_charge_point_ids\":[");
            for (int i = 0; i < removedChargePointIds.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append('"').append(esc(removedChargePointIds.get(i))).append('"');
            }
            sb.append(']');
        }
        // ⚠ Der RAHMEN (P5/E10) folgt derselben PATCH-Regel wie jedes andere
        // Feld: ein Wert, den das Portal nicht kennt, wird WEGGELASSEN, damit
        // die Box ihre eigene Zahl behaelt. Ein Rahmen ohne einen einzigen Wert
        // reist gar nicht mit - ein leeres Objekt taeuschte eine Aussage vor.
        if (frame != null && !frame.leer()) {
            sb.append(",\"frame\":{");
            int n = 0;
            n = appendNum(sb, n, "house_reserve_kw", frame.houseReserveKw());
            n = appendNum(sb, n, "margin_pct", frame.marginPct());
            n = appendNum(sb, n, "min_power_kw", frame.minPowerKw());
            if (frame.rotationMinutes() != null) {
                if (n++ > 0) {
                    sb.append(',');
                }
                sb.append("\"rotation_minutes\":").append(frame.rotationMinutes().intValue());
            }
            n = appendNum(sb, n, "max_house_load_kw", frame.maxHouseLoadKw());
            if (frame.staticBudget() != null) {
                if (n++ > 0) {
                    sb.append(',');
                }
                sb.append("\"static_budget\":").append(frame.staticBudget().booleanValue());
            }
            sb.append('}');
        }
        // ⚠ Die WALLBOXEN (P6) folgen der Grabstein-Logik, nicht der Allowlist:
        // eine LEERE Liste IST die Aussage „keine nimmt teil", denn nur so kann
        // eine entfernte Wallbox wieder aus dem Rahmen fallen. Deshalb wird
        // hier - anders als bei `charge_points` - auch das leere Array
        // geschrieben, sobald das Portal ueberhaupt etwas sagt.
        if (wallboxes != null) {
            sb.append(",\"wallboxes\":[");
            for (int i = 0; i < wallboxes.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                appendWallbox(sb, wallboxes.get(i));
            }
            sb.append(']');
        }
        // ⚠ Die FAHRZEUG-PROFILE (P7) sind eine MENGE - und damit die
        // UMGEKEHRTE Regel der Allowlist: eine LEERE Liste reist MIT und nimmt
        // alle Profile zurueck, weil das Portal sie allein besitzt (es gibt
        // dafuer keine :8484-Oberflaeche). Deshalb braucht es hier auch keine
        // Grabstein-Liste. Nur `null` heisst „das Portal aeussert sich nicht".
        if (vehicleProfiles != null) {
            sb.append(",\"vehicle_profiles\":[");
            for (int i = 0; i < vehicleProfiles.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                appendVehicle(sb, vehicleProfiles.get(i));
            }
            sb.append(']');
        }
        sb.append(",\"published_at\":\"").append(publishedAt).append("\"}");
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Ein Fahrzeug-Profil (P7). Kennung und Quelle sind Pflicht - ein Profil
     * ohne Quelle sagt nichts. Der NAME reist mit, damit die lokale Oberflaeche
     * der Box denselben Namen nennen kann wie das Portal; die Box entscheidet
     * nichts danach und gibt ihn an keine Saeule weiter.
     */
    private static void appendVehicle(StringBuilder sb, VehicleProfileDto v) {
        sb.append("{\"tag_ref\":\"").append(esc(v.tagRef())).append('"');
        if (v.name() != null && !v.name().isBlank()) {
            sb.append(",\"name\":\"").append(esc(v.name())).append('"');
        }
        sb.append(",\"source\":\"").append(esc(v.source())).append('"');
        if (v.minKw() != null) {
            sb.append(",\"min_kw\":").append(trim(v.minKw()));
        }
        sb.append('}');
    }

    /**
     * Eine Zeile der Allowlist. Nur die Kennung ist Pflicht; jedes andere Feld
     * reist NUR mit, wenn der Betreiber es wirklich weiss - eine erfundene 0
     * waere hier eine Aussage ueber ein Geraet, das niemand gemessen hat.
     */
    private static void appendChargePoint(StringBuilder sb, AllowedChargePointDto cp) {
        sb.append("{\"id\":\"").append(esc(cp.chargePointId())).append('"');
        if (cp.label() != null && !cp.label().isBlank()) {
            sb.append(",\"label\":\"").append(esc(cp.label())).append('"');
        }
        if (cp.ratedKw() != null) {
            sb.append(",\"rated_kw\":").append(trim(cp.ratedKw()));
        }
        if (cp.connectors() != null) {
            sb.append(",\"connectors\":").append(cp.connectors().intValue());
        }
        // ⚠ Auch der Anschluss reist NUR mit, wenn der Kunde ihn wirklich
        // gesagt hat. Ein hier eingesetztes "haus" waere eine Aussage ueber die
        // Bilanz einer Anlage, die niemand getroffen hat - und wuerde auf der
        // Box eine schon als "eigen" gefuehrte Saeule zurueckdrehen.
        if (cp.connection() != null && !cp.connection().isBlank()) {
            sb.append(",\"connection\":\"").append(esc(cp.connection())).append('"');
        }
        // ⚠ Die STEUERART (P5) folgt genau derselben Regel: abwesend heisst
        // „fuer diese Saeule aeussert sich das Portal nicht" und es gilt der
        // ANLAGEN-STANDARD - nie „schnell", das waere eine Netzstrom-Freigabe,
        // die niemand erteilt hat.
        if (cp.source() != null && !cp.source().isBlank()) {
            sb.append(",\"source\":\"").append(esc(cp.source())).append('"');
        }
        if (cp.minKw() != null) {
            sb.append(",\"min_kw\":").append(trim(cp.minKw()));
        }
        // ⚠ Der RANG (P6) reist nur mit, wenn diese Saeule wirklich in der
        // Rangliste des Kunden steht. Abwesend heisst „ungerankt", und die Box
        // verteilt dann exakt wie vor P6 (die Vorrang-Menge allein). Gleiche
        // Zahlen sind GLEICHRANGIG - die Box wechselt zwischen ihnen weiter ab.
        if (cp.rank() != null && cp.rank() > 0) {
            sb.append(",\"rank\":").append(cp.rank().intValue());
        }
        sb.append('}');
    }

    /**
     * Eine Wallbox im Rahmen. Nur die Kennung ist Pflicht - jede Zahl reist NUR
     * mit, wenn sie wirklich gepflegt ist. Eine erfundene 0 waere hier eine
     * Aussage ueber ein Geraet, das niemand gemessen hat.
     */
    private static void appendWallbox(StringBuilder sb, WallboxDto wb) {
        sb.append("{\"entity_id\":\"").append(esc(wb.entityId().toString())).append('"');
        if (wb.label() != null && !wb.label().isBlank()) {
            sb.append(",\"label\":\"").append(esc(wb.label())).append('"');
        }
        if (wb.ratedKw() != null) {
            sb.append(",\"rated_kw\":").append(trim(wb.ratedKw()));
        }
        if (wb.minKw() != null) {
            sb.append(",\"min_kw\":").append(trim(wb.minKw()));
        }
        if (wb.rank() != null && wb.rank() > 0) {
            sb.append(",\"rank\":").append(wb.rank().intValue());
        }
        sb.append('}');
    }

    /** Ein optionales Zahlenfeld des Rahmens; n = wie viele schon dastehen. */
    private static int appendNum(StringBuilder sb, int n, String key, Double v) {
        if (v == null) {
            return n;
        }
        if (n > 0) {
            sb.append(',');
        }
        sb.append('"').append(key).append("\":").append(trim(v));
        return n + 1;
    }

    /** Ganze Zahlen ohne Nachkomma - 277 statt 277.0 im Kunden-Dokument. */
    private static String trim(double v) {
        if (v == Math.rint(v) && !Double.isInfinite(v)) {
            return String.valueOf((long) v);
        }
        return String.valueOf(v);
    }

    private static String esc(String v) {
        return v == null ? "" : new String(JsonStringEncoder.getInstance().quoteAsString(v));
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-chargingcfg-" + UUID.randomUUID(),
                    new MemoryPersistence());
        }
        if (!client.isConnected()) {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            options.setConnectionTimeout(5);
            options.setAutomaticReconnect(true);
            if (username != null && !username.isBlank()) {
                options.setUserName(username);
                options.setPassword(password == null ? new char[0] : password.toCharArray());
            }
            client.connect(options);
        }
        return client;
    }

    @PreDestroy
    public synchronized void close() {
        if (client == null) {
            return;
        }
        try {
            if (client.isConnected()) {
                client.disconnect();
            }
            client.close(true);
        } catch (Exception e) {
            log.debug("charging config publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
