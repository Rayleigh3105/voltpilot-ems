package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
import com.voltpilot.api.ueberwachung.WerteLeser.Bezug;
import com.voltpilot.api.ueberwachung.WerteLeser.Lesung;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Der {@code direktvermarktung}-Leser (Konzept d2 §5.7 "Alarme"): liest nur den Herzschlag-Spiegel und den
 * aktuellen Zugang; ein stummer Spiegel ist UNBEKANNT (hält, löst nie aus), Unbekannt ist keine Null.
 */
class DirektvermarktungWerteLeserTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID EINTRAG = UUID.fromString("00000000-0000-0000-0000-00000000000e");
    private static final Instant JETZT = Instant.parse("2026-11-25T12:00:00Z");

    private final DirektvermarktungRepository repo = mock(DirektvermarktungRepository.class);
    private final DirektvermarktungWerteLeser leser = new DirektvermarktungWerteLeser(repo);
    private final WerteKatalog katalog = new WerteKatalog();

    private Bezug anlage() {
        return Bezug.anlage(SITE);
    }

    private Lesung lese(String wertart) {
        return leser.lese(katalog.eintrag(wertart), anlage(), JETZT);
    }

    private static Eintrag anschluss(String zustand) {
        return new Eintrag(EINTRAG, SITE, "luox", zustand, null, null, null, null, null, null, null, 1,
                JETZT, JETZT);
    }

    private static Stand stand(Instant gemeldetAm, Instant handshakeAm, Instant letzteAbfrageAm,
            Integer vorgabePct, Integer einspeisungW, Integer referenzW) {
        return new Stand(null, handshakeAm, null, letzteAbfrageAm, null, null, vorgabePct, null,
                einspeisungW, null, null, referenzW, gemeldetAm);
    }

    @BeforeEach
    void setUp() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(anschluss(DirektvermarktungRepository.VERBUNDEN));
    }

    @Test
    void ohneAnschlussOderOhneSpiegelIstAllesUnbekannt() {
        when(repo.aktiverOhneEnde(SITE)).thenReturn(null);
        assertThat(lese("direktvermarktung.verbindung_weg").bekannt()).isFalse();

        when(repo.aktiverOhneEnde(SITE)).thenReturn(anschluss(DirektvermarktungRepository.VERBUNDEN));
        when(repo.stand(SITE)).thenReturn(null);
        assertThat(lese("direktvermarktung.verbindung_weg").bekannt()).isFalse();

        // Ein alter Spiegel ("Stand unbekannt seit ...") ist ebenso unbekannt - er hält, löst nie aus.
        when(repo.stand(SITE)).thenReturn(stand(JETZT.minusSeconds(900), JETZT.minusSeconds(910), null,
                null, null, null));
        assertThat(lese("direktvermarktung.verbindung_weg").bekannt()).isFalse();
    }

    @Test
    void verbindungFolgtDerHandshakeFrische() {
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), null, null, null, null));
        assertThat(lese("direktvermarktung.verbindung_weg").zustandswort()).isEqualTo("verbunden");

        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(600), null, null, null, null));
        assertThat(lese("direktvermarktung.verbindung_weg").zustandswort()).isEqualTo("getrennt");

        // Nie ein Handshake (baut_auf): kein "Verbindung weg" - die Einrichtung meldet das, nicht dieser Alarm.
        when(repo.stand(SITE)).thenReturn(stand(JETZT, null, null, null, null, null));
        assertThat(lese("direktvermarktung.verbindung_weg").bekannt()).isFalse();
    }

    @Test
    void abfrageGiltNurBeiStehendemTunnel() {
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(120),
                null, null, null));
        assertThat(lese("direktvermarktung.partner_liest_nicht").zustandswort()).isEqualTo("liest");

        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(1200),
                null, null, null));
        assertThat(lese("direktvermarktung.partner_liest_nicht").zustandswort()).isEqualTo("liest_nicht");

        // Tunnel weg: das meldet verbindung_weg, nicht die Abfrage.
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(600), JETZT.minusSeconds(1200),
                null, null, null));
        assertThat(lese("direktvermarktung.partner_liest_nicht").bekannt()).isFalse();
    }

    @Test
    void grenzeVergleichtGegenVorgabeMalReferenzPlusToleranz() {
        // 30 % von 10 kW = 3000 W, Toleranz max(5 %, 500 W) = 500 W.
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(60),
                30, 3400, 10000));
        assertThat(lese("direktvermarktung.anlage_folgt_nicht").zustandswort()).isEqualTo("folgt");

        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(60),
                30, 3600, 10000));
        assertThat(lese("direktvermarktung.anlage_folgt_nicht").zustandswort()).isEqualTo("folgt_nicht");

        // Ohne aktive Vorgabe gibt es nichts zu folgen; ohne Messung kein Urteil (Unbekannt ist keine Null).
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(60),
                100, 99999, 10000));
        assertThat(lese("direktvermarktung.anlage_folgt_nicht").zustandswort()).isEqualTo("folgt");
        when(repo.stand(SITE)).thenReturn(stand(JETZT, JETZT.minusSeconds(60), JETZT.minusSeconds(60),
                30, null, 10000));
        assertThat(lese("direktvermarktung.anlage_folgt_nicht").bekannt()).isFalse();
    }

    @Test
    void zugangFristKenntDreissigUndSiebenTage() {
        when(repo.aktuellerZugang(EINTRAG)).thenReturn(new ZugangZeile(UUID.randomUUID(), EINTRAG,
                "SHA256:abc", JETZT.plusSeconds(20L * 86400), null, null));
        assertThat(lese("direktvermarktung.zugang_laeuft_ab").zustandswort()).isEqualTo("laeuft_ab");
        assertThat(lese("direktvermarktung.zugang_laeuft_gleich_ab").zustandswort()).isEqualTo("gueltig");

        when(repo.aktuellerZugang(EINTRAG)).thenReturn(new ZugangZeile(UUID.randomUUID(), EINTRAG,
                "SHA256:abc", JETZT.plusSeconds(5L * 86400), null, null));
        assertThat(lese("direktvermarktung.zugang_laeuft_gleich_ab").zustandswort()).isEqualTo("laeuft_ab");

        when(repo.aktuellerZugang(EINTRAG)).thenReturn(new ZugangZeile(UUID.randomUUID(), EINTRAG,
                "SHA256:abc", JETZT.plusSeconds(200L * 86400), null, null));
        assertThat(lese("direktvermarktung.zugang_laeuft_ab").zustandswort()).isEqualTo("gueltig");

        when(repo.aktuellerZugang(EINTRAG)).thenReturn(null);
        assertThat(lese("direktvermarktung.zugang_laeuft_ab").bekannt()).isFalse();
    }
}
