package com.voltpilot.api.zugriff;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Der Prüfpunkt an jeder Kunden-Schreibroute (UEMS AP-03 IP-6): trägt der Handler {@link Recht}, entscheidet
 * {@link RechtPruefung}, bevor der Anfragekörper gelesen und der Handler aufgerufen wird. Die Datenbank sperrt seit
 * IP-5 die Zeilen, diese Stelle die Aktionen.
 *
 * <p>Eine Ablehnung wird geworfen, nicht geschrieben: der {@code DispatcherServlet} reicht sie an die
 * {@code @ExceptionHandler} DES Controllers weiter, dem die Route gehört — eine 404 sieht darum genauso aus wie die der
 * Route selbst; {@link RechtFehlt} rendert {@link RechtFehltAntwort}.
 *
 * <p>Das Urteil steht als Anfrage-Attribut {@link #URTEIL} ({@link RechtPruefung.Ergebnis#code()}) — für Tests und
 * Protokoll. Registriert von {@link RechtKonfiguration} für {@code /api/v1/**} außer {@code /api/v1/admin/**}.
 */
public class RechtInterceptor implements HandlerInterceptor {

    public static final String URTEIL = RechtInterceptor.class.getName() + ".urteil";

    private final ObjectProvider<RechtPruefung> pruefung;

    public RechtInterceptor(ObjectProvider<RechtPruefung> pruefung) {
        this.pruefung = pruefung;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod methode)) {
            return true;
        }
        Recht recht = methode.getMethodAnnotation(Recht.class);
        if (recht == null) {
            return true;
        }
        RechtPruefung p = pruefung.getIfAvailable();
        if (p == null) {
            // Nur in Test-Ausschnitten ohne Datenbank; mit einem Zugriff-Kontext wäre das eine offene Tür.
            if (ZugriffContext.get() != null) {
                throw new IllegalStateException("Rechte-Prüfung fehlt, obwohl ein Zugriff-Kontext besteht");
            }
            request.setAttribute(URTEIL, RechtPruefung.Ergebnis.OHNE_KONTEXT.code());
            return true;
        }
        @SuppressWarnings("unchecked")
        Map<String, String> pfad = (Map<String, String>) request.getAttribute(
                HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        RechtPruefung.Urteil u = p.route(recht, pfad == null ? Map.of() : pfad, methode.getBeanType().getSimpleName());
        request.setAttribute(URTEIL, u.ergebnis().code());
        if (u.ablehnung() != null) {
            throw u.ablehnung();
        }
        return true;
    }
}
