import { hapTasks, OhosHapContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { HvigorNode, HvigorPlugin } from '@ohos/hvigor';

// A build with SYNC_ENTRY=false (the AppGallery listing build, see build-profile.json5) is offline,
// so it must not request INTERNET. Setting SYNC_ENTRY back to true restores both entries and permission.
function syncEntryEnabled(context: OhosHapContext): boolean {
  const profile = context.getBuildProfileOpt();
  const modeOption = (profile.buildOptionSet ?? []).find(option => option.name === context.getBuildMode());
  const fields: Record<string, unknown> = {
    ...((profile.buildOption?.arkOptions?.buildProfileFields ?? {}) as Record<string, unknown>),
    ...((modeOption?.arkOptions?.buildProfileFields ?? {}) as Record<string, unknown>)
  };
  return fields['SYNC_ENTRY'] !== false;
}

function offlineBuildPlugin(): HvigorPlugin {
  return {
    pluginId: 'offlineBuildPlugin',
    apply(node: HvigorNode) {
      const context = node.getContext(OhosPluginId.OHOS_HAP_PLUGIN) as OhosHapContext;
      if (syncEntryEnabled(context)) return;
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
  plugins: [offlineBuildPlugin()] /* Custom plugin to extend the functionality of Hvigor. */
}
