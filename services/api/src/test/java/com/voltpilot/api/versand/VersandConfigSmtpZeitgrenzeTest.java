package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * Der SMTP-Adapter gegen einen Fänger, der Verbindungen annimmt und nie grüßt. Vorher setzte {@link VersandConfig}
 * keine Zeitgrenze, und Jakarta Mail wartet dann unbegrenzt auf die erste Zeile des Servers - im
 * {@link ZustellLaeufer} hätte das den einzigen Scheduler-Thread der api und damit jeden {@code @Scheduled}-Job
 * angehalten. Mit der Zeitgrenze scheitert der Versand begrenzt, und der {@link Zusteller} verbucht einen
 * Fehlschlag wie bei jedem anderen Verbindungsfehler.
 */
class VersandConfigSmtpZeitgrenzeTest {

    private ServerSocket faenger;
    private final List<Socket> gehalten = new CopyOnWriteArrayList<>();

    @AfterEach
    void beenden() throws Exception {
        for (Socket s : gehalten) {
            s.close();
        }
        if (faenger != null) {
            faenger.close();
        }
    }

    @Test
    @Timeout(20) // ohne Zeitgrenze im Adapter hinge der Versand hier für immer - der Test scheitert statt zu hängen
    void einSchweigenderServerBeendetDenVersandNachDerZeitgrenze() throws Exception {
        faenger = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
        Thread annehmen = new Thread(() -> {
            try {
                while (!faenger.isClosed()) {
                    gehalten.add(faenger.accept()); // annehmen, offen halten, nie antworten
                }
            } catch (Exception beendet) {
                // Fänger geschlossen
            }
        });
        annehmen.setDaemon(true);
        annehmen.start();

        JavaMailSenderImpl sender = VersandConfig.mailSender("127.0.0.1", faenger.getLocalPort(), "", "",
                false, false, Duration.ofMillis(300));
        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom("meldungen@voltpilot.de");
        mail.setTo("kunde@example.org");
        mail.setSubject("Probe");
        mail.setText("Probe");

        long start = System.nanoTime();
        assertThatThrownBy(() -> sender.send(mail)).isInstanceOf(MailException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void dieBeanTraegtDieZeitgrenzeFuerAufbauAntwortUndSchreiben() {
        JavaMailSenderImpl sender = (JavaMailSenderImpl) new VersandConfig()
                .javaMailSender("smtp.example.org", 587, "nutzer", "geheim", true, true);
        String millis = String.valueOf(VersandConfig.SMTP_ZEITGRENZE.toMillis());
        assertThat(sender.getJavaMailProperties())
                .containsEntry("mail.smtp.connectiontimeout", millis)
                .containsEntry("mail.smtp.timeout", millis)
                .containsEntry("mail.smtp.writetimeout", millis)
                .containsEntry("mail.smtp.auth", "true")
                .containsEntry("mail.smtp.starttls.enable", "true");
    }
}
