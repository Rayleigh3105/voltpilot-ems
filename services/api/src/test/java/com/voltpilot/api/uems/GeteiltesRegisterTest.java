package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Summen-Wächter des geteilten Punkts (AP-07 IP-18b): wann zwei Summanden dasselbe Register lesen. */
class GeteiltesRegisterTest {
    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-0000000000b0");
    private static final UUID ANDERE_BOX = UUID.fromString("00000000-0000-0000-0000-0000000000b9");
    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID B = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID M1 = UUID.fromString("00000000-0000-0000-0000-000000000011");
    private static final UUID M2 = UUID.fromString("00000000-0000-0000-0000-000000000012");
    private static final Instant T0 = Instant.parse("2026-09-01T00:00:00Z");
    private static final Instant T1 = Instant.parse("2026-09-10T00:00:00Z");
    private static final String P = "deye.hybrid_1p.battery.battery";

    private static List<GeteiltesRegister.Summand> beide(String rolle1, String rolle2) {
        return List.of(new GeteiltesRegister.Summand(M1, "MS-1", rolle1),
                new GeteiltesRegister.Summand(M2, "MS-2", rolle2));
    }

    @Test
    void zweiMessstellenLesenDenselbenPunktDerBoxUeberZweiKomponenten() {
        var funde = GeteiltesRegister.finde(beide("zugeordnet", "zugeordnet"), List.of(
                new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, null),
                new GeteiltesRegister.Bindung(M2, BOX, P, B, T0, null)));
        assertThat(funde).containsExactly(new GeteiltesRegister.Fund("zugeordnet", P, List.of("MS-1", "MS-2")));
    }

    @Test
    void keinFundOhneGemeinsameSummeOhneGemeinsamesRegisterOderOhneGemeinsameZeit() {
        var geteilt = List.of(new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, null),
                new GeteiltesRegister.Bindung(M2, BOX, P, B, T0, null));
        assertThat(GeteiltesRegister.finde(beide("zufluss", "zugeordnet"), geteilt))
                .as("verschiedene Summen zählen nichts doppelt").isEmpty();
        assertThat(GeteiltesRegister.finde(beide("zugeordnet", "zugeordnet"), List.of(
                new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, null),
                new GeteiltesRegister.Bindung(M2, ANDERE_BOX, P, B, T0, null))))
                .as("zwei Boxen, zwei Register").isEmpty();
        assertThat(GeteiltesRegister.finde(beide("zugeordnet", "zugeordnet"), List.of(
                new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, null),
                new GeteiltesRegister.Bindung(M2, BOX, P, A, T0, null))))
                .as("dieselbe Komponente: das ist die Doppelbindung eines Zählers, kein geteilter Punkt").isEmpty();
        assertThat(GeteiltesRegister.finde(beide("zugeordnet", "zugeordnet"), List.of(
                new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, T1),
                new GeteiltesRegister.Bindung(M2, BOX, P, B, T1, null))))
                .as("nacheinander, nie zugleich").isEmpty();
        assertThat(GeteiltesRegister.finde(List.of(new GeteiltesRegister.Summand(M1, "MS-1", "zugeordnet")),
                List.of(new GeteiltesRegister.Bindung(M1, BOX, P, A, T0, T1),
                        new GeteiltesRegister.Bindung(M1, BOX, P, B, T1, null))))
                .as("eine Messstelle, die von A zu B umzieht").isEmpty();
    }
}
