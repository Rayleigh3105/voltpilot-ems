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
 *
 * <p><b>Ohne {@code teilansicht} — die benannte Lücke von AP-03 IP-10.</b> Diese Route antwortet mit einer
 * NACKTEN LISTE und kann das additive Feld {@code teilansicht {sichtbar, gesamt}} darum nicht im Körper
 * tragen; ein Umschlag {@code {eintraege, teilansicht}} wäre ein Bruch des Vertrags an einer Kernroute.
 * <b>Einzulösen mit AP-03 IP-12</b> (Portal-Rechte-Weiche): dort werden {@code api.ts} und die
 * Kundenflächen ohnehin umgestellt, und der Umschlag ist dann billig. Die Sicherheitszusage hängt nicht
 * daran — die Liste zeigt ausschließlich Sichtbares (Standort-Zaun {@code site_scope}, IP-5) —, und den
 * Satz „Teilansicht: n von m Standorten" zeichnet das Portal aus {@code GET /api/v1/me}.
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
