package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.DefaultResourceLoader;

/**
 * Der Partnerkatalog gegen die ECHTEN Dateien (PR #1999, {@code catalog/direktvermarkter/profiles/luox.json}),
 * verpackt über das {@code pom.xml}-Ressourcenziel {@code direktvermarkter/} - kein Testdouble.
 */
class PartnerKatalogTest {

    private final PartnerKatalog katalog = new PartnerKatalog(new DefaultResourceLoader(), new ObjectMapper());

    @Test
    void liestDasEchteLuoxProfilAusCatalogDirektvermarkter() {
        PartnerProfil luox = katalog.finde("luox");
        assertThat(luox).isNotNull();
        assertThat(luox.name()).isEqualTo("luox energy");
        assertThat(luox.vertrag().link())
                .startsWith("https://direktvermarktung.luox-energy.de/erloesrechner?spid=voltpilot");
        assertThat(katalog.alle()).extracting(PartnerProfil::partner).contains("luox");
    }
}
