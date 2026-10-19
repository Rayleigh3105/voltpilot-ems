package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.mail.MailSendException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Einstellungen Scheibe 2 (Konzept-Bericht §4.12, Entscheid 10A): "Probe senden" je Weg, Team-Kanal
 * bearbeiten, ein doppelt verbundenes Ziel als sauberer Fehler statt eines rohen 500 (B11), und der
 * Telegram-Versuch, der sich selbst wiederverwendet (B10). Rein - Repository und Adapter gemockt, ohne
 * Spring-Kontext, ohne Datenbank; {@link WebhookVersandAdapter} ist der ECHTE öffentliche Adapter (sein
 * SSRF-Schutz soll gerade wirken), die übrigen Adapter sind Mocks, damit kein echter Versand stattfindet.
 */
class ZustellwegServiceScheibe2Test {

    private final ZustellwegRepository repo = mock(ZustellwegRepository.class);
    private final VersandRepository ausgang = mock(VersandRepository.class);
    private final TelegramAdapter telegram = mock(TelegramAdapter.class);
    private final EmailVersandAdapter email = mock(EmailVersandAdapter.class);
    private final WebPushAdapter push = mock(WebPushAdapter.class);
    private final WebhookVersandAdapter webhook = mock(WebhookVersandAdapter.class);
    private ZustellwegService dienst;

    @BeforeEach
    void aufbauen() {
        dienst = new ZustellwegService(repo, ausgang, telegram, email, push, webhook, "http://localhost:5173",
                "bot-name", "bot-token");
    }

    // --------------------------------------------------------------------- E-Mail: Probe (Entscheid 10A)

    @Test
    void emailProbeOhneBestaetigteAdresseWirftEinenSauberenKonflikt() {
        when(repo.eigener("sub")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> dienst.emailProbeSenden("sub")).isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("bestätigte E-Mail-Adresse");
        verifyNoInteractions(email);
    }

    @Test
    void emailProbeMitBestaetigterAdresseRuftDenAdapterAuf() {
        var weg = new ZustellwegRepository.Zustellweg(UUID.randomUUID(), "jonas@example.test", Instant.now(), true,
                "warnung", false, null);
        when(repo.eigener("sub")).thenReturn(Optional.of(weg));

        ZustellwegService.ProbeErgebnis ergebnis = dienst.emailProbeSenden("sub");

        assertThat(ergebnis.erfolgreich()).isTrue();
        verify(email).senden(eq("jonas@example.test"), anyString(), anyString());
    }

    @Test
    void einFehlgeschlagenerEmailVersandWirdAlsErgebnisGemeldetNichtGeworfen() {
        var weg = new ZustellwegRepository.Zustellweg(UUID.randomUUID(), "jonas@example.test", Instant.now(), true,
                "warnung", false, null);
        when(repo.eigener("sub")).thenReturn(Optional.of(weg));
        doThrow(new MailSendException("SMTP weg")).when(email).senden(any(), any(), any());

        ZustellwegService.ProbeErgebnis ergebnis = dienst.emailProbeSenden("sub");

        assertThat(ergebnis.erfolgreich()).isFalse();
        assertThat(ergebnis.fehler()).contains("SMTP weg");
    }

    // --------------------------------------------------------------------- Push: Probe, Umbenennen

    @Test
    void pushProbeOhneEigenesGeraetWirft404() {
        UUID id = UUID.randomUUID();
        when(repo.pushAboFuerProbe(id, "sub")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> dienst.pushProbeSenden(id, "sub")).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(push);
    }

    @Test
    void pushProbeMitEigenemGeraetRuftDenAdapterAuf() {
        UUID id = UUID.randomUUID();
        var abo = new WebPushAdapter.Abo("https://push.example/geraet-x", "p256dh", "auth");
        when(repo.pushAboFuerProbe(id, "sub")).thenReturn(Optional.of(abo));

        ZustellwegService.ProbeErgebnis ergebnis = dienst.pushProbeSenden(id, "sub");

        assertThat(ergebnis.erfolgreich()).isTrue();
        verify(push).senden(eq(abo), anyString());
    }

    @Test
    void geraetUmbenennenReichtDenNamenAnDasRepositoryWeiter() {
        UUID id = UUID.randomUUID();
        when(repo.pushAboNameSetzen(id, "sub", "iPhone von Ines")).thenReturn(true);

        assertThat(dienst.pushAboNameSetzen(id, "sub", "iPhone von Ines")).isTrue();
    }

    // --------------------------------------------------------------------- Webhook: Probe, Bearbeiten, B11

