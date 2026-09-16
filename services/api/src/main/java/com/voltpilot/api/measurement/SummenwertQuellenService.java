package com.voltpilot.api.measurement;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.uems.PushJeBox;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
        var quellen = registry.datenquelleJeEntitaet(siteId);
        var v = PushJeBox.verteilen(rows.stream().map(r -> new PushJeBox.Entitaet(r.id(), r.entityType(), quellen.get(r.id()))).toList(),
                lead.fuehrendeBox(siteId).box(), registry.siteDeviceIds(siteId),
                registry.zustaendigkeitenDerQuellen(siteId), Instant.now(), List.of());
        return rows.stream().map(r -> {
            UUID box = v.boxen().entrySet().stream().filter(e -> e.getValue().contains(r.id())).map(Map.Entry::getKey).findFirst().orElse(null);
            String grund = v.ausgelassen().stream().filter(a -> a.entitaet().equals(r.id())).map(a -> a.grund().code()).findFirst().orElse(null);
            return new Quelle(r.id(), box, r.label() == null ? "Gerät" : r.label(), grund);
        }).toList();
    }
}
