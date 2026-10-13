package com.voltpilot.api.logging;

import com.voltpilot.api.tenant.TenantContext;
import jakarta.servlet.ServletException;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.slf4j.MDC;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

/**
 * Die Vorgangs-Kennung einer HTTP-Anfrage (docs/k8s-readiness.md, Abschnitt "Logs"): {@code X-Request-ID}
 * vom Ingress übernehmen oder erzeugen, für die Dauer der Anfrage als {@code request_id} im MDC führen und
 * in der Antwort zurückgeben - wer eine fehlgeschlagene Antwort in der Hand hat, findet damit die Zeilen
 * von Ingress, Frontend und api.
 *
 * <p><b>Warum ein Tomcat-Valve und kein Servlet-Filter.</b> Die wichtigste Zeile einer Anfrage ist die
 * zu einer unbehandelten Ausnahme (Status 500 samt Stapelspur). Die schreibt Tomcat selbst, und zwar
 * erst, nachdem JEDER Filter zurückgekehrt ist - ein Filter hätte seine Kennung im {@code finally} da
 * schon abgeräumt. Das Valve am Engine liegt um alles, was Tomcat in diesem Faden für die Anfrage tut:
 * die Filterkette, die eigene Fehlerzeile und den Durchlauf nach {@code /error}. Aus demselben Grund
 * räumt es am Ende auch {@code tenant_id} ab, die der {@code TenantFilter} für genau diese Zeile stehen
 * lässt.
 *
 * <p>Eine mitgeschickte Kennung gilt nur in einer engen Form. Der Ingress reicht den Kopf eines Aufrufers
 * unverändert durch; was nicht passt, wird ersetzt, nie abgewiesen.
 */
@Component
public class VorgangsKennung implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    public static final String KOPFZEILE = "X-Request-ID";
    /** MDC-Schlüssel der Vorgangs-Kennung. */
    public static final String LOG_KENNUNG = "request_id";

    private static final Pattern ANNEHMBAR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final String MERKER = VorgangsKennung.class.getName();

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        factory.addEngineValves(new Klammer());
    }

    static final class Klammer extends ValveBase {

        Klammer() {
            super(true);
        }

        @Override
        public void invoke(Request request, Response response) throws IOException, ServletException {
            String kennung = kennung(request);
            response.setHeader(KOPFZEILE, kennung);
            MDC.put(LOG_KENNUNG, kennung);
            try {
                getNext().invoke(request, response);
            } finally {
                MDC.remove(LOG_KENNUNG);
                MDC.remove(TenantContext.LOG_KENNUNG);
            }
        }

        /** Jeder weitere Durchlauf derselben Anfrage (asynchrone Fortsetzung) behält die erste Kennung. */
        private static String kennung(Request request) {
            if (request.getAttribute(MERKER) instanceof String schon) {
                return schon;
            }
            String kennung = uebernehmenOderErzeugen(request.getHeader(KOPFZEILE));
            request.setAttribute(MERKER, kennung);
            return kennung;
        }
    }

    /** 32 Hex-Zeichen wie die Kennung, die ingress-nginx selbst vergibt. */
    static String uebernehmenOderErzeugen(String mitgeschickt) {
        return mitgeschickt != null && ANNEHMBAR.matcher(mitgeschickt).matches()
                ? mitgeschickt
                : UUID.randomUUID().toString().replace("-", "");
    }
}
