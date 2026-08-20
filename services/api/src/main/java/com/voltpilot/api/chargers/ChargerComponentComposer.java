package com.voltpilot.api.chargers;

import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.UnboundCharger;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Aus einer gemeldeten Ladesäule wird eine KOMPONENTE - automatisch, ohne einen
 * einzigen Klick (Lastmanagement Stufe 3, Konzept §5.3 / E5).
 *
 * <p>Es ist das Bestands-Übernahme-Muster des Hauses, telemetrie-getrieben: der
 * Herzschlag-Zuhörer ruft {@link #ensureComposed} nach jedem verarbeiteten
 * Block, und was hier passiert, ist genau EIN Schritt - eine Säule, die sich
 * gemeldet hat und noch keine Komponente trägt, bekommt eine. Ein Ladepunkt
 * erscheint damit im Anlagen-Modell und in der Topologie, sobald er da ist;
 * niemand legt ihn an, weil ihn niemand ERFINDEN kann - er ist ein physisches
 * Gerät, das sich selbst gemeldet hat.
 *
 * <p><b>WAS komponiert wird, entscheidet allein {@link EntityRegistryService}</b>
 * (Katalog-Typ {@code ev-charger}, Fähigkeiten + Guards aus dem Katalog) - hier
 * steht nur die AUSLÖSE-Politik. Dieselbe Arbeitsteilung wie beim
 * {@code EntityAutoComposer}: eine zweite Kompositions-Wahrheit wäre genau die
 * Doppeldeutigkeit, gegen die das Einheitsmodell gebaut ist.
 *
 * <p><b>⚠ Es entsteht keine zweite Wahrheit über die MESSWERTE.</b> Die
 * Komponente ist die Modell-Seite (Anlagen-Modell, Rollen, der Name, den der
 * Kunde vergibt); die LEBENDEN Zahlen bleiben der Ladepunkt-Lesepfad
 * ({@code /sites/{id}/chargers}), der die Worte der Box weiterreicht. Die
 * Komponente trägt deshalb auch keine {@code connection_json}: eine Anbindung,
 * die der Box-Applier nicht kennt, ließe seine ALLES-ODER-NICHTS-Ableitung
 * scheitern und nähme einer Anlage mit ihrer ersten Ladesäule die Anwendung
 * ihres Wechselrichters - dieselbe Falle, gegen die der Selbstbau-Skip
 * existiert.
 *
 * <p><b>⚠ Nie werfend.</b> Ein Ladepunkt, der lädt, ist wichtiger als sein
 * Modell-Eintrag: jeder Fehler wird protokolliert und verschluckt (das
 * {@code EntityAutoComposer}/{@code RuleEventWriter}-Muster), und der nächste
 * Herzschlag versucht es erneut.
 *
 * <p><b>Genau EINMAL je Säule.</b> Die Bindung steht in
 * {@code device_charge_point.entity_id} und überlebt das Ersetzen des Satzes.
 * Löscht ein Kunde die Komponente bewusst, wird sie NICHT beim nächsten
 * Herzschlag neu erfunden - dieselbe Zusage, die eine bewusst gelöschte
 * komponierte Entität schon heute hat.
 */
@Component
public class ChargerComponentComposer {

    private static final Logger log = LoggerFactory.getLogger(ChargerComponentComposer.class);

    /** Der Katalog-Typ einer Ladesäule (seit Stufe 0 im Typkatalog). */
    public static final String TYPE_EV_CHARGER = "ev-charger";

    private final DeviceChargerStatusRepository chargerStatus;
    private final EntityRegistryService registry;

    public ChargerComponentComposer(DeviceChargerStatusRepository chargerStatus,
            EntityRegistryService registry) {
        this.chargerStatus = chargerStatus;
        this.registry = registry;
    }

    /**
     * Stellt sicher, dass jede gemeldete Säule dieses Geräts eine Komponente
     * hat. Läuft unter dem Mandanten-Kontext des Aufrufers (RLS).
     */
    public void ensureComposed(UUID siteId, UUID deviceId) {
        try {
            List<UnboundCharger> open = chargerStatus.unbound(siteId);
            for (UnboundCharger c : open) {
                if (!deviceId.equals(c.deviceId())) {
                    continue;
                }
                EntityRow row = registry.createEntity(siteId, TYPE_EV_CHARGER, label(c), null,
                        null, null);
                chargerStatus.bindEntity(c.deviceId(), c.chargePointId(), row.id());
                log.info("Ladepunkt {} der Anlage {} ist jetzt eine Komponente ({})",
                        c.chargePointId(), siteId, row.id());
            }
        } catch (Exception e) {
            // Nie werfend: der Ladevorgang zählt, der Modell-Eintrag holt auf.
            log.warn("Ladepunkt-Komponenten der Anlage {} konnten nicht angelegt werden: {}",
                    siteId, e.toString());
        }
    }

    /**
     * Der Anzeigename: der vom Betreiber vergebene, sonst die ChargePointId.
     * Die Id ist ein technischer Fakt und ein zumutbarer Platzhalter - sie zu
     * verschönern erfände einen Namen, den niemand vergeben hat. Der Kunde
     * benennt die Komponente danach mit dem üblichen Stift um.
     */
    private static String label(UnboundCharger c) {
        return c.label() == null || c.label().isBlank() ? c.chargePointId() : c.label();
    }
}
