package com.voltpilot.api.versand;

import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.telegram.TelegramException;
import com.voltpilot.api.versand.webhook.WebhookException;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webhook.WebhookZielPruefung;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import com.voltpilot.api.versand.webpush.WebPushException;
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
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.mail.MailException;
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

    /** Die Testnachricht von "Probe senden" (Entscheid 10A) - die Ruhezeit gilt dafür nicht, sie geht sofort. */
    private static final String PROBE_BETREFF = "VoltPilot: Testnachricht";
    private static final String PROBE_TEXT = "Das ist eine Testnachricht von VoltPilot - dieser Weg funktioniert.";
    private static final String PROBE_PUSH_PAYLOAD =
            "{\"titel\":\"VoltPilot\",\"text\":\"Testnachricht - dieser Weg funktioniert.\",\"url\":\"#/einstellungen\"}";
    private static final String PROBE_WEBHOOK_PAYLOAD = "{\"text\":\"" + PROBE_BETREFF + "\\n" + PROBE_TEXT
            + "\",\"titel\":\"" + PROBE_BETREFF + "\",\"inhalt\":\"" + PROBE_TEXT + "\"}";

    private final ZustellwegRepository zustellwege;
    private final VersandRepository ausgang;
    private final TelegramAdapter telegram;
    private final EmailVersandAdapter email;
    private final WebPushAdapter push;
    private final WebhookVersandAdapter webhook;
    private final String basisUrl;
    private final String telegramBotUsername;
    private final String telegramBotToken;
    private volatile Clock uhr = Clock.systemUTC();

    public ZustellwegService(ZustellwegRepository zustellwege, VersandRepository ausgang, TelegramAdapter telegram,
            EmailVersandAdapter email, WebPushAdapter push, WebhookVersandAdapter webhook,
            @Value("${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl,
            @Value("${voltpilot.telegram.bot-username:}") String telegramBotUsername,
            @Value("${voltpilot.telegram.bot-token:}") String telegramBotToken) {
        this.zustellwege = zustellwege;
        this.ausgang = ausgang;
        this.telegram = telegram;
        this.email = email;
        this.push = push;
        this.webhook = webhook;
        this.basisUrl = basisUrl;
        this.telegramBotUsername = telegramBotUsername;
        this.telegramBotToken = telegramBotToken;
    }

    /** Ergebnis von "Probe senden" (Entscheid 10A) - kein Fehlschlag wirft, die Fläche zeigt ihn an. */
    public record ProbeErgebnis(boolean erfolgreich, String fehler) {
        static ProbeErgebnis ok() {
            return new ProbeErgebnis(true, null);
        }

        static ProbeErgebnis fehlgeschlagen(String fehler) {
            return new ProbeErgebnis(false, fehler == null ? "Unbekannter Fehler" : fehler);
        }
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

    /** "E-Mail-Weg abschalten" (Scheibe 2, B12) - die Adresse und ihre Bestätigung bleiben erhalten. */
    public boolean emailAktivSetzen(String benutzerSub, boolean aktiv) {
        return zustellwege.emailAktivSetzen(benutzerSub, aktiv);
    }

    /** "E-Mail-Weg entfernen" (Scheibe 2, B12). */
    public boolean emailEntfernen(String benutzerSub) {
        return zustellwege.emailEntfernen(benutzerSub);
    }

    /** "Probe-Mail senden" (Entscheid 10A) - braucht eine bestätigte Adresse, die Ruhezeit gilt dafür nicht. */
    public ProbeErgebnis emailProbeSenden(String benutzerSub) {
        ZustellwegRepository.Zustellweg weg = zustellwege.eigener(benutzerSub)
                .filter(ZustellwegRepository.Zustellweg::bestaetigt)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                        "Braucht eine bestätigte E-Mail-Adresse."));
        try {
            email.senden(weg.ziel(), PROBE_BETREFF, PROBE_TEXT);
        } catch (MailException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        return ProbeErgebnis.ok();
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

    /** "Gerät umbenennen" (Scheibe 2, §4.12, Befund M4/M5). */
    public boolean pushAboNameSetzen(UUID id, String benutzerSub, String geraet) {
        return zustellwege.pushAboNameSetzen(id, benutzerSub, geraet);
    }

    /** "Probe-Mitteilung senden" (Entscheid 10A). */
    public ProbeErgebnis pushProbeSenden(UUID id, String benutzerSub) {
        WebPushAdapter.Abo abo = zustellwege.pushAboFuerProbe(id, benutzerSub)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        try {
            push.senden(abo, PROBE_PUSH_PAYLOAD);
        } catch (WebPushException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        return ProbeErgebnis.ok();
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
        pruefenUndWerfen(url);
        String geheimnis = BestaetigungsToken.erzeugen();
        try {
            UUID id = zustellwege.webhookZielAnlegen(benutzerSub, url, geheimnis, name);
            return new NeuesWebhookZiel(id, geheimnis);
        } catch (DuplicateKeyException e) {
            throw doppelteAdresse();
        }
    }

    public boolean webhookZielEinstellungenSetzen(UUID id, String benutzerSub, boolean aktiv, String abSchwere) {
        return zustellwege.webhookZielEinstellungenSetzen(id, benutzerSub, aktiv, abSchwere);
    }

    public boolean webhookZielEntfernen(UUID id, String benutzerSub) {
        return zustellwege.webhookZielEntfernen(id, benutzerSub);
    }

    /** "Team-Kanal bearbeiten" (Scheibe 2, §4.12) - dieselbe SSRF-Prüfung wie beim Anlegen. */
    public boolean webhookZielBearbeiten(UUID id, String benutzerSub, String url, String name) {
        pruefenUndWerfen(url);
        try {
            return zustellwege.webhookZielBearbeiten(id, benutzerSub, url, name);
        } catch (DuplicateKeyException e) {
            throw doppelteAdresse();
        }
    }

    /**
     * "Probe senden" VOR dem Anlegen (Entscheid 10A, §4.12): dieselbe SSRF-Prüfung und ein echter
     * Test-Versand, aber nichts wird gespeichert - das Geheimnis ist nur für diesen einen Ruf gültig.
     */
    public ProbeErgebnis webhookProbeVorAnlegen(String url) {
        try {
            WebhookZielPruefung.pruefenUndAufloesen(url);
        } catch (WebhookZielPruefung.UnsicheresZielException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        try {
            webhook.senden(url, BestaetigungsToken.erzeugen(), PROBE_WEBHOOK_PAYLOAD);
        } catch (WebhookException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        return ProbeErgebnis.ok();
    }

    /** "Probe senden" für ein BEREITS verbundenes Ziel (Entscheid 10A). */
    public ProbeErgebnis webhookProbeSenden(UUID id, String benutzerSub) {
        ZustellwegRepository.WebhookZiel ziel = zustellwege.webhookZielMitGeheimnisEigen(id, benutzerSub)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        try {
            webhook.senden(ziel.url(), ziel.geheimnis(), PROBE_WEBHOOK_PAYLOAD);
        } catch (WebhookException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        return ProbeErgebnis.ok();
    }

    private static void pruefenUndWerfen(String url) {
        try {
            WebhookZielPruefung.pruefenUndAufloesen(url);
        } catch (WebhookZielPruefung.UnsicheresZielException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    /** B11: dieselbe Adresse ein zweites Mal ergab bisher ein rohes 500 (Unique-Constraint). */
    private static ResponseStatusException doppelteAdresse() {
        return new ResponseStatusException(HttpStatus.CONFLICT, "Diese Adresse ist schon verbunden.");
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
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Telegram ist auf dieser Installation nicht eingerichtet.");
        }
        String token = BestaetigungsToken.erzeugen();
        Instant ablauf = uhr.instant().plus(TELEGRAM_TOKEN_GUELTIGKEIT);
        // B10: ein weiterer Tipp auf "verbinden" erneuert den eigenen offenen Versuch (falls einer
        // besteht) statt eine weitere offene Zeile anzulegen - sonst sammeln sich verwaiste
        // Verbindungs-Versuche an, deren Token nie eingelöst wurde.
        Optional<UUID> offen = zustellwege.telegramOffenerVersuch(benutzerSub);
        if (offen.isPresent()) {
            zustellwege.telegramVersuchErneuern(offen.get(), token, ablauf);
        } else {
            zustellwege.telegramVerbindungAnfordern(benutzerSub, token, ablauf);
        }
        return new TelegramVerbindungsLink("https://t.me/" + telegramBotUsername + "?start=" + token);
    }

    /**
     * Die Bot-Antwort auf {@code /start <token>} (vom Telegram-Update-Webhook aufgerufen, keine
     * Anmeldung, kein Mandanten-Kontext - wie die E-Mail-Bestätigung per Link). Schickt bei Erfolg
     * sofort die Verbindungs-Bestätigung in den Chat; ein unbekannter/abgelaufener Token bekommt
     * keine Antwort (kein Hinweis, ob der Token je existiert hat).
     */
    public boolean telegramVerbindungBestaetigen(String token, String chatId) {
        boolean bestaetigt;
        try {
            bestaetigt = zustellwege.telegramVerbindungBestaetigen(token, chatId, uhr.instant()).isPresent();
        } catch (DuplicateKeyException e) {
            // B10 (Doppel-Chat): derselbe Chat ist in diesem Kundenbereich schon mit einer ANDEREN
            // Person verbunden - der Telegram-Webhook antwortet trotzdem immer 200 (Telegram
            // wiederholt einen nicht-2xx-Update sonst endlos), nur ohne Erfolg.
            log.warn("Telegram: Chat {} ist bereits einer anderen Person in diesem Kundenbereich verbunden, "
                    + "Verbindung abgelehnt.", chatId);
            return false;
        }
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

    /** "Probe senden" (Entscheid 10A) - nur für eine bereits bestätigte Verbindung. */
    public ProbeErgebnis telegramProbeSenden(UUID id, String benutzerSub) {
        ZustellwegRepository.TelegramZiel ziel = zustellwege.telegramZielMitChatEigen(id, benutzerSub)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        try {
            telegram.senden(ziel.chatId(), PROBE_TEXT);
        } catch (TelegramException e) {
            return ProbeErgebnis.fehlgeschlagen(e.getMessage());
        }
        return ProbeErgebnis.ok();
    }
}
