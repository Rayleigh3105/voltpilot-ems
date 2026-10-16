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

    /**
     * Wie {@link #webpush}, aber über Webhook (Alerting Scheibe 6, §7 Scheibe 6): alle aktiven
     * Webhook-Ziele der Person fächert der Zusteller auf, mit ihrer eigenen Signatur.
     */
    void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere);

    /**
     * Wie {@link #webpush}, aber über Telegram (Alerting Scheibe 6, §7 Scheibe 6): alle aktiven,
     * bestätigten Telegram-Verbindungen der Person fächert der Zusteller auf.
     */
    void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere);

    /**
     * Wie {@link #email}, aber mit einem Bündel-Schlüssel (Alerting Scheibe 4, Konzept §6.4 Nr. 6,
     * §6.6: "eine gebündelte Nachricht baut der Zusteller je Empfänger nur aus den Meldungen, die
     * dieser sieht"): Zeilen mit demselben {@code buendelSchluessel} (+ {@code empfaengerSub} +
     * {@code weg}), die zur selben Zeit fällig werden, fasst der Zusteller zu EINER Nachricht
     * zusammen. Die Vorgabe (kein Schlüssel) sendet wie bisher einzeln - nur Mehrfach-Regeln
     * (Auswahl, §6.4 "Gilt für") setzen einen Schlüssel, damit Scheibe 1-3 unverändert bleiben.
     */
    default void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String buendelSchluessel) {
        email(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch);
    }

    /** Wie {@link #webpush}, aber mit einem Bündel-Schlüssel - siehe {@link #email(String, UUID, String, String,
     * int, String, String, Instant, String)}. */
    default void webpush(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        webpush(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere);
    }

    /** Wie {@link #webhook}, aber mit einem Bündel-Schlüssel - siehe {@link #email(String, UUID, String, String,
     * int, String, String, Instant, String)}. */
    default void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        webhook(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere);
    }

    /** Wie {@link #telegram}, aber mit einem Bündel-Schlüssel - siehe {@link #email(String, UUID, String, String,
     * int, String, String, Instant, String)}. */
    default void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr, String betreff,
            String inhalt, Instant naechsterVersuch, String schwere, String buendelSchluessel) {
        telegram(quelle, quelleId, empfaengerSub, anlass, nr, betreff, inhalt, naechsterVersuch, schwere);
    }

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

    /** Einmaliger, sofort fälliger Webhook-Versand MIT Stufe (die übliche Form für {@code quelle = "alarm"}). */
    default void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff,
            String inhalt, String schwere) {
        webhook(quelle, quelleId, empfaengerSub, anlass, 0, betreff, inhalt, Instant.now(), schwere);
    }

    /** Einmaliger, sofort fälliger Telegram-Versand MIT Stufe (die übliche Form für {@code quelle = "alarm"}). */
    default void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff,
            String inhalt, String schwere) {
        telegram(quelle, quelleId, empfaengerSub, anlass, 0, betreff, inhalt, Instant.now(), schwere);
    }

    /**
     * Direkter Ziel-Versand an einen NICHT-Plattform-Empfänger (Alerting Scheibe 6, Entscheid 11B:
     * freie externe E-Mail-Empfänger je Überwachung). Quelle {@code "alarm_extern"} - bewusst NICHT
     * {@code "alarm"} - durchläuft darum nie die Sicht-/Ruhezeit-Prüfung des Zustellers (es gibt
     * keine Person mit Rechten oder Ruhezeit dahinter, siehe {@code Zusteller#vorpruefung}); ob
     * überhaupt eingereiht wird, entscheidet allein die Bestätigt/Aktiv-Prüfung VOR dem Aufruf
     * dieser Methode. {@code empfaengerKennung} ist keine echte Person - nur der eindeutige Teil des
     * Versand-Schlüssels (z. B. {@code "extern:" + zeile.id()}).
     */
    default void emailExtern(UUID quelleId, String empfaengerKennung, String anlass, String betreff, String inhalt,
            String ziel) {
        // Vorgabe: kein Versand - siehe STUMM; VersandRepository überschreibt dies mit einem echten Einreihen.
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

        @Override
        public void webhook(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            // kein Versand - siehe Klassenkommentar
        }

        @Override
        public void telegram(String quelle, UUID quelleId, String empfaengerSub, String anlass, int nr,
                String betreff, String inhalt, Instant naechsterVersuch, String schwere) {
            // kein Versand - siehe Klassenkommentar
        }
    };
}
