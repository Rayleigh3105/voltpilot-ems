package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung der Rechte-Bestandsübernahme (UEMS AP-03 IP-2) — der Teil, den der Testcontainers-Lauf
 * ({@code ZugriffBestandTest} ruft {@code lauf()} und {@code beiAnlage} von Hand) nie anfasst: ein Schalter, der
 * in der AUSGELIEFERTEN Datei falsch vorbelegt ist, ist grün im Testlauf und wirkungslos im Cluster. Also: Vorgabe
 * AN in {@code application.yml}, AUS im Testlauf ({@code pom.xml}), der Not-Aus nimmt nur den Start-Lauf — und das
 * Anlage-Ereignis erreicht den Hörer.
 */
class ZugriffBestandWiringTest {

    private static final String SCHALTER = "voltpilot.uems.zugriff-bestand.enabled";

    /** Die Nachbarn, die der Läufer im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        static final UUID KUNDENBEREICH = UUID.randomUUID();
        static final ZugriffBestand BESTAND = mock(ZugriffBestand.class);
        static final KeycloakAdminClient KEYCLOAK = mock(KeycloakAdminClient.class);

        @Bean("adminJdbcTemplate")
        @SuppressWarnings("unchecked")
        JdbcTemplate adminJdbcTemplate() {
            JdbcTemplate jdbc = mock(JdbcTemplate.class);
            when(jdbc.queryForList(any(String.class), any(Class.class))).thenReturn(List.of(KUNDENBEREICH));
            return jdbc;
        }

        @Bean
        KeycloakAdminClient keycloakAdminClient() {
            return KEYCLOAK;
        }

        @Bean
        ZugriffBestand zugriffBestand() {
            return BESTAND;
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, ZugriffBestandLaeufer.class);

    @Test
    void derLaeuferVerdrahtetSichUndGehtImHintergrundUeberJedenKundenbereich() {
        reset(Nachbarn.BESTAND, Nachbarn.KEYCLOAK);
        List<KeycloakUser> konten = List.of(new KeycloakUser("kc-1", "demo", "demo@voltpilot.local", "Demo",
                "Operator", true, Nachbarn.KUNDENBEREICH.toString()));
        when(Nachbarn.KEYCLOAK.listUsersForTenant(Nachbarn.KUNDENBEREICH)).thenReturn(konten);
        when(Nachbarn.BESTAND.bestandAbschliessen(anyList(), any(String.class)))
                .thenReturn(new ZugriffBestand.Ergebnis(1, 1, 1, true));
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            context.getBean(ZugriffBestandLaeufer.class).beimStart();
            // Eine vollstaendige Liste schliesst den Bestand ab und setzt den Stichtag (Befund E12).
            verify(Nachbarn.BESTAND, timeout(5000)).bestandAbschliessen(konten, ZugriffBestand.HERKUNFT_LAUF);
            verify(Nachbarn.BESTAND, never()).uebernehmen(anyList());
        });
    }

    /**
     * Befund E12: der Stichtag sagt „dieser Bestand ist VOLLSTAENDIG uebernommen". Meldet Keycloak so viele Konten,
     * wie die Abfrage hoechstens holt, kann die Liste abgeschnitten sein — dann wird uebernommen, aber kein Stichtag
     * gesetzt: lieber die Regel einen Start laenger als ein ausgesperrtes Bestandskonto.
     */
    @Test
    void eineMoeglicherweiseAbgeschnitteneKontenlisteSetztKeinenStichtag() {
        reset(Nachbarn.BESTAND, Nachbarn.KEYCLOAK);
        List<KeycloakUser> randvoll = new ArrayList<>();
        for (int i = 0; i < KeycloakAdminClient.MAX_KONTEN_JE_KUNDENBEREICH; i++) {
            randvoll.add(new KeycloakUser("kc-" + i, "u" + i, "u" + i + "@voltpilot.local", "U", String.valueOf(i),
                    true, Nachbarn.KUNDENBEREICH.toString()));
        }
        when(Nachbarn.KEYCLOAK.listUsersForTenant(Nachbarn.KUNDENBEREICH)).thenReturn(randvoll);
        when(Nachbarn.BESTAND.uebernehmen(anyList()))
                .thenReturn(new ZugriffBestand.Ergebnis(randvoll.size(), 0, 0));
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            context.getBean(ZugriffBestandLaeufer.class).beimStart();
            verify(Nachbarn.BESTAND, timeout(5000)).uebernehmen(randvoll);
            verify(Nachbarn.BESTAND, never()).bestandAbschliessen(anyList(), any(String.class));
        });
    }

    /** Der Not-Aus nimmt den Start-Lauf, nie den Dienst und nie das Anlage-Ereignis. */
    @Test
    void derNotAusNimmtDenStartLaufNieDasAnlageEreignis() {
        reset(Nachbarn.BESTAND, Nachbarn.KEYCLOAK);
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(ZugriffBestandLaeufer.class);
            context.getBean(ZugriffBestandLaeufer.class).beimStart();
            verify(Nachbarn.KEYCLOAK, after(300).never()).listUsersForTenant(any());
            verify(Nachbarn.BESTAND, never()).uebernehmen(anyList());
            verify(Nachbarn.BESTAND, never()).bestandAbschliessen(anyList(), any(String.class));

            KundenbenutzerAngelegt ereignis = new KundenbenutzerAngelegt(Nachbarn.KUNDENBEREICH, new KeycloakUser(
                    "kc-2", "neu@example.de", "neu@example.de", null, null, true, Nachbarn.KUNDENBEREICH.toString()));
            context.publishEvent(ereignis);
            verify(Nachbarn.BESTAND).beiAnlage(ereignis);
        });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN — und im Testlauf AUS: sonst ginge jeder Testkontext beim Start gegen ein
     * Keycloak, das es dort nicht gibt.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "uems", "zugriff-bestand", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_ZUGRIFF_BESTAND_ENABLED:true}");

        String pom = Files.readString(Path.of("pom.xml"));
        assertThat(pom).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... pfad) {
        Object knoten = yml;
        for (String schluessel : pfad) {
            knoten = ((Map<String, Object>) knoten).get(schluessel);
        }
        return knoten;
    }
}