    @Test
    void webhookProbeVorAnlegenLehntEinUnsicheresZielAbOhneDenAdapterZuRufen() {
        ZustellwegService.ProbeErgebnis ergebnis = dienst.webhookProbeVorAnlegen("http://localhost/intern");

        assertThat(ergebnis.erfolgreich()).isFalse();
        verifyNoInteractions(webhook);
    }

    @Test
    void webhookProbeSendenRuftDenAdapterAufFuerDasEigeneZielMitGeheimnis() {
        UUID id = UUID.randomUUID();
        var ziel = new ZustellwegRepository.WebhookZiel(id, "https://teams.example/hook", "geheim-123");
        when(repo.webhookZielMitGeheimnisEigen(id, "sub")).thenReturn(Optional.of(ziel));

        ZustellwegService.ProbeErgebnis ergebnis = dienst.webhookProbeSenden(id, "sub");

        assertThat(ergebnis.erfolgreich()).isTrue();
        verify(webhook).senden(eq("https://teams.example/hook"), eq("geheim-123"), anyString());
    }

    /** 93.184.216.34 ist eine literale, öffentliche Adresse (example.com) - wie {@code WebhookZielPruefungTest}: kein DNS nötig. */
    private static final String SICHERE_URL = "https://93.184.216.34/hook";

    @Test
    void webhookZielAnlegenMeldetEineDoppelteAdresseAlsSauberen409StattEinesRohen500() {
        when(repo.webhookZielAnlegen(any(), any(), any(), any())).thenThrow(new DuplicateKeyException("doppelt"));

        assertThatThrownBy(() -> dienst.webhookZielAnlegen("sub", SICHERE_URL, "Team"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("schon verbunden");
    }

    @Test
    void webhookZielBearbeitenMeldetEineDoppelteAdresseEbenfallsAls409() {
        UUID id = UUID.randomUUID();
        when(repo.webhookZielBearbeiten(any(), any(), any(), any())).thenThrow(new DuplicateKeyException("doppelt"));

        assertThatThrownBy(() -> dienst.webhookZielBearbeiten(id, "sub", SICHERE_URL, "Team"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("schon verbunden");
    }

    @Test
    void webhookZielBearbeitenPruefreDasZielSsrfWieBeimAnlegen() {
        UUID id = UUID.randomUUID();

        assertThatThrownBy(() -> dienst.webhookZielBearbeiten(id, "sub", "http://localhost/intern", "Team"))
                .isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(repo); // die Prüfung scheitert, bevor überhaupt geschrieben wird
    }

    // --------------------------------------------------------------------- Telegram: B10, Probe

    @Test
    void telegramVerbindungAnfordernErneuertEinenBestehendenOffenenVersuchStattEinerNeuenZeile() {
        UUID offenerVersuch = UUID.randomUUID();
        when(repo.telegramOffenerVersuch("sub")).thenReturn(Optional.of(offenerVersuch));

        dienst.telegramVerbindungAnfordern("sub");

        verify(repo).telegramVersuchErneuern(eq(offenerVersuch), anyString(), any());
        verify(repo, never()).telegramVerbindungAnfordern(any(), any(), any());
    }

    @Test
    void telegramVerbindungAnfordernLegtOhneOffenenVersuchEineNeueZeileAn() {
        when(repo.telegramOffenerVersuch("sub")).thenReturn(Optional.empty());

        dienst.telegramVerbindungAnfordern("sub");

        verify(repo).telegramVerbindungAnfordern(eq("sub"), anyString(), any());
        verify(repo, never()).telegramVersuchErneuern(any(), any(), any());
    }

    @Test
    void telegramVerbindungBestaetigenFaengtEinenDoppeltenChatAbStattZuScheitern() {
        when(repo.telegramVerbindungBestaetigen(any(), any(), any())).thenThrow(new DuplicateKeyException("doppelt"));

        boolean bestaetigt = dienst.telegramVerbindungBestaetigen("tok", "chat-1");

        assertThat(bestaetigt).isFalse();
        verifyNoInteractions(telegram); // keine Bestätigungs-Nachricht an einen Chat, der nicht verbunden wurde
    }

    @Test
    void telegramProbeSendenRuftDenAdapterAufFuerDieEigeneVerbindung() {
        UUID id = UUID.randomUUID();
        when(repo.telegramZielMitChatEigen(id, "sub"))
                .thenReturn(Optional.of(new ZustellwegRepository.TelegramZiel(id, "chat-42")));

        ZustellwegService.ProbeErgebnis ergebnis = dienst.telegramProbeSenden(id, "sub");

        assertThat(ergebnis.erfolgreich()).isTrue();
        verify(telegram).senden(eq("chat-42"), anyString());
    }
}
