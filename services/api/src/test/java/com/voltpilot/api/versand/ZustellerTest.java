package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.versand.webpush.WebPushAdapter;
import com.voltpilot.api.versand.webpush.WebPushException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;

/**
 * Der Zusteller rein (keine Datenbank, kein SMTP, kein echter Push-Dienst) - wer eine Zeile bekommt,
 * wie sie aufgelöst, versandt und nachgewirkt wird (Alerting Scheibe 0/1/3). Die eigentliche
 * Zustellung prüft {@link ZustellungGreenMailIT} gegen einen echten SMTP-Fänger; dieser Test prüft
 * die Entscheidungen drumherum.
 */
class ZustellerTest {

    private static final UUID TENANT = UUID.randomUUID();

    private final VersandRepository ausgang = mock(VersandRepository.class);
    private final ZustellwegRepository zustellwege = mock(ZustellwegRepository.class);
    private final EmailVersandAdapter email = mock(EmailVersandAdapter.class);
    private final WebPushAdapter push = mock(WebPushAdapter.class);
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final Zusteller zusteller = new Zusteller(ausgang, zustellwege, email, push, jdbc);

    private static VersandRepository.Zeile zeile(String quelle, UUID quelleId, String ziel) {
        return zeile(quelle, quelleId, "email", ziel, null);
    }

    private static VersandRepository.Zeile zeile(String quelle, UUID quelleId, String weg, String ziel,
            String schwere) {
        return new VersandRepository.Zeile(UUID.randomUUID(), TENANT, quelle, quelleId, "sub-jonas", weg,
                "ausgeloest", 0, ziel, "Betreff", "Inhalt", 0, schwere, null);
    }

    /** Trägt ihr eigenes {@code ziel} (wie jede Alarm-Zeile mit Stufe "warnung") - braucht darum
     * einen aktiven Zustellweg dieser Stufe ({@code zustellwege.hatAktivenEmailWeg}, siehe
     * {@link #gebuendelteZeile}-Tests, die das pauschal auf {@code true} stellen). */
    private static VersandRepository.Zeile gebuendelteZeile(UUID quelleId, String buendelSchluessel, String inhalt) {
        return new VersandRepository.Zeile(UUID.randomUUID(), TENANT, "alarm", quelleId, "sub-jonas", "email",
                "ausgeloest", 0, "warnung@example.test", "Betreff " + inhalt, inhalt, 0, "warnung",
                buendelSchluessel);
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

    @Test
    void alarmOhneSichtWirdUnterdrueckt() {
        UeberwachungSichtPruefung sicht = mock(UeberwachungSichtPruefung.class);
        zusteller.setSicht(sicht);
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "warnung@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        when(sicht.sichtbar(eq(alarmId), eq("sub-jonas"), any())).thenReturn(false);

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).unterdrueckt(z.id(), "keine_sicht");
        verify(email, never()).senden(any(), any(), any());
    }

