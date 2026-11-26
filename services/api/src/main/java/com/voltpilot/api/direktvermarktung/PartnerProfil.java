package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Der Teil eines Partnerprofils ({@code catalog/direktvermarkter/<partner>.json}, Konzept
 * vp-direktvermarktung-konzept d2 §5.3), den Cloud und Portal in dieser Stufe brauchen: wie der
 * Partner heißt und wohin sein eigener Vertragslink führt. Die Box-seitigen Teile (Zugang, Register,
 * Regeln) liest nur der Go-Kern; das Profil selbst ist Daten, kein Code (E6 = A).
 *
 * <p>Unbekannte Felder werden ignoriert, statt den Katalog-Lauf scheitern zu lassen: ein Partner trägt
 * mehr, als Cloud und Portal heute lesen (Register, Vokabular, Einrichtungsschritte) - das bleibt Sache
 * der Box und, später, des eigenen Validierungswerkzeugs (Muster {@code catalog/control-profiles}).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PartnerProfil(String partner, String name, String fassung, Vertrag vertrag) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Vertrag(String link, String kennung, String ziel) {}

    /** Für die Anzeige im Katalog: niemals {@code null}, auch wenn das Profil (noch) unvollständig ist. */
    public String anzeigename() {
        return name != null && !name.isBlank() ? name : partner;
    }
}
