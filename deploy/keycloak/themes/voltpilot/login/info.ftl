<#--
  Info-Seite ("Sie sind bereits angemeldet.", abgelaufene Links, ...).
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
<!-- template: info.ftl (voltpilot) -->
    <#if section = "header">
        <#if messageHeader??>${kcSanitize(msg("${messageHeader}"))?no_esc}<#else>${msg("vpInfoTitle")}</#if>
    <#elseif section = "form">
        <div id="kc-info-message" class="vpl-alert is-info" role="status">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>
            <span class="instruction">${message.summary}<#if requiredActions??><#list requiredActions>: <b><#items as reqActionItem>${kcSanitize(msg("requiredAction.${reqActionItem}"))?no_esc}<#sep>, </#items></b></#list></#if></span>
        </div>
        <#if !skipLink??>
            <#if pageRedirectUri?has_content>
                <a class="vpl-submit" href="${pageRedirectUri}"><span class="vpl-submit-label">${msg("vpBackToPortal")}</span></a>
            <#elseif actionUri?has_content>
                <a class="vpl-submit" href="${actionUri}"><span class="vpl-submit-label">${kcSanitize(msg("proceedWithAction"))?no_esc}</span></a>
            <#elseif (client.baseUrl)?has_content>
                <a class="vpl-submit" href="${client.baseUrl}"><span class="vpl-submit-label">${msg("vpBackToPortal")}</span></a>
            </#if>
        </#if>
    </#if>
</@layout.registrationLayout>
