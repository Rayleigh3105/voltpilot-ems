package com.voltpilot.api.versand;

import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * Der eine Kanal-Adapter dieser Scheibe (Entscheid 1A): E-Mail über Spring Mail/SMTP. Weitere Wege
 * (Web-Push, Webhook, Telegram) docken künftig als eigener Adapter hinter demselben {@link Zusteller}
 * an, nie SMS oder Anruf (Entscheid 7C).
 *
 * <p>Nur Text (§6.6 "Kurze Texte nach außen") - kein HTML, kein Tracking-Pixel.
 */
public class EmailVersandAdapter {

    private final JavaMailSender mailSender;
    private final String absender;

    public EmailVersandAdapter(JavaMailSender mailSender, String absender) {
        this.mailSender = mailSender;
        this.absender = absender;
    }

    /** @throws MailException wenn der SMTP-Versand fehlschlägt - der Aufrufer trägt das als Fehlschlag ein. */
    public void senden(String ziel, String betreff, String inhalt) {
        SimpleMailMessage nachricht = new SimpleMailMessage();
        nachricht.setFrom(absender);
        nachricht.setTo(ziel);
        nachricht.setSubject(betreff);
        nachricht.setText(inhalt);
        mailSender.send(nachricht);
    }
}
