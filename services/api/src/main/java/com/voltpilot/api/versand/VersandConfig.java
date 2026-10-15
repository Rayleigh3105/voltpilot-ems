package com.voltpilot.api.versand;

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
}
