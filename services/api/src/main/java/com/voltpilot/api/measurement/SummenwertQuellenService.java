package com.voltpilot.api.measurement;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** Die lesende Box einer Komponente ist dieselbe wie im Registry-Push, nicht ihr Transport. */
@Service
public class SummenwertQuellenService {
    public record Quelle(UUID entityId, UUID deviceId, String name, String grund) {}
    private final EntityRegistryRepository registry;
    private final LeadDeviceService lead;
    public SummenwertQuellenService(EntityRegistryRepository registry, LeadDeviceService lead) {
        this.registry = registry; this.lead = lead;
    }
    public List<Quelle> sources(UUID siteId) {
        var rows = registry.entitiesForSite(siteId);
        var fuehrend = lead.fuehrendeBox(siteId);
        return rows.stream().map(r -> new Quelle(r.id(), fuehrend.box(),
                r.label() == null ? "Gerät" : r.label(),
                fuehrend.box() == null ? fuehrend.grund().code() : null)).toList();
    }
}
