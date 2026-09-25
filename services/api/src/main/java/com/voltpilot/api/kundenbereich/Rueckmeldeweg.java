package com.voltpilot.api.kundenbereich;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.ClassUtils;

/**
 * Ein MQTT-Rückmeldeweg der API (UEMS AP-20, Folgepaket zu IP-16, E10 = A „alles gesperrt"): jede Klasse, die
 * Nachrichten der Boxen abonniert, erbt von hier und fragt als ERSTE Anweisung ihres {@code handle(topic, …)}
 * {@link #kundenbereichBeendet(String)}. Ein Treffer ist verworfen und gezählt
 * ({@code voltpilot_rueckmeldung_verworfen_total{weg, grund="kundenbereich_beendet"}}), bevor etwas gelesen, geprüft
 * oder geschrieben wird — auch keine Protokoll- oder Ablehnungszeile.
 *
 * <p>Die Wege haben je einen eigenen Paho-Client und keinen gemeinsamen Punkt; gemeinsam ist ihnen diese Frage an
 * {@link BeendeteKundenbereiche}. {@code RueckmeldewegArchitekturTest} hält jede abonnierende Klasse daran fest, und
 * {@code KundenbereichBeendetRueckmeldungTest} schickt jedem Weg eine Nachricht aus einem beendeten Bereich.
 *
 * <p>Der Stand wird per Setter eingesetzt, nicht im Konstruktor: Tests bauen die Wege mit {@code new …} und behalten
 * so ihren Aufruf; ohne Spring gilt {@link BeendeteKundenbereiche#KEINE}.
 */
public abstract class Rueckmeldeweg {

    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    public final void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
        beendete.anmelden(weg());
    }

    /** Der Name des Weges in der Zählung: die Klasse — genau ein Abonnement je Klasse. */
    public final String weg() {
        return ClassUtils.getUserClass(getClass()).getSimpleName();
    }

    /** {@code true} = der Kundenbereich des Topics ist beendet; die Nachricht ist verworfen und gezählt. */
    protected final boolean kundenbereichBeendet(String topic) {
        return beendete.verwirft(weg(), topic);
    }
}
