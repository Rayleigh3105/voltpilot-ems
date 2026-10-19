package com.voltpilot.api.versand;

import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.telegram.TelegramException;
import com.voltpilot.api.versand.webhook.WebhookZielPruefung;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * „So erreichen wir Sie“ (§6.6): jede Person legt ihren Zustellweg E-Mail einmal selbst an und
 * bestätigt ihn über einen Link - bis dahin bekommt sie Meldungen nur im Portal. Der Benutzer-Spiegel
 * ist ungeprüft und veraltet still, darum wird hier NIE eine Adresse übernommen, die nicht diesen
 * eigenen Bestätigungsweg durchlaufen hat.
 */
@Service
public class ZustellwegService {

    private static final Logger log = LoggerFactory.getLogger(ZustellwegService.class);

    /** Token-Gültigkeit: lang genug für ein E-Mail-Postfach, kurz genug gegen einen verlorenen Link. */
    static final Duration TOKEN_GUELTIGKEIT = Duration.ofDays(2);

    /** Verbindungs-Token für Telegram (§7 Scheibe 6): kurzlebig, der Tipp auf den Link ist unmittelbar. */
    static final Duration TELEGRAM_TOKEN_GUELTIGKEIT = Duration.ofMinutes(15);

    private final ZustellwegRepository zustellwege;
    private final VersandRepository ausgang;
    private final TelegramAdapter telegram;
    private final String basisUrl;
    private final String telegramBotUsername;
    private final String telegramBotToken;
    private volatile Clock uhr = Clock.systemUTC();

    public ZustellwegService(ZustellwegRepository zustellwege, VersandRepository ausgang, TelegramAdapter telegram,
            @Value("${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl,
            @Value("${voltpilot.telegram.bot-username:}") String telegramBotUsername,
            @Value("${voltpilot.telegram.bot-token:}") String telegramBotToken) {
        this.zustellwege = zustellwege;
        this.ausgang = ausgang;
        this.telegram = telegram;
        this.basisUrl = basisUrl;
        this.telegramBotUsername = telegramBotUsername;
        this.telegramBotToken = telegramBotToken;
    }

    /** Nur für Tests: die Uhr, nach der der Token abläuft. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public Optional<ZustellwegRepository.Zustellweg> eigener(String benutzerSub) {
        return zustellwege.eigener(benutzerSub);
    }

    /**
     * Legt den eigenen Zustellweg an/ändert ihn und reiht sofort die Bestätigungs-Mail ein - mit dem
     * Ziel direkt in der Ausgangszeile (die Adresse ist ja noch unbestätigt, der Zusteller kann sie
     * nicht aus einem bestätigten Zustellweg lesen, weil es noch keinen gibt).
     *
     * <p>{@code nr} trägt den Versandzeitpunkt (B2): {@code anlegenOderErneuern} gibt bei einer
     * ERNEUTEN Anforderung derselben Person/Adresse dieselbe {@code zustellweg}-Zeile zurück, also
     * dieselbe {@code quelle_id} - ein fest {@code nr = 0} hätte die zweite Mail am
     * Doppelversand-Schutz (§9) verschluckt, weil der eindeutige Schlüssel dann identisch wäre.
     */
    public void anfordern(String benutzerSub, String ziel) {
        Instant jetzt = uhr.instant();
        String token = BestaetigungsToken.erzeugen();
        UUID id = zustellwege.anlegenOderErneuern(benutzerSub, ziel, token, jetzt.plus(TOKEN_GUELTIGKEIT));
        String link = basisUrl + "/#/zustellweg/bestaetigen?token=" + token;
        int nr = (int) (jetzt.getEpochSecond() % Integer.MAX_VALUE);
        ausgang.emailMitZiel("zustellweg_bestaetigung", id, benutzerSub, "bestaetigung", nr,
                "VoltPilot: Adresse bestätigen",
                "Bitte bestätigen Sie diese E-Mail-Adresse für Meldungen von VoltPilot:\n\n" + link
                        + "\n\nDer Link ist zwei Tage gültig. Haben Sie das nicht angefordert, ignorieren Sie diese Mail.",
                ziel);
    }

    /** {@code true}, wenn der Token gültig war und die Adresse jetzt bestätigt ist. */
    public boolean bestaetigen(String token) {
        return zustellwege.bestaetigen(token, uhr.instant());
    }

    /** Zustell-Vorgabe und Tages-Zusammenfassung ändern (§6.4, §6.4 Nr. 6). */
    public boolean emailEinstellungenSetzen(String benutzerSub, String abSchwere, boolean zusammenfassungAktiv,
            LocalTime zusammenfassungUhrzeit) {
        return zustellwege.emailEinstellungenSetzen(benutzerSub, abSchwere, zusammenfassungAktiv,
                zusammenfassungUhrzeit);
    }

    // --------------------------------------------------------------------- Web-Push (Alerting Scheibe 3, §6.7)

    public List<ZustellwegRepository.PushAbo> pushAboEigene(String benutzerSub) {
        return zustellwege.pushAboEigene(benutzerSub);
    }

    /**
     * Ein neues Geräte-Abo (Alerting Scheibe 3, §7 Punkt 1): die Browser-Erlaubnis selbst ist die
     * Bestätigung (ein Tippen vor der Nachfrage des Browsers, §5 [K1]) - kein Bestätigungslink wie
     * bei E-Mail nötig.
     */
    public UUID pushAbonnieren(String benutzerSub, String endpoint, String p256dh, String auth, String geraet,
            String userAgent) {
        return zustellwege.pushAboAnlegen(benutzerSub, endpoint, p256dh, auth, geraet, userAgent);
    }

    public boolean pushAboEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return zustellwege.pushAboEinstellungenSetzen(id, benutzerSub, aktiv, abSchwere);
    }

