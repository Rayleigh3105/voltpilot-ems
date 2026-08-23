<#--
  Seite abgelaufen (accessCodeLifespanLogin 1800 s bzw.
  accessCodeLifespanUserAction 300 s). Keycloak bietet BEIDE Wege an; der
  sichere - neu starten - steht vorn.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
<!-- template: login-page-expired.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("vpExpiredTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpExpiredHint")}</p>
    <#elseif section = "form">
        <a id="loginRestartLink" class="vpl-submit" href="${url.loginRestartFlowUrl}">
            <span class="vpl-submit-label">${msg("vpExpiredRestart")}</span>
        </a>
        <a id="loginContinueLink" class="vpl-secondary" href="${url.loginAction}">${msg("vpExpiredContinue")}</a>
    </#if>
</@layout.registrationLayout>
