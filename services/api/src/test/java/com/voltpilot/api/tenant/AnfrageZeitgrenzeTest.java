package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class AnfrageZeitgrenzeTest {

    @AfterEach
    void aufraeumen() {
        AnfrageZeitgrenze.ende();
    }

    @Test
    void ohneStartIstSieNichtAktiv() {
        assertThat(AnfrageZeitgrenze.istAktiv()).isFalse();
    }

    @Test
    void startSchaltetSieAnUndEndeWiederAus() {
        AnfrageZeitgrenze.start();
        assertThat(AnfrageZeitgrenze.istAktiv()).isTrue();
        AnfrageZeitgrenze.ende();
        assertThat(AnfrageZeitgrenze.istAktiv()).isFalse();
    }

    @Test
    void ausnahmeSchaltetSieFuerDenRestDerAnfrageAb() {
        AnfrageZeitgrenze.start();
        AnfrageZeitgrenze.ausnahme();
        assertThat(AnfrageZeitgrenze.istAktiv()).isFalse();
    }
}
