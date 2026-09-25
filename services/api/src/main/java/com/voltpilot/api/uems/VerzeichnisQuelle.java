package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * UEMS AP-19 VZ1: eine Quelle des Verzeichnisses. Jede Quelle liest ihre Nachweise über den Dienst, dem sie gehören —
 * im Zaun und mit den Rechten des Aufrufers — und gibt jede Zeile so aus, wie die Operation {@code verzeichnis_zeile}
 * des Vertrags sie formt ({@link EnergiemanagementRegeln#verzeichnisZeile}); sie kopiert nichts.
 *
 * <p>Der Leser {@code GET …/verzeichnis} (IP-8) sammelt alle Quellen in ihrer {@code @Order} und filtert Gruppe,
 * Zeitraum und Person. Heute: {@link AufgabenVerzeichnis} (Gruppe {@code verantwortung}, IP-10); Dokumente und
 * Bekanntmachungen (IP-7/IP-8), Audits (IP-18), Feststellungen (IP-19) und Managementbewertung (IP-23) docken hier an.
 */
public interface VerzeichnisQuelle {

    /** Die Zeilen am {@code stichtag} — jede eine Ausgabe von {@code verzeichnis_zeile}. */
    List<Map<String, Object>> zeilen(LocalDate stichtag);
}
