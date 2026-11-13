import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isBridgeArg(arg, bridgePath) {
  if (typeof arg !== 'string') return false;
  return resolve(arg) === resolve(bridgePath) || basename(arg) === 'bridge.mjs';
}

export function configureProviderSettings(settings, options) {
  const {
    nodePath = process.execPath,
    bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
    providerId = 'antigravity-cli',
    agyPath,
    uninstall = false
  } = options;

  const instance = settings?.providerInstances?.[providerId];
  if (!instance?.config) {
    throw new Error(`Provider "${providerId}" was not found in T3 settings. Add Antigravity CLI in T3 Settings -> Providers first.`);
  }

  const currentArgs = Array.isArray(instance.config.commandArgs) ? instance.config.commandArgs : [];
  const bridgeIndex = currentArgs.findIndex(arg => isBridgeArg(arg, bridgePath));
  const alreadyWrapped = bridgeIndex >= 0;

  let innerCommand;
  let innerArgs;
  if (alreadyWrapped) {
    innerCommand = agyPath ?? currentArgs[bridgeIndex + 1];
    innerArgs = currentArgs.slice(bridgeIndex + 2);
    if (!innerCommand) {
      throw new Error('Wrapped command arguments are missing the inner CLI executable path.');
    }
  } else {
    innerCommand = agyPath ?? instance.config.commandPath;
    innerArgs = currentArgs.length > 0 ? currentArgs : ['acp', '--process-per-session'];
    if (!innerCommand) {
      throw new Error(`Provider "${providerId}" has no commandPath configured.`);
    }
  }

  const updated = structuredClone(settings);
  if (uninstall) {
    if (!alreadyWrapped) {
      return { settings: updated, changed: false, commandPath: innerCommand, commandArgs: innerArgs };
    }
    updated.providerInstances[providerId].config.commandPath = innerCommand;
    updated.providerInstances[providerId].config.commandArgs = innerArgs;
    return { settings: updated, changed: true, commandPath: innerCommand, commandArgs: innerArgs };
  }

  const nextCommandPath = nodePath;
  const nextArgs = ['--no-warnings', resolve(bridgePath), innerCommand, ...innerArgs];
  const unchanged =
    updated.providerInstances[providerId].config.commandPath === nextCommandPath &&
    JSON.stringify(updated.providerInstances[providerId].config.commandArgs) === JSON.stringify(nextArgs);

  updated.providerInstances[providerId].config.commandPath = nextCommandPath;
  updated.providerInstances[providerId].config.commandArgs = nextArgs;
  return { settings: updated, changed: !unchanged, commandPath: nextCommandPath, commandArgs: nextArgs };
}

function parseCliArgs(argv) {
  const options = {
    uninstall: false,
    providerId: 'antigravity-cli',
    settingsPath: process.env.T3_SETTINGS_PATH || join(homedir(), '.t3', 'userdata', 'settings.json'),
    agyPath: undefined
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall' || arg === '--restore') options.uninstall = true;
    else if (arg === '--provider' && argv[i + 1]) options.providerId = argv[++i];
    else if (arg === '--settings' && argv[i + 1]) options.settingsPath = argv[++i];
    else if (arg === '--agy' && argv[i + 1]) options.agyPath = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await import('node:sqlite');
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (!existsSync(cliOptions.settingsPath)) {
    throw new Error(`T3 settings file not found at: ${cliOptions.settingsPath}`);
  }
  const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const raw = readFileSync(cliOptions.settingsPath, 'utf8');
  const current = JSON.parse(raw);
  const result = configureProviderSettings(current, {
    nodePath: process.execPath,
    bridgePath,
    providerId: cliOptions.providerId,
    agyPath: cliOptions.agyPath,
    uninstall: cliOptions.uninstall
  });

  if (!result.changed) {
    console.log(cliOptions.uninstall
      ? 'Context bridge is not currently active in T3 settings; nothing changed.'
      : 'Context bridge is already configured with identical paths; nothing changed.');
    process.exit(0);
  }

  if (!cliOptions.uninstall) {
    const backupPath = join(dirname(cliOptions.settingsPath), 'settings.before-context-bridge.json');
    if (!existsSync(backupPath)) {
      copyFileSync(cliOptions.settingsPath, backupPath);
      console.log(`Saved settings backup to: ${backupPath}`);
    }
  }

  writeFileSync(cliOptions.settingsPath, JSON.stringify(result.settings, null, 2) + '\n', 'utf8');
  console.log(cliOptions.uninstall
    ? `Restored direct CLI command for "${cliOptions.providerId}". Start a new session or reload T3 Code to apply.`
    : `Configured context bridge for "${cliOptions.providerId}". Start a new session or reload T3 Code to apply.`);
}
