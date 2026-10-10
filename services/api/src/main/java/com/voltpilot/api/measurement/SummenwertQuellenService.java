package com.voltpilot.api.measurement;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.uems.PushJeBox;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import com.voltpilot.api.uems.MessstelleFormelAbgelehnt;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** Die lesende Box einer Komponente ist dieselbe wie im Registry-Push, nicht ihr Transport. */
@Service
public class SummenwertQuellenService {
    public record Quelle(UUID entityId, UUID deviceId, String name, String grund) {}
    private final EntityRegistryRepository registry;
    private final LeadDeviceService lead;
    private final MeasurementSelectionRepository components;
    public SummenwertQuellenService(EntityRegistryRepository registry, LeadDeviceService lead,
            MeasurementSelectionRepository components) {
        this.registry = registry; this.lead = lead; this.components = components;
    }
    /** Eine Box allein ist keine Grenze; der Server löst die stabile Gerätekennung auf. */
    public Set<UUID> geraet(UUID siteId, UUID boxId, String geraetId) {
        if (boxId == null || geraetId == null || geraetId.isBlank())
            throw MessstelleFormelAbgelehnt.anfrage("kontext", "Box und Gerätekennung fehlen.");
        var box = components.deviceScope(boxId);
        if (box == null || !siteId.equals(box.siteId())) throw new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        var ids = components.geraeteKomponenten(siteId, boxId).stream()
                .filter(r -> geraetId.equals(r.geraetId())).map(MeasurementSelectionRepository.GeraeteKomponente::entityId)
                .collect(Collectors.toSet());
        if (ids.isEmpty()) throw new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        return Set.copyOf(ids);
    }

    public List<Quelle> sources(UUID siteId, UUID boxId, String geraetId) {
        if (boxId == null && geraetId == null) return sources(siteId);
        var erlaubt = geraet(siteId, boxId, geraetId);
        return sources(siteId).stream().filter(q -> erlaubt.contains(q.entityId())).toList();
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
