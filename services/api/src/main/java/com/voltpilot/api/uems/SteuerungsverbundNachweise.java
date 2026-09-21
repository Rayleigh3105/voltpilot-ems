package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Die schmale Naht zu den Tatsachen des Scharfschaltens, die NICHT am Verbund-Objekt hängen (UEMS AP-15 IP-5, I1,
 * G6). Heute antwortet sie für jede Bedingung ohne Quelle „fehlt“ ({@link SteuerungsverbundNachweiseHeute}); die
 * Pakete, die die Quellen bauen, ersetzen je eine Methode:
 *
 * <ul>
 *   <li>{@link #faehigkeit} — IP-17 (Box meldet {@code steuerungsverbund_anteil}; bis dahin kennt
 *       {@link BoxFaehigkeiten#kann} das Wort nicht und sagt nein),</li>
 *   <li>{@link #sprungprobe} — IP-21 (Protokoll der Sprungprobe je steuernder Box),</li>
 *   <li>{@link #auslegung} — IP-7 mit den Geräte-Rückfällen aus IP-6 (Nennleistung und Rückfall je Box und Richtung,
 *       Vorbehalt aus IP-13),</li>
 *   <li>{@link #verbraucher14a} und {@link #vorgabeSignal} — G6: kein Paket in §8 nennt ihren Träger (Befund im
 *       PR von IP-5); bis dahin unbekannt, also nie scharf.</li>
 * </ul>
 */
public interface SteuerungsverbundNachweise {

    /** Name der Box-Fähigkeit, die jede steuernde Box braucht (I1, I2, R14). */
    String FAEHIGKEIT = "steuerungsverbund_anteil";

    /** Die Box hat die Fähigkeit {@link #FAEHIGKEIT} — gemeldet oder laut Versions-Tabelle. */
    boolean faehigkeit(UUID box);

    /** Die Sprungprobe dieser Box in diesem Verbund ist bestanden und ihr Protokoll gespeichert (T5). */
    boolean sprungprobe(UUID verbundId, UUID box);

    /**
     * Der Eingang der Auslegung je Richtung für die Mitglieder am Tag (G2/G3) — leer, solange er nicht rechenbar ist.
     * Leer heißt {@code auslegung_passt_nicht}: unbekannt ist nicht „passt“.
     */
    Optional<Map<Grenzart, SteuerungsverbundRegeln.Richtung>> auslegung(UUID siteId, List<UUID> boxen, LocalDate tag);

    /** Hinter der Box hängen steuerbare Verbraucher nach § 14a — {@code null} = unbekannt (zählt als ja). */
    Boolean verbraucher14a(UUID siteId, UUID box);

    /** Das Signal des Netzbetreibers liegt an dieser Box an — {@code null} = unbekannt (zählt als nein). */
    Boolean vorgabeSignal(UUID siteId, UUID box);
}
