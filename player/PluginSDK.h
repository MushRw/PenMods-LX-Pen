// SPDX-License-Identifier: GPL-3.0-only
/* PenMods Plugin SDK (vendored from PenMods, src/plugin/PluginSDK.h) */
#pragma once

#include <cstdint>

typedef struct {
    void* (*querySymbol)(const char* symbolName);
    int (*hookFunction)(void* targetAddr, void* detourFunc, void** originalFunc);
} PluginHookAPI;

extern PluginHookAPI* g_hook_api;

#define PLUGIN_SYM(sym) (g_hook_api ? g_hook_api->querySymbol(sym) : NULL)
#define PLUGIN_HOOK(target, detour, original) \
    (g_hook_api ? g_hook_api->hookFunction(target, (void*)(detour), (void**)&(original)) : -1)
