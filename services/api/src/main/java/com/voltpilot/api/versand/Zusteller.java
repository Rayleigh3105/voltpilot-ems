package com.voltpilot.api.versand;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailException;
import org.springframework.stereotype.Service;

/**
 * Der zentrale Versand (Alerting Scheibe 0, Konzept §6.2/§6.7): nimmt fällige Zeilen aus dem Ausgang
 * {@code benachrichtigung}, löst die Adresse über den bestätigten {@link ZustellwegRepository} auf -
 * außer bei der Bestätigungs-Mail selbst, die ihr Ziel direkt trägt - und sendet über den einen
 * SMTP-Adapter dieser Scheibe.
 *
 * <p>Läuft je Kundenbereich unter {@link TenantContext} (der Läufer selbst hat keinen
 * Zugriffs-Kontext, §2.5) - der eigentliche Versand braucht hier keine Rechteprüfung über
 * {@code RechteAbleitung.darf}, weil in dieser Scheibe nur die bestehenden Kundenadministratoren
 * (Unterstützungs-Hinweise) adressiert werden; die Sicht-Prüfung je Wert kommt mit der Überwachung
 * (Scheibe 1).
 */
@Service
public class Zusteller {

    private static final Logger log = LoggerFactory.getLogger(Zusteller.class);

    /** Nach drei erfolglosen Versuchen gilt eine Zustellung als endgültig fehlgeschlagen. */
    static final int HOECHSTVERSUCHE = 3;
    private static final Duration WARTEZEIT_NACH_FEHLER = Duration.ofMinutes(5);
    private static final int STAPEL = 50;

    private final VersandRepository ausgang;
    private final ZustellwegRepository zustellwege;
    private final EmailVersandAdapter email;
    private final JdbcTemplate jdbc;

    public Zusteller(VersandRepository ausgang, ZustellwegRepository zustellwege, EmailVersandAdapter email,
            JdbcTemplate jdbc) {
        this.ausgang = ausgang;
        this.zustellwege = zustellwege;
        this.email = email;
        this.jdbc = jdbc;
    }

    /** Ein Takt: fällige Zeilen quer über alle Kundenbereiche, jede unter ihrem eigenen Mandanten. */
    public int lauf(Instant jetzt) {
        int gesendet = 0;
        for (VersandRepository.Zeile zeile : ausgang.faellig(jetzt, STAPEL)) {
            UUID vorher = TenantContext.get();
            TenantContext.set(zeile.tenantId());
            try {
                if (sende(zeile, jetzt)) {
                    gesendet++;
                }
            } finally {
                if (vorher == null) TenantContext.clear(); else TenantContext.set(vorher);
            }
        }
        return gesendet;
    }

    private boolean sende(VersandRepository.Zeile zeile, Instant jetzt) {
        String ziel = zeile.ziel() != null ? zeile.ziel()
                : zustellwege.bestaetigtesZiel(zeile.tenantId(), zeile.empfaengerSub()).orElse(null);
        if (ziel == null) {
            ausgang.unterdrueckt(zeile.id(), "kein_weg");
            return false;
        }
        try {
            email.senden(ziel, zeile.betreff(), zeile.inhalt());
        } catch (MailException e) {
            log.warn("Versand: E-Mail an Meldung {} fehlgeschlagen (Versuch {}): {}", zeile.id(),
                    zeile.versuche() + 1, e.toString());
            ausgang.fehlgeschlagen(zeile.id(), e.getMessage(), jetzt.plus(WARTEZEIT_NACH_FEHLER), HOECHSTVERSUCHE);
            return false;
        }
        ausgang.gesendet(zeile.id(), jetzt);
        nachwirkung(zeile, jetzt);
        return true;
    }

    /**
     * Die EINE bestehende Nebenwirkung dieser Scheibe: die Unterstützungs-Hinweise warten auf
     * {@code email_versandt_am} (Konzept §7 Scheibe 0, Punkt 4). Keine zweite Versand-Insel - der
     * Zusteller trägt es direkt nach dem erfolgreichen Senden nach, idempotent (nur beim ersten Mal).
     */
    private void nachwirkung(VersandRepository.Zeile zeile, Instant jetzt) {
        if ("unterstuetzung_hinweis".equals(zeile.quelle())) {
            jdbc.update("UPDATE unterstuetzung_hinweis SET email_versandt_am = ? "
                    + "WHERE id = ? AND tenant_id = ? AND email_versandt_am IS NULL",
                    java.sql.Timestamp.from(jetzt), zeile.quelleId(), zeile.tenantId());
        }
    }
}