    @Test
    void alarmInRuhezeitWirdVerschobenStattSofortGesendet() {
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "warnung@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        Instant jetzt = Instant.now();
        Instant ruhezeitEnde = jetzt.plusSeconds(3600);
        RuhezeitPruefung ruhezeit = (id, sub, weg, anlass, j) -> ruhezeitEnde;
        zusteller.setRuhezeit(ruhezeit);

        int gesendet = zusteller.lauf(jetzt);

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).verschieben(z.id(), ruhezeitEnde);
        verify(email, never()).senden(any(), any(), any());
    }

    @Test
    void alarmEndgueltigUnterdruecktDurchRuhezeitWirdAlsStummVerbucht() {
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "warnung@example.test");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        zusteller.setRuhezeit((id, sub, weg, anlass, j) -> Instant.MAX);

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).unterdrueckt(z.id(), "stumm");
        verify(ausgang, never()).verschieben(any(), any());
    }

    @Test
    void pushFaechertAufAlleAktivenAbosAufUndGiltAlsErfolgBeiMindestensEinem() {
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "webpush", null, "dringend");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        WebPushAdapter.Abo abo1 = new WebPushAdapter.Abo("https://push.example/1", "p1", "a1");
        WebPushAdapter.Abo abo2 = new WebPushAdapter.Abo("https://push.example/2", "p2", "a2");
        when(zustellwege.pushAbosFuerVersand(TENANT, "sub-jonas", "dringend")).thenReturn(List.of(abo1, abo2));
        doThrow(new WebPushException(500, "vorübergehend")).when(push).senden(eq(abo1), any());

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(1);
        verify(push).senden(eq(abo2), any());
        verify(ausgang).gesendet(eq(z.id()), any());
        verify(zustellwege, never()).pushAboAlsAbgelaufenMarkieren(any(), any());
    }

    @Test
    void abgelaufenesPushAboWirdAufgeraeumtOhneDenGesamtversandZuBlockieren() {
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "webpush", null, "warnung");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        WebPushAdapter.Abo veraltet = new WebPushAdapter.Abo("https://push.example/veraltet", "p", "a");
        when(zustellwege.pushAbosFuerVersand(TENANT, "sub-jonas", "warnung")).thenReturn(List.of(veraltet));
        doThrow(new WebPushException(410, "Gone")).when(push).senden(eq(veraltet), any());

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(zustellwege).pushAboAlsAbgelaufenMarkieren(eq("https://push.example/veraltet"), any());
        verify(ausgang).fehlgeschlagen(eq(z.id()), anyString(), any(), eq(Zusteller.HOECHSTVERSUCHE));
    }

    @Test
    void pushOhneJedesAktivesAboWirdUnterdrueckt() {
        UUID alarmId = UUID.randomUUID();
        VersandRepository.Zeile z = zeile("alarm", alarmId, "webpush", null, "dringend");
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z));
        when(zustellwege.pushAbosFuerVersand(TENANT, "sub-jonas", "dringend")).thenReturn(List.of());

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        verify(ausgang).unterdrueckt(z.id(), "kein_weg");
    }

    private static int anyInt() {
        return org.mockito.ArgumentMatchers.anyInt();
    }

    // =================================================================== Scheibe 4: Bündeln (§6.4 Nr. 6)

    @Test
    void zweiZeilenMitDemselbenBuendelSchluesselWerdenZuEinerNachrichtZusammengefasst() {
        VersandRepository.Zeile z1 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 1 über 120 kW");
        VersandRepository.Zeile z2 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 2 über 120 kW");
        when(zustellwege.hatAktivenEmailWeg(any(), any(), any())).thenReturn(true);
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z1, z2));

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(2); // beide Zeilen bekommen ihr eigenes Versandergebnis (§6.1 Nr. 10)
        ArgumentCaptor<String> inhalt = ArgumentCaptor.forClass(String.class);
        verify(email, times(1)).senden(eq("warnung@example.test"), anyString(), inhalt.capture());
        assertThat(inhalt.getValue()).contains("Halle 1 über 120 kW").contains("Halle 2 über 120 kW");
        verify(ausgang).gesendet(eq(z1.id()), any());
        verify(ausgang).gesendet(eq(z2.id()), any());
    }

    @Test
    void nurDieSichtbarenZeilenGehenInDieGebuendelteNachricht() {
        UeberwachungSichtPruefung sicht = mock(UeberwachungSichtPruefung.class);
        zusteller.setSicht(sicht);
        UUID unsichtbareId = UUID.randomUUID();
        VersandRepository.Zeile z1 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 1 über 120 kW");
        VersandRepository.Zeile z2 = gebuendelteZeile(unsichtbareId, "regel-x:ausgeloest:100", "Halle 2 über 120 kW");
        VersandRepository.Zeile z3 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 3 über 120 kW");
        when(zustellwege.hatAktivenEmailWeg(any(), any(), any())).thenReturn(true);
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z1, z2, z3));
        when(sicht.sichtbar(any(), eq("sub-jonas"), any())).thenReturn(true);
        when(sicht.sichtbar(eq(unsichtbareId), eq("sub-jonas"), any())).thenReturn(false);

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(2); // nur z1 und z3 - z2 sieht dieser Empfänger nicht (§6.6)
        ArgumentCaptor<String> inhalt = ArgumentCaptor.forClass(String.class);
        verify(email, times(1)).senden(eq("warnung@example.test"), anyString(), inhalt.capture());
        assertThat(inhalt.getValue()).contains("Halle 1 über 120 kW").contains("Halle 3 über 120 kW")
                .doesNotContain("Halle 2 über 120 kW");
        verify(ausgang).unterdrueckt(z2.id(), "keine_sicht");
    }

    @Test
    void bleibtNachDerSichtPruefungNurEineZeileUebrigSendetSieEinzeln() {
        UeberwachungSichtPruefung sicht = mock(UeberwachungSichtPruefung.class);
        zusteller.setSicht(sicht);
        UUID unsichtbareId = UUID.randomUUID();
        VersandRepository.Zeile z1 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 1 über 120 kW");
        VersandRepository.Zeile z2 = gebuendelteZeile(unsichtbareId, "regel-x:ausgeloest:100", "Halle 2 über 120 kW");
        when(zustellwege.hatAktivenEmailWeg(any(), any(), any())).thenReturn(true);
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z1, z2));
        when(sicht.sichtbar(eq(z1.quelleId()), eq("sub-jonas"), any())).thenReturn(true);
        when(sicht.sichtbar(eq(unsichtbareId), eq("sub-jonas"), any())).thenReturn(false);

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(1);
        // Keine Bündel-Vorsilbe ("N Meldungen: ...") bei nur einer übrig gebliebenen Zeile.
        verify(email).senden(eq("warnung@example.test"), eq(z1.betreff()), eq(z1.inhalt()));
    }

    @Test
    void verschiedeneBuendelSchluesselWerdenNichtVermischt() {
        VersandRepository.Zeile z1 = gebuendelteZeile(UUID.randomUUID(), "regel-x:ausgeloest:100", "Halle 1 über 120 kW");
        VersandRepository.Zeile z2 = gebuendelteZeile(UUID.randomUUID(), "regel-y:ausgeloest:100", "Halle 2 über 50 kW");
        when(zustellwege.hatAktivenEmailWeg(any(), any(), any())).thenReturn(true);
        when(ausgang.faellig(any(), anyInt())).thenReturn(List.of(z1, z2));

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(2);
        verify(email, times(2)).senden(eq("warnung@example.test"), anyString(), anyString());
    }
}
