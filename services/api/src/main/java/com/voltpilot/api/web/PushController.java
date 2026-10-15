package com.voltpilot.api.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der ÖFFENTLICHE VAPID-Schlüssel (Alerting Scheibe 3, RFC 8292): kein Geheimnis - der Browser
 * braucht ihn als {@code applicationServerKey} für {@code PushManager.subscribe}, bevor die Person
 * angemeldet sein muss (der Einschalt-Knopf fragt die Erlaubnis erst nach einem Tippen, §5 [K1]).
 * Deshalb ohne Anmeldung erreichbar, wie {@code ZustellwegController#bestaetigen}.
 */
@RestController
@RequestMapping("/api/v1/push")
public class PushController {

    public record OeffentlicherSchluessel(String schluessel) {}

    private final String vapidPublicKey;

    public PushController(@Value("${voltpilot.push.vapid-public-key:}") String vapidPublicKey) {
        this.vapidPublicKey = vapidPublicKey;
    }

    @GetMapping("/oeffentlicher-schluessel")
    public OeffentlicherSchluessel oeffentlicherSchluessel() {
        return new OeffentlicherSchluessel(vapidPublicKey);
    }
}
