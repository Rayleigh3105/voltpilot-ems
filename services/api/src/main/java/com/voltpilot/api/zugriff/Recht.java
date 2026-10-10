package com.voltpilot.api.zugriff;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Das Recht einer Kunden-Schreibroute (UEMS AP-03 IP-6, §6.2 Punkt 5, §4.9 „Schreibpfade tragen ein Recht"): die
 * Kennung ihrer Zeile in {@code docs/contracts/v2/rechte-matrix.json} und das Objekt, an dessen Standort das Recht
 * geprüft wird.
 *
 * <p>{@link RechtInterceptor} prüft VOR dem Handler — Geltungsbereich vor Aktion (W2): außerhalb 404, dieselbe Antwort
 * wie für eine Kennung, die es nicht gibt; im Geltungsbereich ohne Recht 403 {@code recht_fehlt} mit
 * {@code rolle_noetig}. Das Urteil spricht {@link com.voltpilot.api.uems.RechteAbleitung#darf} mit der Matrix-Datei aus
 * dem Jar ({@link RechteMatrixDatei}) — keine zweite Liste im Code.
 *
 * <p>Die Annotation steht direkt UNTER der Mapping-Zeile: über ihr steht der Rechte-Kommentar, den
 * {@code RechteKennungenDerRoutenTest} liest. {@code RechtRoutenArchitekturTest} hält fest, dass jede Kunden-Schreibroute
 * sie trägt oder mit Grund in seiner Liste steht.
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface Recht {

    /**
     * Die Kennung aus der Matrix. Mehrere nur bei {@link RechtZiel#DIENST}: dann wählt die Geltung des Objekts im Dienst
     * die Zeile (Kennzahl am Standort oder im Unternehmen), und die Vorprüfung verlangt eine von ihnen.
     */
    String[] value();

    /** Woran der Standort des Rechts hängt. */
    RechtZiel ziel();

    /** Die Pfadvariable mit der Kennung des Objekts; leer = die Vorgabe der Zielart ({@link RechtZiel#variable()}). */
    String variable() default "";
}
