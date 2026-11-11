package com.voltpilot.api.web;

import com.voltpilot.api.repo.AdminMeldungenRepository;
import com.voltpilot.api.repo.AdminMeldungenRepository.AdminMeldungZeile;
import com.voltpilot.api.web.dto.AdminMeldungDto;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Meldungen plattformweit (Lücke L5, E7 "Braucht dich"):
 * {@code GET /api/v1/admin/meldungen}. Der mandantenbezogene Pfad
 * ({@code MeldungenController} unter {@code /api/v1/meldungen}) bleibt
 * unangetastet - dies ist ein zweiter, admin-geschützter Pfad über
 * {@link AdminMeldungenRepository} (BYPASSRLS-Rolle {@code voltpilot_admin}),
 * wie {@link AdminFleetController}.
 */
@RestController
@RequestMapping("/api/v1/admin/meldungen")
@PreAuthorize("hasRole('platform-admin')")
public class AdminMeldungenController {

    private static final int LIMIT = 200;

    private final AdminMeldungenRepository repo;

    public AdminMeldungenController(AdminMeldungenRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public AdminMeldungDto.Liste liste(@RequestParam(required = false) String status) {
        boolean verlauf = "verlauf".equals(status);
        return new AdminMeldungDto.Liste(repo.liste(verlauf, LIMIT).stream().map(this::dto).toList());
    }

    @GetMapping("/zahl")
    public AdminMeldungDto.Zahl zahl() {
        return new AdminMeldungDto.Zahl(repo.ungeseheneZahl());
    }

    private AdminMeldungDto dto(AdminMeldungZeile a) {
        return new AdminMeldungDto(a.id().toString(), a.kennzeichen(), a.tenantId().toString(),
                a.tenantName(), a.standortId() == null ? null : a.standortId().toString(),
                a.bezugKennung(), a.wertart(), a.schwere(), a.ausgeloestAm(), a.zustand(),
                a.wiederNormalAm(), a.gesehenVon(), a.gesehenAm(), a.erledigtAm());
    }
}
