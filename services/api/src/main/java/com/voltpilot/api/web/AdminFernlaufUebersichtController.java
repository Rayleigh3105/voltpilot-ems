package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.werkstatt.FernlaufService;
import java.util.List;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Karte „Ohne Kundenkonto" auf Plattform › Geräte › Updates (Konzept vp-update-vor-zuordnung, S2):
 * {@code /api/v1/admin/geraete/ohne-kundenkonto}, nur für Plattform-Admins - wie {@link AdminFernlaufController}
 * für eine Box, hier für alle auf einmal. „Aufspielen" je Box und „Alle aufspielen" legen ihre Aufträge über die
 * unveränderte Route {@code POST /api/v1/admin/geraete/{ref}/fernlauf} an (keine zweite Logik); diese Route liest
 * nur, nacheinander dieselbe Vorprüfung wie dort.
 */
@RestController
@RequestMapping("/api/v1/admin/geraete/ohne-kundenkonto")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFernlaufUebersichtController {

    private final FernlaufService fernlauf;
    private final ObjectMapper json;

    public AdminFernlaufUebersichtController(FernlaufService fernlauf, ObjectMapper json) {
        this.fernlauf = fernlauf;
        this.json = json;
    }

    @GetMapping
    public ResponseEntity<List<AdminFernlaufController.StandDto>> liste() {
        List<AdminFernlaufController.StandDto> liste = fernlauf.ohneKundenkonto().stream()
                .map(s -> AdminFernlaufController.standDto(s, json)).toList();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(liste);
    }
}
