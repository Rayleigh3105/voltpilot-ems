<#--
  Fehlerseite (z. B. ungueltige redirect_uri). Der Satz darueber spricht
  Kundendeutsch, die technische Ursache bleibt SICHTBAR - der Support braucht
  sie, und sie zu verstecken macht den Anruf laenger statt kuerzer.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
<!-- template: error.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("vpErrorTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpErrorHint")}</p>
    <#elseif section = "form">
        <div id="kc-error-message" class="vpl-alert is-err" role="alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
            <span class="instruction">${kcSanitize(message.summary)?no_esc}</span>
        </div>
        <#if !skipLink?? && client?? && client.baseUrl?has_content>
            <a id="backToApplication" class="vpl-submit" href="${client.baseUrl}">
                <span class="vpl-submit-label">${msg("vpBackToPortal")}</span>
            </a>
        </#if>
    </#if>
</@layout.registrationLayout>
