package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class RuheHinweisRegelTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("vektoren")
    void vektoren(String name, Zustand zustand, boolean anhaltenErlaubt, List<RuheHinweisRegel.Box> boxen,
            boolean jetzt, boolean beimAnhalten) {
        assertThat(RuheHinweisRegel.ableiten(zustand, anhaltenErlaubt, boxen))
                .as(name).isEqualTo(new RuheHinweisRegel.Ergebnis(jetzt, beimAnhalten));
    }

    static Stream<Arguments> vektoren() {
        return Stream.of(
                Arguments.of("Ruhe · Fähigkeit ja", Zustand.ANGEHALTEN, false,
                        List.of(new RuheHinweisRegel.Box(true, true)), false, false),
                Arguments.of("Ruhe · Fähigkeit nein", Zustand.ANGEHALTEN, false,
                        List.of(new RuheHinweisRegel.Box(true, false)), true, false),
                Arguments.of("Ruhe · Fähigkeit unbekannt", Zustand.EINGERICHTET, false,
                        List.of(new RuheHinweisRegel.Box(true, null)), true, false),
                Arguments.of("Entwurf ruht ebenfalls · Fähigkeit unbekannt", Zustand.ENTWURF, false,
                        List.of(new RuheHinweisRegel.Box(true, null)), true, false),
                Arguments.of("keine Ruhe · Fähigkeit nein", Zustand.AKTIV, false,
                        List.of(new RuheHinweisRegel.Box(true, false)), false, false),
                Arguments.of("wird angehalten · Fähigkeit unbekannt", Zustand.AKTIV, true,
                        List.of(new RuheHinweisRegel.Box(true, null)), false, true),
                Arguments.of("mehrere Boxen · nur die zuständige kann es", Zustand.ANGEHALTEN, false,
                        List.of(new RuheHinweisRegel.Box(false, false), new RuheHinweisRegel.Box(true, true)),
                        false, false),
                Arguments.of("mehrere Boxen · nur die zuständige kann es nicht", Zustand.ANGEHALTEN, false,
                        List.of(new RuheHinweisRegel.Box(false, true), new RuheHinweisRegel.Box(true, false)),
                        true, false),
                Arguments.of("keine zuständige Box · keine Behauptung", Zustand.ANGEHALTEN, false,
                        List.of(new RuheHinweisRegel.Box(false, false)), false, false));
    }
}
