package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.yaml.snakeyaml.Yaml;

class UebergabeWiringTest {
    static final String FLAG="voltpilot.uems.uebergabe.enabled";
    static final Instant A3=Instant.parse("2027-04-10T05:30:00Z");
    UebergabeAufgaben aufgaben=mock(UebergabeAufgaben.class);
    EntityRegistryService registry=mock(EntityRegistryService.class);
    ApplicationContextRunner runner=new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withBean(QuellenUebergabe.class,()->mock(QuellenUebergabe.class))
            .withBean(UebergabeAufgaben.class,()->aufgaben)
            .withBean(EntityRegistryService.class,()->registry)
            .withBean(Clock.class,()->Clock.fixed(A3,ZoneOffset.UTC))
            .withPropertyValues("voltpilot.uems.uebergabe.initial-delay-ms=3600000")
            .withUserConfiguration(UebergabeLaeufer.class,UebergabeSchedulingConfig.class);

    @Test void anFuehrtFaelligeAnlagenMitFakeUhrUnterIhremMandantenAus() {
        UUID tenant=UUID.randomUUID(), site=UUID.randomUUID(), vorher=UUID.randomUUID();
        when(aufgaben.faellig(A3)).thenReturn(List.of(new UebergabeAufgaben.Anlage(tenant,site)));
        doAnswer(call->{assertThat(TenantContext.get()).isEqualTo(tenant);return null;})
                .when(registry).pushRegistryBestEffort(site,A3);
        runner.withPropertyValues(FLAG+"=true").run(c->{
            assertThat(c).hasSingleBean(UebergabeLaeufer.class).hasSingleBean(UebergabeSchedulingConfig.class);
            TenantContext.set(vorher);
            try {
                c.getBean(UebergabeLaeufer.class).takt();
                verify(registry).pushRegistryBestEffort(site,A3);
                assertThat(TenantContext.get()).isEqualTo(vorher);
            } finally { TenantContext.clear(); }
        });
    }
    @Test void ausHatKeinenZeitgeber() {
        runner.withPropertyValues(FLAG+"=false").run(c->{
            assertThat(c).doesNotHaveBean(UebergabeLaeufer.class).doesNotHaveBean(UebergabeSchedulingConfig.class);
            verifyNoInteractions(aufgaben);
        });
    }
    @Test @SuppressWarnings("unchecked") void prodAnTestsAusInDenAusgeliefertenDateien() throws Exception {
        Map<String,Object> yml=(Map<String,Object>) new Yaml().loadAll(getClass().getResourceAsStream("/application.yml")).iterator().next();
        var vp=(Map<String,Object>) yml.get("voltpilot"); var uems=(Map<String,Object>) vp.get("uems");
        var uebergabe=(Map<String,Object>) uems.get("uebergabe");
        assertThat(uebergabe.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_UEBERGABE_ENABLED:true}");
        assertThat(uebergabe.get("interval-ms")).isEqualTo("${VOLTPILOT_UEMS_UEBERGABE_INTERVAL_MS:1000}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<"+FLAG+">false</"+FLAG+">");
    }
}
