package com.voltpilot.api.web;

import com.voltpilot.api.repo.AdminDirektvermarktungRepository;
import com.voltpilot.api.repo.AdminDirektvermarktungRepository.Zeile;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Direktvermarktung-Liste der Plattform (Plattform › Übersicht Kennzahl, Konzept
 * vp-direktvermarktung-konzept d2 §7.7). {@code @PreAuthorize("hasRole('platform-admin')")} wie
 * {@link AdminFleetController}; die RLS-Umgehung bleibt auf {@link AdminDirektvermarktungRepository}
 * beschränkt (dieselbe dedizierte BYPASSRLS-Rolle), read-only.
 */
@RestController
@RequestMapping("/api/v1/admin/direktvermarktung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminDirektvermarktungController {

    /** Eine Zeile der Plattform-Liste. */
    public record AdminDirektvermarktungZeileDto(UUID siteId, String siteName, UUID tenantId, String tenantName,
            String partner, String zustand, LocalDate startdatum, LocalDate ende, Instant aktualisiertAm,
            Instant letzteAbfrageAm, Instant lebenszeichenAm) {

        static AdminDirektvermarktungZeileDto von(Zeile z) {
            return new AdminDirektvermarktungZeileDto(z.siteId(), z.siteName(), z.tenantId(), z.tenantName(),
                    z.partner(), z.zustand(), z.startdatum(), z.ende(), z.aktualisiertAm(), z.letzteAbfrageAm(),
                    z.lebenszeichenAm());
        }
    }

    private final AdminDirektvermarktungRepository repo;

    public AdminDirektvermarktungController(AdminDirektvermarktungRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<AdminDirektvermarktungZeileDto> aktive() {
        return repo.aktive().stream().map(AdminDirektvermarktungZeileDto::von).toList();
    }
}
