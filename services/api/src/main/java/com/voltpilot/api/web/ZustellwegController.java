package com.voltpilot.api.web;

import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.versand.ZustellwegService;
import java.time.LocalTime;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * „So erreichen wir Sie“ (Alerting Scheibe 0/3, §6.6, §6.8 Entwurf 4): der eigene E-Mail-Zustellweg
 * (erst wirksam nach Bestätigung über einen Link) und die eigenen Web-Push-Geräte-Abos
 * ("Abo je Gerät", §7 Scheibe 3). Recht {@code konto.eigenes} — jede Person liest/ändert nur sich
 * selbst, wie {@link MeController}; der E-Mail-Bestätigungs-Endpunkt hat ausdrücklich KEINE
 * Anmeldung (die Person hat zu diesem Zeitpunkt noch keinen bestätigten Weg und damit keinen Grund,
 * sich extra anzumelden - der Token selbst ist der Nachweis). Push braucht keinen solchen Link: die
 * Browser-Erlaubnis selbst ist die Bestätigung (§5 [K1]).
 */
@RestController
@RequestMapping("/api/v1/zustellwege")
public class ZustellwegController {

    /** Anfrage, eine E-Mail-Adresse als eigenen Zustellweg zu bestätigen. */
    public record Anfrage(String ziel) {}

    /** Der eigene Zustand, wie „So erreichen wir Sie“ ihn zeigt. */
    public record Zustand(String ziel, boolean bestaetigt, boolean aktiv, String abSchwere,
            boolean zusammenfassungAktiv, LocalTime zusammenfassungUhrzeit) {
        static Zustand aus(ZustellwegRepository.Zustellweg z) {
            return new Zustand(z.ziel(), z.bestaetigt(), z.aktiv(), z.abSchwere(), z.zusammenfassungAktiv(),
                    z.zusammenfassungUhrzeit());
        }
    }

    /** Zustell-Vorgabe und Tages-Zusammenfassung ändern (§6.4, §6.4 Nr. 6). */
    public record EmailEinstellungen(String abSchwere, boolean zusammenfassungAktiv, LocalTime zusammenfassungUhrzeit) {}

    /** Ein neues Geräte-Abo - die Form von {@code PushSubscription.toJSON()} des Browsers. */
    public record PushAnfrage(String endpoint, String p256dh, String auth, String geraet, String userAgent) {}

    /** Ein Geräte-Abo, wie die Einstellungsfläche es zeigt. */
    public record PushAboDto(String id, String geraet, boolean aktiv, String abSchwere,
            java.time.Instant erstelltAm) {
        static PushAboDto aus(ZustellwegRepository.PushAbo a) {
            return new PushAboDto(a.id().toString(), a.geraet(), a.aktiv(), a.abSchwere(), a.erstelltAm());
        }
    }

    public record PushEinstellungen(boolean aktiv, String abSchwere) {}

    private final ZustellwegService zustellwege;

    public ZustellwegController(ZustellwegService zustellwege) {
        this.zustellwege = zustellwege;
    }

    @GetMapping("/email")
    public ResponseEntity<Zustand> eigener(Authentication auth) {
        return zustellwege.eigener(sub(auth)).map(Zustand::aus).map(ResponseEntity::ok)
                .orElse(ResponseEntity.noContent().build());
    }

