package com.voltpilot.api.measurement;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.uems.MessstelleFormelAbgelehnt;
import java.util.List;
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
        var fuehrend = lead.fuehrendeBox(siteId);
        return rows.stream().map(r -> new Quelle(r.id(), fuehrend.box(),
                r.label() == null ? "Gerät" : r.label(),
                fuehrend.box() == null ? fuehrend.grund().code() : null)).toList();
    }
}
