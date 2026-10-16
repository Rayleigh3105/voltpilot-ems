package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der {@code kennzahl}-Leser rein (Alerting Scheibe 5, §6.3) - keine Datenbank: beide Quellen
 * ({@link com.voltpilot.api.uems.BezugsbasisVergleich}, {@link EnergiezielService}) sind Mocks, der
 * Test prüft nur die Abbildung Feld→Lesung und UNBEKANNT IST KEINE NULL (§6.1 Nr. 4).
 */
class KennzahlWerteLeserTest {

    private static final UUID KENNZAHL = UUID.randomUUID();
    private static final UUID ENERGIEZIEL = UUID.randomUUID();
    private static final Instant JETZT = Instant.parse("2026-10-16T08:00:00Z");

    private final com.voltpilot.api.uems.BezugsbasisVergleich vergleich =
            mock(com.voltpilot.api.uems.BezugsbasisVergleich.class);
    private final EnergiezielService energieziele = mock(EnergiezielService.class);
    private final KennzahlWerteLeser leser = new KennzahlWerteLeser(vergleich, energieziele);
    private final WerteKatalog katalog = new WerteKatalog();

    @Test
    void liestDieAbweichungVonDerBezugsbasis() {
        when(vergleich.vergleich(eq(KENNZAHL), any(), eq(null), eq(null), eq(null)))
                .thenReturn(vergleichMit("12.5"));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("kennzahl.bezugsbasis"), WerteLeser.Bezug.kennzahl(KENNZAHL),
                JETZT);

        assertThat(l.bekannt()).isTrue();
        assertThat(l.zahlenwert()).isEqualTo(12.5);
        assertThat(l.einheit()).isEqualTo("%");
    }

    @Test
    void unbekanntOhneZeitraumOderOhneDelta() {
        when(vergleich.vergleich(eq(KENNZAHL), any(), eq(null), eq(null), eq(null))).thenReturn(vergleichMit(null));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("kennzahl.bezugsbasis"), WerteLeser.Bezug.kennzahl(KENNZAHL),
                JETZT);

        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void unbekanntWennDieKennzahlAbgelehntWird() {
        when(vergleich.vergleich(eq(KENNZAHL), any(), eq(null), eq(null), eq(null)))
                .thenThrow(KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("kennzahl.bezugsbasis"), WerteLeser.Bezug.kennzahl(KENNZAHL),
                JETZT);

        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void liestDenKursZumEnergieziel() {
        when(energieziele.stand(ENERGIEZIEL)).thenReturn(standMitKurs("nicht_auf_kurs"));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("energieziel.kurs"), WerteLeser.Bezug.energieziel(ENERGIEZIEL),
                JETZT);

        assertThat(l.bekannt()).isTrue();
        assertThat(l.zustandswort()).isEqualTo("nicht_auf_kurs");
    }

    @Test
    void unbekanntWennDasEnergiezielAbgelehntWird() {
        when(energieziele.stand(ENERGIEZIEL)).thenThrow(new VerbesserungAbgelehnt(404, "nicht_gefunden",
                "Dieses Energieziel gibt es nicht.", null));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("energieziel.kurs"), WerteLeser.Bezug.energieziel(ENERGIEZIEL),
                JETZT);

        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void falscherBezugIstUnbekannt() {
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("kennzahl.bezugsbasis"), WerteLeser.Bezug.energieziel(ENERGIEZIEL),
                JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    private static BezugsbasisVergleichDto.Vergleich vergleichMit(String deltaProzent) {
        BezugsbasisVergleichDto.Zeitraum zeitraum = deltaProzent == null ? null
                : new BezugsbasisVergleichDto.Zeitraum(1, "100", "90", deltaProzent, "5", "hoeher", "im_rahmen", null,
                        "12", List.of(), null);
        return new BezugsbasisVergleichDto.Vergleich(null, null, null, null, null, List.of(), zeitraum, List.of(),
                null, null);
    }

    private static EnergiezielDto.Stand standMitKurs(String lage) {
        EnergiezielDto.Kurs kurs = new EnergiezielDto.Kurs(lage, 6, 6, null, null, null, null);
        return new EnergiezielDto.Stand(null, null, null, null, List.of(), 6, 6, 12, null, true, List.of(), null,
                null, null, null, kurs);
    }
}
