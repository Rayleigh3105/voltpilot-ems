package com.voltpilot.api.uems;

/**
 * Der Weg eines Sprungprobe-Auftrags zur Box (UEMS AP-15 IP-21): NICHT gespeichert (kein retained — ein Auftrag darf
 * nach einem Wiederverbinden nie ein zweites Mal laufen), QoS 1, auf ihrem eigenen {@code v2}-Teilbaum.
 * {@code false} = nicht zugestellt; der Aufrufer legt dann kein Protokoll an.
 */
public interface SprungprobeVersand {

    boolean senden(String topic, byte[] nutzlast);
}
