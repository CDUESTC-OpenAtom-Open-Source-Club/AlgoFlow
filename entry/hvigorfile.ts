import { hapTasks, OhosHapContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { HvigorNode, HvigorPlugin } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

// A build with SYNC_ENTRY=false (the offline app, see build-profile.json5) must not request INTERNET.
// Setting SYNC_ENTRY back to true restores both entries and permission.
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

// The bundled privacy policy (rawfile/privacy.html) is generated from the template the server uses,
// so the two cannot drift. The operator values stay out of the repository: they come from the
// gitignored entry/privacy.local.json (see deploy/README.md §3). Debug builds fill missing values
// with a marker; the release build fails instead.
const PRIVACY_KEYS = ['OPERATOR_NAME', 'CONTACT_EMAIL', 'DOMAIN', 'EFFECTIVE_DATE'];

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function privacyPolicyPlugin(): HvigorPlugin {
  return {
    pluginId: 'privacyPolicyPlugin',
    apply(node: HvigorNode) {
      const context = node.getContext(OhosPluginId.OHOS_HAP_PLUGIN) as OhosHapContext;
      const modulePath = context.getModulePath();
      const release = context.getBuildMode() === 'release';
      const fail = (reason: string): never => {
        throw new Error(`Privacy policy: ${reason}. See deploy/README.md §3.`);
      };
      const valuesPath = path.join(modulePath, 'privacy.local.json');
      let values: Record<string, unknown> = {};
      if (fs.existsSync(valuesPath)) {
        try {
          // Windows editors may save the file with a byte order mark, which JSON.parse rejects.
          const text = fs.readFileSync(valuesPath, 'utf8');
          values = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) as Record<string, unknown>;
        } catch (error) {
          fail(`entry/privacy.local.json is not valid JSON (${error instanceof Error ? error.message : 'unknown'})`);
        }
      } else if (release) {
        fail('entry/privacy.local.json is missing');
      }
      let html = fs.readFileSync(path.resolve(modulePath, '..', 'deploy', 'privacy.template.html'), 'utf8');
      for (const key of PRIVACY_KEYS) {
        const value = typeof values[key] === 'string' ? (values[key] as string).trim() : '';
        if (value.length === 0 && release) fail(`entry/privacy.local.json has no ${key}`);
        html = html.split(`{{${key}}}`).join(escapeHtml(value.length > 0 ? value : '（未填写）'));
      }
      if (release && html.includes('{{')) fail('deploy/privacy.template.html has a placeholder that is not filled');
      const outputPath = path.join(modulePath, 'src', 'main', 'resources', 'rawfile', 'privacy.html');
      // Rewriting an unchanged file would make every build recompile resources.
      if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8') === html) return;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, html, 'utf8');
    }
  };
}

export default {
  system: hapTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [offlineBuildPlugin(), privacyPolicyPlugin()] /* Custom plugin to extend the functionality of Hvigor. */
}
