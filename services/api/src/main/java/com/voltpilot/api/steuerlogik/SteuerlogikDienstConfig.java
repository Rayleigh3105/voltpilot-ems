package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.JdkFlowCompilerHttp;
import java.net.URI;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Verdrahtet den {@link SteuerlogikDienst} auf den Logik-Dienst. Der Transport ist derselbe schlichte JSON-POST wie
 * zum Flow-Compiler ({@link JdkFlowCompilerHttp}); Tests ersetzen den ganzen Dienst.
 */
@Configuration
@EnableConfigurationProperties(SteuerlogikDienstProperties.class)
public class SteuerlogikDienstConfig {

    @Bean
    public SteuerlogikDienst steuerlogikDienst(SteuerlogikDienstProperties props, ObjectMapper json) {
        return new SteuerlogikDienstClient(new JdkFlowCompilerHttp(props.timeout()), URI.create(props.baseUrl()),
                json);
    }
}
