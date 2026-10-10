package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

/** Bestandsprüfungen lesen die Einträge weiter; der neue Umschlag wird bei JEDEM Abruf geprüft. */
public final class SichtbareListenTestLeser {
    private SichtbareListenTestLeser() {}

    @SuppressWarnings("unchecked")
    public static <T> ResponseEntity<List<T>> lesen(TestRestTemplate rest, String url, HttpMethod method,
            HttpEntity<?> request, ParameterizedTypeReference<List<T>> typ) {
        ResponseEntity<Map<String, Object>> antwort = rest.exchange(url, method, request,
                new ParameterizedTypeReference<>() {});
        List<T> eintraege = null;
        if (antwort.getStatusCode().is2xxSuccessful()) {
            assertThat(antwort.getBody()).containsOnlyKeys("eintraege", "teilansicht");
            assertThat((Map<String, Object>) antwort.getBody().get("teilansicht"))
                    .containsOnlyKeys("sichtbar", "gesamt");
            eintraege = (List<T>) antwort.getBody().get("eintraege");
            assertThat(eintraege).isNotNull();
        }
        return new ResponseEntity<>(eintraege, antwort.getHeaders(), antwort.getStatusCode());
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    public static ResponseEntity<List> lesen(TestRestTemplate rest, String url, HttpMethod method,
            HttpEntity<?> request, Class<List> typ) {
        return (ResponseEntity) lesen(rest, url, method, request,
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
    }
}
