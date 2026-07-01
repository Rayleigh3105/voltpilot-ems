package com.voltpilot.api.web;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceClaimRequest;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Devices for the caller's tenant, and the claim endpoint. Claiming is a single
 * insert scoped to the tenant; RLS plus the global unique {@code external_ref}
 * index make cross-tenant claiming impossible.
 */
@RestController
@RequestMapping("/api/v1/devices")
public class DeviceController {

    private final DeviceRepository devices;
    private final SiteRepository sites;

    public DeviceController(DeviceRepository devices, SiteRepository sites) {
        this.devices = devices;
        this.sites = sites;
    }

    @GetMapping
    public List<DeviceDto> listDevices() {
        return devices.findAll();
    }

    @PostMapping("/claim")
    public ResponseEntity<DeviceDto> claim(@Valid @RequestBody DeviceClaimRequest request) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No tenant in token");
        }
        // The target site must belong to the caller's tenant (RLS-checked).
        if (!sites.existsForCurrentTenant(request.siteId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        try {
            DeviceDto claimed = devices.claim(tenantId, request.siteId(), request.externalRef(), request.kind());
            return ResponseEntity.status(HttpStatus.CREATED).body(claimed);
        } catch (DuplicateKeyException ex) {
            // external_ref already claimed (possibly by another tenant, which RLS hides).
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Device '" + request.externalRef() + "' is already claimed");
        }
    }
}
