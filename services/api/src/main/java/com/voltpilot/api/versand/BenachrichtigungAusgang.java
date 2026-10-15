package com.voltpilot.api.versand;

import java.util.UUID;

/**
 * Der EINE Ausgang des zentralen Versands (Alerting Scheibe 0, Konzept §6.2: "jeder andere Absender
 * der Plattform schreibt in denselben Ausgang"). Jeder fremde Absender - heute die Unterstützungs-
 * Hinweise ({@code UnterstuetzungService}), künftig die Überwachung (Scheibe 1) - reiht hier ein,
 * statt eine eigene Versand-Insel zu bauen.
 *
 * <p>Reiht nur ein; wie (und ob) tatsächlich zugestellt wird, entscheidet {@link Zusteller} zur
 * Sendezeit (Weg, Rechte, bestätigter Zustellweg). {@code nr} bleibt 0 für einen einmaligen Versand -
 * wiederholte Erinnerungen (1, 2, 3) sind Scheibe 1.
 *
 * <p>{@link #STUMM} ist der No-Op für Dienste, die ohne Spring-Kontext konstruiert werden (Unit-Tests
 * bestehender Konstruktoren, die keine neue Pflichtabhängigkeit bekommen sollen) - dasselbe Muster wie
 * {@code UemsLaeuferMelder.STUMM}.
 */
public interface BenachrichtigungAusgang {

    /**
     * Reiht eine E-Mail-Zustellung ein. {@code quelle} + {@code quelleId} sind der generische Verweis
     * auf die Meldung (z.B. {@code "unterstuetzung_hinweis"} + die ID der Hinweis-Zeile); zusammen mit
     * {@code empfaengerSub}, {@code anlass} und {@code nr=0} bilden sie den eindeutigen Schlüssel, der
     * Doppelversand verhindert, auch wenn der Aufrufer selbst zweimal einreiht.
     */
    void email(String quelle, UUID quelleId, String empfaengerSub, String anlass, String betreff, String inhalt);

    BenachrichtigungAusgang STUMM = (quelle, quelleId, empfaengerSub, anlass, betreff, inhalt) -> { };
}
