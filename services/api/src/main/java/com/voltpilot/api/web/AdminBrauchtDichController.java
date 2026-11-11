package com.voltpilot.api.web;

import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.web.dto.AdminBrauchtDichErledigtDto;
import com.voltpilot.api.web.dto.AdminBrauchtDichErledigtDto.ErledigenRequest;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Braucht dich" einzeln auf gelesen/erledigt setzen (Plattform-Übersicht,
 * Scheibe S4, Nachbesserung). Der Schlüssel ist der stabile Eintragsschlüssel
 * aus {@code plattformUebersicht.ts} (z. B. {@code fehler-<ref>}); erledigt
 * gilt, solange der mitgegebene Grund ({@code stand}) unverändert ist - das
 * Portal entscheidet beim Lesen, ob ein Eintrag noch denselben Grund trägt
 * (reine Ableitung, keine zweite Wahrheit hier).
 *
 * <p>Sicherheits-Disziplin wie {@link AdminPlattformDiensteController}:
 * {@code @PreAuthorize("hasRole('platform-admin')")}, die RLS-Umgehung bleibt
 * auf {@link BrauchtDichErledigtRepository} (BYPASSRLS-Rolle
 * {@code voltpilot_admin}) beschränkt.
 */
@RestController
@RequestMapping("/api/v1/admin/plattform/braucht-dich")
@PreAuthorize("hasRole('platform-admin')")
public class AdminBrauchtDichController {

    private final BrauchtDichErledigtRepository repo;

    public AdminBrauchtDichController(BrauchtDichErledigtRepository repo) {
        this.repo = repo;
    }

    @GetMapping("/erledigt")
    public AdminBrauchtDichErledigtDto erledigt() {
        List<AdminBrauchtDichErledigtDto.Eintrag> eintraege = repo.alle().stream()
                .map(e -> new AdminBrauchtDichErledigtDto.Eintrag(e.schluessel(), e.stand(), e.erledigtAm(), e.erledigtVon()))
                .toList();
        return new AdminBrauchtDichErledigtDto(eintraege);
    }

    @PostMapping("/erledigen")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void erledigen(@RequestBody ErledigenRequest req, @AuthenticationPrincipal Jwt caller) {
        if (req == null || req.eintraege() == null || req.eintraege().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "eintraege darf nicht leer sein");
        }
        Akteur wer = Akteur.aus(caller);
        String erledigtVon = wer.name() != null ? wer.name() : wer.sub();
        for (ErledigenRequest.Zeile z : req.eintraege()) {
            if (z.schluessel() == null || z.schluessel().isBlank() || z.stand() == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "schluessel und stand sind pflicht");
            }
            repo.erledigen(z.schluessel(), z.stand(), erledigtVon);
        }
    }

    @DeleteMapping("/{schluessel}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void wiederherstellen(@PathVariable String schluessel) {
        repo.wiederherstellen(schluessel);
    }
}
