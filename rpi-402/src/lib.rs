//! rpi-402: an rpi provider plugin that pays for inference over L402 with a
//! Wavelength wallet. It is the Rust port of the pi-402 TypeScript extension
//! and shares that extension's settings and data directory.

pub mod challenge;
pub mod commands;
pub mod config;
pub mod payer;
pub mod plugin;
pub mod provider;
pub mod store;
pub mod util;
pub mod wallet;

use rpi_plugin_sdk::{
    PluginApi, ProviderStreamCompletionFn, ProviderStreamControl, ProviderStreamEmitFn, StbString,
    StbStringRef,
};
use std::ffi::c_void;

extern "C" fn request(req: StbStringRef, out: *mut StbString, context: *mut c_void) -> i32 {
    // SAFETY: the host passes back the context it received at registration
    // and keeps every argument valid for the duration of this call.
    unsafe {
        rpi_plugin_sdk::provider::drive_with_context(
            provider::create,
            context,
            req,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
            out,
        )
    }
}

#[allow(clippy::too_many_arguments)]
extern "C" fn stream(
    req: StbStringRef,
    emit: Option<ProviderStreamEmitFn>,
    data: *mut c_void,
    control: *const ProviderStreamControl,
    _completion: Option<ProviderStreamCompletionFn>,
    _completion_data: *mut c_void,
    out: *mut StbString,
    context: *mut c_void,
) -> i32 {
    // SAFETY: as for `request`.
    unsafe {
        rpi_plugin_sdk::provider::drive_with_context(
            provider::create,
            context,
            req,
            emit,
            data,
            control,
            out,
        )
    }
}

fn register(api: &PluginApi) -> i32 {
    let endpoint = config::proxy_endpoint();
    // The seller holds the model credential; no API key is needed or used.
    let manifest = serde_json::json!({
        "id": provider::PROVIDER_ID,
        "models": provider::models(&endpoint),
        "requiresAuth": false,
    });
    let rc = rpi_plugin_sdk::provider::register_with_context(
        api,
        provider::PROVIDER_ID,
        &endpoint,
        provider::API_STYLE,
        manifest,
        request,
        stream,
    );
    if rc != 0 {
        return rc;
    }
    commands::register(api)
}

/// The exported `rpi_plugin_register` entry point. The SDK macro generates a
/// safe function taking the host's raw API pointer, which it validates before
/// use; clippy cannot see that through the macro.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
mod entry {
    rpi_plugin_sdk::export_plugin!(super::register);
}
