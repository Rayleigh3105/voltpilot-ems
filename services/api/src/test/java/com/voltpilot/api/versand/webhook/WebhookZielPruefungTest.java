package com.voltpilot.api.versand.webhook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * Der SSRF-Schutz rein (ohne Netz, ohne DNS außer für die absichtlich aufgelösten Literale): nur
 * https, nur ein öffentliches Ziel - Alerting Scheibe 6, §7 Scheibe 6 "SSRF-Schutz zwingend".
 */
class WebhookZielPruefungTest {

    @Test
    void einOeffentlichesHttpsZielIstErlaubt() {
        // 93.184.216.34 (example.com) ist ein IP-Literal - kein echter DNS-Zugriff im Test nötig.
        WebhookZielPruefung.pruefenUndAufloesen("https://93.184.216.34/webhook");
    }

    @Test
    void httpWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("http://93.184.216.34/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class)
                .hasMessageContaining("https");
    }

    @Test
    void loopbackWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://127.0.0.1/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://[::1]/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void linkLocalUndCloudMetadatenWerdenAbgelehnt() {
        // 169.254.169.254 ist die AWS/GCP/Azure-Metadaten-Adresse, Teil von 169.254.0.0/16.
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://169.254.169.254/latest/meta-data"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void privateAdressbereicheWerdenAbgelehnt() {
        for (String ip : new String[] {"10.0.0.1", "172.16.0.1", "192.168.1.1"}) {
            assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://" + ip + "/webhook"))
                    .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
        }
    }

    @Test
    void cgnatWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://100.64.0.1/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void ipv4GemapptesIpv6LoopbackWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://[::ffff:127.0.0.1]/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void ipv6UniqueLocalWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://[fd00::1]/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void anyLocalWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://0.0.0.0/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void multicastWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https://224.0.0.1/webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void keinHostWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("https:///webhook"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void ungueltigeUrlWirdAbgelehnt() {
        assertThatThrownBy(() -> WebhookZielPruefung.pruefenUndAufloesen("nicht eine url"))
                .isInstanceOf(WebhookZielPruefung.UnsicheresZielException.class);
    }

    @Test
    void eineAufgeloesteUriWirdZurueckgegeben() {
        var uri = WebhookZielPruefung.pruefenUndAufloesen("https://93.184.216.34/pfad?x=1");
        assertThat(uri.getHost()).isEqualTo("93.184.216.34");
        assertThat(uri.getPath()).isEqualTo("/pfad");
    }
}
