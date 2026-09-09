package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class OcppControlValidatorTest {
    @Test void sharedPolicyVectors() throws Exception {
        var validator = new OcppControlValidator();
        var vectors = new ObjectMapper().readTree(java.nio.file.Path.of("../../docs/contracts/v2/ocpp-control-vectors.json").toFile()).path("vectors");
        for (var v : vectors) {
            if (v.path("valid").asBoolean()) assertThatCode(() -> validator.validate(v.path("policy"))).as(v.path("name").asText()).doesNotThrowAnyException();
            else assertThatThrownBy(() -> validator.validate(v.path("policy"))).as(v.path("name").asText()).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