    public boolean pushAboEntfernen(UUID id, String benutzerSub) {
        return zustellwege.pushAboEntfernen(id, benutzerSub);
    }

    public boolean pushAboEntfernenNachEndpoint(String benutzerSub, String endpoint) {
        return zustellwege.pushAboEntfernenNachEndpoint(benutzerSub, endpoint);
    }

    // --------------------------------------------------------------------- Webhook (Alerting Scheibe 6, §7)

    public List<ZustellwegRepository.WebhookZielEigen> webhookZieleEigene(String benutzerSub) {
        return zustellwege.webhookZieleEigene(benutzerSub);
    }

    /**
     * Legt ein neues Webhook-Ziel an. Die SSRF-Prüfung ({@link WebhookZielPruefung}) läuft HIER
     * schon beim Anlegen (ehrliche Rückmeldung statt eines Ziels, das nie zustellen wird) UND noch
     * einmal bei jedem Versand ({@code WebhookVersandAdapter}, §9 "DNS-Rebinding").
     *
     * @return das Geheimnis - wird NUR in dieser Antwort gezeigt, danach nie wieder gelesen.
     */
    public record NeuesWebhookZiel(UUID id, String geheimnis) {}

    public NeuesWebhookZiel webhookZielAnlegen(String benutzerSub, String url, String name) {
        try {
            WebhookZielPruefung.pruefenUndAufloesen(url);
        } catch (WebhookZielPruefung.UnsicheresZielException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, e.getMessage());
        }
        String geheimnis = BestaetigungsToken.erzeugen();
        UUID id = zustellwege.webhookZielAnlegen(benutzerSub, url, geheimnis, name);
        return new NeuesWebhookZiel(id, geheimnis);
    }

    public boolean webhookZielEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return zustellwege.webhookZielEinstellungenSetzen(id, benutzerSub, aktiv, abSchwere);
    }

    public boolean webhookZielEntfernen(UUID id, String benutzerSub) {
        return zustellwege.webhookZielEntfernen(id, benutzerSub);
    }

    // --------------------------------------------------------------------- Telegram (Alerting Scheibe 6, §7)

    public List<ZustellwegRepository.TelegramZielEigen> telegramZieleEigene(String benutzerSub) {
        return zustellwege.telegramZieleEigene(benutzerSub);
    }

    /**
     * {@code true}, wenn diese Installation einen Telegram-Bot eingerichtet hat (Bot-Username UND
     * -Token aus der Umgebung) - erst dann lässt sich ein funktionierender {@code t.me}-Start-Link
     * bauen. Das Portal fragt dies ab, statt aus einem leeren Link zu raten.
     */
    public boolean telegramVerfuegbar() {
        return !telegramBotUsername.isBlank() && !telegramBotToken.isBlank();
    }

    /** "Telegram verbinden" (§7 Scheibe 6 Punkt 2): der Link öffnet den Bot mit dem Token als Startparameter. */
    public record TelegramVerbindungsLink(String link) {}

    public TelegramVerbindungsLink telegramVerbindungAnfordern(String benutzerSub) {
        if (!telegramVerfuegbar()) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.CONFLICT,
                    "Telegram ist auf dieser Installation nicht eingerichtet.");
        }
        String token = BestaetigungsToken.erzeugen();
        zustellwege.telegramVerbindungAnfordern(benutzerSub, token, uhr.instant().plus(TELEGRAM_TOKEN_GUELTIGKEIT));
        return new TelegramVerbindungsLink("https://t.me/" + telegramBotUsername + "?start=" + token);
    }

    /**
     * Die Bot-Antwort auf {@code /start <token>} (vom Telegram-Update-Webhook aufgerufen, keine
     * Anmeldung, kein Mandanten-Kontext - wie die E-Mail-Bestätigung per Link). Schickt bei Erfolg
     * sofort die Verbindungs-Bestätigung in den Chat; ein unbekannter/abgelaufener Token bekommt
     * keine Antwort (kein Hinweis, ob der Token je existiert hat).
     */
    public boolean telegramVerbindungBestaetigen(String token, String chatId) {
        boolean bestaetigt = zustellwege.telegramVerbindungBestaetigen(token, chatId, uhr.instant()).isPresent();
        if (bestaetigt) {
            try {
                telegram.verbindungBestaetigen(chatId);
            } catch (TelegramException e) {
                log.warn("Telegram: Verbindungs-Bestätigung an Chat {} nicht zustellbar: {}", chatId, e.getMessage());
            }
        }
        return bestaetigt;
    }

    public boolean telegramZielEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return zustellwege.telegramZielEinstellungenSetzen(id, benutzerSub, aktiv, abSchwere);
    }

    public boolean telegramZielEntfernen(UUID id, String benutzerSub) {
        return zustellwege.telegramZielEntfernen(id, benutzerSub);
    }
}
