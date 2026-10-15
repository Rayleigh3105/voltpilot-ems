package com.voltpilot.api.versand;

import java.time.Instant;
import java.util.UUID;

/**
 * Der EINE Ausgang des zentralen Versands (Alerting Scheibe 0, Konzept §6.2: "jeder andere Absender
 * der Plattform schreibt in denselben Ausgang"). Jeder fremde Absender - heute die Unterstützungs-
 * Hinweise ({@code UnterstuetzungService}), die Überwachung (Scheibe 1/3) - reiht hier ein, statt eine
 * eigene Versand-Insel zu bauen.
 *
 * <p>Reiht nur ein; wie (und ob) tatsächlich zugestellt wird, entscheidet {@link Zusteller} zur
 * Sendezeit (Weg, Rechte, Ruhezeit, bestätigter Zustellweg). Die einfachen Überladungen setzen
 * {@code nr = 0} und {@code naechsterVersuch = jetzt} (ein einmaliger, sofort fälliger Versand);
 * Scheibe 3 braucht die volle Form für Erinnerungen ({@code nr} 1-3, Konzept §6.5) - der
 * eindeutige Schlüssel {@code (quelle, quelle_id, empfaenger_sub, weg, anlass, nr)} verhindert
 * Doppelversand, auch wenn der Aufrufer selbst zweimal einreiht.
 *
 * <p>{@link #STUMM} ist der No-Op für Dienste, die ohne Spring-Kontext konstruiert werden (Unit-Tests
 * bestehender Konstruktoren, die keine neue Pflichtabhängigkeit bekommen sollen) - dasselbe Muster wie
 * {@code UemsLaeuferMelder.STUMM}.
 */
public interface BenachrichtigungAusgang {

    /**
     * Reiht eine Zustellung ein. {@code quelle} + {@code quelleId} sind der generische Verweis auf
     * die Meldung (z.B. {@code "unterstuetzung_hinweis"} + die ID der Hinweis-Zeile, oder
     * {@code "alarm"} + die Alarm-ID); zusammen mit {@code empfaengerSub}, {@code weg},
     * {@code anlass} und {@code nr} bilden sie den eindeutigen Schlüssel.
     */
    void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch);

    /**
     * Wie {@link #email}, aber über Web-Push (Alerting Scheibe 3, §6.4): Geräte-Abos fächert der
     * Zusteller auf. {@code schwere} ist NUR für {@code quelle = "alarm"} gesetzt (sonst
     * {@code null}) - der Zusteller braucht sie, um je Gerät dessen eigene Zustell-Vorgabe
     * ({@code push_abo.ab_schwere}) zu prüfen, ohne das Paket {@code ueberwachung} zu kennen.
     */
    void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere);

    /** Einmaliger, sofort fälliger Versand ({@code nr = 0}) - die Form, die Scheibe 0/1 schon kannten. */
    default void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff,
            String inhalt) {
        email(quelle, quelleId, empfaengerSub, anlass, 0, betreff, inhalt, Instant.now());
    }

    /** Einmaliger, sofort fälliger Push-Versand ({@code nr = 0}, ohne Stufe). */
    default void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff,
            String inhalt) {
        webpush(quelle, quelleId, empfaengerSub, anlass, 0, betreff, inhalt, Instant.now(), null);
    }

    /** Einmaliger, sofort fälliger Push-Versand MIT Stufe (die übliche Form für {@code quelle = "alarm"}). */
    default void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff,
            String inhalt, String schwere) {
        webpush(quelle, quelleId, empfaengerSub, anlass, 0, betreff, inhalt, Instant.now(), schwere);
    }

    BenachrichtigungAusgang STUMM = new BenachrichtigungAusgang() {
        @Override
        public void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
                String inhalt, Instant naechsterVersuch) {
            // kein Versand - siehe Klassenkommentar
        }

        @Override
        public void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            // kein Versand - siehe Klassenkommentar
        }
    };
}
