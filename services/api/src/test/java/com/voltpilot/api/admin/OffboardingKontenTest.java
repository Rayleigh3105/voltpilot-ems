package com.voltpilot.api.admin;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffAenderung;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.web.server.ResponseStatusException;

class OffboardingKontenTest {
    private final UUID tenant = UUID.randomUUID();
    private final KeycloakAdminClient keycloak = mock(KeycloakAdminClient.class);
    private final ZugriffRepository zugriffe = mock(ZugriffRepository.class);
    private final ZugriffAenderung aenderung = mock(ZugriffAenderung.class);
    private final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    private final TransactionStatus transaction = mock(TransactionStatus.class);
    private final AdminBenutzerService service = new AdminBenutzerService(keycloak, zugriffe, aenderung, transactions);

    @BeforeEach void anmelden() {
        when(transactions.getTransaction(any())).thenReturn(transaction);
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject("platform")
                .claim("preferred_username", "Plattform").build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
    }

    @AfterEach void aufraeumen() {
        SecurityContextHolder.clearContext();
        TenantContext.clear();
        ZugriffContext.clear();
    }

    @Test void eineMoeglicherweiseAbgeschnitteneListeSperrtUndLoeschtNichts() {
        when(keycloak.listUsersForTenant(tenant)).thenReturn(Collections.nCopies(
                KeycloakAdminClient.MAX_KONTEN_JE_KUNDENBEREICH, konto("eins")));
        assertThatThrownBy(() -> service.offboardingSperren(tenant)).isInstanceOf(ResponseStatusException.class);
        verify(aenderung, never()).kundenbereichSperren(anyList(), any());
        verify(keycloak, never()).setEnabled(anyString(), anyBoolean());
        verifyNoInteractions(zugriffe);
        verify(transactions).rollback(transaction);
    }

    @Test void einFehlerBeimZweitenKontoRolltDieLokaleTransaktionZurueckUndLoeschtKeines() {
        when(keycloak.listUsersForTenant(tenant)).thenReturn(List.of(konto("eins"), konto("zwei")));
        doThrow(new IllegalStateException("upstream failure")).when(keycloak).setEnabled("zwei", false);
        assertThatThrownBy(() -> service.offboardingSperren(tenant)).isInstanceOf(IllegalStateException.class);
        var order = inOrder(aenderung, keycloak, transactions);
        order.verify(aenderung).kundenbereichSperren(eq(List.of("eins", "zwei")), any());
        order.verify(keycloak).setEnabled("eins", false);
        order.verify(keycloak).setEnabled("zwei", false);
        order.verify(transactions).rollback(transaction);
        verify(keycloak, never()).setEnabled(anyString(), eq(true));
        verify(keycloak, never()).deleteUser(anyString());
    }

    private KeycloakUser konto(String sub) {
        return new KeycloakUser(sub, sub, sub + "@example.test", null, null, true, tenant.toString());
    }
}
