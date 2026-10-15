package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;

/**
 * Der Zusteller rein (keine Datenbank, kein SMTP) - wer eine Zeile bekommt, wie sie aufgelöst, versandt
 * und nachgewirkt wird (Alerting Scheibe 0). Die eigentliche Zustellung prüft {@link ZustellungGreenMailIT}
 * gegen einen echten SMTP-Fänger; dieser Test prüft die Entscheidungen drumherum.
 */
class ZustellerTest {

    private static final UUID TENANT = UUID.randomUUID();

    private final VersandRepository ausgang = mock(VersandRepository.class);
    private final ZustellwegRepository zustellwege = mock(ZustellwegRepository.class);
    private final EmailVersandAdapter email = mock(EmailVersandAdapter.class);
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final Zusteller zusteller = new Zusteller(ausgang, zustellwege, email, jdbc);

    private static VersandRepository.Zeile zeile(String quelle, UUID quelleId, String ziel) {
        return new VersandRepository.Zeile(UUID.randomUUID(), TENANT, quelle, quelleId, "sub-jonas", "email",
                "notfall", 0, ziel, "Betreff", "Inhalt", 0);
    }

    @Test
    void erfolgreicherVersandTraegtDieUnterstuetzungsNachwirkungNach() {
        UUID hinweisId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("unterstuetzung_hinweis", hinweisId, "ziel-direkt@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(1);
        verify(email).senden("ziel-direkt@example.test", "Betreff", "Inhalt");
        verify(ausgang).gesendet(eq(z.id()), any());
        verify(jdbc).update(anyString(), any(), eq(hinweisId), eq(TENANT));
    }

    @Test
    void andereQuelleBekommtKeineNachwirkung() {
        VersandRepository.Zeile z = zeile("zustellweg_bestaetigung", UUID.randomUUID(), "ziel@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));

        zusteller.lauf(Instant.now());

        verify(jdbc, never()).update(anyString(), any(), any(), any());
    }

    @Test
    void ohneZielOderBestaetigtenZustellwegWirdUnterdrueckt() {
        VersandRepository.Zeile z = zeile("unterstuetzung_hinweis", UUID.randomUUID(), null);
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        when(zustellwege.bestaetigtesZiel(TENANT, "sub-jonas")).thenReturn(Optional.empty());

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).unterdrueckt(z.id(), "kein_weg");
        verify(email, never()).senden(any(), any(), any());
    }

    @Test
    void einFehlgeschlagenerVersandBleibtWartenBisZurObergrenze() {
        VersandRepository.Zeile z = zeile("unterstuetzung_hinweis", UUID.randomUUID(), "ziel@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        doThrow(new MailSendException("SMTP weg")).when(email).senden(any(), any(), any());

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).fehlgeschlagen(eq(z.id()), anyString(), any(), eq(Zusteller.HOECHSTVERSUCHE));
        verify(ausgang, never()).gesendet(any(), any());
    }

    private static int anyInt() {
        return org.mockito.ArgumentMatchers.anyInt();
    }
}
