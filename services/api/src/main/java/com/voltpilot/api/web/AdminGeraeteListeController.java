package com.voltpilot.api.web;

import com.voltpilot.api.repo.AdminGeraeteListeRepository;
import com.voltpilot.api.repo.AdminGeraeteListeRepository.GeraeteListeZeile;
import com.voltpilot.api.web.dto.AdminGeraeteListeDto;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die eine Geräte-Liste über alle Lebensabschnitte (Lücke L7):
 * {@code GET /api/v1/admin/geraeteliste}. Ersetzt die client-seitige
 * Zusammensetzung aus Registrierung (Aufkleber + Geräte), Anmeldungen und
 * Werkstatt - {@link AdminGeraeteListeRepository} liefert sie bereits
 * zusammengeführt.
 */
@RestController
@RequestMapping("/api/v1/admin/geraeteliste")
@PreAuthorize("hasRole('platform-admin')")
public class AdminGeraeteListeController {

    private final AdminGeraeteListeRepository repo;

    public AdminGeraeteListeController(AdminGeraeteListeRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public AdminGeraeteListeDto.Liste liste() {
        return new AdminGeraeteListeDto.Liste(repo.alle().stream().map(this::dto).toList());
    }

    private AdminGeraeteListeDto dto(GeraeteListeZeile z) {
        return new AdminGeraeteListeDto(z.externalRef(), z.lebensabschnitt(), z.seit(),
                z.deviceId() == null ? null : z.deviceId().toString(),
                z.siteId() == null ? null : z.siteId().toString(),
                z.tenantId() == null ? null : z.tenantId().toString(),
                z.tenantName(), z.name());
    }
}
