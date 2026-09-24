package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Wendet die {@link ComponentRebind}-Regel auf eine Anlage an: eine Komponente,
 * deren Bindung gerissen ist, wird wieder an DASSELBE Gerät gepinnt, sobald es
 * sich unter einer neuen Kennung meldet.
 *
 * <p>Der Aufrufer muss den Mandanten im {@code TenantContext} gesetzt haben -
 * jeder Lese- und Schreibvorgang läuft über den RLS-Pfad (das
 * {@link ComponentAdoptionService}-Muster).
 *
 * <p><b>Der Push gehört dazu.</b> Der Pin reist IM Registry-Push
 * ({@code edge_source_id}, D-17), mit dem die Box ihre eigenen Quellen-Messwerte
 * auf die Entität abbildet - ein Re-Pin, den das Gerät nie erfährt, wäre auf
 * {@code :8484} weiterhin die alte Zuordnung. Er ist best-effort: die Bindung im
 * Portal ist ohne ihn schon richtig, und der nächste Push holt ihn nach.
 */
@Service
public class ComponentRebindService {

    private static final Logger log = LoggerFactory.getLogger(ComponentRebindService.class);

    /** Der Kennungs-Präfix, unter dem der Zuhörer eine gemeldete Quelle ablegt. */
    private static final String LOCAL_PREFIX = "local:";

    /** Was ein Lauf für eine Anlage getan hat. */
    public record Outcome(int rebound) {}

    private final EntityRegistryRepository entityRepo;
    private final EntityObservedRepository observed;
    private final EntityRegistryService entityRegistry;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComponentRebindService(EntityRegistryRepository entityRepo,
            EntityObservedRepository observed, EntityRegistryService entityRegistry) {
        this.entityRepo = entityRepo;
        this.observed = observed;
        this.entityRegistry = entityRegistry;
    }

    /**
     * Stellt gerissene Bindungen dieser Anlage wieder her. Findet sich kein
     * eindeutiges Paar, passiert NICHTS - der manuelle Weg bleibt.
     */
    @Transactional
    public Outcome rebindOrphanedPins(UUID siteId) {
        List<ComponentRebind.PinnedComponent> pinned = new ArrayList<>();
        for (EntityRow row : entityRepo.pointsForSite(siteId)) {
            boolean hasPin = row.edgeSourceId() != null && !row.edgeSourceId().isBlank();
            // Ohne Pin zählt nur eine Komponente mit gespeicherter Anbindung
            // (die Erstbindung einer im Portal angelegten Komponente); eine
            // komponierte Zeile ohne Verbindung hat nichts wiederzuerkennen.
            if (!hasPin && (row.communication() == null || row.communication().isBlank()
                    || row.connectionJson() == null || row.connectionJson().isBlank())) {
                continue;
            }
            pinned.add(new ComponentRebind.PinnedComponent(row.id(),
                    hasPin ? row.edgeSourceId() : null,
                    row.role(), row.communication(), row.connectionJson(), row.label()));
        }
        if (pinned.isEmpty()) {
            return new Outcome(0);
        }

        List<ComponentRebind.ReportedDevice> reported = new ArrayList<>();
        for (ObservedRow row : observed.forSite(siteId)) {
            if (!"local".equals(row.source())) {
                continue;
            }
            // Der Wechselrichter-Eintrag trägt keine Rolle und fällt damit von
            // selbst heraus (ein Fingerabdruck ohne Rolle ist keiner) - er ist
            // die AUSWAHL der Box, keine Quelle, und war nie gepinnt.
            EntityObservedRepository.EdgeLink link = row.edgeLink();
            reported.add(new ComponentRebind.ReportedDevice(stripLocal(row.entityId()),
                    row.edgeRole(), link == null ? null : link.communication(),
                    link == null ? null : link.connectionJson(), row.label()));
        }

        List<ComponentRebind.Rebind> plan = ComponentRebind.decide(pinned, reported, mapper);
        if (plan.isEmpty()) {
            return new Outcome(0);
        }
        for (ComponentRebind.Rebind r : plan) {
            entityRepo.setEdgeSource(r.pointId(), r.toSourceId());
            if (r.fromSourceId() == null) {
                log.info("Bindung hergestellt: Komponente {} (\"{}\") der Anlage {} hängt jetzt an "
                        + "der gemeldeten Quelle {}", r.pointId(), r.label(), siteId, r.toSourceId());
                continue;
            }
            log.warn("Bindung wiederhergestellt: Komponente {} (\"{}\") der Anlage {} war an die "
                    + "Kennung {} gepinnt und hängt jetzt wieder an demselben Gerät unter {}",
                    r.pointId(), r.label(), siteId, r.fromSourceId(), r.toSourceId());
        }
        entityRegistry.pushRegistryBestEffort(siteId);
        return new Outcome(plan.size());
    }

    private static String stripLocal(String entityId) {
        if (entityId == null) {
            return "";
        }
        return entityId.startsWith(LOCAL_PREFIX) ? entityId.substring(LOCAL_PREFIX.length())
                : entityId;
    }
}
