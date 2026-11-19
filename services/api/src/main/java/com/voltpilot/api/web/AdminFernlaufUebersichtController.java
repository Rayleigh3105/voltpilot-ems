package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.FernlaufService;
import com.voltpilot.api.werkstatt.Nachtlauf;
import com.voltpilot.api.werkstatt.NachtlaufService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Karte „Ohne Kundenkonto" auf Plattform › Geräte › Updates (Konzept vp-update-vor-zuordnung, S2):
 * {@code /api/v1/admin/geraete/ohne-kundenkonto}, nur für Plattform-Admins - wie {@link AdminFernlaufController}
 * für eine Box, hier für alle auf einmal. „Aufspielen" je Box und „Alle aufspielen" legen ihre Aufträge über die
 * unveränderte Route {@code POST /api/v1/admin/geraete/{ref}/fernlauf} an (keine zweite Logik); diese Route liest
 * nur, nacheinander dieselbe Vorprüfung wie dort.
 *
 * <p>Dazu der Schalter „Nachts von selbst" (S4, {@link NachtlaufService}): {@code GET}/{@code POST .../nachtlauf}.
 */
@RestController
@RequestMapping("/api/v1/admin/geraete/ohne-kundenkonto")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFernlaufUebersichtController {

    /**
     * Der Schalter „Nachts von selbst": an oder angehalten, die jüngste Umstellung (wer, wann; {@code null} = ab
     * Werk an), die Nacht, wann der nächste Lauf beginnt, und wie viele Läufe in ihr schon angelegt sind.
     */
    public record NachtlaufSchalterDto(boolean an, String geaendertVon, Instant geaendertAm, Instant beginn,
            Instant ende, Instant naechsterLauf, boolean imFenster, int angelegt, int grenze, Instant stand) {
    }

    public record SchalterRequest(@NotNull Boolean an) {
    }

    private final FernlaufService fernlauf;
    private final NachtlaufService nachtlauf;
    private final ObjectMapper json;

    public AdminFernlaufUebersichtController(FernlaufService fernlauf, NachtlaufService nachtlauf,
            ObjectMapper json) {
        this.fernlauf = fernlauf;
        this.nachtlauf = nachtlauf;
        this.json = json;
    }

    @GetMapping
    public ResponseEntity<List<AdminFernlaufController.StandDto>> liste() {
        List<FernlaufService.Stand> stand = fernlauf.ohneKundenkonto();
        Map<String, Nachtlauf.Dran> plan = nachtlauf.plan(stand);
        List<AdminFernlaufController.StandDto> liste = stand.stream()
                .map(s -> AdminFernlaufController.standDto(s, plan.get(s.edgeRef()), json)).toList();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(liste);
    }

    @GetMapping("/nachtlauf")
    public ResponseEntity<NachtlaufSchalterDto> nachtlauf() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(dto(nachtlauf.lage()));
    }

    /** „Anhalten" ({@code an: false}) und „Einschalten" ({@code an: true}); dieselbe Stellung ändert nichts. */
    @PostMapping("/nachtlauf")
    public ResponseEntity<NachtlaufSchalterDto> schalten(@Valid @RequestBody SchalterRequest req,
            @AuthenticationPrincipal Jwt caller) {
        nachtlauf.schalten(req.an(), Akteur.aus(caller));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(dto(nachtlauf.lage()));
    }

    private static NachtlaufSchalterDto dto(NachtlaufService.Lage l) {
        var u = l.schalter().zuletzt();
        return new NachtlaufSchalterDto(l.schalter().an(), u == null ? null : u.akteurName() == null
                ? u.akteurSub() : u.akteurName(), u == null ? null : u.geaendertAm(), l.nacht().beginn(),
                l.nacht().ende(), l.naechsterBeginn(), l.imFenster(), l.angelegt(), Nachtlauf.GRENZE, l.jetzt());
    }
}
