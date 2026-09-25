package com.voltpilot.api.web;

import com.voltpilot.api.kundenbereich.Gesamtabzug;
import com.voltpilot.api.kundenbereich.KundenbereichEndeFilter;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.zugriff.ZugriffContext;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * UEMS AP-20 IP-17 — Vertragsende II: der Gesamtabzug des Kundenbereichs (E10 = A, BT4, RF-08). Ein ZIP-Strom mit
 * CSV und JSON je Objektart und einem Manifest mit SHA-256 je Datei, beim Abruf gebildet, nicht gespeichert, jeder
 * Abruf protokolliert ({@link Gesamtabzug}).
 *
 * <p><b>Wer:</b> nur der Kundenadministrator — dieselbe Regel, mit der {@link KundenbereichEndeFilter} ihn im Zustand
 * „beendet" noch lesen lässt (Kundenkonto mit wirksamer Zuweisung oder Bestandskonto E12). Erreichbar im Zustand
 * „aktiv" und „beendet" — dort ist er der Zweck. Jede andere Person, Unterstützer, Einsicht und der Umschalter der
 * Plattform bekommen 403 {@code recht_fehlt}.
 */
@RestController
@RequestMapping("/api/v1/unternehmen")
public class UnternehmenAbzugController {

    static final String NUR_KUNDENADMINISTRATOR = "Den Gesamtabzug lädt nur der Kundenadministrator.";

    private final Gesamtabzug abzug;

    public UnternehmenAbzugController(Gesamtabzug abzug) {
        this.abzug = abzug;
    }

    /**
     * Recht: keine eigene Kennung — nur der Kundenadministrator, sonst 403. Der Strom beginnt erst, wenn die
     * Protokollzeile steht; ein abgebrochener Abruf hat kein Manifest.
     */
    @GetMapping("/abzug")
    public void abzug(Authentication auth, HttpServletResponse response) throws IOException {
        ZugriffContext.Zugriff z = ZugriffContext.get();
        ProtokollAkteur wer = ProtokollAkteur.aus(auth).orElse(null);
        if (!KundenbereichEndeFilter.kundenadministrator(z) || wer == null) {
            throw new NurKundenadministrator();
        }
        Gesamtabzug.Abruf abruf = abzug.beginnen(z.kundenbereich(), wer);
        response.setStatus(HttpStatus.OK.value());
        response.setContentType("application/zip");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + abruf.dateiname());
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        abzug.schreiben(abruf, response.getOutputStream());
    }

    /** Die Ablehnung jeder Person außer dem Kundenadministrator. */
    static final class NurKundenadministrator extends RuntimeException {
        NurKundenadministrator() {
            super(NUR_KUNDENADMINISTRATOR);
        }
    }

    /** 403 {@code recht_fehlt} in der Form der UEMS-Ablehnungen ({@code code}, {@code message}, Fakten). */
    @ExceptionHandler(NurKundenadministrator.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(NurKundenadministrator e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "recht_fehlt");
        body.put("message", e.getMessage());
        body.put("recht", null);
        body.put("rolle_noetig", RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code());
        return ResponseEntity.status(HttpStatus.FORBIDDEN).contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
