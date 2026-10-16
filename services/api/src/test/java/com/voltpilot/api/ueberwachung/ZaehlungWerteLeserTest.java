package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.uems.MessstelleRegisterService;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der {@code zaehlung}-Leser rein (Alerting Scheibe 5, §6.3) - keine Datenbank: alle drei Quellen
 * ({@link MessstelleRepository}, {@link MessstelleWerteService}, {@link MessstelleRegisterService})
 * sind Mocks, der Test prüft nur die Abbildung Feld→Lesung, das Monatsraster und UNBEKANNT IST
 * KEINE NULL (§6.1 Nr. 4).
 */
class ZaehlungWerteLeserTest {

    private static final UUID MESSSTELLE = UUID.randomUUID();
    private static final Instant JETZT = Instant.parse("2026-10-16T08:00:00Z");

    private final MessstelleRepository messstellen = mock(MessstelleRepository.class);
    private final MessstelleWerteService werte = mock(MessstelleWerteService.class);
    private final MessstelleRegisterService register = mock(MessstelleRegisterService.class);
    private final ZaehlungWerteLeser leser = new ZaehlungWerteLeser(messstellen, werte, register);
    private final WerteKatalog katalog = new WerteKatalog();

    @Test
    void liestDieMengeDesAbgeschlossenenMonats() {
        when(messstellen.finde(MESSSTELLE)).thenReturn(Optional.of(messstelle()));
        when(werte.monatswert(any(), any(), any())).thenReturn(
                new MessstelleWerteService.Monatswert("Europe/Berlin", wertMitMengeUndZustand("1234.5", null), null));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.menge"), WerteLeser.Bezug.messstelle(MESSSTELLE),
                JETZT);

        assertThat(l.bekannt()).isTrue();
        assertThat(l.zahlenwert()).isEqualTo(1234.5);
        assertThat(l.einheit()).isEqualTo("kWh");
    }

    @Test
    void unbekanntOhneMessstelle() {
        when(messstellen.finde(MESSSTELLE)).thenReturn(Optional.empty());

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.menge"), WerteLeser.Bezug.messstelle(MESSSTELLE),
                JETZT);

        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void periodeMussMonatSein() {
        WerteLeser.Lesung l = leser.lesePeriode(katalog.eintrag("messstelle.menge"),
                WerteLeser.Bezug.messstelle(MESSSTELLE), "tag", false, JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void liestDieBeobachtung() {
        when(register.liste(eq(JETZT), eq(MessstelleRegisterService.Filter.KEINER)))
                .thenReturn(listeMit(registerZeile(MESSSTELLE, "liefert_nicht_seit")));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.beobachtung"),
                WerteLeser.Bezug.messstelle(MESSSTELLE), JETZT);

        assertThat(l.bekannt()).isTrue();
        assertThat(l.zustandswort()).isEqualTo("liefert_nicht_seit");
    }

    @Test
    void unbekannteBeobachtungOhneTreffer() {
        when(register.liste(eq(JETZT), eq(MessstelleRegisterService.Filter.KEINER)))
                .thenReturn(listeMit(registerZeile(UUID.randomUUID(), "liefert")));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.beobachtung"),
                WerteLeser.Bezug.messstelle(MESSSTELLE), JETZT);

        assertThat(l.bekannt()).isFalse();
    }

    @Test
    void monatUnvollstaendigLiestDenZuletztAbgeschlossenenMonat() {
        when(messstellen.finde(MESSSTELLE)).thenReturn(Optional.of(messstelle()));
        when(werte.monatswert(any(), any(), any())).thenReturn(
                new MessstelleWerteService.Monatswert("Europe/Berlin", wertMitMengeUndZustand(null, "unvollstaendig"),
                        null));

        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.monat_unvollstaendig"),
                WerteLeser.Bezug.messstelle(MESSSTELLE), JETZT);

        assertThat(l.bekannt()).isTrue();
        assertThat(l.zustandswort()).isEqualTo("unvollstaendig");
    }

    @Test
    void falscherBezugIstUnbekannt() {
        WerteLeser.Lesung l = leser.lese(katalog.eintrag("messstelle.menge"), WerteLeser.Bezug.anlage(UUID.randomUUID()),
                JETZT);
        assertThat(l.bekannt()).isFalse();
    }

    private static MessstelleRepository.Messstelle messstelle() {
        MessstelleRegeln.Groesse groesse = new MessstelleRegeln.Groesse("Verbrauch", "bezug", "kWh", "Zählerstand");
        return new MessstelleRepository.Messstelle(MESSSTELLE, "MS-01", "Halle 1", "gemessen", "strom", groesse,
                null, null, null, null);
    }

    private static MessstelleWerteDto.Wert wertMitMengeUndZustand(String menge, String zustand) {
        return new MessstelleWerteDto.Wert(null, null, null, null, null, menge == null ? null : new BigDecimal(menge),
                null, null, null, zustand, List.of(), null, null, null, null, null, null, null, null, null, List.of(),
                null, null);
    }

    private static MessstelleDto.Liste listeMit(MessstelleDto.RegisterZeile zeile) {
        return new MessstelleDto.Liste(List.of(), List.of(zeile), null, null, false, null);
    }

    private static MessstelleDto.RegisterZeile registerZeile(UUID id, String beobachtungZustand) {
        MessstelleDto.RegisterBeobachtung beobachtung =
                new MessstelleDto.RegisterBeobachtung(beobachtungZustand, null, null, null, null, null, null);
        return new MessstelleDto.RegisterZeile(id, "MS-01", "Halle 1", "gemessen", "strom", null, null, null, null,
                null, List.of(), null, null, beobachtung, null, List.of(), List.of(), null, List.of(), null);
    }
}
