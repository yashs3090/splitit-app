// Removes the iOS push entitlement (`aps-environment`) that the expo-notifications config plugin
// always adds (it has no option to skip it). SplitIt uses only LOCAL notifications (the "Did your
// $15.10 go through?" check-in, docs/specs/2026-11-26-sent-via-venmo.md § D3), which need no
// entitlement, and the free Personal Team that builds the app can't sign the push capability.
// See docs/specs/2026-11-26-sent-via-venmo-notifications-check.md § 2 and the sent-via-Venmo ADR.
//
// ORDER: list this plugin BEFORE "expo-notifications" in app.json `plugins`. Mods registered
// earlier run later, so listing it first makes it run after expo-notifications has added the key
// (@expo/config-plugins withMod: the action runs, then the previously registered mod).
// __tests__/appConfig.test.ts guards both the order and the result.
//
// If remote push is ever added (paid team + APNs key), delete this plugin.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
