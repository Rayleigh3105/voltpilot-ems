package com.voltpilot.api.chargers;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Räumt die Komponente einer zurückgenommenen Ladesäule ab (vp-ladepunkte-doppelt).
 *
 * <p>Aus jeder gemeldeten Säule komponiert die Plattform eine {@code ev-charger}-Komponente
 * ({@link ChargerComponentComposer}); Steuerung › Laden liest diese Komponenten. Nimmt der Kunde die
 * Kennung zurück („Ladesäule entfernen"), verschwindet die gemeldete Zeile - die Komponente blieb bis
 * hierher stehen und mit ihr ein Ladepunkt unter Laden, den es an der Anlage nicht mehr gibt.
 *
 * <p>Gelöscht wird über DENSELBEN Weg wie „Komponente entfernen" ({@link
 * EntityRegistryService#deleteEntity(UUID, UUID, boolean)} mit {@code purgePoint}): Rollen, Regel-Anspruch
 * und Punkt gehen zusammen, ein Beleg freigegebener Berichtsstände sperrt wie dort, aufgezeichnete
 * Messwerte bleiben.
 *
 * <p>⚠ In einem EIGENEN Sicherungspunkt ({@link Propagation#NESTED}): die Rücknahme der Kennung ist
 * die Handlung des Kunden und darf an ihrer Komponente nie scheitern. Sperrt ein Beleg oder ein
 * Fremdschlüssel (eine Komponente im Zählerbaum wird nie gelöscht), rollt nur dieser Schritt zurück;
 * die Komponente bleibt gespeichert, und Laden zeigt sie trotzdem nicht mehr, weil keine Box ihre
 * Säule meldet ({@code VerbraucherService}).
 */
@Component
public class LadepunktKomponenteAbbau {

    private final EntityRegistryRepository entities;
    private final EntityRegistryService registry;

    public LadepunktKomponenteAbbau(EntityRegistryRepository entities, EntityRegistryService registry) {
        this.entities = entities;
        this.registry = registry;
    }

    /**
     * Löscht die Komponente, wenn sie eine plattform-komponierte Ladesäule ist. {@code false}: es gab
     * an dieser Anlage keine solche Komponente (mehr). Eine Ablehnung wirft - der Aufrufer fängt sie.
     */
    @Transactional(propagation = Propagation.NESTED)
    public boolean entferne(UUID siteId, UUID entityId) {
        EntityRow row = entities.entityForSite(siteId, entityId);
        if (row == null || !ChargerComponentComposer.TYPE_EV_CHARGER.equals(row.entityType())) {
            return false;
        }
        return registry.deleteEntity(siteId, entityId, true);
    }
}
