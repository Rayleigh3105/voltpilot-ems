package com.voltpilot.api.web;

import com.voltpilot.api.repo.AdminDirektvermarktungRepository;
import com.voltpilot.api.repo.AdminDirektvermarktungRepository.ProtokollZeile;
import com.voltpilot.api.repo.AdminDirektvermarktungRepository.SiteDetail;
import com.voltpilot.api.repo.AdminDirektvermarktungRepository.Zeile;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Direktvermarktung-Sicht der Plattform (Plattform › Übersicht, Geräteakte › Verbindung, Konzept
 * vp-direktvermarktung-konzept d2 §7.7). {@code @PreAuthorize("hasRole('platform-admin')")} wie
 * {@link AdminFleetController}; die RLS-Umgehung bleibt auf {@link AdminDirektvermarktungRepository}
 * beschränkt (dieselbe dedizierte BYPASSRLS-Rolle), read-only - kein Schlüssel, kein Passwort, kein
 * Dateiinhalt verlässt je diese Route (§7.7 "Nie sichtbar").
 */
@RestController
@RequestMapping("/api/v1/admin/direktvermarktung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminDirektvermarktungController {

    /**
     * Eine Zeile der Plattform-Liste. {@code ez8Direktvermarkter}: Abgleich mit dem älteren,
     * hardwaregestützten Feld der Anlagensteuerung (EZ-8) - {@code null} ohne ein solches Feld; kein
     * Datenbezug, keine Sperre.
     */
    public record AdminDirektvermarktungZeileDto(UUID siteId, String siteName, UUID tenantId, String tenantName,
            String partner, String zustand, LocalDate startdatum, LocalDate ende, Instant aktualisiertAm,
            Instant letzteAbfrageAm, Instant lebenszeichenAm, Instant zugangGueltigBis, String leadDeviceRef,
            String ez8Direktvermarkter) {

        static AdminDirektvermarktungZeileDto von(Zeile z) {
            return new AdminDirektvermarktungZeileDto(z.siteId(), z.siteName(), z.tenantId(), z.tenantName(),
                    z.partner(), z.zustand(), z.startdatum(), z.ende(), z.aktualisiertAm(), z.letzteAbfrageAm(),
                    z.lebenszeichenAm(), z.zugangGueltigBis(), z.leadDeviceRef(), z.ez8Direktvermarkter());
        }
    }

    /** Geräteakte › Verbindung, Block "Direktvermarkter". Nie {@code chiffrat}/{@code nonce}. */
    public record AdminDirektvermarktungDetailDto(UUID siteId, UUID tenantId, String partner, String zustand,
            Instant zustimmungAm, LocalDate startdatum, LocalDate ende, Instant aktualisiertAm,
            Instant tunnelObenSeit, Instant handshakeAm, String gegenstelle, Double abfragenJeMinute,
            Instant letzteSchreibungAm, Instant lebenszeichenAm, Integer vorgabePct, Integer einspeisungW,
            Integer erzeugungW, Integer netzbetreiberPct, Integer referenzW, String zugangHochgeladenVon,
            Instant zugangGueltigBis, String zugangFingerabdruck, Instant zugangZurueckgezogenAm,
            String ez8Direktvermarkter) {

        static AdminDirektvermarktungDetailDto von(SiteDetail d) {
            return new AdminDirektvermarktungDetailDto(d.siteId(), d.tenantId(), d.partner(), d.zustand(),
                    d.zustimmungAm(), d.startdatum(), d.ende(), d.aktualisiertAm(), d.tunnelObenSeit(),
                    d.handshakeAm(), d.gegenstelle(), d.abfragenJeMinute(), d.letzteSchreibungAm(),
                    d.lebenszeichenAm(), d.vorgabePct(), d.einspeisungW(), d.erzeugungW(), d.netzbetreiberPct(),
                    d.referenzW(), d.zugangHochgeladenVon(), d.zugangGueltigBis(), d.zugangFingerabdruck(),
                    d.zugangZurueckgezogenAm(), d.ez8Direktvermarkter());
        }
    }

    public record AdminDirektvermarktungProtokollZeileDto(long id, String ereignis, String von, String rolle,
            Instant am) {

        static AdminDirektvermarktungProtokollZeileDto von(ProtokollZeile z) {
            return new AdminDirektvermarktungProtokollZeileDto(z.id(), z.ereignis(), z.von(), z.rolle(), z.am());
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

    @GetMapping("/{siteId}")
    public AdminDirektvermarktungDetailDto fuerSite(@PathVariable UUID siteId) {
        SiteDetail d = repo.fuerSite(siteId);
        if (d == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "kein Anschluss für diese Anlage");
        }
        return AdminDirektvermarktungDetailDto.von(d);
    }

    @GetMapping("/{siteId}/protokoll")
    public List<AdminDirektvermarktungProtokollZeileDto> protokoll(@PathVariable UUID siteId) {
        return repo.protokoll(siteId, 50).stream().map(AdminDirektvermarktungProtokollZeileDto::von).toList();
    }
}
