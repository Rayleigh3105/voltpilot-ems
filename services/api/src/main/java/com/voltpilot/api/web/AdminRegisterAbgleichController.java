package com.voltpilot.api.web;

import com.voltpilot.api.repo.AdminRegisterAbgleichRepository;
import com.voltpilot.api.web.dto.RegisterAbgleichDto;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Plattform-Admin "Register-Abgleich" (S5, vp-mastr-mehrere-einheiten-
 * konzept §6/§8): {@code GET /api/v1/admin/register-abgleich}.
 *
 * <p>Sicherheits-Disziplin wie {@link AdminFleetController}: die Route liegt
 * unter {@code /api/v1/admin/**}, {@code @PreAuthorize("hasRole('platform-
 * admin')")} - ein Kunden-Token bekommt 403. Die RLS-Umgehung ist auf
 * {@link AdminRegisterAbgleichRepository} beschränkt, read-only.
 */
@RestController
@RequestMapping("/api/v1/admin/register-abgleich")
@PreAuthorize("hasRole('platform-admin')")
public class AdminRegisterAbgleichController {

    /** Dasselbe Fenster wie {@code AdminFleetController.PV_PEAK_LOOKBACK}. */
    private static final Duration PV_PEAK_LOOKBACK = Duration.ofDays(30);

    private final AdminRegisterAbgleichRepository repo;

    public AdminRegisterAbgleichController(AdminRegisterAbgleichRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public RegisterAbgleichDto abgleich() {
        List<AdminRegisterAbgleichRepository.Zeile> messung =
                repo.messungUeberSumme(Instant.now().minus(PV_PEAK_LOOKBACK));
        return new RegisterAbgleichDto(
                zeilen(messung), zeilen(repo.registerGeaendertSeitUebernahme()),
                zeilen(repo.nummerAnZweiAnlagen()), zeilen(repo.ohneRegister()));
    }

    private static List<RegisterAbgleichDto.Zeile> zeilen(List<AdminRegisterAbgleichRepository.Zeile> rows) {
        return rows.stream()
                .map(r -> new RegisterAbgleichDto.Zeile(r.siteId(), r.siteName(), r.tenantId(), r.tenantName(),
                        r.hinweis()))
                .toList();
    }
}
