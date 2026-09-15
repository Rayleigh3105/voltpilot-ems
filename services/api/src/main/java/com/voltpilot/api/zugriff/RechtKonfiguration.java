package com.voltpilot.api.zugriff;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Hängt {@link RechtInterceptor} an die Kundenrouten — dieselbe Grenze wie {@link ZugriffFilter}: {@code /api/v1/**}
 * ohne {@code /api/v1/admin/**} (Plattform-Betrieb, eigene Rollen). Die Prüfung kommt über einen
 * {@link ObjectProvider}, damit ein Web-Ausschnitt ohne Datenbank startet.
 */
@Configuration
public class RechtKonfiguration implements WebMvcConfigurer {

    private final ObjectProvider<RechtPruefung> pruefung;

    public RechtKonfiguration(ObjectProvider<RechtPruefung> pruefung) {
        this.pruefung = pruefung;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new RechtInterceptor(pruefung))
                .addPathPatterns("/api/v1/**")
                .excludePathPatterns("/api/v1/admin/**");
    }
}
