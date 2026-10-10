package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt.Ablehnung;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService.PlattformAntrag;
import com.voltpilot.api.web.dto.UnterstuetzungDto;
import java.net.URI;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die zwei Wege, auf denen VoltPilot in einen Kundenbereich kommt (UEMS AP-03 IP-8, E8, A5/A14) — Teil des
 * Plattform-Betriebs {@code /api/v1/admin/**}, also {@code platform-admin} wie jede Admin-Route:
 *
 * <ul>
 *   <li>{@code POST …/unterstuetzung/anfrage} — <b>fragen.</b> Die Anfrage gewährt NICHTS; sie legt einen
 *       Wunsch und einen Hinweis an jeden Kundenadministrator an. Erst dessen Bestätigung
 *       ({@code POST /api/v1/unterstuetzung} mit {@code anfrage_id}) macht daraus einen Zugang.</li>
 *   <li>{@code POST …/unterstuetzung/notfall} — <b>der Notfall-Zugriff.</b> VoltPilot gewährt ihn sich
 *       selbst, und genau deshalb ist er eng und laut: <b>24 Stunden</b>, <b>Grund Pflicht</b> (ohne ihn
 *       422 {@code grund_fehlt}, und es wird nichts angelegt), Banner bei allen Benutzern und ein Hinweis
 *       an jeden Kundenadministrator — heute die Karte im Portal, mit SMTP dieselbe Zeile als E-Mail. Der
 *       Kundenadministrator kann ihn jederzeit beenden wie jede Unterstützung.</li>
 * </ul>
 *
 * <p><b>Was das am Zaun ändert:</b> VoltPilot bekommt hier zum ersten Mal einen SICHTBAREN Weg in einen
 * Kundenbereich. Der bisherige Weg — der Mandanten-Umschalter {@code X-Tenant-Id} — bleibt unverändert, bis
 * er abgeschaltet wird ({@code voltpilot.uems.unterstuetzung.umschalter-enabled}, AP-03 W3).
 *
 * <p>Der Kundenbereich steht im PFAD, nie in einem Anfragekörper; für die Dauer des Aufrufs wird er zum
 * {@link TenantContext} der Anfrage, damit RLS und Protokoll ihn sehen — danach steht wieder, was vorher stand.
 */
@RestController
@RequestMapping("/api/v1/admin/tenants/{tenantId}/unterstuetzung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminUnterstuetzungController {

    private final UnterstuetzungService dienst;
    private final TenantRepository tenants;
    private final ObjectMapper streng;

    public AdminUnterstuetzungController(UnterstuetzungService dienst, TenantRepository tenants, ObjectMapper json) {
        this.dienst = dienst;
        this.tenants = tenants;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code plattform.betrieb} — VoltPilot fragt an; gewähren kann nur der Kundenadministrator (E8). */
    @PostMapping("/anfrage")
    public ResponseEntity<UnterstuetzungDto.Anfrage> anfragen(@PathVariable UUID tenantId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = imKundenbereich(tenantId, () -> dienst.anfragen(antrag(body), akteur(auth)));
        return ResponseEntity.created(URI.create("/api/v1/unterstuetzung/anfragen/" + id))
                .body(imKundenbereich(tenantId, () -> dienst.anfragen(false).stream()
                        .filter(a -> a.id().equals(id)).findFirst()
                        .map(UnterstuetzungController::dto)
                        .orElseThrow(() -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN))));
    }

    /**
     * Recht: {@code plattform.betrieb} — der Notfall-Zugriff (E8, A14): 24 Stunden, Grund Pflicht, jeder
     * Kundenadministrator wird benachrichtigt.
     */
    @PostMapping("/notfall")
    public ResponseEntity<UnterstuetzungDto.Unterstuetzung> notfall(@PathVariable UUID tenantId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = imKundenbereich(tenantId, () -> dienst.notfall(antrag(body), akteur(auth)));
        return ResponseEntity.created(URI.create("/api/v1/unterstuetzung/" + id))
                .body(imKundenbereich(tenantId, () -> dienst.liste().stream().filter(s -> s.id().equals(id))
                        .findFirst().map(s -> UnterstuetzungController.dto(s, null))
                        .orElseThrow(() -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN))));
    }

    // ------------------------------------------------------------------ intern

    private PlattformAntrag antrag(JsonNode body) {
        UnterstuetzungDto.PlattformAntrag a = lies(body);
        return new PlattformAntrag(UnterstuetzungService.wort(Umfang.class, "umfang", a.umfang()), a.standorte(),
                a.gueltigAb() == null ? null : a.gueltigAb().toInstant(), a.gueltigBis(), a.grund());
    }

    /**
     * Setzt den Kundenbereich des Pfades für die Dauer des Aufrufs und stellt danach wieder her, was der
     * {@code TenantFilter} gesetzt hatte — ein Admin-Aufruf mit {@code X-Tenant-Id} verschiebt so nie den
     * Kundenbereich eines anderen Aufrufs desselben Threads.
     */
    private <T> T imKundenbereich(UUID tenantId, Supplier<T> arbeit) {
        if (!tenants.existsById(tenantId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        UUID vorher = TenantContext.get();
        TenantContext.set(tenantId);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Kein Konto"));
    }

    private UnterstuetzungDto.PlattformAntrag lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw UnterstuetzungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, UnterstuetzungDto.PlattformAntrag.class);
        } catch (UnrecognizedPropertyException e) {
            throw UnterstuetzungAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw UnterstuetzungAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw UnterstuetzungAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — dieselbe Form wie an den Kundenrouten. */
    @ExceptionHandler(UnterstuetzungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(UnterstuetzungAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(e.koerper());
    }

    /** Eine Kennung im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> keinJson(HttpMessageNotReadableException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(UnterstuetzungAbgelehnt.anfrage("").koerper());
    }
}
