package com.voltpilot.api.flows;

/**
 * A compile attempt did not yield a usable artifact. Carries a machine-readable
 * {@code reason} and a customer-facing German {@code message} that
 * {@link FlowActivationService} relays into an honest {@code activated=false}
 * outcome - so a sidecar outage (or a compiler rejection) leaves the flow at
 * {@code simuliert}, never a half-activated state.
 *
 * <p>Reasons:
 * <ul>
 *   <li>{@code compiler_unavailable} - the flowc sidecar is unreachable /
 *       returned an unexpected status (transient; retry later).</li>
 *   <li>{@code compiler_rejected} - the sidecar compiled but REJECTED the flow
 *       (422 validation) or returned a malformed artifact.</li>
 * </ul>
 */
public class FlowCompilerException extends RuntimeException {

    private final String reason;

    public FlowCompilerException(String reason, String message) {
        super(message);
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }

    static FlowCompilerException unavailable() {
        return new FlowCompilerException("compiler_unavailable",
                "Der Flow-Compiler ist gerade nicht erreichbar. Die Aktivierung wurde "
                        + "abgebrochen - der Flow bleibt unverändert (Simuliert). Bitte "
                        + "versuchen Sie es in wenigen Minuten erneut.");
    }

    static FlowCompilerException rejected(String message) {
        return new FlowCompilerException("compiler_rejected",
                message == null || message.isBlank()
                        ? "Der Flow-Compiler hat den Flow abgelehnt - es wurde nichts ausgerollt."
                        : message);
    }
}
