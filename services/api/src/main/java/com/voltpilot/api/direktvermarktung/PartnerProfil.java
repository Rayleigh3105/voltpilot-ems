package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * Der Teil eines Partnerprofils ({@code catalog/direktvermarkter/<partner>.json}, Konzept
 * vp-direktvermarktung-konzept d2 §5.3), den Cloud und Portal in dieser Stufe brauchen: wie der
 * Partner heißt, wohin sein eigener Vertragslink führt und welche VPN-Gegenstellen eine Zugangsdatei
 * nennen darf. Die Box-seitigen Teile (Register, Regeln) liest nur der Go-Kern; das Profil selbst ist
 * Daten, kein Code (E6 = A).
 *
 * <p>Unbekannte Felder werden ignoriert, statt den Katalog-Lauf scheitern zu lassen: ein Partner trägt
 * mehr, als Cloud und Portal heute lesen (Register, Vokabular, Einrichtungsschritte) - das bleibt Sache
 * der Box und, später, des eigenen Validierungswerkzeugs (Muster {@code catalog/control-profiles}).
 *
 * <p>{@code zugang} ist WRITE_ONLY: der Dienst liest daraus die Gegenstellen-Schranke für den
 * Zugangsdatei-Upload ({@link ZugangsdateiOeffner}), aber keine Katalog- oder Statusantwort trägt sie
 * nach außen - der Kunde braucht sie nicht, und Infrastruktur-Hosts gehören nicht in jede Antwort.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PartnerProfil(String partner, String name, String fassung, Vertrag vertrag,
        @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) Zugang zugang) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Vertrag(String link, String kennung, String ziel) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Zugang(Vpn vpn) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Vpn(List<String> gegenstellen) {}

    /** Für die Anzeige im Katalog: niemals {@code null}, auch wenn das Profil (noch) unvollständig ist. */
    public String anzeigename() {
        return name != null && !name.isBlank() ? name : partner;
    }

    /** Die erlaubten VPN-Gegenstellen ({@code zugang.vpn.gegenstellen}); leer = keine Schranke, nie {@code null}. */
    public List<String> vpnGegenstellen() {
        if (zugang == null || zugang.vpn() == null || zugang.vpn().gegenstellen() == null) return List.of();
        return zugang.vpn().gegenstellen();
    }
}
