package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import org.junit.jupiter.api.Test;

class MastrNumbersTest {

    @Test
    void normalizesLowercaseAndSpaces() throws Exception {
        assertThat(MastrNumbers.requireSee(" see9668 3166 9444 ")).isEqualTo("SEE966831669444");
    }

    @Test
    void acceptsAValidSeeNumber() throws Exception {
        assertThat(MastrNumbers.requireSee("SEE972142227037")).isEqualTo("SEE972142227037");
    }

    @Test
    void rejectsWrongPrefixesWithSpecificGermanHints() {
        assertThat(reasonOf("SSE933136239009").getMessage()).contains("Speicher-EINHEIT");
        assertThat(reasonOf("EEG958276214082").getMessage()).contains("EEG-Anlage");
        assertThat(reasonOf("ABR917552830729").getMessage()).contains("Betreibernummer");
        assertThat(reasonOf("SES123456789012").getMessage()).contains("SEE-Nummer");
    }

    @Test
    void rejectsMalformedNumbers() {
        assertThatThrownBy(() -> MastrNumbers.requireSee("SEE12345"))
                .isInstanceOf(RegistryLookupException.class)
                .hasMessageContaining("12 Ziffern");
        assertThatThrownBy(() -> MastrNumbers.requireSee(""))
                .isInstanceOf(RegistryLookupException.class);
        assertThatThrownBy(() -> MastrNumbers.requireSee("SEE96683166944X"))
                .isInstanceOf(RegistryLookupException.class);
    }

    private RegistryLookupException reasonOf(String raw) {
        RegistryLookupException e = catchThrowableOfType(
                () -> MastrNumbers.requireSee(raw), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.INVALID_NUMBER);
        return e;
    }
}
