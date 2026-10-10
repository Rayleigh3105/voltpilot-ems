package com.voltpilot.api.uems;

/**
 * Der Weg eines Anteils-Dokuments zur Box (UEMS AP-15 IP-7, Y1): gespeichert (retained), QoS 1, auf ihrem eigenen
 * {@code v2}-Teilbaum. {@code false} = nicht zugestellt; der Aufrufer vermerkt dann nichts als gesendet.
 */
public interface VerbundAnteileVersand {

    boolean senden(String topic, byte[] nutzlast);
}
