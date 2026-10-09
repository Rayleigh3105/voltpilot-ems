package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.ResourceAccessException;

/**
 * Befund B2 der Produktionsprüfung (09.10.2026): der Rechte-Startlauf gab nach EINEM gescheiterten Versuch auf, bis
 * zum nächsten Neustart. Jetzt wiederholt er - nur die gescheiterten Kundenbereiche, mit wachsender Pause bis zur
 * Obergrenze, und endet beim Herunterfahren. Ohne Datenbank: die Kette mit echter Datenbank und {@code /me} prüft
 * {@code ZugriffBestandWiederholungApiTest}.
 */
class ZugriffBestandLaeuferWiederholungTest {

    private final UUID a = UUID.randomUUID();
    private final UUID b = UUID.randomUUID();
    private final UUID c = UUID.randomUUID();
    private final KeycloakAdminClient keycloak = mock(KeycloakAdminClient.class);
    private final ZugriffBestand bestand = mock(ZugriffBestand.class);
    private final JdbcTemplate adminJdbc = mock(JdbcTemplate.class);

    private ZugriffBestandLaeufer laeufer() {
        when(adminJdbc.queryForList(any(String.class), eq(UUID.class))).thenReturn(List.of(a, b, c));
        when(bestand.bestandAbschliessen(anyList(), any(String.class)))
                .thenReturn(new ZugriffBestand.Ergebnis(0, 0, 0, true));
        return new ZugriffBestandLaeufer(adminJdbc, keycloak, bestand, true);
    }

    @Test
    void nurAbgewieseneKundenbereicheKommenWiederDranMitWachsenderPauseBisZurObergrenze() throws Exception {
        AtomicInteger versuche = new AtomicInteger();
        when(keycloak.listUsersForTenant(any())).thenReturn(List.of());
        when(keycloak.listUsersForTenant(b)).thenAnswer(inv -> {
            if (versuche.incrementAndGet() <= 6) {
                throw new KeycloakAdminException(503, "Service Unavailable");
            }
            return List.of();
        });
        ZugriffBestandLaeufer laeufer = laeufer();
        List<Duration> pausen = new ArrayList<>();
        laeufer.pauseStellen(pausen::add);

        Thread lauf = laeufer.starten();
        lauf.join(Duration.ofSeconds(10));

        assertThat(lauf.isAlive()).as("nach dem gelungenen Versuch ist Schluss").isFalse();
        assertThat(pausen).containsExactly(Duration.ofSeconds(30), Duration.ofSeconds(60), Duration.ofSeconds(120),
                Duration.ofSeconds(240), Duration.ofMinutes(5), Duration.ofMinutes(5));
        verify(keycloak, times(7)).listUsersForTenant(b);
        // Ein gelungener Kundenbereich kommt nie ein zweites Mal dran.
        verify(keycloak, times(1)).listUsersForTenant(a);
        verify(keycloak, times(1)).listUsersForTenant(c);
        verify(bestand, times(3)).bestandAbschliessen(anyList(), eq(ZugriffBestand.HERKUNFT_LAUF));
        verify(adminJdbc, times(1)).queryForList(any(String.class), eq(UUID.class));
    }

    @Test
    void keycloakNichtErreichbarWiederholtGenauDenNichtErreichtenRest() throws Exception {
        AtomicInteger versuche = new AtomicInteger();
        when(keycloak.listUsersForTenant(any())).thenReturn(List.of());
        when(keycloak.listUsersForTenant(b)).thenAnswer(inv -> {
            if (versuche.incrementAndGet() == 1) {
                throw new ResourceAccessException("I/O error: Connection refused");
            }
            return List.of();
        });
        ZugriffBestandLaeufer laeufer = laeufer();
        List<Duration> pausen = new ArrayList<>();
        laeufer.pauseStellen(pausen::add);

        laeufer.starten().join(Duration.ofSeconds(10));

        assertThat(pausen).containsExactly(ZugriffBestandLaeufer.ERSTE_PAUSE);
        verify(keycloak, times(1)).listUsersForTenant(a);
        verify(keycloak, times(2)).listUsersForTenant(b);
        verify(keycloak, times(1)).listUsersForTenant(c);
    }

    @Test
    void einGescheiterterErsterLaufBeiDerDatenbankWiederholtAlleKundenbereiche() throws Exception {
        when(keycloak.listUsersForTenant(any())).thenReturn(List.of());
        ZugriffBestandLaeufer laeufer = laeufer();
        when(adminJdbc.queryForList(any(String.class), eq(UUID.class)))
                .thenThrow(new IllegalStateException("Datenbank kurz weg")).thenReturn(List.of(a, b, c));
        List<Duration> pausen = new ArrayList<>();
        laeufer.pauseStellen(pausen::add);

        laeufer.starten().join(Duration.ofSeconds(10));

        assertThat(pausen).containsExactly(ZugriffBestandLaeufer.ERSTE_PAUSE);
        verify(bestand, times(3)).bestandAbschliessen(anyList(), eq(ZugriffBestand.HERKUNFT_LAUF));
    }

    @Test
    void herunterfahrenBeendetEineWartendeWiederholung() throws Exception {
        when(keycloak.listUsersForTenant(any())).thenThrow(new ResourceAccessException("Connection refused"));
        ZugriffBestandLaeufer laeufer = laeufer(); // echte Pause: 30 s

        Thread lauf = laeufer.starten();
        verify(keycloak, timeout(5000)).listUsersForTenant(a);
        laeufer.beenden();
        lauf.join(Duration.ofSeconds(5));

        assertThat(lauf.isAlive()).isFalse();
        verify(keycloak, times(1)).listUsersForTenant(any());
        verify(bestand, never()).bestandAbschliessen(anyList(), any(String.class));
    }
}
