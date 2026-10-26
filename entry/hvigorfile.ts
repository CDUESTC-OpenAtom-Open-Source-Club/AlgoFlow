import { hapTasks, OhosHapContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { HvigorNode, HvigorPlugin } from '@ohos/hvigor';

// The AppGallery listing (release) build is offline (SYNC_ENTRY=false in build-profile.json5), so it
// must not request INTERNET; debug builds keep it for sync and AI demos.
function offlineReleasePlugin(): HvigorPlugin {
  return {
    pluginId: 'offlineReleasePlugin',
    apply(node: HvigorNode) {
      const context = node.getContext(OhosPluginId.OHOS_HAP_PLUGIN) as OhosHapContext;
      if (context.getBuildMode() !== 'release') return;
      const moduleJson = context.getModuleJsonOpt();
      const permissions = (moduleJson.module.requestPermissions ?? [])
        .filter(permission => permission.name !== 'ohos.permission.INTERNET');
      if (permissions.length > 0) moduleJson.module.requestPermissions = permissions;
      else delete moduleJson.module.requestPermissions;
      context.setModuleJsonOpt(moduleJson);
    }
  };
}

export default {
  system: hapTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [offlineReleasePlugin()] /* Custom plugin to extend the functionality of Hvigor. */
}
