package com.voltpilot.api.web;

import com.voltpilot.api.components.ComponentAuthority;
import com.voltpilot.api.components.ComponentService;
import com.voltpilot.api.repo.AdminComponentFleetRepository;
import com.voltpilot.api.repo.AdminComponentFleetRepository.ApplyRow;
import com.voltpilot.api.repo.AdminComponentFleetRepository.ComponentCounts;
import com.voltpilot.api.repo.AdminComponentFleetRepository.ControlRow;
import com.voltpilot.api.web.dto.AdminComponentFleetDto;
import com.voltpilot.api.web.dto.AdminComponentFleetDto.ComponentSourceCounts;
import com.voltpilot.api.web.dto.AdminComponentFleetDto.FleetSiteRow;
import com.voltpilot.api.web.dto.AdminComponentFleetDto.WriteAccess;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Betriebs-Sicht auf die Komponenten-Welt der Flotte (Einheitsmodell
 * Stufe 6).
 *
 * <p>EIN Aggregat, server-seitig - das Muster von {@code AdminFleetController}:
 * ein knappes Dutzend plattformweiter Abfragen, danach nur noch
 * {@code Map.get} in der Schleife. Kein N+1, kein Client-Fan-out über die
 * Mandanten.
 *
 * <p><b>Read-only.</b> Es entsteht kein neuer Schreibweg: verwaltet wird
 * weiter je Anlage (Kunden-Route) bzw. je Vorlage
 * ({@link AdminComponentTemplateController}).
 */
@RestController
@RequestMapping("/api/v1/admin/component-fleet")
@PreAuthorize("hasRole('platform-admin')")
public class AdminComponentFleetController {

    private final AdminComponentFleetRepository fleet;

    public AdminComponentFleetController(AdminComponentFleetRepository fleet) {
        this.fleet = fleet;
    }

    @GetMapping
    public AdminComponentFleetDto components() {
        Map<UUID, ComponentCounts> counts = fleet.componentsPerSite();
        Map<UUID, String> soll = fleet.registryRevisionPerSite();
        Map<UUID, ApplyRow> ist = fleet.applyPerSite();
        Map<UUID, ControlRow> control = fleet.controlPerSite();
        Map<UUID, Integer> activations = fleet.activationsPerSite();
        Map<UUID, Integer> templateWrites = fleet.templateWritesPerSite();
        Map<UUID, Integer> privateTemplates = fleet.privateTemplatesPerSite();

        List<FleetSiteRow> rows = new ArrayList<>();
        for (AdminComponentFleetRepository.SiteRow s : fleet.sites()) {
            ComponentCounts c = counts.get(s.siteId());
            ApplyRow a = ist.get(s.siteId());
            ControlRow cs = control.get(s.siteId());
            rows.add(new FleetSiteRow(
                    s.siteId(), s.siteName(), s.tenantId(), s.tenantName(),
                    // Alles, was nicht wörtlich `portal` ist, gilt als box - die
                    // Autoritäts-Regel des Hauses, hier wie überall.
                    ComponentAuthority.of(s.componentAuthority()),
                    s.componentsAdoptedAt(), s.componentsAdoptedBy(),
                    c == null ? 0 : c.total(),
                    c == null ? null : new ComponentSourceCounts(c.builtin(), c.certified(),
                            c.custom(), c.composed(), c.unknown()),
                    privateTemplates.getOrDefault(s.siteId(), 0),
                    // Wörtlich dieselbe Ableitung wie die Kunden-Fläche - inklusive
                    // der vom Gerät gemeldeten Autorität (L8). Nur der fehlende
                    // Empfänger (L10) bleibt draußen: den kennt diese Sicht nicht,
                    // und was sie nicht weiß, behauptet sie nicht.
                    ComponentService.syncStatus(soll.get(s.siteId()),
                            a == null ? null : a.appliedRevision(),
                            a == null ? null : a.heldRevision(),
                            a == null ? null : a.authority(), false),
                    a == null ? null : a.refusedRevision(),
                    a == null ? null : a.refusedReason(),
                    a == null ? null : a.reportedAt(),
                    new WriteAccess(
                            c == null ? 0 : c.control(),
                            activations.getOrDefault(s.siteId(), 0),
                            templateWrites.getOrDefault(s.siteId(), 0),
                            cs == null ? null : cs.certSource(),
                            cs == null ? null : cs.platformCertVerdict(),
                            cs == null ? null : cs.platformCertModel())));
        }
        return new AdminComponentFleetDto(List.copyOf(rows));
    }
}
