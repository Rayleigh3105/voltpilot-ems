package com.voltpilot.api.versand;

import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.telegram.TelegramBotAdapter;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.util.Base64;
import java.util.Properties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * Alerting Scheibe 0: der EINE SMTP-Adapter. Host, Port, Zugangsdaten und Absender kommen aus
 * {@code application.yml} und bleiben dort LEER (bzw. per Umgebungsvariable) - das echte SMTP-Passwort
 * liegt niemals im Repo, sondern kommt beim Deploy aus der sops-Geheimnisdatei des GitOps-Repos
 * (docs/rollout/uems-erste-freigabe.md, Zeile ~980).
 *
 * <p>Konstruiert die Bean bewusst selbst statt Spring Boots {@code MailSenderAutoConfiguration} zu
 * nutzen: so bleibt es EIN Ort, der die Werte liest, und ein leerer Host führt nicht zu einem
 * abweichenden Bean-Vorhandensein, sondern zu einem ehrlichen Verbindungsfehler beim ersten
 * tatsächlichen Versand (von {@link Zusteller} als Fehlschlag protokolliert, kein Absturz des Starts).
 */
@Configuration
public class VersandConfig {

    @Bean
    JavaMailSender javaMailSender(
            @Value("${spring.mail.host:}") String host,
            @Value("${spring.mail.port:587}") int port,
            @Value("${spring.mail.username:}") String username,
            @Value("${spring.mail.password:}") String password,
            @Value("${spring.mail.properties.mail.smtp.auth:true}") boolean auth,
            @Value("${spring.mail.properties.mail.smtp.starttls.enable:true}") boolean starttls) {
        JavaMailSenderImpl sender = new JavaMailSenderImpl();
        sender.setHost(host);
        sender.setPort(port);
        sender.setUsername(username);
        sender.setPassword(password);
        Properties eigenschaften = sender.getJavaMailProperties();
        eigenschaften.put("mail.smtp.auth", String.valueOf(auth));
        eigenschaften.put("mail.smtp.starttls.enable", String.valueOf(starttls));
        return sender;
    }

    @Bean
    EmailVersandAdapter emailVersandAdapter(JavaMailSender javaMailSender,
            @Value("${voltpilot.versand.absender:meldungen@voltpilot.de}") String absender) {
        return new EmailVersandAdapter(javaMailSender, absender);
    }

    /**
     * Alerting Scheibe 3 (Entscheid 1A): der VAPID-Schlüssel kommt - wie das SMTP-Passwort - aus der
     * sops-Geheimnisdatei des GitOps-Repos, lokal/im Testlauf aus Umgebungsvariablen
     * (docs/rollout/uems-erste-freigabe.md). Leere Werte führen NICHT zu einem fehlenden Bean,
     * sondern (wie beim SMTP-Adapter) zu einem ehrlichen Fehler beim ersten tatsächlichen Push-Versand
     * - ein Platzhalter-Schlüssel genügt, damit der Konstruktor selbst nicht scheitert.
     */
    @Bean
    WebPushAdapter webPushAdapter(
            @Value("${voltpilot.push.vapid-public-key:}") String vapidPublicKey,
            @Value("${voltpilot.push.vapid-private-key:}") String vapidPrivateKey,
            @Value("${voltpilot.push.vapid-subject:mailto:meldungen@voltpilot.de}") String vapidSubject) {
        String oeffentlich = vapidPublicKey.isBlank() ? PLATZHALTER_SCHLUESSEL_65 : vapidPublicKey;
        String privat = vapidPrivateKey.isBlank() ? PLATZHALTER_SCHLUESSEL_32 : vapidPrivateKey;
        return new WebPushAdapter(oeffentlich, privat, vapidSubject);
    }

    /** Alerting Scheibe 6: keine Geheimnisse - jedes Webhook-Ziel trägt sein eigenes HMAC-Geheimnis. */
    @Bean
    WebhookVersandAdapter webhookVersandAdapter() {
        return new WebhookVersandAdapter();
    }

    /**
     * Alerting Scheibe 6 (§9): der Bot-Token kommt - wie das SMTP-Passwort und der VAPID-Schlüssel -
     * aus der sops-Geheimnisdatei des GitOps-Repos, lokal/im Testlauf aus Umgebungsvariablen. Ein
     * leerer Token führt NICHT zu einem fehlenden Bean, sondern zu einem ehrlichen Fehler beim
     * ersten tatsächlichen Versand (derselbe Grundsatz wie bei den anderen Adaptern).
     */
    @Bean
    TelegramAdapter telegramAdapter(@Value("${voltpilot.telegram.bot-token:}") String botToken) {
        return new TelegramBotAdapter(botToken);
    }

    private static final String PLATZHALTER_SCHLUESSEL_65 =
            Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[65]);
    // BouncyCastle prüft beim Bauen des privaten Schlüssels, dass der Skalar in [1, n-1] liegt (ECC-
    // Festlegung) - anders als beim leeren SMTP-Host (nur ein String) würde ein Platzhalter aus
    // lauter Nullen also SCHON BEIM START scheitern, nicht erst beim ersten Versand. Der Skalar 1
    // ist immer gültig, unabhängig von der Kurve.
    private static final String PLATZHALTER_SCHLUESSEL_32;

    static {
        byte[] skalarEins = new byte[32];
        skalarEins[31] = 1;
        PLATZHALTER_SCHLUESSEL_32 = Base64.getUrlEncoder().withoutPadding().encodeToString(skalarEins);
    }
}
