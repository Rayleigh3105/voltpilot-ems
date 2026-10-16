package com.voltpilot.api.versand;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import com.voltpilot.api.versand.webpush.WebPushException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailException;
import org.springframework.stereotype.Service;

/**
 * Der zentrale Versand (Alerting Scheibe 0/1/3, Konzept §6.2/§6.6/§6.7): nimmt fällige Zeilen aus dem
 * Ausgang {@code benachrichtigung}, löst den Weg auf - E-Mail über den bestätigten
 * {@link ZustellwegRepository}, Web-Push über alle aktiven Geräte-Abos der Person - und sendet.
 *
 * <p>Läuft je Kundenbereich unter {@link TenantContext} (der Läufer selbst hat keinen
 * Zugriffs-Kontext, §2.5). Für {@code quelle = "alarm"} prüft {@link #sicht} VOR dem Senden die Sicht
 * je Empfänger ({@code RechteAbleitung.darf}, §6.6) und {@link #ruhezeit} (Alerting Scheibe 3, §6.4),
 * ob JETZT überhaupt zugestellt werden darf: fehlt die Sicht, wird die Zeile {@code unterdrueckt} mit
 * Grund {@code keine_sicht}; eine aktive Ruhezeit verschiebt sie (Warnung kommt nach) oder unterdrückt
 * sie endgültig (Stummschaltung, oder der Alarm ist inzwischen erledigt/gesehen - Grund {@code stumm}).
 * Für {@code quelle = "unterstuetzung_hinweis"} (Scheibe 0) und die Tages-Zusammenfassung
 * ({@code quelle = "zusammenfassung"}, Scheibe 3) gilt beides nicht - keine Sicht-/Ruhezeit-Prüfung
 * nötig.
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
    private final WebPushAdapter push;
    private final JdbcTemplate jdbc;

    /** Alerting Scheibe 1: die Sicht-Prüfung je Empfänger (§6.6); ohne Spring greift {@link UeberwachungSichtPruefung#IMMER_SICHTBAR}. */
    private UeberwachungSichtPruefung sicht = UeberwachungSichtPruefung.IMMER_SICHTBAR;
    /** Alerting Scheibe 3: Ruhezeit/Stummschaltung (§6.4); ohne Spring greift {@link RuhezeitPruefung#IMMER_SOFORT}. */
    private RuhezeitPruefung ruhezeit = RuhezeitPruefung.IMMER_SOFORT;

    @Autowired(required = false)
    void setSicht(UeberwachungSichtPruefung sicht) {
        this.sicht = sicht == null ? UeberwachungSichtPruefung.IMMER_SICHTBAR : sicht;
    }

    @Autowired(required = false)
    void setRuhezeit(RuhezeitPruefung ruhezeit) {
        this.ruhezeit = ruhezeit == null ? RuhezeitPruefung.IMMER_SOFORT : ruhezeit;
    }

    public Zusteller(VersandRepository ausgang, ZustellwegRepository zustellwege, EmailVersandAdapter email,
            WebPushAdapter push, JdbcTemplate jdbc) {
        this.ausgang = ausgang;
        this.zustellwege = zustellwege;
        this.email = email;
        this.push = push;
        this.jdbc = jdbc;
    }

    /**
     * Ein Takt: fällige Zeilen quer über alle Kundenbereiche, jede unter ihrem eigenen Mandanten.
     * Gruppiert zuerst je Mandant + Bündel-Schlüssel + Empfänger + Weg (Alerting Scheibe 4, §6.4
     * Nr. 6, §6.6): Zeilen OHNE Schlüssel (Scheibe 0-3, unverändert) bleiben Einzelgängerinnen;
     * Zeilen MIT demselben Schlüssel - eine Mehrfach-Regel, die binnen 30 s mehrfach auslöst - gehen
     * in {@link #sendeBuendel} und werden dort je Empfänger zu EINER Nachricht.
     */
    public int lauf(Instant jetzt) {
        Map<String, List<VersandRepository.Zeile>> gruppen = new LinkedHashMap<>();
        for (VersandRepository.Zeile zeile : ausgang.faellig(jetzt, STAPEL)) {
            String schluessel = zeile.buendelSchluessel() == null ? "einzel:" + zeile.id()
                    : zeile.tenantId() + "|" + zeile.buendelSchluessel() + "|" + zeile.empfaengerSub() + "|"
                            + zeile.weg();
            gruppen.computeIfAbsent(schluessel, k -> new ArrayList<>()).add(zeile);
        }
        int gesendet = 0;
        for (List<VersandRepository.Zeile> gruppe : gruppen.values()) {
            UUID vorher = TenantContext.get();
            TenantContext.set(gruppe.get(0).tenantId());
            try {
                gesendet += gruppe.size() == 1 ? (sende(gruppe.get(0), jetzt) ? 1 : 0) : sendeBuendel(gruppe, jetzt);
            } finally {
                if (vorher == null) TenantContext.clear(); else TenantContext.set(vorher);
            }
        }
        return gesendet;
    }

    private enum Vorpruefung { SENDEN, UNTERDRUECKT, VERSCHOBEN }

    /** Sicht + Ruhezeit (§6.6/§6.4), OHNE zu senden - gemeinsam für {@link #sende} und {@link #sendeBuendel}. */
    private Vorpruefung vorpruefung(VersandRepository.Zeile zeile, Instant jetzt) {
        if (!"alarm".equals(zeile.quelle())) {
            return Vorpruefung.SENDEN;
        }
        if (!sicht.sichtbar(zeile.quelleId(), zeile.empfaengerSub(), jetzt)) {
            ausgang.unterdrueckt(zeile.id(), "keine_sicht");
            return Vorpruefung.UNTERDRUECKT;
        }
        Instant wann = ruhezeit.wannSenden(zeile.quelleId(), zeile.empfaengerSub(), zeile.weg(), zeile.anlass(),
                jetzt);
        if (wann.isAfter(jetzt)) {
            if (Instant.MAX.equals(wann)) {
                ausgang.unterdrueckt(zeile.id(), "stumm");
            } else {
                ausgang.verschieben(zeile.id(), wann);
            }
            return Vorpruefung.VERSCHOBEN;
        }
        return Vorpruefung.SENDEN;
    }

    private boolean sende(VersandRepository.Zeile zeile, Instant jetzt) {
        if (vorpruefung(zeile, jetzt) != Vorpruefung.SENDEN) {
            return false;
        }
        return "webpush".equals(zeile.weg()) ? sendePush(zeile, jetzt) : sendeEmail(zeile, jetzt);
    }

    /**
     * EIN Empfänger, EIN Weg, mehrere gleichzeitig ausgelöste Meldungen derselben Regel (§6.4 Nr. 6):
     * jede Zeile prüft ihre EIGENE Sicht/Ruhezeit zuerst (§6.6 "nur aus den Meldungen, die dieser
     * sieht") - nur die sichtbaren, nicht-stummen gehen in die gebündelte Nachricht. Bleibt nach
     * dieser Prüfung nur EINE übrig, wird sie wie gewohnt einzeln verschickt (keine Nachricht
     * "1 Anlage über ..."). Jede Zeile bekommt trotzdem ihr eigenes Versandergebnis im Verlauf
     * (§6.1 Nr. 10) - auch wenn die gebündelte Nachricht technisch nur EINMAL verschickt wird.
     */
    private int sendeBuendel(List<VersandRepository.Zeile> gruppe, Instant jetzt) {
        List<VersandRepository.Zeile> sendbar = new ArrayList<>();
        for (VersandRepository.Zeile zeile : gruppe) {
            if (vorpruefung(zeile, jetzt) == Vorpruefung.SENDEN) {
                sendbar.add(zeile);
            }
        }
        if (sendbar.isEmpty()) {
            return 0;
        }
        if (sendbar.size() == 1) {
            VersandRepository.Zeile einzige = sendbar.get(0);
            boolean ok = "webpush".equals(einzige.weg()) ? sendePush(einzige, jetzt) : sendeEmail(einzige, jetzt);
            return ok ? 1 : 0;
        }
        VersandRepository.Zeile erste = sendbar.get(0);
        StringBuilder inhalt = new StringBuilder(sendbar.size() + " Meldungen:\n");
        for (VersandRepository.Zeile zeile : sendbar) {
            inhalt.append("- ").append(zeile.inhalt()).append('\n');
        }
        VersandRepository.Zeile gebuendelt = new VersandRepository.Zeile(erste.id(), erste.tenantId(),
                erste.quelle(), erste.quelleId(), erste.empfaengerSub(), erste.weg(), erste.anlass(), erste.nr(),
                erste.ziel(), sendbar.size() + " Meldungen: " + erste.betreff(), inhalt.toString(), erste.versuche(),
                erste.schwere(), erste.buendelSchluessel());
        boolean ok = "webpush".equals(gebuendelt.weg()) ? sendePush(gebuendelt, jetzt) : sendeEmail(gebuendelt, jetzt);
        if (!ok) {
            return 0;
        }
        for (int i = 1; i < sendbar.size(); i++) {
            ausgang.gesendet(sendbar.get(i).id(), jetzt);
        }
        return sendbar.size();
    }

    private boolean sendeEmail(VersandRepository.Zeile zeile, Instant jetzt) {
        if (zeile.schwere() != null
                && !zustellwege.hatAktivenEmailWeg(zeile.tenantId(), zeile.empfaengerSub(), zeile.schwere())) {
            ausgang.unterdrueckt(zeile.id(), "kein_weg"); // §6.4 "Zustell-Vorgabe je Stufe"
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
     * Web-Push (Alerting Scheibe 3, §6.7): EINE Zeile fächert sich auf ALLE aktiven Geräte-Abos der
     * Person auf, deren eigene Zustell-Vorgabe diese Stufe zulässt ("Abo je Gerät"). Gilt mindestens
     * ein Versuch als erfolgreich (2xx), ist die Zeile {@code gesendet}; schlagen ALLE fehl, zählt
     * das als EIN Fehlschlag der Zeile. Ein 404/410 eines einzelnen Geräts räumt nur dieses Abo auf
     * (§7 Scheibe 3 Punkt 1) und hält den Gesamt-Erfolg der Zeile nicht auf.
     */
    private boolean sendePush(VersandRepository.Zeile zeile, Instant jetzt) {
        List<WebPushAdapter.Abo> abos = zustellwege.pushAbosFuerVersand(zeile.tenantId(), zeile.empfaengerSub(),
                zeile.schwere() == null ? "dringend" : zeile.schwere());
        if (abos.isEmpty()) {
            ausgang.unterdrueckt(zeile.id(), "kein_weg");
            return false;
        }
        String payload = pushPayload(zeile);
        boolean mindestensEinErfolg = false;
        String letzterFehler = null;
        for (WebPushAdapter.Abo abo : abos) {
            try {
                push.senden(abo, payload);
                zustellwege.pushAboErfolgVermerken(abo.endpoint(), jetzt);
                mindestensEinErfolg = true;
            } catch (WebPushException e) {
                if (e.abgelaufen()) {
                    zustellwege.pushAboAlsAbgelaufenMarkieren(abo.endpoint(), jetzt);
                } else {
                    log.warn("Versand: Push an Meldung {} fehlgeschlagen ({}): {}", zeile.id(), e.status(),
                            e.getMessage());
                }
                letzterFehler = e.getMessage();
            }
        }
        if (!mindestensEinErfolg) {
            ausgang.fehlgeschlagen(zeile.id(), letzterFehler == null ? "keine Geräte erreichbar" : letzterFehler,
                    jetzt.plus(WARTEZEIT_NACH_FEHLER), HOECHSTVERSUCHE);
            return false;
        }
        ausgang.gesendet(zeile.id(), jetzt);
        return true;
    }

    /** Knappe JSON-Nutzlast für den {@code push}-Handler des Service-Workers (§6.8 Entwurf 4/frontend/public/sw.js). */
    private static String pushPayload(VersandRepository.Zeile zeile) {
        return "{\"titel\":" + jsonText(zeile.betreff()) + ",\"text\":" + jsonText(zeile.inhalt())
                + ",\"url\":\"#/meldungen\"}";
    }

    private static String jsonText(String text) {
        String sicher = text == null ? "" : text.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", "");
        return "\"" + sicher + "\"";
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
