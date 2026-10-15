package com.voltpilot.api.versand;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailException;
import org.springframework.stereotype.Service;

/**
 * Der zentrale Versand (Alerting Scheibe 0/1, Konzept §6.2/§6.6/§6.7): nimmt fällige Zeilen aus dem
 * Ausgang {@code benachrichtigung}, löst die Adresse über den bestätigten
 * {@link ZustellwegRepository} auf - außer bei der Bestätigungs-Mail selbst, die ihr Ziel direkt
 * trägt - und sendet über den einen SMTP-Adapter dieser Scheibe.
 *
 * <p>Läuft je Kundenbereich unter {@link TenantContext} (der Läufer selbst hat keinen
 * Zugriffs-Kontext, §2.5). Für {@code quelle = "alarm"} (Scheibe 1) prüft {@link #sicht} VOR dem
 * Senden die Sicht je Empfänger ({@code RechteAbleitung.darf}, §6.6): fehlt sie, wird die Zeile
 * {@code unterdrueckt} mit Grund {@code keine_sicht}, statt gesendet zu werden. Für
 * {@code quelle = "unterstuetzung_hinweis"} (Scheibe 0) bleibt es dabei, dass nur bestehende
 * Kundenadministratoren adressiert werden - keine Sicht-Prüfung nötig.
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

    /** Alerting Scheibe 1: die Sicht-Prüfung je Empfänger (§6.6); ohne Spring greift {@link UeberwachungSichtPruefung#IMMER_SICHTBAR}. */
    private UeberwachungSichtPruefung sicht = UeberwachungSichtPruefung.IMMER_SICHTBAR;

    @Autowired(required = false)
    void setSicht(UeberwachungSichtPruefung sicht) {
        this.sicht = sicht == null ? UeberwachungSichtPruefung.IMMER_SICHTBAR : sicht;
    }

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
        if ("alarm".equals(zeile.quelle()) && !sicht.sichtbar(zeile.quelleId(), zeile.empfaengerSub(), jetzt)) {
            ausgang.unterdrueckt(zeile.id(), "keine_sicht");
            return false;
        }
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
