package com.voltpilot.api.web;

import com.voltpilot.api.web.dto.SelbstauskunftDto;
import com.voltpilot.api.zugriff.Selbstauskunft;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Selbstauskunft {@code GET /api/v1/me} (UEMS AP-03 IP-4) — die EINE Quelle des Portals für „wer bin ich, was
 * darf ich": Name, Kontoart, Rollen, sichtbare Standorte mit den Rechten je Aktion, künftige Zuweisungen, Teilansicht,
 * Unterstützungen (eigene und gewährte) mit ihren Banner-Sätzen und die Kundenadministratoren für „Grund und Weg".
 *
 * <p>Liest den {@code ZugriffContext} der Anfrage und leitet mit {@code RechteAbleitung} ab; sie setzt nichts durch
 * und vermerkt die erste abgeschlossene Anmeldung (IP-14). Ohne angenommenen Kundenbereich (Partner ohne wirksame Unterstützung) antwortet sie mit dem
 * eigenen Konto allein — nie mit einem Hinweis auf den gewählten Kundenbereich.
 */
@RestController
@RequestMapping("/api/v1/me")
public class MeController {

    private final Selbstauskunft selbstauskunft;
    private final com.voltpilot.api.zugriff.EigeneKundenbereiche kundenbereiche;

    public MeController(Selbstauskunft selbstauskunft, com.voltpilot.api.zugriff.EigeneKundenbereiche kundenbereiche) {
        this.kundenbereiche = kundenbereiche;
        this.selbstauskunft = selbstauskunft;
    }

    /** Recht {@code konto.eigenes} — jede Person liest nur sich selbst; die additive Kundenbereichsliste ist
     * lesend ohne eigene Kennung, ausschließlich für das authentifizierte Unterstützerkonto. */
    @GetMapping
    public SelbstauskunftDto me(Authentication auth) {
        var selbst = selbstauskunft.fuer(auth);
        return "partner".equals(selbst.konto()) || "plattform".equals(selbst.konto())
                ? selbst.mitKundenbereichen(kundenbereiche.lesen()) : selbst;
    }
}
