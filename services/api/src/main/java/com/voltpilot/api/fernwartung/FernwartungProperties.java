package com.voltpilot.api.fernwartung;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Konfiguration der Fernwartung ({@code voltpilot.fernwartung.*}).
 *
 * <p>Die beiden Netze MÜSSEN mit der Konfiguration des Tunnel-Dienstes auf der
 * Wartungs-VM übereinstimmen ({@code VP_TUNNEL_BOX_NETZ},
 * {@code VP_TUNNEL_TECHNIKER_NETZ}); der Dienst verwirft einen Soll-Stand mit
 * abweichenden Netzen, statt ihn halb umzusetzen. Der Servername ist noch
 * offen (Entscheid vom 07.10.2026), also nur Vorgabe.
 *
 * <p>Ein Fehler hier bricht den Start ab: ein falsch geschnittenes Netz würde
 * Adressen vergeben, die der Dienst später ablehnt.
 *
 * @param boxNetz Teilnetz der Boxen, Server auf {@code .1}
 * @param technikerNetz Teilnetz der Techniker-Zugänge, Server auf {@code .1}
 * @param maxFensterDauer längstes Fernwartungsfenster (höchstens 7 Tage, die
 *     Grenze der Datenbank)
 * @param serverEndpunkt DNS-Name des Wartungsservers
 * @param serverPort UDP-Port der WireGuard-Schnittstelle dort
 * @param serverPublicKey öffentlicher Schlüssel des Servers; leer, solange die
 *     VM noch nicht steht
 */
@ConfigurationProperties(prefix = "voltpilot.fernwartung")
public record FernwartungProperties(
        String boxNetz,
        String technikerNetz,
        Duration maxFensterDauer,
        String serverEndpunkt,
        int serverPort,
        String serverPublicKey) {

    public static final Duration HARTE_GRENZE = Duration.ofDays(7);

    public FernwartungProperties {
        if (boxNetz == null || boxNetz.isBlank()) {
            boxNetz = "10.10.16.0/20";
        }
        if (technikerNetz == null || technikerNetz.isBlank()) {
            technikerNetz = "10.10.32.0/24";
        }
        if (maxFensterDauer == null) {
            maxFensterDauer = Duration.ofHours(24);
        }
        if (serverEndpunkt == null || serverEndpunkt.isBlank()) {
            serverEndpunkt = "wartung.voltpilot.de";
        }
        if (serverPort == 0) {
            serverPort = 51820;
        }
        serverPublicKey = serverPublicKey == null || serverPublicKey.isBlank() ? null : serverPublicKey.trim();

        Ipv4Netz box = Ipv4Netz.parse(boxNetz);
        Ipv4Netz techniker = Ipv4Netz.parse(technikerNetz);
        if (box.ueberschneidet(techniker)) {
            throw new IllegalArgumentException("voltpilot.fernwartung: Box-Netz " + box
                    + " und Techniker-Netz " + techniker + " überschneiden sich");
        }
        boxNetz = box.toString();
        technikerNetz = techniker.toString();
        if (maxFensterDauer.compareTo(Duration.ofMinutes(1)) < 0
                || maxFensterDauer.compareTo(HARTE_GRENZE) > 0) {
            throw new IllegalArgumentException(
                    "voltpilot.fernwartung.max-fenster-dauer muss zwischen 1 Minute und 7 Tagen liegen");
        }
        if (serverPort < 1 || serverPort > 65535) {
            throw new IllegalArgumentException("voltpilot.fernwartung.server-port ist kein Port: " + serverPort);
        }
        if (serverPublicKey != null && !WireguardSchluessel.gueltig(serverPublicKey)) {
            throw new IllegalArgumentException(
                    "voltpilot.fernwartung.server-public-key ist kein WireGuard-Schlüssel");
        }
    }

    public Ipv4Netz boxNetzwerk() {
        return Ipv4Netz.parse(boxNetz);
    }

    public Ipv4Netz technikerNetzwerk() {
        return Ipv4Netz.parse(technikerNetz);
    }
}
