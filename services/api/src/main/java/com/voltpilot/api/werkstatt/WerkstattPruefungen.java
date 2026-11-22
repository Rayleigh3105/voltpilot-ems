package com.voltpilot.api.werkstatt;

import java.time.Instant;
import java.util.Collection;
import java.util.List;

/**
 * Die Prüfungen der Werkstatt-Regel als geschlossene Liste - die Kennungen,
 * die eine Abnahme vollständig abgehakt tragen muss. Zwilling des Portals
 * ({@code frontend/portal/src/werkstatt.ts}); beide Tests lesen
 * {@code docs/contracts/werkstatt-pruefungen.json}.
 */
public final class WerkstattPruefungen {

    /** In der Reihenfolge der Regel. */
    public static final List<String> ALLE = List.of(
            "root_passwort",
            "notfall_schluessel",
            "tunnel_status",
            "anmeldeprobe",
            "host_schluessel",
            "fenster_zu",
            "lan_netz",
            "neustart",
            "update_bereit",
            "einrichtung_wlan_bereit");

    /**
     * Die Prüfungen für den WAGO PFC200 (Edge Industrie), in der Reihenfolge
     * seiner Regel ({@code geraete.pfc200} im Vektor). Ohne Prüfung der SPS
     * (Programm, Koppelprobe) und ohne Prüfung der Firmware: Ihr Stand steht
     * als Angabe an der Abnahme. Statt des einen Root-Passworts die drei
     * Zugänge, statt des LAN-Netzes die zwei getrennten Netze und die Dienste
     * je Buchse; ein Einrichtungs-WLAN hat das Gerät nicht.
     */
    public static final List<String> PFC200 = List.of(
            "zugaenge",
            "notfall_schluessel",
            "tunnel_status",
            "anmeldeprobe",
            "host_schluessel",
            "fenster_zu",
            "netze",
            "dienste_zu",
            "neustart",
            "update_bereit");

    /** Die Prüfliste eines Geräts ({@code pfc200}; jedes andere Wort: die Mango). */
    public static List<String> fuer(String geraet) {
        return WerkstattRegel.PFC200.equals(geraet) ? PFC200 : ALLE;
    }

    /** Was in {@code abgehakt} für das Gerät fehlt, in der Reihenfolge seiner Regel. */
    public static List<String> fehlend(String geraet, Collection<String> abgehakt) {
        return fuer(geraet).stream().filter(p -> !abgehakt.contains(p)).toList();
    }

    /** Kennungen, die es in der Liste des Geräts nicht gibt. */
    public static List<String> unbekannt(String geraet, Collection<String> abgehakt) {
        List<String> liste = fuer(geraet);
        return abgehakt.stream().filter(p -> !liste.contains(p)).distinct().sorted().toList();
    }

    /** Die jüngste Prüfung (PR #1885, S1); die einzige, die während der Übergangsfrist fehlen darf. */
    public static final String EINRICHTUNG_WLAN_BEREIT = "einrichtung_wlan_bereit";

    /**
     * Übergangsfrist für {@link #EINRICHTUNG_WLAN_BEREIT} (Entscheid des
     * Kapitäns vom 15.11.2026 zu PR #1885, vier Wochen): Der Werkstatt-Dienst
     * läuft auf einem eigenen Rechner in der Werkstatt und wird dort von Hand
     * aktualisiert, nicht automatisch wie die API. Bis zu diesem Zeitpunkt
     * nimmt die Abnahme eines Dienstes an, dem nur dieser eine Beleg fehlt
     * (alle anderen neun bleiben Pflicht), und kennzeichnet sie sichtbar als
     * "Dienst-Fassung vor Einrichtungs-WLAN". Danach gilt wieder die volle
     * Pflicht aus {@link #ALLE}.
     */
    public static final Instant EINRICHTUNG_WLAN_UEBERGANG_BIS = Instant.parse("2026-12-13T00:00:00Z");

    private WerkstattPruefungen() {
    }

    /** Was in {@code abgehakt} fehlt, in der Reihenfolge der Regel. */
    public static List<String> fehlend(Collection<String> abgehakt) {
        return ALLE.stream().filter(p -> !abgehakt.contains(p)).toList();
    }

    /** Kennungen, die es in der Liste nicht gibt. */
    public static List<String> unbekannt(Collection<String> abgehakt) {
        return abgehakt.stream().filter(p -> !ALLE.contains(p)).distinct().sorted().toList();
    }

    /**
     * Ob eine Abnahme mit genau diesen fehlenden Prüfungen innerhalb der
     * Übergangsfrist noch durchgeht: nur wenn ausschließlich
     * {@link #EINRICHTUNG_WLAN_BEREIT} fehlt und {@code jetzt} vor der Frist liegt.
     */
    public static boolean uebergangGilt(List<String> fehlend, Instant jetzt) {
        return fehlend.equals(List.of(EINRICHTUNG_WLAN_BEREIT)) && jetzt.isBefore(EINRICHTUNG_WLAN_UEBERGANG_BIS);
    }
}
