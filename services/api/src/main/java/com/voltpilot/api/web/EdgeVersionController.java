package com.voltpilot.api.web;

import com.voltpilot.api.ota.EdgeStandVerdict;
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
 * <p>Der Core-Stand kommt bevorzugt aus dem top-level Update-Herzschlag, der
 * unabhängig von einem Flow-Deployment gesendet wird. Der historische
 * {@code flows.core_version}-Beleg bleibt Fallback; die Palette-Version kommt
 * weiterhin aus dem Flow-Block. Eine leere Liste heißt daher wirklich „kein
 * Gerät hat je einen verwertbaren Stand gemeldet", nicht „alle aktuell".
 *
 * <p><b>Seit Geräteseiten Stufe 1 (R2a) trägt jede Zeile zusätzlich das
 * URTEIL</b> gegen das Release-Register ({@code newestRelease}/{@code upToDate},
 * gebildet von {@link EdgeStandVerdict}) - der Maßstab erreichte den Kunden bis
 * dahin überhaupt nicht, seine Box zeigte also eine Version, die niemand
 * einordnen konnte. Es reist das Urteil, NIE das Register.
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
        // EINMAL gelesen, N-mal befragt: das Register ist für alle Geräte
        // dasselbe, und der Kunden-Lesepfad soll es nicht je Zeile holen.
        List<EdgeVersionRepository.RegisterEntry> register = edgeVersions.releases();
        return edgeVersions.findAll().stream()
                .map(v -> {
                    EdgeStandVerdict.Verdict urteil =
                            EdgeStandVerdict.of(v.coreVersion(), register);
                    return new EdgeVersionDto(v.deviceId(), v.siteId(), v.coreVersion(),
                            v.paletteVersion(), v.reportedAt(), urteil.newestRelease(),
                            urteil.upToDate());
                })
                .toList();
    }
}