    @PostMapping("/email")
    public ResponseEntity<Void> anfordern(@RequestBody Anfrage anfrage, Authentication auth) {
        if (istLeer(anfrage.ziel())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "ziel ist ein Pflichtfeld.");
        }
        zustellwege.anfordern(sub(auth), anfrage.ziel());
        return ResponseEntity.accepted().build();
    }

    @PutMapping("/email/einstellungen")
    public ResponseEntity<Void> emailEinstellungen(@RequestBody EmailEinstellungen einstellungen,
            Authentication auth) {
        boolean geaendert = zustellwege.emailEinstellungenSetzen(sub(auth), einstellungen.abSchwere(),
                einstellungen.zusammenfassungAktiv(), einstellungen.zusammenfassungUhrzeit());
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "kein E-Mail-Zustellweg angelegt");
        }
        return ResponseEntity.noContent().build();
    }

    /** Öffentlich, ohne Anmeldung - der Link aus der Bestätigungs-Mail. */
    @GetMapping("/bestaetigen")
    public ResponseEntity<Void> bestaetigen(@RequestParam String token) {
        return zustellwege.bestaetigen(token) ? ResponseEntity.ok().build() : ResponseEntity.status(410).build();
    }

    // --------------------------------------------------------------------- Web-Push (Alerting Scheibe 3, §7)

    @GetMapping("/push")
    public List<PushAboDto> pushAbos(Authentication auth) {
        return zustellwege.pushAboEigene(sub(auth)).stream().map(PushAboDto::aus).toList();
    }

    @PostMapping("/push")
    public ResponseEntity<PushAboDto> pushAbonnieren(@RequestBody PushAnfrage anfrage, Authentication auth) {
        pruefePushAnfrage(anfrage);
        String sub = sub(auth);
        UUID id = zustellwege.pushAbonnieren(sub, anfrage.endpoint(), anfrage.p256dh(), anfrage.auth(),
                anfrage.geraet(), anfrage.userAgent());
        PushAboDto dto = zustellwege.pushAboEigene(sub).stream().filter(a -> a.id().equals(id))
                .findFirst().map(PushAboDto::aus)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR));
        return ResponseEntity.status(HttpStatus.CREATED).body(dto);
    }

    @PutMapping("/push/{id}")
    public ResponseEntity<Void> pushEinstellungen(@PathVariable UUID id, @RequestBody PushEinstellungen einstellungen,
            Authentication auth) {
        boolean geaendert = zustellwege.pushAboEinstellungenSetzen(id, sub(auth), einstellungen.aktiv(),
                einstellungen.abSchwere());
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/push/{id}")
    public ResponseEntity<Void> pushEntfernen(@PathVariable UUID id, Authentication auth) {
        boolean geaendert = zustellwege.pushAboEntfernen(id, sub(auth));
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    // --------------------------------------------------------------------- Webhook (Alerting Scheibe 6, §7)

    public record WebhookAnfrage(String url, String name) {}

    public record WebhookZielDto(String id, String url, String name, boolean aktiv, String abSchwere,
            java.time.Instant erstelltAm) {
        static WebhookZielDto aus(ZustellwegRepository.WebhookZielEigen z) {
            return new WebhookZielDto(z.id().toString(), z.url(), z.name(), z.aktiv(), z.abSchwere(), z.erstelltAm());
        }
    }

    /** Wie {@link WebhookZielDto}, aber einmalig MIT Geheimnis - nur die Antwort auf das Anlegen. */
    public record NeuesWebhookZielDto(String id, String geheimnis) {}

    public record ZielEinstellungen(boolean aktiv, String abSchwere) {}

    @GetMapping("/webhook")
    public List<WebhookZielDto> webhookZiele(Authentication auth) {
        return zustellwege.webhookZieleEigene(sub(auth)).stream().map(WebhookZielDto::aus).toList();
    }

    @PostMapping("/webhook")
    public ResponseEntity<NeuesWebhookZielDto> webhookZielAnlegen(@RequestBody WebhookAnfrage anfrage,
            Authentication auth) {
        if (istLeer(anfrage.url())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "url ist ein Pflichtfeld.");
        }
        var neu = zustellwege.webhookZielAnlegen(sub(auth), anfrage.url(), anfrage.name());
        return ResponseEntity.status(HttpStatus.CREATED).body(new NeuesWebhookZielDto(neu.id().toString(), neu.geheimnis()));
    }

    @PutMapping("/webhook/{id}")
    public ResponseEntity<Void> webhookZielEinstellungen(@PathVariable UUID id,
            @RequestBody ZielEinstellungen einstellungen, Authentication auth) {
        pruefeZielEinstellungen(einstellungen);
        boolean geaendert = zustellwege.webhookZielEinstellungenSetzen(id, sub(auth), einstellungen.aktiv(),
                einstellungen.abSchwere());
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/webhook/{id}")
    public ResponseEntity<Void> webhookZielEntfernen(@PathVariable UUID id, Authentication auth) {
        boolean geaendert = zustellwege.webhookZielEntfernen(id, sub(auth));
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    // --------------------------------------------------------------------- Telegram (Alerting Scheibe 6, §7)

    public record TelegramZielDto(String id, boolean bestaetigt, boolean aktiv, String abSchwere,
            java.time.Instant erstelltAm) {
        static TelegramZielDto aus(ZustellwegRepository.TelegramZielEigen z) {
            return new TelegramZielDto(z.id().toString(), z.bestaetigt(), z.aktiv(), z.abSchwere(), z.erstelltAm());
        }
    }

    public record TelegramVerbindungsLinkDto(String link) {}

    /**
     * {@code verfuegbar}: ob diese Installation einen Telegram-Bot eingerichtet hat - das Portal
     * fragt dies ab, statt selbst zu raten und aus einem leeren Bot-Username einen kaputten
     * {@code t.me}-Link zu bauen (Go-Live-Prüfung).
     */
    public record TelegramStatusDto(boolean verfuegbar, List<TelegramZielDto> ziele) {}

    @GetMapping("/telegram")
    public TelegramStatusDto telegramStatus(Authentication auth) {
        List<TelegramZielDto> ziele = zustellwege.telegramZieleEigene(sub(auth)).stream()
                .map(TelegramZielDto::aus).toList();
        return new TelegramStatusDto(zustellwege.telegramVerfuegbar(), ziele);
    }

    /** "Telegram verbinden": erzeugt den Start-Link, den die Person in Telegram öffnet. */
    @PostMapping("/telegram/verbinden")
    public TelegramVerbindungsLinkDto telegramVerbinden(Authentication auth) {
        var link = zustellwege.telegramVerbindungAnfordern(sub(auth));
        return new TelegramVerbindungsLinkDto(link.link());
    }

    @PutMapping("/telegram/{id}")
    public ResponseEntity<Void> telegramZielEinstellungen(@PathVariable UUID id,
            @RequestBody ZielEinstellungen einstellungen, Authentication auth) {
        pruefeZielEinstellungen(einstellungen);
        boolean geaendert = zustellwege.telegramZielEinstellungenSetzen(id, sub(auth), einstellungen.aktiv(),
                einstellungen.abSchwere());
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    /** "Trennen" (§7 Scheibe 6 Punkt 2). */
    @DeleteMapping("/telegram/{id}")
    public ResponseEntity<Void> telegramZielEntfernen(@PathVariable UUID id, Authentication auth) {
        boolean geaendert = zustellwege.telegramZielEntfernen(id, sub(auth));
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    private static String sub(Authentication auth) {
        return auth != null && auth.getPrincipal() instanceof Jwt jwt ? jwt.getSubject() : auth.getName();
    }

    /** Die Pflichtfelder der Browser-{@code PushSubscription} (RFC 8291) und des Geräte-Namens - wie {@code push_abo}. */
    private static void pruefePushAnfrage(PushAnfrage anfrage) {
        if (istLeer(anfrage.endpoint()) || istLeer(anfrage.p256dh()) || istLeer(anfrage.auth())
                || istLeer(anfrage.geraet())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "endpoint, p256dh, auth und geraet sind Pflichtfelder.");
        }
    }

    /** Die Zustell-Vorgabe einer Webhook-/Telegram-Einstellung (Alerting Scheibe 6, §7 Scheibe 6) - wie {@link #pruefePushAnfrage}. */
    private static void pruefeZielEinstellungen(ZielEinstellungen einstellungen) {
        if (istLeer(einstellungen.abSchwere())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "abSchwere ist ein Pflichtfeld.");
        }
    }

    private static boolean istLeer(String s) {
        return s == null || s.isBlank();
    }
}
