package com.voltpilot.api.web;

import com.voltpilot.api.repo.EdgeVersionRepository;
import com.voltpilot.api.web.dto.EdgeVersionDto;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der gemeldete Edge-Stand aller Geräte des aufrufenden Mandanten
 * ({@code GET /api/v1/edge-versions}) - die Datenquelle der Spalte
 * „Edge-Stand" in der Plattform-Übersicht.
 *
 * <p>Bewusst eine KUNDEN-förmige Route und nicht {@code /api/v1/admin/**}: die
 * Plattform-Übersicht aggregiert Stufe 1 client-seitig über die Mandanten und
 * setzt je Aufruf {@code X-Tenant-Id} - also genau der Weg, den auch
 * {@code /overview} nimmt. RLS ist der Zaun (kein Mandanten-Prädikat in der
 * Abfrage), BYPASSRLS bleibt hinter {@code /api/v1/admin/**}. Ein Kunde sieht
 * damit den Stand seiner EIGENEN Geräte - das ist keine Interna-Preisgabe,
 * sondern die Version, die auf seinem Gerät läuft.
 *
 * <p>Eine leere Liste heißt „kein Gerät hat je eine Version gemeldet", nicht
 * „alle aktuell" - die Oberfläche muss das als „unbekannt" zeigen.
 */
@RestController
@RequestMapping("/api/v1/edge-versions")
public class EdgeVersionController {

    private final EdgeVersionRepository edgeVersions;

    public EdgeVersionController(EdgeVersionRepository edgeVersions) {
        this.edgeVersions = edgeVersions;
    }

    @GetMapping
    public List<EdgeVersionDto> list() {
        return edgeVersions.findAll().stream()
                .map(v -> new EdgeVersionDto(v.deviceId(), v.siteId(), v.coreVersion(),
                        v.paletteVersion(), v.reportedAt()))
                .toList();
    }
}
