package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 WV1/WV2: eine Quelle der Wiedervorlage. Jede Quelle liest ihre Fristen über den Dienst, dem sie gehören —
 * im Zaun und mit den Rechten des Aufrufers — und gibt sie FERTIG aus der Regel ihres Objekts weiter; sie rechnet keine
 * Frist nach. Lage, Vorschau-Fenster und Reihenfolge macht danach die Operation {@code wiedervorlage} des Vertrags
 * ({@link EnergiemanagementRegeln#wiedervorlage}) im Leser {@code GET …/wiedervorlage} (IP-21).
 *
 * <p>Heute: {@link DokumentWiedervorlage} (DK5), {@link AuditWiedervorlage} (IA4), {@link FeststellungWiedervorlage}
 * (FS1) und {@link WiedervorlageBestand} (AP-16 S5, AP-17 F5, AP-12 E7, AP-18 F1–F3 über den Übersichts-Leser, Messbedarf).
 * Die Managementbewertung (MG7) seit IP-23: {@link ManagementbewertungWiedervorlage} in {@code @Order(40)}.
 */
public interface WiedervorlageQuelle {

    /**
     * Eine Frist, wie ihr Objekt sie festlegt. {@code art} aus {@code wiedervorlage_art}; {@code id} und
     * {@code kennzahlId} tragen den Sprung auf eine bestehende Seite (WV3), beide dürfen {@code null} sein.
     */
    record Frist(String art, String kennzeichen, String titel, LocalDate faelligAm, String verantwortlich, UUID id,
            UUID kennzahlId) {}

    /** Die Fristen am Tag {@code abruf} — jede Frist genau einmal, auch eine weit in der Zukunft. */
    List<Frist> fristen(LocalDate abruf);
}
