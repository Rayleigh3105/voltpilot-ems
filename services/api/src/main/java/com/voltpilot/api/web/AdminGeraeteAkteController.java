package com.voltpilot.api.web;

import com.voltpilot.api.enrollment.EnrollmentRepository;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.repo.AdminGeraeteAkteRepository;
import com.voltpilot.api.repo.AdminGeraeteAkteRepository.AkteBoxRow;
import com.voltpilot.api.repo.AdminGeraeteListeRepository;
import com.voltpilot.api.repo.AdminGeraeteListeRepository.GeraeteListeZeile;
import com.voltpilot.api.web.dto.AdminGeraeteAkteDto;
import com.voltpilot.api.werkstatt.WerkstattRepository;
import java.util.Optional;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Geräteakte in EINER Antwort: {@code GET /api/v1/admin/geraete/{ref}}
 * (Lücke L3, Adminview-Konzept Abschnitt 3.4/4.4). Führt zusammen, was die
 * Akte heute client-seitig aus mehreren Listen zusammensetzen müsste: Geräte-
 * und Software-Stand ({@link AdminGeraeteAkteRepository}), Lebensabschnitt
 * ({@link AdminGeraeteListeRepository}, Lücke L7), Zertifikat
 * ({@link EnrollmentRepository}, Lücke L4) und ein Blick auf Fernwartung
 * bzw. Werkstatt für diese EINE Box.
 *
 * <p>Sicherheits-Disziplin wie {@link AdminFleetController}:
 * {@code @PreAuthorize("hasRole('platform-admin')")}; die RLS-Umgehung bleibt
 * auf die admin-geschützten Repositories beschränkt.
 */
@RestController
@RequestMapping("/api/v1/admin/geraete")
@PreAuthorize("hasRole('platform-admin')")
public class AdminGeraeteAkteController {

    private final AdminGeraeteAkteRepository akte;
    private final AdminGeraeteListeRepository liste;
    private final EnrollmentRepository enrollments;
    private final FernwartungService fernwartung;
    private final WerkstattRepository werkstatt;

    public AdminGeraeteAkteController(AdminGeraeteAkteRepository akte,
            AdminGeraeteListeRepository liste, EnrollmentRepository enrollments,
            FernwartungService fernwartung, WerkstattRepository werkstatt) {
        this.akte = akte;
        this.liste = liste;
        this.enrollments = enrollments;
        this.fernwartung = fernwartung;
        this.werkstatt = werkstatt;
    }

    @GetMapping("/{ref}")
    public AdminGeraeteAkteDto akte(@PathVariable String ref) {
        GeraeteListeZeile lebenslauf = liste.eineBox(ref)
                .orElseThrow(() -> new ResponseStatusException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "Unbekannte Referenz: " + ref));

        Optional<AkteBoxRow> box = akte.box(ref);
        AdminGeraeteAkteDto.Kopf kopf = box.map(b -> new AdminGeraeteAkteDto.Kopf(
                b.deviceId().toString(), b.name(), b.siteId().toString(), b.siteName(),
                b.tenantId().toString(), b.tenantName(), b.herzschlagAm(), b.messwertAm(),
                b.lastSeenAt(), b.ausgebautAm())).orElse(null);

        AdminGeraeteAkteDto.Software software = box.map(b -> new AdminGeraeteAkteDto.Software(
                AdminFleetController.edgeDto(b.edge()), AdminFleetController.updateDto(b.update()),
                b.supports(), AdminFleetController.boxArt(b.edge(), b.update()))).orElse(null);

        Optional<Zugang> zugang = fernwartung.box(ref);
        Optional<EnrollmentRepository.Enrollment> enrollment = enrollments.find(ref);
        AdminGeraeteAkteDto.Verbindung verbindung =
                (box.isPresent() || zugang.isPresent())
                        ? new AdminGeraeteAkteDto.Verbindung(
                                box.map(AkteBoxRow::lanHost).orElse(null),
                                box.map(AkteBoxRow::lanSeenAt).orElse(null),
                                zugang.map(Zugang::aktiv).orElse(null),
                                zugang.map(Zugang::adresse).orElse(null))
                        : null;

        boolean inWerkstatt = werkstatt.box(ref).isPresent();
        AdminGeraeteAkteDto.Einrichtung einrichtung =
                (enrollment.isPresent() || inWerkstatt)
                        ? new AdminGeraeteAkteDto.Einrichtung(
                                enrollment.map(EnrollmentRepository.Enrollment::issuedAt).orElse(null),
                                enrollment.map(EnrollmentRepository.Enrollment::notAfter).orElse(null),
                                "werkstatt".equals(lebenslauf.lebensabschnitt())
                                        ? lebenslauf.seit() : null)
                        : null;

        return new AdminGeraeteAkteDto(ref, lebenslauf.lebensabschnitt(), lebenslauf.seit(),
                kopf, software, verbindung, einrichtung);
    }
}
