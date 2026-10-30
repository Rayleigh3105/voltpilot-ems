package com.voltpilot.api.geraetesuche;

/**
 * Der Weg eines Gerätesuche-Auftrags zur Box ({@code docs/contracts/v2/mqtt-geraetesuche.md} §1): NICHT gespeichert
 * (kein retained — ein Einmal-Auftrag darf nach einem Wiederverbinden nie ein zweites Mal laufen), QoS 1, auf seinem
 * eigenen {@code v2}-Topic. {@code false} = nicht zugestellt; der Aufrufer legt dann keine Suche an.
 */
public interface GeraetesucheVersand {

    boolean senden(String topic, byte[] nutzlast);
}
