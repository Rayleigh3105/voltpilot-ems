package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * Die Jackson-Zuordnung eines Partnerprofils (Konzept vp-direktvermarktung-konzept d2 §5.3) auf den Teil, den Cloud
 * und Portal in dieser Stufe lesen - unbekannte Felder (Register, Regeln, Einrichtung) müssen den Katalog-Lauf nicht
 * aufhalten, sie sind Sache der Box bzw. eines späteren Werkzeugs.
 */
class PartnerProfilTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Das Beispielprofil aus dem Konzept, Abschnitt 5.3 - gekürzt auf die Felder dieser Klasse plus Fremdfelder. */
    private static final String LUOX_PROFIL = """
            {
              "partner": "luox",
              "name": "luox energy",
              "fassung": "2026-06-02",
              "zugang": { "art": "vpn_modbus_server" },
              "register": [ { "tabelle": "input", "adresse": 0 } ],
              "regeln": { "lebenszeichen_frist_s": 900 },
              "vertrag": {
                "link": "https://direktvermarktung.luox-energy.de/erloesrechner?spid=voltpilot",
                "kennung": "spid=voltpilot",
                "ziel": "erloesrechner_mit_abschluss"
              },
              "einrichtung": { "vorher": ["vertrag_frage"] },
              "groessenklassen": [ { "ueber_kw": 25, "fernsteuerung": true } ]
            }
            """;

    @Test
    void liestDieFuerCloudUndPortalNoetigenFelderUndIgnoriertDenRest() throws Exception {
        PartnerProfil p = JSON.readValue(LUOX_PROFIL, PartnerProfil.class);
        assertThat(p.partner()).isEqualTo("luox");
        assertThat(p.name()).isEqualTo("luox energy");
        assertThat(p.fassung()).isEqualTo("2026-06-02");
        assertThat(p.vertrag().link())
                .isEqualTo("https://direktvermarktung.luox-energy.de/erloesrechner?spid=voltpilot");
        assertThat(p.vertrag().kennung()).isEqualTo("spid=voltpilot");
        assertThat(p.anzeigename()).isEqualTo("luox energy");
    }

    @Test
    void anzeigenameFaelltAufDenPartnerSchluesselZurueckOhneNamen() throws Exception {
        PartnerProfil p = JSON.readValue("{\"partner\": \"neu\"}", PartnerProfil.class);
        assertThat(p.anzeigename()).isEqualTo("neu");
        assertThat(p.vertrag()).isNull();
    }
}
